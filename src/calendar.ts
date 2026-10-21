/**
 * Calendar sync, an Averages Plus perk (2026-10-21): a private link a
 * calendar app subscribes to (Google Calendar "From URL", Apple Calendar
 * "New Calendar Subscription"), showing the student's due dates. Mounted by
 * index.ts at /calendar.
 *
 *   GET    /calendar/status        { enabled, configured, eligible, plus, on, url, createdAt }
 *   POST   /calendar               {} -> { url, createdAt }: a new link (any old link stops working)
 *   POST   /calendar/touch         keep the stored sign-in in step with this session
 *   DELETE /calendar               the link and its stored sign-in, gone
 *   GET    /calendar/<token>.ics   the calendar itself (no cookie: calendar apps fetch it)
 *
 * What's stored, in the US (CalendarStore, one record per student and one per
 * link): the link's token sealed with PUSH_SECRET (so Settings can show it
 * again) and only its SHA-256 elsewhere; the student's sign-in sealed with
 * PUSH_SECRET, the same way notifications keep it, so the calendar can be read
 * while they're away; their time zone; and when the calendar was last read.
 * Never the calendar itself: schoolwork passes through and isn't stored, like
 * everywhere else (so calendar apps asking more than once every 10 minutes
 * get 429 with Retry-After, which keeps the school platform from being
 * hammered). Turning it off, signing out, switching to Incognito or Plus
 * ending deletes it all.
 *
 * The calendar: assignments, quizzes and tests with a due date from 14 days ago
 * to 90 days ahead, one all-day event each on the day they're due, with the
 * due time in the title. A sign-in that ran out, or Plus that ended, gives a
 * calendar with one event saying what to do, rather than an error a calendar
 * app would hide.
 */

import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import { isDemoSession, isGoogleSession, isIncognitoSession, openValue, sealValue, type SessionData } from "./session.ts";
import { getAssignments, getSections, SchoologyError } from "./schoology.ts";
import { schoologyLocalMs, timeLabel } from "./adapt.ts";
import { CALL_BUDGET, CallBudget, dueMs as classroomDueMs, fetchClassroomBundle, safeTimeZone } from "./classroom.ts";
import { googleConfig, refreshAccessToken, type GoogleEnv } from "./google.ts";
import { hasPlusNow, plusRequired, type PlusEnv, type PlusStoreFor } from "./plus.ts";
import { featureOn } from "./flags.ts";

export const CALENDAR_PURPOSE = "calendar-credential";
export const CALENDAR_LINK_PURPOSE = "calendar-link";
/** A link's calendar is read from the school platform at most this often. */
export const MIN_READ_MS = 10 * 60 * 1000;
export const PAST_DAYS = 14;
export const AHEAD_DAYS = 90;
export const MAX_SECTIONS = 12;
export const MAX_EVENTS = 400;
const TEN_YEARS_S = 10 * 365 * 24 * 3600;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const APP = "https://app.averages.io";

export type CalendarEnv = PlusEnv & GoogleEnv & {
  SESSION_SECRET?: string;
  PUSH_SECRET?: string;
  CALENDAR?: DurableObjectNamespace;
};

/** A link and a feed are both just one record in a CalendarStore. */
export interface CalendarRecordStore {
  read(): Promise<any | null>;
  write(value: unknown): Promise<void>;
  remove(): Promise<void>;
}
export type CalendarStoreFor = (env: CalendarEnv, name: string, requestUrl: string) => CalendarRecordStore;

/** One record per Durable Object: "u:<uid>" (the student's link) or "f:<sha256 of token>" (the feed). */
export class CalendarStore extends DurableObject {
  async read(): Promise<any | null> {
    return (await this.ctx.storage.get("rec")) ?? null;
  }
  async write(value: unknown): Promise<void> {
    await this.ctx.storage.put("rec", value);
  }
  async remove(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

function isLocalRequest(requestUrl: string): boolean {
  try {
    const { hostname } = new URL(requestUrl);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function calendarStoreFor(env: CalendarEnv, name: string, requestUrl: string): CalendarRecordStore {
  if (!env.CALENDAR) throw new Error("calendar_not_bound");
  const ns = isLocalRequest(requestUrl) ? env.CALENDAR : env.CALENDAR.jurisdiction("us" as DurableObjectJurisdiction);
  return ns.get(ns.idFromName(name)) as unknown as CalendarRecordStore;
}

/** The sealing secret is set, and is a different secret from SESSION_SECRET (same rule as notifications). */
export function calendarConfigured(env: CalendarEnv): boolean {
  const secret = env.PUSH_SECRET ?? "";
  return secret.length > 0 && secret !== (env.SESSION_SECRET ?? "");
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function newToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function tokenHash(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function feedUrl(requestUrl: string, token: string): string {
  return `${new URL(requestUrl).origin}/calendar/${token}.ics`;
}

/* ── The calendar ─────────────────────────────────────────────────────── */

export interface DueItem {
  uid: string;
  title: string;
  course: string;
  dueMs: number;
  /** "11:59 PM", or "" when only the day is known. */
  time: string;
  /** The local date it's due, YYYY-MM-DD. */
  day: string;
  link: string;
}

function localDay(ms: number, tz: string): string {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, x.value])
    );
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** RFC 5545 text: backslash, semicolon, comma and newlines escaped. */
export function icsText(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Lines longer than 75 bytes folded (CRLF + space), without splitting a character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The whole .ics text. `notice` adds one all-day event today (sign in again, Plus ended). */
export function buildIcs(items: DueItem[], opts: { now: number; tz: string; notice?: { title: string; text: string } }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Averages.io//Calendar sync//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Averages.io",
    `X-WR-TIMEZONE:${opts.tz}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  const dtstamp = stamp(opts.now);
  const event = (uid: string, day: string, summary: string, description: string, url?: string) => {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${day.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${nextDay(day).replace(/-/g, "")}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(description)}`,
      ...(url ? [`URL:${url}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  };
  if (opts.notice) event(`notice-${localDay(opts.now, opts.tz)}@averages.io`, localDay(opts.now, opts.tz), opts.notice.title, opts.notice.text, APP);
  for (const it of items.slice(0, MAX_EVENTS)) {
    const summary = it.time ? `${it.title} (due ${it.time})` : `${it.title} (due)`;
    const description = [it.course, it.time ? `Due ${it.time}` : "", `Open in Averages.io: ${it.link}`].filter(Boolean).join("\n");
    event(it.uid, it.day, summary, description, it.link);
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Schoology: every class's assignments (12 classes at most, 3 at a time). */
export async function schoologyDueItems(session: SessionData, tz: string, now: number): Promise<DueItem[]> {
  const sections = (await getSections(session.uid, session)) as any[];
  const list = (Array.isArray(sections) ? sections : []).slice(0, MAX_SECTIONS);
  const from = now - PAST_DAYS * 86400000;
  const to = now + AHEAD_DAYS * 86400000;
  const items: DueItem[] = [];
  let i = 0;
  const work = async () => {
    while (i < list.length) {
      const s = list[i++];
      const id = String(s?.id ?? s?.section_id ?? "");
      if (!/^\d{1,20}$/.test(id)) continue;
      const course = String(s?.course_title ?? s?.section_title ?? "Class");
      let rows: any[] = [];
      try {
        rows = (await getAssignments(id, session)) as any[];
      } catch (err) {
        if (err instanceof SchoologyError && err.status === 401) throw err;
        continue;
      }
      for (const a of Array.isArray(rows) ? rows : []) {
        const due = schoologyLocalMs(a?.due, tz);
        if (due === null || due < from || due > to) continue;
        const aid = String(a?.id ?? "");
        if (!/^\d{1,20}$/.test(aid)) continue;
        items.push({
          uid: `sgy-${aid}@averages.io`,
          title: String(a?.title ?? "Untitled").slice(0, 200),
          course,
          dueMs: due,
          time: timeLabel(due, tz),
          day: localDay(due, tz),
          link: `${APP}/assignment?id=${aid}`,
        });
      }
    }
  };
  await Promise.all([work(), work(), work()]);
  return items.sort((a, b) => a.dueMs - b.dueMs);
}

/** Google Classroom: coursework with a due date, from a fresh access token. */
export async function classroomDueItems(session: SessionData, env: CalendarEnv, tz: string, now: number): Promise<DueItem[]> {
  const config = googleConfig(env);
  if (!config) throw new Error("google_not_configured");
  const fresh = await refreshAccessToken(config, session.g!.rt);
  const letters = (fresh.letters ?? session.g!.sc ?? "").replace(/a/g, "");
  const courses = await fetchClassroomBundle(fresh.accessToken, letters, new CallBudget(CALL_BUDGET));
  const from = now - PAST_DAYS * 86400000;
  const to = now + AHEAD_DAYS * 86400000;
  const items: DueItem[] = [];
  for (const c of courses) {
    const course = String(c.course?.name ?? "Class");
    for (const w of c.work ?? []) {
      const due = classroomDueMs(w);
      if (due === null || due < from || due > to) continue;
      const id = String(w?.id ?? "");
      if (!id) continue;
      items.push({
        uid: `gc-${id}@averages.io`,
        title: String(w?.title ?? "Untitled").slice(0, 200),
        course,
        dueMs: due,
        time: w?.dueTime ? timeLabel(due, tz) : "",
        day: localDay(due, tz),
        link: `${APP}/assignment?id=${encodeURIComponent(id)}`,
      });
    }
  }
  return items.sort((a, b) => a.dueMs - b.dueMs);
}

/* ── Routes ───────────────────────────────────────────────────────────── */

export interface CalendarDeps {
  requireSession: (c: any, next: () => Promise<void>) => Promise<Response | void>;
  fromOurApp: (c: any) => Response | null;
  storeFor?: CalendarStoreFor;
  plusStoreFor?: PlusStoreFor;
  /** For tests: what the calendar is made of. */
  dueItems?: (session: SessionData, env: CalendarEnv, tz: string, now: number) => Promise<DueItem[]>;
  now?: () => number;
}

interface LinkRecord { sealedToken: string; hash: string; createdAt: number }
interface FeedRecord { uid: string; cred: { sealed: string; exp: number }; tz: string; createdAt: number; lastReadAt?: number }

async function sealCredential(session: SessionData, secret: string): Promise<{ sealed: string; exp: number } | null> {
  const ttl = session.exp - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return { sealed: await sealValue(JSON.stringify(session), secret, CALENDAR_PURPOSE, ttl), exp: session.exp };
}

function parseSession(text: unknown): SessionData | null {
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text) as SessionData;
    if (!v || typeof v !== "object" || typeof v.uid !== "string" || !v.uid) return null;
    if (isGoogleSession(v)) return typeof v.g?.rt === "string" && v.g.rt ? v : null;
    return typeof v.key === "string" && v.key && typeof v.secret === "string" && v.secret ? v : null;
  } catch {
    return null;
  }
}

/** Deletes a student's link and its feed. Never throws (sign-out, Incognito, Plus ending use it). */
export async function forgetCalendar(env: CalendarEnv, uid: string, requestUrl: string, storeFor?: CalendarStoreFor): Promise<void> {
  if (!uid) return;
  if (!storeFor && !env.CALENDAR) return;
  const open = storeFor ?? calendarStoreFor;
  try {
    const link = open(env, `u:${uid}`, requestUrl);
    const rec = (await link.read()) as LinkRecord | null;
    if (rec?.hash) await open(env, `f:${rec.hash}`, requestUrl).remove();
    await link.remove();
  } catch (err) {
    console.error("calendar_forget_failed", err instanceof Error ? err.message : String(err));
  }
}

export function calendarRoutes(deps: CalendarDeps) {
  const open = deps.storeFor ?? calendarStoreFor;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono<{ Bindings: CalendarEnv; Variables: { session: SessionData } }>();
  const noStore = (c: any) => c.header("Cache-Control", "private, no-store");

  /**
   * Whether this student may use calendar sync: Plus, or anyone while billing
   * is off (2026-10-21, Martin: with the billing switch off, "let the user use
   * every single feature"). Null when the BillingStore couldn't be reached.
   */
  const plusOf = async (c: any, uid: string): Promise<boolean | null> => {
    if (!plusRequired(c.env)) return true;
    try {
      return await hasPlusNow(c.env, uid, c.req.url, deps.plusStoreFor);
    } catch (err) {
      console.error("calendar_plus_check_failed", err instanceof Error ? err.message : String(err));
      return null;
    }
  };
  const linkOf = async (c: any, uid: string): Promise<LinkRecord | null> => (await open(c.env, `u:${uid}`, c.req.url).read()) as LinkRecord | null;

  app.get("/status", deps.requireSession, async (c) => {
    noStore(c);
    const session: SessionData = c.get("session");
    const enabled = featureOn(c.env, "calendar-sync");
    const configured = calendarConfigured(c.env) && !!(deps.storeFor || c.env.CALENDAR);
    const eligible = !isDemoSession(session) && !isIncognitoSession(session);
    // plusRequired: false while billing is off, so the app shows no Plus tag or Get Plus.
    const off = { enabled, configured, eligible, plusRequired: plusRequired(c.env), plus: false, on: false, url: null, createdAt: null };
    if (!eligible || !configured) return c.json(off);
    const plus = (await plusOf(c, session.uid)) === true;
    try {
      const link = await linkOf(c, session.uid);
      if (!link) return c.json({ ...off, plus });
      const token = await openValue(link.sealedToken, c.env.PUSH_SECRET!, CALENDAR_LINK_PURPOSE);
      return c.json({ ...off, plus, on: true, url: typeof token === "string" ? feedUrl(c.req.url, token) : null, createdAt: link.createdAt });
    } catch (err) {
      console.error("calendar_store_failed", err instanceof Error ? err.message : String(err));
      return c.json({ error: "calendar_unavailable" }, 502);
    }
  });

  app.post("/", deps.requireSession, async (c) => {
    const foreign = deps.fromOurApp(c);
    if (foreign) return foreign;
    noStore(c);
    const session: SessionData = c.get("session");
    if (isDemoSession(session)) return c.json({ error: "not_available_in_demo" }, 403);
    if (isIncognitoSession(session)) return c.json({ error: "incognito_mode" }, 403);
    if (!calendarConfigured(c.env) || !(deps.storeFor || c.env.CALENDAR)) return c.json({ error: "calendar_not_configured" }, 503);
    const plus = await plusOf(c, session.uid);
    if (plus === null) return c.json({ error: "billing_unavailable" }, 503);
    if (!plus) return c.json({ error: "plus_required" }, 403);
    const cred = await sealCredential(session, c.env.PUSH_SECRET!);
    if (!cred) return c.json({ error: "session_expired" }, 401);
    let body: any = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const tz = safeTimeZone(body?.tz, (c.req.raw as any)?.cf?.timezone);
    try {
      // A new link every time: the old one (if any) stops working.
      await forgetCalendar(c.env, session.uid, c.req.url, open);
      const token = newToken();
      const hash = await tokenHash(token);
      const createdAt = now();
      const feed: FeedRecord = { uid: session.uid, cred, tz, createdAt };
      await open(c.env, `f:${hash}`, c.req.url).write(feed);
      const link: LinkRecord = { sealedToken: await sealValue(token, c.env.PUSH_SECRET!, CALENDAR_LINK_PURPOSE, TEN_YEARS_S), hash, createdAt };
      await open(c.env, `u:${session.uid}`, c.req.url).write(link);
      return c.json({ url: feedUrl(c.req.url, token), createdAt });
    } catch (err) {
      console.error("calendar_store_failed", err instanceof Error ? err.message : String(err));
      return c.json({ error: "calendar_unavailable" }, 502);
    }
  });

  /** The app posts this now and then while the link is on: the stored sign-in becomes this session's (when it lasts longer). */
  app.post("/touch", deps.requireSession, async (c) => {
    const foreign = deps.fromOurApp(c);
    if (foreign) return foreign;
    noStore(c);
    const session: SessionData = c.get("session");
    if (isDemoSession(session) || isIncognitoSession(session) || !calendarConfigured(c.env)) return c.json({ ok: true, on: false });
    try {
      const link = await linkOf(c, session.uid);
      if (!link) return c.json({ ok: true, on: false });
      const feedStore = open(c.env, `f:${link.hash}`, c.req.url);
      const feed = (await feedStore.read()) as FeedRecord | null;
      if (!feed) return c.json({ ok: true, on: false });
      const cred = await sealCredential(session, c.env.PUSH_SECRET!);
      if (cred && cred.exp > (feed.cred?.exp ?? 0)) await feedStore.write({ ...feed, cred, lastReadAt: 0 });
      return c.json({ ok: true, on: true });
    } catch (err) {
      console.error("calendar_store_failed", err instanceof Error ? err.message : String(err));
      return c.json({ error: "calendar_unavailable" }, 502);
    }
  });

  app.delete("/", deps.requireSession, async (c) => {
    const foreign = deps.fromOurApp(c);
    if (foreign) return foreign;
    noStore(c);
    const session: SessionData = c.get("session");
    if (isDemoSession(session)) return c.json({ error: "not_available_in_demo" }, 403);
    await forgetCalendar(c.env, session.uid, c.req.url, open);
    return c.json({ ok: true });
  });

  /** The calendar itself. The token is the only key: no cookie, no Origin. */
  app.get("/:file", async (c) => {
    const file = c.req.param("file");
    const token = file.endsWith(".ics") ? file.slice(0, -4) : "";
    if (!TOKEN_RE.test(token)) return c.text("Not found", 404);
    if (!calendarConfigured(c.env) || !(deps.storeFor || c.env.CALENDAR)) return c.text("Calendar sync isn't set up", 503);
    const t = now();
    const feedStore = open(c.env, `f:${await tokenHash(token)}`, c.req.url);
    let feed: FeedRecord | null;
    try {
      feed = (await feedStore.read()) as FeedRecord | null;
    } catch {
      return c.text("Try again later", 503);
    }
    if (!feed?.uid) return c.text("Not found", 404);
    const tz = safeTimeZone(feed.tz);
    const send = (ics: string, maxAge = 900) =>
      new Response(ics, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'inline; filename="averages.ics"',
          "Cache-Control": `private, max-age=${maxAge}`,
          "X-Robots-Tag": "noindex",
        },
      });

    const plus = await plusOf(c, feed.uid);
    if (plus === false) {
      return send(buildIcs([], { now: t, tz, notice: { title: "Averages Plus has ended", text: "Calendar sync is part of Averages Plus, so this calendar has stopped updating. Pick Plus in Averages.io Settings > Account to turn it back on, then add the new link." } }));
    }
    const since = t - (feed.lastReadAt ?? 0);
    if (since >= 0 && since < MIN_READ_MS) {
      return new Response("Asked too often. Try again later.", {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((MIN_READ_MS - since) / 1000)), "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const opened = await openValue(feed.cred?.sealed ?? "", c.env.PUSH_SECRET!, CALENDAR_PURPOSE);
    const session = parseSession(opened);
    if (!session || session.uid !== feed.uid) {
      return send(buildIcs([], { now: t, tz, notice: { title: "Sign in to Averages.io", text: "Your Averages.io sign-in ran out, so this calendar stopped updating. Sign in to Averages.io and it picks up again on its own." } }));
    }
    // Noted before reading, so calendar apps retrying at once don't all reach the school platform.
    try {
      await feedStore.write({ ...feed, lastReadAt: t });
    } catch {
      return c.text("Try again later", 503);
    }
    try {
      const items = deps.dueItems
        ? await deps.dueItems(session, c.env, tz, t)
        : isGoogleSession(session)
          ? await classroomDueItems(session, c.env, tz, t)
          : await schoologyDueItems(session, tz, t);
      return send(buildIcs(items, { now: t, tz }));
    } catch (err) {
      console.error("calendar_read_failed", err instanceof Error ? err.message : String(err));
      // Calendar apps keep showing what they had; they ask again later.
      return c.text("Try again later", 503);
    }
  });

  return app;
}
