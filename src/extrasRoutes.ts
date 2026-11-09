// Routes for the per-page extras and Schoology messages, mounted by index.ts.

import { answerUnlessSame } from "./fingerprint.ts";
import { Hono } from "hono";
import { CALL_BUDGET, CallBudget, CLASSROOM_ID_RE } from "./classroom.ts";
import {
  fetchClassroomClassmates,
  fetchClassroomEvents,
  fetchClassroomFolders,
  fetchClassroomPeople,
  fetchSchoologyClassmates,
  fetchSchoologyEvents,
  fetchSchoologyFolders,
  fetchSchoologyGradebook,
  fetchSchoologyPeople,
  fetchSchoologyUpdates,
  parseRange,
  refused,
  SCHOOLOGY_ID_RE,
} from "./extras.ts";
import { canMessage, searchPeople, setThreadStatus,
  adaptRecipients,
  adaptThread,
  deleteThread,
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
import { schoologyPostJson } from "./submit.ts";
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

  app.get("/classmates", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    if (isGoogleSession(session)) {
      try {
        const { token, budget, letters } = await classroom(c, session);
        const answer = await fetchClassroomClassmates(token, letters, budget, String(session.uid ?? ""));
        return c.json({ ...answer, partial: answer.partial || budget.cut });
      } catch (error) {
        return deps.classroomFailure(c, error);
      }
    }
    try {
      return c.json(await fetchSchoologyClassmates(session.uid, session));
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  app.post("/join", deps.requireSession, guard, async (c: any) => {
    const foreign = deps.fromOurApp(c);
    if (foreign) return foreign;
    const session = c.get("session");
    if (isGoogleSession(session)) return c.json({ error: "not_supported" }, 400);
    const body = (await jsonBody(c)) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!/^[A-Z0-9][A-Z0-9-]{3,19}$/.test(code)) return c.json({ error: "bad_code" }, 400);
    try {
      const { status, json } = await schoologyPostJson("/sections/accesscode", session, { access_code: code });
      if (status >= 200 && status < 300) {
        const section = String(json?.section_id ?? json?.realm_id ?? json?.id ?? "");
        return c.json({ ok: true, section: SCHOOLOGY_ID_RE.test(section) ? section : "" });
      }
      return c.json({ error: "not_joined", status }, 400);
    } catch (error) {
      // Schoology said no (a wrong code, a class that's closed to joining, or this call not being open to students).
      if (error instanceof SchoologyError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429) return c.json({ error: "not_joined", status: error.status }, 400);
      return schoologyFailure(c, error);
    }
  });

  app.get("/updates", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    // Classroom's announcements are already in the bundle.
    if (isGoogleSession(session)) return c.json({ COURSE_UPDATES: null, partial: false });
    try {
      return answerUnlessSame(c, await fetchSchoologyUpdates(session.uid, session));
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

  // Add contacts: people in Schoology by name (GET /messages/people?q=, &scope=school for just their school)
  app.get("/people", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    try {
      return c.json({ people: await searchPeople(session, String(c.req.query("q") ?? ""), { mySchool: c.req.query("scope") === "school" }) });
    } catch (error) {
      if (refused(error)) return c.json({ people: [] });
      return schoologyFailure(c, error);
    }
  });

  // Can this student message these people? (GET /messages/can?ids=1,2,3) Schoology's send_message for each.
  app.get("/can", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    const ids = String(c.req.query("ids") ?? "").split(",").map((x) => x.trim()).filter((x) => ID_RE.test(x));
    if (!ids.length || ids.length > 25) return c.json({ error: "bad_request" }, 400);
    c.header("Cache-Control", "private, no-store");
    try {
      return c.json(await canMessage(session, ids));
    } catch (error) {
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

  // Mark as read / unread, on Schoology too: { id, unread: true | false }
  app.post("/status", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    const body = (await jsonBody(c)) as { id?: unknown; unread?: unknown } | null;
    const id = typeof body?.id === "string" || typeof body?.id === "number" ? String(body.id) : "";
    if (!ID_RE.test(id) || typeof body?.unread !== "boolean") return c.json({ error: "bad_request" }, 400);
    try {
      const done = await setThreadStatus(id, body.unread, session);
      return done ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      if (refused(error)) return c.json({ error: "not_allowed" }, 403);
      return schoologyFailure(c, error);
    }
  });

  app.post("/delete", deps.requireSession, guard, async (c: any) => {
    const session = c.get("session");
    const body = (await jsonBody(c)) as { id?: unknown } | null;
    const id = typeof body?.id === "string" || typeof body?.id === "number" ? String(body.id) : "";
    if (!ID_RE.test(id)) return c.json({ error: "bad_request" }, 400);
    try {
      const gone = await deleteThread(id, session);
      return gone ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      if (refused(error)) return c.json({ error: "not_allowed" }, 403);
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
