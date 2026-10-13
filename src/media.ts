/**
 * Profile photos and uploaded backgrounds in R2 (2026-10-13).
 *
 * Until now both lived inside the Sync Across Devices record as data URLs:
 * a few hundred KB each, re-uploaded with every settings change, and able to
 * push the whole record past its 2 MB cap (a 413 the app never showed, so
 * nothing synced at all). Now each picture is its own object in a private R2
 * bucket, and the Sync record keeps a short reference to it.
 *
 * - One object per student per kind, at u/<uid>/<kind>: a new picture
 *   replaces the old one, so nothing is left behind.
 * - Private: the bucket has no public URL. The only way to read a picture is
 *   GET /media/:kind with that student's own session; there is no uid in the
 *   address, so no one can ask for someone else's.
 * - In the "us" jurisdiction, like the Durable Objects.
 * - Incognito (under 13) and demo sessions store nothing.
 * - Turning Sync off (DELETE /sync/settings) deletes every picture too.
 * - The app keeps its own copy on the device, so pages show pictures instantly
 *   and only another device ever downloads them.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { isDemoSession, isIncognitoSession, type SessionData } from "./session.ts";

export const MEDIA_KINDS = ["photo", "background"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Size caps. The photo is a 256 px square from the app (20 to 40 KB), but an
 * animated GIF goes up untouched, so it gets room. Backgrounds are the app's
 * 1600 px crops, a few hundred KB.
 */
export const MAX_MEDIA_BYTES: Record<MediaKind, number> = {
  photo: 2 * 1024 * 1024,
  background: 4 * 1024 * 1024,
};

export function isMediaKind(value: string): value is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value);
}

export function mediaKey(uid: string, kind: MediaKind): string {
  return `u/${uid}/${kind}`;
}

export function mediaPrefix(uid: string): string {
  return `u/${uid}/`;
}

/**
 * What the bytes really are, from their first bytes, never from what the
 * browser says. Anything that isn't a JPEG, PNG, GIF or WebP is refused, so
 * the bucket can't be used to store anything else (and an SVG, which can
 * carry script, can never get in).
 */
export function sniffImage(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** The parts of R2Bucket this file uses, so tests can hand in a small fake. */
export interface MediaBucket {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<{ etag: string } | null>;
  get(key: string): Promise<{ body: ReadableStream; etag: string; httpMetadata?: { contentType?: string }; size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

/** Every picture this student has, gone. Never throws: Sync's own delete must still go through. */
export async function deleteAllMedia(bucket: MediaBucket | undefined, uid: string): Promise<void> {
  if (!bucket) return;
  try {
    // Every key first, then delete: deleting while paging can make a cursor skip some.
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: mediaPrefix(uid), cursor });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    // R2 deletes up to 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
  } catch (err) {
    console.error("media_delete_all_failed", err);
  }
}

/* ── Routes ─────────────────────────────────────────────────────────────── */

type MediaEnv = { Bindings: { MEDIA?: MediaBucket }; Variables: { session: SessionData } };
type C = Context<MediaEnv>;

export interface MediaDeps {
  requireSession: MiddlewareHandler;
  /** The shared "is this our app asking" check (Origin); null when it is. */
  fromOurApp: (c: any) => Response | null;
}

/**
 * PUT    /media/:kind   the picture's bytes as the body. Answers { v }, its version.
 * GET    /media/:kind   the picture (the app turns it into its own copy).
 * DELETE /media/:kind   that picture gone.
 */
export function mediaRoutes(deps: MediaDeps) {
  const app = new Hono<MediaEnv>();

  /** Shared start: no caching anywhere, live sessions only, a bucket to use. */
  const begin = (c: C, kind: string): Response | MediaKind => {
    c.header("Cache-Control", "private, no-store");
    const blocked = deps.fromOurApp(c);
    if (blocked) return blocked;
    if (!isMediaKind(kind)) return c.json({ error: "unknown_kind" }, 404);
    const session = c.get("session");
    if (isDemoSession(session)) return c.json({ error: "not_available_in_demo" }, 403);
    if (isIncognitoSession(session)) return c.json({ error: "incognito_mode" }, 403);
    if (!c.env.MEDIA) return c.json({ error: "media_unavailable" }, 503);
    return kind;
  };

  app.put("/:kind", deps.requireSession, async (c) => {
    const kind = begin(c, c.req.param("kind"));
    if (kind instanceof Response) return kind;
    const max = MAX_MEDIA_BYTES[kind];
    const declared = Number(c.req.header("Content-Length") ?? "0");
    if (declared > max) return c.json({ error: "too_large", maxBytes: max }, 413);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await c.req.arrayBuffer());
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    if (bytes.byteLength === 0) return c.json({ error: "empty" }, 400);
    if (bytes.byteLength > max) return c.json({ error: "too_large", maxBytes: max }, 413);
    const type = sniffImage(bytes);
    if (!type) return c.json({ error: "not_an_image" }, 415);
    const session = c.get("session");
    try {
      const put = await c.env.MEDIA!.put(mediaKey(session.uid, kind), bytes, { httpMetadata: { contentType: type } });
      return c.json({ ok: true, v: put?.etag ?? "" });
    } catch (err) {
      console.error("media_put_failed", err);
      return c.json({ error: "media_unavailable" }, 503);
    }
  });

  app.get("/:kind", deps.requireSession, async (c) => {
    const kind = begin(c, c.req.param("kind"));
    if (kind instanceof Response) return kind;
    const session = c.get("session");
    let obj;
    try {
      obj = await c.env.MEDIA!.get(mediaKey(session.uid, kind));
    } catch (err) {
      console.error("media_get_failed", err);
      return c.json({ error: "media_unavailable" }, 503);
    }
    if (!obj) return c.json({ error: "not_found" }, 404);
    c.header("Content-Type", obj.httpMetadata?.contentType ?? "application/octet-stream");
    c.header("Content-Length", String(obj.size));
    c.header("X-Content-Type-Options", "nosniff");
    // Only ever read by the app's own fetch(), never opened as a page.
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("Cross-Origin-Resource-Policy", "same-site");
    c.header("X-Media-Version", obj.etag);
    return c.body(obj.body as any, 200);
  });

  app.delete("/:kind", deps.requireSession, async (c) => {
    const kind = c.req.param("kind");
    c.header("Cache-Control", "private, no-store");
    const blocked = deps.fromOurApp(c);
    if (blocked) return blocked;
    if (!isMediaKind(kind)) return c.json({ error: "unknown_kind" }, 404);
    const session = c.get("session");
    if (isDemoSession(session)) return c.json({ error: "not_available_in_demo" }, 403);
    // Allowed in Incognito, like DELETE /sync/settings: deleting is always fine.
    if (!c.env.MEDIA) return c.json({ ok: true });
    try {
      await c.env.MEDIA.delete(mediaKey(session.uid, kind));
    } catch (err) {
      console.error("media_delete_failed", err);
      return c.json({ error: "media_unavailable" }, 503);
    }
    return c.json({ ok: true });
  });

  return app;
}
