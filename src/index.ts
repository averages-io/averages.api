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
  clearProfileCookie,
  profileCookie,
  profileForSession,
  profileFrom,
  PROFILE_COOKIE,
  PROFILE_PURPOSE,
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
  schoologyGet,
  SchoologyError,
} from "./schoology.ts";
import {
  adaptAssignmentDetail,
  adaptAssignments,
  assignmentTypesSeen,
  adaptCourseFiles,
  adaptCourses,
  adaptMessages,
  adaptRecentGrades,
  adaptSchoologyGradebook,
  addHistoryTitles,
  assignmentScore,
  colorForCourse,
  computeProjectedGPA,
  findAttachment,
} from "./adapt.ts";
import {
  canvaConfigured,
  canvaExportEnabled,
  canvaFoldersEnabled,
  canvaProbeEnabled,
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
  probePermissions,
  probeSweep,
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
import { CLOUD_APPS, cloudConfigured, isCloudApp, statusForCloudCode, type CloudApp } from "./cloudConnect.ts";
import { schoolsFor } from "./schools.ts";
import { enqueueMany, enqueueRetry, handleRetryBatch, type RetryHandlers, type RetryMessage } from "./retryQueue.ts";
import { withFlags, featureOn, featureForRoute, earlyKey, FEATURE_KEYS, type FeatureKey, type Features } from "./flags.ts";
import { REVIEW_UID, SANDBOX_KEY, SANDBOX_SECRET } from "./reviewSandbox.ts";
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
  classroomGet,
  fetchClassroomAssignment,
  fetchClassroomBundle,
  fetchClassroomFiles,
  listCourses,
  plain,
  safeTimeZone,
} from "./classroom.ts";
import { getRecipients, namesFrom } from "./messages.ts";
import { getSectionGrades } from "./extras.ts";
import { dataExtrasRoutes, messagesRoutes } from "./extrasRoutes.ts";
import { rateLimit } from "./rateLimit.ts";
import type { SyncStore } from "./syncStore.ts";
import type { CanvaStore } from "./canvaStore.ts";
import type { CloudStore } from "./cloudStore.ts";
import type { BillingStore } from "./billingStore.ts";
import { calendarRoutes, forgetCalendar } from "./calendar.ts";
import { hasPlusNow, plusRequired } from "./plus.ts";
import { liveCourses, liveEvery } from "./liveGrades.ts";
import { billingRoutes, stripeWebhookRoutes, type BillingRouteEnv, type BillingStoreApi } from "./billingRoutes.ts";
import type { PushStore } from "./pushStore.ts";
import { forgetPush, pushRoutes } from "./push.ts";
import { submitRoutes } from "./submitRoutes.ts";
import { deleteAllMedia, mediaRoutes, type MediaBucket } from "./media.ts";
import {
  findSubmittedFile,
  getHistory,
  MAX_SUBMISSION_ASSIGNMENTS,
  newestSubmittedFiles,
  SUBMISSION_CALL_BUDGET,
  submittedFiles,
  turnInAssignments,
  type SubmittedFile,
} from "./submit.ts";
import { canvaExportRoutes } from "./canvaExport.ts";
import { converterOn, pdfToDocx, type Converter } from "./convert.ts";
import { canvaFolderRoutes, createFolder, moveItem } from "./canvaFolders.ts";
import { cleanFolderName, newJobId, parseSaveFiles, SAVE_CRED_TTL_S, SAVE_JOB_RE, SAVE_MAX_FILES, SAVE_SPACING_S, saveOneFile } from "./canvaSave.ts";

// The Durable Object classes have to be exported from the Worker's main module
// for Cloudflare to find them (see wrangler.jsonc's durable_objects).
export { SyncStore } from "./syncStore.ts";
export { CanvaStore } from "./canvaStore.ts";
export { CloudStore } from "./cloudStore.ts";
export { BillingStore } from "./billingStore.ts";
export { PushStore } from "./pushStore.ts";
export { CalendarStore } from "./calendar.ts";
export { Converter } from "./convert.ts";

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
   * Profile photos and uploaded backgrounds (src/media.ts), 2026-10-13. A
   * private R2 bucket in the "us" jurisdiction. Optional: without it /media
   * answers 503 and the app keeps pictures inside the Sync record as before.
   */
  MEDIA?: R2Bucket;
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
   * The file converter container (src/convert.ts, 2026-10-15): turns Canva's
   * PDF into Word for the type pill. "1" turns it on; without the binding or
   * the switch the app doesn't offer Word.
   */
  CONVERTER?: DurableObjectNamespace<Converter>;
  CONVERT_ENABLED?: string;
  /**
   * "1" once folder:read and folder:write are enabled for the Canva
   * integration (2026-10-06): Connect asks for them and the Files page shows
   * Canva folders. Until then it lists designs without folders.
   */
  CANVA_FOLDERS_ENABLED?: string;
  /**
   * "1" only while testing whether Canva's undocumented design:permission:* /
   * folder:permission:write scopes do anything (2026-10-10, developer only).
   * While "1", GET /canva/connect?probe=1 also asks for them and POST
   * /canva/probe is reachable (it still needs REVIEW_SECRET). See
   * canvaProbeEnabled() / probePermissions() in canva.ts.
   */
  CANVA_PERMISSION_PROBE?: string;
  /**
   * Google Drive and OneDrive run in the browser (2026-10-05); these are the
   * PUBLIC values the app needs for that, served by GET /config/cloud.
   * Since 2026-10-08 the Worker also signs students in to both with these
   * client IDs and keeps them connected (/cloud/*, src/cloudConnect.ts).
   * GOOGLE_CLIENT_ID is the same OAuth client the Worker already has; the
   * Picker API key is restricted in Google Cloud to the websites
   * app.averages.io/* AND docs.google.com/* (the Picker runs in a docs.google.com
   * frame; without it Google says "The API developer key is invalid") and to
   * the Google Picker API.
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
   * Google Drive and OneDrive that stay connected (2026-10-08): one
   * CloudStore Durable Object per student, in the "us" jurisdiction (see
   * cloudStore below), holding their refresh tokens. See src/cloudConnect.ts.
   */
  CLOUD: DurableObjectNamespace<CloudStore>;
  /**
   * Averages Plus (2026-10-21, src/billing.ts): one BillingStore Durable
   * Object per student who has subscribed, in the "us" jurisdiction, holding
   * their Stripe customer / subscription ids and status. STRIPE_SECRET_KEY and
   * STRIPE_WEBHOOK_SECRET are dashboard secrets (sandbox keys while
   * testing); STRIPE_PRICE_LOOKUP_KEY is optional (default plus_monthly).
   */
  BILLING?: DurableObjectNamespace<BillingStore>;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_LOOKUP_KEY?: string;
  /**
   * OneDrive's client secret (dashboard secret, 2026-10-08), from a Web
   * platform on the Entra app. With MS_CLIENT_ID it lets the Worker sign
   * students in to OneDrive and keep them connected. Unset = OneDrive
   * reports configured: false.
   */
  MS_CLIENT_SECRET?: string;
  /**
   * Optional (dashboard secret, 2026-10-08): GOOGLE_DRIVE_CLIENT_ID's own
   * secret. With both set, Drive connects with that client; otherwise with
   * GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
   */
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  /**
   * Browser notifications (2026-10-05, wired in 2026-10-06): one PushStore
   * Durable Object per student who turned them on, in the "us" jurisdiction
   * (src/pushStore.ts). PUSH_SECRET and VAPID_PRIVATE_JWK are dashboard
   * secrets; VAPID_PUBLIC_KEY is a var in wrangler.jsonc (the browser needs it).
   * Until all three are set, GET /push/config says null and the app shows
   * "Coming soon".
   */
  PUSH: DurableObjectNamespace<PushStore>;
  /** The retry queue (2026-10-16, src/retryQueue.ts): failed push notifications and queued Canva-save files, tried again later. */
  RETRY?: Queue<RetryMessage>;
  /**
   * Feature switches (src/flags.ts, 2026-10-09). FEATURES is filled in per
   * request (Flagship, else the vars). FEATURES_OFF / FEATURES_ON: optional
   * comma-separated keys to flip without Flagship. MAINTENANCE_MESSAGE: the
   * banner's text while maintenance-banner is on (300 characters at most).
   */
  FEATURES?: Features;
  FEATURES_OFF?: string;
  FEATURES_ON?: string;
  /** Early access (2026-10-21): switch keys on for Plus members first (comma-separated); EARLY is this request's list. */
  FEATURES_EARLY?: string;
  EARLY?: FeatureKey[];
  /** Calendar sync (2026-10-21, src/calendar.ts): one CalendarStore per student link and per feed, in the US. */
  CALENDAR?: DurableObjectNamespace;
  MAINTENANCE_MESSAGE?: string;
  /**
   * The reviewer account (2026-10-07, dashboard SECRETS, 16+ characters
   * each): typed into the hidden API-key sign-in, they open sample classes
   * (reviewSandbox.ts) with every integration working. Unset = off.
   */
  REVIEW_KEY?: string;
  /** Cloudflare Flagship (2026-10-08, optional): see src/flags.ts. */
  FLAGS?: { getBooleanValue(key: string, defaultValue: boolean, context?: Record<string, unknown>): Promise<boolean> };
  REVIEW_SECRET?: string;
  /**
   * Optional developer secret (16+ characters). The schools admin endpoint it
   * was made for is gone (2026-10-17); it now only also unlocks the temporary
   * Canva permission probe, alongside REVIEW_SECRET. Unset = off.
   */
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

/** This student's BillingStore (Averages Plus, 2026-10-21), in the US (same local-dev exception). */
function billingStore(env: BillingRouteEnv, uid: string, requestUrl: string): BillingStoreApi {
  const billing = env.BILLING!;
  const ns = isLocalRequest(requestUrl) ? billing : billing.jurisdiction("us" as DurableObjectJurisdiction);
  return ns.get(ns.idFromName(uid)) as unknown as BillingStoreApi;
}

/** This student's CloudStore (Google Drive and OneDrive, 2026-10-08), in the US (same local-dev exception). */
function cloudStore(env: Bindings, uid: string, requestUrl: string) {
  const ns = isLocalRequest(requestUrl) ? env.CLOUD : env.CLOUD.jurisdiction("us" as DurableObjectJurisdiction);
  return ns.get(ns.idFromName(uid));
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
    exposeHeaders: ["Retry-After", "Content-Disposition", "X-Media-Version"],
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

/**
 * Feature switches (src/flags.ts, 2026-10-09). A route whose feature is off
 * answers 503 { error: "feature_off", feature }. Pages the browser navigates
 * to (connect, callback, return, Google sign-in) go back to the app instead,
 * (Settings with ?feature_off=<key>, or the sign-in page for Google), so
 * nobody lands on a JSON page.
 */
const NAVIGATED = /^\/(canva\/(connect|callback|return)|cloud\/[^/]+\/(connect|callback))$/;
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const path = new URL(c.req.url).pathname;
  const offs = featureForRoute(c.req.method, path).filter((k) => !featureOn(c.env, k));
  // Early access (2026-10-21): a switch that's off but in the early list is
  // open to Plus members. Only asked when it matters, so other requests never
  // wait on a BillingStore.
  let off = offs[0];
  if (off && offs.every((k) => earlyKey(c.env, k))) {
    const session = await openedSession(c);
    // Billing off (2026-10-21): every Plus perk is free, early features included.
    let plus = !plusRequired(c.env as any);
    if (!plus && session && !isDemo(session)) {
      try { plus = await hasPlusNow(c.env as any, session.uid, c.req.url); } catch { plus = false; }
    }
    if (plus) off = undefined as unknown as FeatureKey;
  }
  if (!off) return next();
  c.header("Cache-Control", "no-store");
  if (c.req.method === "GET" && NAVIGATED.test(path)) {
    return c.redirect(`${appOrigin(c.req.url)}/settings?feature_off=${off}`);
  }
  return c.json({ error: "feature_off", feature: off }, 503);
});

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
/**
 * Every connected app this student has on our servers, disconnected: Canva
 * (tokens and drafts) and Google Drive / OneDrive (sign-ins, Google's revoked
 * too). Each one on its own, so one failing doesn't keep the others. Never
 * throws: it runs after sign-out has already answered.
 */
async function forgetConnections(env: Bindings, uid: string, requestUrl: string): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  if (env.CANVA) jobs.push(Promise.resolve().then(() => canvaStore(env, uid, requestUrl).disconnect(uid)));
  // Signing out: Google's grant is always revoked (2026-10-26); a Google sign-in is ending anyway.
  if (env.CLOUD) for (const app of CLOUD_APPS) jobs.push(Promise.resolve().then(() => cloudStore(env, uid, requestUrl).disconnect(uid, app, { revokeShared: true })));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.error("signout_forget_failed", r.reason);
}

/** Constant-time match against the reviewer secrets; off unless both are set and at least 16 characters. */
function reviewSecretsMatch(env: Bindings, key: string, secret: string): boolean {
  const k = env.REVIEW_KEY ?? "";
  const s = env.REVIEW_SECRET ?? "";
  if (k.length < 16 || s.length < 16) return false;
  const same = (a: string, b: string) => {
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  };
  // Both compared every time, so the answer takes as long either way.
  const a = same(key, k);
  const b = same(secret, s);
  return a && b;
}

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
   * The reviewer account (2026-10-07): the REVIEW_KEY / REVIEW_SECRET
   * dashboard secrets sign into sample classes served by reviewSandbox.ts,
   * in the app's normal live mode, so every integration works. The sandbox's
   * own key typed in as an ordinary key is refused, so the secrets are the
   * only way in.
   */
  if (key === SANDBOX_KEY || secret === SANDBOX_SECRET) return c.json({ error: "invalid_credentials" }, 401);
  const reviewer = reviewSecretsMatch(c.env, key, secret);
  // Sign-in switches (src/flags.ts): the reviewer account and Schoology keys each have their own.
  const signin: FeatureKey = reviewer ? "test-signin" : "schoology-signin";
  if (!featureOn(c.env, signin)) return c.json({ error: "feature_off", feature: signin }, 503);
  if (reviewer) {
    const me = await getMe({ key: SANDBOX_KEY, secret: SANDBOX_SECRET });
    const token = await sealSession({ key: SANDBOX_KEY, secret: SANDBOX_SECRET, uid: REVIEW_UID, p: profileFrom(me) }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(token, COOKIE_DOMAIN));
    return c.json({
      ok: true,
      user: { uid: REVIEW_UID, name: me.name_display ?? "Reviewer", firstName: me.name_first ?? "", email: me.primary_email ?? "", pictureUrl: "" },
    });
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
    // The name rides along in the sealed cookie so /auth/me never has to ask Schoology for it.
    const p = profileFrom(me);
    const token = await sealSession(under13 ? { key, secret, uid, inc: true, p } : { key, secret, uid, p }, c.env.SESSION_SECRET);
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
  // ?forget=1 (2026-10-13): the app sends it on every sign-out since
  // 2026-10-26 (before, only with Sync Across Devices off). Besides this device's
  // data (which the app deletes itself), that's the connected apps kept here
  // for this student: Canva (and its Edit in Canva drafts), Google Drive and
  // OneDrive. Our own app only: a page on another site can't ask for it.
  const forget = c.req.query("forget") === "1";
  if (forget) {
    const foreign = notFromOurApp(c);
    if (foreign) return foreign;
  }
  if (session && !isDemo(session)) c.executionCtx.waitUntil(forgetPush(c.env, session.uid, c.req.url));
  // The calendar link keeps a sign-in too (2026-10-21): signing out deletes it, like notifications.
  if (session && !isDemo(session)) c.executionCtx.waitUntil(forgetCalendar(c.env as any, session.uid, c.req.url));
  if (forget && session && !isDemo(session)) c.executionCtx.waitUntil(forgetConnections(c.env, session.uid, c.req.url));
  c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN));
  // A Google sign-in's refreshed access token, if any (see googleAccess).
  c.header("Set-Cookie", clearAccessCookie(!isLocalRequest(c.req.url)), { append: true });
  // An older Schoology session's name (see /auth/me).
  c.header("Set-Cookie", clearProfileCookie(!isLocalRequest(c.req.url)), { append: true });
  return c.json({ ok: true });
});

/* ────────────────────────────────────────────────────────────────────
 * Sign in with Google (Google Classroom) was removed on 2026-10-19: the public
 * beta is Schoology only. With /auth/google/start and /auth/google/callback
 * gone there is no way to get a Google session, so the Classroom branches
 * below (isGoogle, googleAccess, src/classroom.ts, src/google.ts) are dormant.
 * classroom.ts also holds helpers the Schoology side uses, so it stays.
 * ──────────────────────────────────────────────────────────────────── */

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

  /**
   * Schoology (2026-10-13): answered from the profile sealed into the cookie
   * at sign-in. This used to call Schoology's /users/me on every page load
   * just for the name, ~3 s that the login page and every page's first load
   * waited on. Opening the cookie (requireSession, above) is what proves the
   * session; the Schoology call never did, since a refusal there came back
   * as a 502, not a 401.
   *
   * A cookie from before this has no profile: ask Schoology once, the old
   * way, and keep the answer in a small side cookie (PROFILE_COOKIE, see
   * session.ts) until the session ends. Not by rewriting the session cookie,
   * which a sign-out racing this slow call could otherwise undo. No one has
   * to sign in again; their next visit takes the fast path.
   *
   * Server-Timing shows which way it went in the browser's Network tab.
   */
  const started = Date.now();
  const answer = (p: NonNullable<SessionData["p"]>, how: string) => {
    c.header("Server-Timing", `auth;desc="${how}";dur=${Date.now() - started}`);
    const origin = c.req.header("Origin");
    if (origin && allowedOrigins(c.req.url).includes(origin)) c.header("Timing-Allow-Origin", origin);
    return c.json({
      uid: session.uid,
      name: p.n,
      firstName: p.f,
      email: p.em ?? "",
      pictureUrl: p.pic ?? "",
      incognito: isIncognito(session),
      provider: "schoology",
    });
  };
  if (session.p) return answer(session.p, "cookie");
  const sealed = readCookie(c.req.header("Cookie") ?? null, PROFILE_COOKIE);
  const kept = sealed ? profileForSession(await openValue(sealed, c.env.SESSION_SECRET, PROFILE_PURPOSE), session) : null;
  if (kept) return answer(kept, "cookie");

  let me;
  try {
    me = await getMe(session);
  } catch {
    return c.json({ error: "schoology_unreachable" }, 502);
  }
  const p = profileFrom(me);
  const left = session.exp - nowSeconds();
  if (left > 0) {
    const value = await sealValue({ uid: session.uid, exp: session.exp, p }, c.env.SESSION_SECRET, PROFILE_PURPOSE, left);
    c.header("Set-Cookie", profileCookie(value, left, !isLocalRequest(c.req.url)));
  }
  return answer(p, "schoology");
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
  // The profile photo and background in R2 (src/media.ts) are Sync data too.
  await deleteAllMedia(c.env.MEDIA as unknown as MediaBucket | undefined, session.uid);
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

    const { OVERDUE, UPCOMING, TODAY } = adaptAssignments(assignmentsBySection, studentTimeZone(c));
    // Which assignment_type values real districts send (2026-10-16), to check
    // how Google Assignments and Turnitin show up (see isOutsideTool). Plain
    // words only, never titles or grades. Remove once confirmed.
    try {
      console.log("assignment_types", assignmentTypesSeen(assignmentsBySection).join(","));
    } catch {
      /* logging never costs the student their grades */
    }
    // Names for the trend chart's points, from the lists just fetched (no extra calls).
    try {
      addHistoryTitles(HISTORY, assignmentsBySection);
    } catch (error) {
      console.error("bundle_history_titles_failed", error instanceof Error ? error.message : String(error));
    }

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
 * Live grades (2026-10-27, src/liveGrades.ts): each class's grade from one
 * Schoology call, for the app's open pages to roll changed numbers. `next` is
 * how many seconds to wait before asking again (Plus: sooner). Demo and
 * Google Classroom sign-ins get `COURSES: null`, which tells the app to stop.
 */
app.get("/data/grades", requireSession, async (c) => {
  const session = c.get("session");
  c.header("Cache-Control", "private, no-store");
  if (isDemo(session) || isGoogle(session)) return c.json({ COURSES: null, next: 0 });
  // Billing off: every Plus perk is free, this one included.
  let plus = !plusRequired(c.env as any);
  if (!plus) {
    try { plus = await hasPlusNow(c.env as any, session.uid, c.req.url); } catch { plus = false; }
  }
  try {
    const grades = await getGrades(session.uid, session);
    return c.json({ generatedAt: new Date().toISOString(), next: liveEvery(plus), COURSES: liveCourses(grades) });
  } catch (error) {
    if (error instanceof SchoologyError) {
      return c.json({ error: "schoology_error", status: error.status, next: liveEvery(plus) }, 502);
    }
    return c.json({ error: "unexpected_error", next: liveEvery(plus) }, 500);
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
/**
 * Which class an assignment belongs to (2026-10-07, Martin: links are just
 * assignment?id=<Schoology/Classroom id>). The assignment page asks this when
 * the id isn't in the bundle (older, graded work): every class is asked at
 * once and the one that has it answers. `{ section, title }`, or 404.
 */
app.get("/data/assignment/locate", requireSession, async (c) => {
  const session = c.get("session");
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  const id = c.req.query("id") ?? "";
  c.header("Cache-Control", "private, no-store");
  const first = async (tries: Promise<{ section: string; title: string }>[]) => {
    const settled = await Promise.allSettled(tries);
    for (const r of settled) if (r.status === "fulfilled") return r.value;
    return null;
  };
  if (isGoogle(session)) {
    if (!CLASSROOM_ID_RE.test(id)) return c.json({ error: "bad_request" }, 400);
    try {
      const accessToken = await googleAccess(c, session);
      const budget = new CallBudget(CALL_BUDGET);
      const courses = await listCourses(accessToken, budget);
      const found = await first(
        courses.map(async (course) => {
          const cid = String(course.id ?? "");
          const work = await classroomGet(`/courses/${encodeURIComponent(cid)}/courseWork/${encodeURIComponent(id)}`, { fields: "id,title" }, accessToken, budget);
          return { section: cid, title: plain(work?.title, 200) };
        })
      );
      return found ? c.json(found) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      return classroomFailure(c, error);
    }
  }
  if (!ID_RE.test(id)) return c.json({ error: "bad_request" }, 400);
  try {
    const sections = await getSections(session.uid, session);
    const found = await first(
      sections
        .map((sec: any) => String(sec?.id ?? sec?.section_id ?? ""))
        .filter((sid: string) => ID_RE.test(sid))
        .map(async (sid: string) => {
          const raw: any = await schoologyGet(`/sections/${sid}/assignments/${id}`, session);
          return { section: sid, title: String(raw?.title ?? "").slice(0, 200) };
        })
    );
    return found ? c.json(found) : c.json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof SchoologyError) return c.json({ error: "schoology_error", status: error.status }, 502);
    return c.json({ error: "unexpected_error" }, 500);
  }
});

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
    // The student's score comes from their grades in this class, asked for at
    // the same time (2026-10-15, the Submissions box's "18/20 A-"). It never
    // fails the page: without it the box shows just the points.
    const [raw, gradeSections] = await Promise.all([
      getAssignment(section, id, session),
      getSectionGrades(session.uid, section, session).catch(() => null),
    ]);
    c.header("Cache-Control", "private, no-store");
    let score: { earned: number; possible: number } | null = null;
    try {
      score = gradeSections ? assignmentScore(gradeSections, section, id) : null;
    } catch {
      score = null;
    }
    return c.json({ ...adaptAssignmentDetail(raw, section, studentTimeZone(c)), score });
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
    // ?view=1 (2026-10-21): open it in the browser's own viewer (PDF, picture,
    // text, audio, video) instead of downloading. Anything else still downloads.
    if (c.req.query("view") === "1") {
      const viewed = viewResponse(upstream, file.name);
      if (viewed) return viewed;
    }
    return downloadResponse(upstream, file.name);
  } catch (error) {
    if (error instanceof SchoologyError) return c.json({ error: "schoology_error", status: error.status }, 502);
    return c.json({ error: "unexpected_error" }, 500);
  }
});

/**
 * File types a browser shows by itself, by file extension (Schoology often
 * says application/octet-stream). Deliberately no HTML, SVG, XML or anything
 * else that can run script: those would run on api.averages.io, next to the
 * session cookie, so they always download.
 */
export const VIEWABLE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/** The type to show a file inline as, or null when it should download. */
export function viewableType(name: string): string | null {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ""))?.[1]?.toLowerCase() ?? "";
  return Object.prototype.hasOwnProperty.call(VIEWABLE_TYPES, ext) ? VIEWABLE_TYPES[ext] : null;
}

/**
 * A file from Schoology shown in the browser (Course Materials double-click,
 * 2026-10-21), or null when its type isn't one the browser shows safely. The
 * type comes from our list, never from upstream; nothing on the page can run
 * (CSP), it can't be framed, and nosniff stops it being read as anything else.
 */
function viewResponse(upstream: Response, name: string): Response | null {
  const type = viewableType(name);
  if (!type) return null;
  const { ascii, utf8Name } = dispositionNames(name);
  const headers = new Headers({
    "Content-Type": type,
    "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${utf8Name}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  const length = upstream.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(upstream.body, { status: 200, headers });
}

/** The two forms of a file name for Content-Disposition: plain ASCII, and RFC 5987 UTF-8. */
function dispositionNames(name: string): { ascii: string; utf8Name: string } {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  let utf8Name: string;
  try {
    utf8Name = encodeURIComponent(name).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  } catch {
    utf8Name = encodeURIComponent(ascii); // a lone surrogate can't be encoded; the ASCII name still works
  }
  return { ascii, utf8Name };
}

/**
 * A file from Schoology streamed on to the browser as a download named
 * `name` (moved out of GET /data/attachment on 2026-10-09 so
 * GET /data/submission-file sends exactly the same headers).
 */
function downloadResponse(upstream: Response, name: string): Response {
  // RFC 5987 filename*, plus a plain ASCII fallback, so any name downloads under its real title.
  const { ascii, utf8Name } = dispositionNames(name);
  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${utf8Name}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const length = upstream.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(upstream.body, { status: 200, headers });
}

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

/** Runs `fn` on every item, at most `limit` at once (Schoology's rate limit is unpublished). */
async function eachAtMost<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The files the signed-in student turned in on Schoology, for the Files page
 * (2026-10-09): every file in their own submission revisions (drafts left
 * out), newest first, at most 500. Ids and names only, never download paths;
 * GET /data/submission-file looks a file up again to download it. Nothing is
 * stored.
 *
 * The same classes as GET /data/files (12 at most, 4 at a time). Only
 * assignments that take files are asked about (see turnInAssignments in
 * submit.ts: no quizzes, tests or discussions, nothing with allow_dropbox
 * "0"), most relevant first, at most 60 and never more than the Free plan's
 * subrequest limit leaves room for (SUBMISSION_CALL_BUDGET), 6 histories at
 * a time. A 404 from a history is "nothing turned in"; any other failure, or
 * assignments left unread, makes the answer `partial: true`.
 *
 * Google Classroom: nothing to list here (work is turned in on Classroom and
 * the files are in the student's own Drive).
 */
app.get("/data/submissions", async (c) => {
  const session = await sessionFrom(c);
  if (!session) return c.json({ error: "not_authenticated" }, 401);
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  c.header("Cache-Control", "private, no-store");
  if (isGoogle(session)) return c.json({ platform: "classroom", courses: [], files: [], partial: false });
  try {
    const { COURSES } = adaptCourses(await getSections(session.uid, session), []);
    const courses = COURSES.slice(0, 12).map((course) => ({ id: course.id, name: course.name, color: course.color }));
    const bySection: Record<string, any[] | null> = {};
    await eachAtMost(courses, 4, async (course) => {
      bySection[course.id] = ID_RE.test(course.id) ? await getAssignments(course.id, session).catch(() => null) : null;
    });
    // A class that didn't answer, or a full page (Schoology may have more than it sent).
    let partial = Object.values(bySection).some((list) => !list || list.length >= 200);

    const candidates = turnInAssignments(bySection);
    const room = Math.max(0, Math.min(MAX_SUBMISSION_ASSIGNMENTS, SUBMISSION_CALL_BUDGET - 1 - courses.length));
    if (candidates.length > room) partial = true;
    const found: SubmittedFile[] = [];
    await eachAtMost(candidates.slice(0, room), 6, async (assignment) => {
      try {
        const raw = await getHistory(session, assignment.course, assignment.id, session.uid);
        found.push(...submittedFiles(raw, session.uid, assignment));
      } catch (error) {
        // Nothing turned in can come back as a 404 (as in /submit/history): not a failure.
        if (error instanceof SchoologyError && error.status === 404) return;
        partial = true;
      }
    });
    const { files, cut } = newestSubmittedFiles(found);
    return c.json({ platform: "schoology", courses, files, partial: partial || cut });
  } catch (error) {
    if (error instanceof SchoologyError) return c.json({ error: "schoology_error", status: error.status }, 502);
    return c.json({ error: "unexpected_error" }, 500);
  }
});

/**
 * Downloads one file the student turned in (the Files page's "Turned in"
 * list, 2026-10-09). The browser navigates here with ids only; the file is
 * looked up again in the student's own submission history (their revisions
 * only, as /submit/history shows them) and streamed straight through from
 * Schoology with the same safe download code as GET /data/attachment, never
 * stored. 404 not_found when that revision or file isn't the student's.
 */
app.get("/data/submission-file", async (c) => {
  const session = await sessionFrom(c);
  if (!session) return c.json({ error: "not_authenticated" }, 401);
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  // Google Classroom files live in Google Drive and open there; they never pass through this Worker.
  if (isGoogle(session)) return c.json({ error: "classroom_files_open_in_drive" }, 404);
  const section = c.req.query("section") ?? "";
  const assignment = c.req.query("assignment") ?? "";
  const revision = c.req.query("revision") ?? "";
  const fileId = c.req.query("file") ?? "";
  if (![section, assignment, revision, fileId].every((id) => ID_RE.test(id))) {
    return c.json({ error: "bad_request" }, 400);
  }
  try {
    let history: unknown;
    try {
      history = await getHistory(session, section, assignment, session.uid);
    } catch (error) {
      // Nothing turned in (or no such assignment for this student).
      if (error instanceof SchoologyError && error.status === 404) return c.json({ error: "not_found" }, 404);
      throw error;
    }
    const file = findSubmittedFile(history, session.uid, revision, fileId);
    if (!file || !file.downloadPath) return c.json({ error: "not_found" }, 404);
    const upstream = await openAttachment(file.downloadPath, session);
    return downloadResponse(upstream, file.name);
  } catch (error) {
    if (error instanceof SchoologyError) return c.json({ error: "schoology_error", status: error.status }, 502);
    return c.json({ error: "unexpected_error" }, 500);
  }
});

/**
 * Public app values for Google Drive and OneDrive. Until 2026-10-08 they
 * connected entirely in the browser; now the Worker keeps them connected
 * (/cloud/* below) and the app still needs the Picker's key and project
 * number from here. Everything here is
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
  // A minute (was 5, 2026-10-07): a new Picker key reaches browsers quickly.
  c.header("Cache-Control", "public, max-age=60");
  const cfg = cloudConfig(c.env);
  // A switched-off integration looks unconfigured to older pages too.
  if (!featureOn(c.env, "drive-integration")) cfg.google = null;
  if (!featureOn(c.env, "onedrive-integration")) cfg.microsoft = null;
  return c.json(cfg);
});

/**
 * GET /config/features (2026-10-09): every switch, for the app to hide what's
 * off (public/js/averages-features.js), and the maintenance banner's text.
 * Thirty seconds, so a flip reaches everyone within a minute.
 */
app.get("/config/features", (c) => {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, featureOn(c.env, k)])) as Features;
  // Billing off (2026-10-21): early-access features are on for everyone, not just Plus members.
  const everyone = !plusRequired(c.env as any);
  if (everyone) for (const k of FEATURE_KEYS) if (!features[k] && earlyKey(c.env, k)) features[k] = true;
  const msg = typeof c.env.MAINTENANCE_MESSAGE === "string" ? c.env.MAINTENANCE_MESSAGE.trim().slice(0, 300) : "";
  c.header("Cache-Control", "public, max-age=30");
  return c.json({
    features,
    // Early access (2026-10-21): switches that are off for everyone but on for Plus members.
    early: FEATURE_KEYS.filter((k) => !features[k] && earlyKey(c.env, k)),
    maintenance: featureOn(c.env, "maintenance-banner") ? { message: msg || "Averages.io is having some trouble right now. Some things may not work." } : null,
  });
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
  // Developer only (2026-10-10): also ask for the undocumented permission
  // scopes, but only while CANVA_PERMISSION_PROBE is "1" (canvaScopes ignores
  // it otherwise, so a normal Connect is never affected). See POST /canva/probe.
  const probe = c.req.query("probe") === "1";
  try {
    // The scopes depend on switches that can come from Flagship (src/flags.ts): pass them in.
    return c.redirect(await canvaStore(c.env, session.uid, c.req.url).beginConnect(returnTo, { CANVA_EXPORT_ENABLED: c.env.CANVA_EXPORT_ENABLED, CANVA_FOLDERS_ENABLED: c.env.CANVA_FOLDERS_ENABLED, CANVA_PERMISSION_PROBE: c.env.CANVA_PERMISSION_PROBE }, probe));
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
    // Revoked at Canva too (2026-10-26): Averages.io leaves the student's Canva account.
    await canvaStore(c.env, c.get("session").uid, c.req.url).disconnect(c.get("session").uid);
    return c.json({ ok: true });
  } catch (error) {
    return canvaFailure(c, error, "canva_disconnect_failed");
  }
});

/**
 * Permission probe (temporary, developer only, 2026-10-10). Lets Martin test,
 * from the live site with his own real Canva connection, whether Canva's
 * undocumented design:permission:* / folder:permission:write scopes do
 * anything: it makes one throwaway test design and folder and tries the most
 * likely (undocumented) addresses against ONLY those, returning what Canva
 * answered (see probePermissions in canva.ts). Off unless CANVA_PERMISSION_PROBE
 * is "1" AND the REVIEW_SECRET (or SCHOOLS_ADMIN_KEY) secret is set, and then only for a caller
 * who presents that key. Tokens never appear in the answer or the logs.
 *
 * Only the general /canva rule (30/min) and Flagship's canva-integration
 * switch apply. The extra 3-runs-per-10-minutes cap was removed (2026-10-10,
 * Martin); the key and CANVA_PERMISSION_PROBE still keep it to the developer.
 */

app.post("/canva/probe", requireSession, async (c) => {
  c.header("Cache-Control", "no-store");
  // Doesn't exist unless switched on and a key is configured: a wrong flag or a
  // missing key is indistinguishable from an unknown route. The key is the
  // REVIEW_SECRET dashboard secret (2026-10-10, Martin: he has no
  // SCHOOLS_ADMIN_KEY); SCHOOLS_ADMIN_KEY also works if it's ever set.
  const keys = [c.env.REVIEW_SECRET ?? "", c.env.SCHOOLS_ADMIN_KEY ?? ""].filter((k) => k.length >= 16);
  if (!canvaProbeEnabled(c.env) || !keys.length) return c.json({ error: "not_found" }, 404);

  const session = c.get("session");
  // Same gates as the other Canva POSTs: no demo/incognito, configured, our app, JSON.
  const blocked = canvaGuard(c) ?? notFromOurApp(c);
  if (blocked) return blocked;
  // Google Classroom sign-ins have no Canva connection (same as /canva/edit).
  if (isGoogle(session)) return c.json({ error: "classroom_not_supported" }, 403);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  // Constant-time, length-safe: either key unlocks the probe (both are always compared).
  const given = String(body?.key ?? "");
  const matches = keys.map((k) => sameString(given, k));
  if (!matches.some(Boolean)) return c.json({ error: "forbidden" }, 403);


  const write = body?.write === true;
  try {
    const store = canvaStore(c.env, session.uid, c.req.url);
    // The student's own token through the normal refresh path (409 if not connected).
    const token = await store.accessToken(session.uid);
    const scopes = await store.grantedScopes(session.uid).catch(() => null);
    // The full sweep (2026-10-10): one batch per request, see probeSweep in canva.ts.
    if (body?.sweep === true) {
      const out = await probeSweep(token, { batch: Number(body.batch) || 0, designId: typeof body.designId === "string" ? body.designId : "", folderId: typeof body.folderId === "string" ? body.folderId : "" });
      if (out.error) return c.json({ ok: false, error: out.error, results: out.results }, 400);
      return c.json({ ok: true, sweep: true, scopes, ...out });
    }
    const { designId, folderId, results } = await probePermissions(token, { write });
    return c.json({ ok: true, scopes, designId, folderId, results });
  } catch (error) {
    return canvaFailure(c, error, "canva_probe_failed");
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
 * Save a folder to Canva (2026-10-16, src/canvaSave.ts): every file in one of
 * the teacher's folders (or a single file) becomes a design in the student's
 * Canva, in a new Canva folder with the folder's name. The files go through
 * the queue one at a time, spaced out under Canva's limit; this answers at
 * once with the job, and GET /canva/save-folder/:job shows how it's going.
 */
const SAVE_PURPOSE = "canva-save";
app.post("/canva/save-folder", requireSession, async (c) => {
  const blocked = canvaGuard(c) ?? notFromOurApp(c);
  if (blocked) return blocked;
  const session = c.get("session");
  if (isGoogle(session)) return c.json({ error: "classroom_not_supported" }, 403);
  // Runs on the queue: without it there's nothing to run the job.
  if (!c.env.RETRY) return c.json({ error: "save_unavailable" }, 503);
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  if (Array.isArray(body?.files) && body.files.length > SAVE_MAX_FILES) return c.json({ error: "too_many_files", max: SAVE_MAX_FILES }, 413);
  const files = parseSaveFiles(body?.files);
  if (!files) return c.json({ error: "bad_request" }, 400);
  const name = cleanFolderName(body?.name);
  const store = canvaStore(c.env, session.uid, c.req.url);
  try {
    // Connected? (409 canva_not_connected / canva_reconnect_needed otherwise.)
    await store.accessToken(session.uid);
    // A Canva folder for more than one file, when the connection may make folders. Without, they go to Projects.
    let folderId: string | null = null;
    if (files.length > 1 && canvaFoldersEnabled(c.env)) {
      try {
        const token = await store.accessTokenWithScope(session.uid, FOLDER_WRITE_SCOPE);
        folderId = (await createFolder(token, name, "root")).id || null;
      } catch (error) {
        console.log("canva_save_no_folder", errorCode(error, "canva_folder_failed"));
      }
    }
    // The sign-in, sealed, so the queue can fetch the files from Schoology; gone when the job ends.
    const sealed = await sealValue(JSON.stringify(session), c.env.SESSION_SECRET, SAVE_PURPOSE, SAVE_CRED_TTL_S);
    const id = newJobId();
    const status = await store.saveCreate({ id, name, folderId, files, sealed, uid: session.uid });
    if (!status) return c.json({ error: "too_many_save_jobs" }, 429);
    const obj = store.id.toString();
    const at = Date.now();
    const queued = await enqueueMany(
      c.env,
      files.map((_, i) => ({ message: { k: "canva_save" as const, obj, job: id, i, at }, delaySeconds: i * SAVE_SPACING_S })),
    );
    if (!queued) {
      await store.saveStop(id);
      return c.json({ error: "save_unavailable" }, 503);
    }
    c.header("Cache-Control", "no-store");
    return c.json(status);
  } catch (error) {
    return canvaFailure(c, error, "canva_save_failed");
  }
});

app.get("/canva/save-folder/:job", requireSession, async (c) => {
  const blocked = canvaGuard(c);
  if (blocked) return blocked;
  const id = c.req.param("job");
  if (!SAVE_JOB_RE.test(id)) return c.json({ error: "bad_request" }, 400);
  const session = c.get("session");
  const status = await canvaStore(c.env, session.uid, c.req.url).saveStatus(id);
  c.header("Cache-Control", "no-store");
  return status ? c.json(status) : c.json({ error: "not_found" }, 404);
});

app.delete("/canva/save-folder/:job", requireSession, async (c) => {
  const blocked = canvaGuard(c) ?? notFromOurApp(c);
  if (blocked) return blocked;
  const id = c.req.param("job");
  if (!SAVE_JOB_RE.test(id)) return c.json({ error: "bad_request" }, 400);
  const session = c.get("session");
  const status = await canvaStore(c.env, session.uid, c.req.url).saveStop(id);
  return status ? c.json(status) : c.json({ error: "not_found" }, 404);
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

/* ────────────────────────────────────────────────────────────────────
 * Google Drive and OneDrive that stay connected (2026-10-08)
 *
 * Martin: "why do google drive and onedrive need to be reauthed every time I
 * visit the page, why can't it be like canva". Same shape as the Canva
 * routes above: the browser navigates to /cloud/:app/connect, the provider
 * sends it back to /cloud/:app/callback, and the student's refresh token
 * stays in their CloudStore (src/cloudConnect.ts). The app then asks
 * POST /cloud/:app/token for a short-lived access token whenever it needs
 * one, and calls Drive or Graph itself: no file passes through here.
 * ──────────────────────────────────────────────────────────────────── */

/** The cloud_* code in an error from the CloudStore; anything unexpected is logged and becomes `fallback`. */
function cloudCode(error: unknown, fallback: string): string {
  // Like errorCode above: over RPC the message may arrive prefixed with the class name.
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = message.match(/\bcloud_[a-z_]+/)?.[0];
  if (code) return code;
  console.error(fallback, error);
  return fallback;
}

function cloudFailure(c: any, error: unknown, fallback: string) {
  const code = cloudCode(error, fallback);
  return c.json({ error: code }, statusForCloudCode(code));
}

/** Back to our own app (fixed origin, checked path) with ?cloud=<outcome>&app=<app>. */
function cloudBack(origin: string, returnTo: string, outcome: string, cloudApp: CloudApp): string {
  return `${origin}${withQuery(withQuery(safeAppPath(returnTo, "/settings"), "cloud", outcome), "app", cloudApp)}`;
}

/**
 * Settings' "Connected as ..." lines for both apps, and whether each is set up
 * on this Worker. `lost: true` (2026-10-09, with `connected: false`) when the
 * connection was dropped because Google or Microsoft refused it; `email` and
 * `name` are then the account that was connected, so Settings can offer to
 * reconnect it.
 */
app.get("/cloud/status", requireSession, async (c) => {
  const session = c.get("session");
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  c.header("Cache-Control", "private, no-store");
  const answer: Record<string, unknown> = {};
  for (const cloudApp of CLOUD_APPS) {
    answer[cloudApp] = { configured: cloudConfigured(c.env, cloudApp), connected: false, lost: false, email: "", name: "", scopes: [] };
  }
  // Incognito keeps nothing, so it can't be connected.
  if (isIncognito(session)) return c.json({ ...answer, incognito: true });
  if (!CLOUD_APPS.some((cloudApp) => cloudConfigured(c.env, cloudApp))) return c.json(answer);
  try {
    const stored = await cloudStore(c.env, session.uid, c.req.url).status(session.uid);
    for (const cloudApp of CLOUD_APPS) {
      if (cloudConfigured(c.env, cloudApp)) answer[cloudApp] = { configured: true, ...stored[cloudApp] };
    }
    return c.json(answer);
  } catch (error) {
    return cloudFailure(c, error, "cloud_unavailable");
  }
});

/**
 * Starts connecting (browser navigation): on to Google's or Microsoft's
 * consent screen. ?return_to= is the app page to come back to, ?read=1 asks
 * OneDrive for Files.Read too, ?login_hint= pre-fills the account.
 */
app.get("/cloud/:app/connect", async (c) => {
  const cloudApp = c.req.param("app");
  if (!isCloudApp(cloudApp)) return c.json({ error: "not_found" }, 404);
  const origin = appOrigin(c.req.url);
  const session = await sessionFrom(c);
  if (!session || isDemo(session)) return c.redirect(`${origin}/`);
  if (isIncognito(session)) return c.redirect(`${origin}/settings?cloud=incognito&app=${cloudApp}`);
  const returnTo = safeAppPath(c.req.query("return_to"), "/settings");
  if (!cloudConfigured(c.env, cloudApp)) return c.redirect(cloudBack(origin, returnTo, "not_configured", cloudApp));
  c.header("Cache-Control", "no-store");
  try {
    const url = await cloudStore(c.env, session.uid, c.req.url).beginConnect(session.uid, cloudApp, {
      returnTo,
      read: c.req.query("read") === "1",
      write: c.req.query("write") === "1",
      loginHint: c.req.query("login_hint") ?? null,
      // This Worker's own address as the browser reached it, so wrangler dev
      // works too. It must be listed with Google / Microsoft (see README).
      redirectUri: `${new URL(c.req.url).origin}/cloud/${cloudApp}/callback`,
    });
    return c.redirect(url);
  } catch (error) {
    cloudCode(error, "cloud_connect_failed");
    return c.redirect(cloudBack(origin, returnTo, "failed", cloudApp));
  }
});

/** Google or Microsoft sends the student back here with ?code&state, or ?error when they cancel. */
app.get("/cloud/:app/callback", async (c) => {
  const cloudApp = c.req.param("app");
  if (!isCloudApp(cloudApp)) return c.json({ error: "not_found" }, 404);
  const origin = appOrigin(c.req.url);
  const session = await sessionFrom(c);
  if (!session || isDemo(session)) return c.redirect(`${origin}/`);
  if (isIncognito(session)) return c.redirect(`${origin}/settings?cloud=incognito&app=${cloudApp}`);
  // The code is in this URL: never let it travel on as a Referer.
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const store = cloudStore(c.env, session.uid, c.req.url);
  const state = c.req.query("state") ?? "";
  try {
    const error = c.req.query("error");
    if (error) {
      const returnTo = await store.cancelConnect(cloudApp, state);
      return c.redirect(cloudBack(origin, returnTo, error === "access_denied" ? "cancelled" : "failed", cloudApp));
    }
    const result = await store.finishConnect(session.uid, cloudApp, state, c.req.query("code") ?? "");
    // Only our own short codes are logged, never the provider's answer.
    if (result.outcome !== "connected") console.warn("cloud_connect_not_finished", cloudApp, result.code ?? "");
    return c.redirect(cloudBack(origin, result.returnTo, result.outcome, cloudApp));
  } catch (error) {
    cloudCode(error, "cloud_callback_failed");
    return c.redirect(cloudBack(origin, "/settings", "failed", cloudApp));
  }
});

/** POST /cloud/:app/token's body: optional (older pages send `{}`), at most 1 KB. Null when it isn't a JSON object. */
async function tokenRequestBody(c: any): Promise<Record<string, unknown> | null> {
  if (Number(c.req.header("Content-Length") ?? 0) > 1024) return null;
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return null;
  }
  if (text.length > 1024) return null;
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * A short-lived access token for the browser: `{access_token, expires_in,
 * email, scopes}`. The cached one while it has more than 5 minutes left,
 * otherwise a fresh one (refreshed inside the student's CloudStore, one at a
 * time). JSON POST from our own app only, so another site can't fetch it.
 *
 * `{ "refresh": true }` (2026-10-09): the browser just got a 401 from Drive or
 * Graph with the token it has. A student who removes Averages.io from their
 * account leaves us a cached token that looks good for up to an hour, and
 * handing it out again made a loop; this refreshes even so (at most once per
 * 30 seconds per connection: within that the current token comes back). A
 * refused grant answers 409 cloud_reconnect_needed and forgets the connection.
 */
app.post("/cloud/:app/token", requireSession, async (c) => {
  const cloudApp = c.req.param("app");
  if (!isCloudApp(cloudApp)) return c.json({ error: "not_found" }, 404);
  const session = c.get("session");
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
  c.header("Cache-Control", "no-store");
  if (isIncognito(session)) return c.json({ error: "incognito_mode" }, 403);
  if (!cloudConfigured(c.env, cloudApp)) return c.json({ error: "cloud_not_configured" }, 503);
  const body = await tokenRequestBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  try {
    const opts = body.refresh === true ? { refresh: true } : {};
    return c.json(await cloudStore(c.env, session.uid, c.req.url).accessToken(session.uid, cloudApp, opts));
  } catch (error) {
    return cloudFailure(c, error, "cloud_unavailable");
  }
});

/**
 * Disconnect: revokes Google's grant where that's safe (see
 * CloudAccount.disconnect) and forgets the tokens, and a lost connection's
 * marker (2026-10-09). Allowed in Incognito, so a student can always remove a
 * connection. Files stay in their Drive.
 */
app.delete("/cloud/:app/connection", requireSession, async (c) => {
  const cloudApp = c.req.param("app");
  if (!isCloudApp(cloudApp)) return c.json({ error: "not_found" }, 404);
  const session = c.get("session");
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
  try {
    // Google's grant is revoked too, unless this student signed in with Google
    // (the same client holds their sign-in; see CloudAccount.disconnect).
    await cloudStore(c.env, session.uid, c.req.url).disconnect(session.uid, cloudApp, { revokeShared: !isGoogle(session) });
    return c.json({ ok: true });
  } catch (error) {
    return cloudFailure(c, error, "cloud_disconnect_failed");
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
 * Averages Plus (2026-10-21): checkout, status and the customer page
 * (src/billingRoutes.ts), and Stripe's signed webhook at /stripe/webhook.
 */
app.route("/billing", billingRoutes({ requireSession, fromOurApp: notFromOurApp, appOrigin, storeFor: billingStore }) as any);
app.route("/stripe", stripeWebhookRoutes({
  storeFor: billingStore,
  // Plus ended: notifications and the calendar link are deleted (src/plus.ts).
  onPlusEnded: async (env, uid, requestUrl) => {
    // Only while billing is on: with it off, both are free for everyone (2026-10-21).
    if (!plusRequired(env)) return;
    await forgetPush(env, uid, requestUrl);
    await forgetCalendar(env, uid, requestUrl);
  },
}) as any);

/** Calendar sync, an Averages Plus perk (src/calendar.ts). */
app.route("/calendar", calendarRoutes({ requireSession, fromOurApp: notFromOurApp }) as any);

/** Profile photo and background for Sync Across Devices, in R2 (src/media.ts). */
app.route("/media", mediaRoutes({ requireSession, fromOurApp: notFromOurApp }) as any);

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
    converterOn: (c) => converterOn(c.env),
    pdfToDocx: (c, pdf) => pdfToDocx(c.env, pdf),
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

/**
 * The Worker: HTTP through Hono. Tests call `app.fetch` on this object
 * exactly as they did on the Hono app.
 */
/**
 * The retry queue's tries (2026-10-16, src/retryQueue.ts). Each says "done",
 * "retry" (a passing failure: the queue tries again later) or "drop" (it
 * can't work: the browser is gone).
 */
export function retryHandlers(env: Bindings): RetryHandlers {
  return {
    async push(obj, ep, note, at) {
      if (!env.PUSH) return "drop";
      const stub = env.PUSH.get(env.PUSH.idFromString(obj));
      return stub.resend(ep, note, at);
    },
    async canvaSave(obj, job, i) {
      if (!env.CANVA) return "drop";
      const stub = env.CANVA.get(env.CANVA.idFromString(obj));
      return saveOneFile({
        take: () => stub.saveTake(job, i),
        record: (result) => stub.saveRecord(job, i, result),
        openSession: async (sealed) => {
          const opened = await openValue(sealed, env.SESSION_SECRET, SAVE_PURPOSE);
          if (typeof opened !== "string") return null;
          try {
            const s = JSON.parse(opened) as SessionData;
            return s && typeof s.uid === "string" && s.uid && typeof s.key === "string" ? s : null;
          } catch {
            return null;
          }
        },
        findFile: async (session, item) => {
          const creds = session as SessionData;
          const raw = item.kind === "assignment" ? await getAssignment(item.section, item.parent, creds) : await getDocument(item.section, item.parent, creds);
          const file = findAttachment(raw, item.file);
          return file && file.downloadPath ? file : null;
        },
        download: (session, path) => downloadAttachment(path, session as SessionData, MAX_IMPORT_BYTES),
        canvaToken: (uid) => stub.accessToken(uid),
        importFile: (token, name, bytes, contentType) => importFile(token, name, bytes, mimeForName(name) ?? (contentType || undefined)),
        findImported: (token, name) => findDesignByTitle(token, importTitle(name)),
        moveToFolder: async (uid, designId, folderId) => moveItem(await stub.accessTokenWithScope(uid, FOLDER_WRITE_SCOPE), designId, folderId),
        maxBytes: MAX_IMPORT_BYTES,
      });
    },
    async gaveUp(message) {
      if (message.k !== "canva_save" || !env.CANVA) return;
      const stub = env.CANVA.get(env.CANVA.idFromString(message.obj));
      await stub.saveRecord(message.job, message.i, { state: "failed", error: "gave_up" });
    },
  };
}

export default {
  // Flagship switches (src/flags.ts) are read once per request, before the app sees env.
  fetch: async (request: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(request, await withFlags(env), ctx),
  // The retry queue (2026-10-16): see src/retryQueue.ts.
  queue: async (batch: MessageBatch<unknown>, env: Bindings) => handleRetryBatch(batch, retryHandlers(env)),
};
