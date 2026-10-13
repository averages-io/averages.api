/**
 * The fast /auth/me (2026-10-13): Schoology sessions answer from the name
 * sealed into the cookie at sign-in, with no call to Schoology. Sessions from
 * before that ask Schoology once and keep the answer in a side cookie, never
 * by rewriting the session cookie (a sign-out racing that call must stay
 * signed out).
 *
 * globalThis.fetch is a fake Schoology that counts every call.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/authme.test.ts
 */
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { REVIEW_UID } from "../src/reviewSandbox.ts";
import {
  openSession,
  openValue,
  PROFILE_COOKIE,
  PROFILE_PURPOSE,
  profileFrom,
  readCookie,
  sealSession,
  sealValue,
  SESSION_COOKIE,
} from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

/* ── Fake Schoology ────────────────────────────────────────────────────── */

const ME = {
  uid: 4242,
  name_display: "Martin Volkov",
  name_first: "Martin",
  primary_email: "martin@school.example",
  picture_url: "https://asset-cdn.schoology.com/system/files/imagecache/profile_reg/pictures/picture-4242.jpg",
};
let schoologyStatus = 200;
let schoologyMe: Record<string, unknown> = ME;
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  calls.push(new URL(url).pathname);
  if (new URL(url).hostname !== "api.schoology.com") throw new Error(`unexpected call: ${url}`);
  if (schoologyStatus !== 200) return new Response("{}", { status: schoologyStatus, headers: { "Content-Type": "application/json" } });
  return new Response(JSON.stringify(schoologyMe), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const SECRET = "authme-test-session-secret";
const REVIEW_KEY = "review-key-0123456789abcdef";
const REVIEW_SECRET = "review-secret-0123456789abcdef";
const ENV: any = { SESSION_SECRET: SECRET, REVIEW_KEY, REVIEW_SECRET };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";
const APP = "https://app.averages.io";

async function call(path: string, init: { method?: string; cookie?: string; json?: unknown; origin?: string } = {}) {
  resetRateLimits();
  const headers = new Headers();
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.origin) headers.set("Origin", init.origin);
  let body: string | undefined;
  if (init.json !== undefined) { headers.set("Content-Type", "application/json"); body = JSON.stringify(init.json); }
  const res = await worker.fetch(new Request(API + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body }), ENV, CTX);
  const data = await res.json().catch(() => null);
  return { res, data };
}
function setCookies(res: Response): string[] {
  return (res.headers as any).getSetCookie?.() ?? [];
}
function cookieValue(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    const v = readCookie(c.split(";")[0], name);
    if (v !== null) return v;
  }
  return null;
}
const ANSWER = { uid: "4242", name: "Martin Volkov", firstName: "Martin", email: "martin@school.example", pictureUrl: ME.picture_url, incognito: false, provider: "schoology" };

/* ── Signing in seals the name ─────────────────────────────────────────── */
console.log("signing in with a Schoology key");
let session = "";
{
  calls.length = 0;
  const { res, data } = await call("/auth/session", { json: { key: "abcdef0123456789abcdef0123456789", secret: "0123456789abcdef0123456789abcdef", under13: false } });
  check("sign-in: 200", [res.status, data.ok], [200, true]);
  check("sign-in asked Schoology once (as before, for the user id)", calls, ["/v1/users/me"]);
  session = cookieValue(res, SESSION_COOKIE) ?? "";
  const opened = await openSession(session, SECRET);
  check("the name is sealed into the session", opened?.p, { n: "Martin Volkov", f: "Martin", em: "martin@school.example", pic: ME.picture_url });
  check("the session cookie stays small (browsers keep ~4096 bytes)", session.length < 1200, true);
}

console.log("\n/auth/me on a new session");
{
  calls.length = 0;
  const { res, data } = await call("/auth/me", { cookie: `${SESSION_COOKIE}=${session}`, origin: APP });
  check("200 with the same answer as before", [res.status, data], [200, ANSWER]);
  check("no call to Schoology", calls, []);
  check("Server-Timing says it came from the cookie", /^auth;desc="cookie";dur=\d+$/.test(res.headers.get("Server-Timing") ?? ""), true);
  check("Timing-Allow-Origin lets the app's DevTools show it", res.headers.get("Timing-Allow-Origin"), APP);
  check("no cookies set", setCookies(res), []);
}
{
  calls.length = 0;
  schoologyStatus = 503;
  const { res, data } = await call("/auth/me", { cookie: `${SESSION_COOKIE}=${session}` });
  check("Schoology down: still signed in, still no call", [res.status, data.name, calls.length], [200, "Martin Volkov", 0]);
  schoologyStatus = 200;
}
{
  const { res } = await call("/auth/me", { cookie: `${SESSION_COOKIE}=${session}`, origin: "https://evil.example" });
  check("no Timing-Allow-Origin for another site", res.headers.get("Timing-Allow-Origin"), null);
}
{
  const under = await call("/auth/session", { json: { key: "abcdef0123456789abcdef0123456789", secret: "0123456789abcdef0123456789abcdef", under13: true } });
  const cookie = `${SESSION_COOKIE}=${cookieValue(under.res, SESSION_COOKIE)}`;
  calls.length = 0;
  const { data } = await call("/auth/me", { cookie });
  check("under 13: Incognito still reported, from the cookie", [data.incognito, data.name, calls.length], [true, "Martin Volkov", 0]);
}

/* ── A session from before 2026-10-13 ──────────────────────────────────── */
console.log("\nan older session (no name inside)");
const oldToken = await sealSession({ key: "abcdef0123456789abcdef0123456789", secret: "0123456789abcdef0123456789abcdef", uid: "4242" }, SECRET);
const oldSession = (await openSession(oldToken, SECRET))!;
let profile = "";
{
  calls.length = 0;
  const { res, data } = await call("/auth/me", { cookie: `${SESSION_COOKIE}=${oldToken}` });
  check("first visit: asks Schoology once, same answer", [res.status, data, calls], [200, ANSWER, ["/v1/users/me"]]);
  check("Server-Timing says Schoology", /^auth;desc="schoology";dur=\d+$/.test(res.headers.get("Server-Timing") ?? ""), true);
  check("the session cookie is NOT rewritten", cookieValue(res, SESSION_COOKIE), null);
  profile = cookieValue(res, PROFILE_COOKIE) ?? "";
  const kept: any = await openValue(profile, SECRET, PROFILE_PURPOSE);
  check("the name goes in the side cookie, tied to this session", [kept?.uid, kept?.exp, kept?.p?.n], ["4242", oldSession.exp, "Martin Volkov"]);
  const raw = setCookies(res).find((c) => c.startsWith(PROFILE_COOKIE + "=")) ?? "";
  const maxAge = Number(/Max-Age=(\d+)/.exec(raw)?.[1]);
  check("side cookie: HttpOnly, Secure, host-only, ends with the session", [/HttpOnly/.test(raw), /Secure/.test(raw), /Domain=/.test(raw), Math.abs(maxAge - (oldSession.exp - Math.floor(Date.now() / 1000))) <= 2], [true, true, false, true]);
}
{
  calls.length = 0;
  const { res, data } = await call("/auth/me", { cookie: `${SESSION_COOKIE}=${oldToken}; ${PROFILE_COOKIE}=${profile}` });
  check("next visit: from the side cookie, no Schoology", [res.status, data.name, calls, /desc="cookie"/.test(res.headers.get("Server-Timing") ?? "")], [200, "Martin Volkov", [], true]);
}
{
  calls.length = 0;
  const { res, data } = await call("/auth/me", { cookie: `${PROFILE_COOKIE}=${profile}` });
  check("the side cookie alone signs no one in", [res.status, data.error, calls], [401, "not_authenticated", []]);
}
{
  const other = await sealSession({ key: "abcdef0123456789abcdef0123456789", secret: "0123456789abcdef0123456789abcdef", uid: "5555" }, SECRET);
  calls.length = 0;
  await call("/auth/me", { cookie: `${SESSION_COOKIE}=${other}; ${PROFILE_COOKIE}=${profile}` });
  check("another student's session ignores this side cookie (asks Schoology)", calls, ["/v1/users/me"]);
  // Sealed for the same student's other sign-in (a different expiry): not used either.
  const stale = await sealValue({ uid: "4242", exp: oldSession.exp - 100, p: profileFrom(ME) }, SECRET, PROFILE_PURPOSE, 3600);
  calls.length = 0;
  await call("/auth/me", { cookie: `${SESSION_COOKIE}=${oldToken}; ${PROFILE_COOKIE}=${stale}` });
  check("a side cookie from a different sign-in is ignored", calls, ["/v1/users/me"]);
  // Sealed under the session's own purpose instead: not a profile cookie.
  calls.length = 0;
  await call("/auth/me", { cookie: `${SESSION_COOKIE}=${oldToken}; ${PROFILE_COOKIE}=${oldToken}` });
  check("a session token in the side cookie's place is ignored", calls, ["/v1/users/me"]);
}
{
  calls.length = 0;
  schoologyStatus = 503;
  const { res, data } = await call("/auth/me", { cookie: `${SESSION_COOKIE}=${oldToken}` });
  check("older session with Schoology down: 502 as before, no cookies", [res.status, data.error, setCookies(res)], [502, "schoology_unreachable", []]);
  schoologyStatus = 200;
}

/* ── Signing out, expiry, odd profiles ─────────────────────────────────── */
console.log("\nsigning out and the edges");
{
  const { res } = await call("/auth/session", { method: "DELETE", cookie: `${SESSION_COOKIE}=${oldToken}; ${PROFILE_COOKIE}=${profile}` });
  const cleared = setCookies(res).filter((c) => /Max-Age=0/.test(c)).map((c) => c.split("=")[0]);
  check("sign-out clears the session, Google and side cookies", cleared.includes(SESSION_COOKIE) && cleared.includes(PROFILE_COOKIE), true);
}
{
  const { res, data } = await call("/auth/me", { cookie: `${SESSION_COOKIE}=garbage.token` });
  check("a bad session cookie: 401 and cleared, as before", [res.status, data.error, setCookies(res).some((c) => c.startsWith(SESSION_COOKIE + "=;"))], [401, "session_expired", true]);
}
{
  const tooLong = await sealSession({ key: "abcdef0123456789abcdef0123456789", secret: "0123456789abcdef0123456789abcdef", uid: "4242", p: { n: "x".repeat(5000), f: "x" } as any }, SECRET);
  const opened = await openSession(tooLong, SECRET);
  check("a profile of the wrong shape is dropped, the session still opens", [opened?.uid, opened?.p], ["4242", undefined]);
}
{
  const p = profileFrom({ name_first: "Sam", picture_url: "javascript:alert(1)", primary_email: "" });
  check("profileFrom: falls back to the first name, keeps only https photos", p, { n: "Sam", f: "Sam" });
  check("profileFrom: nothing at all is still a name", profileFrom({}), { n: "Student", f: "" });
  const long = profileFrom({ name_display: "y".repeat(500), picture_url: "https://x.example/" + "z".repeat(900) });
  check("profileFrom: long values are cut so the cookie stays small", [long.n.length, long.pic], [200, undefined]);
}

/* ── The reviewer account ──────────────────────────────────────────────── */
console.log("\nthe reviewer account");
{
  calls.length = 0;
  const { res } = await call("/auth/session", { json: { key: REVIEW_KEY, secret: REVIEW_SECRET } });
  const token = cookieValue(res, SESSION_COOKIE) ?? "";
  const opened = await openSession(token, SECRET);
  check("reviewer sign-in seals the sandbox name", [opened?.uid, opened?.p?.n, opened?.p?.f], [REVIEW_UID, "Alex Rivera", "Alex"]);
  const me = await call("/auth/me", { cookie: `${SESSION_COOKIE}=${token}` });
  check("reviewer /auth/me from the cookie", [me.res.status, me.data.name, /desc="cookie"/.test(me.res.headers.get("Server-Timing") ?? "")], [200, "Alex Rivera", true]);
  check("still nothing left the Worker for the reviewer", calls, []);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
