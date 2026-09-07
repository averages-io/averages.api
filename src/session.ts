/**
 * Stateless encrypted sessions.
 *
 * The user's Schoology key + secret are sealed with AES-GCM using a
 * Worker-side secret (`SESSION_SECRET`) and handed back as an opaque token in
 * an httpOnly cookie. That means:
 *
 *   - the browser holds the session but cannot read the credentials out of it
 *     (httpOnly blocks JS access; encryption blocks reading it even if it leaks)
 *   - this Worker keeps no database — nothing to breach, nothing to sync, and
 *     no KV namespace for Martin to provision before the thing runs
 *   - revocation is by expiry (and by the user rotating their key in Schoology)
 *
 * The tradeoff of statelessness is that a token can't be individually revoked
 * server-side before it expires. For a personal-key beta that's an acceptable
 * trade; if this ever needs true revocation, swap the sealed blob for a KV
 * lookup key and delete the KV entry on logout.
 */

import type { Credentials } from "./oauth.ts";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface SessionData extends Credentials {
  /** Schoology user id resolved at login, so /users/{id}/... calls need no extra round trip. */
  uid: string;
  /** Unix seconds. Checked on every request. */
  exp: number;
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
  const payload: SessionData = {
    ...data,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
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
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (!data.key || !data.secret || !data.uid) return null;
    return data;
  } catch {
    // Any failure here (bad base64, failed auth tag, bad JSON) means the token
    // isn't one we issued. Treat all of them identically as "not signed in".
    return null;
  }
}

export const SESSION_COOKIE = "schoolagy_session";

export function sessionCookie(token: string, domain: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Domain=${domain}`,
    "HttpOnly",
    "Secure",
    // Lax works because app.schoolagy.io and api.schoolagy.io share the
    // schoolagy.io registrable domain, so this is same-site, not cross-site.
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function clearSessionCookie(domain: string): string {
  return [
    `${SESSION_COOKIE}=`,
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
