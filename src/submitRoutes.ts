/**
 * /submit: turning in work on Schoology (Wave 2, 2026-10-06).
 *
 * A Hono sub-app that index.ts mounts with `app.route("/submit", submitRoutes(deps))`.
 * It takes the pieces it needs from index.ts as `deps` instead of importing
 * them, so index.ts stays the one place that knows about cookies and origins:
 *
 *   requireSession  index.ts's middleware: puts the session on c.var.session, or answers 401.
 *   fromOurApp      index.ts's notFromOurApp: a 403/415 for a state-changing call
 *                   that isn't from our app (Origin, JSON body), else null.
 *
 * Middleware is attached per route, never with use("*"): a sub-app's "*"
 * becomes "/submit/*" on the parent, and keeping it per route means mounting
 * order can never matter.
 *
 * Schoology sessions only. Google Classroom work is turned in on Classroom
 * (404 turn_in_on_classroom); demo has nothing to turn in to (403). Incognito
 * is fine: nothing is stored, the file goes straight to Schoology.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { isDemoSession, isGoogleSession, type SessionData } from "./session.ts";
import { SchoologyError } from "./schoology.ts";
import { safeTimeZone } from "./classroom.ts";
import {
  adaptHistory,
  attachFiles,
  byteLength,
  getHistory,
  ID_RE,
  MAX_FILES,
  MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES,
  MD5_RE,
  openUpload,
  putUpload,
  revisionFromAnswer,
  sanitizeSubmission,
  sealUpload,
  startUpload,
  submitText,
  uploadContentType,
  UPLOAD_REDIRECTED,
  validFilename,
  validFilesize,
} from "./submit.ts";

export interface SubmitDeps {
  requireSession: MiddlewareHandler<any>;
  fromOurApp: (c: Context<any>) => Response | null;
}

type SubmitEnv = {
  Bindings: { SESSION_SECRET: string };
  Variables: { session: SessionData };
};
type C = Context<SubmitEnv>;

/** JSON bodies: small, except a text answer (100 KB of HTML, a bit more once JSON-escaped). */
const MAX_JSON_BYTES = 8 * 1024;
const MAX_TEXT_JSON_BYTES = 512 * 1024;

/** The request's JSON object, or null (not JSON, not an object, or bigger than `max`). */
async function readBody(c: C, max: number): Promise<Record<string, unknown> | null> {
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > max) return null;
  try {
    const text = await c.req.text();
    if (text.length > max) return null;
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** Demo and Google Classroom sessions can't turn in here. Returns a response to send, or null. */
function notSchoology(c: C) {
  const session = c.get("session");
  if (isDemoSession(session)) return c.json({ error: "not_available_in_demo" }, 403);
  if (isGoogleSession(session)) return c.json({ error: "turn_in_on_classroom" }, 404);
  return null;
}

/** The student's time zone for "when": the app's ?tz=, else Cloudflare's guess, else UTC (as /data/bundle). */
function studentTimeZone(c: C): string {
  return safeTimeZone(c.req.query("tz"), (c.req.raw as any)?.cf?.timezone);
}

/**
 * A failed Schoology call. 404 stays 404 (no such class or assignment for
 * this student); everything else is 502 schoology_error with Schoology's
 * status, so the app can tell "Schoology refused" (4xx: the dropbox is
 * closed, say) from "Schoology is down".
 */
function schoologyFailure(c: C, error: unknown) {
  if (error instanceof SchoologyError) {
    return c.json({ error: "schoology_error", status: error.status }, error.status === 404 ? 404 : 502);
  }
  console.error("submit_failed", error);
  return c.json({ error: "unexpected_error" }, 500);
}

export function submitRoutes(deps: SubmitDeps) {
  const app = new Hono<SubmitEnv>();

  /** Shared start of every route: no caching, Schoology sessions only. */
  const begin = (c: C) => {
    c.header("Cache-Control", "private, no-store");
    return notSchoology(c);
  };

  /**
   * Step 1 of a file: tell Schoology what's coming. The browser gets
   * Schoology's file id and a sealed token; the upload_location stays inside
   * the token, which only this Worker can open.
   */
  app.post("/upload", deps.requireSession, async (c) => {
    const blocked = begin(c) ?? deps.fromOurApp(c);
    if (blocked) return blocked;
    const body = await readBody(c, MAX_JSON_BYTES);
    if (!body) return c.json({ error: "invalid_body" }, 400);
    const section = String(body.section ?? "");
    const assignment = String(body.assignment ?? "");
    const filename = body.filename;
    const filesize = body.filesize;
    const md5 = String(body.md5 ?? "").toLowerCase();
    if (!ID_RE.test(section) || !ID_RE.test(assignment) || !validFilename(filename) || !MD5_RE.test(md5)) {
      return c.json({ error: "bad_request" }, 400);
    }
    if (typeof filesize === "number" && Number.isInteger(filesize) && filesize > MAX_UPLOAD_BYTES) {
      return c.json({ error: "file_too_large", maxBytes: MAX_UPLOAD_BYTES }, 413);
    }
    if (!validFilesize(filesize)) return c.json({ error: "bad_request" }, 400);
    const session = c.get("session");
    try {
      const { fileId, location } = await startUpload(session, { filename, filesize, md5 });
      const upload = await sealUpload(
        { l: location, s: section, a: assignment, u: session.uid, f: fileId, n: filesize, m: md5, fn: filename },
        c.env.SESSION_SECRET,
      );
      return c.json({ upload, fileId });
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  /**
   * Step 2: the file's bytes, streamed to Schoology as they arrive. The token
   * must be ours, unexpired and this student's; Content-Length must be the
   * size Schoology was told in step 1 (it checks size and MD5 itself).
   */
  app.put("/upload/:token", deps.requireSession, async (c) => {
    const blocked = begin(c) ?? deps.fromOurApp(c);
    if (blocked) return blocked;
    const session = c.get("session");
    const claim = await openUpload(c.req.param("token"), c.env.SESSION_SECRET);
    if (!claim) return c.json({ error: "upload_expired" }, 403);
    if (claim.u !== session.uid) return c.json({ error: "upload_not_yours" }, 403);

    const lengthHeader = c.req.header("Content-Length") ?? "";
    if (!/^\d{1,12}$/.test(lengthHeader)) return c.json({ error: "length_required" }, 411);
    const length = Number(lengthHeader);
    if (length > MAX_UPLOAD_BYTES) return c.json({ error: "file_too_large", maxBytes: MAX_UPLOAD_BYTES }, 413);
    if (length !== claim.n) return c.json({ error: "size_mismatch" }, 400);
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "size_mismatch" }, 400);

    try {
      const file = await putUpload(claim.l, session, body, length, uploadContentType(c.req.header("Content-Type"), claim.fn));
      // Schoology answers with the file; it must be the one step 1 named.
      if (file && typeof file === "object" && file.id !== undefined && String(file.id) !== claim.f) {
        console.error("submit_upload_mismatch");
        return c.json({ error: "upload_mismatch" }, 502);
      }
      return c.json({ fileId: claim.f });
    } catch (error) {
      if (error instanceof SchoologyError) {
        if (error.message === UPLOAD_REDIRECTED) return c.json({ error: "upload_redirected" }, 502);
        // Schoology refused the bytes themselves (MD5 or size not what step 1 said, an expired location).
        if (error.status >= 400 && error.status < 500 && error.status !== 404) {
          return c.json({ error: "upload_rejected", status: error.status }, 422);
        }
      }
      return schoologyFailure(c, error);
    }
  });

  /** Step 3: turn in the uploaded files, all in one revision. */
  app.post("/file", deps.requireSession, async (c) => {
    const blocked = begin(c) ?? deps.fromOurApp(c);
    if (blocked) return blocked;
    const body = await readBody(c, MAX_JSON_BYTES);
    if (!body) return c.json({ error: "invalid_body" }, 400);
    const section = String(body.section ?? "");
    const assignment = String(body.assignment ?? "");
    const raw = body.fileIds;
    if (!ID_RE.test(section) || !ID_RE.test(assignment) || !Array.isArray(raw) || raw.length < 1 || raw.length > MAX_FILES) {
      return c.json({ error: "bad_request" }, 400);
    }
    const fileIds = [...new Set(raw.map((id) => (typeof id === "string" || typeof id === "number" ? String(id) : "")))];
    if (!fileIds.every((id) => ID_RE.test(id))) return c.json({ error: "bad_request" }, 400);
    try {
      const answer = await attachFiles(c.get("session"), section, assignment, fileIds);
      return c.json({ ok: true, revision: revisionFromAnswer(answer, studentTimeZone(c)) });
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  /** A text answer: cleaned to the allow-list, then turned in. */
  app.post("/text", deps.requireSession, async (c) => {
    const blocked = begin(c) ?? deps.fromOurApp(c);
    if (blocked) return blocked;
    const declared = Number(c.req.header("Content-Length") ?? 0);
    if (declared > MAX_TEXT_JSON_BYTES) return c.json({ error: "text_too_large", maxBytes: MAX_TEXT_BYTES }, 413);
    const body = await readBody(c, MAX_TEXT_JSON_BYTES);
    if (!body) return c.json({ error: "invalid_body" }, 400);
    const section = String(body.section ?? "");
    const assignment = String(body.assignment ?? "");
    if (!ID_RE.test(section) || !ID_RE.test(assignment) || typeof body.body !== "string") {
      return c.json({ error: "bad_request" }, 400);
    }
    if (byteLength(body.body) > MAX_TEXT_BYTES) return c.json({ error: "text_too_large", maxBytes: MAX_TEXT_BYTES }, 413);
    const { html, hasText } = sanitizeSubmission(body.body);
    // Escaping can make it longer ("<" becomes "&lt;").
    if (byteLength(html) > MAX_TEXT_BYTES) return c.json({ error: "text_too_large", maxBytes: MAX_TEXT_BYTES }, 413);
    if (!hasText) return c.json({ error: "empty_submission" }, 400);
    try {
      const answer = await submitText(c.get("session"), section, assignment, html);
      return c.json({ ok: true, revision: revisionFromAnswer(answer, studentTimeZone(c)) });
    } catch (error) {
      return schoologyFailure(c, error);
    }
  });

  /** What this student has turned in for one assignment, newest first. */
  app.get("/history", deps.requireSession, async (c) => {
    const blocked = begin(c);
    if (blocked) return blocked;
    const section = c.req.query("section") ?? "";
    const assignment = c.req.query("assignment") ?? "";
    if (!ID_RE.test(section) || !ID_RE.test(assignment)) return c.json({ error: "bad_request" }, 400);
    const session = c.get("session");
    try {
      const raw = await getHistory(session, section, assignment, session.uid);
      return c.json({ revisions: adaptHistory(raw, session.uid, studentTimeZone(c)) });
    } catch (error) {
      // Nothing turned in yet can come back as a 404: that's an empty history.
      if (error instanceof SchoologyError && error.status === 404) return c.json({ revisions: [] });
      return schoologyFailure(c, error);
    }
  });

  return app;
}
