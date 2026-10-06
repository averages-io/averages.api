/**
 * Storage for "Sync Across Devices": one small Durable Object per student.
 *
 * Replaces the SYNC_KV namespace (deleted 2026-10-01). Workers KV copies
 * values to Cloudflare locations worldwide, which conflicts with PowerSchool's
 * US-only data rule (developer terms §3.2.1). A Durable Object created in the
 * "us" jurisdiction keeps both its stored data and the code that touches it
 * inside the United States. See index.ts's `syncKV()` for where that
 * jurisdiction is applied.
 *
 * SQLite-backed (see `new_sqlite_classes` in wrangler.jsonc), which is what
 * the Workers Free plan supports. It uses the Durable Object key-value storage
 * API, so each object holds just one key: that student's sync record, the
 * same JSON string sync.ts used to write to KV.
 *
 * It only stores and returns strings. All of the rules (what a record looks
 * like) stay in sync.ts.
 */

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
