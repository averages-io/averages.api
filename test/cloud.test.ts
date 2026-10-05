/**
 * Tests for GET /config/cloud's values (the public IDs Google Drive and
 * OneDrive need in the browser).
 *
 * Run: node --experimental-strip-types test/cloud.test.ts
 *
 * The IDs below are made up in the right shapes; none of them is real.
 */

import { cloudConfig } from "../src/cloud.ts";

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

const GOOGLE_ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const API_KEY = "AIza" + "Sy" + "A".repeat(33);
const PROJECT = "123456789012";
const MS_ID = "11111111-2222-4333-8444-555555555555";

check("nothing set: both null (the app shows Coming soon)", cloudConfig({}), { google: null, microsoft: null });

check(
  "everything set",
  cloudConfig({ GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_PICKER_API_KEY: API_KEY, GOOGLE_PROJECT_NUMBER: PROJECT, MS_CLIENT_ID: MS_ID }),
  { google: { clientId: GOOGLE_ID, apiKey: API_KEY, appId: PROJECT }, microsoft: { clientId: MS_ID } },
);

check(
  "Google without the Picker key still connects (Save works, Add from Google Drive doesn't); the project number comes from the client ID",
  cloudConfig({ GOOGLE_CLIENT_ID: GOOGLE_ID }),
  { google: { clientId: GOOGLE_ID, apiKey: null, appId: "123456789012" }, microsoft: null },
);

{
  const DRIVE_ID = "123456789012-zyxwvutsrqponmlkjihgfedcba543210.apps.googleusercontent.com";
  check(
    "a separate Google Drive client wins over the sign-in client",
    cloudConfig({ GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_DRIVE_CLIENT_ID: DRIVE_ID, GOOGLE_PICKER_API_KEY: API_KEY }).google,
    { clientId: DRIVE_ID, apiKey: API_KEY, appId: "123456789012" },
  );
  check(
    "a bad Google Drive client value falls back to the sign-in client",
    cloudConfig({ GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_DRIVE_CLIENT_ID: "GOCSPX-" + "x".repeat(28) }).google?.clientId,
    GOOGLE_ID,
  );
}

check("surrounding spaces from pasting are trimmed", cloudConfig({ MS_CLIENT_ID: `  ${MS_ID}\n` }).microsoft, { clientId: MS_ID });
check("a Microsoft ID in capitals is served in lower case", cloudConfig({ MS_CLIENT_ID: MS_ID.toUpperCase() }).microsoft, { clientId: MS_ID });

// A secret pasted into the wrong box must never be served publicly.
check(
  "a Google client secret in GOOGLE_PICKER_API_KEY is left out",
  cloudConfig({ GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_PICKER_API_KEY: "GOCSPX-" + "x".repeat(28) }).google?.apiKey,
  null,
);
check(
  "a Microsoft client secret in MS_CLIENT_ID is left out",
  cloudConfig({ MS_CLIENT_ID: "abc8Q~" + "y".repeat(34) }).microsoft,
  null,
);
check(
  "a client secret in GOOGLE_CLIENT_ID is left out, and takes the rest of Google with it",
  cloudConfig({ GOOGLE_CLIENT_ID: "GOCSPX-" + "x".repeat(28), GOOGLE_PICKER_API_KEY: API_KEY }).google,
  null,
);
check("a session secret in GOOGLE_PROJECT_NUMBER is left out (the client ID's number is used)", cloudConfig({ GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_PROJECT_NUMBER: crypto.randomUUID() }).google?.appId, "123456789012");
check("an empty value is null", cloudConfig({ MS_CLIENT_ID: "" }).microsoft, null);
check("a non-string value is null", cloudConfig({ MS_CLIENT_ID: 42 as unknown as string }).microsoft, null);
check("an API key with a line break in the middle is left out", cloudConfig({ GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_PICKER_API_KEY: API_KEY.slice(0, 20) + "\n" + API_KEY.slice(20) }).google?.apiKey, null);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
