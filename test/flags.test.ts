// Feature switches: src/flags.ts and the Worker's use of it.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/flags.test.ts
import worker from "../src/index.ts";
import { withFlags, readFeatures, readEarly, earlyKey, fallbackFeatures, featureForRoute, DEFAULTS, FEATURE_KEYS, FLAG_KEEP_MS } from "../src/flags.ts";
import { sectionIds } from "../src/index.ts";
import { adaptCourses } from "../src/adapt.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

check("14 switches, in Martin's order (billing and calendar-sync added 2026-10-21, live-grades 2026-10-27, fullscreen 2026-10-28, schoology-oauth 2026-10-29; coursematerialpreview-feature removed 2026-11-10)", FEATURE_KEYS, ["canva-integration", "onedrive-integration", "drive-integration", "schoology-signin", "test-signin", "maintenance-banner", "turnin-feature", "messaging-features", "notifications-features", "billing", "calendar-sync", "live-grades", "fullscreen", "schoology-oauth"]);
check("live grades need live-grades; the bundle never does", [featureForRoute("GET", "/data/grades"), featureForRoute("GET", "/data/bundle")], [["live-grades"], []]);
check("calendar routes need calendar-sync, except turning it off", [featureForRoute("GET", "/calendar/status"), featureForRoute("POST", "/calendar"), featureForRoute("GET", "/calendar/abc.ics"), featureForRoute("DELETE", "/calendar")], [["calendar-sync"], ["calendar-sync"], ["calendar-sync"], []]);
{
  const early = await readEarly({ FEATURES_EARLY: "messaging-features, nonsense" });
  check("early access from FEATURES_EARLY (unknown keys ignored)", early, ["messaging-features"]);
  const fromFlagship = await readEarly({ FLAGS: { getBooleanValue: async (_k: string, d: boolean) => d, getStringValue: async (k: string) => (k === "early-access" ? "messaging-features" : "") } });
  check("early access from Flagship's early-access string flag", fromFlagship, ["messaging-features"]);
  const slow = await readEarly({ FLAGS: { getBooleanValue: async (_k: string, d: boolean) => d, getStringValue: () => new Promise<string>(() => {}) } }, 20);
  check("Flagship too slow: no early keys", slow, []);
  const env = await withFlags({ FEATURES_EARLY: "messaging-features" });
  check("withFlags carries EARLY; earlyKey reads it", [earlyKey(env, "messaging-features"), earlyKey(env, "billing")], [true, false]);
}
check("defaults: everything on except the banner and billing (Fullscreen on since 2026-11-13)", FEATURE_KEYS.filter((k) => !DEFAULTS[k]), ["maintenance-banner", "billing"]);
check("billing routes: checkout and portal need the switch; status and the webhook never do", [featureForRoute("POST", "/billing/checkout"), featureForRoute("POST", "/billing/portal"), featureForRoute("GET", "/billing/status"), featureForRoute("POST", "/stripe/webhook")], [["billing"], ["billing"], [], []]);
check("no Flagship: the defaults", await readFeatures({}), DEFAULTS);
const vars = fallbackFeatures({ FEATURES_OFF: " Messaging-Features, turnin-feature,nonsense", FEATURES_ON: "maintenance-banner,turnin-feature" });
check("FEATURES_OFF / FEATURES_ON (off wins, any case, unknown ignored)", [vars["messaging-features"], vars["turnin-feature"], vars["maintenance-banner"], vars["canva-integration"]], [false, false, true, true]);

const asked: [string, boolean][] = [];
const flags = (answers: Record<string, any>) => ({ getBooleanValue: async (k: string, d: boolean) => { asked.push([k, d]); if (answers[k] instanceof Error) throw answers[k]; return k in answers ? answers[k] : d; } });
let f = await readFeatures({ FEATURES_OFF: "test-signin", FLAGS: flags({ "drive-integration": false, "maintenance-banner": true }) });
check("Flagship answers win", [f["drive-integration"], f["maintenance-banner"], f["canva-integration"]], [false, true, true]);
check("the default Flagship gets is the fallback", asked.find(([k]) => k === "test-signin"), ["test-signin", false]);
f = await readFeatures({ FLAGS: flags({ "turnin-feature": new Error("down") }) });
check("an error: the fallback", f["turnin-feature"], true);
f = await readFeatures({ FLAGS: { getBooleanValue: () => new Promise<boolean>(() => {}) } }, 30);
check("too slow: the fallbacks", f, DEFAULTS);
f = await readFeatures({ FLAGS: { getBooleanValue: async () => "no" as any } });
check("not a boolean: the fallback", f["messaging-features"], true);
const e: any = await withFlags({ OTHER: "x" });
check("withFlags keeps env and adds FEATURES", [e.OTHER, e.FEATURES["canva-integration"]], ["x", true]);

check("routes → switches", [
  featureForRoute("GET", "/canva/designs"), featureForRoute("POST", "/canva/designs/D1/export"), featureForRoute("GET", "/canva/exports/j1/file"),
  featureForRoute("POST", "/cloud/gdrive/token"), featureForRoute("GET", "/cloud/onedrive/connect"), featureForRoute("GET", "/cloud/status"),
  featureForRoute("POST", "/submit/file"), featureForRoute("GET", "/submit/history"),
  featureForRoute("POST", "/messages/reply"), featureForRoute("POST", "/push/subscribe"), featureForRoute("DELETE", "/push/subscribe"), featureForRoute("GET", "/push/config"),
  featureForRoute("GET", "/data/bundle"),
], [["canva-integration"], ["canva-integration", "turnin-feature"], ["canva-integration", "turnin-feature"], ["drive-integration"], ["onedrive-integration"], [], ["turnin-feature"], [], ["messaging-features"], ["notifications-features"], [], [], []]);

// Through the Worker.
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const ENV: any = { SESSION_SECRET: "s".repeat(32), GOOGLE_CLIENT_ID: "362414855541-abc.apps.googleusercontent.com", MS_CLIENT_ID: "c006202b-180f-4d4c-b03c-c0f43048c8e9", REVIEW_KEY: "k".repeat(20), REVIEW_SECRET: "r".repeat(20) };
const call = (path: string, env: any, init?: RequestInit) => worker.fetch(new Request("https://api.averages.io" + path, init), env, CTX);
const json = async (r: Response) => [r.status, await r.json()];

let r = await call("/config/features", ENV);
let j: any = await r.json();
check("/config/features: defaults, no banner", [r.status, j.features["turnin-feature"], j.features["maintenance-banner"], j.maintenance], [200, true, false, null]);
r = await call("/config/features", { ...ENV, FLAGS: flags({ "maintenance-banner": true }), MAINTENANCE_MESSAGE: "  Schoology is down. " });
j = await r.json();
check("/config/features: banner with its text", [j.features["maintenance-banner"], j.maintenance], [true, { message: "Schoology is down." }]);
j = await (await call("/config/features", { ...ENV, FEATURES_ON: "maintenance-banner" })).json();
check("banner without text: a plain default", typeof j.maintenance.message === "string" && j.maintenance.message.length > 10, true);

j = await (await call("/config/cloud", { ...ENV, FLAGS: flags({ "drive-integration": false }) })).json();
check("/config/cloud: Drive off looks unconfigured, OneDrive still there", [j.google, !!j.microsoft], [null, true]);

const OFF = (k: string) => ({ ...ENV, FLAGS: flags({ [k]: false }) });
check("messages off → 503 feature_off", await json(await call("/messages", OFF("messaging-features"))), [503, { error: "feature_off", feature: "messaging-features" }]);
check("turn in off → /submit/text 503", (await call("/submit/text", OFF("turnin-feature"), { method: "POST" })).status, 503);
check("turn in off → /submit/history still answers (401 without a session)", (await call("/submit/history", OFF("turnin-feature"))).status, 401);
check("/data/submissions and /data/submission-file need no switch", [featureForRoute("GET", "/data/submissions"), featureForRoute("GET", "/data/submission-file"), featureForRoute("GET", "/data/files")], [[], [], []]);
check("turn in off → /data/submissions still answers (401 without a session)", (await call("/data/submissions", OFF("turnin-feature"))).status, 401);
check("on: the route runs as before (401 without a session)", (await call("/messages", ENV)).status, 401);
r = await call("/canva/connect", OFF("canva-integration"));
check("Canva off: Connect goes back to Settings", [r.status, r.headers.get("location")], [302, "https://app.averages.io/settings?feature_off=canva-integration"]);

const signIn = (env: any, key: string, secret: string) => call("/auth/session", env, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.averages.io" }, body: JSON.stringify({ key, secret }) });
check("reviewer sign-in off → 503 test-signin", await json(await signIn(OFF("test-signin"), "k".repeat(20), "r".repeat(20))), [503, { error: "feature_off", feature: "test-signin" }]);
check("Schoology sign-in off → 503 schoology-signin", await json(await signIn(OFF("schoology-signin"), "abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz")), [503, { error: "feature_off", feature: "schoology-signin" }]);
check("Schoology sign-in off doesn't stop the reviewer", (await signIn(OFF("schoology-signin"), "k".repeat(20), "r".repeat(20))).status !== 503, true);

// Flagship is asked at most every FLAG_KEEP_MS per Worker; requests in between use that answer (2026-11-13)
{
  let asks = 0, drive = true;
  const F = { getBooleanValue: async (k: string, d: boolean) => { asks++; return k === "drive-integration" ? drive : d; }, getStringValue: async () => "" };
  const env = { FLAGS: F };
  const t = 1_000_000;
  const a = await withFlags(env, 400, t);
  const n1 = asks;
  drive = false;
  const b = await withFlags(env, 400, t + 5_000);
  const c = await withFlags(env, 400, t + FLAG_KEEP_MS + 1);
  check("Flagship answer kept for FLAG_KEEP_MS, then asked again", [n1 > 0, asks === n1 * 2, a.FEATURES["drive-integration"], b.FEATURES["drive-integration"], c.FEATURES["drive-integration"]], [true, true, true, true, false]);
  await Promise.all([withFlags(env, 400, t + 3 * FLAG_KEEP_MS), withFlags(env, 400, t + 3 * FLAG_KEEP_MS)]);
  check("requests arriving together share one lookup", asks, n1 * 3);
  const other = await withFlags({ FLAGS: { getBooleanValue: async (_k: string, d: boolean) => d } }, 400, t + 1);
  check("a different Flagship binding isn't given another's answer", other.FEATURES["drive-integration"], true);
}
{
  const secs: any[] = [{ id: 5 }, { section_id: "7" }, {}, { id: "", section_id: 9 }, null, { id: "12" }];
  check("sectionIds: same ids and order as adaptCourses", sectionIds(secs), adaptCourses(secs, []).COURSES.map((c) => c.id));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
