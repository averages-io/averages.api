/**
 * Averages Plus perks (2026-10-21): notifications need Plus while billing is
 * on (src/push.ts, src/pushStore.ts), the calendar link (src/calendar.ts),
 * early access (flags.ts + index.ts) and Plus ending (the webhook).
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/plus.test.ts
 */
import { Hono } from "hono";
import worker from "../src/index.ts";
import { pushRoutes, type PushStoreApi } from "../src/push.ts";
import { PushStore, PUSH_PURPOSE } from "../src/pushStore.ts";
import { generateVapidKeys } from "../src/webpush.ts";
import { notificationsPlus, plusRequired } from "../src/plus.ts";
import {
  buildIcs,
  calendarRoutes,
  foldLine,
  forgetCalendar,
  icsText,
  schoologyDueItems,
  tokenHash,
  type CalendarRecordStore,
  type DueItem,
} from "../src/calendar.ts";
import { BillingAccount, hasPlus } from "../src/billing.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { openSession, readCookie, sealSession, sealValue, SESSION_COOKIE, type SessionData } from "../src/session.ts";
import { SANDBOX_KEY, SANDBOX_SECRET } from "../src/reviewSandbox.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}
const section = (t: string) => console.log(`\n${t}`);

class FakeStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get(key: string | string[]): Promise<any> {
    if (Array.isArray(key)) {
      const out = new Map<string, unknown>();
      for (const k of key) if (this.data.has(k)) out.set(k, structuredClone(this.data.get(k)));
      return out;
    }
    return this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.data.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
  }
  async delete(key: string): Promise<boolean> { return this.data.delete(key); }
  async deleteAll(): Promise<void> { this.data.clear(); }
  async getAlarm() { return this.alarm; }
  async setAlarm(at: number) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
}

/* Plus per student, as the BillingStore would say. */
const plusOf = new Map<string, string>(); // uid -> Stripe status
let billingDown = false;
const plusStoreFor = (_env: any, uid: string) => ({
  status: async () => {
    if (billingDown) throw new Error("billing store unreachable");
    const s = plusOf.get(uid) ?? "none";
    return { plus: hasPlus(s), status: s, renewsAt: null, cancelAtPeriodEnd: false, manageable: s !== "none" };
  },
});
/** A BILLING namespace for code that opens stores itself (the PushStore's check, index.ts). */
const BILLING: any = {
  jurisdiction: () => BILLING,
  idFromName: (n: string) => n,
  get: (uid: string) => plusStoreFor(null, uid),
};

const SESSION_SECRET = "plus-test-session-secret";
const PUSH_SECRET = "plus-test-push-secret";
const vapid = await generateVapidKeys();
const BASE = {
  SESSION_SECRET,
  PUSH_SECRET,
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_JWK: JSON.stringify(vapid.privateKeyJwk),
  STRIPE_SECRET_KEY: "sk_test_FAKEnotarealkey",
  BILLING,
};
const BILLING_ON = { ...BASE, FEATURES_ON: "billing" };
const BILLING_OFF = { ...BASE };

section("plus.ts");
{
  check("billing on and set up: Plus required", plusRequired(BILLING_ON as any), true);
  check("billing switch off: not required", plusRequired(BILLING_OFF as any), false);
  check("no Stripe key: not required", plusRequired({ ...BILLING_ON, STRIPE_SECRET_KEY: "" } as any), false);
  plusOf.set("7001", "active");
  check("with Plus: allowed", await notificationsPlus(BILLING_ON as any, "7001", "https://api.averages.io", { storeFor: plusStoreFor }), { required: true, plus: true, allowed: true });
  check("without Plus: not allowed", await notificationsPlus(BILLING_ON as any, "7002", "https://api.averages.io", { storeFor: plusStoreFor }), { required: true, plus: false, allowed: false });
  check("billing off: allowed, nobody asked", await notificationsPlus(BILLING_OFF as any, "7002", "https://api.averages.io", { storeFor: plusStoreFor }), { required: false, plus: false, allowed: true });
}

/* ── Notifications routes ─────────────────────────────────────────────── */
const pushStores = new Map<string, { store: PushStore; storage: FakeStorage }>();
const pushStoreFor = (env: any, uid: string): PushStoreApi => {
  if (!pushStores.has(uid)) {
    const storage = new FakeStorage();
    pushStores.set(uid, { store: new PushStore({ storage } as any, env), storage });
  }
  return pushStores.get(uid)!.store as unknown as PushStoreApi;
};
async function requireSession(c: any, next: () => Promise<void>) {
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  const session = token ? await openSession(token, c.env.SESSION_SECRET) : null;
  if (!session) return c.json({ error: "not_authenticated" }, 401);
  c.set("session", session);
  await next();
}
function fromOurApp(c: any) {
  const origin = c.req.header("Origin");
  if (origin && origin !== "https://app.averages.io") return c.json({ error: "forbidden_origin" }, 403);
  if (c.req.method === "POST" && !(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "json_required" }, 415);
  return null;
}
const pushApp = new Hono();
pushApp.route("/push", pushRoutes({ requireSession, fromOurApp, storeFor: pushStoreFor, plusStoreFor }));
const cookieFor = async (uid: string, extra: Partial<SessionData> = {}) => `${SESSION_COOKIE}=${await sealSession({ key: "k", secret: "s", uid, ...extra } as any, SESSION_SECRET)}`;
async function call(app: any, method: string, path: string, opts: { cookie?: string; body?: unknown; env?: any } = {}) {
  const headers = new Headers({ Origin: "https://app.averages.io" });
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");
  const res = await app.fetch(new Request("https://api.averages.io" + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), opts.env, { waitUntil() {}, passThroughOnException() {} });
  let data: any = null;
  try { data = await res.clone().json(); } catch {}
  return { status: res.status, data, res };
}
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const KEYPAIR = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
const P256 = b64u(new Uint8Array((await crypto.subtle.exportKey("raw", KEYPAIR.publicKey)) as ArrayBuffer));
const AUTH = b64u(crypto.getRandomValues(new Uint8Array(16)));
const browser = (n: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: P256, auth: AUTH } });

section("Notifications need Plus while billing is on");
{
  plusOf.clear();
  const sam = await cookieFor("8001");
  const sub = { subscription: browser("sam"), types: { grades: true } };
  const refused = await call(pushApp, "POST", "/push/subscribe", { cookie: sam, body: sub, env: BILLING_ON });
  check("turn on without Plus: 403 plus_required", [refused.status, refused.data?.error], [403, "plus_required"]);
  const st = await call(pushApp, "POST", "/push/status", { cookie: sam, body: { endpoint: sub.subscription.endpoint }, env: BILLING_ON });
  check("status says Plus is needed", [st.data.on, st.data.plusRequired, st.data.plus], [false, true, false]);
  const free = await call(pushApp, "POST", "/push/subscribe", { cookie: sam, body: sub, env: BILLING_OFF });
  check("billing off: anyone can turn on (as before Plus)", [free.status, free.data?.on], [200, true]);
  const stOff = await call(pushApp, "POST", "/push/status", { cookie: sam, body: { endpoint: sub.subscription.endpoint }, env: BILLING_OFF });
  check("billing off: status has no Plus requirement", [stOff.data.on, stOff.data.plusRequired], [true, false]);
  // Billing goes on: Sam had them on without Plus.
  const turned = await call(pushApp, "POST", "/push/status", { cookie: sam, body: { endpoint: sub.subscription.endpoint }, env: BILLING_ON });
  check("billing on, on without Plus: turned off, and says why", [turned.data.on, turned.data.turnedOff, turned.data.plusRequired], [false, "plus_required", true]);
  check("…and everything stored is deleted", pushStores.get("8001")!.storage.data.size, 0);

  plusOf.set("8001", "active");
  const ok = await call(pushApp, "POST", "/push/subscribe", { cookie: sam, body: sub, env: BILLING_ON });
  check("with Plus: turns on", [ok.status, ok.data?.on], [200, true]);
  const typesOk = await call(pushApp, "PUT", "/push/types", { cookie: sam, body: { types: { due: true } }, env: BILLING_ON });
  check("with Plus: types change", typesOk.status, 200);
  plusOf.set("8001", "canceled");
  const types = await call(pushApp, "PUT", "/push/types", { cookie: sam, body: { types: { due: false } }, env: BILLING_ON });
  check("Plus ended: changing types refused", [types.status, types.data?.error], [403, "plus_required"]);
  const touched = await call(pushApp, "POST", "/push/touch", { cookie: sam, body: {}, env: BILLING_ON });
  check("Plus ended: /touch turns them off", [touched.data.on, touched.data.reason, pushStores.get("8001")!.storage.data.size], [false, "plus_required", 0]);
  const off = await call(pushApp, "DELETE", "/push", { cookie: sam, env: BILLING_ON });
  check("turning off never needs Plus", off.status, 200);

  billingDown = true;
  const down = await call(pushApp, "POST", "/push/subscribe", { cookie: sam, body: sub, env: BILLING_ON });
  check("BillingStore unreachable: 503, nothing turned on", [down.status, down.data?.error], [503, "billing_unavailable"]);
  billingDown = false;
}

section("The background check stops without Plus");
{
  const make = (env: any) => {
    const storage = new FakeStorage();
    return { storage, store: new PushStore({ storage } as any, env) };
  };
  const session: SessionData = { key: "k", secret: "s", uid: "8101", exp: Math.floor(Date.now() / 1000) + 3600 } as any;
  const cred = { sealed: await sealValue(JSON.stringify(session), PUSH_SECRET, PUSH_PURPOSE, 3600), exp: session.exp };
  plusOf.delete("8101");
  {
    const { store, storage } = make(BILLING_ON);
    await store.subscribe({ subscription: browser("a"), types: { grades: true } as any, ...cred });
    await store.alarm();
    check("billing on, no Plus: the check deletes everything (no Schoology call)", [storage.data.size, storage.alarm], [0, null]);
  }
  {
    const { store, storage } = make(BILLING_ON);
    await store.subscribe({ subscription: browser("b"), types: { grades: true } as any, ...cred });
    billingDown = true;
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("no network in this test"); }) as any;
    await store.alarm();
    globalThis.fetch = realFetch;
    billingDown = false;
    check("BillingStore unreachable: kept, tried again later, school platform not asked", [storage.data.has("cred"), storage.alarm !== null, called], [true, true, false]);
  }
}

/* ── Calendar ─────────────────────────────────────────────────────────── */
section("Calendar: the .ics");
{
  check("text escaping", icsText("Lab; part 1, notes\\done\nnext"), "Lab\\; part 1\\, notes\\\\done\\nnext");
  const long = "SUMMARY:" + "é".repeat(60);
  const folded = foldLine(long);
  check("long lines fold at 75 bytes without splitting characters", folded.split("\r\n ").every((l, i) => new TextEncoder().encode(l).length <= (i === 0 ? 75 : 74)) && folded.replace(/\r\n /g, "") === long, true);
  const items: DueItem[] = [{ uid: "sgy-1@averages.io", title: "Lab Report, #4", course: "AP Chem", dueMs: Date.UTC(2026, 9, 23, 6, 59), time: "11:59 PM", day: "2026-10-22", link: "https://app.averages.io/assignment?id=1" }];
  const ics = buildIcs(items, { now: Date.UTC(2026, 9, 21), tz: "America/Los_Angeles" });
  check("calendar wraps one event", [ics.startsWith("BEGIN:VCALENDAR\r\n"), ics.endsWith("END:VCALENDAR\r\n"), (ics.match(/BEGIN:VEVENT/g) || []).length], [true, true, 1]);
  check("all-day on the local due date, time in the title", [ics.includes("DTSTART;VALUE=DATE:20261022"), ics.includes("DTEND;VALUE=DATE:20261023"), ics.includes("SUMMARY:Lab Report\\, #4 (due 11:59 PM)")], [true, true, true]);
  check("only CRLF line endings", /[^\r]\n/.test(ics), false);
  const notice = buildIcs([], { now: Date.UTC(2026, 9, 21, 12), tz: "UTC", notice: { title: "Sign in to Averages.io", text: "x" } });
  check("a notice is one event today", [notice.includes("SUMMARY:Sign in to Averages.io"), notice.includes("DTSTART;VALUE=DATE:20261021")], [true, true]);
}

section("Calendar: due dates from the reviewer sandbox (pretend Schoology)");
{
  const reviewer = { key: SANDBOX_KEY, secret: SANDBOX_SECRET, uid: "r:reviewer", exp: Math.floor(Date.now() / 1000) + 3600 } as any;
  const items = await schoologyDueItems(reviewer, "America/Los_Angeles", Date.now());
  check("sandbox classes have dated work in the window", items.length > 0, true);
  check("every item has a day, a time, a link and an id-based uid", items.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.day) && i.time && i.link.startsWith("https://app.averages.io/assignment?id=") && /^sgy-\d+@averages\.io$/.test(i.uid)), true);
  check("sorted by due time", items.every((x, i) => i === 0 || items[i - 1].dueMs <= x.dueMs), true);
}

section("Calendar: routes");
const recs = new Map<string, unknown>();
let calendarReads = 0;
const recordFor = (_env: any, name: string): CalendarRecordStore => ({
  read: async () => (recs.has(name) ? structuredClone(recs.get(name)) : null),
  write: async (v) => { recs.set(name, structuredClone(v)); },
  remove: async () => { recs.delete(name); },
});
let clock = Date.UTC(2026, 9, 21, 12);
const calApp = new Hono();
calApp.route("/calendar", calendarRoutes({
  requireSession,
  fromOurApp,
  storeFor: recordFor,
  plusStoreFor,
  now: () => clock,
  dueItems: async (session) => {
    calendarReads++;
    return [{ uid: `sgy-${session.uid}@averages.io`, title: "Essay", course: "English", dueMs: clock + 86400000, time: "11:59 PM", day: "2026-10-22", link: "https://app.averages.io/assignment?id=5" }];
  },
}));
const CAL_ENV = { ...BILLING_ON, FEATURES_ON: "billing" };
{
  plusOf.clear();
  const ana = await cookieFor("9001");
  const st0 = await call(calApp, "GET", "/calendar/status", { cookie: ana, env: CAL_ENV });
  check("status before: off, no Plus", [st0.data.enabled, st0.data.configured, st0.data.plus, st0.data.on, st0.data.url], [true, true, false, false, null]);
  const noPlus = await call(calApp, "POST", "/calendar", { cookie: ana, body: { tz: "America/Los_Angeles" }, env: CAL_ENV });
  check("make a link without Plus: 403 plus_required", [noPlus.status, noPlus.data?.error], [403, "plus_required"]);
  check("…even with billing off (calendar is always Plus)", (await call(calApp, "POST", "/calendar", { cookie: ana, body: {}, env: BILLING_OFF })).data?.error, "plus_required");
  const kid = await call(calApp, "POST", "/calendar", { cookie: await cookieFor("9002", { inc: true }), body: {}, env: CAL_ENV });
  check("Incognito: refused", [kid.status, kid.data?.error], [403, "incognito_mode"]);
  check("not set up (no PUSH_SECRET): 503", (await call(calApp, "POST", "/calendar", { cookie: ana, body: {}, env: { ...CAL_ENV, PUSH_SECRET: "" } })).status, 503);

  plusOf.set("9001", "active");
  const made = await call(calApp, "POST", "/calendar", { cookie: ana, body: { tz: "America/Los_Angeles" }, env: CAL_ENV });
  check("with Plus: a link", [made.status, /^https:\/\/api\.averages\.io\/calendar\/[A-Za-z0-9_-]{43}\.ics$/.test(made.data?.url)], [200, true]);
  const url = new URL(made.data.url);
  const token = url.pathname.slice("/calendar/".length, -4);
  check("only the token's hash names the feed; the token itself is sealed", [recs.has(`f:${await tokenHash(token)}`), JSON.stringify([...recs.values()]).includes(token)], [true, false]);
  const st1 = await call(calApp, "GET", "/calendar/status", { cookie: ana, env: CAL_ENV });
  check("status shows the same link again", [st1.data.on, st1.data.url], [true, made.data.url]);

  const feed = await call(calApp, "GET", url.pathname, { env: CAL_ENV });
  const ics = await feed.res.text();
  check("the calendar: text/calendar, private, one event", [feed.res.headers.get("Content-Type"), feed.res.headers.get("Cache-Control"), ics.includes("SUMMARY:Essay (due 11:59 PM)")], ["text/calendar; charset=utf-8", "private, max-age=900", true]);
  const soon = await call(calApp, "GET", url.pathname, { env: CAL_ENV });
  check("asked again within 10 minutes: 429 with Retry-After, school platform not asked", [soon.status, Number(soon.res.headers.get("Retry-After")) > 0, calendarReads], [429, true, 1]);
  check("the calendar itself is never stored (only when it was read)", JSON.stringify([...recs.values()]).includes("Essay"), false);
  clock += 11 * 60 * 1000;
  check("after 10 minutes: read again", [(await call(calApp, "GET", url.pathname, { env: CAL_ENV })).status, calendarReads], [200, 2]);
  clock += 11 * 60 * 1000;

  check("a token that isn't one: 404", (await call(calApp, "GET", "/calendar/" + "x".repeat(43) + ".ics", { env: CAL_ENV })).status, 404);
  check("not .ics: 404", (await call(calApp, "GET", "/calendar/" + token, { env: CAL_ENV })).status, 404);

  plusOf.set("9001", "canceled");
  const ended = await (await call(calApp, "GET", url.pathname, { env: CAL_ENV })).res.text();
  check("Plus ended: a calendar that says so, no due dates", [ended.includes("Averages Plus has ended"), ended.includes("Essay")], [true, false]);
  plusOf.set("9001", "active");

  const again = await call(calApp, "POST", "/calendar", { cookie: ana, body: {}, env: CAL_ENV });
  check("a new link: the old one stops working", [(await call(calApp, "GET", url.pathname, { env: CAL_ENV })).status, (await call(calApp, "GET", new URL(again.data.url).pathname, { env: CAL_ENV })).status], [404, 200]);

  // A stored sign-in that ran out.
  plusOf.set("9003", "active");
  const shortLink = await call(calApp, "POST", "/calendar", { cookie: await cookieFor("9003"), body: {}, env: CAL_ENV });
  {
    const name = `f:${await tokenHash(new URL(shortLink.data.url).pathname.slice("/calendar/".length, -4))}`;
    const f: any = recs.get(name);
    const s = { key: "k", secret: "s", uid: "9003", exp: Math.floor(Date.now() / 1000) + 1 };
    recs.set(name, { ...f, cred: { sealed: await sealValue(JSON.stringify(s), PUSH_SECRET, "calendar-credential", 1), exp: s.exp } });
  }
  await new Promise((r) => setTimeout(r, 2200));
  const stale = await (await call(calApp, "GET", new URL(shortLink.data.url).pathname, { env: CAL_ENV })).res.text();
  check("sign-in ran out: a calendar asking to sign in", stale.includes("Sign in to Averages.io"), true);

  const del = await call(calApp, "DELETE", "/calendar", { cookie: ana, env: CAL_ENV });
  check("turn off: link and feed gone", [del.status, [...recs.keys()].some((k) => k === "u:9001"), (await call(calApp, "GET", new URL(again.data.url).pathname, { env: CAL_ENV })).status], [200, false, 404]);
  const foreign = await calApp.fetch(new Request("https://api.averages.io/calendar", { method: "POST", headers: { Origin: "https://evil.example", Cookie: ana, "Content-Type": "application/json" }, body: "{}" }), CAL_ENV as any, {} as any);
  check("another site can't make a link", foreign.status, 403);

  const bea = await cookieFor("9004");
  plusOf.set("9004", "active");
  await call(calApp, "POST", "/calendar", { cookie: bea, body: {}, env: CAL_ENV });
  await forgetCalendar(CAL_ENV as any, "9004", "https://api.averages.io", recordFor);
  check("forgetCalendar (sign-out, Incognito, Plus ending) deletes both records", [...recs.keys()].filter((k) => k === "u:9004").length, 0);
}

/* ── Through the real Worker: early access, Plus ending ───────────────── */
section("Worker: early access and Plus ending");
{
  const accounts = new Map<string, BillingAccount>();
  class Mem {
    data = new Map<string, unknown>();
    async get(k: string) { return this.data.has(k) ? structuredClone(this.data.get(k)) : undefined; }
    async put(k: string, v: unknown) { this.data.set(k, structuredClone(v)); }
    async delete(k: string) { return this.data.delete(k); }
    async deleteAll() { this.data.clear(); }
  }
  const NS: any = { jurisdiction: () => NS, idFromName: (n: string) => n, get: (n: string) => { if (!accounts.has(n)) accounts.set(n, new BillingAccount(new Mem() as any)); return accounts.get(n); } };
  const calendarRecs = new Map<string, unknown>();
  const CAL_NS: any = { jurisdiction: () => CAL_NS, idFromName: (n: string) => n, get: (n: string) => ({ read: async () => calendarRecs.get(n) ?? null, write: async (v: unknown) => { calendarRecs.set(n, v); }, remove: async () => { calendarRecs.delete(n); } }) };
  const pushDeleted: string[] = [];
  const PUSH_NS: any = { jurisdiction: () => PUSH_NS, idFromName: (n: string) => n, get: (n: string) => ({ deleteAll: async () => { pushDeleted.push(n); } }) };
  const WHSEC = "whsec_FAKEnotarealsecret";
  const env = { ...BASE, BILLING: NS, CALENDAR: CAL_NS, PUSH: PUSH_NS, STRIPE_WEBHOOK_SECRET: WHSEC, FEATURES_ON: "billing", FEATURES_OFF: "messaging-features", FEATURES_EARLY: "messaging-features" };
  const waits: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} };
  const go = async (path: string, init: RequestInit & { cookie?: string } = {}) => {
    resetRateLimits();
    const headers = new Headers(init.headers);
    headers.set("Origin", "https://app.averages.io");
    if (init.cookie) headers.set("Cookie", init.cookie);
    return worker.fetch(new Request("https://api.averages.io" + path, { ...init, headers }), env as any, ctx);
  };
  const cfg = await (await go("/config/features")).json();
  check("/config/features lists early keys that are off", [cfg.features["messaging-features"], cfg.early], [false, ["messaging-features"]]);
  const zoe = await cookieFor("9101");
  const plain = await go("/messages", { cookie: zoe });
  check("early feature without Plus: 503 feature_off", [plain.status, (await plain.json()).error], [503, "feature_off"]);
  await NS.get("9101").apply({ uid: "9101", eventId: "e1", created: 1, customerId: "cus_1", subscriptionId: "sub_1", status: "active" });
  const early = await go("/messages", { cookie: zoe });
  check("early feature with Plus: let through (no longer feature_off)", early.status !== 503, true);

  // Plus ends through Stripe's webhook: notifications and the calendar link go.
  calendarRecs.set("u:9101", { sealedToken: "x", hash: "abc", createdAt: 1 });
  calendarRecs.set("f:abc", { uid: "9101" });
  const payload = JSON.stringify({ id: "evt_end", type: "customer.subscription.deleted", created: 2, data: { object: { id: "sub_1", object: "subscription", customer: "cus_1", status: "canceled", metadata: { uid: "9101" }, items: { data: [] } } } });
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WHSEC), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hook = await worker.fetch(new Request("https://api.averages.io/stripe/webhook", { method: "POST", body: payload, headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${mac}` } }), env as any, ctx);
  await Promise.all(waits);
  check("webhook: Plus ended", [hook.status, (await NS.get("9101").status()).plus], [200, false]);
  check("…notifications deleted and the calendar link gone", [pushDeleted.includes("9101"), calendarRecs.has("u:9101"), calendarRecs.has("f:abc")], [true, false, false]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
