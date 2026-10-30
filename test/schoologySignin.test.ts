/**
 * Sign in with Schoology (2026-10-29, src/schoologySignin.ts): three-legged
 * OAuth, start to callback, against a fake Schoology. Also the helpers, the
 * open-redirect guard, the sealed in-between cookie, and the sandbox test mode.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/schoologySignin.test.ts
 */
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { REVIEW_UID, SANDBOX_KEY, SANDBOX_SECRET } from "../src/reviewSandbox.ts";
import { openSession, readCookie, SESSION_COOKIE } from "../src/session.ts";
import { OAUTH_COOKIE, authorizeUrl, consumerFrom, parseTokenAnswer, sameToken, schoolDomain } from "../src/schoologySignin.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

/* ── Fake Schoology: token calls are form-encoded; /users/me is JSON ──── */
const calls: { path: string; auth: string }[] = [];
let refuse = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (url.hostname !== "api.schoology.com") throw new Error(`unexpected call: ${url}`);
  const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
  calls.push({ path: url.pathname, auth });
  if (refuse) return new Response("Invalid consumer", { status: 401 });
  if (url.pathname === "/v1/oauth/request_token") return new Response("oauth_token=REQTOKEN1&oauth_token_secret=REQSECRET1", { status: 200 });
  if (url.pathname === "/v1/oauth/access_token") return new Response("oauth_token=ACCTOKEN9&oauth_token_secret=ACCSECRET9", { status: 200 });
  if (url.pathname === "/v1/users/me") return new Response(JSON.stringify({ uid: 5150, name_display: "Martin Volkov", name_first: "Martin", primary_email: "", picture_url: "" }), { status: 200, headers: { "Content-Type": "application/json" } });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const SECRET = "schoology-signin-test-session-secret";
const CONSUMER = { SCHOOLOGY_CONSUMER_KEY: "consumer-key-abc", SCHOOLOGY_CONSUMER_SECRET: "consumer-secret-xyz" };
let ENV: any = { SESSION_SECRET: SECRET, ...CONSUMER };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";

async function call(path: string, cookie?: string) {
  resetRateLimits();
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  return worker.fetch(new Request(API + path, { headers, redirect: "manual" }), ENV, CTX);
}
const setCookies = (res: Response): string[] => (res.headers as any).getSetCookie?.() ?? [];
function cookieValue(res: Response, name: string): string | null {
  for (const c of setCookies(res)) { const v = readCookie(c.split(";")[0], name); if (v !== null && v !== "") return v; }
  return null;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */
console.log("helpers");
check("domain: a district's schoology.com address, cleaned", schoolDomain("https://NMUSD.schoology.com/home"), "nmusd.schoology.com");
check("domain: plain schoology.com goes to app.schoology.com", schoolDomain("schoology.com"), "app.schoology.com");
check("domain: any other site is refused (no open redirect)", [schoolDomain("evil.example"), schoolDomain("schoology.com.evil.example"), schoolDomain("evilschoology.com")], [null, null, null]);
check("domain: a listed district address is allowed", schoolDomain("lms.district.org", [{ domain: "lms.district.org" }]), "lms.district.org");
check("domain: junk is refused", [schoolDomain(""), schoolDomain("a b.com"), schoolDomain("127.0.0.1"), schoolDomain(null)], [null, null, null, null]);
check("token answer parsed", parseTokenAnswer("oauth_token=a1&oauth_token_secret=b2&xoauth=1"), { token: "a1", secret: "b2" });
check("token answer missing a part", [parseTokenAnswer("oauth_token=a1"), parseTokenAnswer("<html>"), parseTokenAnswer("")], [null, null, null]);
check("authorize goes to the school's own Schoology", authorizeUrl("nmusd.schoology.com", "T 1", "https://api.averages.io/auth/schoology/callback"),
  "https://nmusd.schoology.com/oauth/authorize?oauth_token=T+1&oauth_callback=https%3A%2F%2Fapi.averages.io%2Fauth%2Fschoology%2Fcallback");
check("sameToken", [sameToken("abc", "abc"), sameToken("abc", "abd"), sameToken("", ""), sameToken("abc", "abcd")], [true, false, false, false]);
check("consumer needs both secrets", [consumerFrom({}), consumerFrom({ SCHOOLOGY_CONSUMER_KEY: "k" }), consumerFrom({ SCHOOLOGY_CONSUMER_KEY: " k ", SCHOOLOGY_CONSUMER_SECRET: "s" })], [null, null, { key: "k", secret: "s" }]);

/* ── Status ────────────────────────────────────────────────────────────── */
console.log("\nstatus");
{
  let r = await call("/auth/schoology/status"); check("on with both secrets", await r.json(), { on: true });
  ENV = { SESSION_SECRET: SECRET }; r = await call("/auth/schoology/status"); check("off without them", await r.json(), { on: false });
  ENV = { SESSION_SECRET: SECRET, ...CONSUMER, FEATURES_OFF: "schoology-oauth" }; r = await call("/auth/schoology/status"); check("off with its switch off", await r.json(), { on: false });
  ENV = { SESSION_SECRET: SECRET, ...CONSUMER };
}

/* ── Start ─────────────────────────────────────────────────────────────── */
console.log("\nstart");
let pending = "";
{
  calls.length = 0;
  const r = await call("/auth/schoology/start?domain=nmusd.schoology.com&under13=0");
  const to = new URL(r.headers.get("Location") ?? "about:blank");
  check("302 to the school's Schoology authorize page", [r.status, to.origin + to.pathname], [302, "https://nmusd.schoology.com/oauth/authorize"]);
  check("with the request token and our callback", [to.searchParams.get("oauth_token"), to.searchParams.get("oauth_callback")], ["REQTOKEN1", "https://api.averages.io/auth/schoology/callback"]);
  check("asked Schoology for a request token, signed with no token yet", [calls.map((c) => c.path), /oauth_token=""/.test(calls[0]?.auth ?? ""), /oauth_consumer_key="consumer-key-abc"/.test(calls[0]?.auth ?? "")], [["/v1/oauth/request_token"], true, true]);
  pending = cookieValue(r, OAUTH_COOKIE) ?? "";
  const raw = setCookies(r).find((c) => c.startsWith(OAUTH_COOKIE)) ?? "";
  check("the in-between cookie is sealed (no token in it), HttpOnly, Lax, only for /auth/schoology", [pending.length > 20, !pending.includes("REQ"), /HttpOnly/.test(raw), /SameSite=Lax/.test(raw), /Path=\/auth\/schoology/.test(raw), /Secure/.test(raw)], [true, true, true, true, true, true]);
  check("no session yet", cookieValue(r, SESSION_COOKIE), null);
}
{
  const r = await call("/auth/schoology/start?domain=evil.example");
  check("an unknown site goes back to sign-in, never there", r.headers.get("Location"), "https://app.averages.io/?signin_error=unknown_school#schoology");
  ENV = { SESSION_SECRET: SECRET };
  const r2 = await call("/auth/schoology/start?domain=nmusd.schoology.com");
  check("no consumer secrets: back with not_configured", r2.headers.get("Location"), "https://app.averages.io/?signin_error=not_configured#schoology");
  ENV = { SESSION_SECRET: SECRET, ...CONSUMER };
  refuse = true; calls.length = 0;
  const r3 = await call("/auth/schoology/start?domain=nmusd.schoology.com");
  check("Schoology refusing our key: back with schoology_refused", r3.headers.get("Location"), "https://app.averages.io/?signin_error=schoology_refused#schoology");
  refuse = false;
}

/* ── Callback ──────────────────────────────────────────────────────────── */
console.log("\ncallback");
{
  let r = await call("/auth/schoology/callback?oauth_token=REQTOKEN1");
  check("without this browser's cookie: expired", r.headers.get("Location"), "https://app.averages.io/?signin_error=expired#schoology");
  r = await call("/auth/schoology/callback?oauth_token=SOMEONEELSE", `${OAUTH_COOKIE}=${pending}`);
  check("someone else's token: refused", r.headers.get("Location"), "https://app.averages.io/?signin_error=expired#schoology");
  r = await call("/auth/schoology/callback", `${OAUTH_COOKIE}=${pending}`);
  check("no token back (they said no): denied", r.headers.get("Location"), "https://app.averages.io/?signin_error=denied#schoology");
  r = await call(`/auth/schoology/callback?oauth_token=REQTOKEN1`, `${OAUTH_COOKIE}=${pending.slice(0, -4)}AAAA`);
  check("a tampered cookie: expired", r.headers.get("Location"), "https://app.averages.io/?signin_error=expired#schoology");

  calls.length = 0;
  r = await call("/auth/schoology/callback?oauth_token=REQTOKEN1", `${OAUTH_COOKIE}=${pending}`);
  check("signed in: back to the app", [r.status, r.headers.get("Location")], [302, "https://app.averages.io/?signin=schoology"]);
  check("swapped the request token, then asked who it is", calls.map((c) => c.path), ["/v1/oauth/access_token", "/v1/users/me"]);
  check("the swap is signed with the request token", /oauth_token="REQTOKEN1"/.test(calls[0]?.auth ?? ""), true);
  check("/users/me is signed with the access token", /oauth_token="ACCTOKEN9"/.test(calls[1]?.auth ?? ""), true);
  const s = await openSession(cookieValue(r, SESSION_COOKIE) ?? "", SECRET);
  check("the session carries the access token and the student", [s?.uid, s?.token, s?.tokenSecret, s?.key, s?.inc ?? null, s?.p?.n], ["5150", "ACCTOKEN9", "ACCSECRET9", "consumer-key-abc", null, "Martin Volkov"]);
  check("the in-between cookie is cleared", setCookies(r).some((c) => c.startsWith(`${OAUTH_COOKIE}=;`) && /Max-Age=0/.test(c)), true);

  // under 13: Incognito only, sealed in
  const st = await call("/auth/schoology/start?domain=nmusd.schoology.com&under13=1");
  const p13 = cookieValue(st, OAUTH_COOKIE) ?? "";
  const r13 = await call("/auth/schoology/callback?oauth_token=REQTOKEN1", `${OAUTH_COOKIE}=${p13}`);
  const s13 = await openSession(cookieValue(r13, SESSION_COOKIE) ?? "", SECRET);
  check("under 13: the session is Incognito", s13?.inc, true);

  // the signed-in session works like any other
  const me = await worker.fetch(new Request(API + "/auth/me", { headers: { Cookie: `${SESSION_COOKIE}=${cookieValue(r, SESSION_COOKIE)}`, Origin: "https://app.averages.io" } }), ENV, CTX);
  check("/auth/me answers for it", [(me as Response).status, ((await (me as Response).json()) as any).uid], [200, "5150"]);
}

/* ── Sandbox test mode (no real keys) ──────────────────────────────────── */
console.log("\nsandbox test mode");
{
  ENV = { SESSION_SECRET: SECRET, SCHOOLOGY_CONSUMER_KEY: SANDBOX_KEY, SCHOOLOGY_CONSUMER_SECRET: SANDBOX_SECRET };
  calls.length = 0;
  const st = await call("/auth/schoology/start?domain=app.schoology.com");
  const to = new URL(st.headers.get("Location") ?? "about:blank");
  check("approves on our own sandbox page, with no call to Schoology", [to.pathname, calls.length], ["/auth/schoology/sandbox-authorize", 0]);
  const ok = await call(to.pathname + to.search);
  const back = new URL(ok.headers.get("Location") ?? "about:blank");
  const done = await call(back.pathname + back.search, `${OAUTH_COOKIE}=${cookieValue(st, OAUTH_COOKIE)}`);
  const s = await openSession(cookieValue(done, SESSION_COOKIE) ?? "", SECRET);
  check("signs in as the reviewer account", [done.headers.get("Location"), s?.uid, s?.key, calls.length], ["https://app.averages.io/?signin=schoology", REVIEW_UID, SANDBOX_KEY, 0]);
  ENV = { ...ENV, FEATURES_OFF: "test-signin" };
  const off = await call("/auth/schoology/sandbox-authorize?oauth_token=x");
  const st2 = await call("/auth/schoology/start?domain=app.schoology.com");
  check("off with the test-signin switch", [off.status, st2.headers.get("Location")], [404, "https://app.averages.io/?signin_error=feature_off#schoology"]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
