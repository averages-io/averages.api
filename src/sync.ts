/**
 * Server-side storage backing "Sync Across Devices."
 *
 * One JSON record per signed-in user, keyed by their stable Schoology `uid`,
 * holding two things:
 *
 *   - `settings` — whatever opaque JSON blob the client pushes. This is the
 *     Settings page's existing `schoolagy_settings_options`/`schoolagy_appearance`/
 *     `schoolagy_course_custom`/etc. localStorage keys, merged client-side into
 *     one object before it's PUT here. This module doesn't need to know that
 *     shape — it just stores and returns whatever it's given — so a new
 *     localStorage key the app starts syncing later needs no API change.
 *   - `gpaHistory` — weekly Projected GPA snapshots (see `recordGpaSnapshot`
 *     below), one per ISO week, capped to `MAX_GPA_HISTORY` entries. This is
 *     what lets a future weekly-report email say "+0.07 vs last week"
 *     without a separate storage system: `index.ts`'s `/data/bundle` handler
 *     appends a snapshot here on every real (non-demo) load for a user who
 *     has sync turned on, piggybacking on data it already computed rather
 *     than needing its own fetch/cron cycle to know a course's grades.
 *
 * Deliberately shaped around a minimal KV-namespace-like interface
 * (`get`/`put`), not Hono-aware, so the logic here is unit-testable with a
 * plain in-memory fake — same reasoning as `domains.ts`. A real Cloudflare KV
 * binding satisfies `KVLike` as-is.
 *
 * Demo sessions never reach this module at all: every route in `index.ts`
 * checks `isDemoSession` first and refuses (403 `not_available_in_demo`)
 * before a KV call would happen — a demo session has no real Schoology uid to
 * key a record on and nothing of its own to sync. See the `/sync/*` and
 * `/data/bundle` handlers in `index.ts`.
 *
 * **Not built yet, on purpose:** this module only stores the snapshots. It
 * does not send any email, and there is no Cron Trigger. Actually delivering
 * a weekly email needs an email-sending provider (SendGrid/Resend/etc., a
 * secret Martin would need to provision) and — the bigger decision — a Cron
 * Trigger has to run without a browser open, so it can't reuse the session
 * cookie flow at all; it would need to look up a Schoology key/secret for
 * every subscribed user on its own, which means storing those long-term
 * server-side instead of only inside each user's own encrypted session
 * cookie. That's the reversal of `session.ts`'s current "this Worker keeps no
 * database, nothing to breach" design flagged earlier — a real decision for
 * Martin to make deliberately, not something to back into as a side effect of
 * this storage layer. What's built here is the prerequisite either way: a
 * place to keep the history so that decision doesn't also block on "and we
 * have no 'last week' number to show."
 */

export interface GpaSnapshot {
  /** ISO week, e.g. "2026-W37" — at most one snapshot per user per week. */
  isoWeek: string;
  /** The calendar date (YYYY-MM-DD) the snapshot was actually recorded. */
  date: string;
  gpa: number;
}

export interface SyncRecord {
  settings: unknown;
  gpaHistory: GpaSnapshot[];
  updatedAt: string;
}

/** Minimal shape of a Cloudflare Workers KV namespace binding. */
export interface KVLike {
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** ~3 months of weekly snapshots — enough for a real trend, small enough to never need pagination. */
export const MAX_GPA_HISTORY = 12;

function syncKey(uid: string): string {
  return `sync:${uid}`;
}

function emptyRecord(): SyncRecord {
  return { settings: null, gpaHistory: [], updatedAt: "" };
}

export async function loadSyncRecord(kv: KVLike, uid: string): Promise<SyncRecord> {
  const raw = await kv.get(syncKey(uid), "json");
  if (!raw || typeof raw !== "object") return emptyRecord();
  const record = raw as Partial<SyncRecord>;
  return {
    settings: record.settings ?? null,
    gpaHistory: Array.isArray(record.gpaHistory) ? record.gpaHistory : [],
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

export async function saveSyncRecord(
  kv: KVLike,
  uid: string,
  record: SyncRecord
): Promise<void> {
  await kv.put(syncKey(uid), JSON.stringify(record));
}

export async function deleteSyncRecord(kv: KVLike, uid: string): Promise<void> {
  await kv.delete(syncKey(uid));
}

/**
 * ISO 8601 week number for a date, e.g. `isoWeekOf(new Date("2026-09-08"))`
 * -> `"2026-W37"`. Standard "nearest Thursday" algorithm — the ISO week a
 * date falls in is the week containing that date's Thursday, which is what
 * makes the first/last week of a year come out right at the boundary instead
 * of off-by-one against a plain "days since Jan 1" count.
 */
export function isoWeekOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Monday=1 .. Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * Records (or, within the same ISO week, overwrites) this week's Projected
 * GPA snapshot and returns the updated record plus the comparison a weekly
 * email would need.
 *
 * One snapshot per user per ISO week, not per request — `/data/bundle` can
 * be hit many times a day; without the same-week overwrite, a user who
 * reloads the app five times on Monday would get five history entries
 * instead of one, and "last week" would end up meaning "the last page load"
 * rather than an actual week ago.
 *
 * "Last week" is deliberately the most recent snapshot strictly before this
 * one, not literally `isoWeek - 1`: a user who didn't open the app for two
 * weeks still gets a real comparison against their last known value instead
 * of a false "no data"/"+0.00" for the gap week.
 */
export function recordGpaSnapshot(
  record: SyncRecord,
  gpa: number,
  now: Date = new Date()
): {
  record: SyncRecord;
  current: number;
  lastWeek: number | null;
  deltaVsLastWeek: number | null;
} {
  const isoWeek = isoWeekOf(now);
  const priorWeeks = record.gpaHistory.filter((s) => s.isoWeek !== isoWeek);
  const previous =
    [...priorWeeks].sort((a, b) => (a.isoWeek < b.isoWeek ? 1 : -1))[0] ?? null;

  const snapshot: GpaSnapshot = { isoWeek, date: now.toISOString().slice(0, 10), gpa };
  const gpaHistory = [...priorWeeks, snapshot]
    .sort((a, b) => (a.isoWeek < b.isoWeek ? -1 : 1))
    .slice(-MAX_GPA_HISTORY);

  const deltaVsLastWeek = previous ? Math.round((gpa - previous.gpa) * 100) / 100 : null;

  return {
    record: { ...record, gpaHistory, updatedAt: now.toISOString() },
    current: gpa,
    lastWeek: previous ? previous.gpa : null,
    deltaVsLastWeek,
  };
}

/**
 * Whether a synced settings blob has the user opted into sync at all.
 *
 * `/data/bundle` needs this to decide whether it's allowed to write a GPA
 * snapshot for a user (see the rule in `index.ts`: Weekly Grade Summary
 * requires Sync Across Devices to be on, so a snapshot should only ever be
 * recorded for someone who could actually receive the email it's for).
 * Defensive about the settings blob's shape since it's client-authored JSON
 * this module never validates on the way in.
 */
export function syncEnabledIn(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const value = (settings as Record<string, unknown>).syncAcrossDevices;
  return value === true;
}
