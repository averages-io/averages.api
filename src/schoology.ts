/**
 * Thin typed client for the Schoology REST API v1.
 *
 * Every call here is signed server-side (see oauth.ts). Nothing in this file
 * should ever be reachable from the browser without going through a route in
 * index.ts that has already resolved a valid session.
 */

import { noteSchoology, noteReused, noteWait } from "./timing.ts";
import { buildAuthHeader, type Credentials } from "./oauth.ts";
import { isSandboxCreds, sandboxFetch } from "./reviewSandbox.ts";

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

/** A Schoology API URL for one of our own paths (ids already checked by the caller), with its query. */
function schoologyUrl(path: string, query: Record<string, string | number | undefined>): URL {
  const url = new URL(`${SCHOOLOGY_BASE}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * One signed fetch with the upstream timeout. A network failure or timeout
 * becomes a SchoologyError (503/504) so callers keep their one error type, and
 * so the route layer answers 502 rather than a bare 500. The message carries
 * no credential material: `path` is one of our own constants.
 */
async function signedFetch(method: string, url: URL, path: string, creds: Credentials, init: { body?: string; redirect: "follow" | "manual" }): Promise<Response> {
  const started = Date.now();
  try {
    return await signedFetchOnce(method, url, path, creds, init);
  } finally {
    noteSchoology(started, Date.now(), path);
  }
}

async function signedFetchOnce(method: string, url: URL, path: string, creds: Credentials, init: { body?: string; redirect: "follow" | "manual" }): Promise<Response> {
  // The reviewer account (reviewSandbox.ts): answered here, never sent to Schoology.
  if (isSandboxCreds(creds)) return sandboxFetch(method, url.toString(), init.body);
  const auth = await buildAuthHeader(method, url.toString(), creds);
  const headers: Record<string, string> = { Authorization: auth, Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await fetch(url.toString(), {
      method,
      headers,
      body: init.body,
      redirect: init.redirect,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new SchoologyError(
      timedOut
        ? `Schoology did not respond within ${UPSTREAM_TIMEOUT_MS}ms for ${path}`
        : `Could not reach Schoology for ${path}`,
      timedOut ? 504 : 503
    );
  }
}

async function failure(response: Response, path: string): Promise<SchoologyError> {
  const body = await response.text().catch(() => "");
  return new SchoologyError(`Schoology returned ${response.status} for ${path}`, response.status, body.slice(0, 500));
}

export const READS = {
  on: typeof navigator !== "undefined" && (navigator as any).userAgent === "Cloudflare-Workers",
  shareMs: 30_000,
  max: 400,
};
const shared = new Map<string, { at: number; text: string }>();
const whoOf = (creds: Credentials) => `${creds.key}\u0000${creds.token ?? ""}`;

/** Forget a student's shared reads: after anything that changes their Schoology. */
export function forgetReads(creds: Credentials): void {
  const who = whoOf(creds) + "\u0001";
  for (const k of [...shared.keys()]) if (k.startsWith(who)) shared.delete(k);
}
export function forgetAllReads(): void {
  shared.clear();
}

export async function schoologyGet<T = unknown>(
  path: string,
  creds: Credentials,
  query: Record<string, string | number | undefined> = {}
): Promise<T> {
  if (!READS.on) return schoologyGetFresh<T>(path, creds, query);
  const url = schoologyUrl(path, query);
  const k = `${whoOf(creds)}\u0001${url.href}`;
  const hit = shared.get(k);
  // Kept as text and parsed for each caller, so no request can change another's copy.
  if (hit && Date.now() - hit.at < READS.shareMs) { noteReused(); return JSON.parse(hit.text) as T; }
  const value = await schoologyGetFresh<T>(path, creds, query);
  const now = Date.now();
  try { shared.set(k, { at: now, text: JSON.stringify(value) }); } catch { /* not worth keeping */ }
  if (shared.size > READS.max) for (const [key, v] of shared) { if (now - v.at >= READS.shareMs || shared.size > READS.max * 0.8) shared.delete(key); else break; }
  return value;
}

async function schoologyGetFresh<T = unknown>(
  path: string,
  creds: Credentials,
  query: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = schoologyUrl(path, query);

  const response = await signedGet(url, path, creds);

  if (!response.ok) throw await failure(response, path);

  return (await response.json()) as T;
}

export const RATE_LIMIT_WAITS_MS = [1200, 2500, 4500];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long Schoology's 429 says to wait (its Retry-After header: seconds, or a date), in ms; null when it doesn't say.
 * Schoology gives each student 50 API calls that refill every 5 seconds, so this is never more than about 5 s.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const v = header.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

async function signedGet(url: URL, path: string, creds: Credentials): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await signedGetOnce(url, path, creds);
    const fallback = RATE_LIMIT_WAITS_MS[attempt];
    if (res.status !== 429 || fallback === undefined) return res;
    await res.body?.cancel().catch(() => {});
    // Schoology's own "try again in": exactly when the calls refill, instead of a guess (2026-11-13). Between
    // 0.1 and 6 s; the old guesses (1.2, 2.5, 4.5 s) when it doesn't say.
    const told = retryAfterMs(res.headers.get("Retry-After"));
    const wait = told === null ? fallback : Math.min(6000, Math.max(100, told));
    // A little jitter, so the calls that were refused together don't all come back together.
    const ms = wait + Math.floor(Math.random() * (told === null ? 400 : 250));
    noteWait(ms);
    await sleep(ms);
  }
}

async function signedGetOnce(url: URL, path: string, creds: Credentials): Promise<Response> {
  let at = url;
  for (let hop = 0; ; hop++) {
    const res = await signedFetch("GET", at, path, creds, { redirect: "manual" });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const loc = res.headers.get("Location");
    if (!loc || hop >= 3) return res;
    let next: URL;
    try { next = new URL(loc, at); } catch { return res; }
    if (next.protocol !== "https:" || next.hostname !== new URL(SCHOOLOGY_BASE).hostname) return res;
    await res.body?.cancel().catch(() => {});
    at = next;
  }
}

export async function schoologyRequest<T = unknown>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  creds: Credentials,
  body?: unknown,
  query: Record<string, string | number | undefined> = {}
): Promise<T | null> {
  const url = schoologyUrl(path, query);
  forgetReads(creds);
  const response = await signedFetch(method, url, path, creds, {
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok) throw await failure(response, path);
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** schoologyRequest("POST", ...). */
export function schoologyPost<T = unknown>(
  path: string,
  creds: Credentials,
  body: unknown,
  query: Record<string, string | number | undefined> = {}
): Promise<T | null> {
  return schoologyRequest<T>("POST", path, creds, body, query);
}

/** schoologyRequest("PUT", ...). */
export function schoologyPut<T = unknown>(
  path: string,
  creds: Credentials,
  body: unknown,
  query: Record<string, string | number | undefined> = {}
): Promise<T | null> {
  return schoologyRequest<T>("PUT", path, creds, body, query);
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
  role_id?: string | number;
  /** The school's own ID for this person (often the student number). Not every school fills it in. */
  school_uid?: string | number;
}

export async function getMe(creds: Credentials): Promise<SchoologyUser> {
  return schoologyGet<SchoologyUser>("/users/me", creds);
}

/**
 * A teacher or admin account: its Schoology role is marked faculty (GET /roles/{id}: "faculty": 1). Averages.io is
 * for students, so these can't sign in. Unknown (no role, or Schoology won't say) counts as a student.
 */
export async function isFacultyAccount(me: SchoologyUser, creds: Credentials): Promise<boolean> {
  const role = String(me.role_id ?? "");
  if (!/^\d{1,20}$/.test(role)) return false;
  try {
    const r = await schoologyGet<{ faculty?: number | string }>(`/roles/${role}`, creds);
    return String(r?.faculty ?? "0") === "1";
  } catch {
    return false;
  }
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
  return getAssignmentsWithAttachments(sectionId, creds);
}

export async function getMessages(
  folder: "inbox" | "sent",
  creds: Credentials,
  limit?: number
) {
  const payload = await schoologyGet(`/messages/${folder}`, creds, limit ? { limit } : {});
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

export const COURSE_FILE_PAGE = 200;

/** A section's Materials documents; exactly COURSE_FILE_PAGE back means there may be more. */
export async function getDocuments(sectionId: string, creds: Credentials) {
  const payload = await schoologyGet(`/sections/${sectionId}/documents`, creds, {
    limit: COURSE_FILE_PAGE,
    with_attachments: "true",
  });
  return listOf(payload, "document");
}

export async function getAssignmentsWithAttachments(sectionId: string, creds: Credentials) {
  const payload = await schoologyGet(`/sections/${sectionId}/assignments`, creds, {
    limit: COURSE_FILE_PAGE,
    with_attachments: "true",
  });
  return listOf(payload, "assignment");
}

export async function getDiscussions(sectionId: string, creds: Credentials) {
  const payload = await schoologyGet(`/sections/${sectionId}/discussions`, creds, { limit: COURSE_FILE_PAGE });
  return listOf(payload, "discussion");
}

/** One discussion, for its page (the prompt, due date and points). */
export async function getDiscussion(sectionId: string, discussionId: string, creds: Credentials) {
  return schoologyGet<Record<string, any>>(`/sections/${sectionId}/discussions/${discussionId}`, creds);
}

/** One document with its attachment, so a download is looked up again on the Worker. */
export async function getDocument(sectionId: string, documentId: string, creds: Credentials) {
  return schoologyGet<Record<string, any>>(`/sections/${sectionId}/documents/${documentId}`, creds, {
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

export function isSafeAttachmentTarget(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "") return false;
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost")) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false; // IPv4 / IPv6 literals
  return true;
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
    if (isSandboxCreds(creds)) return sandboxFetch("GET", url);
    const headers: Record<string, string> = {};
    if (isSchoologyApiUrl(url)) headers.Authorization = await buildAuthHeader("GET", url, creds);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      return await fetch(url, { headers, redirect: "manual", signal: controller.signal });
    } catch {
      const timedOut = controller.signal.aborted;
      throw new SchoologyError(timedOut ? "Attachment download timed out" : "Could not download the attachment", timedOut ? 504 : 503);
    } finally {
      clearTimeout(timer);
    }
  };

  let url = downloadPath;
  let res = await get(url);
  for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400; hop++) {
    const location = res.headers.get("Location");
    if (!location) break;
    const next = new URL(location, url);
    if (!isSafeAttachmentTarget(next)) throw new SchoologyError("Attachment redirect is not allowed", 502);
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
