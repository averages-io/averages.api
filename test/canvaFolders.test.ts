/**
 * Canva folders on the Files page (2026-10-06): the routes in
 * src/canvaFolders.ts, the switch, the scope check and GET /canva/status's
 * `folders`. Canva itself is a fake fetch. Run:
 * node --experimental-strip-types --import ./test/cf-loader.mjs test/canvaFolders.test.ts
 */
import app from "../src/index.ts";
import { sealSession } from "../src/session.ts";
import { adaptFolderItems, cleanFolderName, folderFailure } from "../src/canvaFolders.ts";
import { canvaScopes } from "../src/canva.ts";
import { ruleFor } from "../src/rateLimit.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

const SECRET = "canva-folders-test-secret";
const OLD = ["design:content:write", "design:meta:read", "profile:read"];
const NEW = [...OLD, "folder:read", "folder:write"];

function fakeCanva(state: { connected: boolean; scopes: string[] | null; asked: string[] }) {
  const stub = {
    status: async () => ({ connected: state.connected, name: state.connected ? "Sam" : "" }),
    grantedScopes: async () => state.scopes,
    accessTokenWithScope: async (_uid: string, scope: string) => {
      state.asked.push(scope);
      if (!state.connected) throw new Error("canva_not_connected");
      if (state.scopes && !state.scopes.includes(scope)) throw new Error("canva_reconnect_needed");
      return "TOKEN";
    },
  };
  const ns = { idFromName: (n: string) => n, get: () => stub, jurisdiction: () => ns };
  return ns;
}

// Canva's side.
const calls: { method: string; url: string; body: any; auth: string | null }[] = [];
let nextAnswer: { status: number; body?: any } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.canva.com/")) return realFetch(input, init);
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ method: init.method ?? "GET", url, body, auth: new Headers(init.headers).get("Authorization") });
  if (nextAnswer) {
    const a = nextAnswer;
    nextAnswer = null;
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("/folders/move")) return new Response(null, { status: 204 });
  if ((init.method ?? "GET") === "POST" && url.endsWith("/folders")) {
    return Response.json({ folder: { id: "FNEW1", name: body.name, created_at: 1700000000, updated_at: 1700000000 } });
  }
  if ((init.method ?? "GET") === "PATCH") return Response.json({ folder: { id: "F1", name: body.name, updated_at: 1700000000 } });
  return Response.json({
    items: [
      { type: "folder", folder: { id: "F1", name: "Science", updated_at: 1700000100, thumbnail: { url: "https://document-export.canva.com/t1.png" } } },
      { type: "design", design: { id: "D1", title: "Lab poster", updated_at: 1700000200, thumbnail: { url: "https://document-export.canva.com/t2.png" } } },
      { type: "image", image: { id: "I1", name: "photo.jpg", updated_at: 1700000300 } },
      { type: "folder", folder: { id: "bad id!", name: "x" } },
    ],
    continuation: "NEXT1",
  });
}) as typeof fetch;

async function call(path: string, opts: { method?: string; body?: unknown; env?: Record<string, unknown>; state?: any; origin?: string; contentType?: string } = {}) {
  const token = await sealSession({ uid: "123", key: "k", secret: "s", exp: Math.floor(Date.now() / 1000) + 3600 } as any, SECRET);
  const state = opts.state ?? { connected: true, scopes: NEW, asked: [] };
  const headers: Record<string, string> = { Cookie: `schoolagy_session=${token}` };
  if (opts.body !== undefined) headers["Content-Type"] = opts.contentType ?? "application/json";
  if (opts.origin) headers.Origin = opts.origin;
  const res = await app.fetch(
    new Request("https://api.averages.io" + path, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
    { SESSION_SECRET: SECRET, CANVA_CLIENT_ID: "OC-x", CANVA_CLIENT_SECRET: "y", CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback", CANVA: fakeCanva(state), CANVA_FOLDERS_ENABLED: "1", ...opts.env } as any,
    { waitUntil() {}, passThroughOnException() {} } as any
  );
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, state };
}

console.log("pure helpers");
check("folder name trimmed and line breaks folded", cleanFolderName("  Lab\nReports  "), "Lab Reports");
check("empty name refused", cleanFolderName("   "), null);
check("256 characters refused", cleanFolderName("x".repeat(256)), null);
check("255 characters kept", cleanFolderName("x".repeat(255))?.length, 255);
check("non-string refused", cleanFolderName(42), null);
const adapted = adaptFolderItems({ items: [
  { type: "folder", folder: { id: "F1", name: "", updated_at: 1700000000 } },
  { type: "design", design: { id: "D1", title: "T", updated_at: 1700000000123 } },
  { type: "image", image: { id: "I1" } },
], continuation: "a b" });
check("images skipped, empty folder name filled, seconds to ms, ms kept", adapted.items.map((i) => [i.type, i.id, i.name, i.updatedAt]), [["folder", "F1", "Untitled folder", 1700000000000], ["design", "D1", "T", 1700000000123]]);
check("odd continuation dropped", adapted.continuation, undefined);
check("scopes: off", canvaScopes({}), "design:content:write design:meta:read profile:read");
check("scopes: folders on", canvaScopes({ CANVA_FOLDERS_ENABLED: "1" }), "design:content:write design:meta:read profile:read folder:read folder:write");
check("scopes: both on", canvaScopes({ CANVA_FOLDERS_ENABLED: "1", CANVA_EXPORT_ENABLED: "1" }), "design:content:write design:meta:read profile:read design:content:read folder:read folder:write");
check("failure: in several folders", folderFailure(new Response(null, { status: 400 }), { code: "item_in_multiple_folders" }).message, "canva_item_in_multiple_folders");
check("failure: 403 not allowed", folderFailure(new Response(null, { status: 403 }), {}).message, "canva_folder_not_allowed");
check("failure: 401 reconnect", folderFailure(new Response(null, { status: 401 }), {}).message, "canva_reconnect_needed");
check("failure: 404 gone", folderFailure(new Response(null, { status: 404 }), { code: "folder_not_found" }).message, "canva_folder_gone");
check("rate rule: browsing", ruleFor("GET", "/canva/folders/root/items")?.name, "canvaBrowse");
check("rate rule: writes count as canva", ruleFor("POST", "/canva/folders/move")?.name, "canva");

console.log("listing");
let r = await call("/canva/folders/root/items");
check("root lists folders and designs", [r.status, r.json.connected, r.json.items.map((i: any) => [i.type, i.id, i.name])], [200, true, [["folder", "F1", "Science"], ["design", "D1", "Lab poster"]]]);
check("continuation passed back", r.json.continuation, "NEXT1");
check("asks Canva for designs and folders, newest first", decodeURIComponent(calls.at(-1)!.url).includes("/folders/root/items?item_types=design,folder&sort_by=modified_descending&limit=100"), true);
check("with the student's token, read scope", [calls.at(-1)!.auth, r.state.asked], ["Bearer TOKEN", ["folder:read"]]);
r = await call("/canva/folders/F1/items?continuation=NEXT1");
check("a folder's next page", [r.status, calls.at(-1)!.url.includes("/folders/F1/items?") && calls.at(-1)!.url.includes("continuation=NEXT1")], [200, true]);
r = await call("/canva/folders/..%2Fusers/items");
check("odd folder id refused", r.status === 400 || r.status === 404, true);
r = await call("/canva/folders/F1/items?continuation=%3Cx%3E");
check("odd continuation refused", r.status, 400);
const before = calls.length;
r = await call("/canva/folders/root/items", { env: { CANVA_FOLDERS_ENABLED: "0" } });
check("switch off: reconnect, Canva not called", [r.status, r.json.error, calls.length - before], [409, "canva_reconnect_needed", 0]);
r = await call("/canva/folders/root/items", { state: { connected: true, scopes: OLD, asked: [] } });
check("old connection: reconnect", [r.status, r.json.error], [409, "canva_reconnect_needed"]);
r = await call("/canva/folders/root/items", { state: { connected: false, scopes: null, asked: [] } });
check("not connected", [r.status, r.json.connected], [200, false]);
nextAnswer = { status: 429, body: { code: "too_many_requests" } };
r = await call("/canva/folders/root/items");
check("Canva busy: 429", [r.status, r.json.error], [429, "canva_rate_limited"]);

console.log("new folder");
r = await call("/canva/folders", { method: "POST", body: { name: " Lab  Reports ", parentId: "root" } });
check("made, name cleaned", [r.status, r.json.folder.id, r.json.folder.name], [200, "FNEW1", "Lab Reports"]);
check("Canva got parent_folder_id", calls.at(-1)!.body, { name: "Lab Reports", parent_folder_id: "root" });
check("write scope", r.state.asked, ["folder:write"]);
r = await call("/canva/folders", { method: "POST", body: { name: "", parentId: "root" } });
check("empty name: 400", r.status, 400);
r = await call("/canva/folders", { method: "POST", body: { name: "x", parentId: "uploads" } });
check("not into Uploads", r.status, 400);
r = await call("/canva/folders", { method: "POST", body: { name: "x", parentId: "root" }, origin: "https://evil.example" });
check("other site refused", [r.status, r.json.error], [403, "forbidden_origin"]);
r = await call("/canva/folders", { method: "POST", body: { name: "x", parentId: "root" }, contentType: "text/plain" });
check("form post refused", r.status, 415);

console.log("rename");
r = await call("/canva/folders/F1/rename", { method: "POST", body: { name: "Chemistry" } });
check("renamed with PATCH", [r.status, r.json.folder.name, calls.at(-1)!.method, calls.at(-1)!.url.endsWith("/folders/F1")], [200, "Chemistry", "PATCH", true]);
r = await call("/canva/folders/root/rename", { method: "POST", body: { name: "x" } });
check("Projects itself can't be renamed", r.status, 400);
nextAnswer = { status: 403, body: { code: "permission_denied" } };
r = await call("/canva/folders/F1/rename", { method: "POST", body: { name: "x" } });
check("Canva says no: 403", [r.status, r.json.error], [403, "canva_folder_not_allowed"]);

console.log("move");
r = await call("/canva/folders/move", { method: "POST", body: { itemId: "D1", toFolderId: "F1" } });
check("moved", [r.status, r.json.ok, calls.at(-1)!.body], [200, true, { to_folder_id: "F1", item_id: "D1" }]);
r = await call("/canva/folders/move", { method: "POST", body: { itemId: "D1", toFolderId: "root" } });
check("back to the top", r.status, 200);
r = await call("/canva/folders/move", { method: "POST", body: { itemId: "F1", toFolderId: "F1" } });
check("into itself refused", r.status, 400);
r = await call("/canva/folders/move", { method: "POST", body: { itemId: "D1", toFolderId: "uploads" } });
check("into Uploads refused", r.status, 400);
nextAnswer = { status: 400, body: { code: "item_in_multiple_folders" } };
r = await call("/canva/folders/move", { method: "POST", body: { itemId: "D1", toFolderId: "F1" } });
check("in several folders: Canva only", [r.status, r.json.error], [409, "canva_item_in_multiple_folders"]);

console.log("status");
const st = async (env: Record<string, unknown>, scopes: string[] | null, connected = true) =>
  (await call("/canva/status", { env, state: { connected, scopes, asked: [] } })).json;
check("off by default", (await st({ CANVA_FOLDERS_ENABLED: "0" }, NEW)).folders, "off");
check("on, old connection: reconnect", (await st({}, OLD)).folders, "reconnect");
check("on, new connection: ready", (await st({}, NEW)).folders, "ready");
check("on, scopes unknown: ready", (await st({}, null)).folders, "ready");
check("on, only read granted: reconnect", (await st({}, [...OLD, "folder:read"])).folders, "reconnect");
check("turnIn still worked out on its own", [(await st({ CANVA_EXPORT_ENABLED: "1" }, NEW)).turnIn, (await st({ CANVA_EXPORT_ENABLED: "1" }, NEW)).folders], ["reconnect", "ready"]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
