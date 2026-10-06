/**
 * GET /canva/status's `turnIn` (2026-10-06): can this Canva connection turn
 * in designs as PDFs? Run:
 * node --experimental-strip-types --import ./test/cf-loader.mjs test/canvastatus.test.ts
 */
import app from "../src/index.ts";
import { sealSession } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}
const SECRET = "canva-status-test-secret";
function fakeCanva(state: { connected: boolean; scopes: string[] | null }) {
  const stub = {
    status: async () => ({ connected: state.connected, name: state.connected ? "Sam" : "" }),
    grantedScopes: async () => state.scopes,
  };
  const ns = { idFromName: (n: string) => n, get: () => stub, jurisdiction: () => ns };
  return ns;
}
async function status(env: Record<string, unknown>) {
  const token = await sealSession({ uid: "123", key: "k", secret: "s", exp: Math.floor(Date.now() / 1000) + 3600 } as any, SECRET);
  const res = await app.fetch(
    new Request("https://api.averages.io/canva/status", { headers: { Cookie: `schoolagy_session=${token}` } }),
    { SESSION_SECRET: SECRET, CANVA_CLIENT_ID: "OC-x", CANVA_CLIENT_SECRET: "y", CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback", ...env } as any,
    { waitUntil() {}, passThroughOnException() {} } as any
  );
  return (await res.json()) as any;
}
const OLD = ["design:content:write", "design:meta:read", "profile:read"];
check("export off: off", (await status({ CANVA: fakeCanva({ connected: true, scopes: OLD }), CANVA_EXPORT_ENABLED: "0" })).turnIn, "off");
check("on, old connection: reconnect", (await status({ CANVA: fakeCanva({ connected: true, scopes: OLD }), CANVA_EXPORT_ENABLED: "1" })).turnIn, "reconnect");
check("on, new connection: ready", (await status({ CANVA: fakeCanva({ connected: true, scopes: [...OLD, "design:content:read"] }), CANVA_EXPORT_ENABLED: "1" })).turnIn, "ready");
check("on, scopes unknown: ready (Canva decides)", (await status({ CANVA: fakeCanva({ connected: true, scopes: null }), CANVA_EXPORT_ENABLED: "1" })).turnIn, "ready");
check("on, not connected: off", (await status({ CANVA: fakeCanva({ connected: false, scopes: null }), CANVA_EXPORT_ENABLED: "1" })).turnIn, "off");
const full = await status({ CANVA: fakeCanva({ connected: true, scopes: OLD }), CANVA_EXPORT_ENABLED: "1" });
check("rest of the answer unchanged", [full.configured, full.connected, full.name], [true, true, "Sam"]);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
