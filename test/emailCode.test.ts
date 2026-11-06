// "Verify your email" codes: POST /email/code sends a 6-digit code through the EMAIL binding (faked here), POST /email/verify checks it.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/emailCode.test.ts
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { cleanEmail, codeHash, codeMessage, newCode, sameHash, sendFailure } from "../src/emailCode.ts";
import { sealSession, SESSION_COOKIE } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

globalThis.fetch = (async (input: RequestInfo | URL) => { throw new Error(`unexpected call: ${String(input)}`); }) as typeof fetch;

const SECRET = "email-code-test-session-secret";
const sent: any[] = [];
let failWith: string | null = null;
const EMAIL = { async send(m: any) { if (failWith) { const e: any = new Error("no"); e.code = failWith; throw e; } sent.push(m); return { messageId: "m" + sent.length }; } };
const ENV: any = { SESSION_SECRET: SECRET, EMAIL };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";

async function call(path: string, json: unknown, cookie: string, env: any = ENV) {
  resetRateLimits();
  const headers = new Headers({ "Content-Type": "application/json", Cookie: cookie, Origin: "https://app.averages.io" });
  const res = await worker.fetch(new Request(API + path, { method: "POST", headers, body: JSON.stringify(json) }), env, CTX);
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const cookieFor = async (uid: string, extra: Record<string, unknown> = {}) => `${SESSION_COOKIE}=${await sealSession({ key: "k", secret: "s", uid, ...extra } as any, SECRET)}`;
const codeIn = (m: any) => (String(m.text).match(/\b(\d{6})\b/) || [])[1];

console.log("\nhelpers");
check("an address is cleaned and lowercased", cleanEmail("  Martin@Example.COM "), "martin@example.com");
check("not addresses", ["", "a@b", "a b@c.com", "x@y.com\nBcc: z@w.com", "a@b..com", ".a@b.com", "a,b@c.com", 7].map(cleanEmail), [null, null, null, null, null, null, null, null]);
check("codes are 6 digits", Array.from({ length: 50 }, newCode).every((c) => /^\d{6}$/.test(c)), true);
const h1 = await codeHash(SECRET, "1", "a@b.com", "123456");
check("the hash depends on the code, the student and the address", [h1 === (await codeHash(SECRET, "1", "a@b.com", "123456")), h1 === (await codeHash(SECRET, "1", "a@b.com", "123457")), h1 === (await codeHash(SECRET, "2", "a@b.com", "123456")), h1 === (await codeHash(SECRET, "1", "c@b.com", "123456"))], [true, false, false, false]);
check("sameHash", [sameHash("ab", "ab"), sameHash("ab", "ac"), sameHash("ab", "abc")], [true, false, false]);
check("the email has the code and no link", [codeMessage("042517").subject, /042517/.test(codeMessage("042517").html), /href=/.test(codeMessage("042517").html)], ["042517 is your Averages.io code", true, false]);
check("Email Service errors", ["E_RECIPIENT_SUPPRESSED", "E_DAILY_LIMIT_EXCEEDED", "E_DELIVERY_FAILED"].map((c) => sendFailure({ code: c })), [{ status: 400, error: "email_rejected" }, { status: 429, error: "email_busy" }, { status: 502, error: "email_failed" }]);

console.log("\nroutes");
const me = await cookieFor("4242");
{
  const r = await call("/email/code", { email: "Student@Example.com" }, me);
  check("sends a code", [r.status, r.data.ok, typeof r.data.token, sent.length, sent[0].to, sent[0].from], [200, true, "string", 1, "student@example.com", { email: "no-reply@averages.io", name: "Averages.io" }]);
  check("the token doesn't hold the code", r.data.token.includes(codeIn(sent[0])), false);
  const code = codeIn(sent[0]), wrong = code === "000000" ? "000001" : "000000";
  check("the right code", (await call("/email/verify", { email: "student@example.com", code, token: r.data.token }, me)).data, { ok: true, email: "student@example.com" });
  check("a wrong code", (await call("/email/verify", { email: "student@example.com", code: wrong, token: r.data.token }, me)).data, { error: "wrong_code" });
  check("another address", (await call("/email/verify", { email: "other@example.com", code, token: r.data.token }, me)).data, { error: "code_expired" });
  check("another student", (await call("/email/verify", { email: "student@example.com", code, token: r.data.token }, await cookieFor("999"))).data, { error: "code_expired" });
  check("a made-up token", (await call("/email/verify", { email: "student@example.com", code, token: "x.y" }, me)).data, { error: "code_expired" });
  check("not six digits", (await call("/email/verify", { email: "student@example.com", code: "12345", token: r.data.token }, me)).status, 400);
}
check("a bad address isn't sent", [(await call("/email/code", { email: "nope" }, me)).data, sent.length], [{ error: "bad_email" }, 1]);
check("signed out", (await call("/email/code", { email: "a@example.com" }, "")).status, 401);
check("not for an under-13 sign-in", (await call("/email/code", { email: "a@example.com" }, await cookieFor("77", { inc: true }))).data, { error: "not_in_incognito" });
check("no binding: says so", (await call("/email/code", { email: "a@example.com" }, me, { SESSION_SECRET: SECRET })).data, { error: "email_not_configured" });
failWith = "E_RECIPIENT_SUPPRESSED";
check("Email Service turns it down", await call("/email/code", { email: "a@example.com" }, me), { status: 400, data: { error: "email_rejected" } });
failWith = null;
{
  resetRateLimits();
  const headers = new Headers({ "Content-Type": "application/json", Cookie: me, Origin: "https://app.averages.io" });
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await worker.fetch(new Request(API + "/email/code", { method: "POST", headers, body: JSON.stringify({ email: "a@example.com" }) }), ENV, CTX)).status);
  check("five codes per 10 minutes, then wait", statuses, [200, 200, 200, 200, 200, 429]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
