/**
 * Web Push sender (2026-10-05) — WebCrypto only, no npm dependencies, so it
 * runs in the Worker and imports directly under `node --experimental-strip-types`.
 *
 *   - VAPID (RFC 8292): an ES256 JWT in `Authorization: vapid t=<jwt>, k=<key>`.
 *   - Payload encryption (RFC 8291) with the aes128gcm content coding (RFC 8188):
 *     one record, a fresh ECDH key pair and salt per message.
 *
 * Keys, made once and kept by the Worker:
 *   - VAPID public key: base64url of the 65-byte uncompressed P-256 point. It is
 *     public — the browser passes it to pushManager.subscribe() as
 *     applicationServerKey — so a plain var is fine.
 *   - VAPID private key: the JWK from generateVapidKeys(), stored as a Worker
 *     secret holding the JSON text. Changing the key pair invalidates every
 *     existing subscription (push services bind a subscription to the key).
 *
 * sendWebPush() refuses anything but https:// endpoints on a public host name
 * (no IP literals, no localhost, no single-label names, no credentials, no
 * non-443 port) and never follows redirects, so a stored subscription can't
 * point the Worker at an internal address.
 *
 * Test: test/webpush.test.ts (includes the RFC 8291 Appendix A vector).
 */

const enc = new TextEncoder();

/** Largest plaintext we send: push services cap the whole body at 4096 bytes. */
export const MAX_PAYLOAD_BYTES = 3992;
/** Record size written in the aes128gcm header. */
const RECORD_SIZE = 4096;
/** How long a send may take before it's abandoned. */
const SEND_TIMEOUT_MS = 15_000;
/** RFC 8292: a VAPID JWT must not expire more than 24 hours out. */
const MAX_JWT_LIFETIME = 24 * 60 * 60;
const DEFAULT_JWT_LIFETIME = 12 * 60 * 60;

export type PushSubscriptionKeys = { p256dh: string; auth: string };
export type PushSubscriptionLike = { endpoint: string; keys: PushSubscriptionKeys };
export type VapidConfig = {
  /** base64url, 65-byte uncompressed P-256 point. */
  publicKey: string;
  /** The private JWK, as an object or as the JSON text of a Worker secret. */
  privateKeyJwk: JsonWebKey | string;
  /** "mailto:..." or "https://..." — how the push service can reach us. */
  subject: string;
};
export type Urgency = "very-low" | "low" | "normal" | "high";
export type SendOptions = { ttl?: number; urgency?: Urgency; topic?: string };
export type SendResult = { ok: boolean; status: number; gone: boolean };

/* ── base64url ─────────────────────────────────────────────────────── */

export function b64urlEncode(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Accepts base64url or standard base64, padded or not. Throws on junk. */
export function b64urlDecode(value: string): Uint8Array {
  const s = value.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw new TypeError("invalid base64url");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── small helpers ─────────────────────────────────────────────────── */

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function toBytes(payload: Uint8Array | string): Uint8Array {
  return typeof payload === "string" ? enc.encode(payload) : payload;
}

/** A 65-byte uncompressed P-256 point (0x04 || x || y) from base64url. */
function decodePoint(value: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(value);
  } catch {
    throw new TypeError(`${what} is not base64url`);
  }
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new TypeError(`${what} must be a 65-byte uncompressed P-256 point`);
  return bytes;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * True when a subscription from the browser has the shape we can send to.
 * Use it where subscriptions are saved, so a broken one is never stored.
 */
export function isValidSubscription(sub: unknown): sub is PushSubscriptionLike {
  if (!sub || typeof sub !== "object") return false;
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s.endpoint !== "string" || !isAllowedEndpoint(s.endpoint)) return false;
  if (!s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") return false;
  try {
    decodePoint(s.keys.p256dh, "p256dh");
    return b64urlDecode(s.keys.auth).length === 16;
  } catch {
    return false;
  }
}

/**
 * https only, on a public DNS name: no IP literals, localhost, single-label or
 * .local/.internal names, no user:pass@, no port other than 443.
 */
export function isAllowedEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port !== "" && url.port !== "443") return false;
  // The URL parser lower-cases the host and turns 0x7f.1, 2130706433 etc.
  // into dotted IPv4, so these checks see the canonical form.
  const host = url.hostname.replace(/\.$/, "");
  if (!host || host.startsWith("[") || host.includes(":")) return false; // IPv6 literal
  if (/^[0-9.]+$/.test(host)) return false; // IPv4 literal
  if (!host.includes(".")) return false; // localhost, intranet single-label names
  if (/\.(localhost|local|internal|home\.arpa)$/.test(host)) return false;
  // Only the browsers' own push services (2026-10-06 review): otherwise the
  // Worker would POST to any public host a student registered, every 20
  // minutes. Chrome, Edge (Chromium), Opera, Brave and Samsung Internet use
  // FCM; Firefox, Mozilla's; Safari, Apple's; old Edge, Windows'.
  return PUSH_SERVICES.some((s) => host === s || host.endsWith("." + s));
}

/** The push services browsers use (see isAllowedEndpoint). */
export const PUSH_SERVICES = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

/* ── VAPID (RFC 8292) ──────────────────────────────────────────────── */

/**
 * Makes a VAPID key pair. Run it once (not in the Worker), keep `publicKey`
 * as a var and `JSON.stringify(privateKeyJwk)` as a secret.
 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKeyJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return {
    publicKey: b64urlEncode(raw),
    privateKeyJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
  };
}

function parseJwk(value: JsonWebKey | string): JsonWebKey {
  let jwk: JsonWebKey;
  if (typeof value === "string") {
    try {
      jwk = JSON.parse(value) as JsonWebKey;
    } catch {
      throw new TypeError("VAPID private key is not valid JSON");
    }
  } else {
    jwk = value;
  }
  if (!jwk || typeof jwk !== "object" || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) {
    throw new TypeError("VAPID private key must be a P-256 EC JWK with d, x and y");
  }
  return jwk;
}

/**
 * The `Authorization` header value for one push endpoint:
 * `vapid t=<JWT>, k=<publicKey>`. `expSeconds` is the token lifetime from now
 * (default 12 hours, at most 24).
 */
export async function vapidAuthorization(endpoint: string, vapid: VapidConfig, expSeconds?: number): Promise<string> {
  const lifetime = expSeconds ?? DEFAULT_JWT_LIFETIME;
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > MAX_JWT_LIFETIME) {
    throw new RangeError("VAPID token lifetime must be between 1 second and 24 hours");
  }
  const subject = typeof vapid.subject === "string" ? vapid.subject.trim() : "";
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
    throw new TypeError('VAPID subject must be "mailto:<address>" or an https:// URL');
  }
  const publicKey = decodePoint(vapid.publicKey, "VAPID public key");
  const jwk = parseJwk(vapid.privateKeyJwk);
  // A mismatched pair produces tokens every push service rejects with 401/403;
  // fail here instead, where the cause is obvious.
  if (!bytesEqual(publicKey.subarray(1, 33), b64urlDecode(jwk.x!)) || !bytesEqual(publicKey.subarray(33), b64urlDecode(jwk.y!))) {
    throw new TypeError("VAPID public key does not match the private key");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + Math.floor(lifetime),
        sub: subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  // WebCrypto ECDSA signatures are already the raw r || s (64 bytes) JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${b64urlEncode(publicKey)}`;
}

/* ── Payload encryption (RFC 8291, aes128gcm) ──────────────────────── */

/**
 * Encrypts one push message for a subscription. Returns the whole request
 * body: salt(16) || rs(4, = 4096) || idlen(1, = 65) || server public key(65)
 * || ciphertext. `opts` exists for test vectors: a fixed salt and a fixed
 * ECDH key pair (its public key must be extractable).
 */
export async function encryptPayload(
  payload: Uint8Array | string,
  subscription: { keys: PushSubscriptionKeys },
  opts?: { salt?: Uint8Array; serverKeyPair?: CryptoKeyPair },
): Promise<Uint8Array> {
  const plaintext = toBytes(payload);
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`push payload is ${plaintext.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }
  const uaPublic = decodePoint(subscription.keys.p256dh, "subscription p256dh");
  let authSecret: Uint8Array;
  try {
    authSecret = b64urlDecode(subscription.keys.auth);
  } catch {
    throw new TypeError("subscription auth is not base64url");
  }
  if (authSecret.length !== 16) throw new TypeError("subscription auth must be 16 bytes");
  const salt = opts?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new TypeError("salt must be 16 bytes");

  const serverKeys =
    opts?.serverKeyPair ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", serverKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);

  // The algorithm member is `public` at runtime; workers-types spells it
  // `$public` (a workerd binding artifact), so this object isn't a literal.
  const ecdhParams = { name: "ECDH", public: uaKey };
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, serverKeys.privateKey, 256));

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // Single (and so last) record: plaintext || 0x02, no padding.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/* ── Sending ───────────────────────────────────────────────────────── */

const URGENCIES = new Set<string>(["very-low", "low", "normal", "high"]);

/**
 * Sends one push message. Never throws for a problem with this one
 * subscription (refused endpoint, bad keys, network error, timeout — all
 * `ok: false, status: 0`); throws for caller mistakes that would fail every
 * send (payload too large, bad VAPID config, bad ttl/urgency/topic).
 *
 * `gone: true` (404/410) means the subscription has expired or been revoked:
 * delete it. 429 and 5xx are worth retrying later; other 4xx are not.
 */
export async function sendWebPush(
  subscription: PushSubscriptionLike,
  payload: string,
  vapid: VapidConfig,
  opts?: SendOptions,
): Promise<SendResult> {
  const refused: SendResult = { ok: false, status: 0, gone: false };
  if (!subscription || typeof subscription.endpoint !== "string" || !isAllowedEndpoint(subscription.endpoint)) return refused;

  const bytes = toBytes(payload);
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`push payload is ${bytes.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }
  const ttl = opts?.ttl ?? 86_400;
  if (!Number.isInteger(ttl) || ttl < 0) throw new RangeError("ttl must be a whole number of seconds, 0 or more");
  const urgency = opts?.urgency ?? "normal";
  if (!URGENCIES.has(urgency)) throw new RangeError("urgency must be very-low, low, normal or high");
  const topic = opts?.topic;
  if (topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) {
    throw new RangeError("topic must be 1-32 characters of the base64url alphabet");
  }

  const authorization = await vapidAuthorization(subscription.endpoint, vapid);
  let body: Uint8Array;
  try {
    body = await encryptPayload(bytes, subscription);
  } catch (err) {
    if (err instanceof TypeError) return refused; // this subscription's keys are malformed
    throw err;
  }

  const headers: Record<string, string> = {
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: authorization,
  };
  if (topic !== undefined) headers.Topic = topic;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    try {
      await res.body?.cancel();
    } catch {
      /* nothing to release */
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch {
    return refused;
  } finally {
    clearTimeout(timer);
  }
}
