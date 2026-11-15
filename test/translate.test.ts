// Advanced translation's server fallback: POST /translate (src/translate.ts), Workers AI faked here.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/translate.test.ts
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { checkTranslateBody, translateAll, MAX_TEXTS, TRANSLATE_MODEL } from "../src/translate.ts";
import { sealSession, SESSION_COOKIE } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}
globalThis.fetch = (async (input: RequestInfo | URL) => { throw new Error(`unexpected call: ${String(input)}`); }) as typeof fetch;

const calls: any[] = [];
const AI = { async run(model: string, input: any) { calls.push({ model, input }); if (input.text === "boom") throw new Error("model error"); return { translated_text: `[${input.target_lang}] ${input.text}` }; } };
const SECRET = "translate-test-session-secret";
const ENV: any = { SESSION_SECRET: SECRET, AI, FEATURES_ON: "server-translate" };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const cookieFor = async (uid: string) => `${SESSION_COOKIE}=${await sealSession({ key: "k", secret: "s", uid } as any, SECRET)}`;
async function call(json: unknown, cookie: string, env: any = ENV, origin = "https://app.averages.io") {
  resetRateLimits();
  const headers = new Headers({ "Content-Type": "application/json", Cookie: cookie, Origin: origin });
  const res = await worker.fetch(new Request("https://api.averages.io/translate", { method: "POST", headers, body: JSON.stringify(json) }), env, CTX);
  return { status: res.status, data: (await res.json().catch(() => null)) as any, cache: res.headers.get("Cache-Control") };
}

console.log("\nchecking the request");
check("good, English when from is left out", checkTranslateBody({ to: "es", texts: ["Unit 3 test"] }), { to: "es", texts: ["Unit 3 test"], from: ["en"] });
check("into English, from Spanish", checkTranslateBody({ to: "en", texts: ["Examen"], from: ["es"] }), { to: "en", texts: ["Examen"], from: ["es"] });
check("from must match the texts", checkTranslateBody({ to: "en", texts: ["a", "b"], from: ["es"] }), { error: "unknown_language" });
check("from must be a known language", checkTranslateBody({ to: "en", texts: ["a"], from: ["xx"] }), { error: "unknown_language" });
check("unknown language", checkTranslateBody({ to: "it", texts: ["x"] }), { error: "unknown_language" });
check("not a language code", checkTranslateBody({ to: "__proto__", texts: ["x"] }), { error: "unknown_language" });
check("no texts", checkTranslateBody({ to: "es", texts: [] }), { error: "no_texts" });
check("too many", checkTranslateBody({ to: "es", texts: Array(MAX_TEXTS + 1).fill("a") }), { error: "too_many_texts" });
check("not text", checkTranslateBody({ to: "es", texts: [5] }), { error: "invalid_text" });
check("one too long", checkTranslateBody({ to: "es", texts: ["a".repeat(1001)] }), { error: "text_too_long" });
check("too much in all", checkTranslateBody({ to: "es", texts: Array(13).fill("a".repeat(1000)) }), { error: "too_much_text" });

console.log("\ntranslating");
calls.length = 0;
check("in order, a failure comes back blank", await translateAll(AI, "fr", ["Lab report", "boom", "  ", "Quiz"]), ["[french] Lab report", "", "", "[french] Quiz"]);
calls.length = 0;
check("each from its own language; one already in the target isn't sent", await translateAll(AI, "en", ["Examen", "Quiz"], ["es", "en"]), ["[english] Examen", ""]);
check("Spanish to English", [calls.length, calls[0].input.source_lang, calls[0].input.target_lang], [1, "spanish", "english"]);
calls.length = 0; await translateAll(AI, "fr", ["Lab report", "boom", "  ", "Quiz"]);
check("the m2m100 model, English to the language's name, blanks not sent", [calls.length, calls[0].model, calls[0].input.source_lang, calls[0].input.target_lang], [3, TRANSLATE_MODEL, "english", "french"]);

console.log("\nPOST /translate");
const cookie = await cookieFor("5001");
const ok = await call({ to: "zh", texts: ["Unit 3 test", "Chapter 5 quiz"] }, cookie);
check("translates, not cached", [ok.status, ok.data, ok.cache], [200, { texts: ["[chinese] Unit 3 test", "[chinese] Chapter 5 quiz"] }, "private, no-store"]);
check("signed out: 401", (await call({ to: "es", texts: ["x"] }, "")).status, 401);
check("from another site: refused", (await call({ to: "es", texts: ["x"] }, cookie, ENV, "https://evil.example")).status >= 400, true);
check("bad request: 400", [(await call({ to: "xx", texts: ["x"] }, cookie)).data?.error], ["unknown_language"]);
check("no Workers AI: 503", [(await call({ to: "es", texts: ["x"] }, cookie, { SESSION_SECRET: SECRET, FEATURES_ON: "server-translate" })).data?.error], ["translation_unavailable"]);
const off = await call({ to: "es", texts: ["x"] }, cookie, { SESSION_SECRET: SECRET, AI });
check("switch off (the default): 503 feature_off, the model isn't asked", [off.status, off.data?.error, off.data?.feature], [503, "feature_off", "server-translate"]);
const storeSays = (status: string) => { const ns: any = { idFromName: (n: string) => n, get: () => ({ status: async () => ({ status }) }), jurisdiction: () => ns }; return ns; };
const BILLING_ON = { ...ENV, FEATURES_ON: "billing,server-translate", STRIPE_SECRET_KEY: "sk_test_" + "x".repeat(24) };
const noPlus = await call({ to: "es", texts: ["x"] }, cookie, { ...BILLING_ON, BILLING: storeSays("canceled") });
check("billing on, no Plus: 403 plus_required, model not asked", [noPlus.status, noPlus.data?.error], [403, "plus_required"]);
const withPlus = await call({ to: "es", texts: ["x"] }, cookie, { ...BILLING_ON, BILLING: storeSays("active") });
check("billing on, with Plus: translated", [withPlus.status, withPlus.data?.texts], [200, ["[spanish] x"]]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
