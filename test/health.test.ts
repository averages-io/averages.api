// The automatic outage check (src/health.ts): what counts as down, what the banner says, what /status shows.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/health.test.ts
import { aiSearchCheck, downNow, healthMessage, inBucket, nextRecord, present, reachable, runChecks, AI_SEARCH_FILES, HEALTH_STALE_MS, type HealthRecord } from "../src/health.ts";
import worker, { checkHealth } from "../src/index.ts";
import { resetHealthCache } from "../src/health.ts";

let passed = 0, failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected: ${JSON.stringify(want)}\n        actual:   ${JSON.stringify(got)}`);
}
const answer = (status: number) => async () => new Response("x", { status });
const boom = async () => { throw new Error("no connection"); };

console.log("one service");
check("401 (please sign in) is up", await reachable("https://x.example", answer(401)), "ok");
check("200 is up", await reachable("https://x.example", answer(200)), "ok");
check("503 is down", await reachable("https://x.example", answer(503)), "down");
check("no connection is down", await reachable("https://x.example", boom as any), "down");

console.log("\none round");
{
  const byHost: Record<string, number> = { "api.schoology.com": 401, "api.canva.com": 502, "www.googleapis.com": 401, "graph.microsoft.com": 401 };
  const f = async (url: string) => new Response("", { status: byHost[new URL(url).hostname] ?? 200 });
  const got = await runChecks({ fetcher: f as any, signin: async () => "ok", sync: async () => null, notifications: async () => { throw new Error("x"); }, calendar: null, pictures: async () => ({}), canva: true, gdrive: true, onedrive: false });
  check("each part answered", got, { "schoology-signin": "ok", schoology: "ok", canva: "down", gdrive: "ok", onedrive: "off", sync: "ok", notifications: "down", calendar: "off", pictures: "ok", "ai-search": "off" });
}

console.log("\nA.I. search's files");
{
  const all = new Set(AI_SEARCH_FILES.map((p) => p.replace(/^\/ai\//, "")));
  const bucket = (missing = "") => ({ head: async (k: string) => (all.has(k) && k !== missing ? { size: 1 } : null) });
  check("all in the bucket: up", await inBucket(bucket()), "ok");
  check("the 8-bit model missing: down", await inBucket(bucket("models/averages-search-q8-r17/onnx/model_quantized.onnx_data")), "down");
  check("bucket error: down", await aiSearchCheck({ head: async () => { throw new Error("r2"); } })().catch(() => "down"), "down");
  const seen: string[] = [];
  const web = (status: (u: string) => number) => async (u: string, init?: RequestInit) => { seen.push(String(init?.method) + " " + new URL(u).pathname); return new Response(null, { status: status(u) }); };
  check("no bucket: asks the app (HEAD), all 200: up", await present(AI_SEARCH_FILES.map((p) => "https://app.averages.io" + p), web(() => 200) as any), "ok");
  check("...with HEAD, at /ai/", seen[0].startsWith("HEAD /ai/"), true);
  check("one 404: down", await aiSearchCheck(undefined, web((u) => (u.includes("q8-r17") ? 404 : 200)) as any)(), "down");
  check("in a round", (await runChecks({ fetcher: (async () => new Response("", { status: 401 })) as any, signin: null, sync: null, notifications: null, calendar: null, pictures: null, canva: false, gdrive: false, onedrive: false, aiSearch: async () => "down" }))["ai-search"], "down");
  check("its banner line", healthMessage(["ai-search"]), "A.I. search can't download right now. Search works as before.");
  check("with another", healthMessage(["canva", "ai-search"]), "A few things are having trouble right now: Canva and A.I. search. Everything else still works.");
}

console.log("\nthe record");
{
  const t = 1_000_000_000;
  const a = nextRecord(null, { canva: "down", schoology: "ok" }, t);
  check("down since now", a.since, { canva: t });
  const b = nextRecord(a, { canva: "down" }, t + 900_000);
  check("still down: same since", b.since.canva, t);
  const c = nextRecord(b, { canva: "ok" }, t + 1_800_000);
  check("back up: since cleared", c.since, {});
  check("what's down", downNow(b, t + 900_000), ["canva"]);
  check("too old to trust: nothing", downNow(b, t + 900_000 + HEALTH_STALE_MS + 1), []);
  check("no record: nothing", downNow(null, t), []);
}

console.log("\nthe banner");
check("one", healthMessage(["canva"]), "Canva isn't working right now. You can still turn in files from your computer.");
check("Schoology down covers sign-in", healthMessage(["schoology-signin", "schoology"]), "Schoology isn't answering right now, so grades, assignments and messages may not update.");
check("two", healthMessage(["canva", "gdrive"]), "A few things are having trouble right now: Canva and Google Drive. Everything else still works.");
check("three", healthMessage(["canva", "gdrive", "sync"]), "A few things are having trouble right now: Canva, Google Drive and syncing across devices. Everything else still works.");
check("nothing", healthMessage([]), "");

console.log("\nthe Worker");
{
  let saved: HealthRecord | null = null;
  const HEALTH = { idFromName: (n: string) => n, get: () => ({ read: async () => saved, write: async (r: HealthRecord) => { saved = r; } }) };
  const env: any = { SESSION_SECRET: "health-test-secret-0123456789", HEALTH, FEATURES_ON: "canva-integration", CANVA_CLIENT_ID: "OC-x", CANVA_CLIENT_SECRET: "y", CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback" };
  const f = async (url: string) => new Response("", { status: new URL(url).hostname === "api.canva.com" ? 503 : 401 });
  await checkHealth(env, f as any);
  check("the check saved its record", [!!saved, saved && (saved as HealthRecord).services.canva, saved && (saved as HealthRecord).services.schoology], [true, "down", "ok"]);
  resetHealthCache();
  const CTX: any = { waitUntil() {}, passThroughOnException() {} };
  const feat = await (await worker.fetch(new Request("https://api.averages.io/config/features", { headers: { Origin: "https://app.averages.io" } }), env, CTX)).json() as any;
  check("the pages' banner says what's down", feat.maintenance, { message: "Canva isn't working right now. You can still turn in files from your computer.", automatic: true });
  const st = await (await worker.fetch(new Request("https://api.averages.io/status"), env, CTX)).json() as any;
  check("/status: degraded, Canva down, since when", [st.status, st.health.canva, st.health.schoology, typeof st.downSince?.canva, typeof st.lastHealthCheck], ["degraded", "down", "ok", "string", "string"]);
  resetHealthCache();
  const env2 = { ...env, FEATURES_ON: "canva-integration,maintenance-banner", MAINTENANCE_MESSAGE: "Planned maintenance tonight." };
  const feat2 = await (await worker.fetch(new Request("https://api.averages.io/config/features"), env2, CTX)).json() as any;
  check("the switch's message wins", feat2.maintenance, { message: "Planned maintenance tonight." });
  resetHealthCache();
  saved = null;
  const st3 = await (await worker.fetch(new Request("https://api.averages.io/status"), { ...env, HEALTH: { idFromName: (n: string) => n, get: () => ({ read: async () => null }) } }, CTX)).json() as any;
  check("no check yet: unknown, not down", [st3.status, st3.health.canva, st3.lastHealthCheck], ["ok", "unknown", null]);

  // A.I. search's files missing
  resetHealthCache();
  const envA: any = { ...env, FEATURES_ON: "", AI_FILES: { head: async (k: string) => (k.includes("q8-r17") ? null : { size: 1 }) } };
  saved = null;
  await checkHealth(envA, (async () => new Response("", { status: 401 })) as any);
  check("the check: ai-search down", saved && (saved as HealthRecord).services["ai-search"], "down");
  resetHealthCache();
  const stA = await (await worker.fetch(new Request("https://api.averages.io/status"), envA, CTX)).json() as any;
  check("/status: A.I. search down, degraded, its line", [stA.status, stA.health["ai-search"], stA.message, stA.features.aiSearch], ["degraded", "down", "A.I. search can't download right now. Search works as before.", false]);
  resetHealthCache();
  const fA = await (await worker.fetch(new Request("https://api.averages.io/config/features", { headers: { Origin: "https://app.averages.io" } }), envA, CTX)).json() as any;
  check("banner: a student without A.I. search hears nothing", fA.maintenance, null);
  resetHealthCache();
  const envOn = { ...envA, FEATURES_ON: "ai-search" };
  const fOn = await (await worker.fetch(new Request("https://api.averages.io/config/features", { headers: { Origin: "https://app.averages.io" } }), envOn, CTX)).json() as any;
  check("banner: with A.I. search on for everyone, it says so", fOn.maintenance, { message: "A.I. search can't download right now. Search works as before.", automatic: true });
  resetHealthCache();
  const fSw = await (await worker.fetch(new Request("https://api.averages.io/config/features"), { ...envOn, FEATURES_ON: "ai-search,maintenance-banner", MAINTENANCE_MESSAGE: "Planned maintenance tonight." }, CTX)).json() as any;
  check("banner: the maintenance switch still wins", fSw.maintenance, { message: "Planned maintenance tonight." });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
