/**
 * Sign in with Schoology (2026-10-29): Schoology's three-legged OAuth 1.0a,
 * ready for the day PowerSchool hands over a consumer key and secret.
 *
 *   1. GET /auth/schoology/start?domain=<school's Schoology>&under13=0|1
 *      asks Schoology for a request token (signed with our consumer key and
 *      secret only), keeps the token and its secret in a short-lived sealed
 *      cookie on this browser, and sends the student to their school's own
 *      Schoology at https://<domain>/oauth/authorize. (Schoology's docs: the
 *      student must go back to the domain they use, which "might not
 *      necessarily be app.schoology.com".)
 *   2. Schoology sends them back to GET /auth/schoology/callback?oauth_token=...
 *      The token must match the one in this browser's cookie (so nobody can
 *      finish someone else's sign-in), then it's swapped for an access token
 *      and secret (signed with the request token's secret).
 *   3. /users/me with the access token says who they are, and the usual
 *      session cookie is set, carrying the access token. Every Schoology call
 *      after that is signed exactly as before (oauth.ts already sends
 *      oauth_token and signs with the token secret when they're there).
 *
 * Endpoints (developers.schoology.com/api-documentation/authentication, and
 * the same ones schoolopy uses):
 *   GET https://api.schoology.com/v1/oauth/request_token
 *   https://<school domain>/oauth/authorize?oauth_token=...&oauth_callback=...
 *   GET https://api.schoology.com/v1/oauth/access_token
 * Both token answers are form-encoded: oauth_token=...&oauth_token_secret=...
 *
 * Setup (Martin): the consumer key and secret go in as Cloudflare runtime
 * secrets SCHOOLOGY_CONSUMER_KEY and SCHOOLOGY_CONSUMER_SECRET. Until both are
 * there, /auth/schoology/status says off and the sign-in page keeps showing
 * "coming soon". The switch is "schoology-oauth" (src/flags.ts).
 *
 * Testing without keys: set both secrets to the review sandbox's own key and
 * secret (reviewSandbox.ts). Then the token calls are answered by the sandbox,
 * and "authorize" is a page on this API that approves straight away, signing
 * in as the reviewer account. Only while the test-signin switch is on.
 */

import { buildAuthHeader, type Credentials } from "./oauth.ts";
import { SCHOOLOGY_BASE, UPSTREAM_TIMEOUT_MS } from "./schoology.ts";
import { isSandboxCreds } from "./reviewSandbox.ts";
import { SCHOOLS } from "./schools.ts";

export const OAUTH_COOKIE = "averages_sgy_oauth";
export const OAUTH_PURPOSE = "schoology-oauth";
/** How long a student has to finish signing in at Schoology. */
export const OAUTH_TTL_SECONDS = 15 * 60;

export interface Consumer {
  key: string;
  secret: string;
}

/** The consumer key and secret, or null until both secrets are set. */
export function consumerFrom(env: { SCHOOLOGY_CONSUMER_KEY?: string; SCHOOLOGY_CONSUMER_SECRET?: string }): Consumer | null {
  const key = (env.SCHOOLOGY_CONSUMER_KEY ?? "").trim();
  const secret = (env.SCHOOLOGY_CONSUMER_SECRET ?? "").trim();
  return key && secret ? { key, secret } : null;
}

export const isSandboxConsumer = (c: Consumer | null): boolean => !!c && isSandboxCreds(c);

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/**
 * The school's Schoology address, cleaned ("https://NMUSD.schoology.com/home"
 * -> "nmusd.schoology.com"), or null. Only Schoology's own addresses
 * (*.schoology.com) and the schools in src/schools.ts (districts with their own
 * address, like lms.district.org) are allowed: anything else would make this
 * an open redirect to any site, with our name on it.
 */
export function schoolDomain(raw: unknown, schools: readonly { domain: string; aliases?: string[] }[] = SCHOOLS.schoology): string | null {
  const d = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  if (!HOST_RE.test(d)) return null;
  if (d === "schoology.com" || d.endsWith(".schoology.com")) return d === "schoology.com" ? "app.schoology.com" : d;
  const listed = schools.some((s) => s.domain === d || (Array.isArray(s.aliases) && s.aliases.includes(d)));
  return listed ? d : null;
}

/** "oauth_token=a&oauth_token_secret=b" -> { token, secret }, or null when either is missing. */
export function parseTokenAnswer(text: string): { token: string; secret: string } | null {
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(String(text ?? "").trim());
  } catch {
    return null;
  }
  const token = p.get("oauth_token") ?? "";
  const secret = p.get("oauth_token_secret") ?? "";
  if (!/^[\x21-\x7e]{1,512}$/.test(token) || !/^[\x21-\x7e]{1,512}$/.test(secret)) return null;
  return { token, secret };
}

export class OAuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

/** Where the student approves: their school's Schoology. */
export function authorizeUrl(domain: string, token: string, callback: string): string {
  const u = new URL(`https://${domain}/oauth/authorize`);
  u.searchParams.set("oauth_token", token);
  u.searchParams.set("oauth_callback", callback);
  return u.toString();
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** One signed token call (request_token or access_token). */
async function tokenCall(path: "request_token" | "access_token", creds: Credentials, fetcher: Fetcher): Promise<{ token: string; secret: string }> {
  const url = `${SCHOOLOGY_BASE}/oauth/${path}`;
  const auth = await buildAuthHeader("GET", url, creds);
  let res: Response;
  try {
    res = await fetcher(url, { method: "GET", headers: { Authorization: auth, Accept: "application/x-www-form-urlencoded, text/plain, */*" }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new OAuthError("schoology_unreachable", 503);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new OAuthError(res.status === 401 || res.status === 403 ? "schoology_refused" : "schoology_error", res.status);
  const got = parseTokenAnswer(text);
  if (!got) throw new OAuthError("schoology_bad_answer", res.status);
  return got;
}

/** Step 1: a request token, signed with the consumer key and secret only. */
export function requestToken(consumer: Consumer, fetcher: Fetcher = fetch): Promise<{ token: string; secret: string }> {
  return tokenCall("request_token", { key: consumer.key, secret: consumer.secret }, fetcher);
}

/** Step 3: the request token (now approved) for an access token, signed with the request token's secret. */
export function accessToken(consumer: Consumer, req: { token: string; secret: string }, fetcher: Fetcher = fetch): Promise<{ token: string; secret: string }> {
  return tokenCall("access_token", { key: consumer.key, secret: consumer.secret, token: req.token, tokenSecret: req.secret }, fetcher);
}

/** Same length and same characters, in the same time either way. */
export function sameToken(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0 && a.length > 0;
}

/** What the sealed cookie holds between start and callback. */
export interface PendingSignIn {
  t: string; // request token
  s: string; // request token secret
  d: string; // school domain
  u13: boolean; // under 13: Incognito only
}

export function validPending(v: unknown): v is PendingSignIn {
  const p = v as PendingSignIn;
  return !!p && typeof p.t === "string" && typeof p.s === "string" && typeof p.d === "string" && typeof p.u13 === "boolean" && p.t.length > 0 && p.s.length > 0;
}

export function pendingCookie(value: string, secure: boolean): string {
  return [`${OAUTH_COOKIE}=${value}`, "Path=/auth/schoology", "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax", `Max-Age=${OAUTH_TTL_SECONDS}`].join("; ");
}

export function clearPendingCookie(secure: boolean): string {
  return [`${OAUTH_COOKIE}=`, "Path=/auth/schoology", "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax", "Max-Age=0"].join("; ");
}

/** The words the sign-in page shows for each way it can go wrong (?signin_error=<code>). */
export const SIGNIN_ERRORS = [
  "not_configured",
  "feature_off",
  "unknown_school",
  "denied",
  "expired",
  "schoology_refused",
  "schoology_error",
  "schoology_unreachable",
  "schoology_bad_answer",
  "no_user_id",
  "server_misconfigured",
] as const;
