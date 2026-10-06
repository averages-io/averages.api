/**
 * Browser notifications: what changed, worked out without keeping any of it
 * (2026-10-05). Pure functions only; src/pushStore.ts does the fetching,
 * storing and sending, and test/push.test.ts drives these directly.
 *
 * The student agreed to: "Browser notifications: only for opted-in students.
 * The server keeps an encrypted sign-in only for students who turn
 * notifications on, and deletes it when they turn them off or sign out." So:
 *
 *   - A snapshot holds short keyed hashes only, never a grade, title, name or
 *     message. Each hash covers an id plus whatever marks a change (a score, a
 *     last-updated time), so "is this new?" is a set lookup. The hash key comes
 *     from PUSH_SECRET and the student's id and is never stored, so the stored
 *     hashes can't be matched against guessed grades (a plain hash of "18|20"
 *     could be). HalfSipHash-2-4 rather than WebCrypto because a run hashes up
 *     to a few thousand short strings inside a ~10 ms CPU allowance, and every
 *     crypto.subtle call is an async round trip into the runtime.
 *   - A notification says what KIND of thing changed ("A new grade was
 *     posted."), never which one. The details stay in Averages.
 *
 * Types the student can switch on and off (Settings > Notifications):
 *   grades         a new or changed graded score
 *   assignments    new work posted
 *   due            due within the next 24 hours and (where Classroom can tell
 *                  us) not turned in; once per item and due date
 *   messages       Schoology only: a new unread inbox thread, or one whose
 *                  last_updated moved while it's unread
 *   announcements  Schoology section updates / Classroom announcements
 *
 * The first look at a type is a baseline: it is remembered and notifies
 * nothing, so turning notifications on (or a type back on) never announces
 * everything that was already there.
 */

import { dueMs, timeMs, type CourseRaw } from "./classroom.ts";

export type NotifyType = "grades" | "assignments" | "due" | "messages" | "announcements";
export const NOTIFY_TYPES: readonly NotifyType[] = ["grades", "assignments", "due", "messages", "announcements"];
export type NotifyTypes = Record<NotifyType, boolean>;
export const DEFAULT_TYPES: NotifyTypes = { grades: true, assignments: true, due: true, messages: true, announcements: true };

/** Most hashes kept per type. The newest are kept, so an old item falling off never comes back as "new". */
export const MAX_SET = 600;
/** "Due within a day." */
export const DUE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * A type last read longer ago than this is looked at again as a baseline
 * (except due reminders, which are about what's coming, not what happened).
 * Only reachable after days of failed checks; a pile of old changes isn't news.
 */
export const STALE_MS = 3 * 24 * 60 * 60 * 1000;

/** The five known switches from a request body; anything else in it is ignored. Null when it isn't an object. */
export function parseTypes(input: unknown, base: NotifyTypes = DEFAULT_TYPES): NotifyTypes | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: NotifyTypes = { ...base };
  for (const t of NOTIFY_TYPES) {
    if (!Object.prototype.hasOwnProperty.call(input, t)) continue;
    const v = (input as Record<string, unknown>)[t];
    if (typeof v === "boolean") out[t] = v;
  }
  return out;
}

/** Just the known switches that were sent (for a change to some of them). Null when it isn't an object. */
export function parseTypeChanges(input: unknown): Partial<NotifyTypes> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Partial<NotifyTypes> = {};
  for (const t of NOTIFY_TYPES) {
    if (!Object.prototype.hasOwnProperty.call(input, t)) continue;
    const v = (input as Record<string, unknown>)[t];
    if (typeof v === "boolean") out[t] = v;
  }
  return out;
}

/** Stored types, re-checked on the way out of storage. */
export function normalizeTypes(input: unknown): NotifyTypes {
  return parseTypes(input) ?? { ...DEFAULT_TYPES };
}

/* ── Keyed hashing ─────────────────────────────────────────────────────── */

/**
 * HalfSipHash-2-4 with a 64-bit output (Aumasson and Bernstein's reference
 * halfsiphash.c, outlen 8): a keyed hash built for short inputs, on 32-bit
 * words, so it runs in JavaScript without BigInt. Returns the two output
 * words (little-endian order). test/push.test.ts checks it against the
 * reference test vectors.
 *
 * Written with plain local variables and the rounds spelled out, not a
 * closure or a typed array: that is about four times faster before the
 * runtime optimises it, which matters for a check that runs every 20 minutes
 * in an object that has usually gone cold in between.
 */
function halfSip(k0: number, k1: number, data: Uint8Array, len: number): [number, number] {
  let v0 = k0;
  let v1 = k1 ^ 0xee;
  let v2 = 0x6c796765 ^ k0;
  let v3 = 0x74656462 ^ k1;
  const end = len - (len % 4);
  let i = 0;
  for (;;) {
    let m: number;
    if (i < end) {
      m = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    } else {
      // The last word: the leftover bytes plus the length in the top byte.
      m = (len & 0xff) << 24;
      const left = len & 3;
      if (left >= 3) m |= data[end + 2] << 16;
      if (left >= 2) m |= data[end + 1] << 8;
      if (left >= 1) m |= data[end];
    }
    v3 ^= m;
    for (let r = 0; r < 2; r++) {
      v0 = (v0 + v1) | 0; v1 = (v1 << 5) | (v1 >>> 27); v1 ^= v0; v0 = (v0 << 16) | (v0 >>> 16);
      v2 = (v2 + v3) | 0; v3 = (v3 << 8) | (v3 >>> 24); v3 ^= v2;
      v0 = (v0 + v3) | 0; v3 = (v3 << 7) | (v3 >>> 25); v3 ^= v0;
      v2 = (v2 + v1) | 0; v1 = (v1 << 13) | (v1 >>> 19); v1 ^= v2; v2 = (v2 << 16) | (v2 >>> 16);
    }
    v0 ^= m;
    if (i >= end) break;
    i += 4;
  }
  v2 ^= 0xee;
  for (let r = 0; r < 4; r++) {
    v0 = (v0 + v1) | 0; v1 = (v1 << 5) | (v1 >>> 27); v1 ^= v0; v0 = (v0 << 16) | (v0 >>> 16);
    v2 = (v2 + v3) | 0; v3 = (v3 << 8) | (v3 >>> 24); v3 ^= v2;
    v0 = (v0 + v3) | 0; v3 = (v3 << 7) | (v3 >>> 25); v3 ^= v0;
    v2 = (v2 + v1) | 0; v1 = (v1 << 13) | (v1 >>> 19); v1 ^= v2; v2 = (v2 << 16) | (v2 >>> 16);
  }
  const lo = (v1 ^ v3) >>> 0;
  v1 ^= 0xdd;
  for (let r = 0; r < 4; r++) {
    v0 = (v0 + v1) | 0; v1 = (v1 << 5) | (v1 >>> 27); v1 ^= v0; v0 = (v0 << 16) | (v0 >>> 16);
    v2 = (v2 + v3) | 0; v3 = (v3 << 8) | (v3 >>> 24); v3 ^= v2;
    v0 = (v0 + v3) | 0; v3 = (v3 << 7) | (v3 >>> 25); v3 ^= v0;
    v2 = (v2 + v1) | 0; v1 = (v1 << 13) | (v1 >>> 19); v1 ^= v2; v2 = (v2 << 16) | (v2 >>> 16);
  }
  return [lo, (v1 ^ v3) >>> 0];
}

const word = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** HalfSipHash-2-4, 64-bit output, as bytes. `key` is 8 bytes. */
export function halfSipHash64(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 8) throw new RangeError("HalfSipHash key must be 8 bytes");
  const [lo, hi] = halfSip(word(key, 0), word(key, 4), data, data.length);
  return new Uint8Array([lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, lo >>> 24, hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, hi >>> 24]);
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const utf8 = new TextEncoder();
/** Reused for ASCII text (ids, scores, times: nearly everything hashed), so most hashes allocate nothing. */
const scratch = new Uint8Array(256);

/** 48 bits of the keyed hash as 8 base64url characters: short, and collision-free at these sizes. */
export function hashWith(key: Uint8Array, text: string): string {
  let data: Uint8Array = scratch;
  let len = text.length;
  if (len <= scratch.length) {
    for (let i = 0; i < len; i++) {
      const c = text.charCodeAt(i);
      if (c > 0x7f) {
        data = utf8.encode(text);
        len = data.length;
        break;
      }
      scratch[i] = c;
    }
  } else {
    data = utf8.encode(text);
    len = data.length;
  }
  const [lo, hi] = halfSip(word(key, 0), word(key, 4), data, len);
  // Bytes 0-5 of the little-endian output, as two 24-bit groups.
  const n1 = ((lo & 0xff) << 16) | (((lo >>> 8) & 0xff) << 8) | ((lo >>> 16) & 0xff);
  const n2 = ((lo >>> 24) << 16) | ((hi & 0xff) << 8) | ((hi >>> 8) & 0xff);
  return (
    B64URL[(n1 >>> 18) & 63] + B64URL[(n1 >>> 12) & 63] + B64URL[(n1 >>> 6) & 63] + B64URL[n1 & 63] +
    B64URL[(n2 >>> 18) & 63] + B64URL[(n2 >>> 12) & 63] + B64URL[(n2 >>> 6) & 63] + B64URL[n2 & 63]
  );
}

export type Hasher = (text: string) => string;

/**
 * This student's hasher: an 8-byte key from SHA-256(purpose, PUSH_SECRET, uid).
 * One digest per check; never stored.
 */
export async function snapshotHasher(secret: string, uid: string): Promise<Hasher> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(`push-snapshot\u0000${secret}\u0000${uid}`)));
  const key = digest.slice(0, 8);
  return (text) => hashWith(key, text);
}

/* ── Snapshots ─────────────────────────────────────────────────────────── */

/** What's stored between checks: per type, the hashes seen and when they were read. */
export interface Snapshot {
  v: 1;
  at: Partial<Record<NotifyType, number>>;
  sets: Partial<Record<NotifyType, string[]>>;
}

/**
 * One check's reading. A type is missing when it wasn't asked for or couldn't
 * be read at all (the stored hashes for it are then kept as they are).
 */
export interface Observation extends Snapshot {
  /** Remembered but never notified about (a read message thread). */
  quiet: Partial<Record<NotifyType, string[]>>;
  /**
   * Part of this type couldn't be read (a class that failed, a page cut by the
   * call budget). What's missing may still be there, so the old hashes are
   * kept alongside the new ones instead of being forgotten and re-announced.
   */
  partial: Partial<Record<NotifyType, boolean>>;
}

export function emptyObservation(): Observation {
  return { v: 1, at: {}, sets: {}, quiet: {}, partial: {} };
}

export interface Change {
  type: NotifyType;
  count: number;
}

/** A stored snapshot, or null when it's missing or not one of ours. */
export function readSnapshot(value: unknown): Snapshot | null {
  const s = value as Snapshot;
  if (!s || typeof s !== "object" || s.v !== 1 || !s.sets || typeof s.sets !== "object") return null;
  const out: Snapshot = { v: 1, at: {}, sets: {} };
  for (const t of NOTIFY_TYPES) {
    const list = s.sets[t];
    if (!Array.isArray(list)) continue;
    out.sets[t] = list.filter((h) => typeof h === "string").slice(0, MAX_SET);
    const at = s.at?.[t];
    out.at[t] = typeof at === "number" && Number.isFinite(at) ? at : 0;
  }
  return out;
}

/**
 * What changed since `prev`, per enabled type, for the notification. No
 * `prev` (or no `prev` for a type) is a baseline: nothing to report.
 */
export function diffSnapshots(prev: Snapshot | null, next: Snapshot | Observation, enabled: NotifyTypes, now: number): Change[] {
  const changes: Change[] = [];
  if (!prev) return changes;
  const quiet = (next as Observation).quiet ?? {};
  for (const type of NOTIFY_TYPES) {
    if (!enabled[type]) continue;
    const current = next.sets[type];
    const before = prev.sets[type];
    if (!current || !before) continue;
    if (type !== "due" && now - (prev.at[type] ?? 0) > STALE_MS) continue;
    const seen = new Set(before);
    const skip = new Set(quiet[type] ?? []);
    let count = 0;
    for (const h of current) if (!seen.has(h) && !skip.has(h)) count++;
    if (count > 0) changes.push({ type, count });
  }
  return changes;
}

/**
 * The snapshot to store after a check: each enabled type as just read (plus
 * the old hashes when that read was partial), the old one where it couldn't be
 * read, and nothing for types that are off, so turning one back on starts with
 * a fresh baseline.
 */
export function mergeSnapshot(prev: Snapshot | null, next: Observation, enabled: NotifyTypes): Snapshot {
  const out: Snapshot = { v: 1, at: {}, sets: {} };
  for (const type of NOTIFY_TYPES) {
    if (!enabled[type]) continue;
    const current = next.sets[type];
    const before = prev?.sets[type];
    if (!current) {
      if (before) {
        out.sets[type] = before.slice(0, MAX_SET);
        out.at[type] = prev?.at[type] ?? 0;
      }
      continue;
    }
    let list = current.slice(0, MAX_SET);
    if (next.partial[type] && before) {
      const have = new Set(list);
      for (const h of before) {
        if (list.length >= MAX_SET) break;
        if (!have.has(h)) {
          have.add(h);
          list.push(h);
        }
      }
    }
    out.sets[type] = list;
    out.at[type] = next.at[type] ?? 0;
  }
  return out;
}

interface Item {
  key: string;
  rank: number;
  /** Remembered, never notified about. */
  quiet?: boolean;
}

/** Newest first by `rank`, at most MAX_SET, then hashed (each key once). */
function newestHashed(items: Item[], hash: Hasher, quiet?: string[]): string[] {
  items.sort((a, b) => b.rank - a.rank);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (out.length >= MAX_SET) break;
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    const h = hash(it.key);
    out.push(h);
    if (it.quiet && quiet) quiet.push(h);
  }
  return out;
}

type Raw = Record<string, any>;

function asList(value: unknown): Raw[] {
  if (Array.isArray(value)) return value.filter((x) => x && typeof x === "object");
  if (value && typeof value === "object") return [value as Raw];
  return [];
}

/** A Schoology id: digits only. Anything else is skipped rather than hashed. */
const SCHOOLOGY_ID = /^\d{1,20}$/;
const sid = (v: unknown) => {
  const s = String(v ?? "");
  return SCHOOLOGY_ID.test(s) ? s : "";
};
const idRank = (id: string) => Number(id) || 0;

/** Schoology times: unix seconds (number or numeric string) or "YYYY-MM-DD HH:MM:SS" (read as UTC, same as adapt.ts). */
export function schoologyMs(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const n = Number(value);
    return n > 0 ? n * 1000 : null;
  }
  const ms = Date.parse(String(value).replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : ms;
}

/**
 * What a check read from Schoology. Each field is undefined when it wasn't
 * asked for (its type is off) and null when the call failed; per-section maps
 * hold null for a section that failed.
 */
export interface SchoologyRaw {
  /** The student's own Schoology uid, so their own posts don't notify them. */
  uid: string;
  grades?: Raw[] | null;
  assignments?: Record<string, Raw[] | null> | null;
  inbox?: Raw[] | null;
  updates?: Record<string, Raw[] | null> | null;
}

export function schoologyObservation(raw: SchoologyRaw, enabled: NotifyTypes, hash: Hasher, now: number): Observation {
  const obs = emptyObservation();

  if (enabled.grades && raw.grades) {
    // /users/{uid}/grades: sections > periods > assignments, each with its score.
    const items: Item[] = [];
    for (const section of raw.grades) {
      const sectionId = sid(section?.section_id ?? section?.id);
      if (!sectionId) continue;
      for (const period of asList(section?.period)) {
        for (const a of asList(period?.assignment)) {
          const assignmentId = sid(a?.assignment_id ?? a?.id);
          const grade = a?.grade;
          const exception = Number(a?.exception) || 0;
          // Only graded work: an empty score isn't a grade yet; excused/incomplete is.
          if (!assignmentId || ((grade === null || grade === undefined || grade === "") && !exception)) continue;
          items.push({
            key: `g|${sectionId}|${assignmentId}|${String(grade ?? "")}|${String(a?.max_points ?? "")}|${exception}`,
            rank: schoologyMs(a?.timestamp) ?? idRank(assignmentId),
          });
        }
      }
    }
    obs.sets.grades = newestHashed(items, hash);
    obs.at.grades = now;
  }

  if ((enabled.assignments || enabled.due) && raw.assignments) {
    const posted: Item[] = [];
    const due: Item[] = [];
    let partial = false;
    for (const [sectionIdRaw, list] of Object.entries(raw.assignments)) {
      const sectionId = sid(sectionIdRaw);
      if (!sectionId) continue;
      if (list === null) {
        partial = true;
        continue;
      }
      for (const a of list) {
        const id = sid(a?.id);
        if (!id) continue;
        posted.push({ key: `a|${sectionId}|${id}`, rank: idRank(id) });
        // Schoology doesn't say whether it's turned in, so anything due in
        // the next day counts (the app lists it the same way).
        const at = schoologyMs(a?.due);
        if (at !== null && at > now && at <= now + DUE_WINDOW_MS) due.push({ key: `d|${sectionId}|${id}|${at}`, rank: at });
      }
    }
    if (enabled.assignments) {
      obs.sets.assignments = newestHashed(posted, hash);
      obs.at.assignments = now;
      if (partial) obs.partial.assignments = true;
    }
    if (enabled.due) {
      obs.sets.due = newestHashed(due, hash);
      obs.at.due = now;
      if (partial) obs.partial.due = true;
    }
  }

  if (enabled.messages && raw.inbox) {
    // Every thread is remembered with its last_updated; only unread ones
    // notify. So a reply to a thread the student already read notifies once
    // (it's unread again, with a new time), and marking one unread doesn't.
    const all: Item[] = [];
    for (const m of raw.inbox) {
      const id = sid(m?.id);
      if (!id) continue;
      const updated = String(m?.last_updated ?? m?.created ?? "");
      const unread = String(m?.message_status ?? "").toLowerCase() === "unread";
      all.push({ key: `m|${id}|${updated}`, rank: schoologyMs(updated) ?? idRank(id), quiet: !unread });
    }
    const quiet: string[] = [];
    obs.sets.messages = newestHashed(all, hash, quiet);
    obs.quiet.messages = quiet;
    obs.at.messages = now;
  }

  if (enabled.announcements && raw.updates) {
    const items: Item[] = [];
    let partial = false;
    for (const [sectionIdRaw, list] of Object.entries(raw.updates)) {
      const sectionId = sid(sectionIdRaw);
      if (!sectionId) continue;
      if (list === null) {
        partial = true;
        continue;
      }
      for (const u of list) {
        const id = sid(u?.id);
        // The student's own posts aren't news to them.
        if (!id || (raw.uid && String(u?.uid ?? "") === raw.uid)) continue;
        items.push({ key: `u|${sectionId}|${id}`, rank: idRank(id) });
      }
    }
    obs.sets.announcements = newestHashed(items, hash);
    obs.at.announcements = now;
    if (partial) obs.partial.announcements = true;
  }

  return obs;
}

const CLASSROOM_ID = /^[0-9]{1,24}$/;
const cid = (v: unknown) => {
  const s = String(v ?? "");
  return CLASSROOM_ID.test(s) ? s : "";
};
const DONE = new Set(["TURNED_IN", "RETURNED"]);

/**
 * What a check read from Google Classroom (fetchClassroomBundle's result).
 * `announcementsRead` is false when the announcements permission isn't
 * granted (or the type is off), so that type isn't read at all; `cut` is the
 * call budget running out, which makes every type partial.
 */
export function classroomObservation(raw: CourseRaw[], enabled: NotifyTypes, hash: Hasher, now: number, opts: { announcementsRead: boolean; cut: boolean }): Observation {
  const obs = emptyObservation();
  const grades: Item[] = [];
  const posted: Item[] = [];
  const due: Item[] = [];
  const announcements: Item[] = [];
  let workPartial = opts.cut;
  let gradesPartial = opts.cut;
  let annPartial = opts.cut;

  for (const entry of raw) {
    const courseId = cid(entry?.course?.id);
    if (!courseId) continue;
    if (entry.work === null || !entry.complete) workPartial = true;
    if (entry.work === null || entry.submissions === null || entry.submissionsComplete === false) gradesPartial = true;
    if (entry.announcements === null) annPartial = true;
    const subs = new Map<string, Raw>();
    for (const s of entry.submissions ?? []) {
      const w = cid(s?.courseWorkId);
      if (w) subs.set(w, s);
    }
    for (const work of entry.work ?? []) {
      const id = cid(work?.id);
      if (!id) continue;
      posted.push({ key: `a|${courseId}|${id}`, rank: timeMs(work?.creationTime) ?? timeMs(work?.updateTime) ?? 0 });
      const sub = subs.get(id);
      const graded = !!sub && sub.assignedGrade !== undefined && sub.assignedGrade !== null && Number.isFinite(Number(sub.assignedGrade));
      if (graded) {
        grades.push({
          key: `g|${courseId}|${id}|${Number(sub!.assignedGrade)}|${String(work?.maxPoints ?? "")}`,
          rank: timeMs(sub!.updateTime) ?? 0,
        });
      }
      const at = dueMs(work);
      if (at === null || at <= now || at > now + DUE_WINDOW_MS) continue;
      // Turned in (or graded) is known only from a submission. Without one it
      // isn't turned in, or (submissions list cut short) we can't tell; it
      // counts either way, the same way the app still lists it as upcoming.
      if (graded || (!!sub && DONE.has(String(sub.state ?? "")))) continue;
      due.push({ key: `d|${courseId}|${id}|${at}`, rank: at });
    }
    for (const a of entry.announcements ?? []) {
      const id = cid(a?.id);
      if (id) announcements.push({ key: `u|${courseId}|${id}`, rank: timeMs(a?.updateTime) ?? 0 });
    }
  }

  if (enabled.grades) {
    obs.sets.grades = newestHashed(grades, hash);
    obs.at.grades = now;
    if (gradesPartial) obs.partial.grades = true;
  }
  if (enabled.assignments) {
    obs.sets.assignments = newestHashed(posted, hash);
    obs.at.assignments = now;
    if (workPartial) obs.partial.assignments = true;
  }
  if (enabled.due) {
    obs.sets.due = newestHashed(due, hash);
    obs.at.due = now;
    if (workPartial || gradesPartial) obs.partial.due = true;
  }
  if (enabled.announcements && opts.announcementsRead) {
    obs.sets.announcements = newestHashed(announcements, hash);
    obs.at.announcements = now;
    if (annPartial) obs.partial.announcements = true;
  }
  // Classroom has no messages.
  return obs;
}

/* ── The notification ──────────────────────────────────────────────────── */

export interface NotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

const ONE: Record<NotifyType, (n: number) => string> = {
  grades: (n) => (n === 1 ? "A new grade was posted." : `${n} new grades were posted.`),
  assignments: (n) => (n === 1 ? "A new assignment was posted." : `${n} new assignments were posted.`),
  due: (n) => (n === 1 ? "An assignment is due within a day." : `${n} assignments are due within a day.`),
  messages: (n) => (n === 1 ? "You have a new message." : `You have ${n} new messages.`),
  announcements: (n) => (n === 1 ? "Your teacher posted an update." : `${n} new class updates were posted.`),
};
const NOUN: Record<NotifyType, string> = {
  grades: "grades",
  assignments: "assignments",
  due: "due date reminders",
  messages: "messages",
  announcements: "class updates",
};
/** Where a click lands (the app's own pages, same origin; the service worker re-checks). */
const PAGE: Record<NotifyType, string> = {
  grades: "/grades",
  assignments: "/assignments",
  due: "/assignments",
  messages: "/messages",
  announcements: "/home",
};

/**
 * One notification for one check, whatever changed. Plain, generic copy:
 * what kind of thing, and how many, never which.
 */
export function notificationFor(changes: Change[]): NotificationPayload | null {
  const list = NOTIFY_TYPES.map((t) => changes.find((c) => c.type === t && c.count > 0)).filter((c): c is Change => !!c);
  if (list.length === 0) return null;
  if (list.length === 1) {
    const { type, count } = list[0];
    return { title: "Averages", body: ONE[type](Math.floor(count)), url: PAGE[type], tag: `averages-${type}` };
  }
  const nouns = list.map((c) => NOUN[c.type]);
  const joined = nouns.length === 2 ? `${nouns[0]} and ${nouns[1]}` : `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
  const pages = new Set(list.map((c) => PAGE[c.type]));
  return {
    title: "Averages",
    body: `New ${joined}. Open Averages to see them.`,
    url: pages.size === 1 ? [...pages][0] : "/home",
    tag: "averages-updates",
  };
}

/** The test notification (Settings > Send a Test Notification). */
export const TEST_NOTIFICATION: NotificationPayload = {
  title: "Averages",
  body: "Notifications are on. Averages will let you know when something changes.",
  url: "/settings",
  tag: "averages-test",
};
