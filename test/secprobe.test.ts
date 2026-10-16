/**
 * Adversarial probe (2026-10-16): fires crafted hostile requests at the real
 * Worker in-process and asserts it refuses safely. No network. Guards the
 * auth, CSRF, injection and fail-closed properties against regressions.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/secprobe.test.ts
 */
import app from "../src/index.ts";
import { sealSession, sealValue, openSession, SESSION_COOKIE, DEMO_UID } from "../src/session.ts";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, note = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? "\n        " + note : ""}`); }
}

const SECRET = "secprobe-session-secret-value-1234567890";
const ENV: any = {
  SESSION_SECRET: SECRET,
  CANVA_CLIENT_ID: "OC-x", CANVA_CLIENT_SECRET: "y", CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback",
  GOOGLE_CLIENT_ID: "123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "GOCSPX-x", GOOGLE_REDIRECT_URI: "https://api.averages.io/auth/google/callback",
  REVIEW_KEY: "review-key-abcdefghijklmnop", REVIEW_SECRET: "review-secret-abcdefghijklmnop",
  SCHOOLS_ADMIN_KEY: "k".repeat(32),
};
const CTX = { waitUntil() {}, passThroughOnException() {} } as any;
async function fire(method: string, path: string, opts: { cookie?: string; origin?: string; ct?: string; body?: string; headers?: Record<string, string>; env?: any } = {}) {
  const h: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie !== undefined) h.Cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  if (opts.origin) h.Origin = opts.origin;
  if (opts.ct) h["Content-Type"] = opts.ct;
  const res = await app.fetch(new Request("https://api.averages.io" + path, { method, headers: h, body: opts.body }), { ...ENV, ...opts.env }, CTX);
  return { status: res.status, res };
}
const live = async (uid = "7777777") => sealSession({ key: "ck", secret: "cs", uid } as any, SECRET);

console.log("session tampering");
ok("wrong-secret token: 401", (await fire("GET", "/auth/me", { cookie: await sealSession({ key: "k", secret: "s", uid: "1" } as any, "other-secret-000000000000000000") })).status === 401);
{ const g = await live(); ok("flipped ciphertext byte: 401 (GCM)", (await fire("GET", "/auth/me", { cookie: g.slice(0, -2) + (g.endsWith("A") ? "B" : "A") })).status === 401); }
ok("garbage cookie: 401", (await fire("GET", "/auth/me", { cookie: "not.a.token" })).status === 401);
ok("no cookie: 401", (await fire("GET", "/auth/me")).status === 401);
{
  // Expiry is enforced: prove it by advancing the clock against openSession.
  const t = await live("1");
  const realNow = Date.now; Date.now = () => realNow() + 400 * 24 * 3600 * 1000;
  const after = await openSession(t, SECRET);
  Date.now = realNow;
  ok("a session past its TTL is rejected", after === null);
}

console.log("\ncross-purpose token confusion");
ok("a canva-save sealed value is not a session", (await fire("GET", "/auth/me", { cookie: await sealValue(JSON.stringify({ uid: "1", key: "k", secret: "s" }), SECRET, "canva-save", 3600) })).status === 401);
ok("an oauth-state sealed value is not a session", (await fire("GET", "/auth/me", { cookie: await sealValue({ uid: "1" }, SECRET, "canva-state", 3600) })).status === 401);

console.log("\nlogin CSRF / cross-site");
ok("POST /auth/session evil Origin: 403", (await fire("POST", "/auth/session", { origin: "https://evil.example", ct: "application/json", body: JSON.stringify({ key: "a", secret: "b" }) })).status === 403);
ok("POST /auth/session non-JSON: 415", (await fire("POST", "/auth/session", { ct: "text/plain", body: "key=a" })).status === 415);
{ const r = await fire("POST", "/auth/session", { origin: "https://app.averages.io", ct: "application/json", body: JSON.stringify({ key: "review-key-abcdefghijklmnop", secret: "WRONG-xxxxxxxxxxxxxxxxxxxxxxxx" }) });
  ok("reviewer key + wrong secret: refused, no Set-Cookie", r.status >= 400 && !r.res.headers.get("Set-Cookie")); }

console.log("\nid / path injection (demo session)");
{
  const demo = await sealSession({ key: "", secret: "", uid: DEMO_UID } as any, SECRET);
  for (const p of ["/data/assignment?section=1/../9&id=2", "/data/attachment?section=111&assignment=1&file=1%0d%0aHost:evil", "/data/attachment?section=111&assignment=1&file=" + "9".repeat(50), "/data/submission-file?section=1&assignment=1&revision=1&file=1;rm"]) {
    ok("hostile ids rejected: " + p.slice(0, 44), [400, 401, 403, 404].includes((await fire("GET", p, { cookie: demo })).status));
  }
}

console.log("\nauth required");
for (const [m, p] of [["GET", "/data/bundle"], ["GET", "/data/files"], ["POST", "/canva/save-folder"], ["PUT", "/media/photo"], ["GET", "/sync/settings"], ["POST", "/push/subscribe"]] as const) {
  ok(`${m} ${p}: 401 without a session`, (await fire(m, p, { origin: "https://app.averages.io", ct: "application/json", body: m === "GET" ? undefined : "{}" })).status === 401);
}

console.log("\nsave-to-canva fails closed");
{
  const c = await live("8888888"); const good = { origin: "https://app.averages.io", ct: "application/json", cookie: c } as const;
  const body = JSON.stringify({ name: "x", files: [{ section: "1", kind: "document", parent: "2", file: "3" }] });
  ok("no Canva binding: not 200/500", [403, 409, 503].includes((await fire("POST", "/canva/save-folder", { ...good, body })).status));
  ok("cross-site: 403", (await fire("POST", "/canva/save-folder", { origin: "https://evil.example", ct: "application/json", cookie: c, body })).status === 403);
  ok("bad job id: 400", (await fire("GET", "/canva/save-folder/' OR 1=1", { cookie: c })).status === 400);
  const demo = await sealSession({ key: "", secret: "", uid: DEMO_UID } as any, SECRET);
  ok("demo can't start a save: 403", (await fire("POST", "/canva/save-folder", { origin: "https://app.averages.io", ct: "application/json", cookie: demo, body })).status === 403);
}

console.log("\nadmin surface");
ok("schools list without the key: not 200", (await fire("GET", "/schools/applications")).status !== 200);
ok("probe closed to a normal session", [403, 404].includes((await fire("POST", "/canva/probe", { origin: "https://app.averages.io", ct: "application/json", cookie: await live(), body: JSON.stringify({ key: "x" }) })).status));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
