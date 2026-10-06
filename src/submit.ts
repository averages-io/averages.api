/**
 * Turning in work on Schoology (Wave 2, 2026-10-06): the calls, the checks
 * and the shapes. The routes are in submitRoutes.ts; this file has no Hono in
 * it so the tests can import it directly.
 *
 * A file goes in three steps, as Schoology's docs describe them:
 *   1. POST /v1/upload {filename, filesize, md5_checksum} → a file id and an
 *      upload_location (a URL that accepts exactly that file from exactly
 *      this student).
 *   2. PUT the bytes to upload_location.
 *   3. POST /v1/sections/{section}/submissions/{grade_item}/file with the ids.
 * Step 1 and 3 are small JSON calls. Step 2 is the file itself, which the
 * Worker passes straight through (never buffered, never hashed: the Free plan
 * has about 10 ms of CPU per request, and the browser already worked out the
 * MD5 Schoology checks). The upload_location never reaches the browser: it's
 * sealed into the token the browser sends back with the PUT.
 *
 * Text answers are one call (…/create), after the HTML has been cut down to a
 * short allow-list (sanitizeSubmissionHtml).
 */

import { buildAuthHeader, type Credentials } from "./oauth.ts";
import { isSchoologyApiUrl, listOf, schoologyGet, SchoologyError, SCHOOLOGY_BASE, UPSTREAM_TIMEOUT_MS } from "./schoology.ts";
import { findAttachment, toPlainText } from "./adapt.ts";
import { openValue, sealValue } from "./session.ts";

/** Biggest file we pass on: 95 MB, under the Free plan's 100 MB request body limit. */
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
/** Biggest text answer, before and after cleaning. */
export const MAX_TEXT_BYTES = 100 * 1024;
/** Most files in one turn-in. */
export const MAX_FILES = 20;

/**
 * How long an upload token works. The browser asks for it right before it
 * sends the file, so this only has to cover the gap between the two calls
 * (checked when the PUT starts, not when it ends), with room for a few files
 * asked for at once.
 */
export const UPLOAD_TTL_S = 30 * 60;
export const UPLOAD_PURPOSE = "averages submit upload v1";

/**
 * A ceiling on the PUT. Its answer only comes once every byte has gone up, so
 * the usual 20 seconds would cut off any big file on a school connection; 30
 * minutes covers 95 MB at about half a megabit. The student closing the page
 * cancels it sooner.
 */
const PUT_TIMEOUT_MS = 30 * 60 * 1000;

export const ID_RE = /^\d{1,20}$/;
export const MD5_RE = /^[0-9a-f]{32}$/;

/** A name Schoology can store: 1-255 characters, no path, no control characters, not "." or "..". */
export function validFilename(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || name.length > 255) return false;
  return !/[\/\\\u0000-\u001f\u007f]/.test(name);
}

export function validFilesize(size: unknown): size is number {
  return typeof size === "number" && Number.isInteger(size) && size >= 1 && size <= MAX_UPLOAD_BYTES;
}

/** True for an https URL on Schoology (any *.schoology.com host, default port, no user:password). */
export function isUploadLocation(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      u.port === "" &&
      (host === "schoology.com" || host.endsWith(".schoology.com"))
    );
  } catch {
    return false;
  }
}

/**
 * The type the file goes up as: the browser's Content-Type when it is a plain
 * type/subtype, else one guessed from the name, else octet-stream.
 */
export function uploadContentType(header: string | null | undefined, filename: string): string {
  const given = String(header ?? "").split(";")[0].trim().toLowerCase();
  if (given && given.length <= 127 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(given)) return given;
  return MIME_BY_EXT[extOf(filename)] ?? "application/octet-stream";
}

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}

const MIME_BY_EXT: Record<string, string> = Object.assign(Object.create(null), {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  rtf: "application/rtf",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  zip: "application/zip",
});

/* ── the sealed upload token ───────────────────────────────────────── */

/** What the browser's upload token stands for. Short keys: it travels in a URL. */
export interface UploadClaim {
  /** Schoology's upload_location (never shown to the browser). */
  l: string;
  /** Section and assignment (grade item) it's for. */
  s: string;
  a: string;
  /** The student. */
  u: string;
  /** Schoology's file id. */
  f: string;
  /** Exact size in bytes. */
  n: number;
  /** MD5, lowercase hex. */
  m: string;
  /** File name. */
  fn: string;
}

export function sealUpload(claim: UploadClaim, secret: string): Promise<string> {
  return sealValue(claim, secret, UPLOAD_PURPOSE, UPLOAD_TTL_S);
}

/** The claim inside a token, or null (tampered, expired, another purpose, malformed). */
export async function openUpload(token: string, secret: string): Promise<UploadClaim | null> {
  if (typeof token !== "string" || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const v = (await openValue(token, secret, UPLOAD_PURPOSE)) as any;
  if (!v || typeof v !== "object") return null;
  const ok =
    isUploadLocation(v.l) &&
    ID_RE.test(String(v.s)) &&
    ID_RE.test(String(v.a)) &&
    typeof v.u === "string" && v.u.length > 0 &&
    ID_RE.test(String(v.f)) &&
    validFilesize(v.n) &&
    MD5_RE.test(String(v.m)) &&
    validFilename(v.fn);
  return ok ? (v as UploadClaim) : null;
}

/* ── calls to Schoology ────────────────────────────────────────────── */

/**
 * A signed JSON POST. OAuth 1.0a doesn't sign a JSON body, only the method,
 * URL and oauth_* values. Redirects are not followed: following one would
 * resend the signature to wherever it points (or, for a POST, turn into a
 * GET that was never signed). Returns the status and the parsed body (null
 * when there's none).
 *
 * The api agent is adding a shared schoologyPost to schoology.ts at the same
 * time (2026-10-06); this one can go once that lands.
 */
export async function schoologyPostJson(path: string, creds: Credentials, body: unknown): Promise<{ status: number; json: any }> {
  const url = `${SCHOOLOGY_BASE}${path}`;
  const auth = await buildAuthHeader("POST", url, creds);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new SchoologyError(timedOut ? `Schoology did not respond within ${UPSTREAM_TIMEOUT_MS}ms for ${path}` : `Could not reach Schoology for ${path}`, timedOut ? 504 : 503);
  }
  const text = await res.text().catch(() => "");
  if (res.status < 200 || res.status >= 400) {
    throw new SchoologyError(`Schoology returned ${res.status} for ${path}`, res.status, text.slice(0, 500));
  }
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Step 1: tell Schoology what's coming. Returns its file id and where to PUT the bytes. */
export async function startUpload(
  creds: Credentials,
  file: { filename: string; filesize: number; md5: string },
): Promise<{ fileId: string; location: string }> {
  const { status, json } = await schoologyPostJson("/upload", creds, {
    filename: file.filename,
    filesize: file.filesize,
    md5_checksum: file.md5,
  });
  const fileId = String(json?.id ?? "");
  const location = json?.upload_location;
  if (status >= 300 || !ID_RE.test(fileId) || !isUploadLocation(location)) {
    // Not what Schoology documents: refuse rather than send a file somewhere unexpected.
    throw new SchoologyError("Schoology's upload answer had no usable upload_location", 502);
  }
  return { fileId, location };
}

/** Thrown when the PUT is redirected: the file is never sent anywhere Schoology didn't name up front. */
export const UPLOAD_REDIRECTED = "Schoology redirected the upload";

/**
 * Step 2: the bytes, streamed through. `length` is the size sealed in the
 * token, already checked against the request's Content-Length. On Workers a
 * FixedLengthStream carries the body, which makes the outgoing request
 * declare that exact Content-Length (no chunked encoding) and fails the
 * upload if the browser sends a different number of bytes. The signature
 * goes only to api.schoology.com, never to another host.
 */
export async function putUpload(
  location: string,
  creds: Credentials,
  body: ReadableStream<Uint8Array>,
  length: number,
  contentType: string,
): Promise<any> {
  if (!isUploadLocation(location)) throw new SchoologyError("Upload location is not on Schoology", 400);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(length),
    Accept: "application/json",
  };
  if (isSchoologyApiUrl(location)) headers.Authorization = await buildAuthHeader("PUT", location, creds);
  let res: Response;
  try {
    res = await fetch(location, {
      method: "PUT",
      headers,
      body: fixedLength(body, length),
      redirect: "manual",
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new SchoologyError(timedOut ? "The upload to Schoology timed out" : "The upload to Schoology did not finish", timedOut ? 504 : 503);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new SchoologyError(UPLOAD_REDIRECTED, 502);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new SchoologyError(`Schoology returned ${res.status} for an upload`, res.status, text.slice(0, 500));
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The body as a stream of exactly `length` bytes (Workers); elsewhere (tests) the stream itself. */
export function fixedLength(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const FLS = (globalThis as any).FixedLengthStream;
  if (typeof FLS !== "function") return body;
  const { readable, writable } = new FLS(length);
  // Native stream to native stream: the runtime pumps it, no per-chunk JavaScript.
  body.pipeTo(writable).catch(() => {});
  return readable;
}

/** Step 3: hand the uploaded files in. */
export async function attachFiles(creds: Credentials, section: string, assignment: string, fileIds: string[]): Promise<any> {
  const { json } = await schoologyPostJson(`/sections/${section}/submissions/${assignment}/file`, creds, {
    "file-attachment": { id: fileIds },
  });
  return json;
}

/** A text answer, already cleaned. Never a draft: this is turning it in. */
export async function submitText(creds: Credentials, section: string, assignment: string, html: string): Promise<any> {
  const { json } = await schoologyPostJson(`/sections/${section}/submissions/${assignment}/create`, creds, {
    body: html,
    draft: 0,
  });
  return json;
}

/** This student's revisions for one assignment, with their files. */
export async function getHistory(creds: Credentials, section: string, assignment: string, uid: string): Promise<any> {
  return schoologyGet(`/sections/${section}/submissions/${assignment}/${uid}`, creds, { with_attachments: 1 });
}

/* ── shapes for the app ────────────────────────────────────────────── */

export interface Revision {
  id: string;
  /** Epoch ms (0 when Schoology didn't say). */
  created: number;
  /** "Oct 6, 2:05 PM" in the student's time zone. */
  when: string;
  late: boolean;
  draft: boolean;
  files: { id: string; name: string; size: number }[];
  /** The text answer as plain text, at most 2000 characters. */
  text: string;
}

type Raw = Record<string, any>;

function asList(value: unknown): Raw[] {
  if (Array.isArray(value)) return value.filter((v) => v && typeof v === "object");
  if (value && typeof value === "object") return [value as Raw];
  return [];
}

/** Files nest as `files: [...]`, `files: {file: [...]}` or a single object, like assignments'. */
function revisionFiles(rev: Raw): Revision["files"] {
  const files = rev?.attachments?.files;
  const list = Array.isArray(files) ? files : files && typeof files === "object" && "file" in files ? asList(files.file) : asList(files);
  const out: Revision["files"] = [];
  for (const f of list) {
    const id = String(f?.id ?? "");
    if (!ID_RE.test(id)) continue;
    // Named the same way as the Files page and downloads (adapt.ts), extension included.
    const name = findAttachment({ attachments: { files: [f] } }, id)?.name ?? "File";
    const size = Number(f?.filesize ?? 0);
    out.push({ id, name, size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0 });
  }
  return out.slice(0, 50);
}

/** Schoology's seconds (number or numeric string) as ms; tolerates ms. */
function epochMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.floor(n) : Math.floor(n * 1000);
}

/** One revision for the app, or null when it has no usable id. */
export function adaptRevision(raw: unknown, tz: string): Revision | null {
  if (!raw || typeof raw !== "object") return null;
  const rev = raw as Raw;
  const id = String(rev.revision_id ?? rev.id ?? "");
  if (!ID_RE.test(id)) return null;
  const created = epochMs(rev.created);
  const text = Array.from(toPlainText(rev.body ?? "")).slice(0, 2000).join("");
  return {
    id,
    created,
    when: created ? formatWhen(created, tz) : "",
    late: Number(rev.late) === 1 || rev.late === true,
    draft: Number(rev.draft) === 1 || rev.draft === true,
    files: revisionFiles(rev),
    text,
  };
}

/**
 * What POST …/file and …/create answer with: a revision object (bare or as
 * `revision: [...]`). Null when Schoology sent nothing usable back.
 */
export function revisionFromAnswer(json: unknown, tz: string): Revision | null {
  if (!json || typeof json !== "object") return null;
  const wrapped = listOf(json, "revision");
  return adaptRevision(wrapped[0] ?? json, tz);
}

/** The history for the app: only this student's, newest first, at most 50. */
export function adaptHistory(payload: unknown, uid: string, tz: string): Revision[] {
  const out: Revision[] = [];
  for (const raw of listOf(payload, "revision")) {
    // Personal keys only ever see the student's own, but never show anyone else's.
    if (raw?.uid !== undefined && raw?.uid !== null && String(raw.uid) !== uid) continue;
    const rev = adaptRevision(raw, tz);
    if (rev) out.push(rev);
  }
  out.sort((a, b) => b.created - a.created || Number(b.id) - Number(a.id));
  return out.slice(0, 50);
}

/** One formatter per zone (building one is slow; see classroom.ts). */
const WHEN_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * "Oct 6, 2:05 PM". Put together from parts so it's the same everywhere:
 * newer ICU puts a narrow no-break space before "PM".
 */
export function formatWhen(ms: number, tz: string): string {
  let f = WHEN_FORMATTERS.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    }
    if (WHEN_FORMATTERS.size > 50) WHEN_FORMATTERS.clear();
    WHEN_FORMATTERS.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.month} ${p.day}, ${p.hour}:${p.minute} ${String(p.dayPeriod ?? "").toUpperCase()}`.trim();
}

/* ── cleaning a text answer ────────────────────────────────────────── */

const ALLOWED_TAGS = new Set(["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "h1", "h2", "h3", "a"]);

/** Dropped together with everything inside them, not just their tags. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "template", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet",
  "svg", "math", "xmp", "plaintext", "textarea", "title", "noembed", "noframes", "head", "select",
]);

/** Deeper nesting than this is flattened (its tags dropped, its text kept). */
const MAX_DEPTH = 32;

/**
 * Links kept per answer. Each one is parsed as a URL, which is the slow part
 * of cleaning; past this many the words stay and the links go, so a huge
 * answer can't use up the Worker's CPU allowance.
 */
const MAX_LINKS = 500;

const NAMED_ENTITIES: Record<string, string> = Object.assign(Object.create(null), {
  amp: "&", lt: "<", gt: ">", quot: '"', AMP: "&", LT: "<", GT: ">", QUOT: '"', apos: "'", nbsp: "\u00a0",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", bull: "\u2022", middot: "\u00b7",
  deg: "\u00b0", plusmn: "\u00b1", times: "\u00d7", divide: "\u00f7", frac12: "\u00bd", eacute: "\u00e9",
});

const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/** One level of entity decoding (escaped again on the way out). */
function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(ENTITY_RE, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(n);
    }
    return NAMED_ENTITIES[code] ?? whole; // case matters: &Eacute; is not &eacute;
  });
}

const TEXT_SPECIAL = /[&<>]/;

/** split/join: the fastest way V8 has to replace many matches (a page of "<" in maths). */
function escapeText(s: string): string {
  return TEXT_SPECIAL.test(s) ? s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;") : s;
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Character codes, so the tag reader never builds one-character strings.
const SLASH = 47;
const GT = 62;
const EQ = 61;
const DQUOTE = 34;
const SQUOTE = 39;
const isSpaceCode = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/**
 * The tag readTag() just read (module-level so reading a tag allocates
 * nothing but its name; cleaning is synchronous, so nothing can interleave).
 */
let tagName = "";
let tagHref: string | undefined;

/**
 * Reads one tag starting at its name (just after "<" or "</"), the way a
 * browser would: attribute values may be quoted, and a ">" inside quotes
 * doesn't end the tag. Only an <a>'s href is kept; every other attribute is
 * read past and dropped. Sets tagName/tagHref and returns the index just past
 * the tag, or -1 when the input ends inside it (a browser drops that too).
 */
function readTag(s: string, start: number): number {
  const n = s.length;
  let j = start;
  let c = 0;
  let upper = false;
  while (j < n && !isSpaceCode((c = s.charCodeAt(j))) && c !== SLASH && c !== GT) {
    if (c >= 65 && c <= 90) upper = true;
    j++;
  }
  tagName = upper ? s.slice(start, j).toLowerCase() : s.slice(start, j);
  tagHref = undefined;
  const isLink = tagName === "a";
  for (;;) {
    while (j < n && (isSpaceCode((c = s.charCodeAt(j))) || c === SLASH)) j++;
    if (j >= n) return -1;
    if (c === GT) return j + 1;
    const attrStart = j;
    j++;
    while (j < n && !isSpaceCode((c = s.charCodeAt(j))) && c !== SLASH && c !== GT && c !== EQ) j++;
    const attrEnd = j;
    while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
    let value = "";
    if (j < n && s.charCodeAt(j) === EQ) {
      j++;
      while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
      const q = j < n ? s.charCodeAt(j) : 0;
      if (q === DQUOTE || q === SQUOTE) {
        const close = s.indexOf(q === DQUOTE ? '"' : "'", j + 1);
        if (close === -1) return -1;
        if (isLink) value = s.slice(j + 1, close);
        j = close + 1;
      } else {
        const from = j;
        while (j < n && !isSpaceCode((c = s.charCodeAt(j))) && c !== GT) j++;
        if (isLink) value = s.slice(from, j);
      }
    }
    // The first href wins, as in a browser.
    if (isLink && tagHref === undefined && attrEnd - attrStart === 4 && s.slice(attrStart, attrEnd).toLowerCase() === "href") tagHref = value;
  }
}

/** An http(s) link, normalized, or null. */
export function safeHref(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  // Browsers ignore control characters and whitespace inside a URL ("java\tscript:"), so they go first.
  const value = decodeEntities(raw).replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  if (!value || value.length > 2048 || !/^https?:\/\//i.test(value)) return null;
  try {
    const u = new URL(value);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Plain text (no tags at all): blank lines make paragraphs, single line breaks stay. */
function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${para.split("\n").map(escapeText).join("<br>")}</p>`)
    .join("");
}

/** Block tags that aren't kept but mean "new line" (see sanitizeSubmission). */
const BREAK_TAGS = new Set(["div", "blockquote", "pre", "section", "article", "header", "footer", "main", "aside", "address", "figure", "figcaption", "h4", "h5", "h6", "tr", "dd", "dt", "table", "center"]);
/** Output that already ends a line: no extra <br> needed. */
const ENDS_WITH_BREAK = /(<br>|<\/(p|li|ul|ol|h1|h2|h3)>|<(p|ul|ol|li|h1|h2|h3)>)$/;

/** "</name" ending a dropped element, any case; one per name, reused. */
const CLOSERS = new Map<string, RegExp>();
function closerFor(name: string): RegExp {
  let re = CLOSERS.get(name);
  if (!re) {
    re = new RegExp(`</${name}(?=[\\s/>]|$)`, "ig");
    CLOSERS.set(name, re);
  }
  return re;
}

const OPEN: Record<string, string> = Object.create(null);
const CLOSE: Record<string, string> = Object.create(null);
for (const t of ALLOWED_TAGS) {
  OPEN[t] = `<${t}>`;
  CLOSE[t] = `</${t}>`;
}

const NOT_SPACE = /\S/;
/** A "<" that can start a tag, an end tag, a comment, <!...> or <?...>. */
const TAG_START = /<[A-Za-z!?\/]/g;

/**
 * Cuts a text answer down to p, br, b, strong, i, em, u, ul, ol, li, h1-h3
 * and a (http/https href only). Every other tag and every attribute goes
 * (scripts, styles, frames and the like with all they contain); text is
 * decoded once and escaped again; tags left open are closed. What comes out
 * is safe to show as HTML and can't change the page around it. `hasText`
 * says whether any words are left (whitespace doesn't count).
 *
 * Written for the Worker's CPU allowance (about 10 ms): one pass with
 * indexOf, a lone "<" (maths) left in the surrounding text and escaped with
 * it in one go, no attribute kept but an <a>'s href, few allocations. 100 KB
 * of the densest markup takes a few milliseconds; a real essay, well under one.
 */
export function sanitizeSubmission(input: unknown): { html: string; hasText: boolean } {
  const html = String(input ?? "").replace(/\u0000/g, "");
  if (html.indexOf("<") === -1) {
    // No tags, but it's still HTML (the editor's one-line answer is
    // "Tom &amp; Jerry&nbsp;"): decode once, then escape, never twice
    // (2026-10-06 review).
    const text = decodeEntities(html);
    return { html: plainTextToHtml(text), hasText: NOT_SPACE.test(text) };
  }

  let out = "";
  let hasText = false;
  const stack: string[] = [];
  const n = html.length;
  let links = 0;
  let i = 0;
  /** Where the text not yet written out starts. */
  let textFrom = 0;
  const flushText = (to: number) => {
    // Decoded first, so "<p>&nbsp;</p>" (an editor's empty answer) has no words.
    const text = decodeEntities(html.slice(textFrom, to));
    if (!hasText && NOT_SPACE.test(text)) hasText = true;
    out += escapeText(text);
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);
    const letter = (next >= 65 && next <= 90) || (next >= 97 && next <= 122);
    if (!letter && next !== SLASH && next !== 33 /* ! */ && next !== 63 /* ? */) {
      // "a < b": a lone "<" is text, escaped with the rest. Jump straight to
      // the next "<" that could start a tag, so a long run is one step.
      TAG_START.lastIndex = lt + 1;
      const m = TAG_START.exec(html);
      i = m ? m.index : n;
      continue;
    }
    if (lt > textFrom) flushText(lt);
    textFrom = n; // until a tag below finishes cleanly, nothing after it is text

    if (next === 33 || next === 63) {
      // Comments, <!DOCTYPE>, <![CDATA[...]]>, <?xml?>: dropped.
      const comment = html.startsWith("<!--", lt);
      const end = comment ? html.indexOf("-->", lt + 4) : html.indexOf(">", lt);
      if (end === -1) break;
      i = textFrom = end + (comment ? 3 : 1);
      continue;
    }
    const closing = next === SLASH;
    const nameStart = closing ? lt + 2 : lt + 1;
    const first = html.charCodeAt(nameStart);
    if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) {
      // "</>" or "</ x>": a browser drops it.
      const end = html.indexOf(">", lt);
      if (end === -1) break;
      i = textFrom = end + 1;
      continue;
    }
    const end = readTag(html, nameStart);
    if (end === -1) break; // the input ends inside a tag: the rest is dropped, as a browser does
    i = textFrom = end;
    const name = tagName;

    // A browser's editor starts each new line with a <div> (Enter makes one),
    // and other block tags read as new lines too. They aren't kept, but the
    // line break is, so the words don't run together (2026-10-06 review).
    if (BREAK_TAGS.has(name)) {
      if (!closing && out && !ENDS_WITH_BREAK.test(out.slice(-6))) out += "<br>";
      continue;
    }

    if (!closing && DROP_WITH_CONTENT.has(name)) {
      const closer = closerFor(name);
      closer.lastIndex = i;
      const m = closer.exec(html);
      const close = m ? html.indexOf(">", m.index) : -1;
      if (close === -1) {
        textFrom = n;
        break;
      }
      i = textFrom = close + 1;
      continue;
    }
    if (!(name in OPEN)) continue;
    if (name === "br") {
      if (!closing) out += "<br>";
      continue;
    }
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at === -1) continue;
      while (stack.length > at) out += CLOSE[stack.pop()!];
      continue;
    }
    if (stack.length >= MAX_DEPTH) continue;
    if (name === "a") {
      // No links inside links. MAX_LINKS caps the attempts, kept or not, so a
      // flood of hrefs that fail to parse can't burn the CPU allowance.
      if (stack.includes("a") || links >= MAX_LINKS) continue;
      links++;
      const href = safeHref(tagHref);
      if (!href) continue; // keep the words, drop the link
      stack.push("a");
      out += `<a href="${escapeAttr(href)}">`;
      continue;
    }
    stack.push(name);
    out += OPEN[name];
  }
  if (textFrom < n) flushText(n);
  while (stack.length) out += CLOSE[stack.pop()!];
  return { html: out, hasText };
}

/** sanitizeSubmission's cleaned HTML alone. */
export function sanitizeSubmissionHtml(input: unknown): string {
  return sanitizeSubmission(input).html;
}

/** UTF-8 size of a string. */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}
