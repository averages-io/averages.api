/**
 * Sign in with Google, for schools on Google Classroom (2026-10-05).
 *
 * A normal server-side OAuth sign-in: the browser is sent to Google's consent
 * screen, Google sends it back to GET /auth/google/callback with a one-time
 * code, and this Worker trades the code (with the client secret, which never
 * leaves the Worker) for the student's tokens. The tokens are then sealed into
 * the same encrypted, httpOnly session cookie as a Schoology sign-in. Nothing
 * about the student is stored on our servers (Privacy Policy, "Google").
 *
 * Read-only Classroom permissions only. Google lets the student untick
 * permissions on the consent screen, so the callback checks what was actually
 * granted: classes and coursework are required, the rest just switch their
 * feature off. A student who signed in before an optional permission was
 * added (rosters and topics, 2026-10-06) keeps the letters sealed at their
 * sign-in until they sign in again.
 *
 * The browser never sees a Google token: Classroom calls happen here, in
 * classroom.ts, the same way Schoology calls do.
 */

import { GOOGLE_UID_PREFIX, type GoogleSession } from "./session.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPE_BASE = "https://www.googleapis.com/auth/";

/**
 * The Classroom permissions Averages.io asks for, by the one letter the
 * session keeps for each (the full URLs would make the cookie much bigger).
 * All read-only. They must also be listed on the consent screen in Google
 * Cloud (Data Access).
 */
export const CLASSROOM_SCOPES = {
  /** Class names. Required. */
  c: SCOPE_BASE + "classroom.courses.readonly",
  /** The student's own coursework, submissions and grades. Required. */
  w: SCOPE_BASE + "classroom.coursework.me.readonly",
  /** Class materials (Files page). */
  m: SCOPE_BASE + "classroom.courseworkmaterials.readonly",
  /** Class announcements (Home's messages). */
  a: SCOPE_BASE + "classroom.announcements.readonly",
  /**
   * Class rosters, for the teachers' names (Contacts, the course cards,
   * GET /data/people). Optional, added 2026-10-06: without it those just
   * stay empty and the app says the permission is needed. Averages.io only
   * reads each class's teachers, never the student list.
   */
  r: SCOPE_BASE + "classroom.rosters.readonly",
  /** Class topics, shown as folders in Materials (GET /data/folders). Optional, added 2026-10-06. */
  t: SCOPE_BASE + "classroom.topics.readonly",
} as const;

export type ScopeLetter = keyof typeof CLASSROOM_SCOPES;

/** Without these there's nothing to show, so sign-in stops and says why. */
export const REQUIRED_SCOPES: ScopeLetter[] = ["c", "w"];

/** Who's signed in: name, email and picture (OpenID Connect's basic profile). */
const PROFILE_SCOPES = ["openid", "email", "profile"];

/** How long the sign-in may take between leaving for Google and coming back. */
export const STATE_TTL_SECONDS = 10 * 60;
/** The short-lived cookie that carries the sign-in's state and PKCE verifier. */
export const STATE_COOKIE = "averages_google_signin";
/** sealValue purpose for that cookie (a different key from session cookies). */
export const STATE_PURPOSE = "google-signin-state";

const GOOGLE_CLIENT_ID_RE = /^\d{6,20}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;
/** The base64url strings we hand out as state / PKCE verifier. */
export const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9_-]{64}$/;

export type GoogleEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
};

export class GoogleError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = "GoogleError";
    this.code = code;
  }
}

/** The sign-in's settings, or null when something is missing (the button then says it's unavailable). */
export function googleConfig(env: GoogleEnv): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? "").trim();
  const redirectUri = (env.GOOGLE_REDIRECT_URI ?? "").trim();
  if (!GOOGLE_CLIENT_ID_RE.test(clientId) || !clientSecret) return null;
  // Only our own callback (or a local one under `wrangler dev`).
  if (!/^https:\/\/api\.averages\.io\/auth\/google\/callback$|^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/auth\/google\/callback$/.test(redirectUri)) return null;
  return { clientId, clientSecret, redirectUri };
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `bytes` random bytes as base64url (32 bytes -> 43 characters, 48 -> 64). */
export function randomToken(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** What the state cookie holds. */
export interface SignInState {
  state: string;
  verifier: string;
  under13: boolean;
}

export function validSignInState(value: unknown): value is SignInState {
  const v = value as SignInState;
  return !!v && typeof v === "object" && STATE_RE.test(String(v.state)) && VERIFIER_RE.test(String(v.verifier)) && typeof v.under13 === "boolean";
}

export function newSignInState(under13: boolean): SignInState {
  return { state: randomToken(32), verifier: randomToken(48), under13 };
}

/** Google's consent screen for this sign-in. */
export async function authorizationUrl(config: { clientId: string; redirectUri: string }, s: SignInState): Promise<string> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: [...PROFILE_SCOPES, ...Object.values(CLASSROOM_SCOPES)].join(" "),
    // A refresh token, so the 30-day session keeps working after the first
    // hour. Google only hands one out when the consent screen is shown, hence
    // "consent"; "select_account" lets a shared Chromebook pick the right student.
    access_type: "offline",
    prompt: "consent select_account",
    state: s.state,
    code_challenge: await codeChallenge(s.verifier),
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** The letters of the Classroom permissions in a token response's space-separated `scope`. */
export function grantedLetters(scope: unknown): string {
  const granted = new Set(String(scope ?? "").split(/\s+/).filter(Boolean));
  return (Object.keys(CLASSROOM_SCOPES) as ScopeLetter[]).filter((k) => granted.has(CLASSROOM_SCOPES[k])).join("");
}

export function hasRequiredScopes(letters: string): boolean {
  return REQUIRED_SCOPES.every((k) => letters.includes(k));
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new GoogleError("google_unreachable");
  }
  const data: any = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== "object") {
    // invalid_grant: the code was used already or expired, or (refresh) the
    // student removed Averages.io's access in their Google account.
    if (data?.error === "invalid_grant") throw new GoogleError("google_invalid_grant");
    throw new GoogleError("google_token_failed");
  }
  return data;
}

export interface CodeExchange {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  letters: string;
  idToken: string;
}

/** Trades the callback's one-time code for tokens. */
export async function exchangeCode(config: { clientId: string; clientSecret: string; redirectUri: string }, code: string, verifier: string): Promise<CodeExchange> {
  const data = await tokenRequest({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) throw new GoogleError("google_token_failed");
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
    expiresAt: nowSeconds() + clampExpiry(data.expires_in),
    letters: grantedLetters(data.scope),
    idToken: typeof data.id_token === "string" ? data.id_token : "",
  };
}

/** A new access token for the session's refresh token. */
export async function refreshAccessToken(config: { clientId: string; clientSecret: string }, refreshToken: string): Promise<{ accessToken: string; expiresAt: number; letters: string | null }> {
  const data = await tokenRequest({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) throw new GoogleError("google_token_failed");
  return {
    accessToken,
    expiresAt: nowSeconds() + clampExpiry(data.expires_in),
    // A refresh reports the permissions still granted; null when it doesn't say.
    letters: typeof data.scope === "string" ? grantedLetters(data.scope) : null,
  };
}

function clampExpiry(value: unknown): number {
  const n = Number(value);
  // Google says 3599. Anything odd: assume 5 minutes, so it's refreshed early rather than late.
  return Number.isFinite(n) && n > 60 ? Math.min(n, 24 * 60 * 60) : 300;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function b64urlDecodeText(part: string): string {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

export interface IdClaims {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

/**
 * The student's Google account id, name, email and picture from the ID token.
 *
 * The token came straight from Google's token endpoint over HTTPS, in answer to
 * our own client secret, so (as OpenID Connect allows for exactly this case)
 * its signature isn't re-checked; issuer, audience and expiry still are.
 */
export function idTokenClaims(idToken: string, clientId: string): IdClaims | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const claims = JSON.parse(b64urlDecodeText(parts[1]));
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) return null;
    if (typeof claims.exp !== "number" || claims.exp < nowSeconds() - 300) return null;
    const sub = String(claims.sub ?? "");
    if (!/^[0-9]{1,255}$/.test(sub)) return null;
    const text = (v: unknown, max: number) => Array.from(typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "").slice(0, max).join("");
    const picture = typeof claims.picture === "string" && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(claims.picture) ? claims.picture.slice(0, 300) : "";
    return { sub, email: text(claims.email, 254), name: text(claims.name, 120), picture };
  } catch {
    return null;
  }
}

/** The sealed-session part of a Google sign-in. */
export function googleSessionFrom(exchange: CodeExchange, claims: IdClaims): { uid: string; g: GoogleSession } {
  return {
    uid: GOOGLE_UID_PREFIX + claims.sub,
    g: {
      at: exchange.accessToken,
      rt: exchange.refreshToken,
      ax: exchange.expiresAt,
      sc: exchange.letters,
      name: claims.name,
      email: claims.email,
      pic: claims.picture,
    },
  };
}

/** The state cookie: host-only on api.averages.io, only sent to /auth/google, gone after 10 minutes. */
export function stateCookie(value: string, secure: boolean): string {
  return [`${STATE_COOKIE}=${value}`, "Path=/auth/google", "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax", `Max-Age=${STATE_TTL_SECONDS}`].join("; ");
}

export function clearStateCookie(secure: boolean): string {
  return [`${STATE_COOKIE}=`, "Path=/auth/google", "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax", "Max-Age=0"].join("; ");
}

/**
 * A refreshed access token rides in its own short-lived cookie (sealed,
 * httpOnly, host-only on api.averages.io) instead of rewriting the session
 * cookie. So a data request still refreshing when the student signs out can't
 * put the session back: without the session cookie this one is useless, and
 * it's tied to the session it was made for (second-pass review, 2026-10-05).
 */
export const ACCESS_COOKIE = "averages_google_access";
export const ACCESS_PURPOSE = "google-access-token";

export interface CachedAccess {
  /** The session's uid and expiry, so it only ever works for that session. */
  uid: string;
  exp: number;
  at: string;
  ax: number;
}

export function validCachedAccess(value: unknown, uid: string, exp: number): value is CachedAccess {
  const v = value as CachedAccess;
  return !!v && typeof v === "object" && v.uid === uid && v.exp === exp && typeof v.at === "string" && v.at.length > 0 && typeof v.ax === "number";
}

export function accessCookie(value: string, maxAge: number, secure: boolean): string {
  return [`${ACCESS_COOKIE}=${value}`, "Path=/", "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax", `Max-Age=${Math.max(0, Math.floor(maxAge))}`].join("; ");
}

export function clearAccessCookie(secure: boolean): string {
  return [`${ACCESS_COOKIE}=`, "Path=/", "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax", "Max-Age=0"].join("; ");
}

/** Constant-time string comparison for the state check. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
