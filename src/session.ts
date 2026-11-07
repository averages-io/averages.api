// Stateless encrypted sessions.

import { REVIEW_UID, SANDBOX_KEY, SANDBOX_SECRET } from "./reviewSandbox.ts";
import type { Credentials } from "./oauth.ts";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 15; // 15 days
/** Sessions sealed while sign-ins lasted 30 days carry no `v`. */
const OLD_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Stamped on every session sealed since the change to 15 days. */
const SESSION_VERSION = 2;

export interface SessionData extends Credentials {
  /** Schoology user id resolved at login, so /users/{id}/... calls need no extra round trip. */
  uid: string;
  /** Unix seconds. Checked on every request. */
  exp: number;
  /** 2 = sealed with the 15-day lifetime. Missing on older (30-day) sessions. */
  v?: number;
  inc?: true;
  /** The school's Schoology address signed in through (Sign in with Schoology only). */
  sd?: string;
  g?: GoogleSession;
  p?: SessionProfile;
}

/** n: display name, f: first name, em: email, pic: photo link. */
export interface SessionProfile {
  n: string;
  f: string;
  em?: string;
  pic?: string;
}

/** Caps so a strange profile can never push the cookie past what browsers keep (~4 KB). */
const PROFILE_TEXT_MAX = 200;
const PROFILE_PIC_MAX = 600;

/** The profile to seal, from Schoology's /users/me. */
export function profileFrom(me: {
  name_display?: string;
  name_first?: string;
  primary_email?: string;
  picture_url?: string;
}): SessionProfile {
  const text = (v: unknown) => (typeof v === "string" ? v.slice(0, PROFILE_TEXT_MAX) : "");
  const p: SessionProfile = { n: text(me.name_display) || text(me.name_first) || "Student", f: text(me.name_first) };
  const em = text(me.primary_email);
  if (em) p.em = em;
  const pic = typeof me.picture_url === "string" ? me.picture_url : "";
  if (pic && pic.length <= PROFILE_PIC_MAX && /^https:\/\//.test(pic)) p.pic = pic;
  return p;
}

export function validProfile(p: unknown): p is SessionProfile {
  if (!p || typeof p !== "object") return false;
  const v = p as Record<string, unknown>;
  const str = (x: unknown, max: number) => typeof x === "string" && x.length <= max;
  return (
    str(v.n, PROFILE_TEXT_MAX) && (v.n as string).length > 0 &&
    str(v.f, PROFILE_TEXT_MAX) &&
    (v.em === undefined || str(v.em, PROFILE_TEXT_MAX)) &&
    (v.pic === undefined || str(v.pic, PROFILE_PIC_MAX))
  );
}

export interface GoogleSession {
  /** Access token (about an hour). */
  at: string;
  /** Refresh token, for a new access token when that one runs out. */
  rt: string;
  /** When `at` expires, unix seconds. */
  ax: number;
  /** Which optional Classroom permissions the student granted (letters, see google.ts SCOPES). */
  sc: string;
  name: string;
  email: string;
  pic: string;
}

/** The prefix that keeps Google account ids apart from Schoology's numeric ones. */
export const GOOGLE_UID_PREFIX = "g:";

export function isGoogleSession(session: { g?: unknown; uid?: unknown }): boolean {
  return !!session.g && typeof session.uid === "string" && session.uid.startsWith(GOOGLE_UID_PREFIX);
}

function validGoogle(g: any): g is GoogleSession {
  return (
    !!g &&
    typeof g === "object" &&
    typeof g.at === "string" && g.at.length > 0 &&
    typeof g.rt === "string" && g.rt.length > 0 &&
    typeof g.ax === "number" &&
    typeof g.sc === "string" &&
    typeof g.name === "string" &&
    typeof g.email === "string" &&
    typeof g.pic === "string"
  );
}

/**
 * The uid that marks a sample-data demo session rather than a real Schoology
 * login.
 *
 * It lives here, next to sealing and opening, because those two are the only
 * places that decide what a valid session looks like — and a demo session is
 * valid in a different shape from a real one (see `openSession`). Keeping the
 * constant in the route file instead meant this file couldn't recognise a demo
 * session at all, which is exactly how it came to reject every one of them.
 */
export const DEMO_UID = "__demo__";

export function isDemoSession(session: { uid: string }): boolean {
  return session.uid === DEMO_UID;
}

/** True for a session signed in as under 13 (Incognito only). */
export function isIncognitoSession(session: { inc?: unknown }): boolean {
  return session.inc === true;
}

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Derives a stable AES key from the Worker secret. */
async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealSession(
  data: Omit<SessionData, "exp">,
  secret: string
): Promise<string> {
  return seal({ ...data, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS, v: SESSION_VERSION } as SessionData, secret);
}

async function seal(payload: SessionData, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

async function purposeKey(secret: string, purpose: string): Promise<CryptoKey> {
  return aesKey(`${purpose}\u0000${secret}`);
}

export async function sealValue(value: unknown, secret: string, purpose: string, ttlSeconds: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await purposeKey(secret, purpose);
  const payload = JSON.stringify({ v: value, x: Math.floor(Date.now() / 1000) + ttlSeconds });
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(payload));
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

/** The value sealed by sealValue for this purpose, or null (wrong purpose, tampered, expired, malformed). */
export async function openValue(token: string, secret: string, purpose: string): Promise<unknown> {
  try {
    const [ivPart, dataPart] = token.split(".");
    if (!ivPart || !dataPart) return null;
    const key = await purposeKey(secret, purpose);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(ivPart) }, key, b64urlDecode(dataPart));
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    if (!data || typeof data.x !== "number" || data.x < Math.floor(Date.now() / 1000)) return null;
    return data.v ?? null;
  } catch {
    return null;
  }
}

/** Returns null for anything malformed, tampered with, or expired. */
export async function openSession(
  token: string,
  secret: string
): Promise<SessionData | null> {
  try {
    const [ivPart, dataPart] = token.split(".");
    if (!ivPart || !dataPart) return null;
    const key = await aesKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(ivPart) },
      key,
      b64urlDecode(dataPart)
    );
    const data = JSON.parse(new TextDecoder().decode(plaintext)) as SessionData;
    // A session from before sign-ins were cut to 15 days was sealed for 30:
    // it ends 15 days after its sign-in too, like every new one.
    if (data && data.v !== SESSION_VERSION && typeof data.exp === "number") data.exp -= OLD_SESSION_TTL_SECONDS - SESSION_TTL_SECONDS;
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (!data.uid) return null;

    /**
     * Demo sessions are valid in a different shape: they carry NO Schoology
     * credentials, because there is no Schoology account behind them.
     *
     * This branch is the fix for a real bug. The credential check below
     * predates demo mode and required a non-empty key and secret on every
     * session — so the empty strings a demo session is deliberately sealed
     * with made it fall at the last line of validation. `/auth/me` then 401'd,
     * the app concluded nobody was signed in, and demo/demo produced a login
     * -> onboarding -> login redirect loop with nothing in the logs to show
     * why.
     *
     * Blanking the credentials on the way out (rather than just skipping the
     * check) makes the safety property structural instead of conventional: a
     * demo session cannot carry credentials, so it cannot produce a signed
     * Schoology request even if some future code path forgets to ask whether
     * it's a demo.
     */
    if (isDemoSession(data)) {
      const { g: _ignored, ...rest } = data;
      return { ...rest, key: "", secret: "" };
    }

    /**
     * Google Classroom sessions: also no Schoology credentials, blanked here
     * for the same structural reason as demo. A "g:" uid without valid Google
     * tokens (or Google tokens on a non-"g:" uid) isn't a session we made.
     */
    if (data.g !== undefined || String(data.uid).startsWith(GOOGLE_UID_PREFIX)) {
      if (!validGoogle(data.g) || !String(data.uid).startsWith(GOOGLE_UID_PREFIX) || String(data.uid).length <= GOOGLE_UID_PREFIX.length) return null;
      return { ...data, key: "", secret: "" };
    }

    // A profile that isn't the right shape is dropped, not fatal: /auth/me just asks Schoology.
    if (data.p !== undefined && !validProfile(data.p)) delete data.p;

    // The reviewer account (reviewSandbox.ts): its uid only ever with the sandbox's own credentials.
    if (String(data.uid).startsWith("r:") && !(data.key === SANDBOX_KEY && data.secret === SANDBOX_SECRET && data.uid === REVIEW_UID)) return null;
    if (!data.key || !data.secret) return null;
    return data;
  } catch {
    // Any failure here (bad base64, failed auth tag, bad JSON) means the token
    // isn't one we issued. Treat all of them identically as "not signed in".
    return null;
  }
}

export const SESSION_COOKIE = "averages_session";
export const LEGACY_SESSION_COOKIE = "schoolagy_session";

/** The session token from a Cookie header: the new cookie, or the old one while it's still around. */
export function sessionToken(header: string | null): string | null {
  return readCookie(header, SESSION_COOKIE) ?? readCookie(header, LEGACY_SESSION_COOKIE);
}

export function sessionCookie(token: string, domain: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Domain=${domain}`,
    "HttpOnly",
    "Secure",
    // Lax works because app.averages.io and api.averages.io share the
    // averages.io registrable domain, so this is same-site, not cross-site.
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function clearSessionCookie(domain: string, name: string = SESSION_COOKIE): string {
  return [
    `${name}=`,
    "Path=/",
    `Domain=${domain}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export const PROFILE_COOKIE = "averages_profile";
export const PROFILE_PURPOSE = "session-profile";

export function profileForSession(value: unknown, session: SessionData): SessionProfile | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.uid !== session.uid || v.exp !== session.exp || !validProfile(v.p)) return null;
  return v.p;
}

export function profileCookie(value: string, maxAge: number, secure: boolean): string {
  return [`${PROFILE_COOKIE}=${value}`, "Path=/", "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax", `Max-Age=${Math.max(0, Math.floor(maxAge))}`].join("; ");
}

export function clearProfileCookie(secure: boolean): string {
  return [`${PROFILE_COOKIE}=`, "Path=/", "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax", "Max-Age=0"].join("; ");
}
