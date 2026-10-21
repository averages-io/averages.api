/**
 * One Durable Object per student for Averages Plus (2026-10-21): their Stripe
 * customer and subscription ids and the subscription's status. Opened in the
 * "us" jurisdiction like every other store (PowerSchool developer terms
 * §3.2.1).
 *
 * Separate from the others on purpose: signing out, turning Sync off or
 * switching to Incognito wipe those, but a subscription is still running and
 * still being paid for, so its record has to stay. The logic is
 * billing.ts's BillingAccount, which the tests drive with in-memory storage.
 */

import { DurableObject } from "cloudflare:workers";
import { BillingAccount, type BillingRecord, type BillingStatus, type BillingUpdate } from "./billing.ts";

export class BillingStore extends DurableObject {
  account: BillingAccount;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as any);
    this.account = new BillingAccount(ctx.storage);
  }

  record(): Promise<BillingRecord | null> {
    return this.account.record();
  }
  status(): Promise<BillingStatus> {
    return this.account.status();
  }
  customerId(): Promise<string | null> {
    return this.account.customerId();
  }
  apply(update: BillingUpdate): Promise<boolean> {
    return this.account.apply(update);
  }
}
