// FULLSCREEN_PUBLIC: while it's "0", only testers (app.schoology.com sign-ins and API keys) get Fullscreen.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/fullscreenGate.test.ts
import worker, { fullscreenTester, fullscreenPublic } from "../src/index.ts";
import { sealSession, SESSION_COOKIE } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

const SECRET = "fullscreen-gate-secret";
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const base: any = { uid: "1", exp: 0 };
check("public unless it's \"0\"", [fullscreenPublic({}), fullscreenPublic({ FULLSCREEN_PUBLIC: "1" }), fullscreenPublic({ FULLSCREEN_PUBLIC: "0" })], [true, true, false]);
check("testers", [
  fullscreenTester(null),
  fullscreenTester({ ...base, key: "k", secret: "s", token: "t", tokenSecret: "x", sd: "app.schoology.com" }),
  fullscreenTester({ ...base, key: "k", secret: "s", token: "t", tokenSecret: "x", sd: "exampleusd.schoology.com" }),
  fullscreenTester({ ...base, key: "k", secret: "s" }),
  fullscreenTester({ ...base, key: "demo", secret: "demo", uid: "__demo__" }),
  fullscreenTester({ ...base, key: "k", secret: "s", token: "t", tokenSecret: "x" }),
  fullscreenTester({ ...base, key: "k", secret: "s", token: "t", tokenSecret: "x", sd: "www.schoology.com" }),
  fullscreenTester({ ...base, key: "k", secret: "s", token: "t", tokenSecret: "x", sd: "exampleusd.schoology.com" }, "exampleusd.schoology.com"),
], [false, true, false, true, false, true, true, true]);

async function features(env: any, session?: any) {
  const headers = new Headers({ Origin: "https://app.averages.io" });
  if (session) headers.set("Cookie", `${SESSION_COOKIE}=${await sealSession(session, SECRET)}`);
  const res = await worker.fetch(new Request("https://api.averages.io/config/features", { headers }), env, CTX);
  return { on: (await res.json() as any).features.fullscreen, cache: res.headers.get("Cache-Control") };
}
const ON = { SESSION_SECRET: SECRET, FEATURES_ON: "fullscreen", FULLSCREEN_PUBLIC: "0" };
const env0 = { ...ON };
const r1 = await features(env0);
const r2 = await features(env0, { key: "k", secret: "s", token: "t", tokenSecret: "x", uid: "5", sd: "exampleusd.schoology.com" });
const r3 = await features(env0, { key: "k", secret: "s", token: "t", tokenSecret: "x", uid: "6", sd: "app.schoology.com" });
const r4 = await features({ ...ON, FULLSCREEN_PUBLIC: "1" });
console.log("  (switch reads as", JSON.stringify([r1, r4]), ")");
if (r4.on) {
  check("signed out: no Fullscreen while it's testers only", [r1.on, r1.cache], [false, "private, no-store"]);
  check("another school: no", r2.on, false);
  check("the sandbox school: yes", r3.on, true);
  check("public: everyone, cached (in this browser only while server-translate is per school)", [r4.on, r4.cache], [true, "private, max-age=30"]);
} else console.log("  SKIP  route checks: the fullscreen switch couldn't be turned on here");

// server-translate: off = the Averages.io school only (same list as Fullscreen testers), on = everyone.
async function tr(env: any, session?: any) {
  const headers = new Headers({ Origin: "https://app.averages.io" });
  if (session) headers.set("Cookie", `${SESSION_COOKIE}=${await sealSession(session, SECRET)}`);
  const res = await worker.fetch(new Request("https://api.averages.io/config/features", { headers }), env, CTX);
  return { on: (await res.json() as any).features["server-translate"], cache: res.headers.get("Cache-Control"), vary: res.headers.get("Vary") };
}
const PUB = { SESSION_SECRET: SECRET };
const school = (uid: string, sd: string) => ({ key: "k", secret: "s", token: "t", tokenSecret: "x", uid, sd });
const t1 = await tr(PUB), t2 = await tr(PUB, school("7", "exampleusd.schoology.com")), t3 = await tr(PUB, school("8", "app.schoology.com"));
check("server-translate off: signed out no, another school no, the Averages.io school yes", [t1.on, t2.on, t3.on], [false, false, true]);
check("server-translate off: answer kept per browser", [t3.cache, /Cookie/.test(t3.vary ?? "")], ["private, max-age=30", true]);
const t4 = await tr({ ...PUB, FEATURES_ON: "server-translate" }, school("9", "exampleusd.schoology.com"));
console.log("  (server-translate on reads as", JSON.stringify(t4), ")");
if (t4.on) check("server-translate on: every school, cached publicly", [t4.on, t4.cache], [true, "public, max-age=30"]);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
