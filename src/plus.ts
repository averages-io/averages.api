// Who has Averages Plus, for the Plus perks.

import { billingConfigured, hasPlus, type BillingEnv, type BillingStatus } from "./billing.ts";
import { featureOn } from "./flags.ts";

export type PlusEnv = BillingEnv & { BILLING?: DurableObjectNamespace; FEATURES?: unknown };

/** The BillingStore method this needs (a Durable Object stub in the Worker, an account in tests). */
export interface PlusAccount {
  status(): Promise<BillingStatus>;
}
export type PlusStoreFor = (env: PlusEnv, uid: string, requestUrl: string) => PlusAccount;

/** True only when this Worker is being reached on localhost (`wrangler dev`). Same rule as index.ts. */
function isLocalRequest(requestUrl: string): boolean {
  try {
    const { hostname } = new URL(requestUrl);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * This student's BillingStore, in the "us" jurisdiction (local dev excepted,
 * decided from the request's own URL). Background work with no request passes
 * the API's own address.
 */
export function billingStoreFor(env: PlusEnv, uid: string, requestUrl: string): PlusAccount {
  if (!env.BILLING) throw new Error("billing_not_bound");
  const ns = isLocalRequest(requestUrl) ? env.BILLING : env.BILLING.jurisdiction("us" as DurableObjectJurisdiction);
  return ns.get(ns.idFromName(uid)) as unknown as PlusAccount;
}

/** Billing is on (the switch) and set up (key and store): Plus perks need Plus. */
export function plusRequired(env: PlusEnv, billingSwitch: boolean = featureOn(env, "billing")): boolean {
  return billingSwitch && billingConfigured(env) && !!env.BILLING;
}

/**
 * Answers kept in this Worker's memory for a little while, to keep it cheap. Every live-grades check (every 2 minutes per open tab) asked the student's billing store, one
 * Durable Object request each time. Now a "yes" is kept 5 minutes and a "no" 1 minute, so a new subscriber gets the
 * perks within a minute and a cancelled one loses them within five. Only this Worker instance's memory, never
 * stored; Settings' own Plus check still asks the store every time.
 */
const PLUS_SEEN_BY = new WeakMap<object, Map<string, { plus: boolean; at: number }>>();   // per billing namespace
const PLUS_KEEP_YES_MS = 5 * 60_000, PLUS_KEEP_NO_MS = 60_000, PLUS_SEEN_MAX = 5000;
let PLUS_SEEN_ALL: Map<string, { plus: boolean; at: number }>[] = [];
function plusSeen(env: PlusEnv): Map<string, { plus: boolean; at: number }> | null {
  const key = env.BILLING as unknown as object | undefined;
  if (!key) return null;
  let m = PLUS_SEEN_BY.get(key);
  if (!m) { m = new Map(); PLUS_SEEN_BY.set(key, m); PLUS_SEEN_ALL = [...PLUS_SEEN_ALL.slice(-3), m]; }
  return m;
}
export function forgetPlus(uid?: string): void {
  for (const m of PLUS_SEEN_ALL) { if (uid === undefined) m.clear(); else m.delete(uid); }
}

/** Whether this student has Plus right now (see PLUS_SEEN). Throws when the store can't be reached. */
export async function hasPlusNow(env: PlusEnv, uid: string, requestUrl: string, storeFor: PlusStoreFor = billingStoreFor): Promise<boolean> {
  if (!env.BILLING && storeFor === billingStoreFor) return false;
  const seen = storeFor === billingStoreFor ? plusSeen(env) : null, now = Date.now(), hit = seen?.get(uid);
  if (hit && now - hit.at < (hit.plus ? PLUS_KEEP_YES_MS : PLUS_KEEP_NO_MS)) return hit.plus;
  const status = await storeFor(env, uid, requestUrl).status();
  const plus = hasPlus(status?.status);
  if (seen) {
    if (seen.size >= PLUS_SEEN_MAX) seen.delete(seen.keys().next().value as string);
    seen.set(uid, { plus, at: now });
  }
  return plus;
}

/**
 * Notifications for this student: allowed unless Plus is required and they
 * don't have it. `required` and `plus` are reported so the app can say why.
 */
export async function notificationsPlus(
  env: PlusEnv,
  uid: string,
  requestUrl: string,
  opts: { billingSwitch?: boolean; storeFor?: PlusStoreFor } = {}
): Promise<{ required: boolean; plus: boolean; allowed: boolean }> {
  const required = plusRequired(env, opts.billingSwitch ?? featureOn(env, "billing"));
  if (!required) return { required, plus: false, allowed: true };
  const plus = await hasPlusNow(env, uid, requestUrl, opts.storeFor);
  return { required, plus, allowed: plus };
}
