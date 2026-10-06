/**
 * Route tests for Sign in with Google and the Google Classroom data routes:
 * the real Worker (src/index.ts) runs in Node with Google's endpoints faked.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/google.test.ts
 *
 * Every id, token and secret below is made up.
 */

import app from "../src/index.ts";
import { openSession, readCookie, sealSession, sealValue, SESSION_COOKIE } from "../src/session.ts";
import { ACCESS_COOKIE, ACCESS_PURPOSE, CLASSROOM_SCOPES, codeChallenge, STATE_COOKIE, STATE_PURPOSE } from "../src/google.ts";

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

const SECRET = "route-test-session-secret";
const CLIENT_ID = "123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-route-test-not-real";
const ENV: Record<string, unknown> = {
  SESSION_SECRET: SECRET,
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: "https://api.averages.io/auth/google/callback",
  CANVA_CLIENT_ID: "OC-test",
  CANVA_CLIENT_SECRET: "canva-test",
  CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback",
};
const CTX = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";

async function call(path: string, init: RequestInit & { cookie?: string } = {}, env = ENV) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  return app.fetch(new Request(API + path, { ...init, headers, redirect: "manual" }), env as any, CTX as any);
}

function setCookies(res: Response): string[] {
  return (res.headers as any).getSetCookie?.() ?? [];
}
function cookieValue(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    const v = readCookie(c.split(";")[0], name);
    if (v !== null) return v;
  }
  return null;
}

/* ── Fake Google ───────────────────────────────────────────────────────── */

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let google: Handler = () => new Response("unexpected", { status: 500 });
const calls: { url: URL; init: RequestInit }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  calls.push({ url, init });
  return google(url, init);
}) as typeof fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const jwt = (claims: Record<string, unknown>) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const ALL_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", ...Object.values(CLASSROOM_SCOPES)].join(" ");

let tokenRequests: URLSearchParams[] = [];
function tokenEndpoint(opts: { scope?: string; refresh?: string | null; refreshError?: string } = {}): Handler {
  return async (url, init) => {
    if (url.href !== "https://oauth2.googleapis.com/token") return json({ error: "not_found" }, 404);
    const body = new URLSearchParams(String(init.body));
    tokenRequests.push(body);
    if (body.get("grant_type") === "refresh_token") {
      if (opts.refreshError) return json({ error: opts.refreshError }, 400);
      return json({ access_token: "ya29.refreshed", expires_in: 3599, scope: opts.scope ?? ALL_SCOPES, token_type: "Bearer" });
    }
    if (body.get("code") !== "good-code") return json({ error: "invalid_grant" }, 400);
    return json({
      access_token: "ya29.first",
      expires_in: 3599,
      ...(opts.refresh === null ? {} : { refresh_token: opts.refresh ?? "1//refresh-token" }),
      scope: opts.scope ?? ALL_SCOPES,
      token_type: "Bearer",
      id_token: jwt({ iss: "https://accounts.google.com", aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600, sub: "109876543210", email: "sam@school.example", name: "Sam Student", picture: "https://lh3.googleusercontent.com/a/sam" }),
    });
  };
}

/* ── Start ─────────────────────────────────────────────────────────────── */

console.log("\n/auth/google/start");
const start = await call("/auth/google/start?under13=0");
const consent = new URL(start.headers.get("Location") ?? "about:blank");
check("redirects to Google", [start.status, consent.origin + consent.pathname], [302, "https://accounts.google.com/o/oauth2/v2/auth"]);
check("our client and callback", [consent.searchParams.get("client_id"), consent.searchParams.get("redirect_uri")], [CLIENT_ID, "https://api.averages.io/auth/google/callback"]);
check("asks for a refresh token", [consent.searchParams.get("access_type"), consent.searchParams.get("prompt")], ["offline", "consent select_account"]);
const stateCookieHeader = setCookies(start).find((c) => c.startsWith(STATE_COOKIE + "=")) ?? "";
check("state cookie: host-only, /auth/google only, httpOnly, 10 minutes", stateCookieHeader.split("; ").slice(1), ["Path=/auth/google", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=600"]);
check("no session cookie yet", cookieValue(start, SESSION_COOKIE), null);
const stateSealed = cookieValue(start, STATE_COOKIE)!;
const state = consent.searchParams.get("state")!;

const unconfigured = await call("/auth/google/start", {}, { ...ENV, GOOGLE_CLIENT_SECRET: "" });
check("not set up: back to login, unavailable", unconfigured.headers.get("Location"), "https://app.averages.io/?google=unavailable");

/* ── Callback ──────────────────────────────────────────────────────────── */

console.log("\n/auth/google/callback");
google = tokenEndpoint();
tokenRequests = [];
const cb = (query: string, cookie = `${STATE_COOKIE}=${stateSealed}`) => call(`/auth/google/callback?${query}`, { cookie });

check("no state cookie: expired", (await cb(`state=${state}&code=good-code`, "")).headers.get("Location"), "https://app.averages.io/?google=expired");
check("state mismatch: expired", (await cb(`state=${"A".repeat(43)}&code=good-code`)).headers.get("Location"), "https://app.averages.io/?google=expired");
const otherBrowser = await sealValue({ state: "B".repeat(43), verifier: "v".repeat(64), under13: false }, SECRET, STATE_PURPOSE, 600);
check("someone else's sign-in: expired", (await cb(`state=${state}&code=good-code`, `${STATE_COOKIE}=${otherBrowser}`)).headers.get("Location"), "https://app.averages.io/?google=expired");
const sessionAsState = await sealSession({ key: "k", secret: "s", uid: "1" }, SECRET);
check("a session cookie can't pose as the state", (await cb(`state=${state}&code=good-code`, `${STATE_COOKIE}=${sessionAsState}`)).headers.get("Location"), "https://app.averages.io/?google=expired");
check("cancelled on Google", (await cb(`state=${state}&error=access_denied`)).headers.get("Location"), "https://app.averages.io/?google=cancelled");
check("a used code: failed", (await cb(`state=${state}&code=used-code`)).headers.get("Location"), "https://app.averages.io/?google=failed");
check("no Google traffic before the state checks pass", tokenRequests.length, 1);

tokenRequests = [];
const ok = await cb(`state=${state}&code=good-code`);
check("signed in: back to login, ok", ok.headers.get("Location"), "https://app.averages.io/?google=ok");
const sent = tokenRequests[0];
check("code exchange used our secret, callback and the PKCE verifier", [sent.get("client_secret"), sent.get("redirect_uri"), sent.get("grant_type"), await codeChallenge(sent.get("code_verifier") ?? "")], [CLIENT_SECRET, "https://api.averages.io/auth/google/callback", "authorization_code", consent.searchParams.get("code_challenge")]);
check("state cookie cleared", setCookies(ok).some((c) => c.startsWith(`${STATE_COOKIE}=;`) && c.includes("Max-Age=0")), true);
const sessionCookieHeader = setCookies(ok).find((c) => c.startsWith(SESSION_COOKIE + "=")) ?? "";
check("session cookie on .averages.io for 30 days", sessionCookieHeader.split("; ").slice(1), ["Path=/", "Domain=.averages.io", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=2592000"]);
const token = cookieValue(ok, SESSION_COOKIE)!;
const opened = await openSession(token, SECRET);
check("session: Google uid, no Schoology keys, 13+ not Incognito", [opened?.uid, opened?.key, opened?.secret, opened?.inc, opened?.g?.sc, opened?.g?.rt], ["g:109876543210", "", "", undefined, "cwmart", "1//refresh-token"]);
check("the token never appears in the redirect", (ok.headers.get("Location") ?? "").includes("ya29"), false);

const me = await call("/auth/me", { cookie: `${SESSION_COOKIE}=${token}` });
check("/auth/me", await me.json(), { uid: "g:109876543210", name: "Sam Student", firstName: "Sam", email: "sam@school.example", pictureUrl: "https://lh3.googleusercontent.com/a/sam", incognito: false, provider: "google" });

// Under 13 (the default when the login page doesn't say 13+).
const start13 = await call("/auth/google/start");
const s13 = new URL(start13.headers.get("Location")!).searchParams.get("state")!;
const ok13 = await cb(`state=${s13}&code=good-code`, `${STATE_COOKIE}=${cookieValue(start13, STATE_COOKIE)}`);
check("under 13: Incognito sealed in", (await openSession(cookieValue(ok13, SESSION_COOKIE)!, SECRET))?.inc, true);

google = tokenEndpoint({ scope: "openid " + CLASSROOM_SCOPES.c });
const noWork = await cb(`state=${state}&code=good-code`);
check("coursework permission unticked: explained, not signed in", [noWork.headers.get("Location"), cookieValue(noWork, SESSION_COOKIE)], ["https://app.averages.io/?google=permissions", null]);
google = tokenEndpoint({ refresh: null });
check("no refresh token: failed", (await cb(`state=${state}&code=good-code`)).headers.get("Location"), "https://app.averages.io/?google=failed");

/* ── Classroom data ────────────────────────────────────────────────────── */

const C = "https://classroom.googleapis.com/v1";
let classroomStatus = 200;
let classroomAuth: string[] = [];
function classroom(extra: Handler = tokenEndpoint()): Handler {
  return async (url, init) => {
    if (!url.href.startsWith(C)) return extra(url, init);
    classroomAuth.push(new Headers(init.headers).get("Authorization") ?? "");
    if (classroomStatus !== 200) return json({ error: { code: classroomStatus } }, classroomStatus);
    const p = url.pathname.replace("/v1", "");
    if (p === "/courses") return json({ courses: [{ id: "111", name: "Biology", alternateLink: "https://classroom.google.com/c/MTEx", updateTime: "2026-10-01T00:00:00Z" }] });
    if (p === "/courses/111/courseWork") {
      return json({
        courseWork: [
          { id: "1", title: "Lab report", maxPoints: 20, dueDate: { year: 2026, month: 10, day: 3 }, dueTime: { hours: 6, minutes: 59 }, materials: [{ driveFile: { driveFile: { id: "1LabTemplate0", title: "Lab template.docx", alternateLink: "https://drive.google.com/file/d/1LabTemplate0/view" } } }], updateTime: "2026-10-01T00:00:00Z" },
          { id: "2", title: "Essay", maxPoints: 100, dueDate: { year: 2099, month: 1, day: 1 }, dueTime: { hours: 12, minutes: 0 } },
        ],
      });
    }
    if (p === "/courses/111/courseWork/-/studentSubmissions") return json({ studentSubmissions: [{ courseWorkId: "1", state: "RETURNED", assignedGrade: 18, updateTime: "2026-10-04T00:00:00Z" }, { courseWorkId: "2", state: "CREATED" }] });
    if (p === "/courses/111/announcements") return json({ announcements: [{ id: "9", text: "No class Friday", updateTime: "2026-10-05T00:00:00Z" }] });
    if (p === "/courses/111/courseWorkMaterials") return json({ courseWorkMaterial: [{ id: "900", title: "Notes", updateTime: "2026-10-05T00:00:00Z", materials: [{ driveFile: { driveFile: { id: "1NotesDoc00", title: "Notes", alternateLink: "https://docs.google.com/document/d/1NotesDoc00/edit" } } }] }] });
    if (p === "/courses/111/courseWork/2") return json({ id: "2", title: "Essay", description: "Five paragraphs.", maxPoints: 100, alternateLink: "https://classroom.google.com/c/MTEx/a/Mg/details", dueDate: { year: 2099, month: 1, day: 1 }, dueTime: { hours: 12, minutes: 0 }, materials: [{ link: { url: "https://example.com/rubric", title: "Rubric" } }] });
    if (p === "/courses/111/courseWork/2/studentSubmissions") return json({ studentSubmissions: [{ id: "s2", state: "CREATED", alternateLink: "https://classroom.google.com/c/MTEx/a/Mg/submissions/student/X" }] });
    return json({ error: { code: 404 } }, 404);
  };
}

console.log("\n/data/bundle (Classroom)");
google = classroom();
classroomAuth = [];
const live = `${SESSION_COOKIE}=${token}`;
const bundleRes = await call("/data/bundle?tz=America/Los_Angeles", { cookie: live });
const bundle: any = await bundleRes.json();
check("200, platform classroom", [bundleRes.status, bundle.platform], [200, "classroom"]);
check("grade from returned work", bundle.COURSES.map((c: any) => [c.name, c.grade, c.pct]), [["Biology", "A-", 90]]);
check("upcoming has the essay, in LA time", bundle.UPCOMING.map((u: any) => [u.title, u.due]), [["Essay", "Thu Jan 1"]]);
check("announcement in Home's course updates", bundle.COURSE_UPDATES.map((m: any) => m.body), ["No class Friday"]);
check("Classroom called with the student's token only", [...new Set(classroomAuth)], ["Bearer ya29.first"]);
check("no Schoology traffic", calls.some((x) => x.url.hostname.includes("schoology")), false);

console.log("\ntoken refresh");
// Same session, its sign-in access token about to run out (sealed by hand, keeping uid and expiry).
const expiringSession = { ...opened!, g: { ...opened!.g!, ax: Math.floor(Date.now() / 1000) + 30 } };
const expiring = await (async () => {
  // sealSession sets a new exp; put the original back by sealing a copy with the same fields.
  const { exp: _e, ...rest } = expiringSession;
  return sealSession(rest as any, SECRET);
})();
const expiringOpened = await openSession(expiring, SECRET);
tokenRequests = [];
classroomAuth = [];
const refreshed = await call("/data/bundle", { cookie: `${SESSION_COOKIE}=${expiring}` });
check("refreshed with the refresh token", [refreshed.status, tokenRequests[0]?.get("grant_type"), tokenRequests[0]?.get("refresh_token")], [200, "refresh_token", "1//refresh-token"]);
check("new token used for Classroom", [...new Set(classroomAuth)], ["Bearer ya29.refreshed"]);
check("session cookie NOT rewritten (keeps its 30 days, sign-out can't be undone)", cookieValue(refreshed, SESSION_COOKIE), null);
const accessHeader = setCookies(refreshed).find((c) => c.startsWith(ACCESS_COOKIE + "=")) ?? "";
check("fresh token in its own host-only httpOnly cookie, about an hour", [accessHeader.split("; ").slice(1, 5), Number((accessHeader.match(/Max-Age=(\d+)/) ?? [])[1]) > 3000], [["Path=/", "HttpOnly", "Secure", "SameSite=Lax"], true]);
const access = cookieValue(refreshed, ACCESS_COOKIE)!;
tokenRequests = [];
classroomAuth = [];
const reused = await call("/data/bundle", { cookie: `${SESSION_COOKIE}=${expiring}; ${ACCESS_COOKIE}=${access}` });
check("next request reuses it: no second refresh", [reused.status, tokenRequests.length, [...new Set(classroomAuth)]], [200, 0, ["Bearer ya29.refreshed"]]);
const otherSession = await sealValue({ uid: expiringOpened!.uid, exp: expiringOpened!.exp + 1, at: "ya29.someone-else", ax: Math.floor(Date.now() / 1000) + 3000 }, SECRET, ACCESS_PURPOSE, 3000);
tokenRequests = [];
classroomAuth = [];
await call("/data/bundle", { cookie: `${SESSION_COOKIE}=${expiring}; ${ACCESS_COOKIE}=${otherSession}` });
check("a token cookie from another session isn't used", [tokenRequests.length, [...new Set(classroomAuth)]], [1, ["Bearer ya29.refreshed"]]);
const out = await call("/auth/session", { method: "DELETE", cookie: `${SESSION_COOKIE}=${expiring}; ${ACCESS_COOKIE}=${access}` });
check("sign out clears both cookies", [SESSION_COOKIE, ACCESS_COOKIE].map((n) => setCookies(out).some((c) => c.startsWith(`${n}=;`) && c.includes("Max-Age=0"))), [true, true]);
const accessOnly = await call("/data/bundle", { cookie: `${ACCESS_COOKIE}=${access}` });
check("the token cookie alone is not a session", accessOnly.status, 401);

google = classroom(tokenEndpoint({ refreshError: "invalid_grant" }));
const revoked = await call("/data/bundle", { cookie: `${SESSION_COOKIE}=${expiring}` });
check("access removed in Google: signed out", [revoked.status, (await revoked.json() as any).error, setCookies(revoked).some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && c.includes("Max-Age=0"))], [401, "session_expired", true]);

google = classroom();
classroomStatus = 401;
const c401 = await call("/data/bundle", { cookie: live });
check("Classroom rejects the token: signed out", [c401.status, (await c401.json() as any).error], [401, "session_expired"]);
classroomStatus = 403;
const c403 = await call("/data/bundle", { cookie: live });
check("Classroom refuses (school turned it off): 502, still signed in", [c403.status, (await c403.json() as any).error, cookieValue(c403, SESSION_COOKIE)], [502, "classroom_error", null]);
classroomStatus = 200;

console.log("\n/data/assignment (Classroom)");
const a = await call("/data/assignment?section=111&id=2&tz=UTC", { cookie: live });
const ad: any = await a.json();
check("assignment detail", [a.status, ad.title, ad.description, ad.platform, ad.classroomUrl, ad.submission.state, ad.links], [200, "Essay", "Five paragraphs.", "classroom", "https://classroom.google.com/c/MTEx/a/Mg/submissions/student/X", "not_turned_in", [{ title: "Rubric", url: "https://example.com/rubric" }]]);
check("ids are checked before any call", (await call("/data/assignment?section=111&id=../x", { cookie: live })).status, 400);

console.log("\n/data/files (Classroom)");
const f = await call("/data/files", { cookie: live });
const fd: any = await f.json();
check("Drive files as links", [f.status, fd.platform, fd.files.map((x: any) => [x.name, x.ext, x.kind, x.url])], [200, "classroom", [["Notes", "gdoc", "material", "https://docs.google.com/document/d/1NotesDoc00/edit"], ["Lab template.docx", "docx", "assignment", "https://drive.google.com/file/d/1LabTemplate0/view"]]]);
check("files list has the class", fd.courses.map((x: any) => x.name), ["Biology"]);

console.log("\nSchoology-only routes refuse a Google session");
const att = await call("/data/attachment?section=111&assignment=2&file=3", { cookie: live });
check("download: open it in Drive instead", [att.status, (await att.json() as any).error], [404, "classroom_files_open_in_drive"]);
const edit = await call("/canva/edit", { method: "POST", cookie: live, headers: { "Content-Type": "application/json", Origin: "https://app.averages.io" }, body: JSON.stringify({ section: "111", assignment: "2", fileId: "3" }) });
check("Edit in Canva: not for Classroom files", [edit.status, (await edit.json() as any).error], [403, "classroom_not_supported"]);

console.log("\nforged sessions");
const noTokens = await sealSession({ key: "", secret: "", uid: "g:1" } as any, SECRET);
check("Google uid without tokens: refused", (await call("/auth/me", { cookie: `${SESSION_COOKIE}=${noTokens}` })).status, 401);
const tokensOnSchoology = await sealSession({ key: "k", secret: "s", uid: "4242", g: opened!.g } as any, SECRET);
check("Google tokens on a Schoology uid: refused", (await call("/auth/me", { cookie: `${SESSION_COOKIE}=${tokensOnSchoology}` })).status, 401);

console.log("\nsubrequest budget");
let classroomCalls = 0;
google = async (url) => {
  if (!url.href.startsWith(C)) return json({}, 404);
  classroomCalls++;
  const p = url.pathname.replace("/v1", "");
  if (p === "/courses") return json({ courses: Array.from({ length: 20 }, (_, i) => ({ id: String(1000 + i), name: `Class ${i}` })), nextPageToken: "more" });
  return json({ courseWork: [], studentSubmissions: [], announcements: [], nextPageToken: "more" });
};
const big = await call("/data/bundle", { cookie: live });
const bigData: any = await big.json();
console.log("    Classroom calls:", classroomCalls);
check("12 classes, every one with more pages: stays under 50 calls", [big.status, bigData.COURSES.length, classroomCalls <= 42, bigData.partial], [200, 12, true, true]);

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
