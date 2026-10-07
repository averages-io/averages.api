/**
 * Tests for the API's own rate limits (src/rateLimit.ts, 2026-10-06): which
 * rule a request counts against, the sliding window, and the middleware on a
 * bare Hono app (the route tests in test/routes.test.ts check it on the real
 * Worker too).
 *
 * Run: node --experimental-strip-types test/ratelimit.test.ts
 */

import { Hono } from "hono";
import { RATE_RULES, rateLimit, ruleFor, SlidingWindow } from "../src/rateLimit.ts";
import { DEMO_UID } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`);
  }
}

console.log("\nwhich rule");
const name = (m: string, p: string) => ruleFor(m, p)?.name ?? null;
check("sign-in by IP", [name("POST", "/auth/session"), name("GET", "/auth/google/start"), ruleFor("POST", "/auth/session")?.by], ["signin", "signin", "ip"]);
check("not limited: preflights, health, sign-out, public config", [name("OPTIONS", "/data/bundle"), name("GET", "/"), name("DELETE", "/auth/session"), name("GET", "/config/cloud"), name("GET", "/config/schools"), name("GET", "/push/config")], [null, null, null, null, null, null]);
// 2026-10-06 review: /auth/me and Sync count as data; the Google callback as sign-in.
check("/auth/me and /sync/* count as data; the Google callback as sign-in", [name("GET", "/auth/me"), name("GET", "/sync/settings"), name("PUT", "/sync/settings"), name("GET", "/auth/google/callback")], ["data", "data", "data", "signin"]);
check("checking on a Canva export has its own rule; starting one is canva", [name("GET", "/canva/exports/JOB1"), name("GET", "/canva/exports/JOB1/file"), name("POST", "/canva/designs/D1/export")], ["canvaPoll", "canva", "canva"]);
check("data: /data/* and reading messages", [name("GET", "/data/bundle"), name("GET", "/data/people"), name("GET", "/messages"), name("GET", "/messages/thread"), name("GET", "/messages/recipients")], ["data", "data", "data", "data", "data"]);
check("send: POST /messages*", [name("POST", "/messages"), name("POST", "/messages/reply")], ["send", "send"]);
check("submit, push, canva", [name("POST", "/submit/upload"), name("PUT", "/submit/upload/tok"), name("POST", "/push/subscribe"), name("DELETE", "/push"), name("GET", "/canva/status"), name("POST", "/canva/edit")], ["submit", "submit", "push", "push", "canva", "canva"]);
check("look-alike paths don't count as a prefix", [name("GET", "/database"), name("GET", "/messagesx"), name("GET", "/pushy")], [null, null, null]);
check("the numbers", Object.values(RATE_RULES).map((r) => [r.name, r.limit, r.windowMs, r.by]), [
  ["signin", 30, 60000, "ip"],
  ["data", 90, 60000, "student"],
  ["send", 10, 60000, "student"],
  ["submit", 90, 60000, "student"],
  ["push", 20, 60000, "student"],
  ["canva", 30, 60000, "student"],
  ["canvaPoll", 120, 60000, "student"],
  ["canvaBrowse", 90, 60000, "student"],
  ["apply", 5, 600000, "ip"],
  ["applyCode", 5, 600000, "ip"],
  ["applyVerify", 20, 600000, "ip"],
]);
check("school applications per IP; Martin's list like sign-in", [name("POST", "/schools/apply"), name("GET", "/schools/applications")], ["apply", "signin"]);
check("verify-email codes have their own rules", [name("POST", "/schools/apply/code"), name("POST", "/schools/apply/verify")], ["applyCode", "applyVerify"]);

console.log("\nsliding window");
{
  const w = new SlidingWindow();
  const t0 = 1_000_000;
  const hits = [0, 10, 20].map((dt) => w.hit("k", 3, 60000, t0 + dt).ok);
  check("up to the limit", hits, [true, true, true]);
  check("one more is refused, with how long to wait", w.hit("k", 3, 60000, t0 + 30), { ok: false, retryAfter: 60 });
  check("other keys are separate", w.hit("other", 3, 60000, t0 + 30).ok, true);
  check("refused requests don't count: free again when the oldest leaves the window", [w.hit("k", 3, 60000, t0 + 59_999).ok, w.hit("k", 3, 60000, t0 + 60_001).ok], [false, true]);
  check("Retry-After at least 1 second", w.hit("k", 3, 60000, t0 + 60_005).retryAfter >= 1, true);
}
{
  const w = new SlidingWindow(100);
  for (let i = 0; i < 1000; i++) w.hit(`key${i}`, 5, 60000, i);
  check("bounded: never more keys than its limit, oldest dropped first", [w.hits.size, w.hits.has("key0"), w.hits.has("key999")], [100, false, true]);
  w.hit("key900", 5, 60000, 2000); // touched: now most recent
  for (let i = 1000; i < 1099; i++) w.hit(`key${i}`, 5, 60000, 3000);
  check("a key in use stays", w.hits.has("key900"), true);
}

console.log("\nmiddleware");
{
  const store = new SlidingWindow();
  let uid: string | null = "4242";
  let clock = 5_000_000;
  const app = new Hono();
  app.use("*", rateLimit({ studentOf: async () => uid, store, now: () => clock }));
  app.all("*", (c) => c.json({ ok: true }));
  const env: Record<string, unknown> = {};
  const req = (method: string, path: string, ip = "203.0.113.5") => app.fetch(new Request("https://api.averages.io" + path, { method, headers: { "CF-Connecting-IP": ip } }), env);

  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await req("POST", "/messages")).status);
  check("POST /messages: 10 a minute per student, the 11th is 429", [statuses.filter((s) => s === 200).length, statuses[10]], [10, 429]);
  const limited = await req("POST", "/messages/reply");
  check("429 body and headers", [limited.status, await limited.json(), Number(limited.headers.get("Retry-After")) > 0, limited.headers.get("Cache-Control")], [429, { error: "rate_limited" }, true, "no-store"]);
  check("reading isn't affected by the send limit", (await req("GET", "/messages")).status, 200);
  uid = "5555";
  check("another student has their own count", (await req("POST", "/messages")).status, 200);
  clock += 61_000;
  uid = "4242";
  check("a minute later: allowed again", (await req("POST", "/messages")).status, 200);

  // Demo sessions all share one uid: they count per IP, so one demo visitor can't use up everyone's.
  store.clear();
  uid = DEMO_UID;
  for (let i = 0; i < 90; i++) await req("GET", "/data/bundle", "198.51.100.1");
  check("demo: counted per IP", [(await req("GET", "/data/bundle", "198.51.100.1")).status, (await req("GET", "/data/bundle", "198.51.100.2")).status], [429, 200]);

  // No session: per IP.
  store.clear();
  uid = null;
  for (let i = 0; i < 30; i++) await req("POST", "/auth/session", "192.0.2.9");
  check("sign-in: 30 a minute per IP", [(await req("POST", "/auth/session", "192.0.2.9")).status, (await req("POST", "/auth/session", "192.0.2.10")).status], [429, 200]);
  check("preflights and the health check are never limited", [(await req("OPTIONS", "/auth/session", "192.0.2.9")).status, (await req("GET", "/", "192.0.2.9")).status], [200, 200]);

  // An optional Workers Rate Limiting binding: asked too; refusing is final, failing is ignored.
  store.clear();
  uid = "4242";
  const keys: string[] = [];
  env.RATE_LIMITER = { async limit({ key }: { key: string }) { keys.push(key); return { success: false }; } };
  const viaBinding = await req("GET", "/data/people");
  check("binding says no: 429, Retry-After 60, keyed by rule and student", [viaBinding.status, viaBinding.headers.get("Retry-After"), keys], [429, "60", ["data|u:4242"]]);
  env.RATE_LIMIT_DATA = { async limit() { return { success: true }; } };
  check("a rule's own binding wins over the shared one", (await req("GET", "/data/people")).status, 200);
  env.RATE_LIMIT_DATA = { async limit() { throw new Error("binding down"); } };
  check("a binding that throws doesn't block", (await req("GET", "/data/people")).status, 200);
  delete env.RATE_LIMIT_DATA;
  delete env.RATE_LIMITER;
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
