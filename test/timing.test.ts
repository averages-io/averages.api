// Server-Timing on every answer: src/timing.ts and its use in the Worker (2026-11-13).
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/timing.test.ts
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { newTiming, pathShape, serverTiming } from "../src/timing.ts";
import { SESSION_COOKIE } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

globalThis.fetch = (async (input: RequestInfo | URL) => { throw new Error("unexpected call: " + String(input)); }) as typeof fetch;

const ENV: any = { SESSION_SECRET: "timing-test-session-secret", REVIEW_KEY: "review-key-0123456789abcdef", REVIEW_SECRET: "review-secret-0123456789abcdef" };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const APP = "https://app.averages.io";
async function call(path: string, init: { method?: string; cookie?: string; json?: unknown; origin?: string; env?: any } = {}) {
  resetRateLimits();
  const headers = new Headers();
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.origin) headers.set("Origin", init.origin);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return worker.fetch(new Request("https://api.averages.io" + path, { method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined }), init.env ?? ENV, CTX);
}

check("pathShape takes out ids and the query", [pathShape("/v1/users/4242/sections?limit=200"), pathShape("/v1/sections/7000000001/assignments")], ["/v1/users/:id/sections", "/v1/sections/:id/assignments"]);
{
  const t = newTiming(1000, "EWR");
  t.flagsFrom = "kept"; t.flagsMs = 0; t.calls = 3; t.reused = 1; t.firstAt = 1100; t.lastAt = 1900; t.slowestMs = 700; t.slowestPath = "/v1/users/:id/grades"; t.waitMs = 1300;
  const h = serverTiming(t, 2000);
  check("serverTiming: total, switches, Schoology and 429 waits", [/^app;dur=1000;desc="Averages API, (cold start|warm), EWR"/.test(h), h.includes('flags;dur=0;desc="Feature switches (kept)"'), h.includes('schoology;dur=800;desc="Waiting on Schoology: 3 calls, 1 reused, slowest 700ms /v1/users/:id/grades"'), h.includes("ratelimit;dur=1300")], [true, true, true, true]);
  check("serverTiming: no quotes or line breaks from a path", serverTiming({ ...t, slowestPath: 'a"b\nc' }, 2000).includes('slowest 700ms abc"'), true);
}

const first = await call("/", { origin: APP });
const st1 = first.headers.get("Server-Timing") ?? "";
check("every answer has Server-Timing (app total)", /(^|, )app;dur=\d+;desc="Averages API, (cold start|warm)"/.test(st1), true);
check("our own pages may read it (Timing-Allow-Origin)", first.headers.get("Timing-Allow-Origin"), APP);
const other = await call("/", { origin: "https://evil.example" });
check("other sites aren't let read it", other.headers.get("Timing-Allow-Origin"), null);
check("a second request is a warm one", /desc="Averages API, warm/.test(other.headers.get("Server-Timing") ?? ""), true);
const flagged = await call("/", { env: { ...ENV, FLAGS: { getBooleanValue: async (_k: string, d: boolean) => d, getStringValue: async () => "" } } });
check("with Flagship: says the switches were asked", /flags;dur=\d+;desc="Feature switches \(asked Flagship\)"/.test(flagged.headers.get("Server-Timing") ?? ""), true);

// the reviewer's pretend Schoology counts as Schoology calls
{
  const res = await call("/auth/session", { json: { key: ENV.REVIEW_KEY, secret: ENV.REVIEW_SECRET } });
  const cookie = (res.headers.getSetCookie?.() ?? [res.headers.get("Set-Cookie") ?? ""]).map((c) => c.split(";")[0]).find((c) => c.startsWith(SESSION_COOKIE + "=")) ?? "";
  const b = await call("/data/bundle", { cookie, origin: APP });
  const st = b.headers.get("Server-Timing") ?? "";
  const n = Number((st.match(/Waiting on Schoology: (\d+) calls?/) || [])[1] || 0);
  check("the bundle says how many Schoology calls it waited on", [b.status, n > 5, /schoology;dur=\d+/.test(st), /slowest \d+ms \/[a-z]+\/(:id|me)/.test(st)], [200, true, true, true]);
  check("nothing about the student in it", /\d{6,}/.test(st.replace(/dur=\d+/g, "")), false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
