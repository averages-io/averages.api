/**
 * Averages Plus routes (2026-10-21), mounted by index.ts. The Stripe calls
 * and the per-student record are in billing.ts; see there for the blueprint.
 *
 *   GET  /billing/status    { enabled, configured, eligible, plus, status, renewsAt, cancelAtPeriodEnd, manageable, price }
 *   POST /billing/checkout  {} -> { url }: Stripe's hosted checkout (Managed Payments)
 *   POST /billing/portal    {} -> { url }: Stripe's page to cancel or change the card
 *   POST /stripe/webhook    Stripe's events, signed with STRIPE_WEBHOOK_SECRET
 *
 * Checkout and the portal are behind the "billing" feature switch (off by
 * default; see flags.ts). Status and the webhook never are: a subscriber
 * keeps Plus while the switch is off, and Stripe's events are always recorded.
 *
 * Who can subscribe: a signed-in student, not the demo and not Incognito
 * (under-13 sessions are always Incognito, and Incognito stores nothing on
 * our servers, which a subscription needs). Managing an existing
 * subscription (the portal) is always allowed, Incognito included, so nobody
 * is ever stuck paying.
 */

import { Hono } from "hono";
import { isDemoSession, isIncognitoSession, type SessionData } from "./session.ts";
import {
  BillingError,
  billingConfigured,
  createCheckoutSession,
  createPortalSession,
  hasPlus,
  statusForBillingCode,
  updateFromEvent,
  verifyStripeSignature,
  webhookConfigured,
  WEBHOOK_MAX_BYTES,
  type BillingEnv,
  type BillingStatus,
  type BillingUpdate,
} from "./billing.ts";
import { featureOn } from "./flags.ts";

/** The BillingStore methods the routes use (a Durable Object stub in the Worker, the account itself in tests). */
export interface BillingStoreApi {
  status(): Promise<BillingStatus>;
  customerId(): Promise<string | null>;
  apply(update: BillingUpdate): Promise<boolean>;
}

export type BillingRouteEnv = BillingEnv & { BILLING?: DurableObjectNamespace };

export interface BillingDeps {
  requireSession: (c: any, next: () => Promise<void>) => Promise<Response | void>;
  fromOurApp: (c: any) => Response | null;
  /** Where the browser comes back to: app.averages.io, or the local app under wrangler dev. */
  appOrigin: (requestUrl: string) => string;
  storeFor: (env: BillingRouteEnv, uid: string, requestUrl: string) => BillingStoreApi;
}

function billingFailure(c: any, error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = message.match(/\bbilling_[a-z_]+/)?.[0] ?? fallback;
  // BillingErrors were already logged where they happened (without Stripe's text).
  if (!(error instanceof BillingError)) console.error(fallback, message);
  return c.json({ error: code }, statusForBillingCode(code));
}

export function billingRoutes(deps: BillingDeps) {
  const app = new Hono<{ Bindings: BillingRouteEnv; Variables: { session: SessionData } }>();
  const noStore = (c: any) => c.header("Cache-Control", "private, no-store");

  app.get("/status", deps.requireSession, async (c) => {
    noStore(c);
    const session = c.get("session");
    const enabled = featureOn(c.env, "billing");
    const configured = billingConfigured(c.env) && !!c.env.BILLING;
    const base = { enabled, configured, eligible: !isDemoSession(session) && !isIncognitoSession(session) };
    const none: BillingStatus = { plus: false, status: "none", renewsAt: null, cancelAtPeriodEnd: false, manageable: false, price: null };
    if (isDemoSession(session) || !c.env.BILLING) return c.json({ ...base, ...none });
    try {
      return c.json({ ...base, ...(await deps.storeFor(c.env, session.uid, c.req.url).status()) });
    } catch (error) {
      return billingFailure(c, error, "billing_unavailable");
    }
  });

  app.post("/checkout", deps.requireSession, async (c) => {
    const foreign = deps.fromOurApp(c);
    if (foreign) return foreign;
    noStore(c);
    const session = c.get("session");
    if (isDemoSession(session)) return c.json({ error: "not_available_in_demo" }, 403);
    if (isIncognitoSession(session)) return c.json({ error: "incognito_mode" }, 403);
    if (!billingConfigured(c.env) || !c.env.BILLING) return c.json({ error: "billing_not_configured" }, 503);
    try {
      const store = deps.storeFor(c.env, session.uid, c.req.url);
      const current = await store.status();
      if (hasPlus(current.status)) return c.json({ error: "billing_already_subscribed" }, 409);
      const checkout = await createCheckoutSession(c.env, {
        uid: session.uid,
        appOrigin: deps.appOrigin(c.req.url),
        customerId: await store.customerId(),
      });
      return c.json({ url: checkout.url });
    } catch (error) {
      return billingFailure(c, error, "billing_checkout_failed");
    }
  });

  app.post("/portal", deps.requireSession, async (c) => {
    const foreign = deps.fromOurApp(c);
    if (foreign) return foreign;
    noStore(c);
    const session = c.get("session");
    if (isDemoSession(session)) return c.json({ error: "not_available_in_demo" }, 403);
    if (!billingConfigured(c.env) || !c.env.BILLING) return c.json({ error: "billing_not_configured" }, 503);
    try {
      const customerId = await deps.storeFor(c.env, session.uid, c.req.url).customerId();
      if (!customerId) return c.json({ error: "billing_no_account" }, 404);
      return c.json({ url: await createPortalSession(c.env, { customerId, appOrigin: deps.appOrigin(c.req.url) }) });
    } catch (error) {
      return billingFailure(c, error, "billing_portal_failed");
    }
  });

  return app;
}

/**
 * POST /stripe/webhook: no session and no Origin (it's Stripe calling). The
 * signature is the only thing that matters, so it's checked before anything
 * else is read. Answers 200 for events we don't use (Stripe stops resending
 * them) and 500 when storing fails (Stripe tries again later).
 */
export function stripeWebhookRoutes(deps: Pick<BillingDeps, "storeFor"> & {
  /**
   * Plus just ended for this student (2026-10-21): their Plus perks that keep
   * something on our servers (notifications, the calendar link) are deleted.
   * Run after the response; must not throw.
   */
  onPlusEnded?: (env: any, uid: string, requestUrl: string) => Promise<void>;
}) {
  const app = new Hono<{ Bindings: BillingRouteEnv }>();
  app.post("/webhook", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!webhookConfigured(c.env) || !c.env.BILLING) return c.json({ error: "billing_not_configured" }, 503);
    if (Number(c.req.header("Content-Length") ?? 0) > WEBHOOK_MAX_BYTES) return c.json({ error: "too_large" }, 413);
    const payload = await c.req.text();
    if (payload.length > WEBHOOK_MAX_BYTES) return c.json({ error: "too_large" }, 413);
    const event = await verifyStripeSignature(payload, c.req.header("Stripe-Signature"), c.env.STRIPE_WEBHOOK_SECRET!);
    if (!event) return c.json({ error: "bad_signature" }, 400);
    const update = updateFromEvent(event);
    if (!update) return c.json({ received: true, used: false });
    try {
      const store = deps.storeFor(c.env, update.uid, c.req.url);
      const before = await store.status();
      const changed = await store.apply(update);
      if (changed && deps.onPlusEnded && hasPlus(before.status)) {
        const after = await store.status();
        if (!hasPlus(after.status)) {
          const ended = deps.onPlusEnded(c.env, update.uid, c.req.url).catch(() => {});
          try { c.executionCtx.waitUntil(ended); } catch { await ended; }
        }
      }
      return c.json({ received: true, used: true });
    } catch (error) {
      console.error("billing: storing a webhook failed", event.type, error instanceof Error ? error.message : "");
      return c.json({ error: "store_failed" }, 500);
    }
  });
  return app;
}
