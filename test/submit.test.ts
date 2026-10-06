/**
 * Tests for turning in work (src/submit.ts, src/submitRoutes.ts) and the
 * Canva PDF export (src/canvaExport.ts, plus the scope handling in
 * src/canva.ts), 2026-10-06.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/submit.test.ts
 *
 * The two sub-apps are mounted on a bare Hono app with stand-ins for
 * index.ts's middleware (the same session cookie, the same Origin/JSON rule),
 * and `fetch` is replaced with a fake that plays Schoology and Canva, so every
 * upstream request can be checked: method, URL, headers, body. Every id, key
 * and token below is made up.
 */

import { Hono } from "hono";
import {
  adaptHistory,
  formatWhen,
  isUploadLocation,
  MAX_UPLOAD_BYTES,
  openUpload,
  revisionFromAnswer,
  safeHref,
  sanitizeSubmission,
  sanitizeSubmissionHtml,
  sealUpload,
  uploadContentType,
  UPLOAD_PURPOSE,
  validFilename,
  validFilesize,
  type UploadClaim,
} from "../src/submit.ts";
import { submitRoutes } from "../src/submitRoutes.ts";
import { canvaExportRoutes, contentDisposition, EXPORT_PURPOSE, isExportUrl, pdfName, sealExport } from "../src/canvaExport.ts";
import { CanvaAccount, canvaConfigured, canvaScopes, EXPORT_SCOPE, type CanvaStorage } from "../src/canva.ts";
import { DEMO_UID, isDemoSession, isIncognitoSession, openSession, readCookie, sealSession, sealValue, SESSION_COOKIE } from "../src/session.ts";
import { buildBaseString, hmacSha1, percentEncode } from "../src/oauth.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`);
  }
}
const checkTrue = (name: string, v: boolean) => check(name, v, true);

/* ── fake upstream ─────────────────────────────────────────────────── */

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: any;
  init: RequestInit;
  bytes?: Uint8Array;
}
let calls: Call[] = [];
let upstream: (call: Call) => Response | Promise<Response> = () => new Response("no handler", { status: 500 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const call: Call = { url, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers), body: init.body, init };
  calls.push(call);
  return upstream(call);
}) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/** Reads a streamed request body the way a server would. */
async function drain(call: Call): Promise<Uint8Array> {
  call.bytes = new Uint8Array(await new Response(call.body).arrayBuffer());
  return call.bytes;
}

/* ── the app under test ────────────────────────────────────────────── */

const SECRET = "submit-test-session-secret";
const ENV: Record<string, unknown> = {
  SESSION_SECRET: SECRET,
  CANVA_CLIENT_ID: "OC-test",
  CANVA_CLIENT_SECRET: "canva-test",
  CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback",
  CANVA_EXPORT_ENABLED: "1",
};
const CTX = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";
const ALLOWED = ["https://app.averages.io", "https://averages.io"];

// Stand-ins with index.ts's behaviour (requireSession, notFromOurApp, canvaGuard, canvaStore).
async function requireSession(c: any, next: any) {
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  const session = token ? await openSession(token, c.env.SESSION_SECRET) : null;
  if (!session) return c.json({ error: "not_authenticated" }, 401);
  c.set("session", session);
  await next();
}
function fromOurApp(c: any) {
  const origin = c.req.header("Origin");
  if (origin && !ALLOWED.includes(origin)) return c.json({ error: "forbidden_origin" }, 403);
  if (c.req.method === "POST" && !(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return c.json({ error: "json_required" }, 415);
  }
  return null;
}
function canvaGuard(c: any) {
  if (isDemoSession(c.get("session"))) return c.json({ error: "not_available_in_demo" }, 403);
  if (isIncognitoSession(c.get("session"))) return c.json({ error: "incognito_mode" }, 403);
  if (!canvaConfigured(c.env)) return c.json({ error: "canva_not_configured" }, 503);
  return null;
}

class MemoryStorage implements CanvaStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
}
const accounts = new Map<string, CanvaAccount>();
const accountFor = (uid: string) => {
  if (!accounts.has(uid)) accounts.set(uid, new CanvaAccount(new MemoryStorage(), ENV as any));
  return accounts.get(uid)!;
};

const app = new Hono();
app.route("/submit", submitRoutes({ requireSession, fromOurApp }));
app.route("/canva", canvaExportRoutes({ requireSession, canvaGuard, fromOurApp, storeFor: (_c, uid) => accountFor(uid) }));

const UID = "4242";
const KEY = "consumer-key";
const KSECRET = "consumer-secret";
const student = `${SESSION_COOKIE}=${await sealSession({ key: KEY, secret: KSECRET, uid: UID }, SECRET)}`;
const classmate = `${SESSION_COOKIE}=${await sealSession({ key: "k2", secret: "s2", uid: "5151" }, SECRET)}`;
const incognito = `${SESSION_COOKIE}=${await sealSession({ key: KEY, secret: KSECRET, uid: UID, inc: true }, SECRET)}`;
const demo = `${SESSION_COOKIE}=${await sealSession({ key: "", secret: "", uid: DEMO_UID }, SECRET)}`;
const google = `${SESSION_COOKIE}=${await sealSession(
  { key: "", secret: "", uid: "g:1098", g: { at: "ya29.x", rt: "1//r", ax: Math.floor(Date.now() / 1000) + 3600, sc: "cwma", name: "Sam", email: "s@x", pic: "" } } as any,
  SECRET,
)}`;

type Init = RequestInit & { cookie?: string; json?: unknown; origin?: string | null };
async function call(path: string, init: Init = {}, env = ENV) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.origin !== null) headers.set("Origin", init.origin ?? "https://app.averages.io");
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  const req = new Request(API + path, { ...init, headers, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as any);
  const res = await app.fetch(req, env as any, CTX as any);
  return { res, req, data: res.headers.get("Content-Type")?.includes("json") ? ((await res.clone().json()) as any) : null };
}
const errorOf = async (p: Promise<{ res: Response; data: any }>) => {
  const { res, data } = await p;
  return [res.status, data?.error];
};

/** The token with one character changed. */
const flip = (token: string, at: number) => token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);

/** Recomputes the OAuth 1.0a signature from the header's own nonce and timestamp. */
async function signatureOk(method: string, url: string, header: string, secret = KSECRET): Promise<boolean> {
  const params: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = decodeURIComponent(m[2]);
  const { oauth_signature, realm: _realm, ...oauth } = params;
  const base = buildBaseString(method, new URL(url), oauth);
  return (await hmacSha1(`${percentEncode(secret)}&`, base)) === oauth_signature;
}

/* ═══ unit: checks ═══════════════════════════════════════════════════ */

console.log("checks");
check("a normal file name is fine", validFilename("Lab Report #4 (final).pdf"), true);
check("names with a path, control characters, dots only or 256 characters are not", [
  validFilename("../etc/passwd"), validFilename("a\\b.pdf"), validFilename("a\nb.pdf"), validFilename(".."), validFilename("  "), validFilename("x".repeat(256)), validFilename(42),
], [false, false, false, false, false, false, false]);
check("255 characters is the limit", validFilename("x".repeat(251) + ".pdf"), true);
check("size: 1 byte to 95 MB, whole numbers only", [validFilesize(1), validFilesize(MAX_UPLOAD_BYTES), validFilesize(MAX_UPLOAD_BYTES + 1), validFilesize(0), validFilesize(1.5), validFilesize("10")], [true, true, false, false, false, false]);
check("upload locations: https on schoology.com only", [
  isUploadLocation("https://api.schoology.com/v1/upload/1?x=1"),
  isUploadLocation("https://files.schoology.com/u/1"),
  isUploadLocation("http://api.schoology.com/v1/upload/1"),
  isUploadLocation("https://api.schoology.com.evil.com/x"),
  isUploadLocation("https://evilschoology.com/x"),
  isUploadLocation("https://user:pw@api.schoology.com/x"),
  isUploadLocation("https://api.schoology.com:8443/x"),
  isUploadLocation(42),
], [true, true, false, false, false, false, false, false]);
check("content type: the browser's when it's a plain type", uploadContentType("application/pdf", "x.docx"), "application/pdf");
check("...parameters dropped, lowercased", uploadContentType("Text/Plain; charset=utf-8", "x"), "text/plain");
check("...a header-injection attempt falls back to the name", uploadContentType("text/html\r\nX-Evil: 1", "essay.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
check("...nothing known: octet-stream", uploadContentType("", "data.weird"), "application/octet-stream");
check("export URLs: https on a named host, no credentials", [
  isExportUrl("https://export-download.canva.com/abc/1.pdf?sig=x"),
  isExportUrl("http://export-download.canva.com/a.pdf"),
  isExportUrl("https://127.0.0.1/a.pdf"),
  isExportUrl("https://[::1]/a.pdf"),
  isExportUrl("https://localhost/a.pdf"),
  isExportUrl("https://u:p@export-download.canva.com/a.pdf"),
], [true, false, false, false, false, false]);
check("PDF name from a design title", [pdfName("Lab Report: Final/v2"), pdfName("  "), pdfName("Essay.PDF"), pdfName("a\u0000b\nc")], ["Lab Report: Final v2.pdf", "Canva design.pdf", "Essay.pdf", "a b c.pdf"]);
check("Content-Disposition like /data/attachment's", contentDisposition("Café \"notes\".pdf"), `attachment; filename="Caf_ _notes_.pdf"; filename*=UTF-8''Caf%C3%A9%20%22notes%22.pdf`);

/* ═══ unit: the text cleaner ═════════════════════════════════════════ */

console.log("text cleaner");
const clean: [string, string, string][] = [
  ["allowed tags stay", "<p>Hello <b>world</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u></p>", "<p>Hello <b>world</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u></p>"],
  ["attributes go", `<p onclick="x()" style="color:red" class=a>Hi</p>`, "<p>Hi</p>"],
  ["script goes with its content", "<script>alert(1)</script><p>ok</p>", "<p>ok</p>"],
  ["upper-case script too", "<SCRIPT type=text/javascript>alert(1)</SCRIPT >x", "x"],
  ["an img with onerror goes", "<img src=x onerror=alert(1)>text", "text"],
  ["javascript: links lose the link, keep the words", `<a href="javascript:alert(1)">click</a>`, "click"],
  ["an encoded tab inside javascript: doesn't sneak through", `<a href=" jav&#x09;ascript:alert(1)">x</a>`, "x"],
  ["an entity-encoded scheme doesn't either", `<a href="&#106;avascript:alert(1)">x</a>`, "x"],
  ["data: links go", `<a href="data:text/html,<script>alert(1)</script>">x</a>`, "x"],
  ["an https link keeps only href, escaped", `<a href="https://example.com/a?b=1&amp;c=2" target="_blank" onclick="x">link</a>`, `<a href="https://example.com/a?b=1&amp;c=2">link</a>`],
  ["a quote can't break out of href", `<a href="https://x.com/&quot;onmouseover=&quot;alert(1)">x</a>`, `<a href="https://x.com/%22onmouseover=%22alert(1)">x</a>`],
  ["tag and scheme case don't matter", `<A HREF="HTTPS://EXAMPLE.COM">x</A>`, `<a href="https://example.com/">x</a>`],
  ["no links inside links", `<a href="https://a.com"><a href="https://b.com">x</a></a>`, `<a href="https://a.com/">x</a>`],
  ["svg goes with everything in it", "<svg><g onload=alert(1)><script>alert(1)</script></g></svg>after", "after"],
  ["math too", `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`, ""],
  ["style goes with its content", "<style>p{background:url(javascript:x)}</style>", ""],
  ["iframe goes", `<iframe src="https://evil.com"></iframe>x`, "x"],
  ["comments go, even with tags inside", "<!-- <script>alert(1)</script> -->visible", "visible"],
  ["CDATA and doctype go", "<!DOCTYPE html><![CDATA[<script>]]>ok", "]]&gt;ok"],
  ["a split-up tag doesn't rebuild itself", "<scr<script>ipt>alert(1)</script>", "ipt&gt;alert(1)"],
  ["a null byte can't hide a tag", "<scr\u0000ipt>alert(1)</scr\u0000ipt>ok", "ok"],
  ["form controls go, their words stay", `<form action="https://evil.com"><input value="x"><button>go</button></form>`, "go"],
  ["> inside a quoted attribute doesn't end the tag", `<p title="a>b">ok</p>`, "<p>ok</p>"],
  ["crossed tags are untangled", "<b><i>x</b>y</i>", "<b><i>x</i></b>y"],
  ["open tags are closed", "<ul><li>a<li>b", "<ul><li>a<li>b</li></li></ul>"],
  ["stray closing tags go", "</p></b>x</ul>", "x"],
  ["unterminated tag at the end is dropped", `<p>ok<a href="https://x.com`, "<p>ok</p>"],
  ["headings 1-3 stay, 4 goes", "<h1>T</h1><h2>a</h2><h3>b</h3><h4>x</h4>", "<h1>T</h1><h2>a</h2><h3>b</h3>x"],
  ["br in any spelling", "a<br/>b<BR>c</br>d", "a<br>b<br>cd"],
  ["< and & in text are escaped", "<p>a < b && c > d</p>", "<p>a &lt; b &amp;&amp; c &gt; d</p>"],
  ["entities decode once, then escape again", "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>", "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"],
  ["numeric entities, bad ones become �", "<p>&eacute; &#233; &#x1F600; &#0; &#xD800;</p>", "<p>é é 😀 � �</p>"],
  ["plain text becomes paragraphs", "Line one\nLine two\r\n\r\nPara two & more", "<p>Line one<br>Line two</p><p>Para two &amp; more</p>"],
];
for (const [name, input, expected] of clean) check(name, sanitizeSubmissionHtml(input), expected);
{
  const deep = sanitizeSubmissionHtml("<b>".repeat(1000) + "x");
  check("nesting is capped at 32 deep", (deep.match(/<b>/g) ?? []).length, 32);
  check("words left: an editor's empty answer has none", [sanitizeSubmission("<p>&nbsp;</p><p><br></p>").hasText, sanitizeSubmission("<p> x </p>").hasText, sanitizeSubmission(" \n ").hasText, sanitizeSubmission("<script>words</script>").hasText], [false, true, false, false]);
  check("at most 500 links are kept", (sanitizeSubmissionHtml('<a href="https://a.com/">x</a> '.repeat(600)).match(/<a href/g) ?? []).length, 500);
  check("safeHref keeps https, refuses the rest", [safeHref("https://a.com/x"), safeHref("ftp://a.com"), safeHref("//a.com"), safeHref(undefined)], ["https://a.com/x", null, null, null]);

  // Random soup of nasty pieces: whatever comes out is only allowed tags, no attributes but a safe href.
  const pieces = ["<", ">", "/", '"', "'", "=", " ", "a", "p", "b", "script", "img", "svg", "href", "onerror", "javascript:", "https://x.com", "&lt;", "&#", "&quot;", "<!--", "-->", "\u0000", "style", "<a ", "</a>", "<p>", "<script>", "</script>", "<svg>", "x", '<a href="https://x.com/', '<a href="https://x.com/">', "<a href=https://y.com onclick=x>", "<a href=", '<a href="java', "<B>", "</P>", "\t", "\n"];
  // mulberry32: a small seeded generator, so a failure can be reproduced.
  let seed = 42;
  const rand = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const ok = /^(?:[^<>]|<\/?(?:p|br|b|strong|i|em|u|ul|ol|li|h1|h2|h3)>|<a href="https?:\/\/[^"<>\s]*">|<\/a>)*$/;
  let bad = "";
  const made = { links: 0, tags: 0 };
  for (let n = 0; n < 3000 && !bad; n++) {
    let s = "";
    for (let k = rand(40); k > 0; k--) s += pieces[rand(pieces.length)];
    const out = sanitizeSubmissionHtml(s);
    if (out.includes("<a href")) made.links++;
    if (/<(p|b)>/.test(out)) made.tags++;
    // Words like "onerror" can survive as text; what matters is that no markup but the allowed kind does.
    if (!ok.test(out)) bad = `${JSON.stringify(s)} -> ${JSON.stringify(out)}`;
  }
  check("3000 random nasty inputs: only allowed markup comes out", bad, "");
  console.log(`        (the soup made ${made.links} with links, ${made.tags} with tags)`);
  check("...and the soup did make links and tags (the check isn't empty)", [made.links > 20, made.tags > 20], [true, true]);
}

/* ═══ unit: history ══════════════════════════════════════════════════ */

console.log("history");
{
  const at = Date.UTC(2026, 9, 6, 21, 5) / 1000; // 2:05 PM in Los Angeles (PDT)
  check("when, in the student's zone", formatWhen(at * 1000, "America/Los_Angeles"), "Oct 6, 2:05 PM");
  check("when, in UTC", formatWhen(at * 1000, "UTC"), "Oct 6, 9:05 PM");
  const raw = {
    revision: [
      { revision_id: 1, uid: 4242, created: String(at - 86400), num_items: 1, late: 0, draft: 0, attachments: { files: { file: [{ id: 9001, title: "My essay", filename: "essay.pdf", filesize: 1234, download_path: "https://api.schoology.com/v1/attachment/9001/source/x" }] } } },
      { revision_id: 2, uid: 4242, created: at, num_items: 1, late: 1, draft: 0, body: "<p>My <b>answer</b> &amp; more</p><script>x</script>" },
      { revision_id: 3, uid: 9999, created: at + 10, body: "someone else's" },
      { revision_id: "x", uid: 4242, created: at },
    ],
  };
  const revisions = adaptHistory(raw, UID, "America/Los_Angeles");
  check("newest first, only this student's, only real ids", revisions.map((r) => r.id), ["2", "1"]);
  check("a text revision", revisions[0], { id: "2", created: at * 1000, when: "Oct 6, 2:05 PM", late: true, draft: false, files: [], text: "My answer & more x" });
  check("a file revision: named like the Files page, no download path", revisions[1].files, [{ id: "9001", name: "My essay.pdf", size: 1234 }]);
  checkTrue("no Schoology URL reaches the app", !JSON.stringify(revisions).includes("schoology.com"));
  check("one revision (not in a list) still counts", adaptHistory({ revision: { revision_id: 5, uid: 4242, created: at } }, UID, "UTC").map((r) => r.id), ["5"]);
  check("text is cut at 2000 characters", adaptHistory({ revision: [{ revision_id: 6, body: "é".repeat(3000) }] }, UID, "UTC")[0].text.length, 2000);
  check("a bare revision answer", revisionFromAnswer({ revision_id: 7, created: at, late: 0, draft: 0 }, "UTC")?.id, "7");
  check("a wrapped revision answer", revisionFromAnswer({ revision: [{ revision_id: 8, created: at }] }, "UTC")?.id, "8");
  check("no answer: null", revisionFromAnswer(null, "UTC"), null);
}

/* ═══ unit: the upload token ═════════════════════════════════════════ */

console.log("upload token");
const LOCATION = "https://api.schoology.com/v1/upload/88433?upload_token=s3cr3t";
const MD5 = "0123456789abcdef0123456789abcdef";
const BYTES = new TextEncoder().encode("%PDF-1.4 hello essay");
const claim: UploadClaim = { l: LOCATION, s: "111", a: "601", u: UID, f: "88433", n: BYTES.byteLength, m: MD5, fn: "essay.pdf" };
{
  const token = await sealUpload(claim, SECRET);
  check("opens with the same secret", await openUpload(token, SECRET), claim);
  checkTrue("the upload location can't be read out of it", !token.includes("s3cr3t") && !Buffer.from(token.split(".")[1], "base64url").toString("latin1").includes("schoology"));
  check("not with another secret", await openUpload(token, "other"), null);
  check("not when tampered with", await openUpload(flip(token, token.length - 2), SECRET), null);
  check("not when expired", await openUpload(await sealValue(claim, SECRET, UPLOAD_PURPOSE, -5), SECRET), null);
  check("not a value sealed for something else", await openUpload(await sealValue(claim, SECRET, EXPORT_PURPOSE, 600), SECRET), null);
  check("not a session cookie", await openUpload(student.split("=")[1], SECRET), null);
  check("not one that points off Schoology", await openUpload(await sealValue({ ...claim, l: "https://evil.com/u" }, SECRET, UPLOAD_PURPOSE, 600), SECRET), null);
}

/* ═══ routes: who can turn in ════════════════════════════════════════ */

console.log("\nwho can turn in");
upstream = () => json({}, 500);
calls = [];
check("signed out: 401", await errorOf(call("/submit/history?section=111&assignment=601")), [401, "not_authenticated"]);
check("demo: 403", await errorOf(call("/submit/history?section=111&assignment=601", { cookie: demo })), [403, "not_available_in_demo"]);
check("Google Classroom: turn in on Classroom", await errorOf(call("/submit/upload", { method: "POST", cookie: google, json: { section: "111", assignment: "601", filename: "a.pdf", filesize: 10, md5: MD5 } })), [404, "turn_in_on_classroom"]);
check("...for every route", await errorOf(call("/submit/text", { method: "POST", cookie: google, json: { section: "1", assignment: "2", body: "x" } })), [404, "turn_in_on_classroom"]);
check("no upstream calls for any of them", calls.length, 0);
check("another site's page can't start an upload", await errorOf(call("/submit/upload", { method: "POST", cookie: student, origin: "https://evil.example", json: {} })), [403, "forbidden_origin"]);
check("a form post (not JSON) can't either", await errorOf(call("/submit/file", { method: "POST", cookie: student, headers: { "Content-Type": "text/plain" }, body: "{}" })), [415, "json_required"]);

/* ═══ routes: step 1 ═════════════════════════════════════════════════ */

console.log("\nPOST /submit/upload");
let uploadLocation = LOCATION;
let putAnswer: (call: Call) => Response | Promise<Response> = async (c) => {
  await drain(c);
  return json({ id: 88433, filename: "essay.pdf", filesize: BYTES.byteLength, filemime: "application/pdf", md5_checksum: MD5 });
};
const AT = Date.UTC(2026, 9, 6, 21, 5) / 1000;
let attachStatus = 201;
function schoology(c: Call): Response | Promise<Response> {
  const p = c.url.pathname;
  if (c.url.hostname === "api.schoology.com" && p === "/v1/upload" && c.method === "POST") {
    return json({ id: 88433, upload_location: uploadLocation, filename: "essay.pdf", filesize: BYTES.byteLength, md5_checksum: MD5, timestamp: AT });
  }
  if (c.method === "PUT") return putAnswer(c);
  if (p === "/v1/sections/111/submissions/601/file" && c.method === "POST") {
    return attachStatus === 201 ? json({ revision_id: 7, uid: 4242, created: AT, num_items: 2, late: 0, draft: 0 }, 201) : json({}, attachStatus);
  }
  if (p === "/v1/sections/111/submissions/601/create" && c.method === "POST") return json({ revision_id: 8, uid: 4242, created: AT, num_items: 1, late: 0, draft: 0 }, 201);
  if (p === "/v1/sections/111/submissions/601/4242" && c.method === "GET") {
    return json({ revision: [{ revision_id: 7, uid: 4242, created: AT, late: 0, draft: 0, attachments: { files: { file: [{ id: 88433, title: "essay.pdf", filesize: 20 }] } } }] });
  }
  if (p === "/v1/sections/111/submissions/602/4242") return json({}, 404);
  return json({ error: "unexpected" }, 500);
}
upstream = schoology;
{
  calls = [];
  const { res, data } = await call("/submit/upload", { method: "POST", cookie: student, json: { section: "111", assignment: "601", filename: "essay.pdf", filesize: BYTES.byteLength, md5: MD5.toUpperCase() } });
  const sent = calls[0];
  check("200 with a token and Schoology's file id", [res.status, typeof data.upload, data.fileId], [200, "string", "88433"]);
  check("one call: POST https://api.schoology.com/v1/upload", [calls.length, sent.method, sent.url.href], [1, "POST", "https://api.schoology.com/v1/upload"]);
  check("its JSON body is exactly filename, filesize, md5_checksum (lowercase)", JSON.parse(String(sent.body)), { filename: "essay.pdf", filesize: BYTES.byteLength, md5_checksum: MD5 });
  check("sent as JSON, asking for JSON", [sent.headers.get("Content-Type"), sent.headers.get("Accept")], ["application/json", "application/json"]);
  check("signed for POST on that URL (the body isn't signed)", await signatureOk("POST", sent.url.href, sent.headers.get("Authorization") ?? ""), true);
  check("redirects aren't followed", sent.init.redirect, "manual");
  checkTrue("the upload location never reaches the browser", !JSON.stringify(data).includes("s3cr3t") && !JSON.stringify(data).includes("upload/88433"));
  check("no caching", res.headers.get("Cache-Control"), "private, no-store");
  check("the token is for this student and this file", await openUpload(data.upload, SECRET), { ...claim, m: MD5 });

  check("Incognito can turn in (nothing is stored)", (await call("/submit/upload", { method: "POST", cookie: incognito, json: { section: "111", assignment: "601", filename: "essay.pdf", filesize: 20, md5: MD5 } })).res.status, 200);

  calls = [];
  const bad = (json: unknown) => errorOf(call("/submit/upload", { method: "POST", cookie: student, json }));
  const base = { section: "111", assignment: "601", filename: "essay.pdf", filesize: 20, md5: MD5 };
  check("ids must be digits", [await bad({ ...base, section: "../1" }), await bad({ ...base, assignment: "1 OR 1" })], [[400, "bad_request"], [400, "bad_request"]]);
  check("file name with a path is refused", await bad({ ...base, filename: "../../x.pdf" }), [400, "bad_request"]);
  check("file name over 255 is refused", await bad({ ...base, filename: "x".repeat(256) }), [400, "bad_request"]);
  check("md5 must be 32 hex", [await bad({ ...base, md5: "abc" }), await bad({ ...base, md5: "g".repeat(32) })], [[400, "bad_request"], [400, "bad_request"]]);
  check("empty file is refused", await bad({ ...base, filesize: 0 }), [400, "bad_request"]);
  check("over 95 MB: 413", await bad({ ...base, filesize: MAX_UPLOAD_BYTES + 1 }), [413, "file_too_large"]);
  check("not JSON: 400", await errorOf(call("/submit/upload", { method: "POST", cookie: student, headers: { "Content-Type": "application/json" }, body: "{nope" })), [400, "invalid_body"]);
  check("none of those reached Schoology", calls.length, 0);

  uploadLocation = "https://evil.example/upload/88433";
  check("an upload location off Schoology: refused, no token", await bad(base), [502, "schoology_error"]);
  uploadLocation = "http://api.schoology.com/v1/upload/88433";
  check("an http upload location: refused", await bad(base), [502, "schoology_error"]);
  uploadLocation = LOCATION;
}

/* ═══ routes: step 2 ═════════════════════════════════════════════════ */

console.log("\nPUT /submit/upload/<token>");
async function put(token: string, bytes: Uint8Array, opts: { cookie?: string; length?: string | null; type?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": opts.type ?? "application/pdf" };
  if (opts.length !== null) headers["Content-Length"] = opts.length ?? String(bytes.byteLength);
  return call(`/submit/upload/${token}`, { method: "PUT", cookie: opts.cookie ?? student, headers, body: new Blob([bytes]).stream() });
}
{
  const token = await sealUpload(claim, SECRET);
  calls = [];
  const { res, req, data } = await put(token, BYTES);
  const sent = calls[0];
  check("200 with the file id", [res.status, data], [200, { fileId: "88433" }]);
  check("one PUT, to the sealed upload location", [calls.length, sent.method, sent.url.href], [1, "PUT", LOCATION]);
  check("the same bytes went up", Array.from(sent.bytes ?? []), Array.from(BYTES));
  checkTrue("streamed: the request's own body stream is handed on, never read into memory", sent.body === req.body);
  check("Content-Length and Content-Type passed on", [sent.headers.get("Content-Length"), sent.headers.get("Content-Type")], [String(BYTES.byteLength), "application/pdf"]);
  check("signed for PUT on the full location, query included", await signatureOk("PUT", LOCATION, sent.headers.get("Authorization") ?? ""), true);
  check("a redirect isn't followed", sent.init.redirect, "manual");

  // Workers: a FixedLengthStream carries the body, so the exact length is declared and enforced.
  const g = globalThis as any;
  g.FixedLengthStream = class {
    readable: ReadableStream;
    writable: WritableStream;
    constructor(expected: number) {
      let seen = 0;
      const t = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          seen += chunk.byteLength;
          if (seen > expected) ctl.error(new TypeError("more bytes than declared"));
          else ctl.enqueue(chunk);
        },
        flush(ctl) {
          if (seen !== expected) ctl.error(new TypeError("fewer bytes than declared"));
        },
      });
      this.readable = t.readable;
      this.writable = t.writable;
      (this.readable as any).fixedLength = expected;
    }
  };
  calls = [];
  const fixed = await put(token, BYTES);
  check("with FixedLengthStream: 200", fixed.res.status, 200);
  check("...the body is a fixed-length stream of the sealed size", calls[0].body?.fixedLength, BYTES.byteLength);
  check("...carrying the same bytes", Array.from(calls[0].bytes ?? []), Array.from(BYTES));
  calls = [];
  const short = await put(token, BYTES.slice(0, -1), { length: String(BYTES.byteLength) });
  check("a body shorter than its Content-Length fails the upload", [short.res.status, short.data?.error], [502, "schoology_error"]);
  delete g.FixedLengthStream;

  calls = [];
  check("someone else's token: refused", await errorOf(put(token, BYTES, { cookie: classmate })), [403, "upload_not_yours"]);
  check("a tampered token: refused", await errorOf(put(flip(token, 20), BYTES)), [403, "upload_expired"]);
  check("an expired token: refused", await errorOf(put(await sealValue(claim, SECRET, UPLOAD_PURPOSE, -1), BYTES)), [403, "upload_expired"]);
  check("an export token can't pose as an upload token", await errorOf(put(await sealExport({ j: "J", d: "D", t: "", u: UID }, SECRET), BYTES)), [403, "upload_expired"]);
  check("Content-Length not the size Schoology was told: refused", await errorOf(put(token, new Uint8Array(BYTES.byteLength + 1))), [400, "size_mismatch"]);
  check("no Content-Length: 411", await errorOf(put(token, BYTES, { length: null })), [411, "length_required"]);
  check("over 95 MB declared: 413", await errorOf(put(token, BYTES, { length: String(MAX_UPLOAD_BYTES + 1) })), [413, "file_too_large"]);
  check("Classroom: refused", await errorOf(put(token, BYTES, { cookie: google })), [404, "turn_in_on_classroom"]);
  check("another site's page: refused", await errorOf(call(`/submit/upload/${token}`, { method: "PUT", cookie: student, origin: "https://evil.example", headers: { "Content-Length": "20" }, body: BYTES })), [403, "forbidden_origin"]);
  check("none of those reached Schoology", calls.length, 0);

  // A location on another Schoology host gets the bytes but never the signature.
  const filesClaim = { ...claim, l: "https://files.schoology.com/upload/88433?sig=abc" };
  calls = [];
  const other = await put(await sealUpload(filesClaim, SECRET), BYTES);
  check("another *.schoology.com host: uploaded", other.res.status, 200);
  check("...without the OAuth signature", calls[0].headers.get("Authorization"), null);

  putAnswer = () => new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } });
  calls = [];
  check("Schoology redirecting the upload: fails clearly", await errorOf(put(token, BYTES)), [502, "upload_redirected"]);
  check("...and the redirect isn't followed", calls.length, 1);
  putAnswer = async (c) => {
    await drain(c);
    return json({ error: "md5 mismatch" }, 400);
  };
  check("Schoology refusing the bytes (MD5 or size): 422", await errorOf(put(token, BYTES)), [422, "upload_rejected"]);
  putAnswer = async (c) => {
    await drain(c);
    return json({ id: 99999 });
  };
  check("Schoology naming a different file: refused", await errorOf(put(token, BYTES)), [502, "upload_mismatch"]);
  putAnswer = async (c) => {
    await drain(c);
    return json({}, 503);
  };
  check("Schoology down: 502", await errorOf(put(token, BYTES)), [502, "schoology_error"]);
  putAnswer = async (c) => {
    await drain(c);
    return json({ id: 88433 });
  };
}

/* ═══ routes: step 3, text, history ══════════════════════════════════ */

console.log("\nPOST /submit/file");
{
  calls = [];
  const { res, data } = await call("/submit/file?tz=America/Los_Angeles", { method: "POST", cookie: student, json: { section: "111", assignment: "601", fileIds: ["88433", 88434, "88433"] } });
  const sent = calls[0];
  check("200 with the new revision", [res.status, data], [200, { ok: true, revision: { id: "7", created: AT * 1000, when: "Oct 6, 2:05 PM", late: false, draft: false, files: [], text: "" } }]);
  check("POST to the assignment's submissions/file", [calls.length, sent.method, sent.url.href], [1, "POST", "https://api.schoology.com/v1/sections/111/submissions/601/file"]);
  check("body: every file once, as strings", JSON.parse(String(sent.body)), { "file-attachment": { id: ["88433", "88434"] } });
  check("signed", await signatureOk("POST", sent.url.href, sent.headers.get("Authorization") ?? ""), true);
  calls = [];
  const bad = (body: unknown) => errorOf(call("/submit/file", { method: "POST", cookie: student, json: body }));
  check("no files: 400", await bad({ section: "111", assignment: "601", fileIds: [] }), [400, "bad_request"]);
  check("21 files: 400", await bad({ section: "111", assignment: "601", fileIds: Array.from({ length: 21 }, (_, i) => String(i + 1)) }), [400, "bad_request"]);
  check("a non-numeric file id: 400", await bad({ section: "111", assignment: "601", fileIds: ["1", "../2"] }), [400, "bad_request"]);
  check("fileIds not a list: 400", await bad({ section: "111", assignment: "601", fileIds: "1" }), [400, "bad_request"]);
  check("none of those reached Schoology", calls.length, 0);
  attachStatus = 403;
  check("Schoology refusing (dropbox closed): 502 with its status", (await call("/submit/file", { method: "POST", cookie: student, json: { section: "111", assignment: "601", fileIds: ["1"] } })).data, { error: "schoology_error", status: 403 });
  attachStatus = 201;
}

console.log("\nPOST /submit/text");
{
  calls = [];
  const { res, data } = await call("/submit/text", { method: "POST", cookie: student, json: { section: "111", assignment: "601", body: `<p onclick="x">My <b>answer</b><script>steal()</script> <a href="https://ok.example/x" style="y">source</a></p>` } });
  const sent = calls[0];
  check("200 with the revision", [res.status, data.ok, data.revision?.id], [200, true, "8"]);
  check("POST to submissions/create", [sent.method, sent.url.href], ["POST", "https://api.schoology.com/v1/sections/111/submissions/601/create"]);
  check("body: the cleaned HTML, not a draft", JSON.parse(String(sent.body)), { body: `<p>My <b>answer</b> <a href="https://ok.example/x">source</a></p>`, draft: 0 });
  calls = [];
  check("nothing left after cleaning: 400", await errorOf(call("/submit/text", { method: "POST", cookie: student, json: { section: "111", assignment: "601", body: "<p> </p><script>x</script>" } })), [400, "empty_submission"]);
  check("an editor's empty answer: 400", await errorOf(call("/submit/text", { method: "POST", cookie: student, json: { section: "111", assignment: "601", body: "<p>&nbsp;</p><p><br></p>" } })), [400, "empty_submission"]);
  check("over 100 KB: 413", await errorOf(call("/submit/text", { method: "POST", cookie: student, json: { section: "111", assignment: "601", body: "<p>" + "x".repeat(100 * 1024) + "</p>" } })), [413, "text_too_large"]);
  check("under 100 KB in, over once escaped: 413", await errorOf(call("/submit/text", { method: "POST", cookie: student, json: { section: "111", assignment: "601", body: "<p>" + "<".repeat(40 * 1024) + "</p>" } })), [413, "text_too_large"]);
  check("body not a string: 400", await errorOf(call("/submit/text", { method: "POST", cookie: student, json: { section: "111", assignment: "601", body: ["<p>x</p>"] } })), [400, "bad_request"]);
  check("none of those reached Schoology", calls.length, 0);
}

console.log("\nGET /submit/history");
{
  calls = [];
  const { res, data } = await call("/submit/history?section=111&assignment=601&tz=America/Los_Angeles", { cookie: student });
  const sent = calls[0];
  check("this student's revisions, adapted", [res.status, data], [200, { revisions: [{ id: "7", created: AT * 1000, when: "Oct 6, 2:05 PM", late: false, draft: false, files: [{ id: "88433", name: "essay.pdf", size: 20 }], text: "" }] }]);
  check("asked for this student's own, with attachments", [sent.method, sent.url.origin + sent.url.pathname, sent.url.searchParams.get("with_attachments")], ["GET", "https://api.schoology.com/v1/sections/111/submissions/601/4242", "1"]);
  check("signed", await signatureOk("GET", sent.url.href, sent.headers.get("Authorization") ?? ""), true);
  check("nothing turned in yet (Schoology 404): empty", (await call("/submit/history?section=111&assignment=602", { cookie: student })).data, { revisions: [] });
  check("a bad time zone falls back to UTC", (await call("/submit/history?section=111&assignment=601&tz=Not/AZone", { cookie: student })).data.revisions[0].when, "Oct 6, 9:05 PM");
  check("bad ids: 400", await errorOf(call("/submit/history?section=111&assignment=6x", { cookie: student })), [400, "bad_request"]);
  check("Incognito can see its history", (await call("/submit/history?section=111&assignment=601", { cookie: incognito })).res.status, 200);
}

/* ═══ Canva: scopes ══════════════════════════════════════════════════ */

console.log("\nCanva scopes");
{
  check("flag off: the three scopes", canvaScopes({}), "design:content:write design:meta:read profile:read");
  check("flag on: plus design:content:read", canvaScopes({ CANVA_EXPORT_ENABLED: "1" }), "design:content:write design:meta:read profile:read design:content:read");
  check("only exactly \"1\" turns it on", [canvaScopes({ CANVA_EXPORT_ENABLED: "true" }), canvaScopes({ CANVA_EXPORT_ENABLED: "0" })].every((s) => !s.includes(EXPORT_SCOPE)), true);
  const on = new URL(await new CanvaAccount(new MemoryStorage(), ENV as any).beginConnect("/settings"));
  check("connecting with the flag on asks for it", on.searchParams.get("scope"), "design:content:write design:meta:read profile:read design:content:read");
  const off = new URL(await new CanvaAccount(new MemoryStorage(), { ...ENV, CANVA_EXPORT_ENABLED: undefined } as any).beginConnect("/settings"));
  check("...and with it off doesn't", off.searchParams.get("scope"), "design:content:write design:meta:read profile:read");

  const acct = new CanvaAccount(new MemoryStorage(), ENV as any);
  const soon = Math.floor(Date.now() / 1000) + 3600;
  await acct.saveTokens(UID, { access_token: "OLD_CONN", refresh_token: "R", expires_at: soon, scope: "design:content:write design:meta:read profile:read" });
  check("the granted scopes are kept", await acct.grantedScopes(UID), ["design:content:write", "design:meta:read", "profile:read"]);
  let reason = "";
  await acct.accessTokenWithScope(UID, EXPORT_SCOPE).catch((e) => (reason = (e as Error).message));
  check("a connection made without the scope must reconnect", reason, "canva_reconnect_needed");
  check("...without being disconnected", (await acct.status(UID)).connected, true);
  await acct.saveTokens(UID, { access_token: "NEW_CONN", refresh_token: "R", expires_at: soon, scope: `design:meta:read ${EXPORT_SCOPE}` });
  check("one that has it gets its token", await acct.accessTokenWithScope(UID, EXPORT_SCOPE), "NEW_CONN");
  await acct.saveTokens(UID, { access_token: "UNKNOWN", refresh_token: "R", expires_at: soon });
  check("scopes never reported: Canva decides", await acct.accessTokenWithScope(UID, EXPORT_SCOPE), "UNKNOWN");

  await acct.saveTokens(UID, { access_token: "EXPIRING", refresh_token: "R1", expires_at: 0, scope: `profile:read ${EXPORT_SCOPE}` });
  upstream = (c) => (c.url.pathname.endsWith("/oauth/token") ? json({ access_token: "REFRESHED", refresh_token: "R2", expires_in: 14400 }) : json({}, 404));
  check("a refresh answer without scope...", await acct.accessTokenWithScope(UID, EXPORT_SCOPE), "REFRESHED");
  check("...keeps the scopes already granted", await acct.grantedScopes(UID), ["profile:read", EXPORT_SCOPE]);
  upstream = (c) => (c.url.pathname.endsWith("/oauth/token") ? json({ access_token: "A3", refresh_token: "R3", expires_in: 14400, scope: "profile:read" }) : json({}, 404));
  await acct.saveTokens(UID, { access_token: "EXPIRING", refresh_token: "R2", expires_at: 0, scope: `profile:read ${EXPORT_SCOPE}` });
  await acct.accessToken(UID);
  check("one that reports scopes replaces them", await acct.grantedScopes(UID), ["profile:read"]);
}

/* ═══ Canva: export routes ═══════════════════════════════════════════ */

console.log("\nCanva export routes");
const PDF = new TextEncoder().encode("%PDF-1.7 a design");
const JOB = "e08861ae-3b29-45db-8dc1-1fe0bf7f1cc8";
let jobStatus: any = { id: JOB, status: "in_progress" };
let exportCreate: (c: Call) => Response = () => json({ job: { id: JOB, status: "in_progress" } });
let downloadUrl = "https://export-download.canva.com/DES1/1/0/0001.pdf?X-Amz-Signature=abc";
let download: (c: Call) => Response = () => new Response(PDF, { headers: { "Content-Type": "binary/octet-stream", "Content-Length": String(PDF.byteLength) } });
function canva(c: Call): Response {
  const p = c.url.pathname;
  if (c.url.hostname === "api.canva.com") {
    if (p === "/rest/v1/designs/DES1") return json({ design: { id: "DES1", title: "Lab Report: Final/v2", urls: { edit_url: "https://www.canva.com/design/DES1/edit", view_url: "https://www.canva.com/design/DES1/view" }, updated_at: 1759700000 } });
    if (p === "/rest/v1/designs/GONE") return json({ code: "not_found" }, 404);
    if (p === "/rest/v1/exports" && c.method === "POST") return exportCreate(c);
    if (p === `/rest/v1/exports/${JOB}`) return json({ job: jobStatus });
    return json({ code: "not_found" }, 404);
  }
  return download(c);
}
upstream = canva;
const canvaAcct = accountFor(UID);
const WITH_SCOPE = `design:content:write design:meta:read profile:read ${EXPORT_SCOPE}`;
await canvaAcct.saveTokens(UID, { access_token: "CANVA_AT", refresh_token: "R", expires_at: Math.floor(Date.now() / 1000) + 3600, scope: WITH_SCOPE });
await canvaAcct.addDraft({ designId: "GONE", title: "Old", sourceName: "a.pdf", fileId: "1", section: "111", assignment: "601", createdAt: 1, updatedAt: 1 });
const startExport = (id: string, opts: Init = {}, env = ENV) => call(`/canva/designs/${id}/export`, { method: "POST", cookie: student, json: {}, ...opts }, env);
{
  calls = [];
  const { res, data } = await startExport("DES1");
  check("export started: 200 with a job token", [res.status, typeof data.job], [200, "string"]);
  check("the design is looked up first, with the student's token", [calls[0].method, calls[0].url.href, calls[0].headers.get("Authorization")], ["GET", "https://api.canva.com/rest/v1/designs/DES1", "Bearer CANVA_AT"]);
  check("then POST /exports", [calls.length, calls[1].method, calls[1].url.href, calls[1].headers.get("Authorization"), calls[1].headers.get("Content-Type")], [2, "POST", "https://api.canva.com/rest/v1/exports", "Bearer CANVA_AT", "application/json"]);
  check("asking for a PDF of that design", JSON.parse(String(calls[1].body)), { design_id: "DES1", format: { type: "pdf" } });
  checkTrue("the token isn't Canva's bare job id", data.job !== JOB && !data.job.includes(JOB));
  const job = data.job as string;

  calls = [];
  check("a design they can't open: 404", await errorOf(startExport("GONE")), [404, "canva_design_gone"]);
  check("...nothing exported", calls.filter((x) => x.url.pathname === "/rest/v1/exports").length, 0);
  check("...and it leaves their drafts", (await canvaAcct.listDrafts("111", "601")).length, 0);
  check("a bad design id: 400", await errorOf(startExport("DES1%2F..")), [400, "bad_request"]);
  check("not JSON: 415", await errorOf(call("/canva/designs/DES1/export", { method: "POST", cookie: student, headers: { "Content-Type": "text/plain" }, body: "x" })), [415, "json_required"]);
  check("demo: 403", await errorOf(startExport("DES1", { cookie: demo })), [403, "not_available_in_demo"]);
  check("Incognito (no Canva at all): 403", await errorOf(startExport("DES1", { cookie: incognito })), [403, "incognito_mode"]);
  check("not connected: 409", await errorOf(startExport("DES1", { cookie: classmate })), [409, "canva_not_connected"]);

  calls = [];
  check("flag off: reconnect needed", await errorOf(startExport("DES1", {}, { ...ENV, CANVA_EXPORT_ENABLED: undefined })), [409, "canva_reconnect_needed"]);
  check("...for status", await errorOf(call(`/canva/exports/${job}`, { cookie: student }, { ...ENV, CANVA_EXPORT_ENABLED: "0" })), [409, "canva_reconnect_needed"]);
  check("...and for the file", await errorOf(call(`/canva/exports/${job}/file?design=DES1`, { cookie: student }, { ...ENV, CANVA_EXPORT_ENABLED: undefined })), [409, "canva_reconnect_needed"]);
  check("...with no Canva calls", calls.length, 0);

  await canvaAcct.saveTokens(UID, { access_token: "CANVA_AT", refresh_token: "R", expires_at: Math.floor(Date.now() / 1000) + 3600, scope: "design:content:write design:meta:read profile:read" });
  calls = [];
  check("a token without design:content:read: reconnect needed", await errorOf(startExport("DES1")), [409, "canva_reconnect_needed"]);
  check("...before any Canva call", calls.length, 0);
  await canvaAcct.saveTokens(UID, { access_token: "CANVA_AT", refresh_token: "R", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  exportCreate = () => json({ code: "permission_denied", message: "Missing scopes: [design:content:read]" }, 403);
  check("scopes unknown and Canva says 403: reconnect needed", await errorOf(startExport("DES1")), [409, "canva_reconnect_needed"]);
  exportCreate = () => json({ code: "too_many_requests" }, 429);
  check("Canva throttling: 429", await errorOf(startExport("DES1")), [429, "canva_rate_limited"]);
  exportCreate = () => json({ job: { id: JOB, status: "in_progress" } });
  await canvaAcct.saveTokens(UID, { access_token: "CANVA_AT", refresh_token: "R", expires_at: Math.floor(Date.now() / 1000) + 3600, scope: WITH_SCOPE });

  console.log("\nexport status");
  calls = [];
  jobStatus = { id: JOB, status: "in_progress" };
  const status = await call(`/canva/exports/${job}`, { cookie: student });
  check("in progress", [status.res.status, status.data], [200, { status: "in_progress" }]);
  check("asked Canva about that job with the student's token", [calls[0].url.href, calls[0].headers.get("Authorization")], [`https://api.canva.com/rest/v1/exports/${JOB}`, "Bearer CANVA_AT"]);
  jobStatus = { id: JOB, status: "success", urls: [downloadUrl] };
  check("success (no download URL to the browser)", (await call(`/canva/exports/${job}`, { cookie: student })).data, { status: "success" });
  jobStatus = { id: JOB, status: "failed", error: { code: "license_required", message: "x" } };
  check("failed, saying why", (await call(`/canva/exports/${job}`, { cookie: student })).data, { status: "failed", error: "canva_export_license_required" });
  calls = [];
  check("another student's job: 404", await errorOf(call(`/canva/exports/${job}`, { cookie: classmate })), [404, "canva_export_not_found"]);
  check("a made-up job: 404", await errorOf(call(`/canva/exports/${JOB}`, { cookie: student })), [404, "canva_export_not_found"]);
  check("an upload token as a job: 404", await errorOf(call(`/canva/exports/${await sealUpload(claim, SECRET)}`, { cookie: student })), [404, "canva_export_not_found"]);
  check("...none of them asked Canva", calls.length, 0);

  console.log("\nexport file");
  jobStatus = { id: JOB, status: "success", urls: [downloadUrl] };
  calls = [];
  const file = await call(`/canva/exports/${job}/file?design=DES1`, { cookie: student });
  const bytes = new Uint8Array(await file.res.arrayBuffer());
  check("200 with the PDF's bytes", [file.res.status, Array.from(bytes)], [200, Array.from(PDF)]);
  check("as a PDF named after the design", [file.res.headers.get("Content-Type"), file.res.headers.get("Content-Disposition")], ["application/pdf", contentDisposition("Lab Report: Final v2.pdf")]);
  check("with its length, uncached, no sniffing, name readable by the app", [file.res.headers.get("Content-Length"), file.res.headers.get("Cache-Control"), file.res.headers.get("X-Content-Type-Options"), file.res.headers.get("Access-Control-Expose-Headers")], [String(PDF.byteLength), "private, no-store", "nosniff", "Content-Disposition"]);
  const dl = calls.find((x) => x.url.hostname === "export-download.canva.com")!;
  check("downloaded from Canva's URL with no credentials", [dl?.url.href, dl?.headers.get("Authorization"), dl?.init.redirect], [downloadUrl, null, "manual"]);
  check("the design must be the one exported", await errorOf(call(`/canva/exports/${job}/file?design=OTHER`, { cookie: student })), [400, "bad_request"]);
  check("another student's job: 404", await errorOf(call(`/canva/exports/${job}/file?design=DES1`, { cookie: classmate })), [404, "canva_export_not_found"]);
  jobStatus = { id: JOB, status: "in_progress" };
  check("not ready yet: 409", await errorOf(call(`/canva/exports/${job}/file?design=DES1`, { cookie: student })), [409, "canva_export_not_ready"]);
  jobStatus = { id: JOB, status: "failed", error: { code: "approval_required" } };
  check("failed: 422 saying why", await errorOf(call(`/canva/exports/${job}/file?design=DES1`, { cookie: student })), [422, "canva_export_approval_required"]);

  jobStatus = { id: JOB, status: "success", urls: ["http://export-download.canva.com/a.pdf"] };
  calls = [];
  check("an http download URL is refused", await errorOf(call(`/canva/exports/${job}/file?design=DES1`, { cookie: student })), [502, "canva_export_unavailable"]);
  check("...and never fetched", calls.some((x) => x.url.protocol === "http:"), false);
  jobStatus = { id: JOB, status: "success", urls: ["https://169.254.169.254/latest/meta-data"] };
  check("an IP address is refused", await errorOf(call(`/canva/exports/${job}/file?design=DES1`, { cookie: student })), [502, "canva_export_unavailable"]);
  jobStatus = { id: JOB, status: "success", urls: [downloadUrl] };
  download = (c) => (c.url.hostname === "export-download.canva.com" ? new Response(null, { status: 302, headers: { Location: "http://plain.example/x.pdf" } }) : new Response(PDF));
  check("a redirect to http is refused", await errorOf(call(`/canva/exports/${job}/file?design=DES1`, { cookie: student })), [502, "canva_export_unavailable"]);
  download = (c) => (c.url.hostname === "export-download.canva.com" ? new Response(null, { status: 302, headers: { Location: "https://cdn.example-storage.com/x.pdf" } }) : new Response(PDF, { headers: { "Content-Length": String(PDF.byteLength) } }));
  calls = [];
  const hopped = await call(`/canva/exports/${job}/file?design=DES1`, { cookie: student });
  check("an https redirect is followed by hand", [hopped.res.status, Array.from(new Uint8Array(await hopped.res.arrayBuffer()))], [200, Array.from(PDF)]);
  check("...with no credentials on either hop", calls.filter((x) => x.url.hostname !== "api.canva.com").map((x) => x.headers.get("Authorization")), [null, null]);
  download = () => new Response(PDF, { headers: { "Content-Length": String(MAX_UPLOAD_BYTES + 1) } });
  check("over 95 MB declared: 413", await errorOf(call(`/canva/exports/${job}/file?design=DES1`, { cookie: student })), [413, "file_too_large"]);
  download = () => new Response(new Blob([PDF]).stream());
  const unsized = await call(`/canva/exports/${job}/file?design=DES1`, { cookie: student });
  check("no length given: still streams through (counted)", [unsized.res.status, unsized.res.headers.get("Content-Length"), Array.from(new Uint8Array(await unsized.res.arrayBuffer()))], [200, null, Array.from(PDF)]);
  download = () => new Response("gone", { status: 403 });
  check("an expired download link: 502", await errorOf(call(`/canva/exports/${job}/file?design=DES1`, { cookie: student })), [502, "canva_export_unavailable"]);
}

/* ── Real editor output (2026-10-06 review) ───────────────────────────── */
{
  console.log("\nsanitizer: what a browser's editor really sends");
  check("one line, no tags: decoded once, never double-escaped", sanitizeSubmission("Tom &amp; Jerry&nbsp; x &lt; y").html, "<p>Tom &amp; Jerry\u00a0 x &lt; y</p>");
  check("Enter makes <div>s: each is a new line, words don't run together", sanitizeSubmission("First<div>Second</div><div>Third &amp; last</div>").html, "First<br>Second<br>Third &amp; last");
  check("a blank line (<div><br></div>) stays one blank line", sanitizeSubmission("Hi<div><br></div><div>After</div>").html, "Hi<br><br>After");
  check("no break doubled after a paragraph or heading", [sanitizeSubmission("<p>A</p><div>B</div>").html, sanitizeSubmission("<h2>T</h2><div>x</div>").html], ["<p>A</p>B", "<h2>T</h2>x"]);
  check("block tags' attributes still dropped", sanitizeSubmission('<div onclick="x" style="y">ok</div><blockquote>q</blockquote>').html, "ok<br>q");
  const t0 = performance.now();
  sanitizeSubmission('<a href="https://[">'.repeat(5000));
  check("hrefs that fail to parse are capped too (CPU)", performance.now() - t0 < 60, true);
}

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
