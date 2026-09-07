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
import { adaptAssignments, adaptCourses, adaptMessages } from "./adapt.ts";

type Bindings = {
  /** Random high-entropy string. Set with: npx wrangler secret put SESSION_SECRET */
  SESSION_SECRET: string;
  /** Comma-separated list of allowed browser origins. */
  ALLOWED_ORIGINS?: string;
  /** Cookie domain, e.g. ".schoolagy.io" */
  COOKIE_DOMAIN?: string;
};

type Variables = {
  session: SessionData;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Marks a session as the sample-data demo rather than a real Schoology login.
 * A demo session deliberately holds no key/secret, so it can never produce a
 * signed Schoology request even by accident.
 */
const DEMO_UID = "__demo__";

function isDemo(session: { uid: string }): boolean {
  return session.uid === DEMO_UID;
}

const DEFAULT_ORIGINS = [
  "https://app.schoolagy.io",
  "https://schoolagy.io",
  "http://localhost:3000",
];

app.use("*", async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const origins = allowed.length ? allowed : DEFAULT_ORIGINS;

  return cors({
    origin: (origin) => (origins.includes(origin) ? origin : origins[0]),
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

function cookieDomain(c: any): string {
  return c.env.COOKIE_DOMAIN ?? ".schoolagy.io";
}

app.get("/", (c) =>
  c.json({
    service: "schoolagy-api",
    status: "ok",
    docs: "https://github.com/Schoolagy",
  })
);

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

    return c.json({
      generatedAt: new Date().toISOString(),
      COURSES,
      HISTORY,
      OVERDUE,
      UPCOMING,
      TODAY,
      MESSAGES,
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
