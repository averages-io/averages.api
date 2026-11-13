// api.averages.io — Averages.io's Schoology proxy.

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
  sessionToken,
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
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
  getDiscussion,
  getDiscussions,
  getGrades,
  getMe, isFacultyAccount,
  getMessages,
  getSections,
  schoologyGet,
  SchoologyError,
} from "./schoology.ts";
import {
  adaptAssignmentDetail,
  adaptAssignments,
  discussionsAsWork,
  freshenUpdated,
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
  mergeSeen,
  loadSyncRecord,
  saveSyncRecord,
  kvFromSyncStore,
  type KVLike,
} from "./sync.ts";
import { cloudConfig } from "./cloud.ts";
import { CLOUD_APPS, cloudConfigured, isCloudApp, statusForCloudCode, type CloudApp } from "./cloudConnect.ts";
import { schoolsFor } from "./schools.ts";
import {
  OAUTH_PURPOSE,
  OAUTH_TTL_SECONDS,
  OAuthError,
  accessToken,
  authorizeUrl,
  clearPendingCookie,
  consumerFrom,
  isSandboxConsumer,
  pendingCookie,
  requestToken,
  sameToken,
  schoolDomain,
  validPending,
  OAUTH_COOKIE,
} from "./schoologySignin.ts";
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
import { findMessageFile, getRecipients, getThread, namesFrom } from "./messages.ts";
import { getFolder, getSectionGrades, parseFolder } from "./extras.ts";
import { dataExtrasRoutes, messagesRoutes } from "./extrasRoutes.ts";
import { cleanEmail, codeHash, codeMessage, DEFAULT_EMAIL_FROM, EMAIL_CODE_PURPOSE, EMAIL_CODE_TTL, newCode, sameHash, sendFailure, type SendEmailBinding } from "./emailCode.ts";
import { getLinkImage, getLinkPreview, parseTarget } from "./linkPreview.ts";
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
import { pushConfigured } from "./pushStore.ts";
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
import { canvaExportRoutes, contentDisposition } from "./canvaExport.ts";
import { downNow, healthMessage, healthStore, HEALTH_SERVICES, nextRecord, readHealth, runChecks, type HealthAnswer } from "./health.ts";
import { capStream, DRIVE_FILE_ID_RE, DriveExportError, isDriveExportType, openDriveExport } from "./driveExport.ts";
import { canvaFolderRoutes, createFolder, moveItem } from "./canvaFolders.ts";
import { answerUnlessSame, FP_HEADER } from "./fingerprint.ts";
import { cleanFolderName, newJobId, parseSaveFiles, SAVE_CRED_TTL_S, SAVE_JOB_RE, SAVE_MAX_FILES, SAVE_SPACING_S, saveOneFile } from "./canvaSave.ts";

// The Durable Object classes have to be exported from the Worker's main module
// for Cloudflare to find them (see wrangler.jsonc's durable_objects).
export { SyncStore } from "./syncStore.ts";
export { CanvaStore } from "./canvaStore.ts";
export { CloudStore } from "./cloudStore.ts";
export { BillingStore } from "./billingStore.ts";
export { PushStore } from "./pushStore.ts";
export { CalendarStore } from "./calendar.ts";
export { HealthStore } from "./healthStore.ts";

type Bindings = {
  /** Random high-entropy string. Set with: npx wrangler secret put SESSION_SECRET */
  SESSION_SECRET: string;
  SYNC: DurableObjectNamespace<SyncStore>;
  MEDIA?: R2Bucket;
  EMAIL?: SendEmailBinding;
  EMAIL_FROM?: string;
  CANVA: DurableObjectNamespace<CanvaStore>;
  /** Canva Connect app credentials (dashboard secrets) and the callback URL (wrangler.jsonc var). */
  CANVA_CLIENT_ID?: string;
  CANVA_CLIENT_SECRET?: string;
  CANVA_REDIRECT_URI?: string;
  CANVA_EXPORT_ENABLED?: string;
  CANVA_FOLDERS_ENABLED?: string;
  CANVA_PERMISSION_PROBE?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_PROJECT_NUMBER?: string;
  MS_CLIENT_ID?: string;
  CLOUD: DurableObjectNamespace<CloudStore>;
  BILLING?: DurableObjectNamespace<BillingStore>;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_LOOKUP_KEY?: string;
  MS_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  PUSH: DurableObjectNamespace<PushStore>;
  RETRY?: Queue<RetryMessage>;
  FEATURES?: Features;
  FEATURES_OFF?: string;
  FEATURES_ON?: string;
  FEATURES_EARLY?: string;
  EARLY?: FeatureKey[];
  CALENDAR?: DurableObjectNamespace;
  MAINTENANCE_MESSAGE?: string;
  /** The automatic outage check's one record (src/health.ts, src/healthStore.ts). */
  HEALTH?: DurableObjectNamespace;
  /** "1": Fullscreen for everyone (while its switch is on). "0": only testers (fullscreenTester). Unset counts as "1". */
  FULLSCREEN_PUBLIC?: string;
  /** More school addresses (comma-separated) that see Fullscreen while FULLSCREEN_PUBLIC is "0". */
  FULLSCREEN_SCHOOLS?: string;
  REVIEW_KEY?: string;
  FLAGS?: { getBooleanValue(key: string, defaultValue: boolean, context?: Record<string, unknown>): Promise<boolean> };
  REVIEW_SECRET?: string;
  SCHOOLOGY_CONSUMER_KEY?: string;
  SCHOOLOGY_CONSUMER_SECRET?: string;
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

function billingStore(env: BillingRouteEnv, uid: string, requestUrl: string): BillingStoreApi {
  const billing = env.BILLING!;
  const ns = isLocalRequest(requestUrl) ? billing : billing.jurisdiction("us" as DurableObjectJurisdiction);
  return ns.get(ns.idFromName(uid)) as unknown as BillingStoreApi;
}

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
    exposeHeaders: ["Retry-After", "Content-Disposition", "X-Media-Version", FP_HEADER],
  })(c, next);
});

const openedSessions = new WeakMap<Request, Promise<SessionData | null>>();
function openedSession(c: any): Promise<SessionData | null> {
  const raw: Request = c.req.raw;
  let opened = openedSessions.get(raw);
  if (!opened) {
    const token = sessionToken(c.req.header("Cookie") ?? null);
    opened = token && c.env.SESSION_SECRET ? openSession(token, c.env.SESSION_SECRET) : Promise.resolve(null);
    openedSessions.set(raw, opened);
  }
  return opened;
}

app.use("*", async (c, next) => {
  await next();
  if (isLocalRequest(c.req.url)) return;
  try { c.res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); } catch { /* headers fixed: skip */ }
});

app.use("*", rateLimit({ studentOf: async (c) => (await openedSession(c))?.uid ?? null }));

app.use("*", async (c, next) => {
  await next();
  const header = c.req.header("Cookie") ?? null;
  if (readCookie(header, SESSION_COOKIE) || !readCookie(header, LEGACY_SESSION_COOKIE)) return;
  if (/(^|,\s*)(averages|schoolagy)_session=/.test(c.res.headers.get("Set-Cookie") ?? "")) return;
  const token = readCookie(header, LEGACY_SESSION_COOKIE);
  if (!token || !(await openedSession(c))) return;
  try {
    c.res.headers.append("Set-Cookie", sessionCookie(token, COOKIE_DOMAIN));
    c.res.headers.append("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN, LEGACY_SESSION_COOKIE));
  } catch {
    // a response whose headers can't change (passed straight through): it moves on the next request
  }
});

const NAVIGATED = /^\/(canva\/(connect|callback|return)|cloud\/[^/]+\/(connect|callback))$/;
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const path = new URL(c.req.url).pathname;
  const offs = featureForRoute(c.req.method, path).filter((k) => !featureOn(c.env, k));
  let off = offs[0];
  if (off && offs.every((k) => earlyKey(c.env, k))) {
    const session = await openedSession(c);
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
  const token = sessionToken(c.req.header("Cookie") ?? null);
  if (!token) {
    return c.json({ error: "not_authenticated" }, 401);
  }
  const session = await openedSession(c);
  if (!session) {
    // Expired or tampered — clear it so the browser stops sending a dead cookie.
    c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN));
    c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN, LEGACY_SESSION_COOKIE), { append: true }); // the old name goes too
    return c.json({ error: "session_expired" }, 401);
  }
  c.set("session", session);
  await next();
}

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
 * api.averages.io/status (2026-11-09, Martin): everything the public routes say, on one page, in the same flat
 * shape as "/". Whether each part of Averages.io is on and set up, with the maintenance message when there is one.
 * Booleans only: no client ids, keys or anyone's data.
 */
app.get("/status", async (c) => {
  const env = c.env as any;
  const on = (k: FeatureKey) => featureOn(c.env, k);
  const cloud = cloudConfig(c.env);
  const consumer = consumerFrom(c.env);
  const maintenance = on("maintenance-banner");
  const msg = typeof c.env.MAINTENANCE_MESSAGE === "string" ? c.env.MAINTENANCE_MESSAGE.trim().slice(0, 300) : "";
  // the automatic check every 15 minutes (src/health.ts): each part's last answer
  const now = Date.now();
  const rec = await readHealth(env, isLocalRequest(c.req.url));
  const down = downNow(rec, now);
  const fresh = down.length > 0 || (!!rec && now - rec.checked <= 45 * 60_000);
  const health: Record<string, string> = {};
  for (const s of HEALTH_SERVICES) health[s] = fresh && rec ? (rec.services?.[s] ?? "unknown") : "unknown";
  const downSince: Record<string, string> = {};
  for (const s of down) if (rec?.since?.[s]) downSince[s] = new Date(rec.since[s]!).toISOString();
  c.header("Cache-Control", "public, max-age=30");
  return c.json({
    service: "averages-api",
    status: maintenance || down.length ? "degraded" : "ok",
    message: maintenance ? msg || "Averages.io is experiencing degraded performance right now. Some things may be slow or not work." : down.length ? healthMessage(down) : "Everything is working normally.",
    checked: new Date().toISOString(),
    lastHealthCheck: rec && fresh ? new Date(rec.checked).toISOString() : null,
    health,
    ...(Object.keys(downSince).length ? { downSince } : {}),
    configured: (c.env.SESSION_SECRET ?? "").length > 0,
    signIn: {
      schoology: !!consumer && on("schoology-oauth") && (!isSandboxConsumer(consumer) || on("test-signin")),
      schoologyApiKey: on("schoology-signin"),
    },
    connections: {
      canva: canvaConfigured(c.env) && on("canva-integration"),
      googleDrive: !!cloud.google && on("drive-integration"),
      oneDrive: !!cloud.microsoft && on("onedrive-integration"),
    },
    features: {
      fullscreen: fullscreenPublic(c.env) && on("fullscreen"),
      liveGrades: on("live-grades"),
      turnIn: on("turnin-feature"),
      messages: on("messaging-features"),
      notifications: on("notifications-features") && pushConfigured(env),
      calendarSync: on("calendar-sync"),
      averagesPlus: on("billing"),
    },
    links: {
      app: "https://app.averages.io",
      website: "https://averages.io",
      support: "https://averages.io/support",
      docs: "https://github.com/averages-io/averages.api",
    },
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
async function forgetConnections(env: Bindings, uid: string, requestUrl: string, strict = false): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  if (env.CANVA) jobs.push(Promise.resolve().then(() => canvaStore(env, uid, requestUrl).disconnect(uid)));
  if (env.CLOUD) for (const app of CLOUD_APPS) jobs.push(Promise.resolve().then(() => cloudStore(env, uid, requestUrl).disconnect(uid, app, { revokeShared: true })));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.error("signout_forget_failed", r.reason);
  // Delete account: the app must hear that something is still there
  if (strict && results.some((r) => r.status === "rejected")) throw new Error("connections_not_deleted");
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

  if (key === SANDBOX_KEY || secret === SANDBOX_SECRET) return c.json({ error: "invalid_credentials" }, 401);
  const reviewer = reviewSecretsMatch(c.env, key, secret);
  // Sign-in switches (src/flags.ts): the reviewer account and Schoology keys each have their own.
  const signin: FeatureKey = reviewer ? "test-signin" : "schoology-signin";
  if (!featureOn(c.env, signin)) return c.json({ error: "feature_off", feature: signin }, 503);
  if (reviewer) {
    const me = await getMe({ key: SANDBOX_KEY, secret: SANDBOX_SECRET });
    const token = await sealSession({ key: SANDBOX_KEY, secret: SANDBOX_SECRET, uid: REVIEW_UID, p: profileFrom(me) }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(token, COOKIE_DOMAIN));
    c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN, LEGACY_SESSION_COOKIE), { append: true }); // the old name goes too
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
    c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN, LEGACY_SESSION_COOKIE), { append: true }); // the old name goes too
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
    if (await isFacultyAccount(me, { key, secret })) return c.json({ error: "teacher_account" }, 403);

    // Under 13 (the login page's 13+ box left unticked): Incognito only, sealed
    // into the session so nothing stored on our servers can be turned on.
    const under13 = body.under13 === true;
    // The name rides along in the sealed cookie so /auth/me never has to ask Schoology for it.
    const p = profileFrom(me);
    const token = await sealSession(under13 ? { key, secret, uid, inc: true, p } : { key, secret, uid, p }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(token, COOKIE_DOMAIN));
    c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN, LEGACY_SESSION_COOKIE), { append: true }); // the old name goes too

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
      console.error("signin_schoology_refused", error.status, String(error.body ?? "").slice(0, 300));
      if (error.status === 401) return c.json({ error: "invalid_credentials" }, 401);
      if (error.status === 403) return c.json({ error: "schoology_forbidden" }, 401);
      return c.json({ error: "schoology_error", status: error.status }, 502);
    }
    return c.json({ error: "unexpected_error" }, 500);
  }
});

app.delete("/auth/session", async (c) => {
  const session = await sessionFrom(c);
  const forget = c.req.query("forget") === "1";
  if (forget) {
    const foreign = notFromOurApp(c);
    if (foreign) return foreign;
  }
  if (session && !isDemo(session)) c.executionCtx.waitUntil(forgetPush(c.env, session.uid, c.req.url));
  if (session && !isDemo(session)) c.executionCtx.waitUntil(forgetCalendar(c.env as any, session.uid, c.req.url));
  if (forget && session && !isDemo(session)) c.executionCtx.waitUntil(forgetConnections(c.env, session.uid, c.req.url));
  c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN));
  c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN, LEGACY_SESSION_COOKIE), { append: true }); // the old name goes too
  // A Google sign-in's refreshed access token, if any (see googleAccess).
  c.header("Set-Cookie", clearAccessCookie(!isLocalRequest(c.req.url)), { append: true });
  // An older Schoology session's name (see /auth/me).
  c.header("Set-Cookie", clearProfileCookie(!isLocalRequest(c.req.url)), { append: true });
  return c.json({ ok: true });
});

/** Is Sign in with Schoology ready? The sign-in page asks before showing it. */
app.get("/auth/schoology/status", (c) => {
  const consumer = consumerFrom(c.env);
  const sandbox = isSandboxConsumer(consumer);
  const on = !!consumer && featureOn(c.env, "schoology-oauth") && (!sandbox || featureOn(c.env, "test-signin"));
  c.header("Cache-Control", "no-store");
  return c.json({ on });
});

function signinBack(c: any, code: string, detail?: unknown) {
  const status = detail instanceof SchoologyError || detail instanceof OAuthError ? detail.status : undefined;
  const body = detail instanceof SchoologyError ? String(detail.body ?? "").replace(/oauth_[a-z_]+=[^&\s"]+/gi, "oauth_…").slice(0, 160) : undefined;
  console.log(JSON.stringify({ event: "schoology_signin_back", code, ...(status ? { status } : {}), ...(body ? { body } : {}) }));
  return c.redirect(`${appOrigin(c.req.url)}/?signin_error=${encodeURIComponent(code)}#schoology`, 302);
}

/** The sandbox's stand-in for Schoology's token calls (testing without real keys). */
async function sandboxTokens(url: string): Promise<Response> {
  const rand = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const kind = url.endsWith("/request_token") ? "req" : "acc";
  return new Response(`oauth_token=sbx-${kind}-${rand()}&oauth_token_secret=sbx-${kind}-secret-${rand()}`, { status: 200, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
}

app.get("/auth/schoology/start", async (c) => {
  const consumer = consumerFrom(c.env);
  if (!consumer) return signinBack(c, "not_configured");
  const sandbox = isSandboxConsumer(consumer);
  if (!featureOn(c.env, "schoology-oauth") || (sandbox && !featureOn(c.env, "test-signin"))) return signinBack(c, "feature_off");
  if (!c.env.SESSION_SECRET) return signinBack(c, "server_misconfigured");
  const domain = schoolDomain(c.req.query("domain"));
  if (!domain) return signinBack(c, "unknown_school");
  try {
    const req = await requestToken(consumer, sandbox ? (url) => sandboxTokens(url) : undefined);
    const secure = !isLocalRequest(c.req.url);
    const sealed = await sealValue({ t: req.token, s: req.secret, d: domain, u13: c.req.query("under13") === "1" }, c.env.SESSION_SECRET, OAUTH_PURPOSE, OAUTH_TTL_SECONDS);
    c.header("Set-Cookie", pendingCookie(sealed, secure));
    c.header("Cache-Control", "no-store");
    const callback = sandbox ? `${new URL(c.req.url).origin}/auth/schoology/callback` : `${appOrigin(c.req.url)}/auth/schoology/callback`;
    // The sandbox approves on a page of our own (no real Schoology to go to).
    const to = sandbox ? `${new URL(c.req.url).origin}/auth/schoology/sandbox-authorize?oauth_token=${encodeURIComponent(req.token)}&oauth_callback=${encodeURIComponent(callback)}` : authorizeUrl(domain, req.token, callback);
    return c.redirect(to, 302);
  } catch (error) {
    const code = error instanceof OAuthError ? error.code : "schoology_error";
    if (!(error instanceof OAuthError)) console.error("schoology_signin_start_failed", error);
    return signinBack(c, code);
  }
});

/** Testing only: "approves" straight away, like a student clicking Approve on Schoology. */
app.get("/auth/schoology/sandbox-authorize", (c) => {
  if (!isSandboxConsumer(consumerFrom(c.env)) || !featureOn(c.env, "test-signin")) return c.json({ error: "not_found" }, 404);
  const token = c.req.query("oauth_token") ?? "";
  const back = new URL(c.req.url);
  return c.redirect(`${back.origin}/auth/schoology/callback?oauth_token=${encodeURIComponent(token)}`, 302);
});

app.get("/auth/schoology/callback", async (c) => {
  const secure = !isLocalRequest(c.req.url);
  c.header("Set-Cookie", clearPendingCookie(secure), { append: true });
  c.header("Cache-Control", "no-store");
  const consumer = consumerFrom(c.env);
  if (!consumer) return signinBack(c, "not_configured");
  if (!c.env.SESSION_SECRET) return signinBack(c, "server_misconfigured");
  const sandbox = isSandboxConsumer(consumer);
  if (!featureOn(c.env, "schoology-oauth") || (sandbox && !featureOn(c.env, "test-signin"))) return signinBack(c, "feature_off");
  const sealed = readCookie(c.req.header("Cookie") ?? null, OAUTH_COOKIE);
  const pending = sealed ? await openValue(sealed, c.env.SESSION_SECRET, OAUTH_PURPOSE) : null;
  if (!validPending(pending)) return signinBack(c, "expired");
  const token = c.req.query("oauth_token") ?? "";
  // No token back means they said no (or closed it); a different one isn't this browser's sign-in.
  if (!token) return signinBack(c, "denied");
  if (!sameToken(token, pending.t)) return signinBack(c, "expired");
  try {
    const acc = await accessToken(consumer, { token: pending.t, secret: pending.s }, sandbox ? (url) => sandboxTokens(url) : undefined);
    const creds = sandbox
      ? { key: SANDBOX_KEY, secret: SANDBOX_SECRET, token: acc.token, tokenSecret: acc.secret }
      : { key: consumer.key, secret: consumer.secret, token: acc.token, tokenSecret: acc.secret };
    const me = await getMe(creds);
    const uid = sandbox ? REVIEW_UID : String(me.uid ?? me.id ?? "");
    if (!uid) return signinBack(c, "no_user_id");
    if (!sandbox && (await isFacultyAccount(me, creds))) return signinBack(c, "teacher_account");
    const p = profileFrom(me);
    // The access token rides in the sealed session cookie, like a personal key does: never stored on our servers.
    const session = await sealSession({ ...creds, uid, p, sd: pending.d, ...(pending.u13 ? { inc: true as const } : {}) }, c.env.SESSION_SECRET);
    c.header("Set-Cookie", sessionCookie(session, COOKIE_DOMAIN), { append: true });
    c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN, LEGACY_SESSION_COOKIE), { append: true }); // the old name goes too
    console.log(JSON.stringify({ event: "schoology_signin_ok" }));
    return c.redirect(`${appOrigin(c.req.url)}/?signin=schoology#schoology`, 302);
  } catch (error) {
    if (error instanceof OAuthError) return signinBack(c, error.code === "schoology_refused" ? "schoology_refused_token" : error.code, error);
    if (error instanceof SchoologyError) return signinBack(c, error.status === 401 || error.status === 403 ? "schoology_refused_profile" : "schoology_error", error);
    console.error("schoology_signin_callback_failed", error);
    return signinBack(c, "schoology_error");
  }
});

/**
 * A working Google access token for this request. The one sealed at sign-in
 * lasts an hour; after that a refreshed one is kept in its own short-lived
 * cookie (ACCESS_COOKIE, see google.ts), never by rewriting the session
 * cookie, so the session keeps its 15 days from sign-in and signing out can't
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
    c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN, LEGACY_SESSION_COOKIE), { append: true }); // the old name goes too
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
      // The school's ID for the student, for the report card PDF (2026-11-12). "" when the school has none,
      // and for a session sealed before this field existed (it fills in at the next sign-in).
      studentId: p.sid ?? "",
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
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
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

  const now = new Date().toISOString();
  // The seen notifications live beside the settings (sync.ts): a settings save keeps them as they are.
  const kv = syncKV(c.env, session.uid, c.req.url);
  const before = await loadSyncRecord(kv, session.uid);
  const record = {
    settings: body.settings,
    seen: before.seen,
    updatedAt: now,
    // See SyncRecord's own comment in sync.ts for why settings.html's pull
    // logic compares this rather than updatedAt.
    settingsUpdatedAt: now,
  };
  await saveSyncRecord(kv, session.uid, record);
  return c.json(record);
});

app.get("/sync/seen", requireSession, async (c) => {
  const session = c.get("session");
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  if (isIncognito(session)) return c.json({ error: "incognito_mode" }, 403);
  c.header("Cache-Control", "private, no-store");
  const record = await loadSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid);
  return c.json({ seen: record.seen ?? {} });
});
app.post("/sync/seen", requireSession, async (c) => {
  const session = c.get("session");
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  if (isIncognito(session)) return c.json({ error: "incognito_mode" }, 403);
  c.header("Cache-Control", "private, no-store");
  let body: { seen?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const kv = syncKV(c.env, session.uid, c.req.url);
  const record = await loadSyncRecord(kv, session.uid);
  const seen = mergeSeen(record.seen, body && body.seen);
  await saveSyncRecord(kv, session.uid, { ...record, seen });
  return c.json({ seen });
});

app.delete("/sync/settings", requireSession, async (c) => {
  const session = c.get("session");
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
  if (isDemo(session)) {
    return c.json({ error: "not_available_in_demo" }, 403);
  }
  await deleteSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid);
  // The profile photo and background in R2 (src/media.ts) are Sync data too.
  await deleteAllMedia(c.env.MEDIA as unknown as MediaBucket | undefined, session.uid);
  return c.json({ ok: true });
});

async function askSelf(c: any, method: string, path: string): Promise<any> {
  try {
    const headers: Record<string, string> = { cookie: c.req.header("cookie") ?? "" };
    const origin = c.req.header("origin");
    if (origin) headers.origin = origin;
    if (method === "POST") headers["content-type"] = "application/json";
    const r = await app.request(new URL(path, c.req.url).href, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }, c.env, c.executionCtx);
    if (!r.ok) return { unavailable: r.status };
    return await r.json();
  } catch {
    return { unavailable: true };
  }
}
/** A synced settings blob with its pictures named, not copied (they can be megabytes). */
function withoutPictures(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return /^data:image\//.test(value) ? `[picture, ${value.length} characters]` : value;
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => withoutPictures(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = withoutPictures(v, depth + 1);
  return out;
}

app.get("/account/export", requireSession, async (c) => {
  const session = c.get("session");
  c.header("Cache-Control", "private, no-store");
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  const [sync, push, calendar, billing, cloud, canva] = await Promise.all([
    isIncognito(session) ? Promise.resolve(null) : loadSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid).catch(() => ({ unavailable: true })),
    askSelf(c, "POST", "/push/status"),
    askSelf(c, "GET", "/calendar/status"),
    askSelf(c, "GET", "/billing/status"),
    askSelf(c, "GET", "/cloud/status"),
    askSelf(c, "GET", "/canva/status"),
  ]);
  c.header("Content-Disposition", 'attachment; filename="averages-io-data.json"');
  return c.json({
    about: "Everything Averages.io keeps about you, as of exportedAt. Your grades, assignments and files aren't kept by Averages.io: they stay in Schoology.",
    exportedAt: new Date().toISOString(),
    account: { id: session.uid, signIn: session.g ? "Google" : "Schoology", mode: isIncognito(session) ? "Incognito" : "Classic" },
    syncedSettings: sync ? withoutPictures(sync) : null,
    notifications: push,
    calendarLink: calendar,
    plus: billing,
    connectedApps: { googleDriveAndOneDrive: cloud, canva },
  });
});

app.delete("/account", requireSession, async (c) => {
  const session = c.get("session");
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
  c.header("Cache-Control", "private, no-store");
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  const billing = await askSelf(c, "GET", "/billing/status");
  if (billing && billing.plus === true) return c.json({ error: "plus_active", status: billing.status ?? "" }, 409);
  const results = await Promise.allSettled([
    // No SYNC binding (a local setup without it): nothing was ever stored there.
    c.env.SYNC ? deleteSyncRecord(syncKV(c.env, session.uid, c.req.url), session.uid) : Promise.resolve(),
    // strict: each one throws when it couldn't delete, so a partial delete answers delete_incomplete, not ok
    deleteAllMedia(c.env.MEDIA as unknown as MediaBucket | undefined, session.uid, true),
    forgetPush(c.env, session.uid, c.req.url, undefined, true),
    forgetCalendar(c.env as any, session.uid, c.req.url, undefined, true),
    forgetConnections(c.env, session.uid, c.req.url, true),
  ]);
  const failed = results.filter((r) => r.status === "rejected").length;
  for (const r of results) if (r.status === "rejected") console.error("account_delete_failed", r.reason);
  if (failed) return c.json({ error: "delete_incomplete", failed }, 502);
  c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN));
  c.header("Set-Cookie", clearSessionCookie(COOKIE_DOMAIN, LEGACY_SESSION_COOKIE), { append: true }); // the old name goes too
  c.header("Set-Cookie", clearAccessCookie(!isLocalRequest(c.req.url)), { append: true });
  c.header("Set-Cookie", clearProfileCookie(!isLocalRequest(c.req.url)), { append: true });
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
/** The class ids adaptCourses makes COURSES from, in the same order (section.id, else section_id; blanks skipped). */
export function sectionIds(sections: unknown): string[] {
  const out: string[] = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    const id = String((section as any)?.id ?? (section as any)?.section_id ?? "");
    if (id) out.push(id);
  }
  return out;
}

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
    // Assignments are per-section, so this fans out. Capped and failure-
    // tolerant: one section erroring (a teacher restricting access, say)
    // must not take down the whole payload. It starts as soon as the class
    // list is in, without waiting for grades, the inbox and the names
    // (the same first 12 classes adaptCourses keeps, in Schoology's order).
    const assignmentsBySection: Record<string, any[]> = {};
    const sectionsP = getSections(session.uid, session);
    const assignmentsP = sectionsP.then((list) =>
      Promise.all(
        sectionIds(list).slice(0, 12).map(async (id) => {
          try {
            const [items, discussions] = await Promise.all([
              getAssignments(id, session),
              getDiscussions(id, session).catch(() => []),
            ]);
            assignmentsBySection[id] = items.concat(discussionsAsWork(discussions));
          } catch (error) {
            console.error("bundle_assignments_failed", error instanceof SchoologyError ? error.status : "", error instanceof SchoologyError ? String(error.body ?? "").slice(0, 160) : String(error).slice(0, 160));
            assignmentsBySection[id] = [];
          }
        })
      )
    );
    assignmentsP.catch(() => {});
    const [sections, grades, inbox, recipients] = await Promise.all([
      sectionsP,
      getGrades(session.uid, session),
      getMessages("inbox", session).catch(() => null),
      getRecipients(session).catch(() => null),
    ]);

    const { COURSES, HISTORY } = adaptCourses(sections, grades);
    await assignmentsP;

    const { OVERDUE, UPCOMING, TODAY } = adaptAssignments(assignmentsBySection, studentTimeZone(c));
    try {
      freshenUpdated(COURSES, grades, assignmentsBySection);
    } catch {
      /* the grade time stays */
    }
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

    // ?since=<fp>: { unchanged: true } when nothing changed (src/fingerprint.ts)
    return answerUnlessSame(c, {
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
  const token = sessionToken(c.req.header("Cookie") ?? null);
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
    const discussion = c.req.query("type") === "discussion";
    const [raw, gradeSections] = await Promise.all([
      discussion ? getDiscussion(section, id, session).then((d) => discussionsAsWork([d])[0] ?? { ...d, type: "discussion" }) : getAssignment(section, id, session),
      getSectionGrades(session.uid, section, session).catch(() => null),
    ]);
    c.header("Cache-Control", "private, no-store");
    let score: { earned: number; possible: number } | null = null;
    try {
      score = gradeSections ? assignmentScore(gradeSections, section, id) ?? (raw?.grade_item_id ? assignmentScore(gradeSections, section, String(raw.grade_item_id)) : null) : null;
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
  const documentId = c.req.query("document") ?? "";
  const parentOk = (ID_RE.test(assignment) && documentId === "") || (ID_RE.test(documentId) && assignment === "");
  if (!ID_RE.test(section) || !ID_RE.test(fileId) || !parentOk) {
    return c.json({ error: "bad_request" }, 400);
  }
  try {
    const parent = assignment ? await getAssignment(section, assignment, session) : await getDocument(section, documentId, session);
    const file = findAttachment(parent, fileId);
    if (!file || !file.downloadPath) return c.json({ error: "file_not_found" }, 404);
    if (c.req.query("as") === "pdf") return await previewResponse(file, session);
    const upstream = await openAttachment(file.downloadPath, session);
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

app.get("/messages/file", async (c) => {
  const session = await sessionFrom(c);
  if (!session) return c.json({ error: "not_authenticated" }, 401);
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  if (isGoogle(session)) return c.json({ error: "not_available" }, 404);
  const thread = c.req.query("thread") ?? "";
  const fileId = c.req.query("file") ?? "";
  if (!ID_RE.test(thread) || !ID_RE.test(fileId)) return c.json({ error: "bad_request" }, 400);
  try {
    const rows = await getThread(thread, session, { keepUnread: true });
    const file = rows ? findMessageFile(rows, fileId) : null;
    if (!file) return c.json({ error: "file_not_found" }, 404);
    const upstream = await openAttachment(file.downloadPath, session);
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

/**
 * `?as=pdf`: Schoology's PDF copy of the file (pdfPreviewPath in adapt.ts), shown inline under the
 * file's own name with ".pdf", so the Files page can draw a Word, PowerPoint or Excel file's first
 * page. 404 no_preview when Schoology has no copy.
 */
async function previewResponse(file: { name: string; previewPath: string }, session: SessionData): Promise<Response> {
  if (!file.previewPath) return Response.json({ error: "no_preview" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  const upstream = await openAttachment(file.previewPath, session);
  const base = file.name.replace(/\.[a-z0-9]{1,8}$/i, "") || "Preview";
  return viewResponse(upstream, `${base}.pdf`)!;
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
        const [documents, assignments, root] = await Promise.all([
          getDocuments(course.id, session).catch(() => null),
          getAssignmentsWithAttachments(course.id, session).catch(() => null),
          getFolder(course.id, "0", session).catch(() => null),
        ]);
        bySection[course.id] = { documents, assignments };
        if (root) for (const f of parseFolder(root).folders) folders.push({ ...f, course: course.id });
      }
    };
    const folders: { id: string; title: string; color: string; course: string }[] = [];
    await Promise.all(Array.from({ length: Math.min(4, courses.length) }, worker));
    const { files, partial } = adaptCourseFiles(bySection);
    return c.json({ courses, files, folders, partial });
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

app.get("/data/submissions", async (c) => {
  const session = await sessionFrom(c);
  if (!session) return c.json({ error: "not_authenticated" }, 401);
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  c.header("Cache-Control", "private, no-store");
  if (isGoogle(session)) return c.json({ platform: "classroom", courses: [], files: [], partial: false });
  const forList = c.req.query("for");
  if (typeof forList === "string") {
    const pairs = [...new Set(forList.split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 15)
      .map((x) => x.split(":")).filter((p) => p.length === 2 && ID_RE.test(p[0]) && ID_RE.test(p[1]));
    const found: SubmittedFile[] = [];
    let partial = false;
    await eachAtMost(pairs, 5, async ([course, id]) => {
      try {
        found.push(...submittedFiles(await getHistory(session, course, id, session.uid), session.uid, { course, id, title: "" }));
      } catch (error) {
        if (error instanceof SchoologyError && error.status === 404) return;
        partial = true;
      }
    });
    const { files, cut } = newestSubmittedFiles(found);
    return c.json({ platform: "schoology", courses: [], files, partial: partial || cut });
  }
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
    if (c.req.query("as") === "pdf") return await previewResponse(file, session);
    const upstream = await openAttachment(file.downloadPath, session);
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

app.get("/config/schools", (c) => {
  const schools = schoolsFor(c.req.query("lms"));
  if (!schools) return c.json({ error: "bad_request" }, 400);
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ schools });
});

app.get("/config/cloud", (c) => {
  c.header("Cache-Control", "public, max-age=60");
  const cfg = cloudConfig(c.env);
  // A switched-off integration looks unconfigured to older pages too.
  if (!featureOn(c.env, "drive-integration")) cfg.google = null;
  if (!featureOn(c.env, "onedrive-integration")) cfg.microsoft = null;
  return c.json(cfg);
});

/**
 * Who sees Fullscreen while FULLSCREEN_PUBLIC is "0": students signed in through the app.schoology.com sandbox/dev
 * school, and API-key sign-ins (testers and the reviewer account). Not demo.
 */
export function fullscreenTester(session: SessionData | null, extra = ""): boolean {
  if (!session || isDemo(session) || session.g) return false;
  // Sign-ins from before the school was kept in the session (no `sd`) all came through the app.schoology.com
  // install, the only school Sign in with Schoology works for so far: they count as testers until they sign in again.
  if (typeof session.sd !== "string") return true;
  const testers = ["app.schoology.com", "www.schoology.com", "schoology.com", ...String(extra).split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)];
  return testers.includes(session.sd.toLowerCase());
}
export function fullscreenPublic(env: { FULLSCREEN_PUBLIC?: string }): boolean {
  return String(env.FULLSCREEN_PUBLIC ?? "1").trim() !== "0";
}

app.get("/config/features", async (c) => {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, featureOn(c.env, k)])) as Features;
  const everyone = !plusRequired(c.env as any);
  if (everyone) for (const k of FEATURE_KEYS) if (!features[k] && earlyKey(c.env, k)) features[k] = true;
  const msg = typeof c.env.MAINTENANCE_MESSAGE === "string" ? c.env.MAINTENANCE_MESSAGE.trim().slice(0, 300) : "";
  // the switch's message wins; else what the 15-minute check found down (src/health.ts)
  const auto = featureOn(c.env, "maintenance-banner") ? "" : healthMessage(downNow(await readHealth(c.env as any, isLocalRequest(c.req.url)), Date.now()));
  // Fullscreen only for testers until FULLSCREEN_PUBLIC is "1": then the answer depends on who's asking.
  const perStudent = !fullscreenPublic(c.env) && features.fullscreen;
  if (perStudent) features.fullscreen = fullscreenTester(await sessionFrom(c), c.env.FULLSCREEN_SCHOOLS ?? "");
  c.header("Cache-Control", perStudent ? "private, no-store" : "public, max-age=30");
  if (perStudent) c.header("Vary", "Cookie");
  return c.json({
    features,
    early: FEATURE_KEYS.filter((k) => !features[k] && earlyKey(c.env, k)),
    maintenance: featureOn(c.env, "maintenance-banner") ? { message: msg || "Averages.io is experiencing degraded performance right now. Some things may be slow or not work." } : auto ? { message: auto, automatic: true } : null,
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
    let turnIn: "off" | "ready" | "reconnect" = "off";
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
  const store = canvaStore(c.env, session.uid, c.req.url);
  const state = c.req.query("state") ?? "";
  const startedFrom = (consume = false) => store.connectReturn(state, consume).catch(() => "/settings");
  if (c.req.query("error")) return c.redirect(`${origin}${withQuery(await startedFrom(true), "canva", "cancelled")}`);
  const back = await startedFrom();
  try {
    const returnTo = await store.finishConnect(session.uid, state, c.req.query("code") ?? "");
    return c.redirect(`${origin}${withQuery(safeAppPath(returnTo, "/settings"), "canva", "connected")}`);
  } catch (error) {
    errorCode(error, "canva_callback_failed");
    return c.redirect(`${origin}${withQuery(back, "canva", "failed")}`);
  }
});

/** Disconnect: forgets the tokens and the drafts list. Designs stay in the student's Canva. */
app.delete("/canva/connection", requireSession, async (c) => {
  if (isDemo(c.get("session"))) return c.json({ error: "not_available_in_demo" }, 403);
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
  try {
    await canvaStore(c.env, c.get("session").uid, c.req.url).disconnect(c.get("session").uid);
    return c.json({ ok: true });
  } catch (error) {
    return canvaFailure(c, error, "canva_disconnect_failed");
  }
});

app.post("/canva/probe", requireSession, async (c) => {
  c.header("Cache-Control", "no-store");
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
      // works too. It must be listed with Google / Microsoft (see DEVELOPMENT.md).
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
 * A Google file over Drive's 10 MB export limit, as Word, Excel, PowerPoint, PDF or CSV (src/driveExport.ts).
 * GET /cloud/gdrive/export/:id?as=docx. Streamed through with the student's own Drive token, never stored.
 */
app.get("/cloud/gdrive/export/:id", requireSession, async (c) => {
  const session = c.get("session");
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  const foreign = notFromOurApp(c);
  if (foreign) return foreign;
  c.header("Cache-Control", "no-store");
  if (isIncognito(session)) return c.json({ error: "incognito_mode" }, 403);
  if (!cloudConfigured(c.env, "gdrive")) return c.json({ error: "cloud_not_configured" }, 503);
  const id = c.req.param("id");
  const as = c.req.query("as") ?? "";
  if (!DRIVE_FILE_ID_RE.test(id) || !isDriveExportType(as)) return c.json({ error: "bad_request" }, 400);
  let token: string;
  try {
    token = (await cloudStore(c.env, session.uid, c.req.url).accessToken(session.uid, "gdrive", {})).access_token;
  } catch (error) {
    return cloudFailure(c, error, "cloud_unavailable");
  }
  try {
    const file = await openDriveExport(token, id, as);
    const headers = new Headers({
      "Content-Type": file.type,
      "Content-Disposition": contentDisposition(file.name),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Expose-Headers": "Content-Disposition",
    });
    if (file.length !== null) headers.set("Content-Length", String(file.length));
    return new Response(file.length !== null ? file.body : file.body.pipeThrough(capStream(95 * 1024 * 1024)), { status: 200, headers });
  } catch (error) {
    if (error instanceof DriveExportError) {
      console.error("drive_export_failed", error.code, error.trace);
      return c.json({ error: error.code }, error.status as any);
    }
    console.error("drive_export_failed", error instanceof Error ? error.name : "unknown");
    return c.json({ error: "cloud_download_failed" }, 502);
  }
});

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

const extrasDeps = { requireSession, fromOurApp: notFromOurApp, googleAccess, classroomFailure, studentTimeZone };

/** GET /data/people, /data/updates, /data/events, /data/folders, /data/gradebook (src/extrasRoutes.ts). */
app.route("/data", dataExtrasRoutes(extrasDeps));

/** GET /messages, /messages/thread, /messages/recipients; POST /messages, /messages/reply. Schoology only. */
app.route("/messages", messagesRoutes(extrasDeps));

app.post("/email/code", requireSession, async (c) => {
  const session = c.get("session");
  c.header("Cache-Control", "no-store");
  if (isDemo(session)) return c.json({ error: "not_available_in_demo" }, 403);
  if (session.inc) return c.json({ error: "not_in_incognito" }, 403);
  if (!c.env.SESSION_SECRET) return c.json({ error: "server_misconfigured" }, 500);
  const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
  const email = cleanEmail(body?.email);
  if (!email) return c.json({ error: "bad_email" }, 400);
  if (!c.env.EMAIL) return c.json({ error: "email_not_configured" }, 503);
  const code = newCode();
  const { subject, text, html } = codeMessage(code);
  try {
    await c.env.EMAIL.send({ to: email, from: { email: c.env.EMAIL_FROM || DEFAULT_EMAIL_FROM, name: "Averages.io" }, subject, text, html });
  } catch (err) {
    const f = sendFailure(err);
    console.error(JSON.stringify({ event: "email_code_failed", code: String((err as { code?: unknown })?.code ?? "") }));
    return c.json({ error: f.error }, f.status);
  }
  const token = await sealValue({ u: session.uid, e: email, h: await codeHash(c.env.SESSION_SECRET, session.uid, email, code) }, c.env.SESSION_SECRET, EMAIL_CODE_PURPOSE, EMAIL_CODE_TTL);
  return c.json({ ok: true, token, expiresIn: EMAIL_CODE_TTL });
});
app.post("/email/verify", requireSession, async (c) => {
  const session = c.get("session");
  c.header("Cache-Control", "no-store");
  if (isDemo(session) || session.inc) return c.json({ error: "not_available" }, 403);
  const body = (await c.req.json().catch(() => null)) as { email?: unknown; code?: unknown; token?: unknown } | null;
  const email = cleanEmail(body?.email), code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!email || !/^\d{6}$/.test(code) || typeof body?.token !== "string" || body.token.length > 2048) return c.json({ error: "bad_request" }, 400);
  const sealed = (await openValue(body.token, c.env.SESSION_SECRET, EMAIL_CODE_PURPOSE)) as { u?: string; e?: string; h?: string } | null;
  // run out, or for someone else, or for another address: ask for a new code
  if (!sealed || sealed.u !== session.uid || sealed.e !== email || typeof sealed.h !== "string") return c.json({ error: "code_expired" }, 400);
  if (!sameHash(sealed.h, await codeHash(c.env.SESSION_SECRET, session.uid, email, code))) return c.json({ error: "wrong_code" }, 400);
  return c.json({ ok: true, email });
});

app.get("/links/preview", requireSession, async (c) => {
  c.header("Cache-Control", "private, max-age=3600");
  const target = parseTarget(c.req.query("url"));
  if (!target) return c.json({ error: "bad_request" }, 400);
  return c.json(await getLinkPreview(target));
});
app.get("/links/image", requireSession, async (c) => {
  const target = parseTarget(c.req.query("url"));
  if (!target) return c.json({ error: "bad_request" }, 400);
  try {
    const res = await getLinkImage(target);
    return res ?? c.json({ error: "not_an_image" }, 404);
  } catch {
    return c.json({ error: "not_available" }, 502);
  }
});

/** Browser notifications (src/push.ts). */
app.route("/push", pushRoutes({ requireSession, fromOurApp: notFromOurApp }));

// Plus ended: notifications and the calendar link are deleted (src/plus.ts).
async function onPlusEnded(env: any, uid: string, requestUrl: string): Promise<void> {
  if (!plusRequired(env)) return;
  await forgetPush(env, uid, requestUrl);
  await forgetCalendar(env, uid, requestUrl);
}
app.route("/billing", billingRoutes({ requireSession, fromOurApp: notFromOurApp, appOrigin, storeFor: billingStore, onPlusEnded }) as any);
app.route("/stripe", stripeWebhookRoutes({ storeFor: billingStore, onPlusEnded }) as any);

/** Calendar sync, an Averages Plus perk (src/calendar.ts). */
app.route("/calendar", calendarRoutes({ requireSession, fromOurApp: notFromOurApp }) as any);

/** Profile photo and background for Sync Across Devices, in R2 (src/media.ts). */
app.route("/media", mediaRoutes({ requireSession, fromOurApp: notFromOurApp }) as any);

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

/**
 * The Worker: HTTP through Hono. Tests call `app.fetch` on this object
 * exactly as they did on the Hono app.
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
  queue: async (batch: MessageBatch<unknown>, env: Bindings) => handleRetryBatch(batch, retryHandlers(env)),
  // Every 15 minutes (wrangler.jsonc triggers): the automatic outage check (src/health.ts)
  scheduled: async (_event: unknown, env: Bindings, ctx: ExecutionContext) => { ctx.waitUntil(checkHealth(await withFlags(env))); },
};

/** One round of the outage check, kept in HealthStore. Never throws. */
export async function checkHealth(env: Bindings, fetcher?: (url: string, init?: RequestInit) => Promise<Response>): Promise<void> {
  try {
    const on = (k: FeatureKey) => featureOn(env, k);
    const us = (ns: any) => { try { return typeof ns?.jurisdiction === "function" ? ns.jurisdiction("us") : ns; } catch { return ns; } };
    const stub = (ns: any, name: string) => { const n = us(ns); return n.get(n.idFromName(name)); };
    const consumer = consumerFrom(env);
    const cloud = cloudConfig(env);
    const services = await runChecks({
      fetcher,
      signin: consumer && on("schoology-oauth") && !isSandboxConsumer(consumer)
        ? () => requestToken(consumer, fetcher ?? fetch).then((): HealthAnswer => "ok", (): HealthAnswer => "down")
        : null,
      // our own pieces each read a test record that holds nothing ("health-check" is never a student)
      sync: env.SYNC ? () => stub(env.SYNC, "health-check").getRecord("health") : null,
      notifications: (env as any).PUSH ? () => stub((env as any).PUSH, "health-check").status() : null,
      calendar: (env as any).CALENDAR ? () => stub((env as any).CALENDAR, "health-check").read() : null,
      pictures: (env as any).MEDIA ? () => (env as any).MEDIA.list({ prefix: "health/", limit: 1 }) : null,
      canva: canvaConfigured(env) && on("canva-integration"),
      gdrive: !!cloud.google && on("drive-integration"),
      onedrive: !!cloud.microsoft && on("onedrive-integration"),
    });
    const store = healthStore(env as any, false);
    if (!store) return;
    const prev = await store.read().catch(() => null);
    const rec = nextRecord(prev, services, Date.now());
    await store.write(rec);
    const down = Object.entries(services).filter(([, v]) => v === "down").map(([k]) => k);
    if (down.length) console.error("health_down", down.join(","));
  } catch (err) {
    console.error("health_check_failed", err instanceof Error ? err.message : String(err));
  }
}

