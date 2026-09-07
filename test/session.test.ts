/**
 * Tests for sealed sessions.
 *
 * Run: node --experimental-strip-types test/session.test.ts
 *
 * These matter because the session token carries the user's Schoology
 * credentials. A token that can be read, forged, or replayed after expiry is a
 * credential leak, not a bug — so each of those properties gets a test.
 */

import {
  clearSessionCookie,
  openSession,
  readCookie,
  sealSession,
  sessionCookie,
} from "../src/session.ts";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n        expected: ${expected}\n        actual:   ${actual}`);
  }
}
const checkTrue = (name: string, v: boolean) => check(name, v, true);

const SECRET = "test-secret-do-not-use-in-production";
const CREDS = { key: "consumer-key-abc", secret: "consumer-secret-xyz", uid: "4242" };

console.log("\nround trip");
const token = await sealSession(CREDS, SECRET);
const opened = await openSession(token, SECRET);
check("key survives", opened?.key, CREDS.key);
check("secret survives", opened?.secret, CREDS.secret);
check("uid survives", opened?.uid, CREDS.uid);
checkTrue("has a future expiry", (opened?.exp ?? 0) > Math.floor(Date.now() / 1000));

console.log("\nconfidentiality");
// The whole point: someone holding the token must not be able to read the
// Schoology secret out of it.
checkTrue("secret is not readable in the token", !token.includes(CREDS.secret));
checkTrue("key is not readable in the token", !token.includes(CREDS.key));
checkTrue("uid is not readable in the token", !token.includes(CREDS.uid));

console.log("\nintegrity");
check("wrong signing secret is rejected", await openSession(token, "wrong-secret"), null);

// Flip one character of the ciphertext — AES-GCM's auth tag must catch it.
const [iv, data] = token.split(".");
const flipped = data[10] === "A" ? "B" : "A";
const tampered = `${iv}.${data.slice(0, 10)}${flipped}${data.slice(11)}`;
check("tampered ciphertext is rejected", await openSession(tampered, SECRET), null);

check("garbage is rejected", await openSession("not-a-token", SECRET), null);
check("empty string is rejected", await openSession("", SECRET), null);
check("missing the iv part is rejected", await openSession("onlyonepart", SECRET), null);

console.log("\nexpiry");
// Seal a token, then reopen it with the clock pushed past its lifetime.
const realNow = Date.now;
const shortToken = await sealSession(CREDS, SECRET);
Date.now = () => realNow() + 31 * 24 * 60 * 60 * 1000; // 31 days on, TTL is 30
check("expired token is rejected", await openSession(shortToken, SECRET), null);
Date.now = realNow;
checkTrue("still valid before expiry", (await openSession(shortToken, SECRET)) !== null);

console.log("\nuniqueness");
// Same input, different token every time — a fresh IV per seal. Identical
// ciphertext for identical input would leak that two users share credentials.
const t1 = await sealSession(CREDS, SECRET);
const t2 = await sealSession(CREDS, SECRET);
checkTrue("each seal produces a distinct token", t1 !== t2);

console.log("\ncookie shape");
const cookie = sessionCookie("abc.def", ".schoolagy.io");
checkTrue("HttpOnly (JS cannot read the credentials)", cookie.includes("HttpOnly"));
checkTrue("Secure (HTTPS only)", cookie.includes("Secure"));
checkTrue("SameSite set", cookie.includes("SameSite=Lax"));
checkTrue("scoped to the domain", cookie.includes("Domain=.schoolagy.io"));
checkTrue("clearing sets Max-Age=0", clearSessionCookie(".schoolagy.io").includes("Max-Age=0"));

console.log("\ncookie parsing");
check(
  "reads the right cookie among several",
  readCookie("other=1; schoolagy_session=wanted; another=2", "schoolagy_session"),
  "wanted"
);
check(
  "handles values containing '='",
  readCookie("schoolagy_session=a.b=c", "schoolagy_session"),
  "a.b=c"
);
check("absent cookie is null", readCookie("other=1", "schoolagy_session"), null);
check("no header is null", readCookie(null, "schoolagy_session"), null);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
