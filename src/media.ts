// Profile photos and uploaded backgrounds in R2.

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
  photo: 1024 * 1024,
  background: 4 * 1024 * 1024,
};

/**
 * Photos are kept small (2026-11-23, Martin: "compress pfps automatically when they get inputed into R2"). The app
 * already makes each one a 256 px square (WebP, or JPEG where the browser can't make WebP), about 10-40 KB, so the API
 * only has to turn away anything else: a still photo over 512 px a side or over 150 KB. An animated GIF goes up as it
 * is (re-making every frame on the server would cost far more than it saves), up to 1 MB and 1024 px a side.
 */
export const PHOTO_MAX_SIDE = 512;
export const PHOTO_MAX_STILL_BYTES = 150 * 1024;
export const GIF_MAX_SIDE = 1024;

/** An image's width and height from its first bytes, without decoding it; null when they can't be found. */
export function imageSize(b: Uint8Array, type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"): { w: number; h: number } | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { w, h } : null);
  if (type === "image/png") return b.length >= 24 ? ok(u32be(16), u32be(20)) : null;
  if (type === "image/gif") return b.length >= 10 ? ok(u16le(6), u16le(8)) : null;
  if (type === "image/webp") {
    if (b.length < 30) return null;
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8X") return ok(u24le(24) + 1, u24le(27) + 1);
    if (chunk === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1); }
    if (chunk === "VP8 ") return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    return null;
  }
  // JPEG: walk the markers to the first frame header (SOF0-SOF15, but not DHT, JPG or DAC)
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(u16be(i + 7), u16be(i + 5));
    if (m === 0xd9 || m === 0xda) return null;
    i += 2 + u16be(i + 2);
  }
  return null;
}

/** Why this photo is turned away, or null when it's fine. */
export function photoProblem(bytes: Uint8Array, type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"): { status: 413 | 422; error: string; max: number } | null {
  const gif = type === "image/gif";
  if (!gif && bytes.byteLength > PHOTO_MAX_STILL_BYTES) return { status: 413, error: "too_large", max: PHOTO_MAX_STILL_BYTES };
  const size = imageSize(bytes, type), side = gif ? GIF_MAX_SIDE : PHOTO_MAX_SIDE;
  if (!size) return { status: 422, error: "not_an_image", max: side };
  if (size.w > side || size.h > side) return { status: 422, error: "photo_too_big", max: side };
  return null;
}

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
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<{ etag: string } | null>;
  get(key: string): Promise<{ body: ReadableStream; etag: string; httpMetadata?: { contentType?: string }; size: number; text?: () => Promise<string> } | null>;
  head?(key: string): Promise<{ etag: string } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; include?: ("customMetadata" | "httpMetadata")[] }): Promise<{ objects: { key: string; customMetadata?: Record<string, string> }[]; truncated: boolean; cursor?: string }>;
}

/** Every picture this student has, gone. Never throws: Sync's own delete must still go through. */
/** strict (Delete account): a failure is thrown, so the app hears "not everything was deleted" instead of "done". */
export async function deleteAllMedia(bucket: MediaBucket | undefined, uid: string, strict = false): Promise<void> {
  if (!bucket) return;
  try {
    // the photo's places in classmates' lists go first (they're outside this student's own folder)
    await unshareAll(bucket, uid);
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
    if (strict) throw err;
  }
}

/* ── The photo, shown to classmates (2026-11-23, Martin: "their pfp is shared with classmates with the app and vice
 * versa but can be turned off") ──────────────────────────────────────────────────────────────────────────────────
 * Off until the student turns it on (Settings > Privacy). On, the photo gets one small marker per class the student
 * is in: share/<section>/<uid>, its version in the marker. A classmate's GET /data/classmates lists the markers of
 * the classes Schoology says THEY are in, and only for the people Schoology lists in that class, so a photo only
 * ever reaches someone who shares a class with its owner. Each photo address is signed for the one student it was
 * given to and runs out after a week; turning it off deletes the markers and the photo stops loading at once.
 * Costs: one list per class per classmates read (the app keeps that 5 minutes), one read per photo a browser
 * doesn't have yet; photos are cached under their version. */

export function shareRecordKey(uid: string): string {
  return `u/${uid}/share`;
}
export function shareKey(section: string, uid: string): string {
  return `share/${section}/${uid}`;
}
const SECTION_RE = /^[0-9A-Za-z_-]{1,40}$/;
/** Most classes one student's photo is marked in (Schoology students rarely have more than 12). */
export const MAX_SHARED_SECTIONS = 40;

/** The classes this student's photo is marked in, or null when sharing is off. */
export async function readShare(bucket: MediaBucket, uid: string): Promise<string[] | null> {
  const obj = await bucket.get(shareRecordKey(uid));
  if (!obj) return null;
  try {
    const text = obj.text ? await obj.text() : await new Response(obj.body).text();
    const j = JSON.parse(text) as { sections?: unknown };
    return Array.isArray(j.sections) ? j.sections.filter((x): x is string => typeof x === "string" && SECTION_RE.test(x)) : [];
  } catch {
    return [];
  }
}

async function photoVersion(bucket: MediaBucket, uid: string): Promise<string> {
  if (bucket.head) return (await bucket.head(mediaKey(uid, "photo")))?.etag ?? "";
  const obj = await bucket.get(mediaKey(uid, "photo"));
  if (obj) {
    try { await obj.body.cancel(); } catch { /* fine */ }
  }
  return obj?.etag ?? "";
}

/**
 * Sharing on with these classes (null: off). The markers follow: one per class while there's a photo, none
 * without one (the record stays, so a photo added later is shown). Never more classes than MAX_SHARED_SECTIONS.
 */
export async function setShare(bucket: MediaBucket, uid: string, sections: string[] | null): Promise<void> {
  const before = (await readShare(bucket, uid)) ?? [];
  if (sections === null) {
    if (before.length) await bucket.delete(before.map((s) => shareKey(s, uid)));
    await bucket.delete(shareRecordKey(uid));
    return;
  }
  const now = [...new Set(sections.filter((x) => SECTION_RE.test(x)))].slice(0, MAX_SHARED_SECTIONS);
  const gone = before.filter((s) => !now.includes(s));
  if (gone.length) await bucket.delete(gone.map((s) => shareKey(s, uid)));
  await bucket.put(shareRecordKey(uid), JSON.stringify({ sections: now }), { httpMetadata: { contentType: "application/json" } });
  await markShares(bucket, uid, now);
}

/** The markers again, with the photo's current version (after a new photo), or gone (no photo). */
async function markShares(bucket: MediaBucket, uid: string, sections: string[]): Promise<void> {
  if (!sections.length) return;
  const v = await photoVersion(bucket, uid);
  if (!v) {
    await bucket.delete(sections.map((s) => shareKey(s, uid)));
    return;
  }
  await Promise.all(sections.map((s) => bucket.put(shareKey(s, uid), "", { customMetadata: { v } })));
}

/** After the photo changed or went: classmates get the new one, or none. Never throws (the photo itself is saved). */
export async function photoChanged(bucket: MediaBucket, uid: string): Promise<void> {
  try {
    const sections = await readShare(bucket, uid);
    if (sections) await markShares(bucket, uid, sections);
  } catch (err) {
    console.error("media_share_update_failed", err);
  }
}

/** Every marker gone (Delete account, Sync off). The record itself is in the student's folder and goes with it. */
export async function unshareAll(bucket: MediaBucket, uid: string): Promise<void> {
  const sections = await readShare(bucket, uid);
  if (sections && sections.length) await bucket.delete(sections.map((s) => shareKey(s, uid)));
}

/** The class list changed (a new term): the markers move. Only writes when something is different. */
export async function syncShareSections(bucket: MediaBucket, uid: string, sections: string[]): Promise<void> {
  try {
    const before = await readShare(bucket, uid);
    if (!before) return;
    const now = [...new Set(sections.filter((x) => SECTION_RE.test(x)))].slice(0, MAX_SHARED_SECTIONS);
    if (now.length === before.length && now.every((s) => before.includes(s))) return;
    await setShare(bucket, uid, now);
  } catch (err) {
    console.error("media_share_sections_failed", err);
  }
}

/** One class's shared photos: uid -> version. */
export async function sharedInSection(bucket: MediaBucket, section: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!SECTION_RE.test(section)) return out;
  const prefix = `share/${section}/`;
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const r = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    for (const o of r.objects) {
      const uid = o.key.slice(prefix.length), v = o.customMetadata?.v;
      if (uid && v) out.set(uid, v);
    }
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return out;
}

/* Photo addresses: for one viewer, one photo version, a week at most. Same address all day, so browsers reuse it. */
const PEER_PURPOSE = "peer-photo-v1";
const WEEK = 7 * 86400;
async function peerMac(secret: string, viewer: string, owner: string, v: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret + ":" + PEER_PURPOSE), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${viewer}\n${owner}\n${v}\n${exp}`));
  return [...new Uint8Array(mac).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function peerPhotoUrl(origin: string, secret: string, viewer: string, owner: string, v: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const exp = (Math.floor(nowSec / 86400) + 1) * 86400 + WEEK;
  const s = await peerMac(secret, viewer, owner, v, exp);
  return `${origin}/media/peer/${encodeURIComponent(owner)}?v=${encodeURIComponent(v)}&e=${exp}&s=${s}`;
}
export async function peerPhotoOk(secret: string, viewer: string, owner: string, v: string, exp: number, s: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!v || !Number.isFinite(exp) || exp < nowSec || exp > nowSec + WEEK + 2 * 86400 || !/^[0-9a-f]{32}$/.test(s)) return false;
  const want = await peerMac(secret, viewer, owner, v, exp);
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ s.charCodeAt(i);
  return d === 0;
}

/**
 * GET /data/classmates, with photos: each classmate who shows their photo gets it in place of Schoology's. The
 * lists come from Schoology with the viewer's own sign-in, so only people in the viewer's own classes can match.
 */
export async function addSharedPhotos(
  bucket: MediaBucket,
  classmates: Record<string, { id: string; photo: string }[]>,
  opts: { origin: string; secret: string; viewer: string },
): Promise<void> {
  const sections = Object.keys(classmates).filter((s) => (classmates[s] || []).length);
  const maps = await Promise.all(sections.map((s) => sharedInSection(bucket, s).catch(() => new Map<string, string>())));
  const urls = new Map<string, Promise<string>>();
  const jobs: Promise<void>[] = [];
  sections.forEach((s, i) => {
    const map = maps[i];
    if (!map.size) return;
    for (const m of classmates[s]) {
      const v = map.get(String(m.id));
      if (!v || String(m.id) === opts.viewer) continue;
      const k = `${m.id}\n${v}`;
      if (!urls.has(k)) urls.set(k, peerPhotoUrl(opts.origin, opts.secret, opts.viewer, String(m.id), v));
      jobs.push(urls.get(k)!.then((u) => { m.photo = u; }));
    }
  });
  await Promise.all(jobs);
}

/* ── Routes ─────────────────────────────────────────────────────────────── */

type MediaEnv = { Bindings: { MEDIA?: MediaBucket }; Variables: { session: SessionData } };
type C = Context<MediaEnv>;

export interface MediaDeps {
  requireSession: MiddlewareHandler;
  /** The shared "is this our app asking" check (Origin); null when it is. */
  fromOurApp: (c: any) => Response | null;
  /** The student's classes (Schoology section ids), for showing their photo to classmates; null: not supported. */
  sectionsOf?: (session: SessionData) => Promise<string[] | null>;
  /** The secret photo addresses are signed with. */
  secret?: (c: any) => string;
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

  /* Show my photo to classmates: GET { on }, POST { on: true | false }. */
  app.get("/photo/share", deps.requireSession, async (c) => {
    const kind = begin(c, "photo");
    if (kind instanceof Response) return kind;
    if (!deps.sectionsOf) return c.json({ on: false, available: false });
    try {
      // photo: whether the account has one saved (without it nothing shows); classes: how many it's shown in
      const uid = c.get("session").uid, sections = await readShare(c.env.MEDIA!, uid);
      return c.json({ on: sections !== null, available: true, photo: !!(await photoVersion(c.env.MEDIA!, uid)), classes: sections ? sections.length : 0 });
    } catch (err) {
      console.error("media_share_read_failed", err);
      return c.json({ error: "media_unavailable" }, 503);
    }
  });

  app.post("/photo/share", deps.requireSession, async (c) => {
    const kind = begin(c, "photo");
    if (kind instanceof Response) return kind;
    let body: { on?: unknown } | null = null;
    try {
      body = await c.req.json();
    } catch {
      /* below */
    }
    if (!body || typeof body.on !== "boolean") return c.json({ error: "bad_request" }, 400);
    const session = c.get("session");
    try {
      if (!body.on) {
        await setShare(c.env.MEDIA!, session.uid, null);
        return c.json({ ok: true, on: false });
      }
      const sections = deps.sectionsOf ? await deps.sectionsOf(session) : null;
      if (!sections) return c.json({ error: "not_supported" }, 400);
      await setShare(c.env.MEDIA!, session.uid, sections);
      return c.json({ ok: true, on: true, photo: !!(await photoVersion(c.env.MEDIA!, session.uid)), classes: Math.min(sections.length, MAX_SHARED_SECTIONS) });
    } catch (err) {
      console.error("media_share_failed", err);
      return c.json({ error: "media_unavailable" }, 503);
    }
  });

  /* A classmate's photo, from an address GET /data/classmates gave this student. */
  app.get("/peer/:uid", deps.requireSession, async (c) => {
    const blocked = deps.fromOurApp(c);
    if (blocked) return blocked;
    c.header("Cache-Control", "private, no-store");
    const session = c.get("session");
    if (isDemoSession(session) || isIncognitoSession(session)) return c.json({ error: "not_found" }, 404);
    if (!c.env.MEDIA || !deps.secret) return c.json({ error: "media_unavailable" }, 503);
    const owner = c.req.param("uid"), v = c.req.query("v") ?? "", exp = Number(c.req.query("e") ?? ""), s = c.req.query("s") ?? "";
    if (!(await peerPhotoOk(deps.secret(c), session.uid, owner, v, exp, s))) return c.json({ error: "not_found" }, 404);
    let obj;
    try {
      // still shown? (turning it off deletes the record: the photo stops at once)
      if ((await readShare(c.env.MEDIA, owner)) === null) return c.json({ error: "not_found" }, 404);
      obj = await c.env.MEDIA.get(mediaKey(owner, "photo"));
    } catch (err) {
      console.error("media_peer_failed", err);
      return c.json({ error: "media_unavailable" }, 503);
    }
    // a newer photo has its own address: this one stops, so nothing caches the new picture under the old version
    if (!obj || obj.etag !== v) {
      if (obj) {
        try { await obj.body.cancel(); } catch { /* fine */ }
      }
      return c.json({ error: "not_found" }, 404);
    }
    c.header("Content-Type", obj.httpMetadata?.contentType ?? "application/octet-stream");
    c.header("Content-Length", String(obj.size));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("Cross-Origin-Resource-Policy", "same-site");
    // only this student's browser, only this version of the photo, and only for an hour (2026-11-23 sweep: it was the
    // week the address lasts, so a photo its owner stopped showing could stay in a classmate's browser that long)
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(obj.body as any, 200);
  });

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
    if (kind === "photo") {
      const bad = photoProblem(bytes, type);
      if (bad) return c.json(bad.error === "too_large" ? { error: "too_large", maxBytes: bad.max } : bad.error === "photo_too_big" ? { error: "photo_too_big", maxSide: bad.max } : { error: "not_an_image" }, bad.status);
    }
    const session = c.get("session");
    try {
      const put = await c.env.MEDIA!.put(mediaKey(session.uid, kind), bytes, { httpMetadata: { contentType: type } });
      if (kind === "photo") await photoChanged(c.env.MEDIA!, session.uid);
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
      if (kind === "photo") await photoChanged(c.env.MEDIA, session.uid);
    } catch (err) {
      console.error("media_delete_failed", err);
      return c.json({ error: "media_unavailable" }, 503);
    }
    return c.json({ ok: true });
  });

  return app;
}
