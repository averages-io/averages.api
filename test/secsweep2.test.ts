// Security sweep, 2026-11-23: the surfaces added since the 11-09 IDOR pass (classmate photos, the email code
// popup, Turnstile, the Plus cache, link previews), plus two checks that cover every route at once so a new one
// can't quietly skip them:
//   1. every POST / PUT / DELETE refuses another site (Origin), with a real session;
//   2. every signed-in route counts against a rate limit.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/secsweep2.test.ts
import app from "../src/index.ts";
import { sealSession, sealValue, SESSION_COOKIE } from "../src/session.ts";
import { ruleFor } from "../src/rateLimit.ts";
import { codeHash, EMAIL_CODE_PURPOSE, EMAIL_CODE_TTL } from "../src/emailCode.ts";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, note = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? "\n        " + note : ""}`); }
}

const SECRET = "secsweep2-session-secret-0123456789abcdef";
const CTX = { waitUntil() {}, passThroughOnException() {} } as any;
const APP = "https://app.averages.io", EVIL = "https://evil.example";
// Nothing in here may reach the network: any outside call answers 599.
let outside = 0;
globalThis.fetch = (async () => { outside++; return new Response("{}", { status: 599 }); }) as any;

const ENV: any = {
  SESSION_SECRET: SECRET,
  FEATURES_ON: "billing,schoology-oauth,canva-export,canva-folders,canva-save",
  CANVA_CLIENT_ID: "OC-x", CANVA_CLIENT_SECRET: "y", CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback",
};
const cookieFor = async (uid: string) => `${SESSION_COOKIE}=${await sealSession({ key: "ck", secret: "cs", uid } as any, SECRET)}`;
async function call(method: string, path: string, o: { cookie?: string; origin?: string; json?: unknown; env?: any } = {}) {
  const h: Record<string, string> = {};
  if (o.cookie) h.Cookie = o.cookie;
  if (o.origin) h.Origin = o.origin;
  if (o.json !== undefined) h["Content-Type"] = "application/json";
  const res = await app.fetch(new Request("https://api.averages.io" + path, { method, headers: h, body: o.json === undefined ? undefined : JSON.stringify(o.json) }), { ...ENV, ...o.env }, CTX);
  let data: any = null;
  try { data = await res.clone().json(); } catch { /* not JSON */ }
  return { status: res.status, data, res };
}

/* ── Every route, read from the source, so a new one is covered the day it's added ── */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const MOUNT: Record<string, string> = { "push.ts": "/push", "billingRoutes.ts": "/billing", "calendar.ts": "/calendar", "media.ts": "/media", "submitRoutes.ts": "/submit", "canvaExport.ts": "/canva", "canvaFolders.ts": "/canva" };
const routes: [string, string][] = [];
for (const f of readdirSync(SRC)) {
  if (!f.endsWith(".ts")) continue;
  const text = readFileSync(SRC + f, "utf8");
  // extrasRoutes.ts holds two routers: /data first, then /messages (from messagesRoutes on)
  const split = f === "extrasRoutes.ts" ? text.indexOf("export function messagesRoutes") : -1;
  for (const m of text.matchAll(/app\.(get|post|put|delete|patch)\("([^"]+)"/g)) {
    let pre = f === "index.ts" ? "" : f === "extrasRoutes.ts" ? ((m.index ?? 0) > split ? "/messages" : "/data") : MOUNT[f];
    if (f === "billingRoutes.ts" && m[2] === "/webhook") pre = "/stripe";
    if (pre === undefined) { ok(`route file ${f} is mapped to where it's mounted`, false, m[2]); continue; }
    routes.push([m[1].toUpperCase(), pre + (m[2] === "/" && pre ? "" : m[2])]);
  }
}
const fill = (p: string) => p.replace(":kind", "photo").replace(":app", "gdrive").replace(/:[a-z]+/g, "x1");
ok("found the routes (more than 90)", routes.length > 90, String(routes.length));

console.log("\n1. every POST / PUT / DELETE refuses another site, with a real session");
{
  const cookie = await cookieFor("777");
  // On purpose: sign-out works from anywhere (it only ends your own session); Stripe's webhook is server to server
  // (its signature is the check); the Canva probe exists only while testing locally (404 everywhere else).
  const ALLOWED = new Set(["DELETE /auth/session", "POST /stripe/webhook", "POST /canva/probe"]);
  const open: string[] = [];
  for (const [m, p] of routes) {
    if (m === "GET" || ALLOWED.has(`${m} ${p}`)) continue;
    const r = await call(m, fill(p), { cookie, origin: EVIL, json: m === "DELETE" ? undefined : {} });
    if (r.status !== 403) open.push(`${r.status} ${m} ${p}`);
  }
  ok("all refused with 403", open.length === 0, open.join("\n        "));
  const r = await call("DELETE", "/auth/session", { cookie, origin: EVIL });
  ok("sign-out from another site only ends that session (cookie cleared)", r.status === 200 && (r.res.headers.get("Set-Cookie") ?? "").includes("Max-Age=0"));
}

console.log("\n2. every signed-in route counts against a rate limit");
{
  // Public or server-to-server: the health page, public config, the sign-in page's own status, sign-out, Stripe.
  const PUBLIC = new Set(["GET /", "GET /status", "GET /config/schools", "GET /config/cloud", "GET /config/features", "GET /push/config", "GET /auth/schoology/status", "GET /auth/schoology/sandbox-authorize", "DELETE /auth/session", "POST /stripe/webhook"]);
  const none = routes.filter(([m, p]) => !ruleFor(m, fill(p)) && !PUBLIC.has(`${m} ${p}`)).map(([m, p]) => `${m} ${p}`);
  ok("none left out", none.length === 0, none.join(", "));
  ok("the ones that call other services have their own: links, Stripe's suggested email, the DNS email check", [ruleFor("GET", "/links/preview")?.name, ruleFor("GET", "/links/image")?.name, ruleFor("GET", "/email/suggested")?.name, ruleFor("POST", "/email/check")?.name].join() === "links,links,billing,data");
}

console.log("\n3. the email code (onboarding / Settings verify popup)");
{
  const a = await cookieFor("1001"), b = await cookieFor("1002");
  const tokenFor = async (uid: string, email: string, code: string) => sealValue({ u: uid, e: email, h: await codeHash(SECRET, uid, email, code) }, SECRET, EMAIL_CODE_PURPOSE, EMAIL_CODE_TTL);
  const t = await tokenFor("1001", "kid@example.com", "123456");
  const verify = (cookie: string, body: any, origin = APP) => call("POST", "/email/verify", { cookie, origin, json: body });
  ok("the right code, for the student it was sent to: ok", (await verify(a, { email: "kid@example.com", code: "123456", token: t })).status === 200);
  ok("a wrong code: refused", (await verify(a, { email: "kid@example.com", code: "654321", token: t })).data?.error === "wrong_code");
  ok("another student with the same token and code: refused", (await verify(b, { email: "kid@example.com", code: "123456", token: t })).data?.error === "code_expired");
  ok("the same token for another address: refused", (await verify(a, { email: "other@example.com", code: "123456", token: t })).data?.error === "code_expired");
  ok("a token changed by one character: refused", (await verify(a, { email: "kid@example.com", code: "123456", token: t.slice(0, -2) + (t.endsWith("A") ? "B" : "A") + t.slice(-1) })).data?.error === "code_expired");
  const other = await sealValue({ u: "1001", e: "kid@example.com", h: await codeHash(SECRET, "1001", "kid@example.com", "123456") }, SECRET, "session-profile", 600);
  ok("a value sealed for another purpose: refused", (await verify(a, { email: "kid@example.com", code: "123456", token: other })).data?.error === "code_expired");
  ok("not a 6-digit code: 400 before anything is checked", (await verify(a, { email: "kid@example.com", code: "12345a", token: t })).status === 400);
  ok("from another site: 403 (2026-11-23)", (await verify(a, { email: "kid@example.com", code: "123456", token: t }, EVIL)).status === 403);
  ok("asking for a code from another site: 403, nothing sent", (await call("POST", "/email/code", { cookie: a, origin: EVIL, json: { email: "kid@example.com" } })).status === 403);
  ok("the address check from another site: 403", (await call("POST", "/email/check", { cookie: a, origin: EVIL, json: { email: "kid@example.com" } })).status === 403);
  ok("guessing is slow: 20 tries per student per 10 minutes", ruleFor("POST", "/email/verify")?.limit === 20 && ruleFor("POST", "/email/verify")?.windowMs === 600000 && ruleFor("POST", "/email/verify")?.by === "student");
}

console.log("\n4. classmate photos: the address only works for whom it was made");
{
  const photos = readFileSync(SRC + "media.ts", "utf8");
  ok("a classmate's photo is kept by the browser an hour at most (sharing turned off reaches them soon)", /c\.header\("Cache-Control", "private, max-age=3600"\)/.test(photos) && !/max-age=604800/.test(photos));
  const viewer = await cookieFor("2001");
  for (const q of ["", "?v=e1&e=9999999999&s=" + "0".repeat(32), "?v=e1&e=abc&s=x", "?v=..%2F..%2Fu%2F2002%2Fphoto&e=1&s=1"]) {
    ok("made-up or broken address: 404 " + (q.slice(0, 24) || "(none)"), (await call("GET", "/media/peer/2002" + q, { cookie: viewer, origin: APP, env: { MEDIA: { get: async () => null, head: async () => null, list: async () => ({ objects: [] }) } } })).status === 404);
  }
  ok("no session: 401", (await call("GET", "/media/peer/2002?v=e1&e=1&s=1", { origin: APP })).status === 401);
}

console.log("\n5. nothing above reached the network");
ok("no outside calls", outside === 0, String(outside));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
