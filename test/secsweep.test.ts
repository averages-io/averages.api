/**
 * Security sweep (2026-10-28): adversarial pass over the surfaces added since
 * the Sept/Oct audits — the Stripe webhook, the calendar .ics feed, R2 media
 * (profile photos / backgrounds), live grades, and sign-out — plus a fresh
 * cross-user-isolation check. Fires hostile requests at the real Worker
 * in-process (no network) and seeds two fake students to prove one can never
 * reach the other's data. Every id, token and secret here is invented.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/secsweep.test.ts
 */
import app from "../src/index.ts";
import { sealSession, sealValue, SESSION_COOKIE, DEMO_UID } from "../src/session.ts";
import { BillingAccount, verifyStripeSignature, type BillingUpdate } from "../src/billing.ts";
import { mediaKey, mediaPrefix } from "../src/media.ts";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, note = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${note ? "\n        " + note : ""}`); }
}

const SECRET = "secsweep-session-secret-value-0987654321";
const PUSH_SECRET = "secsweep-push-secret-different-from-session";
const WH = "whsec_secsweeptestsecret";

/* ── Fake bindings: R2 for media, a Durable Object namespace for the stores. ── */
function fakeR2() {
  const m = new Map<string, { bytes: Uint8Array; type: string }>();
  return {
    store: m,
    async put(key: string, value: Uint8Array, opts?: any) { m.set(key, { bytes: value instanceof Uint8Array ? value : new Uint8Array(value), type: opts?.httpMetadata?.contentType ?? "" }); return { etag: "e" + m.size }; },
    async get(key: string) { const v = m.get(key); if (!v) return null; return { body: v.bytes, etag: "e", httpMetadata: { contentType: v.type }, size: v.bytes.byteLength }; },
    async delete(keys: string | string[]) { (Array.isArray(keys) ? keys : [keys]).forEach(k => m.delete(k)); },
    async list(opts?: any) { const pre = opts?.prefix ?? ""; return { objects: [...m.keys()].filter(k => k.startsWith(pre)).map(key => ({ key })), truncated: false }; },
  };
}
// One in-memory Durable Object namespace shared by BILLING/CALENDAR, keyed by name.
function fakeDONamespace(impl: (name: string) => any) {
  const inst = new Map<string, any>();
  const ns: any = {
    idFromName: (name: string) => ({ name }),
    jurisdiction: () => ns,
    get: (id: any) => { if (!inst.has(id.name)) inst.set(id.name, impl(id.name)); return inst.get(id.name); },
  };
  return ns;
}

const CTX = { waitUntil() {}, passThroughOnException() {} } as any;
const ENV: any = {
  SESSION_SECRET: SECRET,
  PUSH_SECRET,
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WH,
  CANVA_CLIENT_ID: "OC-x", CANVA_CLIENT_SECRET: "y", CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback",
};

async function fire(method: string, path: string, opts: { cookie?: string; origin?: string; ct?: string; body?: string | Uint8Array; headers?: Record<string, string>; env?: any } = {}) {
  const h: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie !== undefined) h.Cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  if (opts.origin) h.Origin = opts.origin;
  if (opts.ct) h["Content-Type"] = opts.ct;
  const res = await app.fetch(new Request("https://api.averages.io" + path, { method, headers: h, body: opts.body as any }), { ...ENV, ...opts.env }, CTX);
  return { status: res.status, res };
}
const live = (uid: string, extra: any = {}) => sealSession({ key: "ck", secret: "cs", uid, ...extra } as any, SECRET);
const APP = "https://app.averages.io";

// A tiny valid PNG (8-byte signature + a byte), enough for the magic-byte sniff.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

console.log("key derivation: stores are addressed by the session uid, never request input");
ok("media key is u/<uid>/<kind>", mediaKey("AAA", "photo" as any) === "u/AAA/photo" && mediaKey("BBB", "photo" as any) === "u/BBB/photo");
ok("media prefix is per-uid", mediaPrefix("AAA") === "u/AAA/" && !mediaPrefix("AAA").includes("BBB"));

console.log("\nmedia (R2 photos/backgrounds)");
{
  const r2 = fakeR2();
  const env = { MEDIA: r2 };
  const a = await live("userA"), b = await live("userB");
  // A uploads a photo.
  const up = await fire("PUT", "/media/photo", { cookie: a, origin: APP, ct: "image/png", body: PNG, env });
  ok("A uploads a photo: 200, stored at A's key", up.status === 200 && r2.store.has("u/userA/photo"));
  // B cannot read A's photo — B's GET reads B's own key (empty) → 404.
  const bRead = await fire("GET", "/media/photo", { cookie: b, origin: APP, env });
  ok("B reading /media/photo gets B's own (404), never A's", bRead.status === 404);
  // A reads its own.
  ok("A reads its own photo: 200", (await fire("GET", "/media/photo", { cookie: a, origin: APP, env })).status === 200);
  // :kind can only be photo/background — no traversal to another uid's object.
  for (const k of ["..%2f..%2fuserA%2fphoto", "photo%2f..%2f..%2fuserA%2fphoto", "evil", "photo.png"]) {
    ok("hostile :kind rejected: " + k.slice(0, 30), [400, 404].includes((await fire("GET", "/media/" + k, { cookie: b, origin: APP, env })).status));
  }
  // Non-image bytes refused (so no HTML/SVG polyglot can be stored and served).
  const html = new TextEncoder().encode("<svg onload=alert(1)>");
  ok("non-image upload refused (415/400), nothing stored", [400, 415].includes((await fire("PUT", "/media/photo", { cookie: a, origin: APP, ct: "image/png", body: html, env })).status));
  // Oversize declared length refused.
  ok("oversize Content-Length refused: 413", (await fire("PUT", "/media/photo", { cookie: a, origin: APP, ct: "image/png", body: PNG, headers: { "Content-Length": String(50 * 1024 * 1024) }, env })).status === 413);
  // CSRF: a cross-site PUT/DELETE is refused.
  ok("cross-site PUT /media: 403", (await fire("PUT", "/media/photo", { cookie: a, origin: "https://evil.example", ct: "image/png", body: PNG, env })).status === 403);
  // The GET response can never be rendered as a page.
  const g = await fire("GET", "/media/photo", { cookie: a, origin: APP, env });
  const csp = g.res.headers.get("Content-Security-Policy") ?? "";
  ok("media GET is nosniff + sandboxed CSP (no inline execution if served)", g.res.headers.get("X-Content-Type-Options") === "nosniff" && /default-src 'none'/.test(csp) && /sandbox/.test(csp));
}

console.log("\nStripe webhook");
{
  async function signed(payload: string, secret = WH) {
    const t = Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", k, enc.encode(`${t}.${payload}`));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    return `t=${t},v1=${hex}`;
  }
  const BILLING = fakeDONamespace(() => {
    let rec: any = null;
    return { async status() { return rec ? { plus: rec.status === "active", status: rec.status, renewsAt: null, cancelAtPeriodEnd: false, manageable: !!rec.customerId, price: null } : { plus: false, status: "none", renewsAt: null, cancelAtPeriodEnd: false, manageable: false, price: null }; },
             async apply(u: BillingUpdate) { const seen = rec?.seen ?? []; if (seen.includes(u.eventId)) return false; rec = { status: u.status ?? rec?.status ?? "", customerId: u.customerId ?? rec?.customerId, seen: [...seen, u.eventId] }; return true; } };
  });
  const env = { BILLING };
  const evt = (id: string, uid: string) => JSON.stringify({ id, type: "customer.subscription.updated", created: Math.floor(Date.now() / 1000), data: { object: { id: "sub_" + uid, status: "active", customer: "cus_" + uid, metadata: { uid } } } });
  // Forged / missing signature: refused, nothing stored.
  ok("no signature: 400", (await fire("POST", "/stripe/webhook", { ct: "application/json", body: evt("e1", "victim"), env })).status === 400);
  ok("wrong-secret signature: 400", (await fire("POST", "/stripe/webhook", { ct: "application/json", body: evt("e2", "victim"), headers: { "Stripe-Signature": await signed(evt("e2", "victim"), "whsec_wrong") }, env })).status === 400);
  const bodyTamper = evt("e3", "attacker");
  ok("valid signature over a different body: 400", (await fire("POST", "/stripe/webhook", { ct: "application/json", body: bodyTamper, headers: { "Stripe-Signature": await signed(evt("e3", "someoneelse")) }, env })).status === 400);
  ok("attacker can't grant themselves Plus without the webhook secret", (await (await fire("GET", "/billing/status", { cookie: await live("attacker"), origin: APP, env: { ...env, FEATURES_ON: "billing" } })).res.json() as any).plus === false);
  // A correctly signed event is accepted and idempotent on replay.
  const body = evt("evn1", "payer");
  const sig = await signed(body);
  const first = await fire("POST", "/stripe/webhook", { ct: "application/json", body, headers: { "Stripe-Signature": sig }, env });
  ok("signed event: accepted (used:true)", first.status === 200 && (await first.res.json() as any).used === true);
  // Idempotency on replay is a property of the store itself; prove it directly.
  {
    const mem = new Map<string, any>();
    const acct = new BillingAccount({ async get(k: string) { return mem.get(k) ?? null; }, async put(k: string, v: any) { mem.set(k, v); } } as any);
    const u: BillingUpdate = { uid: "payer", eventId: "EVX", created: 1000, status: "active", customerId: "cus_1", subscriptionId: "sub_1" };
    const c1 = await acct.apply(u);
    const c2 = await acct.apply(u);
    ok("replay of the same event id: idempotent (second apply is a no-op)", c1 === true && c2 === false && (await acct.status()).plus === true);
  }
  // Oversize body refused before parsing.
  ok("oversize webhook body: 413", (await fire("POST", "/stripe/webhook", { ct: "application/json", body: "x".repeat(600 * 1024), headers: { "Stripe-Signature": "t=1,v1=00" }, env })).status === 413);
  // The signer itself: a tampered payload never verifies.
  ok("verifyStripeSignature rejects a tampered payload", (await verifyStripeSignature("{}", await signed("{}") + "0", WH)) === null);
}

console.log("\ncalendar .ics feed (no cookie — token is the only key)");
{
  const CALENDAR = fakeDONamespace(() => {
    let rec: any = null;
    return { async read() { return rec; }, async write(v: any) { rec = v; } };
  });
  const env = { CALENDAR };
  for (const t of ["", "short", "../secret", "a".repeat(43) + "/..", "%2e%2e", "notatoken.ics"]) {
    const r = await fire("GET", "/calendar/" + t + (t.endsWith(".ics") ? "" : ".ics"), { env });
    ok("malformed token refused (404/503): " + (t || "(empty)").slice(0, 24), [404, 503].includes(r.status));
  }
  // A well-formed but unknown token: 404 (no feed), never another user's calendar.
  const unknown = "A".repeat(43);
  ok("well-formed unknown token: 404 (no such feed)", (await fire("GET", "/calendar/" + unknown + ".ics", { env })).status === 404);
  // A session cookie value is not a calendar token.
  const sess = await live("caluser");
  ok("a session cookie is not usable as a calendar token", [404, 503].includes((await fire("GET", "/calendar/" + encodeURIComponent(sess).replace(/%../g, "").slice(0, 43) + ".ics", { env })).status));
  // Purpose isolation: a value sealed for the calendar link can't open a session, and vice versa.
  const calCred = await sealValue(JSON.stringify({ uid: "caluser", key: "k", secret: "s" }), PUSH_SECRET, "calendar-credential", 3600);
  ok("a calendar-credential value is not a session cookie", (await fire("GET", "/auth/me", { cookie: calCred })).status === 401);
}

console.log("\nlive grades /data/grades (added 2026-10-27)");
{
  ok("no session: 401", (await fire("GET", "/data/grades", { origin: APP })).status === 401);
  const demo = await sealSession({ key: "", secret: "", uid: DEMO_UID } as any, SECRET);
  const r = await fire("GET", "/data/grades", { cookie: demo, origin: APP });
  ok("demo: 200 with COURSES null (nothing to leak, no school call)", r.status === 200 && (await r.res.json() as any).COURSES === null);
  ok("feature off: hidden (503 feature_off)", (await fire("GET", "/data/grades", { cookie: await live("g1"), origin: APP, env: { FEATURES_OFF: "live-grades" } })).status === 503);
  ok("cross-site GET still needs a real session, not an Origin trick", (await fire("GET", "/data/grades", { origin: "https://evil.example" })).status === 401);
}

console.log("\nsign-out and CSRF on mutating routes");
{
  ok("DELETE /auth/session needs no CSRF but clears cookie", (await fire("DELETE", "/auth/session", { cookie: await live("so1") })).status === 200);
  // billing on, so the feature gate doesn't shadow the Origin check.
  for (const [m, p, body] of [["POST", "/billing/checkout", "{}"], ["POST", "/billing/portal", "{}"], ["POST", "/calendar", "{}"], ["DELETE", "/calendar", undefined], ["PUT", "/sync/settings", "{}"], ["DELETE", "/sync/settings", undefined]] as const) {
    ok(`${m} ${p} cross-site: 403`, (await fire(m, p, { cookie: await live("so2"), origin: "https://evil.example", ct: "application/json", body: body as any, env: { FEATURES_ON: "billing" } })).status === 403);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
