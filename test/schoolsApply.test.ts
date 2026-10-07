/**
 * Schools flow (2026-10-06): the schools@averages.io automatic reply, the
 * application form's endpoint, Martin's list, and the email builder.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/schoolsApply.test.ts
 */
import worker, { handleSchoolsEmail } from "../src/index.ts";
import { autoReplyAllowed, buildMime, cleanEmail, encodeHeaderWord, SCHOOLS_ADDRESS } from "../src/mail.ts";
import { canvasHost, emailEndingAllowed, emailEndings, validateApplication } from "../src/schools.ts";
import { SchoolsBook, MAX_APPS, REPLY_EVERY_MS, CODE_GAP_MS, CODE_SEND_WINDOW_MS, CODE_TTL_MS, newCode } from "../src/schoolsStore.ts";
import { APPLY_URL, autoReplyEmail, replySubject, verifyCodeEmail } from "../src/schoolsMail.ts";
import { resetRateLimits } from "../src/rateLimit.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

/** The decoded text of one part ("text/plain" or "text/html") of a raw message. */
function part(raw: string, type: string): string {
  const at = raw.indexOf(`Content-Type: ${type}`);
  if (at === -1) return "";
  const body = raw.slice(raw.indexOf("\r\n\r\n", at) + 4, raw.indexOf("\r\n--", at));
  return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (c) => c.charCodeAt(0)));
}
const headerOf = (raw: string, name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(raw.split("\r\n\r\n")[0])?.[1] ?? null;

function memStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(k: string) { return structuredClone(map.get(k)) as T | undefined; },
    async put<T>(k: string, v: T) { map.set(k, structuredClone(v)); },
  };
}

/* ── Addresses and MIME ─────────────────────────────────────────────── */
console.log("\naddresses and MIME");
check("clean addresses", [cleanEmail("IT Desk <IT@NMUSD.US>"), cleanEmail(" a.b+c@school.org "), cleanEmail("nope"), cleanEmail("a@b"), cleanEmail("x@y.org\r\nBcc: z@evil.example")], ["IT@nmusd.us", "a.b+c@school.org", "", "", ""]);
check("plain subjects stay plain", encodeHeaderWord("Averages.io for your school"), "Averages.io for your school");
check("non-ASCII subjects are encoded words", /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=( =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)*$/.test(encodeHeaderWord("Distrito Escolar de Peñasco ✓ ".repeat(3))), true);
const raw = buildMime({
  from: SCHOOLS_ADDRESS, fromName: "Averages.io", to: "it@school.org",
  subject: "Hello\r\nBcc: victim@evil.example", text: "Línea uno\nTwo", html: "<p>Hi ✓</p>",
  inReplyTo: "<abc123@mail.school.org>", autoReply: true, replyTo: "x@y.org", now: new Date(0), boundary: "B",
});
const head = raw.split("\r\n\r\n")[0];
check("a line break in the subject can't add a header", [head.includes("\r\nBcc:"), headerOf(raw, "Subject")], [false, "Hello Bcc: victim@evil.example"]);
check("threading and robot headers", [headerOf(raw, "In-Reply-To"), headerOf(raw, "References"), headerOf(raw, "Auto-Submitted"), headerOf(raw, "Reply-To")], ["<abc123@mail.school.org>", "<abc123@mail.school.org>", "auto-replied", "x@y.org"]);
check("From, To, MIME", [headerOf(raw, "From"), headerOf(raw, "To"), headerOf(raw, "MIME-Version"), /@averages\.io>$/.test(headerOf(raw, "Message-ID") ?? "")], ["Averages.io <schools@averages.io>", "it@school.org", "1.0", true]);
check("both parts decode to what went in", [part(raw, "text/plain"), part(raw, "text/html")], ["Línea uno\nTwo", "<p>Hi ✓</p>"]);
check("CRLF everywhere, no bare LF", /[^\r]\n/.test(raw), false);
check("a broken Message-ID isn't copied", headerOf(buildMime({ from: SCHOOLS_ADDRESS, to: "a@b.org", subject: "s", text: "t", html: "h", inReplyTo: "<x>\r\nBcc: y@z.org" }), "In-Reply-To"), null);
let threw = false;
try { buildMime({ from: SCHOOLS_ADDRESS, to: "not an address", subject: "s", text: "t", html: "h" }); } catch { threw = true; }
check("a bad recipient is refused", threw, true);

/* ── Who gets an automatic reply ────────────────────────────────────── */
console.log("\nautomatic reply rules");
const H = (o: Record<string, string> = {}) => new Headers(o);
check("a person: yes", autoReplyAllowed("Jane IT <jane@nmusd.us>", H()), { ok: true, reason: "" });
check("robots and lists: no", [
  autoReplyAllowed("noreply@nmusd.us", H()).reason,
  autoReplyAllowed("MAILER-DAEMON@mx.nmusd.us", H()).reason,
  autoReplyAllowed("jane@nmusd.us", H({ "Auto-Submitted": "auto-replied" })).reason,
  autoReplyAllowed("jane@nmusd.us", H({ Precedence: "bulk" })).reason,
  autoReplyAllowed("jane@nmusd.us", H({ "List-Id": "<staff.nmusd.us>" })).reason,
  autoReplyAllowed("jane@nmusd.us", H({ "X-Auto-Response-Suppress": "OOF, AutoReply" })).reason,
  autoReplyAllowed("jane@nmusd.us", H({ "Return-Path": "<>" })).reason,
  autoReplyAllowed("martin@averages.io", H()).reason,
  autoReplyAllowed("garbage", H()).reason,
], ["robot_sender", "robot_sender", "auto_submitted", "bulk", "mailing_list", "suppressed", "bounce", "our_domain", "no_sender"]);
check("Auto-Submitted: no is a person", autoReplyAllowed("jane@nmusd.us", H({ "Auto-Submitted": "no" })).ok, true);

/* ── The application ────────────────────────────────────────────────── */
console.log("\napplication checks");
check("Canvas addresses, however they're pasted", [canvasHost("https://NMUSD.instructure.com/courses/12?x=1"), canvasHost("canvas.nmusd.us"), canvasHost("nmusd.instructure.com:443"), canvasHost("localhost"), canvasHost("10.0.0.1"), canvasHost("my school"), canvasHost("x.local"), canvasHost("")], ["nmusd.instructure.com", "canvas.nmusd.us", "nmusd.instructure.com", "", "", "", "", ""]);
const good = { school: "  Newport Mesa   Unified ", canvas: "https://nmusd.instructure.com/", email: "IT@NMUSD.US", name: "Jane", note: "Thanks!" };
check("a good one", validateApplication(good), { ok: true, value: { school: "Newport Mesa Unified", canvas: "nmusd.instructure.com", email: "IT@nmusd.us", name: "Jane", note: "Thanks!" }, spam: false });
check("missing and bad fields are named", validateApplication({ school: "", canvas: "not a url", email: "x@" }), { ok: false, fields: { school: "missing", canvas: "invalid", email: "invalid" } });
check("limits", validateApplication({ ...good, school: "s".repeat(121), note: "n".repeat(1001), name: "m".repeat(81) }), { ok: false, fields: { school: "too_long", name: "too_long", note: "too_long" } });
check("the hidden field marks a bot", (validateApplication({ ...good, website: "http://spam.example" }) as any).spam, true);
check("not an object", validateApplication(null), { ok: false, fields: { school: "missing", canvas: "missing", email: "missing" } });

/* ── The store ──────────────────────────────────────────────────────── */
console.log("\nstore");
{
  const s = memStorage();
  const book = new SchoolsBook(s);
  const v = (validateApplication(good) as any).value;
  const first = await book.add(v, 1000);
  const again = await book.add({ ...v, note: "Again" }, 2000);
  check("the same school and contact within a day: replaced, same id", [again.duplicate, again.app.id === first.app.id, (await book.list()).length, (await book.list())[0].note], [true, true, 1, "Again"]);
  const later = await book.add(v, 2000 + 25 * 3600e3);
  check("a day later: a new one", [later.duplicate, (await book.list()).length], [false, 2]);
  for (let i = 0; i < MAX_APPS + 10; i++) await book.add({ ...v, email: `it${i}@nmusd.us` }, 10_000_000 + i);
  check("capped, newest first", [(await book.list()).length, (await book.list())[0].email], [MAX_APPS, `it${MAX_APPS + 9}@nmusd.us`]);
  check("one reply per sender per 30 days", [await book.claimReply("Jane@NMUSD.us", 0), await book.claimReply("jane@nmusd.us", 1000), await book.claimReply("jane@nmusd.us", REPLY_EVERY_MS + 1)], [true, false, true]);
  await book.claimReply("old@x.org", 0);
  await book.claimReply("new@x.org", REPLY_EVERY_MS * 3);
  check("old reply records are forgotten", Object.keys(s.map.get("replied") as object), ["new@x.org"]);
}

/* ── Email contents ─────────────────────────────────────────────────── */
console.log("\nemail contents");
{
  const m = autoReplyEmail("Averages.io for our students");
  check("reply subject threads", [m.subject, replySubject("RE: hi"), replySubject("")], ["Re: Averages.io for our students", "RE: hi", "Averages.io for your school"]);
  check("the apply link is in both parts", [m.html.includes(`href="${APPLY_URL}"`), m.text.includes(APPLY_URL)], [true, true]);
  check("no em dashes, no images", [/—/.test(m.html + m.text), /<img\b/i.test(m.html)], [false, false]);
}

/* ── Routes through the real Worker ─────────────────────────────────── */
console.log("\nroutes");
const sent: { from: string; to: string; raw: string }[] = [];
function fakeSchools() {
  const book = new SchoolsBook(memStorage());
  const stub = { add: (v: any) => book.add(v), list: () => book.list(), claimReply: (s: string) => book.claimReply(s), issueCode: (e: string) => book.issueCode(e), checkCode: (e: string, c: string) => book.checkCode(e, c), book };
  const ns: any = { idFromName: (n: string) => n, get: () => stub, jurisdiction: () => ns };
  return ns;
}
const waits: Promise<unknown>[] = [];
const CTX: any = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} };
const ENV: any = {
  SESSION_SECRET: "x",
  SCHOOLS: fakeSchools(),
  SCHOOLS_MAIL: { send: async (m: any) => { sent.push({ from: m.from, to: m.to, raw: m.raw }); } },
  SCHOOLS_NOTIFY_TO: "martin@example.org",
  SCHOOLS_ADMIN_KEY: "k".repeat(32),
};
async function post(body: unknown, opts: { origin?: string; type?: string; ip?: string } = {}) {
  const headers = new Headers({ "Content-Type": opts.type ?? "application/json", "CF-Connecting-IP": opts.ip ?? "203.0.113.50" });
  if (opts.origin !== "") headers.set("Origin", opts.origin ?? "https://app.averages.io");
  return worker.fetch(new Request("https://api.averages.io/schools/apply", { method: "POST", headers, body: JSON.stringify(body) }), ENV, CTX);
}
resetRateLimits();
{
  const nasty = { ...good, school: "<script>alert(1)</script> High", note: "a <b>bold</b> note" };
  const r = await post(nasty);
  await Promise.all(waits);
  check("applied: 200 ok, CORS for the app", [r.status, await r.json(), r.headers.get("Access-Control-Allow-Origin")], [200, { ok: true }, "https://app.averages.io"]);
  check("emailed to Martin from schools@, Reply-To the school", [sent.length, sent[0]?.from, sent[0]?.to, headerOf(sent[0]?.raw ?? "", "Reply-To")], [1, SCHOOLS_ADDRESS, "martin@example.org", "IT@nmusd.us"]);
  const html = part(sent[0]?.raw ?? "", "text/html");
  check("what the school typed is escaped in the email", [html.includes("<script>"), html.includes("&lt;script&gt;alert(1)&lt;/script&gt; High"), html.includes("&lt;b&gt;bold&lt;/b&gt;")], [false, true, true]);
  const bad = await post({ school: "", canvas: "x", email: "y" }, { ip: "203.0.113.51" });
  check("bad fields: 400 naming them", [bad.status, (await bad.json() as any).fields], [400, { school: "missing", canvas: "invalid", email: "invalid" }]);
  sent.length = 0;
  const bot = await post({ ...good, website: "x" }, { ip: "203.0.113.52" });
  await Promise.all(waits);
  check("a bot: ok, nothing stored or sent", [bot.status, sent.length], [200, 0]);
  check("another site: refused", (await post(good, { origin: "https://evil.example", ip: "203.0.113.53" })).status, 403);
  check("not JSON (a plain form): refused", (await post(good, { type: "text/plain", ip: "203.0.113.54" })).status, 415);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await post(good, { ip: "203.0.113.60" })).status);
  check("5 per 10 minutes per network, then 429", statuses, [200, 200, 200, 200, 200, 429]);
  const noStore = await worker.fetch(new Request("https://api.averages.io/schools/apply", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.averages.io", "CF-Connecting-IP": "203.0.113.61" }, body: JSON.stringify(good) }), { ...ENV, SCHOOLS: undefined }, CTX);
  check("not set up yet: 503", noStore.status, 503);
}
{
  const list = (auth?: string, env = ENV) => worker.fetch(new Request("https://api.averages.io/schools/applications", { headers: auth ? { Authorization: auth, "CF-Connecting-IP": "203.0.113.70" } : { "CF-Connecting-IP": "203.0.113.70" } }), env, CTX);
  check("list without the key: 403", (await list()).status, 403);
  check("list with a wrong key: 403", (await list("Bearer " + "j".repeat(32))).status, 403);
  const ok = await list("Bearer " + "k".repeat(32));
  const body = await ok.json() as any;
  check("list with the key: the applications", [ok.status, Array.isArray(body.applications), body.applications.length > 0, ok.headers.get("Cache-Control")], [200, true, true, "no-store"]);
  check("no key set (or a short one): the list doesn't exist", [(await list("Bearer x", { ...ENV, SCHOOLS_ADMIN_KEY: undefined })).status, (await list("Bearer short", { ...ENV, SCHOOLS_ADMIN_KEY: "short" })).status], [404, 404]);
}

/* ── Turnstile (2026-10-07) ─────────────────────────────────────────── */
console.log("\nturnstile");
{
  const { checkTurnstile } = await import("../src/schools.ts");
  const answer = (o: any, status = 200) => (async () => new Response(JSON.stringify(o), { status })) as any;
  check("good token", await checkTurnstile("tok", "s", "1.2.3.4", answer({ success: true, action: "school-apply", hostname: "app.averages.io" })), "ok");
  check("Cloudflare says no", await checkTurnstile("tok", "s", null, answer({ success: false, "error-codes": ["timeout-or-duplicate"] })), "failed");
  check("made on another site", await checkTurnstile("tok", "s", null, answer({ success: true, hostname: "evil.example" })), "failed");
  check("another form's token", await checkTurnstile("tok", "s", null, answer({ success: true, action: "login" })), "failed");
  check("no token", await checkTurnstile("", "s", null, answer({ success: true })), "failed");
  check("Cloudflare down", await checkTurnstile("tok", "s", null, (async () => { throw new Error("x"); }) as any), "unavailable");
  check("Cloudflare 500", await checkTurnstile("tok", "s", null, answer({}, 500)), "unavailable");
  const OK = { success: true, action: "school-apply", hostname: "app.averages.io" };
  check("replayed token (timeout-or-duplicate)", await checkTurnstile("tok", "s", null, answer({ success: false, "error-codes": ["timeout-or-duplicate"] })), "failed");
  check("wrong secret is ours to fix", await checkTurnstile("tok", "s", null, answer({ success: false, "error-codes": ["invalid-input-secret"] })), "unavailable");
  check("no action or host refused", [await checkTurnstile("tok", "s", null, answer({ success: true, hostname: "app.averages.io" })), await checkTurnstile("tok", "s", null, answer({ success: true, action: "school-apply" }))], ["failed", "failed"]);
  check("localhost only when the API is local", [await checkTurnstile("tok", "s", null, answer({ ...OK, hostname: "localhost" })), await checkTurnstile("tok", "s", null, answer({ ...OK, hostname: "localhost" }), true)], ["failed", "ok"]);
  check("averages.io itself isn't the form", await checkTurnstile("tok", "s", null, answer({ ...OK, hostname: "averages.io" })), "failed");
  let sentSecret = "";
  await checkTurnstile("tok", " sek\n", null, (async (_u: any, init: any) => { sentSecret = (init.body as FormData).get("secret") as string; return new Response(JSON.stringify(OK)); }) as any);
  check("secret trimmed", sentSecret, "sek");

  const real = globalThis.fetch;
  let verdict: any = { success: true, action: "school-apply", hostname: "app.averages.io" };
  const seen: string[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://challenges.cloudflare.com/")) { seen.push((init.body as FormData).get("response") as string); return new Response(JSON.stringify(verdict)); }
    return real(input, init);
  }) as typeof fetch;
  const TENV = { ...ENV, SCHOOLS: fakeSchools(), TURNSTILE_SITE_KEY: "0x4AAA", TURNSTILE_SECRET: "sek" };
  const good = { school: "Lincoln USD", canvas: "lincolnusd.instructure.com", email: "it@lincolnusd.org" };
  const send = (body: unknown, ip: string) => worker.fetch(new Request("https://api.averages.io/schools/apply", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.averages.io", "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), TENV, CTX);
  resetRateLimits();
  let r = await send(good, "198.51.100.1");
  check("on: no token refused", [r.status, (await r.json() as any).error], [400, "captcha_failed"]);
  r = await send({ ...good, turnstileToken: "T1" }, "198.51.100.2");
  check("on: good token saved", [r.status, (await r.json() as any).ok, seen.at(-1)], [200, true, "T1"]);
  verdict = { success: false };
  r = await send({ ...good, turnstileToken: "T2" }, "198.51.100.3");
  check("on: bad token refused", r.status, 400);
  verdict = { success: false, "error-codes": ["timeout-or-duplicate"] };
  r = await send({ ...good, turnstileToken: "T1" }, "198.51.100.5");
  check("on: replaying a used token refused", [r.status, (await r.json() as any).error], [400, "captcha_failed"]);
  r = await send({ ...good, website: "http://spam", turnstileToken: "" }, "198.51.100.4");
  check("bot trap still answers ok first", r.status, 200);
  globalThis.fetch = real;
  const cfg = async (env: any) => (await (await worker.fetch(new Request("https://api.averages.io/config/apply"), env, CTX)).json() as any).turnstileSiteKey;
  check("config: key when on, null when off or half set", [await cfg(TENV), await cfg(ENV), await cfg({ ...ENV, TURNSTILE_SITE_KEY: "0x4AAA" })], ["0x4AAA", null, null]);
  resetRateLimits();
}

/* ── Email to schools@ ──────────────────────────────────────────────── */
console.log("\nemail handler");
const enc = (t: string) => new TextEncoder().encode(t);
const RAW_REPLY = [
  'From: "Jane Doe" <jane@nmusd.us>',
  "To: schools@averages.io",
  "Subject: Re: Averages.io for our students",
  "Message-ID: <m2@mail.nmusd.us>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  'Content-Type: text/plain; charset="utf-8"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hi! We applied =E2=80=94 our Canvas is nmusd.instructure.com.=",
  "",
  "Thanks, Jane",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Hi! We applied</p>",
  "--b1--",
  "",
].join("\r\n");
function incoming(from: string, headers: Record<string, string> = {}, to = SCHOOLS_ADDRESS, raw = "") {
  const log = { forwards: [] as string[], replies: [] as any[] };
  const bytes = enc(raw);
  const msg: any = {
    from, to, headers: new Headers({ Subject: "Averages.io for our students", "Message-ID": "<m1@mail.nmusd.us>", ...headers }),
    raw: raw ? new Response(bytes).body : null, rawSize: bytes.length,
    setReject() {}, async forward(addr: string) { log.forwards.push(addr); }, async reply(m: any) { log.replies.push(m); },
  };
  return { msg, log };
}
{
  const env = { ...ENV, SCHOOLS: fakeSchools(), SCHOOLS_NOTIFY_TO: " Martin@Example.org " };
  sent.length = 0;
  const a = incoming("Jane IT <jane@nmusd.us>");
  await handleSchoolsEmail(a.msg, env);
  check("a copy to Martin from schools@ (not a forward), address cleaned", [sent.length, sent[0]?.from, sent[0]?.to, a.log.forwards.length], [1, SCHOOLS_ADDRESS, "Martin@example.org", 0]);
  check("copy: Reply-To the sender", headerOf(sent[0]?.raw ?? "", "Reply-To"), "jane@nmusd.us");
  check("copy: subject says who (encoded, it has a middle dot)", (headerOf(sent[0]?.raw ?? "", "Subject") ?? "").startsWith("=?UTF-8?B?"), true);
  check("one automatic reply, to the sender, from schools@", [a.log.replies.length, a.log.replies[0]?.from, a.log.replies[0]?.to], [1, SCHOOLS_ADDRESS, "jane@nmusd.us"]);
  const r = a.log.replies[0]?.raw ?? "";
  check("threaded, marked automatic, Re: subject", [headerOf(r, "In-Reply-To"), headerOf(r, "Auto-Submitted"), headerOf(r, "Subject")], ["<m1@mail.nmusd.us>", "auto-replied", "Re: Averages.io for our students"]);
  check("the reply has the apply link", part(r, "text/html").includes(APPLY_URL), true);

  // Her reply, with a real body: its text is in Martin's copy and the original is attached.
  sent.length = 0;
  const b = incoming('"Jane Doe" <jane@nmusd.us>', { From: '"Jane Doe" <jane@nmusd.us>', Subject: "Re: Averages.io for our students", "Message-ID": "<m2@mail.nmusd.us>" }, SCHOOLS_ADDRESS, RAW_REPLY);
  await handleSchoolsEmail(b.msg, env);
  const copy = sent[0]?.raw ?? "";
  check("her second email: copied, no second reply", [sent.length, b.log.replies.length, b.log.forwards.length], [1, 0, 0]);
  check("copy shows her words (quoted-printable, utf-8)", part(copy, "text/plain").includes("Hi! We applied \u2014 our Canvas is nmusd.instructure.com.\r\nThanks, Jane".replace("\r\n", "\n")) || part(copy, "text/plain").includes("Hi! We applied \u2014 our Canvas is nmusd.instructure.com."), true);
  check("copy names her", part(copy, "text/plain").includes("From: Jane Doe (jane@nmusd.us)"), true);
  check("copy is multipart/mixed with the original attached", [/^Content-Type: multipart\/mixed;/m.test(copy.split("\r\n\r\n")[0]), copy.includes('filename="original-email.eml"')], [true, true]);
  const att = copy.slice(copy.indexOf('filename="original-email.eml"'));
  const b64 = att.slice(att.indexOf("\r\n\r\n") + 4, att.indexOf("\r\n--"));
  check("the attachment is the original, byte for byte", new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\r\n/g, "")), (c) => c.charCodeAt(0))), RAW_REPLY);

  const c = incoming("noreply@nmusd.us");
  sent.length = 0;
  await handleSchoolsEmail(c.msg, env);
  check("a robot: copied, never answered", [sent.length, c.log.replies.length], [1, 0]);
  const d = incoming("bob@other.org", {}, "help@averages.io");
  sent.length = 0;
  await handleSchoolsEmail(d.msg, env);
  check("another address routed here: copied only", [sent.length, d.log.replies.length], [1, 0]);

  // No send binding: a plain forward, as before.
  const g = incoming("gina@school.org");
  await handleSchoolsEmail(g.msg, { ...env, SCHOOLS_MAIL: undefined });
  check("no SCHOOLS_MAIL: forwarded instead", g.log.forwards, ["Martin@example.org"]);
  // The copy fails: falls back to forwarding.
  const h = incoming("hal@school.org");
  await handleSchoolsEmail(h.msg, { ...env, SCHOOLS_MAIL: { send: async () => { throw new Error("not verified"); } } });
  check("copy failed: forwarded instead", h.log.forwards, ["Martin@example.org"]);
  // A huge email: the text only, no attachment.
  sent.length = 0;
  const big = incoming("ivy@school.org", {}, SCHOOLS_ADDRESS, RAW_REPLY);
  big.msg.rawSize = 11 * 1024 * 1024;
  await handleSchoolsEmail(big.msg, env);
  check("too big to attach: sent without it, and says so", [sent.length, (sent[0]?.raw ?? "").includes("original-email.eml"), part(sent[0]?.raw ?? "", "text/plain").includes("too big to attach")], [1, false, true]);

  const e = incoming("amy@school.org");
  e.msg.forward = async () => { throw new Error("unverified destination"); };
  e.msg.reply = async () => { throw new Error("DMARC failed"); };
  let crashed = false;
  try { await handleSchoolsEmail(e.msg, { ...env, SCHOOLS_MAIL: { send: async () => { throw new Error("x"); } } }); } catch { crashed = true; }
  check("failures are logged, never thrown", crashed, false);
  const f = incoming("zed@school.org");
  sent.length = 0;
  await handleSchoolsEmail(f.msg, { ...env, SCHOOLS_NOTIFY_TO: undefined });
  check("no inbox set: still answers, sends no copy", [f.log.forwards.length, sent.length, f.log.replies.length], [0, 0, 1]);
}

console.log("\nreading emails");
{
  const { readEmailText, htmlToText, MAX_TEXT } = await import("../src/mailRead.ts");
  check("plain text preferred", readEmailText(enc(RAW_REPLY)).startsWith("Hi! We applied \u2014"), true);
  const htmlOnly = ["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", btoa("<div>Hello<br>there &amp; <b>you</b></div><script>x()</script>")].join("\r\n");
  check("HTML only, base64: readable text", readEmailText(enc(htmlOnly)), "Hello\nthere & you");
  const nested = ['Content-Type: multipart/mixed; boundary="o"', "", "--o", 'Content-Type: multipart/alternative; boundary="i"', "", "--i", "Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable", "", "Caf=E9 menu", "--i--", "--o", "Content-Type: application/pdf", "Content-Disposition: attachment; filename=a.pdf", "", "JVBERi0=", "--o--", ""].join("\r\n");
  check("nested parts, latin-1, attachment skipped", readEmailText(enc(nested)), "Caf\u00e9 menu");
  check("no text at all", readEmailText(enc("Content-Type: image/png\r\n\r\nxx")), "");
  check("long text cut, says so", readEmailText(enc("Content-Type: text/plain\r\n\r\n" + "a".repeat(MAX_TEXT + 50))).endsWith("[cut short: the full email is attached]"), true);
  const t0 = Date.now();
  htmlToText("<script>".repeat(20000) + "x");
  readEmailText(enc("Content-Type: text/html\r\n\r\n" + "<a ".repeat(100000)));
  check("hostile HTML stays fast", Date.now() - t0 < 2000, true);
}
check("the Worker exports an email handler", typeof (worker as any).email, "function");

/* ── Email endings and "Verify your email" (2026-10-07) ───────────────── */
console.log("\nemail endings and codes");
{
  check("endings parsed: dots, spaces, junk, repeats", emailEndings(" .edu, org ,US,net,,k12!,edu"), ["edu", "org", "us", "net"]);
  check("endings: unset is any", emailEndings(undefined), []);
  const E = ["edu", "org", "us", "net"];
  check("allowed endings", ["it@lincoln.k12.ca.us", "a@b.edu", "a@district.org", "a@x.net", "a@gmail.com", "a@school.co.uk"].map((e) => emailEndingAllowed(e, E)), [true, true, true, true, false, false]);
  check("no list allows anything", emailEndingAllowed("a@gmail.com", []), true);
  const v = validateApplication({ school: "Lincoln", canvas: "lincoln.instructure.com", email: "it@gmail.com" }, E);
  check("application with a .com email: field error 'ending'", v.ok ? null : (v as any).fields, { email: "ending" });

  // The store's code rules, on a Map.
  const book = new SchoolsBook(memStorage());
  const t = 1_000_000_000_000;
  const first = await book.issueCode("it@x.org", t, "123456");
  check("code issued", first, { code: "123456" });
  check("again right away: wait the gap", await book.issueCode("it@x.org", t + 1000, "222222"), { wait: Math.ceil((CODE_GAP_MS - 1000) / 1000) });
  await book.issueCode("it@x.org", t + CODE_GAP_MS, "333333");
  await book.issueCode("it@x.org", t + 2 * CODE_GAP_MS, "444444");
  const fourth = await book.issueCode("it@x.org", t + 3 * CODE_GAP_MS, "555555");
  check("4th in 10 minutes: wait for the window", "wait" in fourth && fourth.wait === Math.ceil((CODE_SEND_WINDOW_MS - 3 * CODE_GAP_MS) / 1000), true);
  check("old code replaced by the newest", (await book.checkCode("it@x.org", "123456", t + 2 * CODE_GAP_MS + 1)).result, "wrong");
  check("newest code works once", [(await book.checkCode("it@x.org", "444444", t + 2 * CODE_GAP_MS + 2)).result, (await book.checkCode("it@x.org", "444444", t + 2 * CODE_GAP_MS + 3)).result], ["ok", "expired"]);
  await book.issueCode("b@x.org", t, "111111");
  const tries = [];
  for (let i = 0; i < 5; i++) tries.push(await book.checkCode("b@x.org", "000000", t + 10));
  check("5 wrong tries, then locked", tries.map((r: any) => r.result + (r.left ?? "")), ["wrong4", "wrong3", "wrong2", "wrong1", "too_many"]);
  check("right code after lock: still locked", (await book.checkCode("b@x.org", "111111", t + 20)).result, "too_many");
  await book.issueCode("c@x.org", t, "777777");
  check("expired after 10 minutes", (await book.checkCode("c@x.org", "777777", t + CODE_TTL_MS + 1)).result, "expired");
  check("no code for that address", (await book.checkCode("nobody@x.org", "123456", t)).result, "expired");
  const codes = new Set(Array.from({ length: 200 }, () => newCode()));
  check("codes are 6 digits and vary", [[...codes].every((c) => /^\d{6}$/.test(c)), codes.size > 190], [true, true]);
  const m = verifyCodeEmail("042917");
  check("code email: code in subject and both parts", [m.subject, m.text.includes("042917"), m.html.includes("042917")], ["Your Averages.io code: 042917", true, true]);
  check("code email: never anything but digits", verifyCodeEmail("<b>1</b>").html.includes("<b>1</b>"), false);

  // The routes.
  const mails: { to: string; raw: string }[] = [];
  const VENV: any = { ...ENV, SCHOOLS: fakeSchools(), SCHOOLS_EMAIL_ENDINGS: "edu,org,us,net", SCHOOLS_VERIFY_EMAIL: "1", SCHOOLS_MAIL: { send: async (m: any) => { mails.push({ to: m.to, raw: m.raw }); } } };
  const call = (path: string, body: unknown, ip = "198.51.100.70", env: any = VENV) =>
    worker.fetch(new Request("https://api.averages.io" + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.averages.io", "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), env, CTX);
  const cfg = async (env: any) => (await (await worker.fetch(new Request("https://api.averages.io/config/apply"), env, CTX)).json()) as any;
  resetRateLimits();
  check("config: endings and verify on", [(await cfg(VENV)).emailEndings, (await cfg(VENV)).verifyEmail], [["edu", "org", "us", "net"], true]);
  check("config: verify off without the switch or mail", [(await cfg({ ...VENV, SCHOOLS_VERIFY_EMAIL: "0" })).verifyEmail, (await cfg({ ...VENV, SCHOOLS_MAIL: undefined })).verifyEmail], [false, false]);
  check("code: off = 404", (await call("/schools/apply/code", { email: "it@x.org" }, "198.51.100.71", { ...VENV, SCHOOLS_VERIFY_EMAIL: "0" })).status, 404);
  let r = await call("/schools/apply/code", { email: "it@gmail.com" });
  check("code: .com refused before anything is sent", [r.status, (await r.json() as any).fields, mails.length], [400, { email: "ending" }, 0]);
  r = await call("/schools/apply/code", { email: "IT@Lincoln.ORG" });
  const sentCode = /code: (\d{6})/.exec(headerOf(mails[0]?.raw ?? "", "Subject") ?? "")?.[1] ?? "";
  check("code: sent to the address typed", [r.status, mails.length, mails[0]?.to, sentCode.length], [200, 1, "IT@Lincoln.ORG", 6]);
  r = await call("/schools/apply/code", { email: "it@lincoln.org" }, "198.51.100.72");
  check("code: again too soon (any case) = 429 with seconds", [r.status, (await r.json() as any).error, Number(r.headers.get("Retry-After")) > 0], [429, "code_wait", true]);
  r = await call("/schools/apply/verify", { email: "it@lincoln.org", code: sentCode === "000000" ? "000001" : "000000" });
  check("verify: wrong code, tries left", [r.status, await r.json()], [400, { error: "code_wrong", triesLeft: 4 }]);
  const lincoln = { school: "Lincoln USD", canvas: "lincoln.instructure.com", email: "IT@Lincoln.ORG" };
  r = await call("/schools/apply", lincoln, "198.51.100.73");
  check("apply without verifying: refused", [r.status, (await r.json() as any).error], [400, "email_unverified"]);
  r = await call("/schools/apply/verify", { email: "it@lincoln.org", code: sentCode.slice(0, 3) + " " + sentCode.slice(3) });
  const ver = await r.json() as any;
  check("verify: right code (spaces ok) gives a proof", [r.status, ver.ok, typeof ver.emailProof], [200, true, "string"]);
  r = await call("/schools/apply", { ...lincoln, email: "other@lincoln.org", emailProof: ver.emailProof }, "198.51.100.74");
  check("proof for another address: refused", (await r.json() as any).error, "email_unverified");
  r = await call("/schools/apply", { ...lincoln, emailProof: "x.y" }, "198.51.100.75");
  check("forged proof: refused", (await r.json() as any).error, "email_unverified");
  r = await call("/schools/apply", { ...lincoln, emailProof: ver.emailProof }, "198.51.100.76");
  check("apply with the proof: saved", [r.status, await r.json()], [200, { ok: true }]);
  r = await call("/schools/apply/code", { email: "it@x.org" }, "198.51.100.77", { ...VENV, SCHOOLS_MAIL: { send: async () => { throw new Error("not a verified destination"); } } });
  check("code: Cloudflare won't send = 502 code_send_failed", [r.status, (await r.json() as any).error], [502, "code_send_failed"]);
  r = await call("/schools/apply", { ...lincoln }, "198.51.100.78", { ...VENV, SCHOOLS_VERIFY_EMAIL: "0" });
  check("verify off: apply works without a proof", r.status, 200);
  const TS: any = { ...VENV, TURNSTILE_SITE_KEY: "0x4AAA", TURNSTILE_SECRET: "sek" };
  r = await call("/schools/apply/code", { email: "it@y.org" }, "198.51.100.79", TS);
  check("code with Turnstile on: needs a token", [r.status, (await r.json() as any).error], [400, "captcha_failed"]);
  resetRateLimits();
  const ips = [];
  for (let i = 0; i < 6; i++) ips.push((await call("/schools/apply/code", { email: `a${i}@z.org` }, "198.51.100.90")).status);
  check("code: 5 per IP per 10 minutes", ips, [200, 200, 200, 200, 200, 429]);
  resetRateLimits();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
