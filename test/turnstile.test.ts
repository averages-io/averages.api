// Invisible Turnstile on the sign-in page: the token check, and both sign-in routes with it on and off.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/turnstile.test.ts
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { checkTurnstile, turnstileHosts, turnstileOn } from "../src/turnstile.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

// Cloudflare's siteverify, faked: the token says what it should answer
const ANSWERS: Record<string, unknown> = {
  good: { success: true, action: "signin", hostname: "app.averages.io" },
  local: { success: true, action: "signin", hostname: "localhost" },
  other_action: { success: true, action: "school-apply", hostname: "app.averages.io" },
  other_site: { success: true, action: "signin", hostname: "evil.example" },
  used: { success: false, "error-codes": ["timeout-or-duplicate"] },
  badsecret: { success: false, "error-codes": ["invalid-input-secret"] },
};
let verifyCalls = 0;
const siteverify = (async (_url: any, init?: RequestInit) => {
  verifyCalls++;
  const token = String((init?.body as FormData).get("response"));
  if (token === "down") return new Response("oops", { status: 500 });
  return new Response(JSON.stringify(ANSWERS[token] ?? { success: false }), { status: 200 });
}) as typeof fetch;

console.log("the token check");
check("on only with both the site key and the secret", [turnstileOn({}), turnstileOn({ TURNSTILE_SITE_KEY: "k" }), turnstileOn({ TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" })], [false, false, true]);
const ck = (t: unknown, local = false) => checkTurnstile(t, "s", { fetcher: siteverify, hosts: turnstileHosts({ TURNSTILE_HOSTNAMES: "app.averages.io" }, local) });
check("hostnames from TURNSTILE_HOSTNAMES; localhost only while testing locally", [[...turnstileHosts({ TURNSTILE_HOSTNAMES: " app.averages.io , " })], [...turnstileHosts({ TURNSTILE_HOSTNAMES: "app.averages.io" }, true)]], [["app.averages.io"], ["app.averages.io", "localhost", "127.0.0.1"]]);
check("no hostnames set: nothing passes", await checkTurnstile("good", "s", { fetcher: siteverify, hosts: new Set() }), "failed");
check("a real token from our sign-in page", await ck("good"), "ok");
verifyCalls = 0;
check("missing or odd: failed, Cloudflare not asked", [await ck(undefined), await ck(""), await ck(5), verifyCalls], ["failed", "failed", "failed", 0]);
check("another action, another site, used twice: failed", [await ck("other_action"), await ck("other_site"), await ck("used")], ["failed", "failed", "failed"]);
check("localhost only counts when testing locally", [await ck("local"), await ck("local", true)], ["failed", "ok"]);
check("Cloudflare down, or our secret wrong: unavailable (not the student's fault)", [await ck("down"), await ck("badsecret")], ["unavailable", "unavailable"]);

console.log("\nthe sign-in routes");
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (url.hostname === "challenges.cloudflare.com") return siteverify(url, init);
  if (url.pathname === "/v1/oauth/request_token") return new Response("oauth_token=REQ1&oauth_token_secret=REQS1", { status: 200 });
  throw new Error(`unexpected call: ${url}`);
}) as typeof fetch;
const BASE: any = { SESSION_SECRET: "turnstile-test-secret", SCHOOLOGY_CONSUMER_KEY: "ck", SCHOOLOGY_CONSUMER_SECRET: "cs" };
const ON: any = { ...BASE, TURNSTILE_SITE_KEY: "0x4AAAAtest", TURNSTILE_SECRET: "s", TURNSTILE_HOSTNAMES: "app.averages.io" };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const go = async (env: any, path: string, init: RequestInit = {}) => {
  resetRateLimits();
  const headers = new Headers(init.headers); headers.set("Origin", "https://app.averages.io");
  return worker.fetch(new Request("https://api.averages.io" + path, { ...init, headers, redirect: "manual" }), env, CTX) as Promise<Response>;
};
check("status tells the page the site key (when on)", [await (await go(ON, "/auth/schoology/status")).json(), await (await go(BASE, "/auth/schoology/status")).json()], [{ on: true, turnstile: "0x4AAAAtest" }, { on: true }]);
let r = await go(ON, "/auth/schoology/start?domain=app.schoology.com");
check("Sign in with Schoology without a token: back to the page with verify_failed", [r.status, r.headers.get("Location")], [302, "https://app.averages.io/?signin_error=verify_failed#schoology"]);
r = await go(ON, "/auth/schoology/start?domain=app.schoology.com&ts=used");
check("with a used token: verify_failed", r.headers.get("Location"), "https://app.averages.io/?signin_error=verify_failed#schoology");
r = await go(ON, "/auth/schoology/start?domain=app.schoology.com&ts=good");
check("with a real token: on to the school's Schoology", [r.status, (r.headers.get("Location") ?? "").startsWith("https://app.schoology.com/oauth/authorize")], [302, true]);
r = await go(ON, "/auth/schoology/start?domain=app.schoology.com&ts=down");
check("Cloudflare can't be asked: refused, with its own message (Cloudflare's guidance)", r.headers.get("Location"), "https://app.averages.io/?signin_error=verify_unavailable#schoology");
r = await go(BASE, "/auth/schoology/start?domain=app.schoology.com");
check("Turnstile off: no token needed", (r.headers.get("Location") ?? "").startsWith("https://app.schoology.com/oauth/authorize"), true);
const post = (env: any, body: unknown) => go(env, "/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
r = await post(ON, { key: "demo", secret: "demo" });
check("API-key sign-in without a token: 400 verify_failed", [r.status, (await r.json()).error], [400, "verify_failed"]);
r = await post(ON, { key: "demo", secret: "demo", turnstile: "good" });
check("with a real token: goes on to the usual checks", r.status !== 400 || (await r.json()).error !== "verify_failed", true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
