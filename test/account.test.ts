// The routes, end to end through the Worker with the review sandbox's account (no Schoology): classmates, join by code.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/account.test.ts
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { REVIEW_UID, SANDBOX_KEY, SANDBOX_SECRET } from "../src/reviewSandbox.ts";
import { readCookie, sealSession, SESSION_COOKIE } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

// Nothing here may reach the internet: the sandbox answers for Schoology.
globalThis.fetch = (async (input: RequestInfo | URL) => { throw new Error(`unexpected call: ${String(input)}`); }) as typeof fetch;

const SECRET = "account-routes-test-session-secret";
const ENV: any = { SESSION_SECRET: SECRET, REVIEW_KEY: "review-key-0123456789abcdef", REVIEW_SECRET: "review-secret-0123456789abcdef" };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";
const APP = "https://app.averages.io";
const session = await sealSession({ key: SANDBOX_KEY, secret: SANDBOX_SECRET, uid: REVIEW_UID }, SECRET);
const COOKIE = `${SESSION_COOKIE}=${session}`;

async function call(path: string, init: { method?: string; json?: unknown; origin?: string | null; cookie?: string | null } = {}) {
  resetRateLimits();
  const headers = new Headers();
  if (init.cookie !== null) headers.set("Cookie", init.cookie ?? COOKIE);
  if (init.origin !== null) headers.set("Origin", init.origin ?? APP);
  let body: string | undefined;
  if (init.json !== undefined) { headers.set("Content-Type", "application/json"); body = JSON.stringify(init.json); }
  const res = (await worker.fetch(new Request(API + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body }), ENV, CTX)) as Response;
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { res, data };
}

console.log("classmates");
{
  const { res, data } = await call("/data/classmates");
  const lists = Object.values(data.CLASSMATES ?? {}) as any[][];
  check("200 with a list for each class", [res.status, lists.length > 0], [200, true]);
  check("names and ids only (no grades or emails)", lists.flat().every((m) => Object.keys(m).sort().join() === "id,name,photo"), true);
  check("never the student themselves", lists.flat().some((m) => m.id === REVIEW_UID), false);
  const out = await call("/data/classmates", { cookie: null });
  check("signed out: 401", out.res.status, 401);
}

console.log("\njoin by code");
{
  let r = await call("/data/join", { json: { code: "sample-join" } });
  check("a good code joins (case doesn't matter)", [r.res.status, r.data.ok, /^\d+$/.test(r.data.section)], [200, true, true]);
  r = await call("/data/join", { json: { code: "SAMPLE-CLOSED" } });
  check("a closed class: not_joined", [r.res.status, r.data.error], [400, "not_joined"]);
  r = await call("/data/join", { json: { code: "NOPE-1234" } });
  check("an unknown code: not_joined", [r.res.status, r.data.error], [400, "not_joined"]);
  r = await call("/data/join", { json: { code: "a b" } });
  check("not a code at all: bad_code", [r.res.status, r.data.error], [400, "bad_code"]);
  r = await call("/data/join", { json: { code: "SAMPLE-JOIN" }, origin: "https://evil.example" });
  check("from another site: refused", r.res.status >= 400 && r.data.ok !== true, true);
}

console.log("\nfolders, with what's in them");
{
  const { res, data } = await call("/data/folders?course=7000000001");
  const items = data.items ?? [];
  check("200 with items", [res.status, items.length > 0], [200, true]);
  check("each item: key, title and folder", items.every((x: any) => /^[a-z_-]+:\d+$/.test(x.key) && typeof x.title === "string" && typeof x.folder === "string"), true);
  check("top level and inside folders both listed", [items.some((x: any) => x.folder === ""), items.some((x: any) => x.folder !== "")], [true, true]);
  check("titles are filled in", items.every((x: any) => x.title.length > 0), true);
  check("placement still there (older apps)", typeof data.placement, "object");
}

console.log("\ndownload your data");
{
  const { res, data } = await call("/account/export");
  check("200 as a download", [res.status, /attachment; filename="averages-io-data\.json"/.test(res.headers.get("Content-Disposition") ?? "")], [200, true]);
  check("says who and what mode", [data.account.id, data.account.mode], [REVIEW_UID, "Classic"]);
  check("no-store", res.headers.get("Cache-Control"), "private, no-store");
  check("has every part", ["syncedSettings", "notifications", "calendarLink", "plus", "connectedApps"].every((k) => k in data), true);
  const out = await call("/account/export", { cookie: null });
  check("signed out: 401", out.res.status, 401);
}

console.log("\ndelete your account");
{
  let r = await call("/account", { method: "DELETE", origin: "https://evil.example" });
  check("from another site: refused, still signed in", [r.res.status >= 400, ((r.res.headers as any).getSetCookie?.() ?? []).some((c: string) => c.startsWith(`${SESSION_COOKIE}=;`))], [true, false]);
  r = await call("/account", { method: "DELETE" });
  const cleared = ((r.res.headers as any).getSetCookie?.() ?? []).some((c: string) => readCookie(c.split(";")[0], SESSION_COOKIE) === "");
  check("deleted, and signed out", [r.res.status, r.data.ok, cleared], [200, true, true]);
  const out = await call("/account", { method: "DELETE", cookie: null });
  check("signed out: 401", out.res.status, 401);
}

console.log("\ndelete your account: everything, or it says so");
{
  // pictures in R2: all gone
  const objs = new Map([["u/r:reviewer/photo", 1], ["u/r:reviewer/background", 1], ["u/someone-else/photo", 1]]);
  ENV.MEDIA = { async list({ prefix }: any) { return { objects: [...objs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }, async delete(keys: string[]) { for (const k of keys) objs.delete(k); } };
  let r = await call("/account", { method: "DELETE" });
  check("pictures deleted, nobody else's", [r.res.status, [...objs.keys()]], [200, ["u/someone-else/photo"]]);
  // a store that can't be reached: the app hears it, and stays signed in
  ENV.MEDIA = { async list() { throw new Error("r2 down"); }, async delete() {} };
  const quiet = console.error; console.error = () => {};
  r = await call("/account", { method: "DELETE" });
  console.error = quiet;
  const cleared = ((r.res.headers as any).getSetCookie?.() ?? []).some((c: string) => readCookie(c.split(";")[0], SESSION_COOKIE) === "");
  check("pictures couldn't go: delete_incomplete, still signed in", [r.res.status, r.data.error, cleared], [502, "delete_incomplete", false]);
  delete ENV.MEDIA;
}

// Add contacts: people by name through Schoology's own search
{
  const r = await call("/messages/people?q=librar");
  check("search finds the librarian", [r.res.status, (r.data.people || []).map((p: any) => p.name)], [200, ["Ms. Alvarez (Librarian)"]]);
  check("one letter isn't a search", (await call("/messages/people?q=a")).data, { people: [] });
  check("signed out", (await call("/messages/people?q=chen", { cookie: null })).res.status, 401);
}

// Read / unread goes to Schoology too (PUT /messages/inbox/{id})
{
  const find = (d: any, id: string) => (d.CONVERSATIONS || []).find((x: any) => String(x.id) === id);
  const t = ((await call("/messages")).data.CONVERSATIONS || []).find((x: any) => x.unread);
  const id = String(t?.id ?? "");
  check("there's an unread thread", /^\d+$/.test(id), true);
  let r = await call("/messages/status", { method: "POST", json: { id, unread: false } });
  check("marked read", [r.res.status, r.data.ok, !!find((await call("/messages")).data, id)?.unread], [200, true, false]);
  r = await call("/messages/status", { method: "POST", json: { id, unread: true } });
  check("marked unread again, and Schoology says so", [r.res.status, !!find((await call("/messages")).data, id)?.unread], [200, true]);
  check("not in the inbox", (await call("/messages/status", { method: "POST", json: { id: "424242", unread: true } })).res.status, 404);
  check("bad body", (await call("/messages/status", { method: "POST", json: { id, unread: "yes" } })).res.status, 400);
  check("from another site", (await call("/messages/status", { method: "POST", json: { id, unread: true }, origin: "https://evil.example" })).res.status >= 400, true);
  check("signed out", (await call("/messages/status", { method: "POST", json: { id, unread: true }, cookie: null })).res.status, 401);
}

// Can I message them? Schoology's send_message per person; search keeps to the student's school
{
  const r = await call("/messages/can?ids=8300000001,8200000001,123");
  check("classmate no", r.data.can?.["8200000001"], false);
  check("the librarian's school email comes too", r.data.email?.["8300000001"], "alvarez@sample.example.org");
  check("a classmate's doesn't", r.data.email?.["8200000001"], undefined);
  check("librarian yes", r.data.can?.["8300000001"], true);
  check("not a person here: unknown", r.data.can?.["123"] ?? null, null);
  check("no ids", (await call("/messages/can?ids=")).res.status, 400);
  check("too many", (await call("/messages/can?ids=" + Array.from({ length: 26 }, (_, i) => 1000 + i).join(","))).res.status, 400);
  check("signed out", (await call("/messages/can?ids=8300000001", { cookie: null })).res.status, 401);
  const all = await call("/messages/people?q=chen");
  check("search covers everyone on Schoology", (all.data.people || []).map((p: any) => p.name), ["Maya Chen", "Mr. Chen (Counselor)", "Dr. Chen (Other Campus)", "Ms. Chen (Other School)"]);
  const s = await call("/messages/people?q=chen&scope=school");
  check("only my school: my campus, not other schools or my district's other campuses", (s.data.people || []).map((p: any) => p.name), ["Maya Chen", "Mr. Chen (Counselor)"]);
}

// Background refresh: ?since=<fingerprint> answers { unchanged: true } when nothing changed
{
  const first = await call("/data/bundle");
  const fp = first.res.headers.get("X-Averages-Fp") ?? "";
  check("bundle has a fingerprint", [first.res.status, /^[a-f0-9]{16}$/.test(fp), Array.isArray(first.data.COURSES)], [200, true, true]);
  const again = await call("/data/bundle?since=" + fp);
  check("same again: unchanged", [again.res.status, again.data, again.res.headers.get("X-Averages-Fp")], [200, { unchanged: true }, fp]);
  const other = await call("/data/bundle?since=0000000000000000");
  check("an old fingerprint: the whole answer", Array.isArray(other.data.COURSES), true);
  const junk = await call("/data/bundle?since=nope");
  check("junk since: the whole answer", Array.isArray(junk.data.COURSES), true);
  const u1 = await call("/data/updates"), ufp = u1.res.headers.get("X-Averages-Fp") ?? "";
  check("updates: unchanged too", (await call("/data/updates?since=" + ufp)).data, { unchanged: true });
  check("the page can read it (CORS)", /x-averages-fp/i.test(first.res.headers.get("Access-Control-Expose-Headers") ?? ""), true);
}

// Teachers' school emails on the people list (GET /data/people)
{
  const r = await call("/data/people");
  const withMail = (r.data.CONTACTS || []).filter((c: any) => c.email);
  check("teachers come with their school email", [r.res.status, withMail.length > 0, withMail.every((c: any) => /@sample\.example\.org$/.test(c.email))], [200, true, true]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
