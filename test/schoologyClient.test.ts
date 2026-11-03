// The Schoology client's reads (2026-11-03): redirects are re-signed, and the
// 50-calls-per-5-seconds limit (429) waits and tries again.
import { getMe, getAssignments, RATE_LIMIT_WAITS_MS } from "../src/schoology.ts";

let passed = 0, failed = 0;
function check(name: string, a: unknown, e: unknown) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${E}\n        actual:   ${A}`); }
}
// Short waits here; the real ones are about a second and up.
RATE_LIMIT_WAITS_MS.splice(0, RATE_LIMIT_WAITS_MS.length, 5, 5, 5);

let calls: { path: string; nonce: string }[] = [];
let answer: (path: string, n: number) => Response = () => new Response("{}");
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
  const nonce = /oauth_nonce="([^"]+)"/.exec(auth)?.[1] ?? "";
  calls.push({ path: url.pathname, nonce });
  return answer(url.pathname, calls.length);
}) as typeof fetch;
const CREDS = { key: "k", secret: "s" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

console.log("redirects");
calls = [];
answer = (p) => p === "/v1/users/me" ? new Response(null, { status: 303, headers: { Location: "https://api.schoology.com/v1/users/77" } }) : json({ uid: 77, name_first: "Ana" });
const me = await getMe(CREDS);
check("/users/me follows Schoology's 303 to the user", [me.uid, calls.map((c) => c.path)], [77, ["/v1/users/me", "/v1/users/77"]]);
check("each hop is signed fresh (a reused nonce is refused as a replay)", calls[0].nonce !== calls[1].nonce && !!calls[1].nonce, true);
calls = [];
answer = () => new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } });
await getMe(CREDS).catch(() => {});
check("a redirect off Schoology's API is never followed with our signature", calls.map((c) => c.path), ["/v1/users/me"]);

console.log("rate limit");
calls = [];
answer = (_p, n) => n <= 2 ? new Response("You have reached Schoology's api request limit of 50 requests per 5 seconds", { status: 429 }) : json({ assignment: [{ id: 1, title: "HW" }] });
const list = await getAssignments("5", CREDS);
check("two 429s, then the answer: the assignments arrive", [list.length, calls.length], [1, 3]);
check("...each try signed fresh", new Set(calls.map((c) => c.nonce)).size, 3);
calls = [];
answer = () => new Response("limit", { status: 429 });
let code = 0;
await getAssignments("5", CREDS).catch((e) => { code = e.status; });
check("still limited after every wait: gives up with the 429 (4 tries)", [code, calls.length], [429, 4]);
calls = [];
answer = () => new Response("nope", { status: 403 });
await getAssignments("5", CREDS).catch(() => {});
check("other refusals aren't retried", calls.length, 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
