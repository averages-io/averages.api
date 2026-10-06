/**
 * Server-side storage backing "Sync Across Devices."
 *
 * One JSON record per signed-in user, keyed by their stable Schoology `uid`,
 * holding `settings`: whatever opaque JSON blob the client pushes. This is the
 * Settings page's existing `schoolagy_settings_options`/`schoolagy_appearance`/
 * `schoolagy_course_custom`/etc. localStorage keys, merged client-side into
 * one object before it's PUT here. This module doesn't need to know that
 * shape — it just stores and returns whatever it's given — so a new
 * localStorage key the app starts syncing later needs no API change.
 *
 * (2026-10-06: the record used to also hold at most two Projected GPA
 * snapshots, `gpaSnapshot`, for the Weekly Grade Summary email's "vs last
 * week" line, written by `/data/bundle`. That email was replaced by browser
 * notifications on 2026-10-04 and never stored anything else, so the
 * snapshot, its rotation logic and the email toggle check are gone. A record
 * saved before this change may still carry `gpaSnapshot` (or the even older
 * `gpaHistory`): loadSyncRecord ignores both, so the next save drops them.)
 *
 * Deliberately shaped around a minimal KV-namespace-like interface
 * (`get`/`put`), not Hono-aware, so the logic here is unit-testable with a
 * plain in-memory fake. Since 2026-10-04 the real storage is a per-student
 * Durable Object in the US (syncStore.ts), wrapped as `KVLike` by
 * `kvFromSyncStore` below; this file's rules didn't change.
 *
 * Demo sessions never reach this module at all: every route in `index.ts`
 * checks `isDemoSession` first and refuses (403 `not_available_in_demo`)
 * before a KV call would happen — a demo session has no real Schoology uid to
 * key a record on and nothing of its own to sync. See the `/sync/*` handlers
 * in `index.ts`.
 */

export interface SyncRecord {
  settings: unknown;
  /**
   * Stamped on every write to this record. Deliberately NOT what the client
   * compares to decide whether to pull — see `settingsUpdatedAt` for that.
   * Kept mainly so a raw look at a stored record (or a future admin view)
   * has an obvious "last touched" field.
   */
  updatedAt: string;
  /**
   * Stamped ONLY when the `settings` half of this record actually changes
   * (index.ts's `PUT /sync/settings`). settings.html's pull logic compares
   * this one. (It was split from `updatedAt` when `/data/bundle` also wrote
   * GPA snapshots into this record on nearly every page load; since
   * 2026-10-06 nothing else writes here, but the field and its meaning stay
   * so the app's pull logic needs no change.)
   */
  settingsUpdatedAt: string;
}

/** Minimal shape of a Cloudflare Workers KV namespace binding. */
export interface KVLike {
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What sync.ts needs from the per-student Durable Object (see syncStore.ts). */
export interface SyncStoreLike {
  getRecord(key: string): Promise<string | null>;
  putRecord(key: string, value: string): Promise<void>;
  deleteRecord(key: string): Promise<void>;
}

/**
 * Wraps a student's Durable Object (syncStore.ts) as the same `KVLike` shape
 * the rest of this file was written against, so none of the sync rules had
 * to change when storage moved off Workers KV (2026-10-04).
 *
 * `getStore` is called inside each method rather than up front on purpose:
 * if the binding is missing or the object can't be reached, the error comes
 * back as a rejected promise the caller can catch, instead of a thrown error.
 * (`/data/bundle` relied on that while it read this record for the GPA
 * snapshot; since 2026-10-06 only the `/sync/settings` routes read it.)
 */
export function kvFromSyncStore(getStore: () => SyncStoreLike): KVLike {
  return {
    async get(key) {
      const raw = await getStore().getRecord(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null; // a damaged record reads as "nothing saved", same as KV did
      }
    },
    async put(key, value) {
      await getStore().putRecord(key, value);
    },
    async delete(key) {
      await getStore().deleteRecord(key);
    },
  };
}

function syncKey(uid: string): string {
  return `sync:${uid}`;
}

function emptyRecord(): SyncRecord {
  return { settings: null, updatedAt: "", settingsUpdatedAt: "" };
}

export async function loadSyncRecord(kv: KVLike, uid: string): Promise<SyncRecord> {
  const raw = await kv.get(syncKey(uid), "json");
  if (!raw || typeof raw !== "object") return emptyRecord();
  const record = raw as Partial<SyncRecord>;
  // Only these three fields are read back: an old record's `gpaSnapshot` or
  // `gpaHistory` (see the top of this file) is left behind, so the next save
  // writes the record without it.
  return {
    settings: record.settings ?? null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    // Missing on any record written before this field existed — that's the
    // exact "old, untimestamped record" case settings.html's pull logic
    // treats as untrustworthy rather than something to adopt. See the
    // field's own comment above.
    settingsUpdatedAt: typeof record.settingsUpdatedAt === "string" ? record.settingsUpdatedAt : "",
  };
}

export async function saveSyncRecord(
  kv: KVLike,
  uid: string,
  record: SyncRecord
): Promise<void> {
  // Exactly the three fields, whatever else the object passed in carries.
  const clean: SyncRecord = { settings: record.settings, updatedAt: record.updatedAt, settingsUpdatedAt: record.settingsUpdatedAt };
  await kv.put(syncKey(uid), JSON.stringify(clean));
}

export async function deleteSyncRecord(kv: KVLike, uid: string): Promise<void> {
  await kv.delete(syncKey(uid));
}
