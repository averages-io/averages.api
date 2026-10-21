/**
 * Who has Averages Plus, for the Plus perks (2026-10-21, Martin: "build
 * everything like connected to plus").
 *
 *   Browser notifications  need Plus while billing is on and set up
 *                          (plusRequired); with billing off they stay free,
 *                          as before Plus existed.
 *   Calendar sync          always needs Plus (it's new; nobody had it free).
 *   Early access           a switch in the early list is on for Plus members
 *                          before everyone (flags.ts earlyKeys).
 *
 * The answer comes from the student's BillingStore (src/billingStore.ts),
 * which Stripe's webhook keeps current. A store that can't be reached throws:
 * callers decide whether that refuses (turning something on) or waits
 * (background checks never delete anything over an outage).
 */

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

/** Whether this student has Plus right now. Throws when the store can't be reached. */
export async function hasPlusNow(env: PlusEnv, uid: string, requestUrl: string, storeFor: PlusStoreFor = billingStoreFor): Promise<boolean> {
  if (!env.BILLING && storeFor === billingStoreFor) return false;
  const status = await storeFor(env, uid, requestUrl).status();
  return hasPlus(status?.status);
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
