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
  isGoogleSession as isGoogle,
  isIncognitoSession as isIncognito,
  openSession,
  openValue,
  readCookie,
  sealSession,
  sealValue,
  sessionCookie,
  SESSION_COOKIE,
  type SessionData,
} from "./session.ts";
import {
  downloadAttachment,
  getAssignment,
  getAssignmentsWithAttachments,
  getDocument,
  getDocuments,
  openAttachment,
  getAssignments,
  getGrades,
  getMe,
  getMessages,
  getSections,
  SchoologyError,
} from "./schoology.ts";
import {
  adaptAssignmentDetail,
  adaptAssignments,
  adaptCourseFiles,
  adaptCourses,
  adaptMessages,
  adaptRecentGrades,
  adaptSchoologyGradebook,
  colorForCourse,
  computeProjectedGPA,
  findAttachment,
} from "./adapt.ts";
import {
  canvaConfigured,
  canvaExportEnabled,
  canvaFoldersEnabled,
  EXPORT_SCOPE,
  FOLDER_READ_SCOPE,
  FOLDER_WRITE_SCOPE,
  editUrlWithCorrelation,
  findDesignByTitle,
  getDesign,
  importFile,
  importTitle,
  listDesigns,
  MAX_IMPORT_BYTES,
  mimeForName,
  safeAppPath,
  statusForCode,
  verifyReturnJwt,
  withQuery,
  type DesignInfo,
  type Draft,
} from "./canva.ts";
import {
  deleteSyncRecord,
  loadSyncRecord,
  saveSyncRecord,
  kvFromSyncStore,
  type KVLike,
} from "./sync.ts";
import { cloudConfig } from "./cloud.ts";
import { schoolsFor, validateApplication } from "./schools.ts";
import { EmailMessage } from "cloudflare:email";
import { autoReplyAllowed, buildMime, cleanEmail, SCHOOLS_ADDRESS } from "./mail.ts";
import { applicationEmail, autoReplyEmail } from "./schoolsMail.ts";
import type { SchoolsStore } from "./schoolsStore.ts";
import {
  accessCookie,
  ACCESS_COOKIE,
  ACCESS_PURPOSE,
  authorizationUrl,
  clearAccessCookie,
  clearStateCookie,
  exchangeCode,
  googleConfig,
  googleSessionFrom,
  GoogleError,
  hasRequiredScopes,
  idTokenClaims,
  newSignInState,
  nowSeconds,
  refreshAccessToken,
  sameString,
  stateCookie,
  STATE_COOKIE,
  STATE_PURPOSE,
  STATE_RE,
  STATE_TTL_SECONDS,
  validCachedAccess,
  validSignInState,
} from "./google.ts";
import {
  adaptClassroomAssignment,
  adaptClassroomBundle,
  adaptClassroomFiles,
  CALL_BUDGET,
  CallBudget,
  CLASSROOM_ID_RE,
  ClassroomError,
  fetchClassroomAssignment,
  fetchClassroomBundle,
  fetchClassroomFiles,
  plain,
  safeTimeZone,
} from "./classroom.ts";
import { getRecipients, namesFrom } from "./messages.ts";
import { dataExtrasRoutes, messagesRoutes } from "./extrasRoutes.ts";
import { rateLimit } from "./rateLimit.ts";
import type { SyncStore } from "./syncStore.ts";
import type { CanvaStore } from "./canvaStore.ts";
import type { PushStore } from "./pushStore.ts";
import { forgetPush, pushRoutes } from "./push.ts";
import { submitRoutes } from "./submitRoutes.ts";
import { canvaExportRoutes } from "./canvaExport.ts";
import { canvaFolderRoutes } from "./canvaFolders.ts";

// The Durable Object classes have to be exported from the Worker's main module
// for Cloudflare to find them (see wrangler.jsonc's durable_objects).
export { SyncStore } from "./syncStore.ts";
export { CanvaStore } from "./canvaStore.ts";
export { PushStore } from "./pushStore.ts";
export { SchoolsStore } from "./schoolsStore.ts";

type Bindings = {
  /** Random high-entropy string. Set with: npx wrangler secret put SESSION_SECRET */
  SESSION_SECRET: string;
  /**
   * Backs "Sync Across Devices": one SyncStore Durable Object per student,
   * always opened in the "us" jurisdiction (see syncKV below). Replaced the
   * SYNC_KV namespace on 2026-10-04; KV copied data outside the US. (It also
   * held a Projected-GPA snapshot for the weekly email until 2026-10-06; see
   * sync.ts.)
   */
  SYNC: DurableObjectNamespace<SyncStore>;
  /**
   * Canva connections and drafts: one CanvaStore Durable Object per student,
   * also in the "us" jurisdiction (see canvaStore below). Added 2026-10-05.
   */
  CANVA: DurableObjectNamespace<CanvaStore>;
  /** Canva Connect app credentials (dashboard secrets) and the callback URL (wrangler.jsonc var). */
  CANVA_CLIENT_ID?: string;
  CANVA_CLIENT_SECRET?: string;
  CANVA_REDIRECT_URI?: string;
  /**
   * "1" once design:content:read is enabled for the Canva integration in
   * Canva's Developer Portal (2026-10-06). Until then Connect doesn't ask for
   * it and turning in Canva designs answers canva_reconnect_needed. See
   * canvaScopes() in canva.ts.
   */
  CANVA_EXPORT_ENABLED?: string;
  /**
   * "1" once folder:read and folder:write are enabled for the Canva
   * integration (2026-10-06): Connect asks for them and the Files page shows
   * Canva folders. Until then it lists designs without folders.
   */
  CANVA_FOLDERS_ENABLED?: string;
  /**
   * Google Drive and OneDrive run in the browser (2026-10-05); these are the
   * PUBLIC values the app needs for that, served by GET /config/cloud.
   * GOOGLE_CLIENT_ID is the same OAuth client the Worker already has; the
   * Picker API key is restricted to app.averages.io in Google Cloud.
   */
  GOOGLE_CLIENT_ID?: string;
  /**
   * Sign in with Google, for Google Classroom (2026-10-05): the same OAuth
   * client's secret (dashboard secret, never in this repo) and the callback
   * URL (wrangler.jsonc var; .dev.vars for local testing).
   */
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_PROJECT_NUMBER?: string;
  MS_CLIENT_ID?: string;
  /**
   * Browser notifications (2026-10-05, wired in 2026-10-06): one PushStore
   * Durable Object per student who turned them on, in the "us" jurisdiction
   * (src/pushStore.ts). PUSH_SECRET and VAPID_PRIVATE_JWK are dashboard
   * secrets; VAPID_PUBLIC_KEY is a dashboard variable (the browser needs it).
   * Until all three are set, GET /push/config says null and the app shows
   * "Coming soon".
   */
  PUSH: DurableObjectNamespace<PushStore>;
  /**
   * Schools (2026-10-06): applications from app.averages.io/schools/apply
   * and the auto-reply log, one SchoolsStore Durable Object in the US.
   * SCHOOLS_MAIL is Email Routing's send_email binding (emails Martin each
   * application). SCHOOLS_NOTIFY_TO (dashboard secret) is Martin's inbox: a
   * verified Email Routing destination, never written in this public repo.
   * SCHOOLS_ADMIN_KEY (dashboard secret) unlocks GET /schools/applications.
   */
  SCHOOLS?: DurableObjectNamespace<SchoolsStore>;
  SCHOOLS_MAIL?: SendEmail;
  SCHOOLS_NOTIFY_TO?: string;
  SCHOOLS_ADMIN_KEY?: string;
  PUSH_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  /**
   * Optional Workers Rate Limiting bindings (see src/rateLimit.ts). Not
   * bound yet; the in-memory limits apply without them.
   */
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
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

/** This student's CanvaStore, in the US (same local-dev exception as syncKV above). */
function canvaStore(env: Bindings, uid: string, requestUrl: string) {
  const ns = isLocalRequest(requestUrl) ? env.CANVA : env.CANVA.jurisdiction("us" as DurableObjectJurisdiction);
  return ns.get(ns.idFromName(uid));
}

/**
 * The one SchoolsStore, in the US (local-dev exception as above). The email
 * handler has no request URL: email only ever reaches the deployed Worker.
 */
function schoolsStoreFor(env: Bindings, requestUrl: string | null) {
  if (!env.SCHOOLS) return null;
  const ns = requestUrl && isLocalRequest(requestUrl) ? env.SCHOOLS : env.SCHOOLS.jurisdiction("us" as DurableObjectJurisdiction);
  return ns.get(ns.idFromName("schools"));
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
    // So the app can read how long to wait after a 429 (rate limits, below).
    // Content-Disposition: the Canva PDF's file name when turning a design in (2026-10-06 review).
    exposeHeaders: ["Retry-After", "Content-Disposition"],
  })(c, next);
});

/**
 * The session cookie opened once per request (2026-10-06): the rate limiter
 * needs the student's uid before the route's own requireSession runs, and
 * opening the cookie is an AES decrypt, so the result is kept for the rest of
 * the request. Null when there's no cookie, no SESSION_SECRET, or the cookie
 * isn't a valid session.
 */
const openedSessions = new WeakMap<Request, Promise<SessionData | null>>();
function openedSession(c: any): Promise<SessionData | null> {
  const raw: Request = c.req.raw;
  let opened = openedSessions.get(raw);
  if (!opened) {
    const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
    opened = token && c.env.SESSION_SECRET ? openSession(token, c.env.SESSION_SECRET) : Promise.resolve(null);
    openedSessions.set(raw, opened);
  }
  return opened;
}

/**
 * Rate limits on our own routes (2026-10-06): per IP for sign-in, per
 * student for everything that reaches Schoology, Google or our storage.
 * After CORS, so a 429 still carries the CORS headers the app needs to read
 * it. See src/rateLimit.ts for the numbers and the optional binding.
 */
app.use("*", rateLimit({ studentOf: async (c) => (await openedSession(c))?.uid ?? null }));

/** Resolves the session cookie, or 401s. */
async function requireSession(c: any, next: any) {
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: "not_authenticated" }, 401);
  }
  const session = await openedSession(c);
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
  // Only from our own app, as JSON (2026-10-06 review): a form on another
  // site could otherwise sign a student into someone else's account (login
  // CSRF), and with turning in live their work would go to that account.
  const blocked = notFromOurApp(c);
  if (blocked) return blocked;
  let body: { key?: string; secret?: string; under13?: unknown };
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

    // Under 13 (the login page's 13+ box left unticked): Incognito only, sealed
    // into the session so nothing stored on our servers can be turned on.
    const under13 = body.under13 === true;
    const token = await sealSession(under13 ? { key, secret, uid, inc: true } : { key, secret, uid }, c.env.SESSION_SECRET);
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

app.delete("/auth/session", async (c) => {
  // Signing out also deletes the stored sign-in browser notifications use,
  // and every browser's subscription (2026-10-06). After the answer, and
  // never in the way: forgetPush never throws, and does nothing without the
  // PUSH binding.
  const session = await sessionFrom(c);
  if (session && !isDemo(session)) c.executionCtx.waitUntil(forgetPush(c.env, session.uid, c.req.url));
  c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN));
  // A Google sign-in's refreshed access token, if any (see googleAccess).
  c.header("Set-Cookie", clearAccessCookie(!isLocalRequest(c.req.url)), { append: true });
  return c.json({ ok: true });
});

/* ────────────────────────────────────────────────────────────────────
 * Sign in with Google, for Google Classroom (2026-10-05)
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Step 1: the login page's "Continue with Google" button navigates here. The
 * sign-in's random state and PKCE verifier go into a sealed, 10-minute cookie
 * that only this Worker's /auth/google paths ever see, and the browser is sent
 * on to Google's consent screen.
 *
 * `under13` is the login page's 13+ box: anything but "0" means under 13
 * (the safe default), which seals Incognito into the session.
 */
app.get("/auth/google/start", async (c) => {
  const origin = appOrigin(c.req.url);
  const config = googleConfig(c.env);
  if (!config || !c.env.SESSION_SECRET) return c.redirect(`${origin}/?google=unavailable`);
  const signIn = newSignInState(c.req.query("under13") !== "0");
  const sealed = await sealValue(signIn, c.env.SESSION_SECRET, STATE_PURPOSE, STATE_TTL_SECONDS);
  c.header("Set-Cookie", stateCookie(sealed, !isLocalRequest(c.req.url)));
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.redirect(await authorizationUrl(config, signIn));
});

/**
 * Step 2: Google sends the browser back here with ?code&state (or ?error when
 * the student cancels). The state must match the cookie this same browser got
 * in step 1, so a sign-in can't be finished in someone else's browser. The
 * code is traded for tokens with the client secret, the permissions actually
 * granted are checked, and the tokens are sealed into the session cookie.
 * Every outcome goes back to the login page, which either moves on (signed
 * in) or explains what happened (?google=...).
 */
app.get("/auth/google/callback", async (c) => {
  const origin = appOrigin(c.req.url);
  const secure = !isLocalRequest(c.req.url);
  const back = (outcome: string) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(`${origin}/?google=${outcome}`);
  };
  // The state cookie is single-use: cleared whatever happens next.
  c.header("Set-Cookie", clearStateCookie(secure), { append: true });

  const config = googleConfig(c.env);
  if (!config || !c.env.SESSION_SECRET) return back("unavailable");

  const sealed = readCookie(c.req.header("Cookie") ?? null, STATE_COOKIE);
  const signIn = sealed ? await openValue(sealed, c.env.SESSION_SECRET, STATE_PURPOSE) : null;
  const state = c.req.query("state") ?? "";
  if (!validSignInState(signIn) || !STATE_RE.test(state) || !sameString(state, signIn.state)) return back("expired");

  const error = c.req.query("error");
  if (error) return back(error === "access_denied" ? "cancelled" : "failed");
  const code = c.req.query("code") ?? "";
  if (!code || code.length > 2048) return back("failed");

  try {
    const exchange = await exchangeCode(config, code, signIn.verifier);
    if (!hasRequiredScopes(exchange.letters)) return back("permissions");
    const claims = idTokenClaims(exchange.idToken, config.clientId);
    if (!claims || !exchange.refreshToken) return back("failed");
    const google = googleSessionFrom(exchange, claims);
    const session = { key: "", secret: "", ...google, ...(signIn.under13 ? { inc: true as const } : {}) };
    const token = await sealSession(session, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(token, COOKIE_DOMAIN), { append: true });
    return back("ok");
  } catch (err) {
    if (!(err instanceof GoogleError)) console.error("google_callback_failed", err);
    return back("failed");
  }
});

/**
 * A working Google access token for this request. The one sealed at sign-in
 * lasts an hour; after that a refreshed one is kept in its own short-lived
 * cookie (ACCESS_COOKIE, see google.ts), never by rewriting the session
 * cookie, so the session keeps its 30 days from sign-in and signing out can't
 * be undone by a request that was still refreshing. Throws
 * GoogleError("google_invalid_grant") when the student removed Averages.io's
 * access in their Google account: the caller signs them out.
 */
async function googleAccess(c: any, session: SessionData): Promise<string> {
  const g = session.g!;
  const now = nowSeconds();
  if (g.ax - 60 > now) return g.at;
  const sealed = readCookie(c.req.header("Cookie") ?? null, ACCESS_COOKIE);
  const cached = sealed ? await openValue(sealed, c.env.SESSION_SECRET, ACCESS_PURPOSE) : null;
  if (validCachedAccess(cached, session.uid, session.exp) && cached.ax - 60 > now) return cached.at;
  const config = googleConfig(c.env);
  if (!config) throw new GoogleError("google_not_configured");
  const fresh = await refreshAccessToken(config, g.rt);
  const ttl = Math.max(60, Math.min(fresh.expiresAt, session.exp) - now);
  const value = await sealValue({ uid: session.uid, exp: session.exp, at: fresh.accessToken, ax: fresh.expiresAt }, c.env.SESSION_SECRET, ACCESS_PURPOSE, ttl);
  c.header("Set-Cookie", accessCookie(value, ttl, !isLocalRequest(c.req.url)), { append: true });
  return fresh.accessToken;
}

/**
 * How a failed Google Classroom call is answered. Google saying the sign-in
 * is no good any more (revoked, expired) signs the student out (401 clears
 * the cookie, and the app goes back to the login page); anything else is a
 * 502 the app shows as "couldn't load".
 */
function classroomFailure(c: any, error: unknown) {
  const signedOut =
    (error instanceof GoogleError && error.code === "google_invalid_grant") ||
    (error instanceof ClassroomError && error.status === 401);
  if (signedOut) {
    c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN), { append: true });
    c.header("Set-Cookie", clearAccessCookie(!isLocalRequest(c.req.url)), { append: true });
    return c.json({ error: "session_expired" }, 401);
  }
  if (error instanceof ClassroomError) {
    return c.json({ error: "classroom_error", status: error.status }, error.status === 404 ? 404 : 502);
  }
  if (error instanceof GoogleError) return c.json({ error: "google_unreachable" }, 502);
  console.error("classroom_failed", error);
  return c.json({ error: "unexpected_error" }, 500);
}

/** The student's time zone for Classroom's UTC due dates: the app's, else Cloudflare's guess, else UTC. */
function studentTimeZone(c: any): string {
  return safeTimeZone(c.req.query("tz"), (c.req.raw as any)?.cf?.timezone);
}

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

  if (isGoogle(session)) {
    const g = session.g!;
    return c.json({
      uid: session.uid,
      name: g.name || "Student",
      firstName: g.name.split(" ")[0] ?? "",
      email: g.email,
      pictureUrl: g.pic,
      incognito: isIncognito(session),
      provider: "google",
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
      incognito: isIncognito(session),
      provider: "schoology",
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
  if (isIncognito(session)) return c.json({ error: "incognito_mode" }, 403);
  const record = await loadSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid);
  return c.json(record);
});

app.put("/sync/settings", requireSession, async (c) => {
  const session = c.get("session");
  if (isDemo(session)) {
    return c.json({ error: "not_available_in_demo" }, 403);
  }
  // Incognito stores nothing on our servers. (DELETE stays allowed: deleting is always fine.)
  if (isIncognito(session)) return c.json({ error: "incognito_mode" }, 403);

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

  // The whole record is just the settings and two timestamps (2026-10-06:
  // the GPA snapshot the weekly email used is gone, and a record that still
  // carries one loses it here, on its next save; see sync.ts).
  const now = new Date().toISOString();
  const record = {
    settings: body.settings,
    updatedAt: now,
    // See SyncRecord's own comment in sync.ts for why settings.html's pull
    // logic compares this rather than updatedAt.
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
 * so whatever had last been pushed just sat in KV under the user's uid
 * indefinitely. Turning sync back on later would have silently pulled that
 * stale record back down.
 *
 * settings.html calls this the moment the user confirms turning sync off
 * (see its own comment there). Deletes the WHOLE record (including, on an
 * old record, the GPA snapshots the weekly email kept until 2026-10-06),
 * since "delete my data" means all of it.
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

  if (isGoogle(session)) return classroomBundle(c, session);

  try {
    /**
     * One wave for everything that depends on nothing (2026-09-17).
     *
     * This used to be three separate waits, and two of them didn't need to
     * be: the inbox fetch sat at the bottom of the handler, behind the twelve
     * assignment calls. Now there are exactly two waits, and the second one
     * is the only one that has to be second: assignments are per-section, so
     * they can't be asked for until wave 1 says which sections exist.
     *
     * The recipients list (2026-10-06) names the senders on Home's Messages
     * widget: Schoology's inbox has author ids but no names. (The sync record
     * read that used to sit here went with the weekly email's GPA snapshot,
     * 2026-10-06.)
     *
     * The `.catch` handlers are load-bearing. `Promise.all` rejects on the
     * FIRST rejection, so an unguarded inbox fetch — messaging can be turned
     * off district-wide — would take sections and grades down with it and turn
     * a working grades page into a 502. Same for the recipients list, which
     * some districts and personal keys refuse. Sections and grades are
     * deliberately left unguarded: without them there is no bundle to return.
     */
    const [sections, grades, inbox, recipients] = await Promise.all([
      getSections(session.uid, session),
      getGrades(session.uid, session),
      getMessages("inbox", session).catch(() => null),
      getRecipients(session).catch(() => null),
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
      MESSAGES = inbox ? adaptMessages(inbox, namesFrom(recipients)) : [];
    } catch {
      MESSAGES = [];
    }

    /**
     * Recent Grades and each class's Grades tab (2026-10-06), the same shapes
     * Classroom's bundle sends, from the grades and assignments already in
     * hand: no extra Schoology calls. Category weights here come from the
     * grades payload, which doesn't always carry them; GET /data/gradebook
     * reads the exact ones for the course the gradebook page opens. Guarded
     * like the messages: never the reason grades don't load.
     */
    const now = Date.now();
    let RECENT_GRADES: any[] = [];
    const GRADEBOOK: Record<string, unknown> = {};
    try {
      RECENT_GRADES = adaptRecentGrades(grades, assignmentsBySection, now);
      const gradesBySection = new Map(grades.map((g: any) => [String(g?.section_id ?? g?.id ?? ""), g]));
      for (const [courseId, assignments] of Object.entries(assignmentsBySection)) {
        GRADEBOOK[courseId] = adaptSchoologyGradebook({ categories: null, gradeEntry: gradesBySection.get(courseId), assignments });
      }
    } catch (error) {
      console.error("bundle_grades_failed", error instanceof Error ? error.message : String(error));
    }

    return c.json({
      generatedAt: new Date(now).toISOString(),
      COURSES,
      HISTORY,
      OVERDUE,
      UPCOMING,
      TODAY,
      MESSAGES,
      RECENT_GRADES,
      GRADEBOOK,
      projectedGPA: computeProjectedGPA(COURSES),
    });
  } catch (error) {
    if (error instanceof SchoologyError) {
      return c.json({ error: "schoology_error", status: error.status }, 502);
    }
    return c.json({ error: "unexpected_error" }, 500);
  }
});

/**
 * The bundle for a Google Classroom sign-in: same shapes as Schoology's, plus
 * `platform: "classroom"` (on the bundle, each class and each assignment) so
 * pages know to send turning in to Classroom, and SUBMITTED, which Classroom
 * can tell us (Schoology can't).
 */
async function classroomBundle(c: any, session: SessionData) {
  const tz = studentTimeZone(c);
  try {
    const accessToken = await googleAccess(c, session);
    const budget = new CallBudget(CALL_BUDGET);
    const raw = await fetchClassroomBundle(accessToken, session.g!.sc, budget);
    const bundle = adaptClassroomBundle(raw, Date.now(), tz);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      generatedAt: new Date().toISOString(),
      platform: "classroom",
      ...bundle,
      partial: bundle.partial || budget.cut,
    });
  } catch (error) {
    return classroomFailure(c, error);
  }
}

/* ────────────────────────────────────────────────────────────────────
 * Assignment detail and Canva (2026-10-05)
 * ──────────────────────────────────────────────────────────────────── */

/** Schoology ids are plain numbers; anything else never reaches a Schoology URL. */
const ID_RE = /^\d{1,20}$/;
/** Canva design ids are short letters/digits/_/- strings. */
const DESIGN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const APP_ORIGIN = "https://app.averages.io";

/** Where a browser navigation should land: the real app, or the local one under `wrangler dev`. */
function appOrigin(requestUrl: string): string {
  return isLocalRequest(requestUrl) ? DEV_ORIGIN : APP_ORIGIN;
}

/**
 * The session for routes the browser NAVIGATES to (connect, callback, return):
 * those answer with redirects, never a JSON 401 page, so they read the cookie
 * themselves instead of using requireSession.
 */
async function sessionFrom(c: any): Promise<SessionData | null> {
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  if (!token || !c.env.SESSION_SECRET) return null;
  return openSession(token, c.env.SESSION_SECRET);
}

/** An error code safe to hand to the app; anything unexpected becomes `fallback` (and is logged). */
function errorCode(error: unknown, fallback: string): string {
  // Errors from the Durable Object arrive over RPC as plain Errors whose
  // message may be prefixed with the original class ("CanvaError: canva_..."),
  // so the code is picked out rather than compared whole.
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = message.match(/\bcanva_[a-z_]+/)?.[0];
  if (code) return code;
  console.error(fallback, error);
  return fallback;
}

function canvaFailure(c: any, error: unknown, fallback = "canva_failed") {
  if (error instanceof SchoologyError) {
    if (error.status === 413) return c.json({ error: "file_too_large" }, 413);
    return c.json({ error: "schoology_error", status: error.status }, 502);
  }
  const code = errorCode(error, fallback);
  return c.json({ error: code }, statusForCode(code));
}

/** Demo and unconfigured checks shared by the JSON Canva routes. Returns a response to send, or null to continue. */
function canvaGuard(c: any) {
  if (isDemo(c.get("session"))) return c.json({ error: "not_available_in_demo" }, 403);
  if (isIncognito(c.get("session"))) return c.json({ error: "incognito_mode" }, 403);
  if (!canvaConfigured(c.env)) return c.json({ error: "canva_not_configured" }, 503);
  return null;
}

/**
 * State-changing Canva calls must come from our own app: an allowed Origin
 * (when the browser sends one) and, for POSTs, a JSON body. JSON forces a
 * CORS preflight, so a plain form on some other page (even another
 * *.averages.io one, which SameSite=Lax would let through) can't fire them.
 * Returns a response to send, or null to continue.
 */
function notFromOurApp(c: any) {
  const origin = c.req.header("Origin");
  if (origin && !allowedOrigins(c.req.url).includes(origin)) return c.json({ error: "forbidden_origin" }, 403);
  if (c.req.method === "POST" && !(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return c.json({ error: "json_required" }, 415);
  }
  return null;
}

/** What the app sees of a draft (no Schoology or Canva URLs that outlive the page). */
function publicDraft(d: Draft, design?: { title: string; updatedAt: number; thumbnailUrl: string } | null) {
  return {
    designId: d.designId,
    title: (design?.title || d.title || d.sourceName).slice(0, 255),
    sourceName: d.sourceName,
    createdAt: d.createdAt,
    updatedAt: Math.max(d.updatedAt, design?.updatedAt ?? 0),
    thumbnailUrl: design?.thumbnailUrl ?? "",
  };
}

/**
 * One assignment's description and Attached Materials, for the assignment
 * page. Files come back with an id and name only; the download path stays on
 * the server.
 */
app.get("/data/assignment", requireSession, async (c) => {
  const session = c.get("session");
  if (isDemo(session)) {
    return c.json({ error: "not_available_in_demo" }, 403);
  }
  const section = c.req.query("section") ?? "";
  const id = c.req.query("id") ?? "";
  if (isGoogle(session)) {
    if (!CLASSROOM_ID_RE.test(section) || !CLASSROOM_ID_RE.test(id)) return c.json({ error: "bad_request" }, 400);
    try {
      const accessToken = await googleAccess(c, session);
      const { work, submission } = await fetchClassroomAssignment(section, id, accessToken);
      c.header("Cache-Control", "private, no-store");
      return c.json(adaptClassroomAssignment(work, submission, section, studentTimeZone(c)));
    } catch (error) {
      return classroomFailure(c, error);
    }
  }
  if (!ID_RE.test(section) || !ID_RE.test(id)) {
    return c.json({ error: "bad_request" }, 400);
  }
  try {
    const raw = await getAssignment(section, id, session);
    c.header("Cache-Control", "private, no-store");
    return c.json(adaptAssignmentDetail(raw, section));
  } catch (error) {
    if (error instanceof SchoologyError) {
      return c.json({ error: "schoology_error", status: error.status }, error.status === 404 ? 404 : 502);
    }
    return c.json({ error: "unexpected_error" }, 500);
  }
});

/**
 * Downloads one of an assignment's attached files (the assignment page's
 * Download button). The browser navigates here; the file is streamed straight
 * through from Schoology, never stored. Same rule as Edit in Canva: ids only
 * from the browser, the real download path is looked up on Schoology.
 */
app.get("/data/attachment", async (c) => {
  const session = await sessionFrom(c);
  if (!session) return c.json({ error: "not_authenticated" }, 401);
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  // Google Classroom files live in Google Drive and open there; they never pass through this Worker.
  if (isGoogle(session)) return c.json({ error: "classroom_files_open_in_drive" }, 404);
  const section = c.req.query("section") ?? "";
  const assignment = c.req.query("assignment") ?? "";
  const fileId = c.req.query("file") ?? "";
  // A file can also hang off a Materials document (Files page, 2026-10-05): exactly one of the two.
  const documentId = c.req.query("document") ?? "";
  const parentOk = (ID_RE.test(assignment) && documentId === "") || (ID_RE.test(documentId) && assignment === "");
  if (!ID_RE.test(section) || !ID_RE.test(fileId) || !parentOk) {
    return c.json({ error: "bad_request" }, 400);
  }
  try {
    const parent = assignment ? await getAssignment(section, assignment, session) : await getDocument(section, documentId, session);
    const file = findAttachment(parent, fileId);
    if (!file || !file.downloadPath) return c.json({ error: "file_not_found" }, 404);
    const upstream = await openAttachment(file.downloadPath, session);
    // RFC 5987 filename*, plus a plain ASCII fallback, so any name downloads under its real title.
    const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    let utf8Name: string;
    try {
      utf8Name = encodeURIComponent(file.name).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
    } catch {
      utf8Name = encodeURIComponent(ascii); // a lone surrogate can't be encoded; the ASCII name still works
    }
    const headers = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${utf8Name}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const length = upstream.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);
    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof SchoologyError) return c.json({ error: "schoology_error", status: error.status }, 502);
    return c.json({ error: "unexpected_error" }, 500);
  }
});

/**
 * Every file in the signed-in student's courses, for the Files page
 * (2026-10-05): the files teachers posted in Materials (documents) and the
 * files attached to assignments. Ids and names only, never download paths;
 * GET /data/attachment looks a file up again to download it. Nothing is
 * stored. Four sections at a time, so a student with many classes doesn't
 * fire two dozen Schoology calls at once; a section that fails is skipped and
 * the answer says `partial: true`.
 */
app.get("/data/files", async (c) => {
  const session = await sessionFrom(c);
  if (!session) return c.json({ error: "not_authenticated" }, 401);
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  c.header("Cache-Control", "private, no-store");
  if (isGoogle(session)) {
    // Google Drive files posted in the student's classes, as links that open in Google Drive.
    try {
      const accessToken = await googleAccess(c, session);
      const budget = new CallBudget(CALL_BUDGET);
      const { courses, byCourse, complete } = await fetchClassroomFiles(accessToken, session.g!.sc, budget);
      const { files, partial } = adaptClassroomFiles(byCourse);
      return c.json({
        platform: "classroom",
        courses: courses.map((course) => ({ id: String(course.id), name: plain(course.name, 120) || "Untitled class", color: colorForCourse(String(course.id)) })),
        files,
        partial: partial || !complete || budget.cut,
      });
    } catch (error) {
      return classroomFailure(c, error);
    }
  }
  try {
    const { COURSES } = adaptCourses(await getSections(session.uid, session), []);
    const courses = COURSES.slice(0, 12).map((course) => ({ id: course.id, name: course.name, color: course.color }));
    const bySection: Record<string, { documents: any[] | null; assignments: any[] | null }> = {};
    let next = 0;
    const worker = async () => {
      while (next < courses.length) {
        const course = courses[next++];
        const [documents, assignments] = await Promise.all([
          getDocuments(course.id, session).catch(() => null),
          getAssignmentsWithAttachments(course.id, session).catch(() => null),
        ]);
        bySection[course.id] = { documents, assignments };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, courses.length) }, worker));
    const { files, partial } = adaptCourseFiles(bySection);
    return c.json({ courses, files, partial });
  } catch (error) {
    if (error instanceof SchoologyError) return c.json({ error: "schoology_error", status: error.status }, 502);
    return c.json({ error: "unexpected_error" }, 500);
  }
});

/**
 * Public app values for Google Drive and OneDrive, which connect in the
 * browser (the student's tokens never reach this Worker). Everything here is
 * already visible to anyone who opens the app: OAuth client IDs, and a Picker
 * API key that Google Cloud restricts to app.averages.io. No secrets, so no
 * sign-in needed. A missing value comes back as null and the app shows that
 * app as "Coming soon".
 */
/**
 * The schools the sign-in page can search (2026-10-06): public, no sign-in
 * needed (the page asks before anyone is signed in). See src/schools.ts.
 */
app.get("/config/schools", (c) => {
  const schools = schoolsFor(c.req.query("lms"));
  if (!schools) return c.json({ error: "bad_request" }, 400);
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ schools });
});

app.get("/config/cloud", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(cloudConfig(c.env));
});

/**
 * Drives Settings › Integrations' "Connected / Not connected" line, which
 * Canva's review requires (along with a Disconnect button).
 */
app.get("/canva/status", requireSession, async (c) => {
  if (isDemo(c.get("session"))) return c.json({ error: "not_available_in_demo" }, 403);
  c.header("Cache-Control", "private, no-store");
  if (isIncognito(c.get("session"))) return c.json({ configured: canvaConfigured(c.env), connected: false, name: "", incognito: true });
  if (!canvaConfigured(c.env)) return c.json({ configured: false, connected: false, name: "" });
  try {
    const store = canvaStore(c.env, c.get("session").uid, c.req.url);
    const status = await store.status(c.get("session").uid);
    // Can this connection turn in designs as PDFs (2026-10-06)? "off" until
    // CANVA_EXPORT_ENABLED; "reconnect" for a connection made before the
    // export scope was asked for (Canva didn't grant it), so Settings can
    // offer Reconnect. Unknown scopes count as ready: Canva decides then.
    let turnIn: "off" | "ready" | "reconnect" = "off";
    // Canva folders on the Files page (2026-10-06): the same three answers.
    let folders: "off" | "ready" | "reconnect" = "off";
    const exportOn = canvaExportEnabled(c.env);
    const foldersOn = canvaFoldersEnabled(c.env);
    if ((exportOn || foldersOn) && status.connected) {
      const granted = await store.grantedScopes(c.get("session").uid).catch(() => null);
      const has = (scope: string) => !granted || granted.includes(scope);
      if (exportOn) turnIn = has(EXPORT_SCOPE) ? "ready" : "reconnect";
      if (foldersOn) folders = has(FOLDER_READ_SCOPE) && has(FOLDER_WRITE_SCOPE) ? "ready" : "reconnect";
    }
    return c.json({ configured: true, ...status, turnIn, folders });
  } catch (error) {
    return canvaFailure(c, error, "canva_status_failed");
  }
});

/** Starts connecting: the browser navigates here and is sent on to Canva's consent screen. */
app.get("/canva/connect", async (c) => {
  const origin = appOrigin(c.req.url);
  const session = await sessionFrom(c);
  if (!session || isDemo(session)) return c.redirect(`${origin}/`);
  if (isIncognito(session)) return c.redirect(`${origin}/settings?canva=incognito`);
  const returnTo = safeAppPath(c.req.query("return_to"), "/settings");
  try {
    return c.redirect(await canvaStore(c.env, session.uid, c.req.url).beginConnect(returnTo));
  } catch (error) {
    errorCode(error, "canva_connect_failed");
    return c.redirect(`${origin}${withQuery(returnTo, "canva", "failed")}`);
  }
});

/** Canva sends the student back here with ?code&state (or ?error when they cancel). */
app.get("/canva/callback", async (c) => {
  const origin = appOrigin(c.req.url);
  const session = await sessionFrom(c);
  if (!session || isDemo(session)) return c.redirect(`${origin}/`);
  if (isIncognito(session)) return c.redirect(`${origin}/settings?canva=incognito`);
  if (c.req.query("error")) return c.redirect(`${origin}/settings?canva=cancelled`);
  try {
    const returnTo = await canvaStore(c.env, session.uid, c.req.url).finishConnect(
      session.uid,
      c.req.query("state") ?? "",
      c.req.query("code") ?? ""
    );
    return c.redirect(`${origin}${withQuery(safeAppPath(returnTo, "/settings"), "canva", "connected")}`);
  } catch (error) {
    errorCode(error, "canva_callback_failed");
    return c.redirect(`${origin}/settings?canva=failed`);
  }
});

/** Disconnect: forgets the tokens and the drafts list. Designs stay in the student's Canva. */
app.delete("/canva/connection", requireSession, async (c) => {
  if (isDemo(c.get("session"))) return c.json({ error: "not_available_in_demo" }, 403);
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
  try {
    await canvaStore(c.env, c.get("session").uid, c.req.url).disconnect();
    return c.json({ ok: true });
  } catch (error) {
    return canvaFailure(c, error, "canva_disconnect_failed");
  }
});

/**
 * Edit in Canva: imports one of the assignment's attached files into the
 * student's Canva, records it as a draft, and answers with the editor URL
 * (carrying a Return key). The browser sends ids only; the Worker re-reads the
 * assignment from Schoology and downloads that file itself.
 *
 * A file already in Drafts is reopened instead of imported again: Canva
 * refuses a second import of the same file anyway (duplicate_import).
 */
app.post("/canva/edit", requireSession, async (c) => {
  const blocked = canvaGuard(c) ?? notFromOurApp(c);
  if (blocked) return blocked;
  const session = c.get("session");
  // Edit in Canva copies a file from the school platform; Google Classroom files are in Google Drive instead.
  if (isGoogle(session)) return c.json({ error: "classroom_not_supported" }, 403);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const section = String(body?.section ?? "");
  const assignment = String(body?.assignment ?? "");
  const fileId = String(body?.fileId ?? "");
  if (!ID_RE.test(section) || !ID_RE.test(assignment) || !ID_RE.test(fileId)) {
    return c.json({ error: "bad_request" }, 400);
  }
  const returnTo = safeAppPath(body?.returnTo, "/assignments");
  const store = canvaStore(c.env, session.uid, c.req.url);

  /** Records `design` as this file's draft and answers with its editor link. */
  const answer = async (design: DesignInfo, sourceName: string, existing: Draft | null, reused: boolean) => {
    const now = Date.now();
    const draft: Draft = existing ?? {
      designId: design.id,
      title: design.title || importTitle(sourceName),
      sourceName,
      fileId,
      section,
      assignment,
      createdAt: now,
      updatedAt: now,
    };
    if (!existing) await store.addDraft(draft);
    await store.rememberImport(section, assignment, fileId, design.id);
    const key = await store.saveReturn({ designId: design.id, returnTo });
    return c.json({ editUrl: editUrlWithCorrelation(design.editUrl, key), draft: publicDraft(draft, design), reused });
  };

  try {
    const token = await store.accessToken(session.uid);

    // Already made a design from this file? Reopen it: Canva refuses to import
    // the same file twice anyway. (Remembered even after its draft is deleted.)
    const existing = await store.findDraftForFile(section, assignment, fileId);
    const knownId = existing?.designId ?? (await store.importedDesign(section, assignment, fileId));
    if (knownId) {
      const design = await getDesign(token, knownId);
      if (design) return answer(design, existing?.sourceName ?? design.title, existing, true);
      // Deleted in Canva, expired unedited, or another Canva account: start over.
      if (existing) await store.removeDraft(existing.designId);
    }

    const raw = await getAssignment(section, assignment, session);
    const file = findAttachment(raw, fileId);
    if (!file || !file.downloadPath) return c.json({ error: "file_not_found" }, 404);
    if (file.size > MAX_IMPORT_BYTES) return c.json({ error: "file_too_large" }, 413);

    const { bytes, contentType } = await downloadAttachment(file.downloadPath, session, MAX_IMPORT_BYTES);
    let design: DesignInfo | null;
    try {
      design = (await importFile(token, file.name, bytes, mimeForName(file.name) ?? (contentType || undefined)))[0] ?? null;
    } catch (error) {
      // Imported before and we lost track of it (e.g. after a disconnect):
      // find the student's own design with that title instead.
      if (!(error instanceof Error && error.message.includes("canva_duplicate_import"))) throw error;
      design = await findDesignByTitle(token, importTitle(file.name));
      if (!design) throw error;
    }
    if (!design) return c.json({ error: "canva_import_failed" }, 422);
    return answer(design, file.name, null, false);
  } catch (error) {
    return canvaFailure(c, error, "canva_edit_failed");
  }
});

/**
 * Reopen a design (a draft, or one from the Files tab) with a fresh Return
 * key, so Canva's Return button comes back to the page it was opened from.
 */
app.post("/canva/designs/:id/open", requireSession, async (c) => {
  const blocked = canvaGuard(c) ?? notFromOurApp(c);
  if (blocked) return blocked;
  const session = c.get("session");
  const designId = c.req.param("id");
  if (!DESIGN_ID_RE.test(designId)) return c.json({ error: "bad_request" }, 400);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    /* returnTo is optional */
  }
  const store = canvaStore(c.env, session.uid, c.req.url);
  try {
    const token = await store.accessToken(session.uid);
    const design = await getDesign(token, designId);
    if (!design) {
      await store.removeDraft(designId);
      return c.json({ error: "canva_design_gone" }, 404);
    }
    const key = await store.saveReturn({ designId, returnTo: safeAppPath(body?.returnTo, "/files") });
    return c.json({ editUrl: editUrlWithCorrelation(design.editUrl, key) });
  } catch (error) {
    return canvaFailure(c, error, "canva_open_failed");
  }
});

/**
 * Where Canva's Return button lands (?correlation_jwt=...). The JWT is checked
 * (signature, audience, type, expiry), the Return key is looked up in this
 * student's own storage, and they're sent back to the page they came from.
 */
app.get("/canva/return", async (c) => {
  const origin = appOrigin(c.req.url);
  const session = await sessionFrom(c);
  if (!session || isDemo(session)) return c.redirect(`${origin}/`);
  try {
    const { designId, correlationState } = await verifyReturnJwt(c.env, c.req.query("correlation_jwt") ?? "");
    const store = canvaStore(c.env, session.uid, c.req.url);
    const ctx = await store.takeReturn(correlationState);
    if (!ctx || ctx.designId !== designId) return c.redirect(`${origin}/home?canva=returned`);
    await store.touchDraft(designId);
    return c.redirect(`${origin}${withQuery(safeAppPath(ctx.returnTo, "/home"), "canva", "saved")}`);
  } catch (error) {
    // An unverifiable JWT is hostile input, not a bug: note it and send them home.
    errorCode(error, "canva_return_failed");
    return c.redirect(`${origin}/home?canva=bad_return`);
  }
});

/** One assignment's drafts, refreshed from Canva (titles, edit times). Designs deleted in Canva drop off. */
app.get("/canva/drafts", requireSession, async (c) => {
  const blocked = canvaGuard(c);
  if (blocked) return blocked;
  const session = c.get("session");
  const section = c.req.query("section") ?? "";
  const assignment = c.req.query("assignment") ?? "";
  if (!ID_RE.test(section) || !ID_RE.test(assignment)) return c.json({ error: "bad_request" }, 400);
  c.header("Cache-Control", "private, no-store"); // thumbnails expire after 15 minutes
  const store = canvaStore(c.env, session.uid, c.req.url);
  try {
    const { connected } = await store.status(session.uid);
    if (!connected) return c.json({ connected: false, drafts: [] });
    const token = await store.accessToken(session.uid);
    const drafts = (await store.listDrafts(section, assignment)).slice(0, 20);
    const out: ReturnType<typeof publicDraft>[] = [];
    await Promise.all(
      drafts.map(async (d) => {
        let design;
        try {
          design = await getDesign(token, d.designId);
        } catch {
          design = undefined; // Canva hiccup: still show the draft with what we know
        }
        if (design === null) {
          await store.removeDraft(d.designId);
          return;
        }
        out.push(publicDraft(d, design));
      })
    );
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return c.json({ connected: true, drafts: out });
  } catch (error) {
    return canvaFailure(c, error, "canva_drafts_failed");
  }
});

/** Removes a draft from Averages.io. The design itself stays in the student's Canva. */
app.delete("/canva/drafts/:id", requireSession, async (c) => {
  if (isDemo(c.get("session"))) return c.json({ error: "not_available_in_demo" }, 403);
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
  const designId = c.req.param("id");
  if (!DESIGN_ID_RE.test(designId)) return c.json({ error: "bad_request" }, 400);
  try {
    const removed = await canvaStore(c.env, c.get("session").uid, c.req.url).removeDraft(designId);
    return c.json({ ok: true, removed });
  } catch (error) {
    return canvaFailure(c, error, "canva_draft_delete_failed");
  }
});

/** The student's Canva designs for the Files tab, newest first, 50 a page. */
app.get("/canva/designs", requireSession, async (c) => {
  const blocked = canvaGuard(c);
  if (blocked) return blocked;
  const session = c.get("session");
  c.header("Cache-Control", "private, no-store"); // thumbnails expire after 15 minutes
  const continuation = c.req.query("continuation");
  if (continuation !== undefined && !/^[A-Za-z0-9_\-=.~+/]{1,512}$/.test(continuation)) {
    return c.json({ error: "bad_request" }, 400);
  }
  try {
    const store = canvaStore(c.env, session.uid, c.req.url);
    const { connected } = await store.status(session.uid);
    if (!connected) return c.json({ connected: false, items: [] });
    const page = await listDesigns(await store.accessToken(session.uid), continuation);
    return c.json({
      connected: true,
      items: page.items.map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt, thumbnailUrl: d.thumbnailUrl })),
      continuation: page.continuation,
    });
  } catch (error) {
    return canvaFailure(c, error, "canva_list_failed");
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

/* ────────────────────────────────────────────────────────────────────
 * Per-page extras, Schoology messages and browser notifications (2026-10-06)
 * ──────────────────────────────────────────────────────────────────── */

const extrasDeps = { requireSession, fromOurApp: notFromOurApp, googleAccess, classroomFailure, studentTimeZone };

/** GET /data/people, /data/updates, /data/events, /data/folders, /data/gradebook (src/extrasRoutes.ts). */
app.route("/data", dataExtrasRoutes(extrasDeps));

/** GET /messages, /messages/thread, /messages/recipients; POST /messages, /messages/reply. Schoology only. */
app.route("/messages", messagesRoutes(extrasDeps));

/** Browser notifications (src/push.ts). */
app.route("/push", pushRoutes({ requireSession, fromOurApp: notFromOurApp }));

/**
 * Turning in work on Schoology (2026-10-06): file uploads (streamed straight
 * through to Schoology), typed answers and the student's submission history.
 * And Canva designs exported as PDFs to turn in. Both sub-apps attach their
 * own middleware per route; mounted after the CORS middleware so it applies.
 */
app.route("/submit", submitRoutes({ requireSession, fromOurApp: notFromOurApp }));
app.route(
  "/canva",
  canvaExportRoutes({
    requireSession,
    canvaGuard,
    fromOurApp: notFromOurApp,
    storeFor: (c, uid) => canvaStore(c.env, uid, c.req.url),
  })
);
/** Canva folders on the Files page (src/canvaFolders.ts), off until CANVA_FOLDERS_ENABLED. */
app.route(
  "/canva",
  canvaFolderRoutes({
    requireSession,
    canvaGuard,
    fromOurApp: notFromOurApp,
    storeFor: (c, uid) => canvaStore(c.env, uid, c.req.url),
  })
);

/* ── Schools (2026-10-06) ──────────────────────────────────────────────
 * A student's Email Template asks their school's IT team to write to
 * schools@averages.io; they get an automatic reply (handleSchoolsEmail
 * below) with the link to app.averages.io/schools/apply; the form posts here.
 */

/**
 * One application. Public (school IT staff aren't signed in), JSON from our
 * own app only, rate-limited per IP. Saved first, then emailed to Martin.
 */
app.post("/schools/apply", async (c) => {
  const blocked = notFromOurApp(c);
  if (blocked) return blocked;
  c.header("Cache-Control", "no-store");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const checked = validateApplication(body);
  if (!checked.ok) return c.json({ error: "invalid", fields: checked.fields }, 400);
  // The hidden field a person never fills in: a bot. Polite "ok", nothing kept.
  if (checked.spam) return c.json({ ok: true });
  const store = schoolsStoreFor(c.env, c.req.url);
  if (!store) return c.json({ error: "unavailable" }, 503);
  try {
    const { app: saved, duplicate } = await store.add(checked.value);
    if (c.env.SCHOOLS_MAIL && c.env.SCHOOLS_NOTIFY_TO) {
      const mail = applicationEmail(saved, duplicate);
      const raw = buildMime({ from: SCHOOLS_ADDRESS, fromName: "Averages.io schools", to: c.env.SCHOOLS_NOTIFY_TO, replyTo: saved.email, ...mail });
      // After the answer: a slow or failed email never costs the school its "sent".
      c.executionCtx.waitUntil(
        c.env.SCHOOLS_MAIL.send(new EmailMessage(SCHOOLS_ADDRESS, c.env.SCHOOLS_NOTIFY_TO, raw)).catch((error: unknown) => console.error("schools_notify_failed", error))
      );
    }
    return c.json({ ok: true });
  } catch (error) {
    console.error("schools_apply_failed", error);
    return c.json({ error: "unavailable" }, 503);
  }
});

/**
 * Martin's list of applications: `Authorization: Bearer <SCHOOLS_ADMIN_KEY>`.
 * Off (404) until that secret is set, and refused for a key under 24
 * characters. Compared in constant time.
 */
app.get("/schools/applications", async (c) => {
  c.header("Cache-Control", "no-store");
  const key = c.env.SCHOOLS_ADMIN_KEY ?? "";
  if (key.length < 24) return c.json({ error: "not_found" }, 404);
  const given = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameString(given, key)) return c.json({ error: "forbidden" }, 403);
  const store = schoolsStoreFor(c.env, c.req.url);
  if (!store) return c.json({ error: "unavailable" }, 503);
  return c.json({ applications: await store.list() });
});

/**
 * Email to schools@averages.io (Email Routing sends it to this Worker).
 * Everything is forwarded to Martin's inbox; a school's first email also gets
 * the automatic reply with the application link (once per sender per 30
 * days, never to robots: see autoReplyAllowed in mail.ts). Never throws: a
 * failure is logged, the email itself was still delivered to Martin.
 */
export async function handleSchoolsEmail(message: ForwardableEmailMessage, env: Bindings, _ctx?: ExecutionContext): Promise<void> {
  const to = cleanEmail(message.to);
  const from = cleanEmail(message.from);
  if (env.SCHOOLS_NOTIFY_TO) {
    try {
      await message.forward(env.SCHOOLS_NOTIFY_TO);
    } catch (error) {
      console.error("schools_forward_failed", error);
    }
  }
  if (to !== SCHOOLS_ADDRESS || !from) return;
  if (!autoReplyAllowed(message.from, message.headers).ok) return;
  try {
    const store = schoolsStoreFor(env, null);
    if (!store || !(await store.claimReply(from))) return;
    const mail = autoReplyEmail(message.headers.get("Subject"));
    const raw = buildMime({
      from: SCHOOLS_ADDRESS,
      fromName: "Averages.io",
      to: from,
      ...mail,
      inReplyTo: message.headers.get("Message-ID") ?? undefined,
      autoReply: true,
    });
    await message.reply(new EmailMessage(SCHOOLS_ADDRESS, from, raw));
  } catch (error) {
    console.error("schools_reply_failed", error);
  }
}

/**
 * The Worker: HTTP through Hono, email through handleSchoolsEmail. Tests call
 * `app.fetch` on this object exactly as they did on the Hono app.
 */
export default {
  fetch: app.fetch,
  email: handleSchoolsEmail,
};
