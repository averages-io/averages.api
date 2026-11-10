// The one record of how each part of Averages.io answered its last check (src/health.ts). US jurisdiction.

import { DurableObject } from "cloudflare:workers";
import type { HealthRecord } from "./health.ts";

export class HealthStore extends DurableObject {
  async read(): Promise<HealthRecord | null> {
    const rec = await this.ctx.storage.get<HealthRecord>("rec");
    return rec && typeof rec === "object" ? rec : null;
  }

  async write(rec: HealthRecord): Promise<void> {
    await this.ctx.storage.put("rec", rec);
  }
}
