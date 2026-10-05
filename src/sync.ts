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
 *   - `gpaSnapshot` — at most two Projected GPA snapshots, `current` (this
 *     ISO week's) and `previous` (the one before it) — see
 *     `recordGpaSnapshot` below. This is what lets a future weekly-report
 *     email say "+0.07 vs last week" without a separate storage system:
 *     `index.ts`'s `/data/bundle` handler updates it on every real
 *     (non-demo) load, piggybacking on data it already computed rather than
 *     needing its own fetch/cron cycle to know a course's grades — but only
 *     for a user who has BOTH Sync Across Devices AND Weekly Grade Summary
 *     turned on (`syncEnabledIn` + `weeklyGradeSummaryEnabledIn`).
 *     Deliberately not a longer rolling history (an earlier version kept up
 *     to 12 weeks/~3 months): the email only ever needs one comparison
 *     point, so there's no reason to hold more than that. Shrunk
 *     2026-09-12, per Martin, after a privacy-policy review flagged
 *     months of GPA history as creepier than the feature it's for needs to
 *     be — and, separately, storage is now gated on the email toggle
 *     itself rather than on sync alone, so turning the email off (while
 *     leaving sync on for everything else) actually stops Averages.io
 *     recording a number for it, and `PUT /sync/settings` below clears
 *     whatever's already stored the moment a push shows the email is off.
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
  /**
   * At most this week's snapshot and the one immediately before it — never
   * a longer history. See `recordGpaSnapshot` for the rotation logic and
   * this file's own top-of-file comment for why this shrank from a
   * multi-week array to just these two.
   */
  gpaSnapshot: { current: GpaSnapshot | null; previous: GpaSnapshot | null };
  /**
   * Stamped on every write to this record — settings pushes AND the
   * `/data/bundle` GPA-snapshot piggyback below both touch it. Deliberately
   * NOT what the client compares to decide whether to pull — see
   * `settingsUpdatedAt` for that. Kept mainly so a raw look at a KV record
   * (or a future admin view) has an obvious "last touched" field.
   */
  updatedAt: string;
  /**
   * Stamped ONLY when the `settings` half of this record actually changes
   * (index.ts's `PUT /sync/settings`) — never by the GPA-snapshot writes
   * `/data/bundle` does on nearly every authenticated page load. That
   * separation is the whole point: settings.html's pull logic needs to
   * tell "another device changed my settings since I last synced" apart
   * from "this account's GPA history quietly grew a bit," and a shared
   * timestamp bumped by both would make every routine page load look like
   * a settings change and trigger a needless reload.
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
 * back as a rejected promise, which `/data/bundle`'s `.catch(() => null)`
 * already handles, instead of a thrown error that would take the grades
 * page down with it.
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
  return { settings: null, gpaSnapshot: { current: null, previous: null }, updatedAt: "", settingsUpdatedAt: "" };
}

function isGpaSnapshotShape(
  value: unknown
): value is { current: GpaSnapshot | null; previous: GpaSnapshot | null } {
  return !!value && typeof value === "object" && "current" in value && "previous" in value;
}

export async function loadSyncRecord(kv: KVLike, uid: string): Promise<SyncRecord> {
  const raw = await kv.get(syncKey(uid), "json");
  if (!raw || typeof raw !== "object") return emptyRecord();
  const record = raw as Partial<SyncRecord> & { gpaHistory?: unknown };
  return {
    settings: record.settings ?? null,
    // A record written before 2026-09-12 has an old `gpaHistory` array
    // instead of this field — deliberately not migrated forward. Carrying
    // old entries into the new shape would defeat the point of shrinking
    // retention in the first place, so any pre-existing history is just
    // dropped here rather than translated.
    gpaSnapshot: isGpaSnapshotShape(record.gpaSnapshot)
      ? record.gpaSnapshot
      : { current: null, previous: null },
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
 * Keeps at most two snapshots — `current` and `previous` — never a longer
 * history (see `SyncRecord.gpaSnapshot`'s own comment for why). One
 * snapshot per user per ISO week, not per request — `/data/bundle` can be
 * hit many times a day; a reload later in the SAME week updates `current`
 * in place rather than rotating `previous` again, so "last week" stays the
 * same answer across every reload within a week instead of meaning "the
 * last page load."
 *
 * "Last week" is deliberately whatever `previous` already held going into
 * this call, not literally `isoWeek - 1`: a user who didn't open the app
 * for two weeks still gets a real comparison against their last known value
 * instead of a false "no data"/"+0.00" for the gap week — same behavior as
 * the multi-week-history version this replaced, just without holding onto
 * anything older than that one comparison point.
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
  const snapshot: GpaSnapshot = { isoWeek, date: now.toISOString().slice(0, 10), gpa };
  const existing = record.gpaSnapshot ?? { current: null, previous: null };

  const gpaSnapshot =
    existing.current && existing.current.isoWeek === isoWeek
      ? { current: snapshot, previous: existing.previous } // same week — update in place, previous doesn't move
      : { current: snapshot, previous: existing.current }; // a new week started — current rotates into previous

  const previous = gpaSnapshot.previous;
  const deltaVsLastWeek = previous ? Math.round((gpa - previous.gpa) * 100) / 100 : null;

  return {
    record: { ...record, gpaSnapshot, updatedAt: now.toISOString() },
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

/**
 * Whether a synced settings blob has the user opted into the weekly email
 * itself, not just Sync Across Devices. Added 2026-09-12 so `/data/bundle`
 * can stop recording a GPA snapshot for anyone who has sync on but the
 * email off — before this, `syncEnabledIn` alone gated the snapshot, which
 * meant it was recorded for every synced user regardless of whether they'd
 * ever turned the email on. `settings.html`'s `collectSyncedSettings()`
 * already pushes `settingsOptions` (which includes `weeklyGradeSummary`) as
 * part of the synced blob on every settings change, so this needed no new
 * client-side plumbing — just the server-side check that was missing.
 */
export function weeklyGradeSummaryEnabledIn(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const options = (settings as Record<string, unknown>).settingsOptions;
  if (!options || typeof options !== "object") return false;
  return (options as Record<string, unknown>).weeklyGradeSummary === true;
}
