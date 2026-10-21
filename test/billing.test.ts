/**
 * Averages Plus (2026-10-21): src/billing.ts and the /billing and
 * /stripe/webhook routes, through the real Worker with a sealed session.
 *
 * No Durable Object or network: BILLING is an in-memory stand-in that keeps
 * one BillingAccount per student, and globalThis.fetch plays Stripe's
 * /v1/prices, /v1/checkout/sessions and /v1/billing_portal/sessions. Anything
 * else leaving the Worker fails the test.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/billing.test.ts
 */
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { DEMO_UID, SESSION_COOKIE, sealSession } from "../src/session.ts";
import type { CanvaStorage } from "../src/canva.ts";
import {
  BillingAccount,
  MANAGED_PAYMENTS_VERSION,
  clearPriceCache,
  hasPlus,
  publicStatus,
  stripeForm,
  updateFromEvent,
  verifyStripeSignature,
} from "../src/billing.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

/* ── Fake Stripe ───────────────────────────────────────────────────────── */

type Call = { url: string; method: string; headers: Record<string, string>; form: Record<string, string> };
const calls: Call[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let prices: unknown[] = [{ id: "price_PLUS123", lookup_key: "plus_monthly" }];
let checkoutAnswer: () => Response = () => json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const u = new URL(url);
  const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
  const form = Object.fromEntries(new URLSearchParams(typeof init.body === "string" ? init.body : u.search));
  calls.push({ url: u.origin + u.pathname, method: init.method ?? "GET", headers, form });
  if (u.origin !== "https://api.stripe.com") throw new Error(`unexpected network call: ${url}`);
  if (u.pathname === "/v1/prices") return json({ object: "list", data: prices });
  if (u.pathname === "/v1/checkout/sessions") return checkoutAnswer();
  if (u.pathname === "/v1/billing_portal/sessions") return json({ id: "bps_1", url: "https://billing.stripe.com/p/session/test_1" });
  throw new Error(`unexpected Stripe call: ${u.pathname}`);
}) as typeof fetch;

/* ── Fake BillingStore namespace ───────────────────────────────────────── */

class MemoryStorage implements CanvaStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.data.delete(key); }
  async deleteAll(): Promise<void> { this.data.clear(); }
}

const accounts = new Map<string, BillingAccount>();
const jurisdictions: string[] = [];
const BILLING: any = {
  jurisdiction: (j: string) => { jurisdictions.push(j); return BILLING; },
  idFromName: (name: string) => name,
  get: (id: string) => {
    let a = accounts.get(id);
    if (!a) { a = new BillingAccount(new MemoryStorage()); accounts.set(id, a); }
    return a;
  },
};

const SECRET = "billing-test-session-secret";
const WHSEC = "whsec_FAKEnotarealsecret";
const BASE_ENV = {
  SESSION_SECRET: SECRET,
  STRIPE_SECRET_KEY: "sk_test_FAKEnotarealkey",
  STRIPE_WEBHOOK_SECRET: WHSEC,
  BILLING,
  FEATURES_ON: "billing",
};
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";
const APP = "https://app.averages.io";

async function cookieFor(uid: string, extra: Record<string, unknown> = {}): Promise<string> {
  return `${SESSION_COOKIE}=${await sealSession({ uid, key: "k", secret: "s", ...extra } as any, SECRET)}`;
}

type Init = { method?: string; cookie?: string; json?: unknown; body?: string; headers?: Record<string, string>; env?: any; noOrigin?: boolean };
async function call(path: string, init: Init = {}) {
  resetRateLimits();
  const env = init.env ?? BASE_ENV;
  const headers = new Headers(init.headers);
  if (!init.noOrigin && !headers.has("Origin")) headers.set("Origin", APP);
  if (init.cookie) headers.set("Cookie", init.cookie);
  let body = init.body;
  if (init.json !== undefined) { body = JSON.stringify(init.json); headers.set("Content-Type", "application/json"); }
  const res = await worker.fetch(new Request(API + path, { method: init.method ?? "GET", headers, body }), env, CTX);
  const data: any = (res.headers.get("Content-Type") ?? "").includes("json") ? await res.clone().json() : null;
  return { res, data };
}

async function sign(payload: string, secret = WHSEC, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let eventN = 0;
async function webhook(type: string, object: Record<string, unknown>, opts: { created?: number; secret?: string; t?: number; id?: string } = {}) {
  const event = { id: opts.id ?? `evt_${++eventN}`, object: "event", type, created: opts.created ?? Math.floor(Date.now() / 1000), data: { object } };
  const payload = JSON.stringify(event);
  return call("/stripe/webhook", { method: "POST", body: payload, noOrigin: true, headers: { "Content-Type": "application/json", "Stripe-Signature": await sign(payload, opts.secret, opts.t) } });
}

const completed = (uid: string, extra: Record<string, unknown> = {}) => ({
  id: "cs_test_1", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
  customer: "cus_A1", subscription: "sub_A1", client_reference_id: uid, metadata: { uid }, ...extra,
});
const subscription = (uid: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: "sub_A1", object: "subscription", customer: "cus_A1", status, cancel_at_period_end: false, metadata: { uid },
  items: { data: [{ id: "si_1", current_period_end: 1800000000 }] }, ...extra,
});

/* ── Pieces ────────────────────────────────────────────────────────────── */
console.log("\npieces");
check("Stripe form encoding: nested and arrays",
  stripeForm({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], managed_payments: { enabled: "true" }, skip: undefined }),
  "mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&managed_payments%5Benabled%5D=true");
check("Plus statuses", ["active", "trialing", "past_due", "canceled", "incomplete", "unpaid", ""].map(hasPlus), [true, true, true, false, false, false, false]);
check("no record: no Plus", publicStatus(null), { plus: false, status: "none", renewsAt: null, cancelAtPeriodEnd: false, manageable: false });

{
  const payload = JSON.stringify({ id: "evt_x", type: "ping", data: { object: {} } });
  const now = Math.floor(Date.now() / 1000);
  check("signature: good", !!(await verifyStripeSignature(payload, await sign(payload), WHSEC)), true);
  check("signature: another secret", await verifyStripeSignature(payload, await sign(payload, "whsec_FAKEsomeoneelse"), WHSEC), null);
  check("signature: body changed", await verifyStripeSignature(payload + " ", await sign(payload), WHSEC), null);
  check("signature: too old (replay)", await verifyStripeSignature(payload, await sign(payload, WHSEC, now - 301), WHSEC), null);
  check("signature: one good v1 among several", !!(await verifyStripeSignature(payload, `${(await sign(payload)).split(",")[0]},v1=${"0".repeat(64)},${(await sign(payload)).split(",")[1]}`, WHSEC)), true);
  check("signature: missing or junk header", [await verifyStripeSignature(payload, null, WHSEC), await verifyStripeSignature(payload, "t=abc,v1=zz", WHSEC), await verifyStripeSignature(payload, "garbage", WHSEC)], [null, null, null]);
}

check("event: checkout completed and paid -> active",
  updateFromEvent({ id: "evt_1", type: "checkout.session.completed", created: 10, data: { object: completed("123") } }),
  { uid: "123", eventId: "evt_1", created: 10, customerId: "cus_A1", subscriptionId: "sub_A1", status: "active" });
check("event: checkout not paid yet -> no status",
  updateFromEvent({ id: "evt_2", type: "checkout.session.completed", created: 10, data: { object: completed("123", { payment_status: "unpaid" }) } })?.status, undefined);
check("event: one-time checkout (not a subscription) ignored", updateFromEvent({ id: "e", type: "checkout.session.completed", data: { object: completed("123", { mode: "payment" }) } }), null);
check("event: subscription without our uid ignored", updateFromEvent({ id: "e", type: "customer.subscription.updated", data: { object: subscription("", "active", { metadata: {} }) } }), null);
check("event: subscription deleted -> canceled", updateFromEvent({ id: "e", type: "customer.subscription.deleted", created: 5, data: { object: subscription("123", "active") } })?.status, "canceled");
check("event: period end from the items (newer API versions)", updateFromEvent({ id: "e", type: "customer.subscription.updated", data: { object: subscription("123", "active") } })?.periodEnd, 1800000000);
check("event: period end on the subscription (older versions)", updateFromEvent({ id: "e", type: "customer.subscription.updated", data: { object: subscription("123", "active", { current_period_end: 1700000000, items: { data: [] } }) } })?.periodEnd, 1700000000);
check("event: something else ignored", updateFromEvent({ id: "e", type: "invoice.paid", data: { object: { id: "in_1" } } }), null);

{
  console.log("\nrecord");
  const acct = new BillingAccount(new MemoryStorage());
  await acct.apply({ uid: "u", eventId: "e1", created: 100, customerId: "cus_A", subscriptionId: "sub_A", status: "active" });
  check("checkout completed: Plus", (await acct.status()).plus, true);
  check("the same event again: nothing changes", await acct.apply({ uid: "u", eventId: "e1", created: 100, status: "canceled" }), false);
  check("…still Plus", (await acct.status()).plus, true);
  await acct.apply({ uid: "u", eventId: "e2", created: 200, subscriptionId: "sub_A", status: "past_due" });
  check("past due: still Plus while Stripe retries", (await acct.status()), { plus: true, status: "past_due", renewsAt: null, cancelAtPeriodEnd: false, manageable: true });
  check("an older event arriving late doesn't undo a newer one", await acct.apply({ uid: "u", eventId: "e3", created: 150, subscriptionId: "sub_A", status: "active" }), false);
  check("…status stays past_due", (await acct.status()).status, "past_due");
  await acct.apply({ uid: "u", eventId: "e4", created: 300, subscriptionId: "sub_A", status: "canceled" });
  check("canceled: no Plus, customer kept for Manage plan", [(await acct.status()).plus, (await acct.status()).manageable], [false, true]);
  await acct.apply({ uid: "u", eventId: "e5", created: 400, customerId: "cus_A", subscriptionId: "sub_B", status: "active" });
  check("subscribed again: the new subscription counts", [(await acct.status()).plus, (await acct.record())?.subscriptionId], [true, "sub_B"]);
  check("the OLD subscription ending later doesn't take Plus away", await acct.apply({ uid: "u", eventId: "e6", created: 500, subscriptionId: "sub_A", status: "canceled" }), false);
  check("…still Plus on sub_B", [(await acct.status()).plus, (await acct.record())?.subscriptionId], [true, "sub_B"]);
}

/* ── Routes ────────────────────────────────────────────────────────────── */
console.log("\nroutes");
const sam = await cookieFor("4001");
{
  const r = await call("/billing/status", { cookie: sam });
  check("status: no subscription yet", r.data, { enabled: true, configured: true, eligible: true, plus: false, status: "none", renewsAt: null, cancelAtPeriodEnd: false, manageable: false });
  check("status: needs a session", (await call("/billing/status")).res.status, 401);
  const off = await call("/billing/status", { cookie: sam, env: { ...BASE_ENV, FEATURES_ON: "" } });
  check("switch off (the default): status still answers, enabled false", [off.res.status, off.data.enabled], [200, false]);
}
{
  const off = await call("/billing/checkout", { method: "POST", cookie: sam, json: {}, env: { ...BASE_ENV, FEATURES_ON: "" } });
  check("checkout with the switch off: 503 feature_off", [off.res.status, off.data], [503, { error: "feature_off", feature: "billing" }]);
  const noKey = await call("/billing/checkout", { method: "POST", cookie: sam, json: {}, env: { ...BASE_ENV, STRIPE_SECRET_KEY: undefined } });
  check("checkout without a Stripe key: 503", [noKey.res.status, noKey.data.error], [503, "billing_not_configured"]);
  const demo = await call("/billing/checkout", { method: "POST", cookie: await cookieFor(DEMO_UID), json: {} });
  check("demo can't subscribe", [demo.res.status, demo.data.error], [403, "not_available_in_demo"]);
  const kid = await call("/billing/checkout", { method: "POST", cookie: await cookieFor("4002", { inc: true }), json: {} });
  check("Incognito (incl. every under-13) can't subscribe", [kid.res.status, kid.data.error], [403, "incognito_mode"]);
  const foreign = await call("/billing/checkout", { method: "POST", cookie: sam, json: {}, headers: { Origin: "https://evil.example" } });
  check("another site can't start a checkout", foreign.res.status, 403);
  const form = await call("/billing/checkout", { method: "POST", cookie: sam, body: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  check("a plain form post is refused (JSON only)", form.res.status, 415);
}
{
  calls.length = 0;
  clearPriceCache();
  const r = await call("/billing/checkout", { method: "POST", cookie: sam, json: {} });
  check("checkout: Stripe's hosted page", [r.res.status, r.data], [200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" }]);
  const price = calls.find((c) => c.url.endsWith("/v1/prices"))!;
  check("price found by lookup key, active only", [price.method, price.form["lookup_keys[]"], price.form.active], ["GET", "plus_monthly", "true"]);
  const cs = calls.find((c) => c.url.endsWith("/v1/checkout/sessions"))!;
  check("blueprint: managed_payments[enabled]=true, subscription mode, the Plus price", [cs.form["managed_payments[enabled]"], cs.form.mode, cs.form["line_items[0][price]"], cs.form["line_items[0][quantity]"]], ["true", "subscription", "price_PLUS123", "1"]);
  check("blueprint: Stripe-Version 2026-02-25.preview on the checkout call only", [cs.headers["stripe-version"], price.headers["stripe-version"]], [MANAGED_PAYMENTS_VERSION, undefined]);
  check("whose it is: uid in the session and the subscription's metadata", [cs.form["metadata[uid]"], cs.form["subscription_data[metadata][uid]"], cs.form.client_reference_id], ["4001", "4001", "4001"]);
  check("back to Settings > Account", [cs.form.success_url, cs.form.cancel_url], [`${APP}/settings?section=account&billing=success`, `${APP}/settings?section=account&billing=cancelled`]);
  check("secret key sent only to Stripe, as a Bearer token", cs.headers.authorization, `Bearer ${BASE_ENV.STRIPE_SECRET_KEY}`);
  check("the store is opened in the US", jurisdictions.includes("us"), true);
  calls.length = 0;
  await call("/billing/checkout", { method: "POST", cookie: sam, json: {} });
  check("price cached: no second lookup", calls.filter((c) => c.url.endsWith("/v1/prices")).length, 0);
}
{
  clearPriceCache();
  prices = [];
  const r = await call("/billing/checkout", { method: "POST", cookie: await cookieFor("4003"), json: {} });
  check("no price with that lookup key: 502 billing_price_missing", [r.res.status, r.data.error], [502, "billing_price_missing"]);
  prices = [{ id: "price_PLUS123" }];
  clearPriceCache();
  checkoutAnswer = () => json({ error: { type: "invalid_request_error", message: "secret detail" } }, 400);
  const bad = await call("/billing/checkout", { method: "POST", cookie: await cookieFor("4003"), json: {} });
  check("Stripe refuses: a code, never Stripe's message", [bad.res.status, bad.data], [502, { error: "billing_stripe_error" }]);
  checkoutAnswer = () => json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
}

console.log("\nwebhook");
{
  const bad = await call("/stripe/webhook", { method: "POST", body: "{}", noOrigin: true, headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=" + "0".repeat(64) } });
  check("unsigned or wrongly signed: 400", [bad.res.status, bad.data.error], [400, "bad_signature"]);
  const wrongSecret = await webhook("checkout.session.completed", completed("4001"), { secret: "whsec_FAKEnotours" });
  check("signed with another secret: 400, nothing stored", [wrongSecret.res.status, (await call("/billing/status", { cookie: sam })).data.plus], [400, false]);
  const noSecret = await call("/stripe/webhook", { method: "POST", body: "{}", noOrigin: true, env: { ...BASE_ENV, STRIPE_WEBHOOK_SECRET: undefined } });
  check("no webhook secret set: 503", noSecret.res.status, 503);

  const done = await webhook("checkout.session.completed", completed("4001"));
  check("checkout.session.completed: 200, used", [done.res.status, done.data], [200, { received: true, used: true }]);
  const s = (await call("/billing/status", { cookie: sam })).data;
  check("…the student has Plus", [s.plus, s.status, s.manageable], [true, "active", true]);
  const again = await call("/billing/checkout", { method: "POST", cookie: sam, json: {} });
  check("…and can't check out twice", [again.res.status, again.data.error], [409, "billing_already_subscribed"]);

  await webhook("customer.subscription.updated", subscription("4001", "active", { cancel_at_period_end: true }));
  const s2 = (await call("/billing/status", { cookie: sam })).data;
  check("set to cancel: still Plus until the period ends, with the date", [s2.plus, s2.cancelAtPeriodEnd, s2.renewsAt], [true, true, 1800000000 * 1000]);

  calls.length = 0;
  const portal = await call("/billing/portal", { method: "POST", cookie: sam, json: {} });
  check("Manage plan: Stripe's customer page for this customer", [portal.res.status, portal.data.url], [200, "https://billing.stripe.com/p/session/test_1"]);
  const p = calls.find((c) => c.url.endsWith("/v1/billing_portal/sessions"))!;
  check("…for their own customer, back to Settings", [p.form.customer, p.form.return_url], ["cus_A1", `${APP}/settings?section=account`]);
  const kidPortal = await call("/billing/portal", { method: "POST", cookie: await cookieFor("4001", { inc: true }), json: {} });
  check("Manage plan works in Incognito too (nobody stuck paying)", kidPortal.res.status, 200);
  const nobody = await call("/billing/portal", { method: "POST", cookie: await cookieFor("4999"), json: {} });
  check("Manage plan without ever subscribing: 404", [nobody.res.status, nobody.data.error], [404, "billing_no_account"]);

  await webhook("customer.subscription.deleted", subscription("4001", "canceled"));
  check("subscription deleted: Plus ends", (await call("/billing/status", { cookie: sam })).data.plus, false);

  const other = await webhook("invoice.paid", { id: "in_1", object: "invoice" });
  check("events we don't use: 200, not used", [other.res.status, other.data], [200, { received: true, used: false }]);
  const stranger = await webhook("checkout.session.completed", completed("", { metadata: {}, client_reference_id: null }));
  check("a checkout that isn't ours (no uid): 200, not used", stranger.data, { received: true, used: false });
  check("webhook isn't behind the switch", (await webhook("invoice.paid", { id: "in_2" }, {})).res.status, 200);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
