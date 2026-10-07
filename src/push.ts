/**
 * Browser notification routes (2026-10-05), mounted by index.ts with
 * `app.route("/push", pushRoutes({...}))`. The work happens in the student's
 * PushStore (src/pushStore.ts); what changed is worked out in src/notify.ts.
 *
 *   GET    /push/config      public: { publicKey } (null until set up)
 *   POST   /push/subscribe   { subscription, types }: turn on for this browser
 *   DELETE /push/subscribe   { endpoint }: turn off for this browser (the last
 *                            one off deletes everything)
 *   DELETE /push             everything, every browser
 *   PUT    /push/types       { types } (only the switches sent change)
 *   POST   /push/test        { endpoint }: a test notification to this browser
 *   POST   /push/touch       keep the stored sign-in in step with this session
 *   POST   /push/status      { endpoint }: on? on in this browser? which types?
 *
 * Only for opted-in students: the demo has no account behind it and Incognito
 * stores nothing on our servers, so both are refused (deleting stays allowed
 * in Incognito: deleting is always fine). State-changing calls must come from
 * our own app (deps.fromOurApp: allowed Origin, JSON for POSTs).
 */

import { Hono } from "hono";
import { DEMO_UID, isDemoSession, isIncognitoSession, sealValue, type SessionData } from "./session.ts";
import { DEFAULT_TYPES, parseTypeChanges, parseTypes, type NotifyTypes } from "./notify.ts";
import {
  cleanSubscription,
  PUSH_PURPOSE,
  pushConfigured,
  pushStoreFor,
  vapidFrom,
  type PushEnv,
  type PushStatus,
  type TestResult,
} from "./pushStore.ts";
import type { PushSubscriptionLike } from "./webpush.ts";
import { safeTimeZone } from "./classroom.ts";

/** The PushStore methods the routes use (a Durable Object stub in the Worker, the object itself in tests). */
export interface PushStoreApi {
  subscribe(input: { subscription: PushSubscriptionLike; types: NotifyTypes; sealed: string; exp: number; tz?: string }): Promise<PushStatus>;
  setTypes(changes: Partial<NotifyTypes>): Promise<PushStatus | null>;
  unsubscribe(endpoint: string): Promise<PushStatus>;
  deleteAll(): Promise<void>;
  touch(input: { sealed: string; exp: number }): Promise<boolean>;
  test(endpoint: string): Promise<TestResult>;
  status(endpoint?: string): Promise<PushStatus>;
}

export type StoreFor = (env: PushEnv, uid: string, requestUrl: string) => PushStoreApi;

export interface PushDeps {
  /** index.ts's requireSession: 401s without a valid session, else sets c.get("session"). */
  requireSession: (c: any, next: () => Promise<void>) => Promise<Response | void>;
  /** index.ts's notFromOurApp: a Response to send for a foreign Origin or a non-JSON POST, else null. */
  fromOurApp: (c: any) => Response | null;
  /** This student's PushStore; defaults to pushStoreFor (the "us" jurisdiction). */
  storeFor?: StoreFor;
}

const defaultStoreFor: StoreFor = (env, uid, requestUrl) => pushStoreFor(env, uid, requestUrl) as unknown as PushStoreApi;

const TEST_STATUS: Record<string, number> = {
  push_not_configured: 503,
  not_subscribed: 404,
  too_soon: 429,
  subscription_gone: 410,
  push_failed: 502,
};

async function jsonBody(c: any): Promise<any> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** A push endpoint from a request body: a string of sensible length, else "". */
function endpointFrom(body: any): string {
  const e = body?.endpoint;
  return typeof e === "string" && e.length > 0 && e.length <= 2048 ? e : "";
}

/**
 * The stored sign-in: this session, sealed with PUSH_SECRET, expiring when the
 * session does. Null when the session has already run out.
 */
async function sealCredential(session: SessionData, secret: string): Promise<{ sealed: string; exp: number } | null> {
  const ttl = session.exp - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return { sealed: await sealValue(JSON.stringify(session), secret, PUSH_PURPOSE, ttl), exp: session.exp };
}

export function pushRoutes(deps: PushDeps) {
  const storeFor = deps.storeFor ?? defaultStoreFor;
  const app = new Hono<{ Bindings: PushEnv; Variables: { session: SessionData } }>();
  const noStore = (c: any) => c.header("Cache-Control", "private, no-store");

  /** A store call that failed (the Durable Object unreachable, say): 502, logged. */
  const unavailable = (c: any, err: unknown) => {
    console.error("push_store_failed", err instanceof Error ? err.message : String(err));
    return c.json({ error: "push_unavailable" }, 502);
  };

  /** Refusals shared by the routes that turn things on or use the stored sign-in. */
  const gate = (c: any, opts: { incognitoOk?: boolean; needsConfig?: boolean } = {}) => {
    const foreign = deps.fromOurApp(c);
    if (foreign) return foreign;
    const session: SessionData = c.get("session");
    if (isDemoSession(session)) return c.json({ error: "not_available_in_demo" }, 403);
    if (!opts.incognitoOk && isIncognitoSession(session)) return c.json({ error: "incognito_mode" }, 403);
    if (opts.needsConfig && !pushConfigured(c.env)) return c.json({ error: "push_not_configured" }, 503);
    return null;
  };

  /** The VAPID public key the browser subscribes with, or null (the app then says Coming soon). */
  app.get("/config", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ publicKey: pushConfigured(c.env) ? vapidFrom(c.env)!.publicKey : null });
  });

  app.post("/subscribe", deps.requireSession, async (c) => {
    const blocked = gate(c, { needsConfig: true });
    if (blocked) return blocked;
    noStore(c);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "invalid_body" }, 400);
    const subscription = cleanSubscription(body.subscription);
    if (!subscription) return c.json({ error: "bad_subscription" }, 400);
    // Only the five known switches; anything else (or no types at all) is ignored.
    const types = parseTypes(body.types) ?? { ...DEFAULT_TYPES };
    const session = c.get("session");
    const credential = await sealCredential(session, c.env.PUSH_SECRET!);
    if (!credential) return c.json({ error: "session_expired" }, 401);
    try {
      // The student's time zone (2026-10-07): Schoology due times are local, so "due within a day" needs it.
      const tz = safeTimeZone(body.tz, (c.req.raw as any)?.cf?.timezone);
      const status = await storeFor(c.env, session.uid, c.req.url).subscribe({ subscription, types, tz, ...credential });
      return c.json({ ok: true, ...status });
    } catch (err) {
      return unavailable(c, err);
    }
  });

  app.delete("/subscribe", deps.requireSession, async (c) => {
    const blocked = gate(c, { incognitoOk: true });
    if (blocked) return blocked;
    noStore(c);
    const endpoint = endpointFrom(await jsonBody(c));
    if (!endpoint) return c.json({ error: "bad_request" }, 400);
    try {
      const status = await storeFor(c.env, c.get("session").uid, c.req.url).unsubscribe(endpoint);
      return c.json({ ok: true, ...status });
    } catch (err) {
      return unavailable(c, err);
    }
  });

  app.delete("/", deps.requireSession, async (c) => {
    const blocked = gate(c, { incognitoOk: true });
    if (blocked) return blocked;
    noStore(c);
    try {
      await storeFor(c.env, c.get("session").uid, c.req.url).deleteAll();
      return c.json({ ok: true });
    } catch (err) {
      return unavailable(c, err);
    }
  });

  app.put("/types", deps.requireSession, async (c) => {
    const blocked = gate(c);
    if (blocked) return blocked;
    noStore(c);
    // Only the five known switches; the ones not sent stay as they are.
    const types = parseTypeChanges((await jsonBody(c))?.types);
    if (!types) return c.json({ error: "bad_types" }, 400);
    try {
      const status = await storeFor(c.env, c.get("session").uid, c.req.url).setTypes(types);
      if (!status) return c.json({ error: "not_subscribed" }, 404);
      return c.json({ ok: true, ...status });
    } catch (err) {
      return unavailable(c, err);
    }
  });

  app.post("/test", deps.requireSession, async (c) => {
    const blocked = gate(c, { needsConfig: true });
    if (blocked) return blocked;
    noStore(c);
    const endpoint = endpointFrom(await jsonBody(c));
    if (!endpoint) return c.json({ error: "bad_request" }, 400);
    try {
      const result = await storeFor(c.env, c.get("session").uid, c.req.url).test(endpoint);
      if (result.ok) return c.json({ ok: true });
      return c.json({ error: result.code }, (TEST_STATUS[result.code] ?? 502) as any);
    } catch (err) {
      return unavailable(c, err);
    }
  });

  /**
   * The app posts this at most once a day while notifications are on in its
   * browser: the stored sign-in becomes this session's (when it lasts at
   * least as long). Nothing stored, nothing done: `on: false` tells the
   * browser its notifications were turned off meanwhile.
   */
  app.post("/touch", deps.requireSession, async (c) => {
    const blocked = gate(c, { needsConfig: true });
    if (blocked) return blocked;
    noStore(c);
    const credential = await sealCredential(c.get("session"), c.env.PUSH_SECRET!);
    if (!credential) return c.json({ error: "session_expired" }, 401);
    try {
      const on = await storeFor(c.env, c.get("session").uid, c.req.url).touch(credential);
      return c.json({ ok: true, on });
    } catch (err) {
      return unavailable(c, err);
    }
  });

  /**
   * Whether notifications are on, and on in the asking browser. A POST so the
   * endpoint stays out of URLs and logs. Demo and Incognito are simply off.
   */
  app.post("/status", deps.requireSession, async (c) => {
    const foreign = deps.fromOurApp(c);
    if (foreign) return foreign;
    noStore(c);
    const session: SessionData = c.get("session");
    const off = { on: false, here: false, devices: 0, types: null, checkedAt: null };
    if (isDemoSession(session) || isIncognitoSession(session)) return c.json({ ...off, configured: pushConfigured(c.env) });
    if (!pushConfigured(c.env)) return c.json({ ...off, configured: false });
    const endpoint = endpointFrom(await jsonBody(c));
    try {
      const status = await storeFor(c.env, session.uid, c.req.url).status(endpoint || undefined);
      return c.json({ ...status, configured: true });
    } catch (err) {
      return unavailable(c, err);
    }
  });

  return app;
}

/**
 * Signing out (DELETE /auth/session) deletes the student's stored sign-in and
 * every browser's subscription right away. Never throws: signing out must
 * work even if this doesn't.
 */
export async function forgetPush(env: PushEnv, uid: string, requestUrl: string, storeFor?: StoreFor): Promise<void> {
  if (!uid || uid === DEMO_UID) return;
  if (!storeFor && !env.PUSH) return; // not deployed with the PUSH binding yet
  try {
    await (storeFor ?? defaultStoreFor)(env, uid, requestUrl).deleteAll();
  } catch (err) {
    console.error("push_forget_failed", err instanceof Error ? err.message : String(err));
  }
}
