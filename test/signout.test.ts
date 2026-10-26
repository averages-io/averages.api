/**
 * Signing out with ?forget=1 (2026-10-13): the app sends it when Sync Across
 * Devices is off, and the API then disconnects Canva, Google Drive and
 * OneDrive for that student too. Plain sign-out leaves them alone.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/signout.test.ts
 */
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { DEMO_UID, sealSession, SESSION_COOKIE } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`network call during the sign-out test: ${String(input)}`);
}) as typeof fetch;

/** Durable Object namespaces that record which student's store was asked to disconnect what. */
let calls: string[] = [];
let canvaBroken = false;
function ns(kind: "canva" | "cloud") {
  const n: any = {
    jurisdiction: () => n,
    idFromName: (name: string) => name,
    get: (id: string) => ({
      async disconnect(uid?: string, app?: string, opts?: { revokeShared?: boolean }) {
        if (kind === "canva" && canvaBroken) throw new Error("Canva store down");
        calls.push(kind === "canva" ? `canva ${id}` : `${app} ${id} (uid ${uid})${opts?.revokeShared ? " revoke" : ""}`);
      },
    }),
  };
  return n;
}

const SECRET = "signout-test-session-secret";
const ENV: any = { SESSION_SECRET: SECRET, CANVA: ns("canva"), CLOUD: ns("cloud") };
let waits: Promise<unknown>[] = [];
const CTX: any = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} };
const API = "https://api.averages.io";
const APP = "https://app.averages.io";
const CREDS = { key: "abcdef0123456789abcdef0123456789", secret: "0123456789abcdef0123456789abcdef" };
const martin = `${SESSION_COOKIE}=${await sealSession({ ...CREDS, uid: "4242" }, SECRET)}`;
const demo = `${SESSION_COOKIE}=${await sealSession({ key: "", secret: "", uid: DEMO_UID }, SECRET)}`;

async function signOut(query: string, cookie?: string, origin = APP, env = ENV) {
  resetRateLimits();
  calls = [];
  waits = [];
  const headers = new Headers({ Origin: origin });
  if (cookie) headers.set("Cookie", cookie);
  const res = await worker.fetch(new Request(`${API}/auth/session${query}`, { method: "DELETE", headers }), env, CTX);
  await Promise.allSettled(waits);
  const cookies: string[] = (res.headers as any).getSetCookie?.() ?? [];
  return { status: res.status, calls: [...calls].sort(), clearsSession: cookies.some((c) => c.startsWith(SESSION_COOKIE + "=;")) };
}

console.log("sign-out with Sync off (?forget=1)");
{
  const r = await signOut("?forget=1", martin);
  check("200 and the session cookie cleared", [r.status, r.clearsSession], [200, true]);
  check("Canva, Google Drive and OneDrive all disconnected, for this student, Google's grant revoked too", r.calls, ["canva 4242", "gdrive 4242 (uid 4242) revoke", "onedrive 4242 (uid 4242) revoke"]);
}
{
  canvaBroken = true;
  const r = await signOut("?forget=1", martin);
  canvaBroken = false;
  check("Canva failing doesn't stop Drive and OneDrive, or the sign-out", [r.status, r.clearsSession, r.calls], [200, true, ["gdrive 4242 (uid 4242) revoke", "onedrive 4242 (uid 4242) revoke"]]);
}
{
  const r = await signOut("?forget=1", martin, APP, { SESSION_SECRET: SECRET });
  check("no Canva or Cloud stores configured: still signs out", [r.status, r.clearsSession, r.calls], [200, true, []]);
}

console.log("\nplain sign-out (Sync on)");
{
  const r = await signOut("", martin);
  check("signs out, connections kept (the account keeps them)", [r.status, r.clearsSession, r.calls], [200, true, []]);
  const other = await signOut("?forget=0", martin);
  check("anything but forget=1 is a plain sign-out", other.calls, []);
}

console.log("\nrefusals and edges");
{
  const r = await signOut("?forget=1", martin, "https://evil.example");
  check("another site can't make it forget (403, nothing touched)", [r.status, r.calls, r.clearsSession], [403, [], false]);
  const plain = await signOut("", martin, "https://evil.example");
  check("plain sign-out from anywhere still works as before", plain.status, 200);
  const none = await signOut("?forget=1");
  check("no session: just clears cookies", [none.status, none.calls], [200, []]);
  const d = await signOut("?forget=1", demo);
  check("demo: nothing to disconnect", [d.status, d.calls], [200, []]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
