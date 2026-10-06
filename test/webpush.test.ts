/**
 * Tests for the Web Push sender (src/webpush.ts).
 *
 * Run: node --experimental-strip-types test/webpush.test.ts
 *
 * The decryption below is written out separately from the module (straight
 * from RFC 8291 section 3.4 / RFC 8188), so a round trip checks the module
 * against the spec rather than against itself.
 */

import {
  b64urlDecode,
  b64urlEncode,
  encryptPayload,
  generateVapidKeys,
  isAllowedEndpoint,
  isValidSubscription,
  MAX_PAYLOAD_BYTES,
  sendWebPush,
  vapidAuthorization,
} from "../src/webpush.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`);
  }
}
async function rejects(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "resolved";
  } catch (err) {
    return (err as Error).name;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ── an independent RFC 8291 decrypter ─────────────────────────────── */

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

async function decrypt(body: Uint8Array, uaPrivate: CryptoKey, uaPublic: Uint8Array, authSecret: Uint8Array) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16, false);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(authSecret, secret, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--; // strip padding
  const delimiter = padded[end];
  return { rs, idlen, asPublic, delimiter, text: dec.decode(padded.slice(0, end)) };
}

/** A "browser": an ECDH key pair plus a 16-byte auth secret. */
async function makeBrowser() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, uaPublic, auth, keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(auth) } };
}

/* ── RFC 8291 Appendix A ───────────────────────────────────────────── */

{
  const PLAINTEXT = "When I grow up, I want to be a watermelon";
  const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
  const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
  const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
  const EXPECTED =
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

  const point = (b64: string) => {
    const p = b64urlDecode(b64);
    return { x: b64urlEncode(p.slice(1, 33)), y: b64urlEncode(p.slice(33)) };
  };
  const asPrivate = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: AS_PRIVATE, ...point(AS_PUBLIC) },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const asPublic = await crypto.subtle.importKey("raw", b64urlDecode(AS_PUBLIC), { name: "ECDH", namedCurve: "P-256" }, true, []);

  const body = await encryptPayload(PLAINTEXT, { keys: { p256dh: UA_PUBLIC, auth: AUTH } }, {
    salt: b64urlDecode(SALT),
    serverKeyPair: { privateKey: asPrivate, publicKey: asPublic },
  });
  check("RFC 8291 Appendix A: encrypted body matches the RFC byte for byte", b64urlEncode(body), EXPECTED);

  // ...and the independent decrypter reads the RFC's own message back.
  const uaPrivate = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: UA_PRIVATE, ...point(UA_PUBLIC) },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const out = await decrypt(b64urlDecode(EXPECTED), uaPrivate, b64urlDecode(UA_PUBLIC), b64urlDecode(AUTH));
  check("RFC 8291 Appendix A: the test decrypter recovers the RFC plaintext", out.text, PLAINTEXT);
  check("RFC 8291 Appendix A: rs 4096, keyid 65 bytes", [out.rs, out.idlen], [4096, 65]);
}

/* ── round trip with fresh keys ────────────────────────────────────── */

{
  const browser = await makeBrowser();
  const message = JSON.stringify({ title: "New grade", body: "Algebra II — 94% on Quiz 3 ✓" });
  const body = await encryptPayload(message, { keys: browser.keys });
  const out = await decrypt(body, browser.pair.privateKey, browser.uaPublic, browser.auth);
  check("round trip: plaintext comes back (UTF-8 intact)", out.text, message);
  check("round trip: last-record delimiter 0x02", out.delimiter, 2);
  check("round trip: header is salt(16) rs(4)=4096 idlen(1)=65 key(65)", [out.rs, out.idlen, out.asPublic[0], body.length], [4096, 65, 4, 86 + enc.encode(message).length + 1 + 16]);

  const again = await encryptPayload(message, { keys: browser.keys });
  check("fresh salt and server key every message", b64urlEncode(again.slice(0, 86)) !== b64urlEncode(body.slice(0, 86)), true);

  const bytesBody = await encryptPayload(enc.encode("raw bytes"), { keys: browser.keys });
  check("Uint8Array payloads work too", (await decrypt(bytesBody, browser.pair.privateKey, browser.uaPublic, browser.auth)).text, "raw bytes");

  const max = "a".repeat(MAX_PAYLOAD_BYTES);
  const maxBody = await encryptPayload(max, { keys: browser.keys });
  check(`a ${MAX_PAYLOAD_BYTES}-byte payload fits in a 4096-byte body`, maxBody.length <= 4096, true);
  check(`${MAX_PAYLOAD_BYTES + 1} bytes is refused`, await rejects(() => encryptPayload(max + "a", { keys: browser.keys })), "RangeError");
  check(
    "the limit counts UTF-8 bytes, not characters",
    await rejects(() => encryptPayload("é".repeat(MAX_PAYLOAD_BYTES / 2 + 1), { keys: browser.keys })),
    "RangeError",
  );
  check("a bad p256dh is refused", await rejects(() => encryptPayload("x", { keys: { p256dh: "AAAA", auth: browser.keys.auth } })), "TypeError");
  check("a bad auth secret is refused", await rejects(() => encryptPayload("x", { keys: { p256dh: browser.keys.p256dh, auth: "AAAA" } })), "TypeError");
}

/* ── VAPID ─────────────────────────────────────────────────────────── */

const vapidKeys = await generateVapidKeys();
const SUBJECT = "mailto:help@averages.io";
const vapid = { publicKey: vapidKeys.publicKey, privateKeyJwk: vapidKeys.privateKeyJwk, subject: SUBJECT };

check("VAPID public key is a 65-byte uncompressed point", [b64urlDecode(vapidKeys.publicKey).length, b64urlDecode(vapidKeys.publicKey)[0]], [65, 4]);
check("VAPID public key is unpadded base64url", /^[A-Za-z0-9_-]{87}$/.test(vapidKeys.publicKey), true);
check("VAPID private JWK has only kty/crv/x/y/d", Object.keys(vapidKeys.privateKeyJwk).sort(), ["crv", "d", "kty", "x", "y"]);

{
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc123:def?x=1";
  const before = Math.floor(Date.now() / 1000);
  const header = await vapidAuthorization(endpoint, vapid);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  check("Authorization header shape: vapid t=<jwt>, k=<key>", !!m, true);
  if (m) {
    const [, h, c, s, k] = m;
    check("k= is the VAPID public key", k, vapidKeys.publicKey);
    check("JWT header", JSON.parse(dec.decode(b64urlDecode(h))), { typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(dec.decode(b64urlDecode(c)));
    check("aud is the endpoint's origin", claims.aud, "https://fcm.googleapis.com");
    check("sub is the subject", claims.sub, SUBJECT);
    check("exp is about 12 hours out", claims.exp - before >= 12 * 3600 - 1 && claims.exp - before <= 12 * 3600 + 5, true);
    const sig = b64urlDecode(s);
    check("signature is raw r||s (64 bytes)", sig.length, 64);
    const pub = await crypto.subtle.importKey("raw", b64urlDecode(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, enc.encode(`${h}.${c}`));
    check("ES256 signature verifies with the public key", valid, true);
    const tampered = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, enc.encode(`${h}.${c}x`));
    check("...and fails for altered claims", tampered, false);
  }

  const fromSecret = await vapidAuthorization("https://updates.push.services.mozilla.com:443/wpush/v2/gAAA", {
    ...vapid,
    privateKeyJwk: JSON.stringify(vapidKeys.privateKeyJwk),
  }, 3600);
  const claims = JSON.parse(dec.decode(b64urlDecode(fromSecret.slice(8).split(".")[1])));
  check("private key as JSON text (a Worker secret) works; custom lifetime", [claims.aud, claims.exp - before <= 3600 + 5 && claims.exp - before >= 3599], [
    "https://updates.push.services.mozilla.com",
    true,
  ]);

  const other = await generateVapidKeys();
  check("mismatched public/private key is refused", await rejects(() => vapidAuthorization(endpoint, { ...vapid, publicKey: other.publicKey })), "TypeError");
  check("lifetime over 24h is refused", await rejects(() => vapidAuthorization(endpoint, vapid, 24 * 3600 + 1)), "RangeError");
  check("subject must be mailto: or https:", await rejects(() => vapidAuthorization(endpoint, { ...vapid, subject: "help@averages.io" })), "TypeError");
  check("garbage secret is refused", await rejects(() => vapidAuthorization(endpoint, { ...vapid, privateKeyJwk: "{not json" })), "TypeError");
}

/* ── sendWebPush with a mocked fetch ───────────────────────────────── */

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
let nextStatus = 201;
let fetchThrows = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(input), init: init ?? {} });
  if (fetchThrows) throw new TypeError("network down");
  return new Response(nextStatus === 201 ? "" : "nope", { status: nextStatus });
}) as typeof fetch;

{
  const browser = await makeBrowser();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc:123", keys: browser.keys };
  const message = JSON.stringify({ title: "Hi" });

  nextStatus = 201;
  calls.length = 0;
  const r = await sendWebPush(sub, message, vapid);
  check("201: ok", r, { ok: true, status: 201, gone: false });
  check("one POST to the endpoint", [calls.length, calls[0]?.url, calls[0]?.init.method], [1, sub.endpoint, "POST"]);
  const h = (calls[0]?.init.headers ?? {}) as Record<string, string>;
  check(
    "headers",
    { ce: h["Content-Encoding"], ct: h["Content-Type"], ttl: h.TTL, urgency: h.Urgency, topic: h.Topic },
    { ce: "aes128gcm", ct: "application/octet-stream", ttl: "86400", urgency: "normal", topic: undefined },
  );
  check("Authorization is VAPID with our key", h.Authorization?.startsWith("vapid t=") && h.Authorization.endsWith(`, k=${vapidKeys.publicKey}`), true);
  check("redirects are not followed; a timeout signal is attached", [calls[0]?.init.redirect, calls[0]?.init.signal instanceof AbortSignal, calls[0]?.init.signal?.aborted], [
    "manual",
    true,
    false,
  ]);
  const sent = calls[0]?.init.body as Uint8Array;
  check("the body decrypts to the payload", (await decrypt(sent, browser.pair.privateKey, browser.uaPublic, browser.auth)).text, message);

  calls.length = 0;
  await sendWebPush(sub, message, vapid, { ttl: 60, urgency: "high", topic: "grades_Q3-algebra" });
  const h2 = (calls[0]?.init.headers ?? {}) as Record<string, string>;
  check("ttl / urgency / topic options", [h2.TTL, h2.Urgency, h2.Topic], ["60", "high", "grades_Q3-algebra"]);

  check("topic over 32 chars is refused", await rejects(() => sendWebPush(sub, message, vapid, { topic: "a".repeat(33) })), "RangeError");
  check("topic outside base64url is refused", await rejects(() => sendWebPush(sub, message, vapid, { topic: "new grade!" })), "RangeError");
  check("bad urgency is refused", await rejects(() => sendWebPush(sub, message, vapid, { urgency: "urgent" as "high" })), "RangeError");
  check("negative ttl is refused", await rejects(() => sendWebPush(sub, message, vapid, { ttl: -1 })), "RangeError");

  nextStatus = 410;
  check("410: gone (delete the subscription)", await sendWebPush(sub, message, vapid), { ok: false, status: 410, gone: true });
  nextStatus = 404;
  check("404: gone", await sendWebPush(sub, message, vapid), { ok: false, status: 404, gone: true });
  nextStatus = 429;
  check("429: not ok, not gone", await sendWebPush(sub, message, vapid), { ok: false, status: 429, gone: false });
  nextStatus = 500;
  check("500: not ok, not gone", await sendWebPush(sub, message, vapid), { ok: false, status: 500, gone: false });
  nextStatus = 201;
  fetchThrows = true;
  check("network error: ok false, status 0", await sendWebPush(sub, message, vapid), { ok: false, status: 0, gone: false });
  fetchThrows = false;

  {
    // A push service that never answers: the 15 s timer aborts the request.
    // setTimeout is swapped for one that fires at once and records the delay.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const delays: number[] = [];
    let cleared = 0;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      cleared++;
      realClearTimeout(id);
    }) as typeof clearTimeout;
    const mockFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const res = await sendWebPush(sub, message, vapid);
    globalThis.fetch = mockFetch;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    check("a hung push service times out after 15 s: ok false, status 0; timer cleared", [res, delays, cleared], [{ ok: false, status: 0, gone: false }, [15000], 1]);
  }

  calls.length = 0;
  check("payload too large throws", await rejects(() => sendWebPush(sub, "a".repeat(MAX_PAYLOAD_BYTES + 1), vapid)), "RangeError");
  check("...without calling fetch", calls.length, 0);

  check(
    "subscription with broken keys: ok false, status 0, no fetch",
    [await sendWebPush({ endpoint: sub.endpoint, keys: { p256dh: "AAAA", auth: browser.keys.auth } }, message, vapid), calls.length],
    [{ ok: false, status: 0, gone: false }, 0],
  );

  const refusedEndpoints = [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://127.0.0.1/push",
    "https://localhost/push",
    "https://localhost./push",
    "https://foo.localhost/push",
    "https://[::1]/push",
    "https://10.0.0.7/push",
    "https://169.254.169.254/latest/meta-data",
    "https://2130706433/push", // 127.0.0.1 in decimal
    "https://0x7f.1/push", // 127.0.0.1 in hex shorthand
    "https://intranet/push",
    "https://printer.local/push",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "ftp://fcm.googleapis.com/x",
    "not a url",
  ];
  for (const endpoint of refusedEndpoints) {
    calls.length = 0;
    const res = await sendWebPush({ endpoint, keys: browser.keys }, message, vapid);
    check(`refused without fetch: ${endpoint}`, [res, calls.length], [{ ok: false, status: 0, gone: false }, 0]);
  }

  check("real push service hosts are allowed", [
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/QK4x",
    "https://wns2-by3p.notify.windows.com/w/?token=x",
  ].map(isAllowedEndpoint), [true, true, true, true]);

  check("isValidSubscription: good", isValidSubscription(sub), true);
  check("isValidSubscription: bad shapes", [
    isValidSubscription(null),
    isValidSubscription({ endpoint: sub.endpoint }),
    isValidSubscription({ endpoint: "https://127.0.0.1/x", keys: browser.keys }),
    isValidSubscription({ endpoint: sub.endpoint, keys: { p256dh: browser.keys.p256dh, auth: "AAAA" } }),
  ], [false, false, false, false]);
}

// 2026-10-06 review: only the browsers' push services, never just any public host.
check("a public host that isn't a push service: refused", ["https://evil.example/push/abc", "https://example.com/x", "https://fcm.googleapis.com.evil.example/x", "https://notfcm.googleapis.com/x"].map(isAllowedEndpoint), [false, false, false, false]);
check("the push services, including their subdomains", ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-by3p.notify.windows.com/w/?token=x"].map(isAllowedEndpoint), [true, true, true, true]);

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
