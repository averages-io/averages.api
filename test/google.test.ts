/**
 * Sign in with Google (Google Classroom) was removed on 2026-10-19: the public
 * beta is Schoology only. These checks keep it removed. The old end-to-end
 * tests for the Google sign-in and Classroom routes are in git history
 * (before 2026-10-19) if Classroom comes back.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/google.test.ts
 */
import app from "../src/index.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

// Everything Google sign-in used to need, set, so a 404 means the route is gone (not just unconfigured).
const ENV: any = {
  SESSION_SECRET: "s".repeat(32),
  GOOGLE_CLIENT_ID: "123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-test",
  GOOGLE_REDIRECT_URI: "https://api.averages.io/auth/google/callback",
};
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const call = (path: string) => app.fetch(new Request("https://api.averages.io" + path), ENV, CTX);

console.log("Google sign-in is gone");
const start = await call("/auth/google/start?under13=0");
check("/auth/google/start: 404, no redirect to Google", [start.status, start.headers.get("location")], [404, null]);
check("/auth/google/start: no state cookie", start.headers.get("Set-Cookie"), null);
const callback = await call("/auth/google/callback?code=abc&state=xyz");
check("/auth/google/callback: 404, no session cookie", [callback.status, callback.headers.get("Set-Cookie")], [404, null]);

const features: any = await (await call("/config/features")).json();
check("/config/features: no Classroom sign-in switch", "gclassroom-signin" in features.features, false);
check("/config/features: Schoology sign-in still there", features.features["schoology-signin"], true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
