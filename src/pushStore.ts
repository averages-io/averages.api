/**
 * Browser notifications: one PushStore Durable Object per student who turned
 * them on (2026-10-05). Opened in the "us" jurisdiction (pushStoreFor below),
 * like SyncStore and CanvaStore, so the stored sign-in and the code that uses
 * it stay in the United States (PowerSchool developer terms §3.2.1). Separate
 * from both: turning notifications off deletes everything in here and nothing
 * else, and turning Sync or Canva off never touches this.
 *
 * What it keeps (Durable Object key-value storage), and nothing more:
 *   subs   up to 5 push subscriptions, one per browser (same endpoint replaces)
 *   types  which kinds of notification are on
 *   cred   the student's session, sealed with PUSH_SECRET (sealValue purpose
 *          "push-credential", expiring with the session itself). PUSH_SECRET
 *          is a separate Worker secret from SESSION_SECRET, so the stored
 *          sign-in can't be opened with the session key alone.
 *   snap   the last snapshot: short keyed hashes only (see notify.ts)
 *   meta   timestamps, a failure count, and a random generation id
 *
 * Every ~20 minutes (plus jitter) alarm() opens the sign-in, reads only what
 * the enabled types need, compares with the snapshot, and sends at most one
 * notification per browser. A sign-in that no longer works (expired, Google
 * access removed, Schoology key revoked) deletes everything: notifications
 * stop for good until the student turns them on again. Anything else that
 * goes wrong keeps the old snapshot and tries again next time.
 *
 * Free plan limits: 50 subrequests and ~10 ms CPU per invocation, alarms
 * included. A Schoology check makes at most 27 calls (3 at a time), a
 * Classroom one at most 43 (CALL_BUDGET plus the token refresh), and sending
 * adds one per browser (at most 5).
 */

import { DurableObject } from "cloudflare:workers";
import { isGoogleSession, openValue, type SessionData } from "./session.ts";
import { getAssignments, getGrades, getMessages, getSections, listOf, SchoologyError, schoologyGet } from "./schoology.ts";
import { CALL_BUDGET, CallBudget, ClassroomError, fetchClassroomBundle } from "./classroom.ts";
import { googleConfig, GoogleError, hasRequiredScopes, refreshAccessToken, type GoogleEnv } from "./google.ts";
import { readFeatures } from "./flags.ts";
import { isValidSubscription, sendWebPush, type PushSubscriptionLike, type VapidConfig } from "./webpush.ts";
import {
  classroomObservation,
  diffSnapshots,
  mergeSnapshot,
  normalizeTypes,
  notificationFor,
  parseTypeChanges,
  NOTIFY_TYPES,
  readSnapshot,
  schoologyObservation,
  snapshotHasher,
  TEST_NOTIFICATION,
  type NotificationPayload,
  type NotifyTypes,
  type Observation,
  type SchoologyRaw,
} from "./notify.ts";

/** sealValue purpose for the stored sign-in. */
export const PUSH_PURPOSE = "push-credential";
export const MAX_SUBSCRIPTIONS = 5;
/** How often a student's classes are checked, plus up to JITTER_MS so checks don't bunch up. */
export const CHECK_EVERY_MS = 20 * 60 * 1000;
export const JITTER_MS = 4 * 60 * 1000;
/** After this many failed checks in a row, check hourly until one works. */
export const BACKOFF_AFTER = 6;
export const BACKOFF_EVERY_MS = 60 * 60 * 1000;
/** The first check (the baseline) runs soon after turning notifications on. */
export const FIRST_CHECK_MS = 15 * 1000;
/** Same cap as the app's bundle. */
export const MAX_SECTIONS = 12;
const SCHOOLOGY_CONCURRENCY = 3;
/** Section updates read per class (newest first). */
const UPDATES_PER_SECTION = 20;
/** Send a Test Notification: at most one per this long. */
export const TEST_EVERY_MS = 10 * 1000;
/** How long a push service holds a notification for a browser that's offline. */
const PUSH_TTL_SECONDS = 12 * 60 * 60;
const MAX_ENDPOINT_LENGTH = 2048;

export type PushEnv = GoogleEnv & {
  SESSION_SECRET?: string;
  /** Separate from SESSION_SECRET: seals the stored sign-in and keys the snapshot hashes. */
  PUSH_SECRET?: string;
  /** base64url P-256 public key (a var: the browser needs it). */
  VAPID_PUBLIC_KEY?: string;
  /** The private JWK's JSON text (a secret). */
  VAPID_PRIVATE_JWK?: string;
  /** "mailto:..." or "https://...", default mailto:help@averages.io. */
  VAPID_SUBJECT?: string;
  PUSH?: DurableObjectNamespace<PushStore>;
};

/** The VAPID keys and subject, or null when either key is missing. */
export function vapidFrom(env: PushEnv): VapidConfig | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKeyJwk = (env.VAPID_PRIVATE_JWK ?? "").trim();
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !privateKeyJwk) return null;
  return { publicKey, privateKeyJwk, subject: (env.VAPID_SUBJECT ?? "").trim() || "mailto:help@averages.io" };
}

/**
 * Notifications can be turned on: both VAPID keys and PUSH_SECRET are set,
 * and PUSH_SECRET really is a different secret from SESSION_SECRET (the same
 * value would undo the point of having two).
 */
export function pushConfigured(env: PushEnv): boolean {
  const secret = env.PUSH_SECRET ?? "";
  return !!vapidFrom(env) && secret.length > 0 && secret !== (env.SESSION_SECRET ?? "");
}

/** True only when this Worker is being reached on localhost (`wrangler dev`). Same rule as index.ts. */
function isLocalRequest(requestUrl: string): boolean {
  try {
    const { hostname } = new URL(requestUrl);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * This student's PushStore, created in the "us" jurisdiction. Same local-dev
 * exception as index.ts's syncKV(): workerd refuses jurisdictions, so under
 * `wrangler dev` on localhost it's opened without one (decided from the
 * request's own URL, so a deployed Worker never takes that path). The cast is
 * because the installed workers-types predates the "us" jurisdiction.
 */
export function pushStoreFor(env: PushEnv, uid: string, requestUrl: string): DurableObjectStub<PushStore> {
  if (!env.PUSH) throw new Error("push_not_bound");
  const ns = isLocalRequest(requestUrl) ? env.PUSH : env.PUSH.jurisdiction("us" as DurableObjectJurisdiction);
  return ns.get(ns.idFromName(uid));
}

/** A subscription as stored: the endpoint and keys only, nothing else the browser sent. */
export interface StoredSubscription extends PushSubscriptionLike {
  addedAt: number;
}
interface Credential {
  sealed: string;
  /** The session's own expiry, unix seconds. */
  exp: number;
}
interface Meta {
  /** New each time notifications are turned on from nothing; a check that sees it change stops. */
  gen: string;
  createdAt: number;
  lastCheckAt?: number;
  lastOkAt?: number;
  lastSentAt?: number;
  lastTestAt?: number;
  failures?: number;
  /** The student's time zone, from their browser when they turned notifications on (2026-10-07). */
  tz?: string;
}

export interface PushStatus {
  /** Notifications are on for this student (in at least one browser). */
  on: boolean;
  /** ...including the browser that asked. */
  here: boolean;
  devices: number;
  types: NotifyTypes | null;
  /** When the last check that worked ran (ms), or null. */
  checkedAt: number | null;
}

export type TestResult = { ok: true } | { ok: false; code: "push_not_configured" | "not_subscribed" | "too_soon" | "subscription_gone" | "push_failed"; status?: number };

/** The endpoint and keys from a browser subscription, or null when it isn't one we can send to. */
export function cleanSubscription(sub: unknown): PushSubscriptionLike | null {
  if (!isValidSubscription(sub) || sub.endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

/** The sign-in no longer works: delete everything (the student turns notifications back on). */
class StopForGood extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StopForGood";
  }
}

/**
 * What went wrong, for the logs: the upstream and its status, never the
 * message (Schoology's names the student's uid in the path).
 */
function describe(err: unknown): string {
  if (err instanceof SchoologyError) return `schoology_${err.status}`;
  if (err instanceof ClassroomError) return `classroom_${err.status}`;
  if (err instanceof GoogleError) return err.code;
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 120)}`;
  return "unknown";
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** At most `limit` of `tasks` running at once. */
async function inPool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

const SECTION_ID = /^\d{1,20}$/;

/**
 * Reads from Schoology what the enabled types need, 3 calls at a time. A
 * 401 on the student's own lists means the key was revoked or changed
 * (stop for good); a failed class just leaves that class out (partial).
 */
export async function readSchoology(session: SessionData, enabled: NotifyTypes): Promise<SchoologyRaw> {
  const raw: SchoologyRaw = { uid: session.uid };
  const needSections = enabled.assignments || enabled.due || enabled.announcements;
  const [sections, grades, inbox] = await Promise.allSettled([
    needSections ? getSections(session.uid, session) : Promise.resolve(null),
    enabled.grades ? getGrades(session.uid, session) : Promise.resolve(null),
    enabled.messages ? getMessages("inbox", session) : Promise.resolve(null),
  ]);
  for (const r of [sections, grades, inbox]) {
    if (r.status === "rejected" && r.reason instanceof SchoologyError && r.reason.status === 401) throw new StopForGood("schoology_unauthorized");
  }
  if (enabled.grades) raw.grades = grades.status === "fulfilled" ? grades.value : null;
  // Messaging can be off district-wide; that's just no messages, never an error.
  if (enabled.messages) raw.inbox = inbox.status === "fulfilled" ? inbox.value : null;
  if (!needSections) return raw;
  if (sections.status !== "fulfilled" || !sections.value) {
    if (enabled.assignments || enabled.due) raw.assignments = null;
    if (enabled.announcements) raw.updates = null;
    return raw;
  }

  const ids = sections.value
    .map((s) => String(s?.id ?? s?.section_id ?? ""))
    .filter((id) => SECTION_ID.test(id))
    .slice(0, MAX_SECTIONS);
  const tasks: (() => Promise<void>)[] = [];
  if (enabled.assignments || enabled.due) {
    const byId: Record<string, any[] | null> = {};
    raw.assignments = byId;
    for (const id of ids) {
      tasks.push(async () => {
        byId[id] = await getAssignments(id, session).catch(() => null);
      });
    }
  }
  if (enabled.announcements) {
    const byId: Record<string, any[] | null> = {};
    raw.updates = byId;
    for (const id of ids) {
      tasks.push(async () => {
        byId[id] = await schoologyGet(`/sections/${id}/updates`, session, { limit: UPDATES_PER_SECTION })
          .then((payload) => listOf(payload, "update"))
          .catch(() => null);
      });
    }
  }
  await inPool(tasks, SCHOOLOGY_CONCURRENCY);
  return raw;
}

/**
 * Reads Google Classroom with a fresh access token from the stored refresh
 * token. Google saying the refresh token is no good (invalid_grant: the
 * student removed Averages.io's access) or the required Classroom permissions
 * being gone stops for good.
 */
/**
 * Null when there's nothing this student's Classroom can tell us (only
 * Messages on, or only Announcements without that permission): not a failure.
 */
export async function readClassroom(session: SessionData, enabled: NotifyTypes, env: PushEnv, hash: (s: string) => string, now: number): Promise<Observation | null> {
  const needWork = enabled.grades || enabled.assignments || enabled.due;
  if (!needWork && !enabled.announcements) return null;
  const config = googleConfig(env);
  if (!config) throw new Error("google_not_configured");
  const g = session.g!;
  let accessToken: string;
  let letters = g.sc;
  try {
    const fresh = await refreshAccessToken(config, g.rt);
    accessToken = fresh.accessToken;
    if (fresh.letters !== null) letters = fresh.letters;
  } catch (err) {
    if (err instanceof GoogleError && err.code === "google_invalid_grant") throw new StopForGood("google_invalid_grant");
    throw err;
  }
  if (!hasRequiredScopes(letters)) throw new StopForGood("google_scopes_removed");
  const readAnnouncements = enabled.announcements && letters.includes("a");
  if (!needWork && !readAnnouncements) return null;
  const budget = new CallBudget(CALL_BUDGET);
  const raw = await fetchClassroomBundle(accessToken, readAnnouncements ? letters : letters.replace(/a/g, ""), budget);
  return classroomObservation(raw, enabled, hash, now, { announcementsRead: readAnnouncements, cut: budget.cut });
}

export class PushStore extends DurableObject<PushEnv> {
  /* ── RPC (from src/push.ts) ───────────────────────────────────────── */

  /**
   * Turns notifications on for one browser: stores its subscription, the
   * types, and the sealed sign-in. The first time (nothing stored yet) the
   * first check is scheduled soon; it's the baseline and notifies nothing.
   */
  async subscribe(input: { subscription: PushSubscriptionLike; types: NotifyTypes; sealed: string; exp: number; tz?: string }): Promise<PushStatus> {
    const sub = cleanSubscription(input?.subscription);
    if (!sub) throw new Error("push_bad_subscription");
    if (typeof input.sealed !== "string" || !input.sealed || typeof input.exp !== "number" || !Number.isFinite(input.exp)) {
      throw new Error("push_bad_credential");
    }
    const s = this.ctx.storage;
    const now = Date.now();
    const got = await s.get<unknown>(["subs", "meta", "cred"]);
    const meta = got.get("meta") as Meta | undefined;
    const subs = this.subsFrom(got.get("subs")).filter((x) => x.endpoint !== sub.endpoint);
    subs.push({ ...sub, addedAt: now });
    while (subs.length > MAX_SUBSCRIPTIONS) subs.shift(); // the oldest browser goes
    await s.put({
      subs,
      types: normalizeTypes(input.types),
      cred: this.newerCredential(got.get("cred"), { sealed: input.sealed, exp: input.exp }),
      meta: { ...(meta ?? { gen: randomId(), createdAt: now }), ...(typeof input.tz === "string" && input.tz.length <= 64 ? { tz: input.tz } : {}) },
    });
    if (!meta || (await s.getAlarm()) === null) await s.setAlarm(now + FIRST_CHECK_MS + Math.floor(Math.random() * 15_000));
    return this.status(sub.endpoint);
  }

  /**
   * Which kinds of notification are on: the switches sent are changed, the
   * rest kept. Hashes kept for a type that's now off are forgotten. Null when
   * nothing is stored.
   */
  async setTypes(changes: Partial<NotifyTypes>): Promise<PushStatus | null> {
    const s = this.ctx.storage;
    const got = await s.get<unknown>(["meta", "types"]);
    if (!got.get("meta")) return null;
    const next = normalizeTypes({ ...normalizeTypes(got.get("types")), ...parseTypeChanges(changes) });
    await s.put("types", next);
    const snap = readSnapshot(await s.get("snap"));
    if (snap) {
      for (const t of NOTIFY_TYPES) {
        if (next[t]) continue;
        delete snap.sets[t];
        delete snap.at[t];
      }
      await s.put("snap", snap);
    }
    return this.status();
  }

  /** Turns notifications off for one browser; with none left, everything is deleted. */
  async unsubscribe(endpoint: string): Promise<PushStatus> {
    const s = this.ctx.storage;
    const subs = this.subsFrom(await s.get("subs"));
    const left = subs.filter((x) => x.endpoint !== endpoint);
    if (left.length === 0) {
      await this.deleteAll();
      return this.status();
    }
    if (left.length !== subs.length) await s.put("subs", left);
    return this.status(endpoint);
  }

  /** Everything this object holds, and its alarm, gone (turned off everywhere, or signed out). */
  async deleteAll(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Keeps the stored sign-in in step with the student's current session (the
   * app calls this at most once a day). Only when notifications are on, and
   * only for a session that lasts at least as long as the stored one, so an
   * older device can't swap in a sign-in that runs out sooner.
   */
  async touch(input: { sealed: string; exp: number; tz?: string }): Promise<boolean> {
    const s = this.ctx.storage;
    const got = await s.get<unknown>(["meta", "cred"]);
    const meta = got.get("meta") as Meta | undefined;
    if (!meta || !got.get("cred")) return false;
    if (typeof input?.sealed !== "string" || !input.sealed || typeof input.exp !== "number") return false;
    await s.put("cred", this.newerCredential(got.get("cred"), input));
    // The time zone too (2026-10-07), so students who turned notifications on
    // before it was kept get "due within a day" in their own zone.
    if (typeof input.tz === "string" && input.tz.length <= 64 && input.tz !== meta.tz) await s.put("meta", { ...meta, tz: input.tz });
    return true;
  }

  /** Settings > Send a Test Notification, to this one browser. */
  async test(endpoint: string): Promise<TestResult> {
    const vapid = vapidFrom(this.env);
    if (!vapid) return { ok: false, code: "push_not_configured" };
    const s = this.ctx.storage;
    const got = await s.get<unknown>(["subs", "meta"]);
    const meta = got.get("meta") as Meta | undefined;
    const sub = this.subsFrom(got.get("subs")).find((x) => x.endpoint === endpoint);
    if (!meta || !sub) return { ok: false, code: "not_subscribed" };
    const now = Date.now();
    if (meta.lastTestAt && now - meta.lastTestAt < TEST_EVERY_MS) return { ok: false, code: "too_soon" };
    await s.put("meta", { ...meta, lastTestAt: now });
    const res = await this.sendOne(sub, TEST_NOTIFICATION, vapid, 5 * 60);
    if (res.gone) {
      await this.dropEndpoints([endpoint]);
      return { ok: false, code: "subscription_gone" };
    }
    return res.ok ? { ok: true } : { ok: false, code: "push_failed", status: res.status };
  }

  async status(endpoint?: string): Promise<PushStatus> {
    const got = await this.ctx.storage.get<unknown>(["subs", "meta", "types"]);
    const meta = got.get("meta") as Meta | undefined;
    const subs = this.subsFrom(got.get("subs"));
    const on = !!meta && subs.length > 0;
    return {
      on,
      here: on && !!endpoint && subs.some((x) => x.endpoint === endpoint),
      devices: on ? subs.length : 0,
      types: on ? normalizeTypes(got.get("types")) : null,
      checkedAt: on ? meta!.lastOkAt ?? null : null,
    };
  }

  /* ── The check ─────────────────────────────────────────────────────── */

  /**
   * Never throws: Cloudflare retries a throwing alarm within seconds, which
   * would hammer Schoology or Google. Every path either schedules the next
   * check or deletes everything.
   */
  async alarm(): Promise<void> {
    const s = this.ctx.storage;
    const now = Date.now();
    let gen = "";
    let failed = false;
    try {
      const got = await s.get<unknown>(["subs", "meta", "cred", "types"]);
      const meta = got.get("meta") as Meta | undefined;
      const cred = got.get("cred") as Credential | undefined;
      const subs = this.subsFrom(got.get("subs"));
      // Leftovers with no browser or no sign-in to use: nothing to keep.
      if (!meta || !cred || subs.length === 0) {
        await this.deleteAll();
        return;
      }
      gen = meta.gen;
      if (typeof cred.exp !== "number" || cred.exp * 1000 <= now) {
        await this.deleteAll();
        return;
      }

      const secret = this.env.PUSH_SECRET ?? "";
      const vapid = vapidFrom(this.env);
      // Not configured (a secret removed from the dashboard): keep everything
      // and look again later. Deleting here would turn every student's
      // notifications off over a deploy mistake.
      if (!secret || !vapid) return;
      // notifications-features switched off (src/flags.ts): send nothing, keep
      // everyone's settings, and look again next time.
      if (!(await readFeatures(this.env))["notifications-features"]) return;

      const opened = await openValue(cred.sealed, secret, PUSH_PURPOSE);
      const session = typeof opened === "string" ? this.parseSession(opened) : null;
      // Expired, tampered, or sealed under a PUSH_SECRET that has since changed.
      if (!session) {
        await this.deleteAll();
        return;
      }

      const enabled = normalizeTypes(got.get("types"));
      if (!NOTIFY_TYPES.some((t) => enabled[t])) return;

      const hash = await snapshotHasher(secret, session.uid);
      let observed: Observation | null;
      try {
        observed = isGoogleSession(session)
          ? await readClassroom(session, enabled, this.env, hash, now)
          : schoologyObservation(await readSchoology(session, enabled), enabled, hash, now, meta.tz ?? "UTC");
      } catch (err) {
        if (err instanceof StopForGood) {
          console.log("push_stopped", err.message);
          await this.deleteAll();
          return;
        }
        failed = true;
        console.error("push_check_failed", describe(err));
        return;
      }

      // The student may have turned notifications off (or off and on again)
      // while Schoology or Google was answering: then this check's result
      // belongs to nobody, and nothing more is written. Types and snapshot are
      // read again too, in case they changed meanwhile: a type switched off
      // mid-check doesn't notify, and one switched on starts with a baseline.
      const after = await s.get<unknown>(["meta", "subs", "types", "snap"]);
      const metaNow = after.get("meta") as Meta | undefined;
      if (!metaNow || metaNow.gen !== gen) {
        gen = "";
        return;
      }
      if (!observed) return;
      // Every call failed: a failed check (counted, see scheduleNext), not a reading of "nothing there".
      if (!NOTIFY_TYPES.some((t) => enabled[t] && observed.sets[t] !== undefined)) {
        failed = true;
        console.error("push_check_failed", "nothing_read");
        return;
      }

      const enabledNow = normalizeTypes(after.get("types"));
      const prev = readSnapshot(after.get("snap"));
      const changes = diffSnapshots(prev, observed, enabledNow, now);
      // Saved before sending, so a notification is never sent twice for the same change.
      await s.put({ snap: mergeSnapshot(prev, observed, enabledNow), meta: { ...metaNow, lastCheckAt: now, lastOkAt: now, failures: 0 } });

      const note = notificationFor(changes);
      const targets = this.subsFrom(after.get("subs"));
      if (!note || targets.length === 0) return;
      const results = await Promise.all(targets.map((sub) => this.sendOne(sub, note, vapid, PUSH_TTL_SECONDS)));
      const gone = targets.filter((_, i) => results[i].gone).map((sub) => sub.endpoint);
      if (gone.length) await this.dropEndpoints(gone);
      if (results.some((r) => r.ok)) {
        const m = (await s.get("meta")) as Meta | undefined;
        if (m && m.gen === gen) await s.put("meta", { ...m, lastSentAt: now });
      }
    } catch (err) {
      failed = true;
      console.error("push_alarm_failed", describe(err));
    } finally {
      await this.scheduleNext(gen, failed, now);
    }
  }

  /* ── Helpers ───────────────────────────────────────────────────────── */

  /**
   * The next check, unless everything was deleted or replaced meanwhile. A
   * failed check is counted; after BACKOFF_AFTER in a row, checks are hourly
   * until one works (a working check resets the count).
   */
  private async scheduleNext(gen: string, failed: boolean, now: number): Promise<void> {
    if (!gen) return;
    try {
      const meta = (await this.ctx.storage.get("meta")) as Meta | undefined;
      if (!meta || meta.gen !== gen) return;
      let failures = meta.failures ?? 0;
      if (failed) {
        failures += 1;
        await this.ctx.storage.put("meta", { ...meta, lastCheckAt: now, failures });
      }
      const every = failures >= BACKOFF_AFTER ? BACKOFF_EVERY_MS : CHECK_EVERY_MS;
      await this.ctx.storage.setAlarm(Date.now() + every + Math.floor(Math.random() * JITTER_MS));
    } catch (err) {
      console.error("push_schedule_failed", describe(err));
    }
  }

  private async sendOne(sub: PushSubscriptionLike, note: NotificationPayload, vapid: VapidConfig, ttl: number) {
    try {
      return await sendWebPush(sub, JSON.stringify(note), vapid, { ttl, urgency: "normal", topic: note.tag });
    } catch (err) {
      // Only configuration mistakes throw (a bad VAPID key): same for every browser, so log it once per send.
      console.error("push_send_failed", describe(err));
      return { ok: false, status: 0, gone: false };
    }
  }

  /** Forgets browsers whose subscription has expired or been revoked; none left, nothing kept. */
  private async dropEndpoints(endpoints: string[]): Promise<void> {
    const s = this.ctx.storage;
    const got = await s.get<unknown>(["subs", "meta"]);
    if (!got.get("meta")) return;
    const subs = this.subsFrom(got.get("subs"));
    const left = subs.filter((x) => !endpoints.includes(x.endpoint));
    if (left.length === 0) await this.deleteAll();
    else if (left.length !== subs.length) await s.put("subs", left);
  }

  private subsFrom(value: unknown): StoredSubscription[] {
    if (!Array.isArray(value)) return [];
    return value.filter((x) => x && typeof x === "object" && typeof x.endpoint === "string" && x.keys && typeof x.keys === "object");
  }

  private newerCredential(old: unknown, next: Credential): Credential {
    const o = old as Credential | undefined;
    if (o && typeof o.sealed === "string" && typeof o.exp === "number" && o.exp > next.exp && o.exp * 1000 > Date.now()) return o;
    return { sealed: next.sealed, exp: next.exp };
  }

  private parseSession(text: string): SessionData | null {
    try {
      const v = JSON.parse(text) as SessionData;
      if (!v || typeof v !== "object" || typeof v.uid !== "string" || !v.uid) return null;
      if (isGoogleSession(v)) return typeof v.g?.rt === "string" && v.g.rt ? v : null;
      return typeof v.key === "string" && v.key && typeof v.secret === "string" && v.secret ? v : null;
    } catch {
      return null;
    }
  }
}
