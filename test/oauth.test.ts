/**
 * Tests for the OAuth 1.0a signer.
 *
 * Run: node --experimental-strip-types test/oauth.test.ts
 *
 * The signature test uses the canonical example from the OAuth 1.0 spec
 * (Appendix A.5.1), which is the standard published vector implementations are
 * checked against. It matters because a wrong signature fails as a bare 401
 * from Schoology with no explanation — the kind of bug that costs a day if it
 * isn't caught before deploy.
 */

import { buildAuthHeader, buildBaseString, hmacSha1, percentEncode } from "../src/oauth.ts";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
  }
}

function checkTrue(name: string, value: boolean) {
  check(name, value, true);
}

console.log("\npercent-encoding (RFC 3986)");
// encodeURIComponent leaves these alone; OAuth requires them escaped. Getting
// this wrong only breaks requests whose values happen to contain them, which
// is exactly the kind of bug that ships.
check("escapes !", percentEncode("!"), "%21");
check("escapes *", percentEncode("*"), "%2A");
check("escapes '", percentEncode("'"), "%27");
check("escapes ( )", percentEncode("()"), "%28%29");
check("leaves unreserved alone", percentEncode("aZ0-._~"), "aZ0-._~");
check("escapes space as %20 not +", percentEncode("a b"), "a%20b");

console.log("\nOAuth 1.0 spec Appendix A.5.1 vector");
// GET http://photos.example.net/photos?file=vacation.jpg&size=original
const vectorParams = {
  oauth_consumer_key: "dpf43f3p2l4k3l03",
  oauth_token: "nnch734d00sl2jdk",
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: "1191242096",
  oauth_nonce: "kllo9940pd9333jh",
  oauth_version: "1.0",
};
const vectorUrl = new URL(
  "http://photos.example.net/photos?file=vacation.jpg&size=original"
);

const EXPECTED_BASE =
  "GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26" +
  "oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26" +
  "oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096%26" +
  "oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal";

check("base string", buildBaseString("GET", vectorUrl, vectorParams), EXPECTED_BASE);

const signature = await hmacSha1("kd94hf93k423kf44&pfkkdhi9sl3r4s00", EXPECTED_BASE);
check("HMAC-SHA1 signature", signature, "tR3+Ty81lMeYAr/Fid0kMTYa/WM=");

console.log("\nend-to-end header for the same vector");
const header = await buildAuthHeader(
  "GET",
  "http://photos.example.net/photos?file=vacation.jpg&size=original",
  {
    key: "dpf43f3p2l4k3l03",
    secret: "kd94hf93k423kf44",
    token: "nnch734d00sl2jdk",
    tokenSecret: "pfkkdhi9sl3r4s00",
  },
  { nonce: "kllo9940pd9333jh", timestamp: "1191242096" }
);
checkTrue(
  "header carries the expected signature",
  header.includes(`oauth_signature="${percentEncode("tR3+Ty81lMeYAr/Fid0kMTYa/WM=")}"`)
);
checkTrue("header is an OAuth header", header.startsWith('OAuth realm="Schoology API",'));

console.log("\ntwo-legged (Averages.io's actual flow: no token)");
const twoLegged = await buildAuthHeader(
  "GET",
  "https://api.schoology.com/v1/users/me",
  { key: "abc123", secret: "shhh" },
  { nonce: "fixednonce", timestamp: "1700000000" }
);
checkTrue("sends an empty oauth_token", twoLegged.includes('oauth_token=""'));
checkTrue("uses HMAC-SHA1", twoLegged.includes('oauth_signature_method="HMAC-SHA1"'));
checkTrue("includes a signature", /oauth_signature="[^"]+"/.test(twoLegged));

// The signing key must end in "&" when there's no token secret. Verify by
// recomputing what the signature should be and comparing.
const twoLeggedBase = buildBaseString(
  "GET",
  new URL("https://api.schoology.com/v1/users/me"),
  {
    oauth_consumer_key: "abc123",
    oauth_nonce: "fixednonce",
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: "1700000000",
    oauth_version: "1.0",
    oauth_token: "",
  }
);
const expectedTwoLegged = await hmacSha1("shhh&", twoLeggedBase);
checkTrue(
  "signing key is secret + trailing '&'",
  twoLegged.includes(`oauth_signature="${percentEncode(expectedTwoLegged)}"`)
);

console.log("\nquery parameters are folded into the signature");
// A filtered call and an unfiltered one must NOT produce the same signature —
// if query params were dropped from the base string, they would.
const withQuery = await buildAuthHeader(
  "GET",
  "https://api.schoology.com/v1/users/1/grades?section_id=99",
  { key: "abc123", secret: "shhh" },
  { nonce: "n", timestamp: "1700000000" }
);
const withoutQuery = await buildAuthHeader(
  "GET",
  "https://api.schoology.com/v1/users/1/grades",
  { key: "abc123", secret: "shhh" },
  { nonce: "n", timestamp: "1700000000" }
);
const sigOf = (h: string) => h.match(/oauth_signature="([^"]+)"/)?.[1];
checkTrue("query changes the signature", sigOf(withQuery) !== sigOf(withoutQuery));

console.log("\nnonces are unique per request");
const a = await buildAuthHeader("GET", "https://api.schoology.com/v1/users/me", {
  key: "k",
  secret: "s",
});
const b = await buildAuthHeader("GET", "https://api.schoology.com/v1/users/me", {
  key: "k",
  secret: "s",
});
const nonceOf = (h: string) => h.match(/oauth_nonce="([^"]+)"/)?.[1];
checkTrue("two requests get different nonces", nonceOf(a) !== nonceOf(b));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
