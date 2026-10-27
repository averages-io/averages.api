/**
 * Averages Plus: a monthly subscription through Stripe (2026-10-21).
 *
 * Built from Stripe's "Set up Managed Payments" blueprint. Stripe sells it as
 * the merchant of record, so it collects and pays sales tax / VAT / GST, and
 * handles fraud and order support. The steps it lists, and where they live:
 *
 *   1. A product with an eligible tax code. Already made in the Stripe
 *      Dashboard ("Averages Plus", SaaS personal use, $2.99/month plus
 *      EUR/GBP/AUD/CAD); the price is found by its lookup key (plus_monthly,
 *      or STRIPE_PRICE_LOOKUP_KEY), never a hard-coded id, so a new price
 *      only needs the key moved over in Stripe.
 *   2. A Checkout Session with managed_payments[enabled]=true, sent with the
 *      Stripe-Version 2026-02-25.preview header the blueprint asks for
 *      (createCheckoutSession). The browser goes to Stripe's hosted page; no
 *      card details ever reach us.
 *   3. Testing it: sandbox keys and Stripe's test cards.
 *   4. Webhooks: checkout.session.completed (and the subscription's own
 *      updates, so a cancel or a failed renewal ends Plus) arrive at
 *      POST /stripe/webhook, signed with STRIPE_WEBHOOK_SECRET
 *      (verifyStripeSignature).
 *
 * What's kept, per student, in their BillingStore Durable Object (US
 * jurisdiction, like everything else we store): the Stripe customer and
 * subscription ids, the subscription's status, when the current period ends,
 * whether it's set to cancel, when we last heard, and the last few event ids
 * (so a resent event isn't applied twice). No card details, no address, no
 * email: Stripe keeps those.
 *
 * Free of Hono and `cloudflare:workers`, so the tests import it directly.
 * Errors carry a short billing_* code as their message, never a key or
 * Stripe's own error text.
 */

import type { CanvaStorage } from "./canva.ts";

export const STRIPE_API = "https://api.stripe.com";
/** The blueprint's version header for Checkout Sessions with Managed Payments. Other calls use the account's default. */
export const MANAGED_PAYMENTS_VERSION = "2026-02-25.preview";
export const DEFAULT_PRICE_LOOKUP_KEY = "plus_monthly";
/** How far a webhook's signed time may be from ours (Stripe's own default). */
export const WEBHOOK_TOLERANCE_S = 300;
/** Webhook bodies are small; anything bigger isn't Stripe. */
export const WEBHOOK_MAX_BYTES = 512 * 1024;
const STRIPE_TIMEOUT_MS = 15_000;
const PRICE_CACHE_MS = 10 * 60 * 1000;
const SEEN_EVENTS_KEPT = 30;

export interface BillingEnv {
  /** Secret or restricted key (dashboard secret). Sandbox keys while testing. */
  STRIPE_SECRET_KEY?: string;
  /** The webhook endpoint's signing secret, whsec_... (dashboard secret). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Optional: the price's lookup key, if not plus_monthly. */
  STRIPE_PRICE_LOOKUP_KEY?: string;
}

export class BillingError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "BillingError";
  }
}

/** HTTP status for a billing_* code. */
export function statusForBillingCode(code: string): number {
  switch (code) {
    case "billing_not_configured":
      return 503;
    case "billing_already_subscribed":
      return 409;
    case "billing_no_account":
      return 404;
    case "billing_price_missing":
    case "billing_stripe_error":
    case "billing_unavailable":
      return 502;
    default:
      return 500;
  }
}

/** The key looks like a Stripe secret or restricted key. */
export function billingConfigured(env: BillingEnv): boolean {
  return typeof env.STRIPE_SECRET_KEY === "string" && /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(env.STRIPE_SECRET_KEY.trim());
}

export function webhookConfigured(env: BillingEnv): boolean {
  return typeof env.STRIPE_WEBHOOK_SECRET === "string" && /^whsec_[A-Za-z0-9+/=]{10,}$/.test(env.STRIPE_WEBHOOK_SECRET.trim());
}

function lookupKey(env: BillingEnv): string {
  const key = (env.STRIPE_PRICE_LOOKUP_KEY ?? "").trim();
  return /^[A-Za-z0-9_.-]{1,200}$/.test(key) ? key : DEFAULT_PRICE_LOOKUP_KEY;
}

/** Stripe's form encoding: nested objects and arrays as a[b][0][c]=v. */
export function stripeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const add = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${prefix}[${i}]`, v));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${prefix}[${k}]`, v);
    else out.append(prefix, String(value));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.toString();
}

/** One call to Stripe's API. Throws BillingError; Stripe's own message only goes to the log. */
export async function stripeRequest(
  env: BillingEnv,
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  opts: { version?: string } = {}
): Promise<any> {
  if (!billingConfigured(env)) throw new BillingError("billing_not_configured");
  const headers: Record<string, string> = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY!.trim()}` };
  if (opts.version) headers["Stripe-Version"] = opts.version;
  let url = `${STRIPE_API}${path}`;
  let body: string | undefined;
  const form = stripeForm(params);
  if (method === "GET") {
    if (form) url += `?${form}`;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = form;
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) });
  } catch (error) {
    console.error("billing: stripe unreachable", path, error instanceof Error ? error.name : "");
    throw new BillingError("billing_unavailable");
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || typeof data !== "object") {
    const e = data && data.error ? data.error : {};
    // Type and code are safe to log (no key, no customer data); the message can quote parameters.
    console.error("billing: stripe error", path, res.status, e.type ?? "", e.code ?? "", e.param ?? "");
    throw new BillingError(res.status >= 500 ? "billing_unavailable" : "billing_stripe_error");
  }
  return data;
}

const priceCache = new Map<string, { id: string; at: number }>();
export function clearPriceCache(): void {
  priceCache.clear();
}

/** The active price for Averages Plus, by its lookup key (cached 10 minutes, per test/live mode). */
export async function findPlusPrice(env: BillingEnv): Promise<string> {
  const key = lookupKey(env);
  const mode = /_live_/.test(env.STRIPE_SECRET_KEY ?? "") ? "live" : "test";
  const cacheKey = `${mode}:${key}`;
  const hit = priceCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PRICE_CACHE_MS) return hit.id;
  const list = await stripeRequest(env, "GET", "/v1/prices", { "lookup_keys[]": key, active: "true", limit: "1" });
  const price = Array.isArray(list.data) ? list.data[0] : null;
  if (!price || typeof price.id !== "string" || !/^price_[A-Za-z0-9]+$/.test(price.id)) throw new BillingError("billing_price_missing");
  priceCache.set(cacheKey, { id: price.id, at: Date.now() });
  return price.id;
}

/** client_reference_id only takes plain ids; the uid always travels in metadata too. */
function referenceId(uid: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,200}$/.test(uid) ? uid : undefined;
}

/**
 * The blueprint's Checkout Session: subscription mode, one Plus price,
 * managed_payments[enabled]=true, version header 2026-02-25.preview.
 * The student's uid goes in the session's and the subscription's metadata,
 * which is how the webhook knows whose Plus it is. Returns the hosted page URL.
 */
export async function createCheckoutSession(
  env: BillingEnv,
  input: { uid: string; appOrigin: string; customerId?: string | null }
): Promise<{ id: string; url: string }> {
  const price = await findPlusPrice(env);
  const back = `${input.appOrigin}/settings?section=account`;
  const params: Record<string, unknown> = {
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    managed_payments: { enabled: "true" },
    success_url: `${back}&billing=success`,
    cancel_url: `${back}&billing=cancelled`,
    client_reference_id: referenceId(input.uid),
    metadata: { uid: input.uid },
    subscription_data: { metadata: { uid: input.uid } },
  };
  if (input.customerId && /^cus_[A-Za-z0-9]+$/.test(input.customerId)) params.customer = input.customerId;
  const session = await stripeRequest(env, "POST", "/v1/checkout/sessions", params, { version: MANAGED_PAYMENTS_VERSION });
  if (typeof session.url !== "string" || !session.url.startsWith("https://")) throw new BillingError("billing_stripe_error");
  return { id: String(session.id ?? ""), url: session.url };
}

/** Stripe's customer page (cancel, change card, invoices). Returns its URL. */
export async function createPortalSession(env: BillingEnv, input: { customerId: string; appOrigin: string }): Promise<string> {
  if (!/^cus_[A-Za-z0-9]+$/.test(input.customerId)) throw new BillingError("billing_no_account");
  const portal = await stripeRequest(env, "POST", "/v1/billing_portal/sessions", {
    customer: input.customerId,
    return_url: `${input.appOrigin}/settings?section=account`,
  });
  if (typeof portal.url !== "string" || !portal.url.startsWith("https://")) throw new BillingError("billing_stripe_error");
  return portal.url;
}

/* ── Webhook signatures ─────────────────────────────────────────────── */

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks the Stripe-Signature header: HMAC-SHA256 of "<t>.<raw body>" with
 * the endpoint's signing secret, against any v1 signature in the header, and
 * the time within WEBHOOK_TOLERANCE_S. Returns the parsed event, or null.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  nowS = Math.floor(Date.now() / 1000)
): Promise<any | null> {
  if (!header || !secret || header.length > 2048) return null;
  let t = NaN;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowS - t) > WEBHOOK_TOLERANCE_S) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  if (!sigs.some((s) => sameText(s, expected))) return null;
  try {
    const event = JSON.parse(payload);
    return event && typeof event === "object" && typeof event.id === "string" && typeof event.type === "string" ? event : null;
  } catch {
    return null;
  }
}

/* ── What a webhook means for a student ─────────────────────────────── */

export interface BillingUpdate {
  uid: string;
  eventId: string;
  /** The event's own time (Unix seconds), so an older event can't undo a newer one. */
  created: number;
  customerId?: string;
  subscriptionId?: string;
  status?: string;
  periodEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
  /** What they pay, from the subscription's price (2026-10-27, for Settings > Plus). */
  price?: PlanPrice | null;
}

/** A subscription's price: amount in the currency's smallest unit (cents), e.g. 299 "usd" "month". */
export interface PlanPrice {
  amount: number;
  currency: string;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
}

/** The first item's price on a subscription, or null when it doesn't look like one. */
export function priceOf(sub: any): PlanPrice | null {
  const price = sub && sub.items && Array.isArray(sub.items.data) && sub.items.data[0] && sub.items.data[0].price;
  if (!price || typeof price !== "object") return null;
  const amount = price.unit_amount;
  const currency = typeof price.currency === "string" ? price.currency.toLowerCase() : "";
  const interval = price.recurring && price.recurring.interval;
  const count = price.recurring && price.recurring.interval_count;
  if (!Number.isInteger(amount) || amount < 0 || amount > 100000000) return null;
  if (!/^[a-z]{3}$/.test(currency)) return null;
  if (!["day", "week", "month", "year"].includes(interval)) return null;
  return { amount, currency, interval, intervalCount: Number.isInteger(count) && count > 0 && count < 1000 ? count : 1 };
}

const idOf = (v: unknown, prefix: string): string | undefined => {
  const id = typeof v === "string" ? v : v && typeof v === "object" ? (v as any).id : undefined;
  return typeof id === "string" && id.startsWith(prefix) && id.length < 255 ? id : undefined;
};

const uidOf = (meta: unknown): string | undefined => {
  const uid = meta && typeof meta === "object" ? (meta as any).uid : undefined;
  return typeof uid === "string" && uid.length > 0 && uid.length <= 200 ? uid : undefined;
};

/** When the current period ends: on the subscription in older API versions, on its items in newer ones. */
function periodEndOf(sub: any): number | null {
  if (typeof sub.current_period_end === "number") return sub.current_period_end;
  const items = sub.items && Array.isArray(sub.items.data) ? sub.items.data : [];
  const ends = items.map((i: any) => i && i.current_period_end).filter((n: unknown) => typeof n === "number");
  return ends.length ? Math.max(...ends) : null;
}

/**
 * A subscription set to end (2026-10-23, found in the sandbox test): newer API
 * versions (the account's 2026-09-30.endive among them) no longer set
 * cancel_at_period_end when someone cancels in the Customer Portal; they set
 * cancel_at, a date, to the end of the period instead. Either one means it
 * won't renew. Undoing the cancellation clears both.
 */
function cancelAtOf(sub: any): number | null {
  return typeof sub.cancel_at === "number" && sub.cancel_at > 0 ? sub.cancel_at : null;
}
function endingOf(sub: any): boolean {
  return sub.cancel_at_period_end === true || cancelAtOf(sub) !== null;
}
/** When Plus ends or renews: the cancel date when it's set and comes first, else the period's end. */
function endOf(sub: any): number | null {
  const end = periodEndOf(sub);
  const cancelAt = cancelAtOf(sub);
  return cancelAt !== null && (end === null || cancelAt < end) ? cancelAt : end;
}

const SUBSCRIPTION_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed"]);
export const HANDLED_EVENTS = ["checkout.session.completed", ...SUBSCRIPTION_EVENTS];

/**
 * The student and the change in a webhook event, or null for an event we
 * don't use or one that isn't ours (no uid in its metadata).
 */
export function updateFromEvent(event: any): BillingUpdate | null {
  const obj = event && event.data && event.data.object;
  if (!obj || typeof obj !== "object") return null;
  const created = typeof event.created === "number" ? event.created : 0;
  if (event.type === "checkout.session.completed") {
    if (obj.mode !== "subscription") return null;
    const uid = uidOf(obj.metadata) ?? (typeof obj.client_reference_id === "string" ? obj.client_reference_id : undefined);
    if (!uid) return null;
    const paid = obj.status === "complete" && (obj.payment_status === "paid" || obj.payment_status === "no_payment_required");
    return {
      uid,
      eventId: event.id,
      created,
      customerId: idOf(obj.customer, "cus_"),
      subscriptionId: idOf(obj.subscription, "sub_"),
      // The subscription's own events refine this (trialing, past_due, canceled...).
      status: paid ? "active" : undefined,
    };
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const uid = uidOf(obj.metadata);
    if (!uid) return null;
    return {
      uid,
      eventId: event.id,
      created,
      customerId: idOf(obj.customer, "cus_"),
      subscriptionId: idOf(obj.id, "sub_"),
      status: event.type === "customer.subscription.deleted" ? "canceled" : typeof obj.status === "string" ? obj.status : undefined,
      periodEnd: endOf(obj),
      cancelAtPeriodEnd: endingOf(obj),
      price: priceOf(obj),
    };
  }
  return null;
}

/* ── One student's record ───────────────────────────────────────────── */

export interface BillingRecord {
  customerId: string;
  subscriptionId: string;
  status: string;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** What they pay (2026-10-27). Missing on records from before then until the next subscription event. */
  price?: PlanPrice | null;
  /** The newest event applied (Unix seconds). */
  updatedAt: number;
  seen: string[];
}

/** Statuses that count as having Plus. past_due: Stripe is still retrying the card. */
export function hasPlus(status: string | undefined | null): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

export interface BillingStatus {
  plus: boolean;
  status: string;
  /** Milliseconds: when it renews, or ends if it's set to cancel. */
  renewsAt: number | null;
  cancelAtPeriodEnd: boolean;
  /** There's a Stripe customer, so "Manage plan" can open their page. */
  manageable: boolean;
  /** What they pay, when known (Settings > Plus shows it). Never card details: those stay on Stripe's page. */
  price: PlanPrice | null;
}

export function publicStatus(record: BillingRecord | null): BillingStatus {
  if (!record) return { plus: false, status: "none", renewsAt: null, cancelAtPeriodEnd: false, manageable: false, price: null };
  return {
    plus: hasPlus(record.status),
    status: record.status || "none",
    renewsAt: record.periodEnd ? record.periodEnd * 1000 : null,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    manageable: !!record.customerId,
    price: record.price ?? null,
  };
}

const RECORD_KEY = "billing";

/**
 * Runs inside the student's BillingStore (one at a time), so two webhooks for
 * the same student can't interleave.
 */
export class BillingAccount {
  storage: CanvaStorage;
  constructor(storage: CanvaStorage) {
    this.storage = storage;
  }

  async record(): Promise<BillingRecord | null> {
    const r = await this.storage.get<BillingRecord>(RECORD_KEY);
    return r && typeof r === "object" ? r : null;
  }

  async status(): Promise<BillingStatus> {
    return publicStatus(await this.record());
  }

  async customerId(): Promise<string | null> {
    return (await this.record())?.customerId || null;
  }

  /** Applies one webhook's change. Returns whether anything changed. */
  async apply(update: BillingUpdate): Promise<boolean> {
    const current = await this.record();
    if (current && current.seen.includes(update.eventId)) return false;
    const next: BillingRecord = current
      ? { ...current, seen: [...current.seen] }
      : { customerId: "", subscriptionId: "", status: "", periodEnd: null, cancelAtPeriodEnd: false, updatedAt: 0, seen: [] };
    next.seen = [...next.seen, update.eventId].slice(-SEEN_EVENTS_KEPT);

    const otherSubscription = !!(update.subscriptionId && next.subscriptionId && update.subscriptionId !== next.subscriptionId);
    let take = true;
    if (otherSubscription) {
      // A different subscription: a new one replaces the old, but an old one
      // ending (or failing) must not take away the one that's running.
      take = !(hasPlus(next.status) && !hasPlus(update.status));
    } else if (update.created < next.updatedAt) {
      // An older event about the same subscription arriving late.
      take = false;
    }

    if (update.customerId && !next.customerId) next.customerId = update.customerId;
    if (take) {
      if (update.customerId) next.customerId = update.customerId;
      if (update.subscriptionId) next.subscriptionId = update.subscriptionId;
      if (update.status) next.status = update.status;
      if (update.periodEnd !== undefined) next.periodEnd = update.periodEnd;
      if (update.cancelAtPeriodEnd !== undefined) next.cancelAtPeriodEnd = update.cancelAtPeriodEnd;
      if (update.price) next.price = update.price;
      next.updatedAt = Math.max(next.updatedAt, update.created);
    }
    await this.storage.put(RECORD_KEY, next);
    return take;
  }
}
