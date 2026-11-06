// Server-side storage backing "Sync Across Devices." One JSON record per signed-in user.

export interface SyncRecord {
  settings: unknown;
  /**
   * Stamped on every write to this record. Deliberately NOT what the client
   * compares to decide whether to pull — see `settingsUpdatedAt` for that.
   * Kept mainly so a raw look at a stored record (or a future admin view)
   * has an obvious "last touched" field.
   */
  updatedAt: string;
  settingsUpdatedAt: string;
  seen?: SeenLists;
}

export type SeenLists = Partial<Record<(typeof SEEN_KINDS)[number], string[]>>;
export const SEEN_KINDS = ["u", "g", "m", "a", "f"] as const;
export const SEEN_CAP = 300;
const SEEN_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Only well-formed lists: the three kinds, ids that look like ids, the newest SEEN_CAP of each. */
export function cleanSeen(raw: unknown): SeenLists {
  const out: SeenLists = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of SEEN_KINDS) {
    const list = (raw as Record<string, unknown>)[k];
    if (!Array.isArray(list)) continue;
    const ids = [...new Set(list.map(String).filter((id) => SEEN_ID_RE.test(id)))];
    if (ids.length) out[k] = ids.slice(-SEEN_CAP);
  }
  return out;
}

/** The stored lists plus new ones: everything seen anywhere stays seen (older ones drop off past SEEN_CAP). */
export function mergeSeen(stored: unknown, incoming: unknown): SeenLists {
  const a = cleanSeen(stored), b = cleanSeen(incoming), out: SeenLists = {};
  for (const k of SEEN_KINDS) {
    const ids = [...new Set([...(a[k] ?? []), ...(b[k] ?? [])])];
    if (ids.length) out[k] = ids.slice(-SEEN_CAP);
  }
  return out;
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
    seen: cleanSeen(record.seen),
  };
}

export async function saveSyncRecord(
  kv: KVLike,
  uid: string,
  record: SyncRecord
): Promise<void> {
  // Exactly these fields, whatever else the object passed in carries.
  const clean: SyncRecord = { settings: record.settings, updatedAt: record.updatedAt, settingsUpdatedAt: record.settingsUpdatedAt, seen: cleanSeen(record.seen) };
  await kv.put(syncKey(uid), JSON.stringify(clean));
}

export async function deleteSyncRecord(kv: KVLike, uid: string): Promise<void> {
  await kv.delete(syncKey(uid));
}
