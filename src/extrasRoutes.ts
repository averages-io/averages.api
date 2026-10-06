/**
 * Routes for the per-page extras and Schoology messages (2026-10-06),
 * mounted by index.ts:
 *
 *   app.route("/data", dataExtrasRoutes(deps))      people, updates, events, folders, gradebook
 *   app.route("/messages", messagesRoutes(deps))    list, thread, send, reply, recipients
 *
 * The work is in extras.ts and messages.ts; this file only checks the
 * request and picks the answer. Every answer is `private, no-store`. A demo
 * session gets 403 `not_available_in_demo` (its pages run on sample data and
 * never call these). Schoology failures are 502 `schoology_error`; Classroom
 * ones go through index.ts's classroomFailure (401 signs out, else 502).
 */

import { Hono } from "hono";
import { CALL_BUDGET, CallBudget, CLASSROOM_ID_RE } from "./classroom.ts";
import {
  fetchClassroomEvents,
  fetchClassroomFolders,
  fetchClassroomPeople,
  fetchSchoologyEvents,
  fetchSchoologyFolders,
  fetchSchoologyGradebook,
  fetchSchoologyPeople,
  fetchSchoologyUpdates,
  parseRange,
  refused,
  SCHOOLOGY_ID_RE,
} from "./extras.ts";
import {
  adaptRecipients,
  adaptThread,
  getRecipients,
  getThread,
  ID_RE,
  loadConversations,
  parseNewMessage,
  parseReply,
  sendNewMessage,
  sendReply,
} from "./messages.ts";
import { SchoologyError } from "./schoology.ts";
import { isDemoSession, isGoogleSession, type SessionData } from "./session.ts";

export interface ExtrasDeps {
  /** index.ts's requireSession: 401s without a valid session, else sets c.get("session"). */
  requireSession: (c: any, next: () => Promise<void>) => Promise<Response | void>;
  /** index.ts's notFromOurApp: a Response for a foreign Origin or a non-JSON POST, else null. */
  fromOurApp: (c: any) => Response | null;
  /** A working Google access token for a Google session (refreshing it when needed). */
  googleAccess: (c: any, session: SessionData) => Promise<string>;
  /** How a failed Classroom/Google call is answered. */
  classroomFailure: (c: any, error: unknown) => Response;
  /** The student's time zone (the app's ?tz=, else Cloudflare's guess, else UTC). */
  studentTimeZone: (c: any) => string;
}

function schoologyFailure(c: any, error: unknown) {
  if (error instanceof SchoologyError) return c.json({ error: "schoology_error", status: error.status }, 502);
  console.error("extras_failed", error instanceof Error ? error.message : String(error));
  return c.json({ error: "unexpected_error" }, 500);
}

/** Read a JSON request body; null when it isn't a JSON object. */
async function jsonBody(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function dataExtrasRoutes(deps: ExtrasDeps) {
  const app = new Hono<{ Variables: { session: SessionData } }>();

  // Shared by every extra: no caching anywhere, and no demo. Added to each
  // route rather than with app.use("*"): mounted at /data, a "*" middleware
  // here would also wrap index.ts's own /data routes (the bundle answers a
  // demo session with sample-data mode, not 403).
  const guard = async (c: any, next: () => Promise<void>) => {
    c.header("Cache-Control", "private, no-store");
    if (isDemoSession(c.get("session"))) return c.json({ error: "not_available_in_demo" }, 403);
    await next();
  };

  /** A Classroom extra: the token, a fresh call budget and the granted permission letters. */
  const classroom = async (c: any, session: SessionData) => ({
    token: await deps.googleAccess(c, session),
    budget: new CallBudget(CALL_BUDGET),
    letters: session.g!.sc,
  });

  app.get("/people", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    if (isGoogleSession(session)) {
      try {
        const { token, budget, letters } = await classroom(c, session);
        const answer = await fetchClassroomPeople(token, letters, budget);
        return c.json({ ...answer, partial: answer.partial || budget.cut });
      } catch (error) {
        return deps.classroomFailure(c, error);
      }
    }
    try {
      return c.json(await fetchSchoologyPeople(session.uid, session));
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  app.get("/updates", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    // Classroom's announcements are already in the bundle.
    if (isGoogleSession(session)) return c.json({ COURSE_UPDATES: null, partial: false });
    try {
      return c.json(await fetchSchoologyUpdates(session.uid, session));
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  app.get("/events", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    const range = parseRange(c.req.query("start"), c.req.query("end"));
    if (!range) return c.json({ error: "bad_range" }, 400);
    const course = c.req.query("course");
    const google = isGoogleSession(session);
    if (course !== undefined && !(google ? CLASSROOM_ID_RE : SCHOOLOGY_ID_RE).test(course)) return c.json({ error: "bad_request" }, 400);
    if (google) {
      try {
        const { token, budget } = await classroom(c, session);
        return c.json(await fetchClassroomEvents(token, budget, range, deps.studentTimeZone(c), course ?? null));
      } catch (error) {
        return deps.classroomFailure(c, error);
      }
    }
    try {
      return c.json(await fetchSchoologyEvents(session.uid, session, range, course ?? null));
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  app.get("/folders", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    const course = c.req.query("course") ?? "";
    if (isGoogleSession(session)) {
      if (!CLASSROOM_ID_RE.test(course)) return c.json({ error: "bad_request" }, 400);
      try {
        const { token, budget, letters } = await classroom(c, session);
        return c.json({ course, ...(await fetchClassroomFolders(token, letters, budget, course)) });
      } catch (error) {
        return deps.classroomFailure(c, error);
      }
    }
    if (!SCHOOLOGY_ID_RE.test(course)) return c.json({ error: "bad_request" }, 400);
    try {
      return c.json({ course, ...(await fetchSchoologyFolders(course, session)) });
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  app.get("/gradebook", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    const course = c.req.query("course") ?? "";
    if (isGoogleSession(session)) {
      if (!CLASSROOM_ID_RE.test(course)) return c.json({ error: "bad_request" }, 400);
      // The bundle's Classroom gradebook is already exact (it has the class's own settings).
      return c.json({ GRADEBOOK: null, partial: false });
    }
    if (!SCHOOLOGY_ID_RE.test(course)) return c.json({ error: "bad_request" }, 400);
    try {
      return c.json(await fetchSchoologyGradebook(session.uid, course, session));
    } catch (error) {
      if (error instanceof SchoologyError && error.status === 404) return c.json({ error: "not_found" }, 404);
      return schoologyFailure(c, error);
    }
  });

  return app;
}

/**
 * Schoology private messages. Classroom has none: 404 `not_available`.
 * Sending (POST) must come from our own app (deps.fromOurApp).
 */
export function messagesRoutes(deps: ExtrasDeps) {
  const app = new Hono<{ Variables: { session: SessionData } }>();

  const guard = async (c: any, next: () => Promise<void>) => {
    c.header("Cache-Control", "private, no-store");
    if (c.req.method === "POST") {
      const foreign = deps.fromOurApp(c);
      if (foreign) return foreign;
    }
    const session = c.get("session");
    if (isDemoSession(session)) return c.json({ error: "not_available_in_demo" }, 403);
    if (isGoogleSession(session)) return c.json({ error: "not_available" }, 404);
    await next();
  };

  app.get("/", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    try {
      return c.json(await loadConversations(session, session.uid));
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  app.get("/thread", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    const id = c.req.query("id") ?? "";
    if (!ID_RE.test(id)) return c.json({ error: "bad_request" }, 400);
    try {
      const rows = await getThread(id, session);
      if (!rows) return c.json({ error: "not_found" }, 404);
      return c.json(adaptThread(id, rows, session.uid, deps.studentTimeZone(c)));
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  app.get("/recipients", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    try {
      return c.json({ recipients: adaptRecipients(await getRecipients(session)) });
    } catch (error) {
      // Not allowed to list them (some districts, some personal keys): nobody to show, not a failure.
      if (refused(error)) return c.json({ recipients: [] });
      return schoologyFailure(c, error);
    }
  });

  app.post("/", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    const parsed = parseNewMessage(await jsonBody(c), session.uid);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const sent = await sendNewMessage(session, parsed);
      if (!sent.ok) return c.json({ error: sent.error }, 403);
      return c.json({ ok: true, id: sent.id });
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  app.post("/reply", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    const parsed = parseReply(await jsonBody(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const sent = await sendReply(session, session.uid, parsed);
      if (!sent.ok) return c.json({ error: sent.error }, sent.error === "not_found" ? 404 : 409);
      return c.json({ ok: true });
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  return app;
}
