// One Durable Object per student for Averages Plus: their Stripe customer and subscription ids and the subscription's status.

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
