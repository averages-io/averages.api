/**
 * api.schoolagy.io — Schoolagy's Schoology proxy.
 *
 * Exists for one non-negotiable reason: OAuth-signed Schoology calls must
 * happen server-side. The user's consumer secret can never be exposed to
 * browser JS, so the browser talks to this Worker, and only this Worker talks
 * to Schoology.
 *
 * Deployed separately from the app (app.schoolagy.io) so the two can be
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
  schoologyGet,
  SchoologyError,
} from "./schoology.ts";
import { adaptAssignments, adaptCourses, adaptMessages, computeProjectedGPA } from "./adapt.ts";
import {
  loadSyncRecord,
  recordGpaSnapshot,
  saveSyncRecord,
  syncEnabledIn,
  type KVLike,
} from "./sync.ts";

type Bindings = {
  /** Random high-entropy string. Set with: npx wrangler secret put SESSION_SECRET */
  SESSION_SECRET: string;
  /**
   * Backs "Sync Across Devices" and the Projected-GPA history behind the
   * weekly-report email's "vs last week" line — see sync.ts. Provision with:
   *   npx wrangler kv namespace create SYNC_KV
   * then paste the returned id into wrangler.jsonc's kv_namespaces entry.
   */
  SYNC_KV: KVLike;
};

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
 * schoolagy.io only, as of 2026-09-08.
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
const ALLOWED_ORIGINS = ["https://app.schoolagy.io", "https://schoolagy.io", "http://localhost:3000"];
const COOKIE_DOMAIN = ".schoolagy.io";

app.use("*", async (c, next) => {
  return cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]),
    // Required for the httpOnly session cookie to travel at all.
    credentials: true,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
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
    c.header("Set-Cookie", clearSessionCookie(cookieDomain(c)));
    return c.json({ error: "session_expired" }, 401);
  }
  c.set("session", session);
  await next();
}

function cookieDomain(_c: any): string {
  return COOKIE_DOMAIN;
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
 * only whether the secret exists and how long it is — never any part of the
 * value itself.
 */
app.get("/", (c) => {
  const secret = c.env.SESSION_SECRET ?? "";
  return c.json({
    service: "schoolagy-api",
    status: "ok",
    configured: secret.length > 0,
    sessionSecretLength: secret.length,
    hint:
      secret.length > 0
        ? "Ready. SESSION_SECRET is set as a runtime secret."
        : "SESSION_SECRET is NOT reaching the Worker at runtime. Set it under the Worker's Settings -> Variables and Secrets (type: Secret), or run: npx wrangler secret put SESSION_SECRET. A value entered in Build settings does not count.",
    docs: "https://github.com/Schoolagy",
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
    c.header("Set-Cookie", sessionCookie(token, cookieDomain(c)));
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
    c.header("Set-Cookie", sessionCookie(token, cookieDomain(c)));

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
  c.header("Set-Cookie", clearSessionCookie(cookieDomain(c)));
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
  const record = await loadSyncRecord(c.env.SYNC_KV, session.uid);
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

  // Preserve any GPA history already on file — this endpoint only owns the
  // `settings` half of the record; `/data/bundle` below owns `gpaHistory`.
  const existing = await loadSyncRecord(c.env.SYNC_KV, session.uid);
  const record = {
    ...existing,
    settings: body.settings,
    updatedAt: new Date().toISOString(),
  };
  await saveSyncRecord(c.env.SYNC_KV, session.uid, record);
  return c.json(record);
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
    const [sections, grades] = await Promise.all([
      getSections(session.uid, session),
      getGrades(session.uid, session),
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

    let MESSAGES: any[] = [];
    try {
      MESSAGES = adaptMessages(await getMessages("inbox", session));
    } catch {
      // Messaging can be disabled district-wide; that's not a failure of the
      // rest of the app.
      MESSAGES = [];
    }

    /**
     * Projected-GPA snapshot for the weekly-report email's "vs last week"
     * line — piggybacked on this request rather than its own fetch/cron,
     * since COURSES (and each course's predicted grade) was just computed
     * above anyway. Only recorded for a user who (a) is real, not demo —
     * already true of this whole branch — and (b) has Sync Across Devices on,
     * per the rule enforced client-side in settings.html: Weekly Grade
     * Summary can't be turned on without it, so a user with sync off has no
     * use for a snapshot regardless. Best-effort and non-blocking: a KV
     * hiccup here must never turn into a failed page load for the student
     * who just wants to see their grades.
     */
    const projectedGPA = computeProjectedGPA(COURSES);
    let gpaVsLastWeek: number | null = null;
    try {
      const syncRecord = await loadSyncRecord(c.env.SYNC_KV, session.uid);
      if (syncEnabledIn(syncRecord.settings)) {
        const snapshot = recordGpaSnapshot(syncRecord, projectedGPA);
        gpaVsLastWeek = snapshot.deltaVsLastWeek;
        c.executionCtx.waitUntil(saveSyncRecord(c.env.SYNC_KV, session.uid, snapshot.record));
      }
    } catch {
      // Never let GPA-history bookkeeping take the whole bundle down with it.
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
 * Escape hatch: signed passthrough to any read-only Schoology endpoint.
 *
 * Lets the app reach parts of the API that don't have a dedicated adapter yet
 * without needing a Worker redeploy for each one. GET-only on purpose — this
 * beta has no reason to write to a student's Schoology account, and not
 * accepting writes at all is a stronger guarantee than validating them.
 */
app.get("/schoology/*", requireSession, async (c) => {
  const session = c.get("session");

  if (isDemo(session)) {
    return c.json({ error: "not_available_in_demo" }, 403);
  }

  const path = c.req.path.replace(/^\/schoology/, "");
  if (!path || path.includes("..")) {
    return c.json({ error: "invalid_path" }, 400);
  }

  const query: Record<string, string> = {};
  const url = new URL(c.req.url);
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  try {
    return c.json(await schoologyGet(path, session, query));
  } catch (error) {
    if (error instanceof SchoologyError) {
      return c.json({ error: "schoology_error", status: error.status }, 502);
    }
    return c.json({ error: "unexpected_error" }, 500);
  }
});

export default app;
