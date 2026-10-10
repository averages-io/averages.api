/**
 * Canva permission probe (temporary, developer only, 2026-10-10):
 * GET /canva/connect?probe=1 and POST /canva/probe, the gates around them, and
 * that a run only ever touches the test ids it created and never returns a
 * token. Canva itself is a fake fetch. Run:
 * node --experimental-strip-types --import ./test/cf-loader.mjs test/canvaProbe.test.ts
 */
import app from "../src/index.ts";
import { sealSession } from "../src/session.ts";
import { CanvaAccount, PROBE_SCOPES, type CanvaStorage } from "../src/canva.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

const SECRET = "canva-probe-test-secret";
const ADMIN_KEY = "k".repeat(32); // >= 24 chars, as the route requires
const TOKEN = "SECRET-TOKEN-must-never-leak";
const SCOPES = ["design:content:write", "design:meta:read", "profile:read", "design:permission:read", "design:permission:write", "folder:permission:write"];

/** In-memory CanvaStorage, so the connect test runs the real beginConnect. */
function memStorage(): CanvaStorage {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k) as any,
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => m.delete(k),
    deleteAll: async () => m.clear(),
  };
}

/**
 * A CANVA Durable Object stand-in. `beginConnect` delegates to a real
 * CanvaAccount so the authorize URL carries the real scopes; `accessToken` and
 * `grantedScopes` are canned.
 */
function fakeCanva(env: Record<string, unknown>, scopes: string[] | null = SCOPES, connected = true) {
  const account = new CanvaAccount(memStorage(), env as any);
  const stub = {
    beginConnect: (returnTo: string, switches: any, probe?: boolean) => {
      if (switches) account.env = { ...account.env, ...switches };
      return account.beginConnect(returnTo, { probe });
    },
    accessToken: async () => { if (!connected) throw new Error("canva_not_connected"); return TOKEN; },
    grantedScopes: async () => scopes,
    status: async () => ({ connected, name: connected ? "Martin" : "" }),
  };
  const ns = { idFromName: (n: string) => n, get: () => stub, jurisdiction: () => ns };
  return ns;
}

/* Canva's side. */
const calls: { method: string; path: string; body: any; auth: string | null }[] = [];
let designWrites = 0;
const realFetch = globalThis.fetch;
function body(a: any, status: number) {
  return new Response(a === undefined ? null : JSON.stringify(a), { status, headers: { "Content-Type": "application/json" } });
}
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.canva.com/")) return realFetch(input, init);
  const method = init.method ?? "GET";
  const path = url.slice("https://api.canva.com/rest/v1".length);
  calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("Authorization") });
  if (method === "POST" && path === "/designs") return body({ design: { id: "DTEST" } }, 200);
  if (method === "POST" && path === "/folders") return body({ folder: { id: "FTEST" } }, 200);
  if (method === "GET" && path === "/designs/DTEST") return body({ design: { id: "DTEST", title: "t" } }, 200);
  // The design permission writes: accept the third, refuse the rest.
  if (path === "/designs/DTEST/permissions" && method !== "GET") {
    designWrites++;
    return body({ message: "guess" }, designWrites >= 3 ? 200 : 400);
  }
  // Everything else — read guesses, folder writes, other write guesses — is "not found".
  return body({ code: "not_found", message: "no such endpoint" }, 404);
}) as typeof fetch;

async function session(uid = "123") {
  return sealSession({ uid, key: "k", secret: "s", exp: Math.floor(Date.now() / 1000) + 3600 } as any, SECRET);
}

const BASE_ENV = {
  SESSION_SECRET: SECRET,
  CANVA_CLIENT_ID: "OC-x",
  CANVA_CLIENT_SECRET: "y",
  CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback",
};

async function probe(opts: { env?: Record<string, unknown>; body?: unknown; cookie?: boolean; origin?: string; contentType?: string; uid?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie !== false) headers.Cookie = `schoolagy_session=${await session(opts.uid)}`;
  if (opts.body !== undefined) headers["Content-Type"] = opts.contentType ?? "application/json";
  if (opts.origin) headers.Origin = opts.origin;
  const env = { ...BASE_ENV, CANVA: fakeCanva({ ...BASE_ENV }), CANVA_PERMISSION_PROBE: "1", SCHOOLS_ADMIN_KEY: ADMIN_KEY, ...opts.env };
  const res = await app.fetch(
    new Request("https://api.averages.io/canva/probe", { method: "POST", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
    env as any,
    { waitUntil() {}, passThroughOnException() {} } as any,
  );
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

console.log("gates");
let r = await probe({ env: { CANVA_PERMISSION_PROBE: "0" }, body: { key: ADMIN_KEY } });
check("flag off: 404", [r.status, r.json.error], [404, "not_found"]);
r = await probe({ env: { SCHOOLS_ADMIN_KEY: undefined }, body: { key: ADMIN_KEY } });
check("no admin key set: 404", [r.status, r.json.error], [404, "not_found"]);
r = await probe({ env: { SCHOOLS_ADMIN_KEY: "short" }, body: { key: "short" } });
check("admin key too short: 404", [r.status, r.json.error], [404, "not_found"]);
r = await probe({ body: { key: "k".repeat(31) + "X" } });
check("wrong key: 403", [r.status, r.json.error], [403, "forbidden"]);
r = await probe({ cookie: false, body: { key: ADMIN_KEY } });
check("no session: 401", [r.status, r.json.error], [401, "not_authenticated"]);
r = await probe({ body: { key: ADMIN_KEY }, origin: "https://evil.example" });
check("other site: 403 forbidden_origin", [r.status, r.json.error], [403, "forbidden_origin"]);
r = await probe({ body: { key: ADMIN_KEY }, contentType: "text/plain" });
check("form post refused: 415", r.status, 415);

console.log("happy path (write)");
calls.length = 0;
designWrites = 0;
r = await probe({ body: { key: ADMIN_KEY, write: true }, uid: "happy" });
check("ok", [r.status, r.json.ok], [200, true]);
check("test ids returned", [r.json.designId, r.json.folderId], ["DTEST", "FTEST"]);
check("scopes echoed from the connection", r.json.scopes, SCOPES);
const paths = calls.map((c) => `${c.method} ${c.path}`);
check("creates a test design and folder", [paths[0], paths[1]], ["POST /designs", "POST /folders"]);
check("full design read happened", paths.includes("GET /designs/DTEST"), true);
// Every call is against one of the two created ids (DTEST/FTEST) and nothing else.
const strayId = calls.filter((c) => c.path !== "/designs" && c.path !== "/folders" && !c.path.includes("DTEST") && !c.path.includes("FTEST"));
check("only ever touches the created ids", strayId.length, 0);
// Read guesses are GETs; the only writes are on the TEST design / folder.
const designWriteCalls = calls.filter((c) => c.path === "/designs/DTEST/permissions" && c.method !== "GET");
check("design writes stop at the first 2xx (3, not all 8)", designWriteCalls.length, 3);
check("no later (PATCH/PUT) design write guesses after the accepted one", calls.some((c) => (c.method === "PATCH" || c.method === "PUT") && c.path.startsWith("/designs/DTEST")), false);
check("folder write guesses still run", calls.some((c) => c.path === "/folders/FTEST/permissions" && c.method !== "GET"), true);
check("uses the student's own bearer token", calls.every((c) => c.auth === `Bearer ${TOKEN}`), true);
check("no token anywhere in the answer", JSON.stringify(r.json).includes(TOKEN), false);
check("a read guess was recorded with its status and a relative path", r.json.results.some((x: any) => x.method === "GET" && x.path === "/designs/DTEST/permissions" && x.status === 404), true);

console.log("read-only run");
calls.length = 0;
designWrites = 0;
r = await probe({ body: { key: ADMIN_KEY }, uid: "readonly" });
check("no write guesses when write is not set", calls.some((c) => c.method !== "GET" && c.path.includes("permissions")), false);

console.log("not connected");
r = await probe({ env: { CANVA: fakeCanva({ ...BASE_ENV }, null, false) }, body: { key: ADMIN_KEY }, uid: "noconn" });
check("409 canva_not_connected", [r.status, r.json.error], [409, "canva_not_connected"]);

console.log("strict rate limit (3 per 10 min per student)");
for (let i = 0; i < 3; i++) await probe({ body: { key: ADMIN_KEY }, uid: "rl" });
r = await probe({ body: { key: ADMIN_KEY }, uid: "rl" });
check("4th run refused", [r.status, r.json.error], [429, "rate_limited"]);

/* ── connect?probe=1 ──────────────────────────────────────────────── */
console.log("connect scopes");
async function connectScopes(query: string, env: Record<string, unknown>): Promise<string[]> {
  const res = await app.fetch(
    new Request(`https://api.averages.io/canva/connect${query}`, { headers: { Cookie: `schoolagy_session=${await session("connect-" + query)}` } }),
    { ...BASE_ENV, CANVA: fakeCanva({ ...BASE_ENV, ...env }), ...env } as any,
    { waitUntil() {}, passThroughOnException() {} } as any,
  );
  const loc = res.headers.get("Location") ?? "";
  const scope = new URL(loc).searchParams.get("scope") ?? "";
  return scope.split(" ");
}
let s = await connectScopes("?probe=1", { CANVA_PERMISSION_PROBE: "1" });
check("flag on + probe=1: the three scopes are added", PROBE_SCOPES.every((sc) => s.includes(sc)), true);
s = await connectScopes("", { CANVA_PERMISSION_PROBE: "1" });
check("flag on, no probe: not added", PROBE_SCOPES.some((sc) => s.includes(sc)), false);
s = await connectScopes("?probe=1", { CANVA_PERMISSION_PROBE: "0" });
check("flag off + probe=1: ignored, not added", PROBE_SCOPES.some((sc) => s.includes(sc)), false);
check("normal scopes still asked for", ["design:content:write", "design:meta:read", "profile:read"].every((sc) => s.includes(sc)), true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
