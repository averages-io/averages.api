// The Schoology client's reads: redirects are re-signed, and the 50-calls-per-5-seconds limit (429) waits and tries again.
import { getMe, getAssignments, postedInDiscussion, RATE_LIMIT_WAITS_MS, retryAfterMs } from "../src/schoology.ts";
import { sendNewMessage, deleteThread } from "../src/messages.ts";

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
// Schoology's Retry-After is what we wait (2026-11-13), not our own guess
check("retryAfterMs: seconds, a date, nothing", [retryAfterMs("2"), retryAfterMs("0.5"), retryAfterMs(new Date(10_000).toUTCString(), 7_000), retryAfterMs(null), retryAfterMs("soon")], [2000, 500, 3000, null, null]);
{
  RATE_LIMIT_WAITS_MS.splice(0, RATE_LIMIT_WAITS_MS.length, 3000, 3000, 3000);   // a wait it must NOT use
  calls = [];
  answer = (_p, n) => n <= 1 ? new Response("limit", { status: 429, headers: { "Retry-After": "0" } }) : json({ assignment: [{ id: 2, title: "Lab" }] });
  const t0 = Date.now();
  const got = await getAssignments("5", CREDS);
  const ms = Date.now() - t0;
  check("a 429 that says when: waits that long (at least 0.1 s), not the 3 s guess", [got.length, calls.length, ms >= 100, ms < 1500], [1, 2, true, true]);
  RATE_LIMIT_WAITS_MS.splice(0, RATE_LIMIT_WAITS_MS.length, 5, 5, 5);
}
calls = [];
answer = () => new Response("nope", { status: 403 });
await getAssignments("5", CREDS).catch(() => {});
check("other refusals aren't retried", calls.length, 1);

console.log("assignments are paged; discussion replies (2026-11-14)");
{
  calls = [];
  const page = (start: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(1000 + start + i), title: "A" + (start + i) }));
  answer = (p) => {
    const u = calls[calls.length - 1];
    return json({ assignment: calls.length === 1 ? page(0, 200) : page(200, 30), total: 230 });
  };
  const all = await getAssignments("5", CREDS);
  check("a class with 230 assignments: two pages, all 230", [all.length, calls.length], [230, 2]);
  calls = [];
  answer = () => json({ assignment: page(0, 12), total: 12 });
  check("one short page: one call", [(await getAssignments("5", CREDS)).length, calls.length], [12, 1]);
  calls = [];
  answer = () => json({ comment: [{ id: 1, uid: "900", comment: "first" }, { id: 2, uid: "77", comment: "mine" }], total: 2 });
  check("posted: a reply with the student's uid", [await postedInDiscussion("5", "9", "77", CREDS), calls.map((c) => c.path)], [true, ["/v1/sections/5/discussions/9/comments"]]);
  answer = () => json({ comment: [{ id: 1, uid: "900", comment: "someone else" }], total: 1 });
  check("not posted: only others' replies", await postedInDiscussion("5", "9", "77", CREDS), false);
  answer = () => json({ total: 0 });
  check("no replies at all: not posted", await postedInDiscussion("5", "9", "77", CREDS), false);
}

console.log("new messages (who they may go to)");
// Schoology's recipients list empty (seen in the sandbox): the teachers of the student's own classes are allowed.
let posted: string[] = [];
const fake = (schoologySays: Response | null) => {
  posted = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const p = url.pathname;
    if (p === "/v1/messages/recipients") return json({ recipient: [] });
    if (p === "/v1/users/42/sections") return json({ section: [{ id: 700 }, { id: 701 }] });
    if (p === "/v1/sections/700/enrollments") return json({ enrollment: [{ uid: 9001, admin: 1, status: 1, name_display: "Ms. Reyes" }, { uid: 42, admin: 0, status: 1 }] });
    if (p === "/v1/sections/701/enrollments") return json({ enrollment: [{ uid: 9002, admin: 1, status: 1, name_display: "Mr. Hall" }] });
    if (p === "/v1/messages" && init?.method === "POST") { posted.push(String(init.body)); return schoologySays ?? json({ id: 555 }); }
    return json({}, 404);
  }) as typeof fetch;
};
const ME = { key: "k", secret: "s", uid: "42" };
fake(null);
check("to a teacher of one of their classes: sent", [await sendNewMessage(ME, { recipientIds: ["9002"], subject: "Hi", message: "Q" }), posted.length], [{ ok: true, id: "555" }, 1]);
fake(null);
check("to someone outside their classes: refused before Schoology", [await sendNewMessage(ME, { recipientIds: ["31337"], subject: "Hi", message: "Q" }), posted.length], [{ ok: false, error: "recipient_not_allowed" }, 0]);
fake(new Response('"Some or all of the recipients you entered are invalid"', { status: 400 }));
check("Schoology's own no (the school's settings) is said as such", await sendNewMessage(ME, { recipientIds: ["9001"], subject: "Hi", message: "Q" }), { ok: false, error: "school_blocks_new_messages" });

console.log("deleting a conversation");
{
  let seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
    return answer(url.pathname, seen.length);
  }) as typeof fetch;
  answer = () => new Response(null, { status: 204 });
  check("in both folders: both deleted", [await deleteThread("1827715414", CREDS), seen], [true, ["DELETE /v1/messages/inbox/1827715414", "DELETE /v1/messages/sent/1827715414"]]);
  seen = []; answer = (p) => p.includes("/sent/") ? new Response("not found", { status: 404 }) : new Response(null, { status: 204 });
  check("only in the inbox: still deleted", await deleteThread("55", CREDS), true);
  seen = []; answer = () => new Response("not found", { status: 404 });
  check("in neither: false (already gone)", await deleteThread("55", CREDS), false);
  seen = []; answer = () => new Response("no", { status: 403 });
  let st = 0; await deleteThread("55", CREDS).catch((e) => { st = e.status; });
  check("refused in both: the refusal is thrown", st, 403);
  seen = []; answer = () => new Response("down", { status: 500 });
  st = 0; await deleteThread("55", CREDS).catch((e) => { st = e.status; });
  check("Schoology down: thrown", st, 500);
  seen = [];
  check("an id that isn't digits never reaches Schoology", [await deleteThread("../users/1", CREDS), seen.length], [false, 0]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
