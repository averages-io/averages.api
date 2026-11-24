// "Sign out everywhere" and changing SESSION_SECRET without signing everyone out (2026-11-23 security sweep).
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/sessionGuard.test.ts
import app from "../src/index.ts";
import { openSession, sealSession, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionIssuedAt, DEMO_UID } from "../src/session.ts";
import { forgetGuards, sessionEnded } from "../src/sessionGuard.ts";
import { resetRateLimits } from "../src/rateLimit.ts";

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

const SECRET = "guard-test-session-secret-0123456789abcd";
const OLD = "guard-test-the-previous-secret-9876543210";
const CTX = { waitUntil() {}, passThroughOnException() {} } as any;
globalThis.fetch = (async () => new Response("{}", { status: 599 })) as any;

/* A SESSIONS namespace: one guard per student, like the Durable Object (just its two methods). */
let broken = false;
const guards = new Map<string, { t: number }>();
const SESSIONS: any = {
  idFromName: (name: string) => ({ name }),
  jurisdiction: () => SESSIONS,
  get: (id: { name: string }) => ({
    async endedAt() { if (broken) throw new Error("down"); return guards.get(id.name)?.t ?? 0; },
    async endAll(at: number) { if (broken) throw new Error("down"); guards.set(id.name, { t: at }); },
  }),
};
const ENV: any = { SESSION_SECRET: SECRET, SESSIONS };
const cookieOf = (token: string) => `${SESSION_COOKIE}=${token}`;
async function call(method: string, path: string, o: { token?: string; origin?: string; env?: any } = {}) {
  resetRateLimits();
  const h: Record<string, string> = {};
  if (o.token) h.Cookie = cookieOf(o.token);
  if (o.origin) h.Origin = o.origin;
  if (method === "POST") h["Content-Type"] = "application/json";
  const res = await app.fetch(new Request("https://api.averages.io" + path, { method, headers: h, body: method === "POST" ? "{}" : undefined }), { ...ENV, ...o.env }, CTX);
  return res;
}
const setCookies = (res: Response): string[] => (res.headers as any).getSetCookie?.() ?? [];
const later = async <T>(ms: number, f: () => Promise<T>): Promise<T> => {
  const real = Date.now;
  Date.now = () => real() + ms;
  try { return await f(); } finally { Date.now = real; }
};
const APP = "https://app.averages.io";
const live = (uid: string, secret = SECRET) => sealSession({ key: "ck", secret: "cs", uid } as any, secret);

console.log("when a session was signed in");
{
  const s = await openSession(await live("1"), SECRET);
  check("its end, less the 15 days", Math.abs(sessionIssuedAt(s!) - Math.floor(Date.now() / 1000)) <= 1, true);
}

console.log("\nsign out everywhere");
{
  const phone = await live("4242"), laptop = await live("4242"), other = await live("5151");
  check("before: both devices signed in", [(await call("GET", "/auth/me", { token: phone })).status !== 401, (await call("GET", "/auth/me", { token: laptop })).status !== 401], [true, true]);
  check("from another site: 403, nothing ended", [(await call("POST", "/auth/signout-everywhere", { token: laptop, origin: "https://evil.example" })).status, guards.has("4242")], [403, false]);
  const r = await call("POST", "/auth/signout-everywhere", { token: laptop, origin: APP });
  check("from the app: 200, and this device's cookies cleared", [r.status, setCookies(r).some((x) => x.startsWith(`${SESSION_COOKIE}=;`)), setCookies(r).some((x) => x.startsWith("averages_signed_in=;"))], [200, true, true]);
  const p = await call("GET", "/auth/me", { token: phone });
  check("the other device is signed out (401) and told to drop its cookie", [p.status, setCookies(p).some((x) => x.startsWith(`${SESSION_COOKIE}=;`))], [401, true]);
  check("so is this one", (await call("GET", "/auth/me", { token: laptop })).status, 401);
  check("data routes too", (await call("GET", "/data/bundle", { token: phone })).status, 401);
  check("another student isn't touched", (await call("GET", "/auth/me", { token: other })).status !== 401, true);
  const fresh = await later(2000, () => live("4242"));
  check("signing in again afterwards works", (await later(2000, () => call("GET", "/auth/me", { token: fresh }))).status !== 401, true);
  forgetGuards();
  check("another Worker copy (nothing remembered) asks the store: still signed out", (await call("GET", "/auth/me", { token: phone })).status, 401);
}

console.log("\nwhen the store can't answer");
{
  forgetGuards();
  broken = true;
  const t = await live("6060");
  check("nobody is signed out because of it (fails open)", (await call("GET", "/auth/me", { token: t })).status !== 401, true);
  check("and signing out everywhere says it didn't work (503), cookie kept", [(await call("POST", "/auth/signout-everywhere", { token: t, origin: APP })).status], [503]);
  broken = false;
}

console.log("\nnot for the shared accounts, nor without the store");
{
  const demo = await sealSession({ key: "", secret: "", uid: DEMO_UID } as any, SECRET);
  check("demo: 403", (await call("POST", "/auth/signout-everywhere", { token: demo, origin: APP })).status, 403);
  check("no SESSIONS binding: 503, sessions work as before", [(await call("POST", "/auth/signout-everywhere", { token: await live("7"), origin: APP, env: { SESSIONS: undefined } })).status], [503]);
  check("signed out: 401", (await call("POST", "/auth/signout-everywhere", { origin: APP })).status, 401);
}

console.log("\nthe store lives as long as a session can");
{
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/sessionGuard.ts", import.meta.url), "utf8"));
  check("deletes itself 15 days (and an hour) after", /setAlarm\(Date\.now\(\) \+ \(SESSION_TTL_SECONDS \+ 3600\) \* 1000\)/.test(src) && /deleteAll\(\)/.test(src), true);
  check("15 days", SESSION_TTL_SECONDS, 15 * 86400);
  const s = await openSession(await live("9"), SECRET);
  check("a guard set before this sign-in doesn't end it", await sessionEnded(s!, () => ({ endedAt: async () => sessionIssuedAt(s!) - 5, endAll: async () => {} })), false);
}

console.log("\nchanging SESSION_SECRET (SESSION_SECRET_PREVIOUS)");
{
  forgetGuards();
  const old = await live("8080", OLD);
  const before = await openSession(old, OLD);
  check("without the previous secret set: signed out, like before", (await call("GET", "/auth/me", { token: old })).status, 401);
  const r = await call("GET", "/auth/me", { token: old, env: { SESSION_SECRET_PREVIOUS: OLD } });
  check("with it: still signed in", r.status !== 401, true);
  const moved = setCookies(r).find((x) => x.startsWith(`${SESSION_COOKIE}=`) && !x.startsWith(`${SESSION_COOKIE}=;`));
  const token = moved ? moved.split(";")[0].slice(SESSION_COOKIE.length + 1) : "";
  const after = await openSession(token, SECRET);
  check("and the cookie is sealed again with the new secret", !!after, true);
  check("the same session: same student, same end (not made longer)", [after?.uid, after?.exp], [before?.uid, before?.exp]);
  check("the new cookie needs no previous secret", (await call("GET", "/auth/me", { token })).status !== 401, true);
  const again = await call("GET", "/auth/me", { token, env: { SESSION_SECRET_PREVIOUS: OLD } });
  check("a cookie already on the new secret isn't sealed again", setCookies(again).some((x) => x.startsWith(`${SESSION_COOKIE}=`)), false);
  check("a made-up token opens with neither", (await call("GET", "/auth/me", { token: "abc.def", env: { SESSION_SECRET_PREVIOUS: OLD } })).status, 401);
  await call("POST", "/auth/signout-everywhere", { token, origin: APP });
  check("signing out everywhere ends the old-secret cookie too", (await call("GET", "/auth/me", { token: old, env: { SESSION_SECRET_PREVIOUS: OLD } })).status, 401);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
