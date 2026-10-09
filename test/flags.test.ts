/**
 * Feature switches (2026-10-09): src/flags.ts and the Worker's use of it.
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/flags.test.ts
 */
import worker from "../src/index.ts";
import { withFlags, readFeatures, fallbackFeatures, featureForRoute, DEFAULTS, FEATURE_KEYS } from "../src/flags.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

check("13 switches, in Martin's order", FEATURE_KEYS, ["canva-integration", "onedrive-integration", "drive-integration", "schoology-signin", "gclassroom-signin", "canvas-signin", "test-signin", "maintenance-banner", "schoolsform-page", "coursematerialpreview-feature", "turnin-feature", "messaging-features", "notifications-features"]);
check("defaults: everything on except the banner and previews", FEATURE_KEYS.filter((k) => !DEFAULTS[k]), ["maintenance-banner", "coursematerialpreview-feature"]);
check("no Flagship: the defaults", await readFeatures({}), DEFAULTS);
const vars = fallbackFeatures({ FEATURES_OFF: " Messaging-Features, turnin-feature,nonsense", FEATURES_ON: "maintenance-banner,turnin-feature" });
check("FEATURES_OFF / FEATURES_ON (off wins, any case, unknown ignored)", [vars["messaging-features"], vars["turnin-feature"], vars["maintenance-banner"], vars["canva-integration"]], [false, false, true, true]);

const asked: [string, boolean][] = [];
const flags = (answers: Record<string, any>) => ({ getBooleanValue: async (k: string, d: boolean) => { asked.push([k, d]); if (answers[k] instanceof Error) throw answers[k]; return k in answers ? answers[k] : d; } });
let f = await readFeatures({ FEATURES_OFF: "canvas-signin", FLAGS: flags({ "drive-integration": false, "maintenance-banner": true }) });
check("Flagship answers win", [f["drive-integration"], f["maintenance-banner"], f["canva-integration"]], [false, true, true]);
check("the default Flagship gets is the fallback", asked.find(([k]) => k === "canvas-signin"), ["canvas-signin", false]);
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
  featureForRoute("POST", "/schools/apply/code"), featureForRoute("GET", "/auth/google/start"), featureForRoute("GET", "/data/bundle"),
], [["canva-integration"], ["canva-integration", "turnin-feature"], ["canva-integration", "turnin-feature"], ["drive-integration"], ["onedrive-integration"], [], ["turnin-feature"], [], ["messaging-features"], ["notifications-features"], [], [], ["schoolsform-page"], ["gclassroom-signin"], []]);

// Through the Worker.
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const ENV: any = { SESSION_SECRET: "s".repeat(32), SCHOOLS: {}, SCHOOLS_MAIL: { send: async () => ({}) }, GOOGLE_CLIENT_ID: "362414855541-abc.apps.googleusercontent.com", MS_CLIENT_ID: "c006202b-180f-4d4c-b03c-c0f43048c8e9", REVIEW_KEY: "k".repeat(20), REVIEW_SECRET: "r".repeat(20) };
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
check("on: the route runs as before (401 without a session)", (await call("/messages", ENV)).status, 401);
r = await call("/canva/connect", OFF("canva-integration"));
check("Canva off: Connect goes back to Settings", [r.status, r.headers.get("location")], [302, "https://app.averages.io/settings?feature_off=canva-integration"]);
r = await call("/auth/google/start", OFF("gclassroom-signin"));
check("Classroom sign-in off: back to the sign-in page", [r.status, r.headers.get("location")], [302, "https://app.averages.io/?google=unavailable"]);
check("school form off: apply refused, config says closed", [(await call("/schools/apply", OFF("schoolsform-page"), { method: "POST" })).status, ((await (await call("/config/apply", OFF("schoolsform-page"))).json()) as any).open], [503, false]);

const signIn = (env: any, key: string, secret: string) => call("/auth/session", env, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.averages.io" }, body: JSON.stringify({ key, secret }) });
check("reviewer sign-in off → 503 test-signin", await json(await signIn(OFF("test-signin"), "k".repeat(20), "r".repeat(20))), [503, { error: "feature_off", feature: "test-signin" }]);
check("Schoology sign-in off → 503 schoology-signin", await json(await signIn(OFF("schoology-signin"), "abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz")), [503, { error: "feature_off", feature: "schoology-signin" }]);
check("Schoology sign-in off doesn't stop the reviewer", (await signIn(OFF("schoology-signin"), "k".repeat(20), "r".repeat(20))).status !== 503, true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
