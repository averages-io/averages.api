/**
 * Exporting a Canva design as a PDF, so a draft can be turned in (Submit from
 * Drafts, Add from Canva; 2026-10-06).
 *
 * A Hono sub-app that index.ts mounts with
 * `app.route("/canva", canvaExportRoutes(deps))`, next to the other /canva
 * routes. Its `deps` come from index.ts:
 *
 *   requireSession  puts the session on c.var.session, or answers 401.
 *   canvaGuard      index.ts's canvaGuard: demo, Incognito and "Canva isn't
 *                   set up" answers, else null.
 *   fromOurApp      index.ts's notFromOurApp (Origin and JSON checks), else null.
 *   storeFor        (c, uid) => this student's CanvaStore (index.ts's canvaStore()).
 *
 * Middleware is attached per route, never with use("*"): on the parent that
 * would become "/canva/*" and could reach the redirect-only Canva routes.
 *
 * Exporting needs the design:content:read scope. Until Martin turns it on in
 * Canva's Developer Portal and sets CANVA_EXPORT_ENABLED="1", and for any
 * connection made before then, every route here answers 409
 * canva_reconnect_needed and the app says "Reconnect Canva to turn in
 * designs".
 *
 * Canva Connect: POST /v1/exports {design_id, format: {type: "pdf"}} starts a
 * job; GET /v1/exports/{id} says in_progress, success (with download URLs,
 * good for 24 hours) or failed.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  CANVA_API,
  CanvaError,
  canvaExportEnabled,
  canvaFetch,
  EXPORT_SCOPE,
  getDesign,
  statusForCode,
} from "./canva.ts";
import { openValue, sealValue, type SessionData } from "./session.ts";
import { MAX_UPLOAD_BYTES } from "./submit.ts";

/** What these routes need from the student's CanvaStore (its RPC stub has these). */
export interface CanvaExportStore {
  accessTokenWithScope(uid: string, scope: string): Promise<string>;
  removeDraft(designId: string): Promise<boolean>;
}

export interface CanvaExportDeps {
  requireSession: MiddlewareHandler<any>;
  canvaGuard: (c: Context<any>) => Response | null;
  fromOurApp: (c: Context<any>) => Response | null;
  storeFor: (c: Context<any>, uid: string) => CanvaExportStore;
}

type ExportEnv = {
  Bindings: { SESSION_SECRET: string; CANVA_EXPORT_ENABLED?: string };
  Variables: { session: SessionData };
};
type C = Context<ExportEnv>;

/** Same rule as index.ts: Canva design ids are short letters/digits/_/- strings. */
const DESIGN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Canva's export job ids (UUIDs today). */
const JOB_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** The biggest PDF passed on: the same 95 MB as a turned-in file. */
export const MAX_EXPORT_BYTES = MAX_UPLOAD_BYTES;

/**
 * The browser gets a sealed job token rather than Canva's job id: it ties the
 * job to this student and the design (whose title names the file), so the
 * file route needs no extra Canva call to name it, and nobody else's session
 * can use it. An hour is far longer than an export takes.
 */
export const EXPORT_PURPOSE = "averages canva export v1";
export const EXPORT_TTL_S = 60 * 60;

export interface ExportClaim {
  /** Canva's job id. */
  j: string;
  /** Design id. */
  d: string;
  /** Design title when the export started. */
  t: string;
  /** The student. */
  u: string;
}

export function sealExport(claim: ExportClaim, secret: string): Promise<string> {
  return sealValue(claim, secret, EXPORT_PURPOSE, EXPORT_TTL_S);
}

export async function openExport(token: string, secret: string): Promise<ExportClaim | null> {
  if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const v = (await openValue(token, secret, EXPORT_PURPOSE)) as any;
  if (!v || typeof v !== "object") return null;
  if (!JOB_ID_RE.test(String(v.j)) || !DESIGN_ID_RE.test(String(v.d)) || typeof v.t !== "string" || typeof v.u !== "string" || !v.u) return null;
  return v as ExportClaim;
}

/* ── calls to Canva ────────────────────────────────────────────────── */

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * A failed export call. 401 (token no good) and 403 (the token can't export:
 * no design:content:read, which Canva reports as permission_denied) both mean
 * the student has to reconnect.
 */
function exportFailure(res: Response, json: any): CanvaError {
  const code = String(json?.code ?? "");
  if (code === "too_many_requests" || code.endsWith("_throttled") || res.status === 429) return new CanvaError("canva_rate_limited", 429);
  if (res.status === 401 || res.status === 403) return new CanvaError("canva_reconnect_needed", 409);
  if (res.status === 404) return new CanvaError("canva_design_gone", 404);
  return new CanvaError("canva_export_unavailable", 502);
}

/** Starts a PDF export of the design. Returns Canva's job id. */
export async function createPdfExport(token: string, designId: string): Promise<string> {
  const res = await canvaFetch(`${CANVA_API}/exports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ design_id: designId, format: { type: "pdf" } }),
  });
  const json = await readJson(res);
  if (!res.ok) throw exportFailure(res, json);
  const id = String(json?.job?.id ?? "");
  if (!JOB_ID_RE.test(id)) throw new CanvaError("canva_export_unavailable", 502);
  return id;
}

export interface ExportJob {
  status: "in_progress" | "success" | "failed";
  urls: string[];
  /** Why it failed, as a code the app can explain. */
  error?: string;
}

/**
 * Failure reasons Canva names. license_required: the design uses paid
 * elements the student's plan doesn't cover. approval_required: their
 * school's Canva needs someone to approve it first. Both are for the student
 * to sort out in Canva, not bugs.
 */
function jobError(code: unknown): string {
  if (code === "license_required") return "canva_export_license_required";
  if (code === "approval_required") return "canva_export_approval_required";
  return "canva_export_failed";
}

export async function getExportJob(token: string, jobId: string): Promise<ExportJob> {
  const res = await canvaFetch(`${CANVA_API}/exports/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await readJson(res);
  if (res.status === 404) throw new CanvaError("canva_export_not_found", 404);
  if (!res.ok) throw exportFailure(res, json);
  const job = json?.job ?? {};
  const urls = Array.isArray(job.urls) ? job.urls.filter((u: unknown) => typeof u === "string") : [];
  if (job.status === "success") return { status: "success", urls };
  if (job.status === "failed") return { status: "failed", urls: [], error: jobError(job.error?.code) };
  // Anything else (a status Canva adds later) reads as still working; the app gives up after a while.
  return { status: "in_progress", urls: [] };
}

/**
 * A download URL we'll fetch: https on a named host (no IP addresses, no
 * localhost, no user:password), default port. Canva's are signed links on its
 * own export host; no credentials are ever sent with them.
 */
export function isExportUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 4096) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password || u.port !== "") return false;
    if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost")) return false;
    if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false; // IPv4 / IPv6 literals
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the exported PDF. Redirects are followed by hand (https only, at
 * most 3), and no Authorization header is sent anywhere: the URL carries its
 * own signature. The 20 second limit covers getting the answer started, not
 * the whole download, which streams on to the student for as long as it takes.
 */
export async function openExportFile(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    if (!isExportUrl(current)) throw new CanvaError("canva_export_unavailable", 502);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal: ctl.signal });
    } catch {
      throw new CanvaError("canva_unreachable", 504);
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location");
      await res.body?.cancel().catch(() => {});
      if (!location) break;
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new CanvaError("canva_export_unavailable", 502);
    }
    return res;
  }
  throw new CanvaError("canva_export_unavailable", 502);
}

/** Fails the stream once more than `max` bytes have gone through. */
function capBytes(max: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) controller.error(new Error("export_too_large"));
      else controller.enqueue(chunk);
    },
  });
}

/** "Lab Report.pdf" from a design title: no path characters, no control characters. */
export function pdfName(title: string): string {
  const clean = Array.from(String(title ?? "").replace(/[\u0000-\u001f\u007f\/\\]+/g, " ").replace(/\s+/g, " ").trim())
    .slice(0, 200)
    .join("")
    .trim();
  const base = clean.replace(/\.pdf$/i, "").trim() || "Canva design";
  return `${base}.pdf`;
}

/** RFC 5987 filename*, plus a plain ASCII fallback, the same as GET /data/attachment builds it. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  let utf8Name: string;
  try {
    utf8Name = encodeURIComponent(name).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  } catch {
    utf8Name = encodeURIComponent(ascii);
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8Name}`;
}

/* ── routes ────────────────────────────────────────────────────────── */

/** An error code safe for the app, with its status (same picking-out rule as index.ts's errorCode). */
function failure(c: C, error: unknown, fallback: string) {
  if (error instanceof CanvaError) return c.json({ error: error.message }, error.status as any);
  // From the Durable Object over RPC the class is gone but the code survives in the message.
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = message.match(/\bcanva_[a-z_]+/)?.[0];
  if (code) return c.json({ error: code }, statusForCode(code) as any);
  console.error(fallback, error);
  return c.json({ error: fallback }, 502);
}

export function canvaExportRoutes(deps: CanvaExportDeps) {
  const app = new Hono<ExportEnv>();

  /** Shared checks. Returns a response to send, or null. */
  const begin = (c: C, write: boolean) => {
    c.header("Cache-Control", "private, no-store");
    const blocked = deps.canvaGuard(c) ?? (write ? deps.fromOurApp(c) : null);
    if (blocked) return blocked;
    // Off until the scope is enabled in Canva (see the top of this file).
    if (!canvaExportEnabled(c.env)) return c.json({ error: "canva_reconnect_needed" }, 409);
    return null;
  };

  /** The job token from the path, if it's this student's. */
  const claimFor = async (c: C) => {
    const claim = await openExport(c.req.param("job") ?? "", c.env.SESSION_SECRET);
    return claim && claim.u === c.get("session").uid ? claim : null;
  };

  /**
   * Starts a PDF export of one of the student's designs. The design is looked
   * up with their own token first: a design they can't open in Canva is 404
   * (and leaves their drafts, like Open does).
   */
  app.post("/designs/:id/export", deps.requireSession, async (c) => {
    const blocked = begin(c, true);
    if (blocked) return blocked;
    const designId = c.req.param("id");
    if (!DESIGN_ID_RE.test(designId)) return c.json({ error: "bad_request" }, 400);
    const session = c.get("session");
    const store = deps.storeFor(c, session.uid);
    try {
      const token = await store.accessTokenWithScope(session.uid, EXPORT_SCOPE);
      const design = await getDesign(token, designId);
      if (!design) {
        await store.removeDraft(designId).catch(() => false);
        return c.json({ error: "canva_design_gone" }, 404);
      }
      const jobId = await createPdfExport(token, designId);
      const job = await sealExport({ j: jobId, d: designId, t: design.title.slice(0, 255), u: session.uid }, c.env.SESSION_SECRET);
      return c.json({ job });
    } catch (error) {
      return failure(c, error, "canva_export_failed");
    }
  });

  /** How the export is going: in_progress, success or failed (with `error` saying why). */
  app.get("/exports/:job", deps.requireSession, async (c) => {
    const blocked = begin(c, false);
    if (blocked) return blocked;
    const claim = await claimFor(c);
    if (!claim) return c.json({ error: "canva_export_not_found" }, 404);
    const session = c.get("session");
    try {
      const token = await deps.storeFor(c, session.uid).accessTokenWithScope(session.uid, EXPORT_SCOPE);
      const job = await getExportJob(token, claim.j);
      return c.json(job.status === "failed" ? { status: "failed", error: job.error } : { status: job.status });
    } catch (error) {
      return failure(c, error, "canva_export_failed");
    }
  });

  /**
   * The finished PDF, streamed through (never stored), named after the
   * design. `design` must be the design the export was started for.
   */
  app.get("/exports/:job/file", deps.requireSession, async (c) => {
    const blocked = begin(c, false);
    if (blocked) return blocked;
    const claim = await claimFor(c);
    if (!claim) return c.json({ error: "canva_export_not_found" }, 404);
    if ((c.req.query("design") ?? "") !== claim.d) return c.json({ error: "bad_request" }, 400);
    const session = c.get("session");
    try {
      const token = await deps.storeFor(c, session.uid).accessTokenWithScope(session.uid, EXPORT_SCOPE);
      const job = await getExportJob(token, claim.j);
      if (job.status === "in_progress") return c.json({ error: "canva_export_not_ready" }, 409);
      if (job.status === "failed") return c.json({ error: job.error ?? "canva_export_failed" }, 422);
      if (!job.urls.length) return c.json({ error: "canva_export_unavailable" }, 502);

      const upstream = await openExportFile(job.urls[0]);
      const declared = upstream.headers.get("Content-Length");
      const length = declared && /^\d{1,12}$/.test(declared) ? Number(declared) : null;
      if (length !== null && length > MAX_EXPORT_BYTES) {
        await upstream.body?.cancel().catch(() => {});
        return c.json({ error: "file_too_large", maxBytes: MAX_EXPORT_BYTES }, 413);
      }
      const headers = new Headers({
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition(pdfName(claim.t)),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // The app reads the name when it fetches the file (cross-origin, so it has to be exposed).
        "Access-Control-Expose-Headers": "Content-Disposition",
      });
      if (length !== null) headers.set("Content-Length", String(length));
      // Size known and allowed: passed straight through. Unknown: counted, and cut off past the cap.
      const body = length !== null || !upstream.body ? upstream.body : upstream.body.pipeThrough(capBytes(MAX_EXPORT_BYTES));
      return new Response(body, { status: 200, headers });
    } catch (error) {
      return failure(c, error, "canva_export_failed");
    }
  });

  return app;
}
