/**
 * OAuth 1.0a request signing for the Schoology REST API.
 *
 * Schoolagy uses TWO-LEGGED OAuth: the user generates a personal API key +
 * secret for their own account at `app.schoology.com/api`, and the app signs
 * requests with it directly. There is no request-token/access-token dance and
 * no `oauth_token` — per Schoology's own docs, "the consumer and the user are
 * one and the same." (Three-legged OAuth and App Center approval are only
 * needed to read OTHER people's accounts; see schoology-api-reference.md.)
 *
 * This module runs server-side only. The consumer secret must never reach
 * browser JS — that's the whole reason this Worker exists as a separate
 * service from the app.
 */

const OAUTH_SIGNATURE_METHOD = "HMAC-SHA1";
const OAUTH_VERSION = "1.0";

/**
 * RFC 3986 percent-encoding. Deliberately stricter than encodeURIComponent,
 * which leaves ! * ' ( ) unescaped — OAuth requires those escaped, and a
 * mismatch here silently produces signatures the server rejects.
 */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha1(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message)
  );
  // base64 of the raw signature bytes
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export interface Credentials {
  key: string;
  secret: string;
  /**
   * Three-legged OAuth access token. Omitted for the two-legged personal-key
   * flow this beta uses, where the consumer and the user are the same account.
   * Present here so the "appAuth" flow (pending Schoology App Center approval)
   * can reuse this signer unchanged rather than needing a second one.
   */
  token?: string;
  tokenSecret?: string;
}

/**
 * Builds the `Authorization` header value for a signed two-legged request.
 *
 * The signature base string is METHOD & encoded-URL & encoded-sorted-params,
 * where "params" is every OAuth parameter PLUS every query-string parameter,
 * sorted by encoded key (then encoded value). Query params must be folded in —
 * omitting them is the single most common cause of 401s on endpoints that take
 * filters like `?section_id=123`.
 */
export async function buildAuthHeader(
  method: string,
  url: string,
  creds: Credentials,
  /** Fixed nonce/timestamp, for reproducing published test vectors. */
  fixed?: { nonce: string; timestamp: string }
): Promise<string> {
  const parsed = new URL(url);

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.key,
    oauth_nonce: fixed?.nonce ?? nonce(),
    oauth_signature_method: OAUTH_SIGNATURE_METHOD,
    oauth_timestamp: fixed?.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_version: OAUTH_VERSION,
    // Empty string for two-legged — present but blank, per Schoology's docs.
    oauth_token: creds.token ?? "",
  };

  const baseString = buildBaseString(method, parsed, oauthParams);

  // Two-legged: the token secret is empty, but the separating "&" is still
  // required — omitting it is a classic source of silent 401s.
  const signingKey = `${percentEncode(creds.secret)}&${percentEncode(
    creds.tokenSecret ?? ""
  )}`;
  const signature = await hmacSha1(signingKey, baseString);

  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };

  const rendered = Object.entries(headerParams)
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(",");

  return `OAuth realm="Schoology API",${rendered}`;
}

/**
 * Builds the OAuth signature base string: METHOD & encoded-URL & encoded-params.
 *
 * Exported so it can be checked against published OAuth 1.0a test vectors —
 * a wrong base string produces a signature the server rejects with a bare 401
 * and no hint as to why, which is close to undebuggable from the outside.
 *
 * Query-string parameters are folded in alongside the oauth_* ones and the
 * whole set sorted; forgetting the query params is the most common way this
 * goes wrong on endpoints that take filters like `?section_id=123`.
 */
export function buildBaseString(
  method: string,
  url: URL,
  oauthParams: Record<string, string>
): string {
  const allParams: [string, string][] = Object.entries(oauthParams);
  url.searchParams.forEach((value, key) => {
    allParams.push([key, value]);
  });

  const normalized = allParams
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  // Port is included only when non-default; URL.origin already handles that.
  const baseUrl = `${url.origin}${url.pathname}`;
  return [method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalized)].join("&");
}

export { percentEncode, hmacSha1 };
