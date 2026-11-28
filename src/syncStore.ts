// Storage for "Sync Across Devices": one small Durable Object per student.

import { DurableObject } from "cloudflare:workers";

export class SyncStore extends DurableObject {
  /** The stored string, or null when nothing is saved. */
  async getRecord(key: string): Promise<string | null> {
    const value = await this.ctx.storage.get<string>(key);
    return typeof value === "string" ? value : null;
  }

  async putRecord(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  /**
   * Deletes the record and everything else this object holds, so turning sync
   * off leaves nothing behind for this student.
   */
  async deleteRecord(_key: string): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
