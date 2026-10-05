/**
 * Thin typed client for the Schoology REST API v1.
 *
 * Every call here is signed server-side (see oauth.ts). Nothing in this file
 * should ever be reachable from the browser without going through a route in
 * index.ts that has already resolved a valid session.
 */

import { buildAuthHeader, type Credentials } from "./oauth.ts";

export const SCHOOLOGY_BASE = "https://api.schoology.com/v1";

/** See the comment on the fetch in schoologyGet for why this is 20s. */
export const UPSTREAM_TIMEOUT_MS = 20_000;

export class SchoologyError extends Error {
  // Declared as plain fields rather than TS parameter properties so this file
  // stays runnable under Node's type-stripping (which only removes types and
  // can't emit the assignments parameter properties imply). That's what lets
  // the test suite import this module directly, with no build step.
  status: number;
  body?: string;

  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "SchoologyError";
    this.status = status;
    this.body = body;
  }
}

export async function schoologyGet<T = unknown>(
  path: string,
  creds: Credentials,
  query: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(
    `${SCHOOLOGY_BASE}${path.startsWith("/") ? path : `/${path}`}`
  );
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const auth = await buildAuthHeader("GET", url.toString(), creds);

  /**
   * A ceiling on how long one upstream call may hang (2026-09-17).
   *
   * Without it a Schoology request that never answers leaves the student's
   * page spinning indefinitely — the Worker is not burning CPU while it
   * waits, so nothing on our side ever cuts it off. 20 seconds is deliberately
   * generous: it is not a performance knob, it is the line past which
   * Schoology is effectively down, and a student on a slow connection must
   * never trip it.
   *
   * Aborting is safe here in a way it was NOT for sign-out (see signOut in the
   * app's lib/averages.ts, where tearing down the request meant the clearing
   * Set-Cookie never arrived). These are GETs: nothing is left half-done.
   */
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: auth,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    // Surfaced as a SchoologyError so callers keep their one error type, and
    // so the route layer answers 502 rather than a bare 500. The message
    // carries no credential material — `path` is one of our own constants.
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new SchoologyError(
      timedOut
        ? `Schoology did not respond within ${UPSTREAM_TIMEOUT_MS}ms for ${path}`
        : `Could not reach Schoology for ${path}`,
      timedOut ? 504 : 503
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SchoologyError(
      `Schoology returned ${response.status} for ${path}`,
      response.status,
      body.slice(0, 500)
    );
  }

  return (await response.json()) as T;
}

/**
 * Schoology wraps list responses in a singular-noun key
 * (`{"section": [...]}`, `{"assignment": [...]}`), and returns a bare object
 * rather than an array when there's exactly one result. This normalizes both
 * into a plain array so callers never have to special-case either.
 */
export function listOf<T = Record<string, unknown>>(
  payload: unknown,
  key: string
): T[] {
  if (!payload || typeof payload !== "object") return [];
  const value = (payload as Record<string, unknown>)[key];
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") return [value as T];
  return [];
}

export interface SchoologyUser {
  uid?: string | number;
  id?: string | number;
  name_display?: string;
  name_first?: string;
  name_last?: string;
  primary_email?: string;
  picture_url?: string;
}

export async function getMe(creds: Credentials): Promise<SchoologyUser> {
  return schoologyGet<SchoologyUser>("/users/me", creds);
}

export async function getSections(uid: string, creds: Credentials) {
  const payload = await schoologyGet(`/users/${uid}/sections`, creds);
  return listOf(payload, "section");
}

export async function getGrades(uid: string, creds: Credentials) {
  const payload = await schoologyGet(`/users/${uid}/grades`, creds);
  return listOf(payload, "section");
}

export async function getAssignments(sectionId: string, creds: Credentials) {
  const payload = await schoologyGet(`/sections/${sectionId}/assignments`, creds, {
    limit: 200,
  });
  return listOf(payload, "assignment");
}

export async function getMessages(
  folder: "inbox" | "sent",
  creds: Credentials
) {
  const payload = await schoologyGet(`/messages/${folder}`, creds);
  return listOf(payload, "message");
}

/**
 * One assignment with its attachments (description, files, links). Used by
 * the assignment page and by Edit in Canva, which re-reads the assignment
 * itself rather than trusting a file URL from the browser: the only files it
 * will ever download are ones Schoology lists on that student's assignment.
 */
export async function getAssignment(sectionId: string, assignmentId: string, creds: Credentials) {
  return schoologyGet<Record<string, any>>(`/sections/${sectionId}/assignments/${assignmentId}`, creds, {
    with_attachments: "true",
  });
}

/** True for an https URL on Schoology's API host, the only place a signed request may go. */
export function isSchoologyApiUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "api.schoology.com";
  } catch {
    return false;
  }
}

/**
 * Reads a response body, stopping (and failing) as soon as it passes
 * `maxBytes`. When the size is announced up front, the bytes go straight into
 * one buffer of that size, so a big file isn't held twice in memory.
 */
async function readCapped(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const declared = Number(res.headers.get("Content-Length") ?? 0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (declared > 0 && declared <= maxBytes) {
    const out = new Uint8Array(declared);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total === declared ? out.buffer : out.slice(0, total).buffer;
      if (total + value.byteLength > declared) {
        // More than announced (a decompressed body, say): carry on the slow way.
        chunks.push(out.slice(0, total));
        chunks.push(value);
        total += value.byteLength;
        break;
      }
      out.set(value, total);
      total += value.byteLength;
    }
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SchoologyError("Attachment is too large", 413);
    }
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SchoologyError("Attachment is too large", 413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/**
 * Opens an attachment for the signed-in student and returns Schoology's final
 * response (body not read yet), for streaming or reading.
 *
 * `downloadPath` must come from Schoology's own assignment response (never
 * from the browser) and must be on api.schoology.com, the only host our OAuth
 * signature is ever sent to. Schoology answers with a redirect to its file
 * storage; that's followed by hand (https only, at most 3 hops) so the
 * Authorization header is never forwarded to another host.
 */
export async function openAttachment(downloadPath: string, creds: Credentials): Promise<Response> {
  if (!isSchoologyApiUrl(downloadPath)) {
    throw new SchoologyError("Attachment is not on api.schoology.com", 400);
  }
  const get = async (url: string) => {
    const headers: Record<string, string> = {};
    if (isSchoologyApiUrl(url)) headers.Authorization = await buildAuthHeader("GET", url, creds);
    try {
      return await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new SchoologyError(timedOut ? "Attachment download timed out" : "Could not download the attachment", timedOut ? 504 : 503);
    }
  };

  let url = downloadPath;
  let res = await get(url);
  for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400; hop++) {
    const location = res.headers.get("Location");
    if (!location) break;
    const next = new URL(location, url);
    if (next.protocol !== "https:") throw new SchoologyError("Attachment redirect is not https", 502);
    url = next.toString();
    res = await get(url);
  }
  if (!res.ok) {
    throw new SchoologyError(`Schoology returned ${res.status} for an attachment`, res.status);
  }
  return res;
}

/** An attachment's bytes (for Edit in Canva), refused past `maxBytes`. */
export async function downloadAttachment(
  downloadPath: string,
  creds: Credentials,
  maxBytes: number
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await openAttachment(downloadPath, creds);
  const declared = Number(res.headers.get("Content-Length") ?? 0);
  if (declared > maxBytes) throw new SchoologyError("Attachment is too large", 413);
  const bytes = await readCapped(res, maxBytes);
  const contentType = (res.headers.get("Content-Type") ?? "").split(";")[0].trim();
  return { bytes, contentType };
}
