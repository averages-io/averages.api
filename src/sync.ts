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
  /** The day (days since 1970, UTC) each seen id was first marked seen. See SEEN_DAYS. */
  seenAt?: SeenDays;
}

export type SeenLists = Partial<Record<(typeof SEEN_KINDS)[number], string[]>>;
export type SeenDays = Partial<Record<(typeof SEEN_KINDS)[number], Record<string, number>>>;
/**
 * Only the last 15 days of seen ids are kept. Anything older counts as seen on every device
 * anyway (the app treats an update, grade, message, assignment or file over 15 days old as not new), so its
 * id is dropped. Something can't be seen before it's posted, so an id marked seen 15+ days ago belongs to
 * something at least that old. Ids that come without a day (older records, the Windowed bell) start today.
 */
export const SEEN_DAYS = 15;
export function dayOf(ms: number = Date.now()): number {
  return Math.floor(ms / 86_400_000);
}
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

/** A day for every seen id: the one given (if it's a sensible day, not in the future), else today. The later of two wins. */
export function seenDays(seen: SeenLists, ...given: unknown[]): SeenDays {
  const today = dayOf(), out: SeenDays = {};
  for (const k of SEEN_KINDS) {
    const ids = seen[k];
    if (!ids || !ids.length) continue;
    const m: Record<string, number> = {};
    for (const id of ids) {
      let best = -1;
      for (const g of given) {
        const v = g && typeof g === "object" ? (g as Record<string, Record<string, unknown>>)[k]?.[id] : undefined;
        if (typeof v === "number" && Number.isInteger(v) && v <= today && v > today - 3650 && v > best) best = v;
      }
      m[id] = best >= 0 ? best : today;
    }
    out[k] = m;
  }
  return out;
}
/** The seen ids and their days without anything marked seen more than SEEN_DAYS ago. */
export function pruneSeen(seen: SeenLists, at: SeenDays, today: number = dayOf()): { seen: SeenLists; seenAt: SeenDays } {
  const out: SeenLists = {}, outAt: SeenDays = {};
  for (const k of SEEN_KINDS) {
    const keep = (seen[k] ?? []).filter((id) => (at[k]?.[id] ?? today) >= today - SEEN_DAYS);
    if (keep.length) { out[k] = keep; outAt[k] = Object.fromEntries(keep.map((id) => [id, at[k]?.[id] ?? today])); }
  }
  return { seen: out, seenAt: outAt };
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
        return null; // a damaged record reads as "nothing saved", same as the old store did
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
    ...(() => { const seen = cleanSeen(record.seen); return pruneSeen(seen, seenDays(seen, record.seenAt)); })(),
  };
}

export async function saveSyncRecord(
  kv: KVLike,
  uid: string,
  record: SyncRecord
): Promise<void> {
  // Exactly these fields, whatever else the object passed in carries.
  const seen = cleanSeen(record.seen), kept = pruneSeen(seen, seenDays(seen, record.seenAt));
  const clean: SyncRecord = { settings: record.settings, updatedAt: record.updatedAt, settingsUpdatedAt: record.settingsUpdatedAt, seen: kept.seen, seenAt: kept.seenAt };
  await kv.put(syncKey(uid), JSON.stringify(clean));
}

export async function deleteSyncRecord(kv: KVLike, uid: string): Promise<void> {
  await kv.delete(syncKey(uid));
}
