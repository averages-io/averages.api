/**
 * The 2026-10-28 routes, end to end through the Worker with the review
 * sandbox's account (no Schoology): classmates, join by code, folder items
 * with titles, Download your data, and Delete your account.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/account.test.ts
 */
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { REVIEW_UID, SANDBOX_KEY, SANDBOX_SECRET } from "../src/reviewSandbox.ts";
import { readCookie, sealSession, SESSION_COOKIE } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

// Nothing here may reach the internet: the sandbox answers for Schoology.
globalThis.fetch = (async (input: RequestInfo | URL) => { throw new Error(`unexpected call: ${String(input)}`); }) as typeof fetch;

const SECRET = "account-routes-test-session-secret";
const ENV: any = { SESSION_SECRET: SECRET, REVIEW_KEY: "review-key-0123456789abcdef", REVIEW_SECRET: "review-secret-0123456789abcdef" };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";
const APP = "https://app.averages.io";
const session = await sealSession({ key: SANDBOX_KEY, secret: SANDBOX_SECRET, uid: REVIEW_UID }, SECRET);
const COOKIE = `${SESSION_COOKIE}=${session}`;

async function call(path: string, init: { method?: string; json?: unknown; origin?: string | null; cookie?: string | null } = {}) {
  resetRateLimits();
  const headers = new Headers();
  if (init.cookie !== null) headers.set("Cookie", init.cookie ?? COOKIE);
  if (init.origin !== null) headers.set("Origin", init.origin ?? APP);
  let body: string | undefined;
  if (init.json !== undefined) { headers.set("Content-Type", "application/json"); body = JSON.stringify(init.json); }
  const res = (await worker.fetch(new Request(API + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body }), ENV, CTX)) as Response;
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { res, data };
}

console.log("classmates");
{
  const { res, data } = await call("/data/classmates");
  const lists = Object.values(data.CLASSMATES ?? {}) as any[][];
  check("200 with a list for each class", [res.status, lists.length > 0], [200, true]);
  check("names and ids only (no grades or emails)", lists.flat().every((m) => Object.keys(m).sort().join() === "id,name,photo"), true);
  check("never the student themselves", lists.flat().some((m) => m.id === REVIEW_UID), false);
  const out = await call("/data/classmates", { cookie: null });
  check("signed out: 401", out.res.status, 401);
}

console.log("\njoin by code");
{
  let r = await call("/data/join", { json: { code: "sample-join" } });
  check("a good code joins (case doesn't matter)", [r.res.status, r.data.ok, /^\d+$/.test(r.data.section)], [200, true, true]);
  r = await call("/data/join", { json: { code: "SAMPLE-CLOSED" } });
  check("a closed class: not_joined", [r.res.status, r.data.error], [400, "not_joined"]);
  r = await call("/data/join", { json: { code: "NOPE-1234" } });
  check("an unknown code: not_joined", [r.res.status, r.data.error], [400, "not_joined"]);
  r = await call("/data/join", { json: { code: "a b" } });
  check("not a code at all: bad_code", [r.res.status, r.data.error], [400, "bad_code"]);
  r = await call("/data/join", { json: { code: "SAMPLE-JOIN" }, origin: "https://evil.example" });
  check("from another site: refused", r.res.status >= 400 && r.data.ok !== true, true);
}

console.log("\nfolders, with what's in them");
{
  const { res, data } = await call("/data/folders?course=7000000001");
  const items = data.items ?? [];
  check("200 with items", [res.status, items.length > 0], [200, true]);
  check("each item: key, title and folder", items.every((x: any) => /^[a-z_-]+:\d+$/.test(x.key) && typeof x.title === "string" && typeof x.folder === "string"), true);
  check("top level and inside folders both listed", [items.some((x: any) => x.folder === ""), items.some((x: any) => x.folder !== "")], [true, true]);
  check("titles are filled in", items.every((x: any) => x.title.length > 0), true);
  check("placement still there (older apps)", typeof data.placement, "object");
}

console.log("\ndownload your data");
{
  const { res, data } = await call("/account/export");
  check("200 as a download", [res.status, /attachment; filename="averages-io-data\.json"/.test(res.headers.get("Content-Disposition") ?? "")], [200, true]);
  check("says who and what mode", [data.account.id, data.account.mode], [REVIEW_UID, "Classic"]);
  check("no-store", res.headers.get("Cache-Control"), "private, no-store");
  check("has every part", ["syncedSettings", "notifications", "calendarLink", "plus", "connectedApps"].every((k) => k in data), true);
  const out = await call("/account/export", { cookie: null });
  check("signed out: 401", out.res.status, 401);
}

console.log("\ndelete your account");
{
  let r = await call("/account", { method: "DELETE", origin: "https://evil.example" });
  check("from another site: refused, still signed in", [r.res.status >= 400, ((r.res.headers as any).getSetCookie?.() ?? []).some((c: string) => c.startsWith(`${SESSION_COOKIE}=;`))], [true, false]);
  r = await call("/account", { method: "DELETE" });
  const cleared = ((r.res.headers as any).getSetCookie?.() ?? []).some((c: string) => readCookie(c.split(";")[0], SESSION_COOKIE) === "");
  check("deleted, and signed out", [r.res.status, r.data.ok, cleared], [200, true, true]);
  const out = await call("/account", { method: "DELETE", cookie: null });
  check("signed out: 401", out.res.status, 401);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
