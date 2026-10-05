/**
 * api.averages.io — Averages.io's Schoology proxy (was api.schoolagy.io until 2026-10-05).
 *
 * Exists for one non-negotiable reason: OAuth-signed Schoology calls must
 * happen server-side. The user's consumer secret can never be exposed to
 * browser JS, so the browser talks to this Worker, and only this Worker talks
 * to Schoology.
 *
 * Deployed separately from the app (app.averages.io) so the two can be
 * redeployed, scaled and reasoned about independently.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  clearSessionCookie,
  DEMO_UID,
  isDemoSession as isDemo,
  openSession,
  readCookie,
  sealSession,
  sessionCookie,
  SESSION_COOKIE,
  type SessionData,
} from "./session.ts";
import {
  getAssignments,
  getGrades,
  getMe,
  getMessages,
  getSections,
  SchoologyError,
} from "./schoology.ts";
import { adaptAssignments, adaptCourses, adaptMessages, computeProjectedGPA } from "./adapt.ts";
import {
  deleteSyncRecord,
  loadSyncRecord,
  recordGpaSnapshot,
  saveSyncRecord,
  syncEnabledIn,
  weeklyGradeSummaryEnabledIn,
  kvFromSyncStore,
  type KVLike,
} from "./sync.ts";
import type { SyncStore } from "./syncStore.ts";

// The Durable Object class has to be exported from the Worker's main module
// for Cloudflare to find it (see wrangler.jsonc's durable_objects).
export { SyncStore } from "./syncStore.ts";

type Bindings = {
  /** Random high-entropy string. Set with: npx wrangler secret put SESSION_SECRET */
  SESSION_SECRET: string;
  /**
   * Backs "Sync Across Devices" and the Projected-GPA snapshot behind the
   * weekly-report email's "vs last week" line: one SyncStore Durable Object
   * per student, always opened in the "us" jurisdiction (see syncKV below).
   * Replaced the SYNC_KV namespace on 2026-10-04; KV copied data outside the US.
   */
  SYNC: DurableObjectNamespace<SyncStore>;
};

/** True only when this Worker is being reached on localhost (`wrangler dev`). */
function isLocalRequest(requestUrl: string): boolean {
  try {
    const { hostname } = new URL(requestUrl);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false; // unparseable: treat as production, the safe default
  }
}

/**
 * This student's sync storage: their own SyncStore Durable Object, created in
 * the "us" jurisdiction so the stored record and the code that reads it stay
 * in the United States (PowerSchool developer terms §3.2.1).
 *
 * Local exception: Cloudflare's local runtime (workerd, every Wrangler
 * version as of 2026-10-04) refuses jurisdictions outright ("Jurisdiction
 * restrictions are not implemented in workerd"), so under `wrangler dev` on
 * localhost the object is opened without one. That's decided from the
 * request's own URL, the same way allowedOrigins() does it, so a deployed
 * Worker can never take this path: it is never reached on localhost.
 *
 * The cast is only because the installed @cloudflare/workers-types predates
 * the "us" jurisdiction (added June 2026); the runtime accepts it.
 */
function syncKV(env: Bindings, uid: string, requestUrl: string): KVLike {
  return kvFromSyncStore(() => {
    const ns = isLocalRequest(requestUrl) ? env.SYNC : env.SYNC.jurisdiction("us" as DurableObjectJurisdiction);
    return ns.get(ns.idFromName(uid));
  });
}

type Variables = {
  session: SessionData;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * `DEMO_UID` / `isDemo` are imported from ./session.ts rather than defined
 * here. They used to live in this file, which meant session.ts — the module
 * that decides whether a token is valid at all — had no idea demo sessions
 * existed, and rejected every one of them.
 */

/**
 * averages.io only, as of 2026-10-05 (schoolagy.io before that: it carries a
 * greyware tag on school filters and reads as a Schoology lookalike).
 *
 * Earlier, schoolagy.io only, as of 2026-09-08.
 *
 * A `sch00lagy.com` fallback domain briefly existed (for when a school
 * network blocked schoolagy.io outright) behind a `src/domains.ts` module
 * that matched the incoming request's Host/Origin to the right domain
 * family at runtime. Removed per Martin: it also turned out to be the
 * actual cause of a real deploy failure — that file never made it into the
 * live repo when the change was applied, so every build since then failed
 * with "Cannot find module './domains.ts'" the moment something else
 * triggered a rebuild. Back to one fixed domain, one fixed cookie domain,
 * nothing to keep in sync across two files. If a second domain is wanted
 * again later, `src/domains.ts` from that point in history is the pattern
 * to bring back — deliberately not resurrected here as a "just in case"
 * middle ground, since an unused abstraction is exactly the kind of thing
 * that quietly drifts out of sync with what's actually deployed.
 */
const ALLOWED_ORIGINS = ["https://app.averages.io", "https://averages.io"];

/** Only honoured when this Worker is itself being reached on localhost — see allowedOrigins(). */
const DEV_ORIGIN = "http://localhost:3000";

const COOKIE_DOMAIN = ".averages.io";

/** Ceiling on one user's synced settings blob — see PUT /sync/settings. */
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;

/**
 * The CORS allow-list for THIS request.
 *
 * `http://localhost:3000` used to sit in the list unconditionally, including
 * in production. That's a real hole, if a narrow one: with `credentials: true`,
 * any page served from port 3000 on a student's own machine could call this
 * API with their session cookie attached and read the response — their whole
 * Schoology account — because the browser considers that origin allowed. It
 * was only ever there for local development, and local development doesn't
 * need it from production: the app's own API_BASE (see the app's
 * lib/averages.ts) points a localhost app at a localhost Worker, not at
 * api.averages.io. So allow it only when the Worker answering is itself
 * local, which is exactly the `wrangler dev` case and never the deployed one.
 */
function allowedOrigins(requestUrl: string): string[] {
  // An unparseable URL counts as production (see isLocalRequest), which is the
  // safe default: never widen the allow-list on an error path.
  return isLocalRequest(requestUrl) ? [...ALLOWED_ORIGINS, DEV_ORIGIN] : ALLOWED_ORIGINS;
}

app.use("*", async (c, next) => {
  const allowed = allowedOrigins(c.req.url);
  return cors({
    // Returning a non-matching origin for anything not on the list is the deny
    // path: the browser compares Access-Control-Allow-Origin against its own
    // origin and blocks the response when they differ.
    origin: (origin) => (allowed.includes(origin) ? origin : allowed[0]),
    // Required for the httpOnly session cookie to travel at all.
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })(c, next);
});

/** Resolves the session cookie, or 401s. */
async function requireSession(c: any, next: any) {
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: "not_authenticated" }, 401);
  }
  const session = await openSession(token, c.env.SESSION_SECRET);
  if (!session) {
    // Expired or tampered — clear it so the browser stops sending a dead cookie.
    c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN));
    return c.json({ error: "session_expired" }, 401);
  }
  c.set("session", session);
  await next();
}

/**
 * Health check — and, deliberately, a configuration check.
 *
 * `configured` reports whether SESSION_SECRET is actually visible to the
 * RUNNING Worker. That distinction matters and is easy to get wrong: a value
 * entered as a "build variable" in the Workers Builds settings is available
 * while the project builds and is simply absent at runtime, which produces a
 * confusing 500 on sign-in with nothing in the dashboard obviously wrong.
 *
 * Opening this URL in a browser answers the question in one second. It reports
 * only WHETHER the secret exists — never any part of the value, and (since
 * 2026-09-15) not its length either. This endpoint is public and unauthenticated,
 * and publishing the exact length of the key that seals every session cookie
 * tells an attacker how much work a brute-force is, for no diagnostic benefit:
 * "is it set or not" is the entire question this is here to answer.
 */
app.get("/", (c) => {
  const secret = c.env.SESSION_SECRET ?? "";
  return c.json({
    service: "averages-api",
    status: "ok",
    configured: secret.length > 0,
    hint:
      secret.length > 0
        ? "Ready. SESSION_SECRET is set as a runtime secret."
        : "SESSION_SECRET is NOT reaching the Worker at runtime. Set it under the Worker's Settings -> Variables and Secrets (type: Secret), or run: npx wrangler secret put SESSION_SECRET. A value entered in Build settings does not count.",
    docs: "https://github.com/averages-io/averages.api",
  });
});

/**
 * Sign in with a personal Schoology API key + secret.
 *
 * Verifies the credentials by actually calling Schoology as that user before
 * accepting them — so a typo fails here, at the login screen, rather than
 * silently producing an app full of empty pages.
 */
app.post("/auth/session", async (c) => {
  let body: { key?: string; secret?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const key = (body.key ?? "").trim();
  const secret = (body.secret ?? "").trim();
  if (!key || !secret) {
    return c.json({ error: "missing_credentials" }, 400);
  }

  if (!c.env.SESSION_SECRET) {
    // Fail loudly rather than silently issuing sessions sealed with "undefined".
    return c.json({ error: "server_misconfigured" }, 500);
  }

  /**
   * Demo mode: "demo" as both the key and the secret.
   *
   * This is the ONLY way into the sample-data version of the app. It goes
   * through sign-in like any other credential and produces a real session
   * cookie, which matters: it means the server decides who gets in, so nobody
   * can reach an app page by editing browser storage or typing a URL. There is
   * no client-side shortcut and no local flag to forge.
   *
   * A demo session carries no Schoology credentials at all — it can't, because
   * there are none — so every authenticated route below refuses it rather than
   * attempting a signed call with empty keys.
   */
  if (key.toLowerCase() === "demo" && secret.toLowerCase() === "demo") {
    const token = await sealSession(
      { key: "", secret: "", uid: DEMO_UID },
      c.env.SESSION_SECRET
    );
    c.header("Set-Cookie", sessionCookie(token, COOKIE_DOMAIN));
    return c.json({
      ok: true,
      demo: true,
      user: { uid: DEMO_UID, name: "Demo Student", firstName: "Demo", email: "", pictureUrl: "" },
    });
  }

  try {
    const me = await getMe({ key, secret });
    const uid = String(me.uid ?? me.id ?? "");
    if (!uid) {
      return c.json({ error: "no_user_id" }, 502);
    }

    const token = await sealSession({ key, secret, uid }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(token, COOKIE_DOMAIN));

    return c.json({
      ok: true,
      user: {
        uid,
        name: me.name_display || me.name_first || "Student",
        firstName: me.name_first ?? "",
        email: me.primary_email ?? "",
        pictureUrl: me.picture_url ?? "",
      },
    });
  } catch (error) {
    if (error instanceof SchoologyError) {
      // 401/403 from Schoology means the key/secret pair is wrong or revoked —
      // report that as a credential problem, not a server error.
      if (error.status === 401 || error.status === 403) {
        return c.json({ error: "invalid_credentials" }, 401);
      }
      return c.json({ error: "schoology_error", status: error.status }, 502);
    }
    return c.json({ error: "unexpected_error" }, 500);
  }
});

app.delete("/auth/session", (c) => {
  c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN));
  return c.json({ ok: true });
});

app.get("/auth/me", requireSession, async (c) => {
  const session = c.get("session");

  if (isDemo(session)) {
    return c.json({
      uid: DEMO_UID,
      demo: true,
      name: "Demo Student",
      firstName: "Demo",
      email: "",
      pictureUrl: "",
    });
  }

  try {
    const me = await getMe(session);
    return c.json({
      uid: session.uid,
      name: me.name_display || me.name_first || "Student",
      firstName: me.name_first ?? "",
      email: me.primary_email ?? "",
      pictureUrl: me.picture_url ?? "",
    });
  } catch {
    return c.json({ error: "schoology_unreachable" }, 502);
  }
});

/**
 * Sync Across Devices — read/write the signed-in user's synced settings blob.
 *
 * Refused for demo sessions (403 `not_available_in_demo`), same pattern as
 * `/schoology/*` below: a demo session has no real Schoology uid, so there's
 * no stable key to store anything under, and nothing on a demo account is
 * meant to persist between visits in the first place.
 *
 * The API doesn't validate or interpret the settings blob's shape — it's
 * whatever the client's Settings page decides to merge together from its own
 * localStorage keys (see sync.ts's file comment). This endpoint's only job is
 * "keep this JSON, keyed to this user, hand it back."
 */
app.get("/sync/settings", requireSession, async (c) => {
  const session = c.get("session");
  if (isDemo(session)) {
    return c.json({ error: "not_available_in_demo" }, 403);
  }
  const record = await loadSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid);
  return c.json(record);
});

app.put("/sync/settings", requireSession, async (c) => {
  const session = c.get("session");
  if (isDemo(session)) {
    return c.json({ error: "not_available_in_demo" }, 403);
  }

  let body: { settings?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  if (body.settings === undefined) {
    return c.json({ error: "missing_settings" }, 400);
  }

  /**
   * Bound what one account can park in KV.
   *
   * This blob is whatever the Settings page decides to merge together, stored
   * verbatim and never inspected — which until now meant no ceiling at all
   * beyond Cloudflare's own 25MB-per-value limit. It legitimately carries a
   * cropped wallpaper as a data: URL (a 1600px JPEG, so a few hundred KB is
   * normal and expected), so the cap has to sit well clear of that; 2MB is
   * roughly triple the realistic worst case and still a hard stop on using a
   * student account as free storage. Rejecting loudly with 413 rather than
   * truncating: a silently half-saved settings record is worse than one that
   * didn't save.
   */
  let serialized: string;
  try {
    serialized = JSON.stringify(body.settings);
  } catch {
    // Circular structure, or something else JSON can't represent.
    return c.json({ error: "invalid_settings" }, 400);
  }
  if (serialized.length > MAX_SETTINGS_BYTES) {
    return c.json({ error: "settings_too_large", maxBytes: MAX_SETTINGS_BYTES }, 413);
  }

  // Preserve any GPA snapshot already on file — this endpoint only owns the
  // `settings` half of the record; `/data/bundle` below owns `gpaSnapshot`.
  // The one exception: if this push shows Weekly Grade Summary is now off,
  // clear the snapshot outright instead of leaving it to sit there unused.
  // Gating storage on the toggle (see weeklyGradeSummaryEnabledIn in
  // sync.ts, added 2026-09-12) only means anything if turning the toggle
  // off actually makes Averages.io stop holding the number, not just stop it
  // from updating further.
  const existing = await loadSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid);
  const now = new Date().toISOString();
  const record = {
    ...existing,
    settings: body.settings,
    gpaSnapshot: weeklyGradeSummaryEnabledIn(body.settings)
      ? existing.gpaSnapshot
      : { current: null, previous: null },
    updatedAt: now,
    // Stamped here, and ONLY here (not by the GPA-snapshot piggyback in
    // /data/bundle below) — see SyncRecord's own comment in sync.ts for
    // why settings.html's pull logic needs this separate from updatedAt.
    settingsUpdatedAt: now,
  };
  await saveSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid, record);
  return c.json(record);
});

/**
 * Turning Sync Across Devices off is a real "forget me," not just "stop
 * asking" — added 2026-09-09 per Martin. Before this, the toggle only ever
 * flipped a local flag (`schoolagy_settings_options.syncAcrossDevices`) off;
 * `deleteSyncRecord` already existed in sync.ts but nothing ever called it,
 * so whatever had last been pushed — the settings blob AND the GPA-history
 * snapshots — just sat in KV under the user's uid indefinitely. Turning sync
 * back on later would have silently pulled that stale record back down.
 *
 * settings.html calls this the moment the user confirms turning sync off
 * (see its own comment there). Deletes the WHOLE record — both halves,
 * settings and gpaSnapshot — not just the settings half this endpoint's
 * GET/PUT otherwise own, since "delete my data" means all of it.
 */
app.delete("/sync/settings", requireSession, async (c) => {
  const session = c.get("session");
  if (isDemo(session)) {
    return c.json({ error: "not_available_in_demo" }, 403);
  }
  await deleteSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid);
  return c.json({ ok: true });
});

/**
 * One call that returns everything the app's pages need, already mapped into
 * the shapes they render.
 *
 * Deliberately a single endpoint rather than one per page: Schoology is slow
 * and rate-limited, sections/grades/assignments are all interdependent, and a
 * page-by-page fetch would mean the same sections call repeated on every
 * navigation.
 */
app.get("/data/bundle", requireSession, async (c) => {
  const session = c.get("session");

  // Demo sessions have no Schoology account behind them. Returning an empty
  // bundle (rather than erroring) is what makes every page fall through to the
  // sample data baked into its own markup.
  if (isDemo(session)) {
    return c.json({ demo: true, generatedAt: new Date().toISOString() });
  }

  try {
    /**
     * One wave for everything that depends on nothing (2026-09-17).
     *
     * This used to be three separate waits, and two of them didn't need to
     * be: the inbox fetch sat at the bottom of the handler, behind the twelve
     * assignment calls, and the sync-record read sat below that again — even
     * though neither needs a single byte from Schoology's sections or grades.
     * Every bundle paid two full round trips for the ordering alone.
     *
     * Now there are exactly two waits, and the second one is the only one
     * that has to be second: assignments are per-section, so they can't be
     * asked for until wave 1 says which sections exist.
     *
     * The two `.catch` handlers are load-bearing. `Promise.all` rejects on the
     * FIRST rejection, so an unguarded inbox fetch — messaging can be turned
     * off district-wide — would take sections and grades down with it and turn
     * a working grades page into a 502. Sections and grades are deliberately
     * left unguarded: without them there is no bundle to return.
     */
    const [sections, grades, inbox, syncRecord] = await Promise.all([
      getSections(session.uid, session),
      getGrades(session.uid, session),
      getMessages("inbox", session).catch(() => null),
      loadSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid).catch(() => null),
    ]);

    const { COURSES, HISTORY } = adaptCourses(sections, grades);

    // Assignments are per-section, so this fans out. Capped and failure-
    // tolerant: one section erroring (a teacher restricting access, say)
    // must not take down the whole payload.
    const assignmentsBySection: Record<string, any[]> = {};
    await Promise.all(
      COURSES.slice(0, 12).map(async (course) => {
        try {
          assignmentsBySection[course.id] = await getAssignments(
            course.id,
            session
          );
        } catch {
          assignmentsBySection[course.id] = [];
        }
      })
    );

    const { OVERDUE, UPCOMING, TODAY } = adaptAssignments(assignmentsBySection);

    // The fetch already happened up in wave 1; this is just the mapping. It
    // keeps its own guard because adaptMessages walks a shape Schoology varies
    // by district, and a surprise there must not cost the student their
    // grades either.
    let MESSAGES: any[] = [];
    try {
      MESSAGES = inbox ? adaptMessages(inbox) : [];
    } catch {
      MESSAGES = [];
    }

    /**
     * Projected-GPA snapshot for the weekly-report email's "vs last week"
     * line — piggybacked on this request rather than its own fetch/cron,
     * since COURSES (and each course's predicted grade) was just computed
     * above anyway. Recorded only for a user who (a) is real, not demo —
     * already true of this whole branch — (b) has Sync Across Devices on,
     * and (c) has Weekly Grade Summary itself turned on.
     *
     * (b) alone used to be the only check here, on the theory that the
     * client already enforces "no weekly email without sync" so checking
     * again server-side was redundant — but that meant anyone with sync on
     * got a GPA snapshot recorded regardless of whether they'd ever turned
     * the email on, which is more retention than the feature it's for
     * needs. Fixed 2026-09-12, per Martin, alongside shrinking storage
     * itself from a 12-week rolling history down to just this week's number
     * and the one before it — see sync.ts's own top-of-file comment.
     * Best-effort and non-blocking either way: a KV hiccup here must never
     * turn into a failed page load for the student who just wants to see
     * their grades.
     */
    const projectedGPA = computeProjectedGPA(COURSES);
    let gpaVsLastWeek: number | null = null;
    try {
      // `syncRecord` was read in wave 1 — it only ever needed session.uid.
      // Null means the read failed, which is treated the same as sync being
      // off: no snapshot, no delta, and the grades still render.
      if (syncRecord && syncEnabledIn(syncRecord.settings) && weeklyGradeSummaryEnabledIn(syncRecord.settings)) {
        const snapshot = recordGpaSnapshot(syncRecord, projectedGPA);
        gpaVsLastWeek = snapshot.deltaVsLastWeek;
        c.executionCtx.waitUntil(saveSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid, snapshot.record));
      }
    } catch {
      // Never let GPA-snapshot bookkeeping take the whole bundle down with it.
    }

    return c.json({
      generatedAt: new Date().toISOString(),
      COURSES,
      HISTORY,
      OVERDUE,
      UPCOMING,
      TODAY,
      MESSAGES,
      projectedGPA,
      gpaVsLastWeek,
    });
  } catch (error) {
    if (error instanceof SchoologyError) {
      return c.json({ error: "schoology_error", status: error.status }, 502);
    }
    return c.json({ error: "unexpected_error" }, 500);
  }
});

/**
 * REMOVED 2026-09-15: `GET /schoology/*`, a signed passthrough to any
 * read-only Schoology endpoint.
 *
 * It was built as an escape hatch so the app could reach parts of Schoology
 * with no dedicated adapter yet without a Worker redeploy. Nothing ever used
 * it — a search across the whole app (pages-src, app/, scripts/) found zero
 * callers — so what it actually provided was a single authenticated URL that
 * would relay ANY read from a signed-in student's Schoology account back to
 * whatever asked. That's a large amplifier for any other bug: one XSS, one
 * malicious extension, one leaked session and the reachable blast radius is
 * everything Schoology will show that student, rather than the specific
 * fields /data/bundle chooses to return.
 *
 * Deleting it is not a loss of capability — the typed helpers in
 * schoology.ts (getMe/getSections/getGrades/getAssignments/getMessages) are
 * how every real call is made, and a new endpoint is a few lines there plus a
 * route here. If it's ever wanted back, bring it back deliberately, with an
 * allow-list of the exact paths the app needs rather than a wildcard.
 */

export default app;
