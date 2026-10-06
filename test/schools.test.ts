/**
 * GET /config/schools (2026-10-06): the sign-in page's school lists.
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/schools.test.ts
 */
import app from "../src/index.ts";
import { schoolsFor, SCHOOLS } from "../src/schools.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}
const call = (path: string) =>
  app.fetch(new Request("https://api.averages.io" + path, { headers: { Origin: "https://app.averages.io" } }), { SESSION_SECRET: "test" } as any, { waitUntil() {}, passThroughOnException() {} } as any);

check("schoology list", schoolsFor("schoology"), SCHOOLS.schoology);
check("canvas list", schoolsFor("canvas"), SCHOOLS.canvas);
check("anything else: null", [schoolsFor("google"), schoolsFor(undefined), schoolsFor("constructor")], [null, null, null]);
for (const lms of ["schoology", "canvas"]) {
  const r = await call(`/config/schools?lms=${lms}`);
  check(`${lms}: 200 with a list`, [r.status, Array.isArray(((await r.json()) as any).schools)], [200, true]);
  check(`${lms}: cached an hour, public`, r.headers.get("Cache-Control"), "public, max-age=3600");
  check(`${lms}: CORS for the app`, r.headers.get("Access-Control-Allow-Origin"), "https://app.averages.io");
}
const bad = await call("/config/schools?lms=blackboard");
check("unknown platform: 400", bad.status, 400);
const none = await call("/config/schools");
check("no platform: 400", none.status, 400);
// Every listed school has a usable name and address.
for (const [lms, list] of Object.entries(SCHOOLS)) {
  for (const s of list) check(`${lms}: ${s.name} looks right`, [!!s.name.trim(), /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s.domain)], [true, true]);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
