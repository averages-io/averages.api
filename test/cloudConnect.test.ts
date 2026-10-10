/**
 * Google Drive and OneDrive that stay connected (2026-10-08): src/cloudConnect.ts
 * through the real Worker routes (/cloud/*), with a sealed session cookie.
 *
 * No Durable Object or network: CLOUD is an in-memory stand-in that keeps one
 * CloudAccount per student (as a Durable Object would), and globalThis.fetch
 * plays Google's and Microsoft's token and revoke endpoints. Anything else
 * leaving the Worker fails the test.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/cloudConnect.test.ts
 */
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { DEMO_UID, SESSION_COOKIE, sealSession } from "../src/session.ts";
import { REVIEW_UID, SANDBOX_KEY, SANDBOX_SECRET } from "../src/reviewSandbox.ts";
import { codeChallenge, b64url, type CanvaStorage } from "../src/canva.ts";
import {
  CloudAccount,
  DRIVE_FILE_SCOPE,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_ENDPOINT,
  MS_AUTHORIZE_URL,
  MS_TOKEN_URL,
  openConnection,
  openLost,
  parseScopes,
  sealConnection,
  sealLost,
  validLoginHint,
  type CloudApp,
} from "../src/cloudConnect.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

/* ── Fake Google and Microsoft ─────────────────────────────────────────── */

type Call = { url: string; method: string; form: Record<string, string>; signal: boolean };
const calls: Call[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/** What each endpoint answers next; tests swap these. */
const answer: Record<string, (form: Record<string, string>) => Response | Promise<Response>> = {};
let counter = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const form = Object.fromEntries(new URLSearchParams(typeof init.body === "string" ? init.body : ""));
  calls.push({ url, method: init.method ?? "GET", form, signal: !!init.signal });
  if (url === GOOGLE_TOKEN_ENDPOINT) return answer[`google:${form.grant_type}`](form);
  if (url === MS_TOKEN_URL) return answer[`ms:${form.grant_type}`](form);
  if (url === GOOGLE_REVOKE_URL) return answer.revoke ? answer.revoke(form) : new Response("", { status: 200 });
  throw new Error(`unexpected network call: ${url}`);
}) as typeof fetch;

function idToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

const G_CLIENT = "123456789012-abcdefgh12345678.apps.googleusercontent.com";
const G_DRIVE_CLIENT = "123456789012-drivedrive12345678.apps.googleusercontent.com";
const MS_CLIENT = "c006202b-180f-4d4c-b03c-c0f43048c8e9";
const G_SCOPE_GRANTED = `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/userinfo.profile`;

function defaultAnswers() {
  answer["google:authorization_code"] = (f) =>
    json({
      access_token: `g-at-${++counter}`,
      expires_in: 3599,
      refresh_token: "g-rt-1",
      scope: G_SCOPE_GRANTED,
      token_type: "Bearer",
      id_token: idToken({ iss: "https://accounts.google.com", aud: f.client_id, sub: "111", email: "sam@example.com", name: "Sam Student" }),
    });
  answer["google:refresh_token"] = () => json({ access_token: `g-at-${++counter}`, expires_in: 3599, scope: G_SCOPE_GRANTED, token_type: "Bearer" });
  answer["ms:authorization_code"] = (f) =>
    json({
      access_token: `ms-at-${++counter}`,
      expires_in: 3600,
      refresh_token: "ms-rt-1",
      // Microsoft names Graph scopes in full sometimes.
      scope: f.scope.includes("Files.Read ") || f.scope.endsWith("Files.Read")
        ? "https://graph.microsoft.com/Files.Read https://graph.microsoft.com/Files.ReadWrite.AppFolder https://graph.microsoft.com/User.Read openid profile email"
        : "https://graph.microsoft.com/Files.ReadWrite.AppFolder https://graph.microsoft.com/User.Read openid profile email",
      id_token: idToken({ aud: f.client_id, preferred_username: "sam@outlook.com", name: "Sam O" }),
    });
  let ms = 1;
  // Microsoft answers with what this token can do: the scopes asked for, less offline_access.
  answer["ms:refresh_token"] = (f) =>
    json({ access_token: `ms-at-${++counter}`, expires_in: 3600, refresh_token: `ms-rt-${++ms}`, scope: f.scope.split(" ").filter((x) => x !== "offline_access").join(" ") });
  delete answer.revoke;
}
defaultAnswers();

/* ── Fake CloudStore namespace ─────────────────────────────────────────── */

class MemoryStorage implements CanvaStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
}

const SECRET = "cloud-connect-test-session-secret";
const objects = new Map<string, { storage: MemoryStorage; account: CloudAccount }>();
const jurisdictions: string[] = [];
/** Env the fake Durable Objects see (they get the Worker's env, like the real ones). */
let doEnv: any = {};
const CLOUD: any = {
  jurisdiction: (j: string) => { jurisdictions.push(j); return CLOUD; },
  idFromName: (name: string) => name,
  get: (id: string) => {
    let o = objects.get(id);
    if (!o) {
      const storage = new MemoryStorage();
      o = { storage, account: new CloudAccount(storage, { get SESSION_SECRET() { return doEnv.SESSION_SECRET; }, get GOOGLE_CLIENT_ID() { return doEnv.GOOGLE_CLIENT_ID; }, get GOOGLE_CLIENT_SECRET() { return doEnv.GOOGLE_CLIENT_SECRET; }, get GOOGLE_DRIVE_CLIENT_ID() { return doEnv.GOOGLE_DRIVE_CLIENT_ID; }, get GOOGLE_DRIVE_CLIENT_SECRET() { return doEnv.GOOGLE_DRIVE_CLIENT_SECRET; }, get MS_CLIENT_ID() { return doEnv.MS_CLIENT_ID; }, get MS_CLIENT_SECRET() { return doEnv.MS_CLIENT_SECRET; } }) };
      objects.set(id, o);
    }
    return o.account;
  },
};

const BASE_ENV = {
  SESSION_SECRET: SECRET,
  GOOGLE_CLIENT_ID: G_CLIENT,
  GOOGLE_CLIENT_SECRET: "google-client-secret-value",
  MS_CLIENT_ID: MS_CLIENT,
  MS_CLIENT_SECRET: "ms-client-secret-value",
  CLOUD,
};
const DRIVE_ENV = { ...BASE_ENV, GOOGLE_DRIVE_CLIENT_ID: G_DRIVE_CLIENT, GOOGLE_DRIVE_CLIENT_SECRET: "drive-client-secret-value" };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";
const APP = "https://app.averages.io";

async function cookieFor(uid: string, extra: Record<string, unknown> = {}): Promise<string> {
  const token = await sealSession({ uid, key: "k", secret: "s", ...extra } as any, SECRET);
  return `${SESSION_COOKIE}=${token}`;
}

type Init = { method?: string; cookie?: string; json?: unknown; body?: string; headers?: Record<string, string>; env?: any; base?: string };
async function call(path: string, init: Init = {}) {
  resetRateLimits(); // the rules are tested in ratelimit.test.ts; here many calls come from one student
  const env = init.env ?? BASE_ENV;
  doEnv = env;
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", APP);
  if (init.cookie) headers.set("Cookie", init.cookie);
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("Content-Type", "application/json");
  }
  const res = await worker.fetch(new Request((init.base ?? API) + path, { method: init.method ?? "GET", headers, body, redirect: "manual" }), env, CTX);
  const type = res.headers.get("Content-Type") ?? "";
  const data: any = type.includes("json") ? await res.clone().json() : null;
  return { res, data, location: res.headers.get("Location") ?? "" };
}

const token = (app: CloudApp, cookie: string, env?: any) => call(`/cloud/${app}/token`, { method: "POST", cookie, json: {}, env });
const status = (cookie: string, env?: any) => call("/cloud/status", { cookie, env });

/** Starts a connect and answers the authorize URL's parameters. */
async function startConnect(app: CloudApp, cookie: string, query = "", env?: any) {
  const r = await call(`/cloud/${app}/connect${query}`, { cookie, env });
  const url = new URL(r.location);
  return { ...r, url, params: Object.fromEntries(url.searchParams), state: url.searchParams.get("state") ?? "" };
}

/** Connect + callback in one go; answers the callback's redirect. */
async function connect(app: CloudApp, cookie: string, query = "", env?: any) {
  const start = await startConnect(app, cookie, query, env);
  const back = await call(`/cloud/${app}/callback?code=good-code&state=${start.state}`, { cookie, env });
  return { start, back };
}

/** Moves a stored connection's access-token expiry (they're sealed, so open, edit, reseal). */
async function setAccessLeft(uid: string, app: CloudApp, seconds: number) {
  const o = objects.get(uid)!;
  const sealed = (await o.storage.get<string>(`conn:${app}`))!;
  const conn = (await openConnection(sealed, uid, app, SECRET))!;
  conn.accessExp = Math.floor(Date.now() / 1000) + seconds;
  await o.storage.put(`conn:${app}`, await sealConnection(conn, uid, app, SECRET));
}
async function stored(uid: string, app: CloudApp) {
  const sealed = await objects.get(uid)?.storage.get<string>(`conn:${app}`);
  return sealed ? openConnection(sealed, uid, app, SECRET) : null;
}
const tokenCalls = (url: string) => calls.filter((c) => c.url === url);

/* ── helpers ───────────────────────────────────────────────────────────── */
console.log("\nhelpers");
check("login_hint: emails only", [validLoginHint("sam@example.com"), validLoginHint("not an email"), validLoginHint("a@b.c\r\nX: y"), validLoginHint("x".repeat(250) + "@a.com"), validLoginHint(5)], ["sam@example.com", null, null, null, null]);
check("Graph scopes shortened, duplicates dropped", parseScopes("onedrive", "https://graph.microsoft.com/Files.Read Files.Read User.Read"), ["Files.Read", "User.Read"]);
check("Google scopes kept as they are", parseScopes("gdrive", `openid ${DRIVE_FILE_SCOPE}`), ["openid", DRIVE_FILE_SCOPE]);
{
  const conn = { client: "c", refresh: "r", access: "a", accessExp: 1, scopes: [], email: "", name: "", connectedAt: 0 };
  const sealed = await sealConnection(conn, "123", "gdrive", SECRET);
  check("sealed: no token in the clear", sealed.includes("\"r\"") || sealed.includes("refresh"), false);
  check("sealed: opens only for its own student and app", [!!(await openConnection(sealed, "123", "gdrive", SECRET)), await openConnection(sealed, "124", "gdrive", SECRET), await openConnection(sealed, "123", "onedrive", SECRET), await openConnection(sealed, "123", "gdrive", "other-secret")], [true, null, null, null]);
}

/* ── status ────────────────────────────────────────────────────────────── */
console.log("\nstatus");
const SAM = "4242";
const sam = await cookieFor(SAM);
{
  const none = await status(sam, { SESSION_SECRET: SECRET, CLOUD });
  const off = { configured: false, connected: false, lost: false, email: "", name: "", scopes: [] };
  check("nothing set up: both configured false, no Durable Object opened", [none.res.status, none.data, objects.size], [200, { gdrive: off, onedrive: off }, 0]);
  const msOnly = await status(sam, { ...BASE_ENV, MS_CLIENT_SECRET: undefined });
  check("OneDrive without MS_CLIENT_SECRET: not configured", [msOnly.data.gdrive.configured, msOnly.data.onedrive.configured], [true, false]);
  const gNoSecret = await status(sam, { ...BASE_ENV, GOOGLE_CLIENT_SECRET: undefined });
  check("Google without a secret: not configured", gNoSecret.data.gdrive.configured, false);
  const noSession = await status(sam, { ...BASE_ENV, SESSION_SECRET: undefined });
  check("no SESSION_SECRET: no session at all (401)", noSession.res.status, 401);
  const bad = await status(sam, { ...BASE_ENV, GOOGLE_CLIENT_ID: "GOCSPX-a-secret-in-the-wrong-box", MS_CLIENT_ID: "not-a-guid" });
  check("client IDs in the wrong shape: not configured", [bad.data.gdrive.configured, bad.data.onedrive.configured], [false, false]);
  const fresh = await status(sam);
  const on = { configured: true, connected: false, lost: false, email: "", name: "", scopes: [] };
  check("set up, not connected", [fresh.res.status, fresh.data, fresh.res.headers.get("Cache-Control")], [200, { gdrive: on, onedrive: on }, "private, no-store"]);
  check("opened in the us jurisdiction", jurisdictions.at(-1), "us");
  const before = jurisdictions.length;
  await call("/cloud/status", { cookie: sam, base: "http://localhost:8787", headers: { Origin: "http://localhost:3000" } });
  check("on localhost (wrangler dev): no jurisdiction", jurisdictions.length, before);
  check("no cookie: 401", (await call("/cloud/status")).res.status, 401);
  check("demo: 403 not_available_in_demo", (await status(await cookieFor(DEMO_UID))).data, { error: "not_available_in_demo" });
}

/* ── connect: Google ───────────────────────────────────────────────────── */
console.log("\nconnect: Google Drive");
{
  const s = await startConnect("gdrive", sam, "?return_to=%2Ffiles&login_hint=sam%40example.com");
  check("302 to Google's authorize URL", [s.res.status, `${s.url.origin}${s.url.pathname}`], [302, GOOGLE_AUTHORIZE_URL]);
  const p = s.params;
  check("client, callback, code flow", [p.client_id, p.redirect_uri, p.response_type], [G_CLIENT, `${API}/cloud/gdrive/callback`, "code"]);
  check("scopes: openid email profile drive.file drive.install", p.scope, `openid email profile ${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive.install`);
  check("scope separator is %20, never +", s.location.includes("scope=openid%20email%20profile%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file"), true);
  check("offline + consent (a refresh token every time)", [p.access_type, p.prompt], ["offline", "consent"]);
  check("PKCE S256 and a 32-character state", [p.code_challenge_method, /^[A-Za-z0-9_-]{43}$/.test(p.code_challenge), /^[A-Za-z0-9_-]{32}$/.test(s.state)], ["S256", true, true]);
  check("login_hint passed on", p.login_hint, "sam@example.com");
  check("sign-in client: earlier grants (Classroom) not merged in", p.include_granted_scopes, undefined);
  check("no secret in the URL", s.location.includes("google-client-secret-value"), false);
  const pending = (await objects.get(SAM)!.storage.get<Record<string, any>>("connect"))!;
  check("state remembered in the student's own object, with where to go back", [pending[s.state]?.app, pending[s.state]?.returnTo, pending[s.state]?.exp - Math.floor(Date.now() / 1000) <= 600], ["gdrive", "/files", true]);
  check("the verifier never leaves the Worker", s.location.includes(pending[s.state].verifier), false);
  check("challenge = S256(verifier)", p.code_challenge, await codeChallenge(pending[s.state].verifier));

  const badHint = await startConnect("gdrive", sam, "?login_hint=not%20an%20email");
  check("a login_hint that isn't an email is left out", badHint.params.login_hint, undefined);
  const drive = await startConnect("gdrive", sam, "", DRIVE_ENV);
  check("Drive client (with its own secret): used, with include_granted_scopes", [drive.params.client_id, drive.params.include_granted_scopes], [G_DRIVE_CLIENT, "true"]);
  const driveNoSecret = await startConnect("gdrive", sam, "", { ...DRIVE_ENV, GOOGLE_DRIVE_CLIENT_SECRET: undefined });
  check("Drive client without a secret: falls back to the sign-in client", driveNoSecret.params.client_id, G_CLIENT);
}

/* ── connect: OneDrive ─────────────────────────────────────────────────── */
console.log("\nconnect: OneDrive");
{
  const s = await startConnect("onedrive", sam, "?login_hint=sam%40outlook.com");
  const p = s.params;
  check("302 to Microsoft's authorize URL", [s.res.status, `${s.url.origin}${s.url.pathname}`], [302, MS_AUTHORIZE_URL]);
  check("client, callback, query response, account picker", [p.client_id, p.redirect_uri, p.response_type, p.response_mode, p.prompt], [MS_CLIENT, `${API}/cloud/onedrive/callback`, "code", "query", "select_account"]);
  check("scopes without Files.Read", p.scope, "openid profile email offline_access User.Read Files.ReadWrite.AppFolder");
  check("PKCE and login_hint", [p.code_challenge_method, p.login_hint], ["S256", "sam@outlook.com"]);
  const read = await startConnect("onedrive", sam, "?read=1");
  check("read=1 adds Files.Read", read.params.scope, "openid profile email offline_access User.Read Files.ReadWrite.AppFolder Files.Read");
}

/* ── where the browser goes ────────────────────────────────────────────── */
console.log("\nredirects");
{
  check("no session: to the app's start page", (await call("/cloud/gdrive/connect")).location, `${APP}/`);
  check("demo: to the app's start page", (await call("/cloud/gdrive/connect", { cookie: await cookieFor(DEMO_UID) })).location, `${APP}/`);
  const inc = await cookieFor(SAM, { inc: true });
  check("Incognito: Settings explains", (await call("/cloud/gdrive/connect", { cookie: inc })).location, `${APP}/settings?cloud=incognito&app=gdrive`);
  check("not configured: back to return_to with not_configured", (await call("/cloud/onedrive/connect?return_to=/files", { cookie: sam, env: { ...BASE_ENV, MS_CLIENT_SECRET: "" } })).location, `${APP}/files?cloud=not_configured&app=onedrive`);
  for (const evil of ["//evil.example", "https://evil.example/", "/\\evil.example", "javascript:alert(1)", "/a b"]) {
    const r = await call(`/cloud/onedrive/connect?return_to=${encodeURIComponent(evil)}`, { cookie: sam, env: { ...BASE_ENV, MS_CLIENT_SECRET: "" } });
    check(`return_to ${JSON.stringify(evil)} can't leave the app`, r.location, `${APP}/settings?cloud=not_configured&app=onedrive`);
  }
  check("an unknown app: 404", (await call("/cloud/dropbox/connect", { cookie: sam })).res.status, 404);
  check("local dev: back to localhost:3000", (await call("/cloud/gdrive/connect", { base: "http://localhost:8787", headers: { Origin: "http://localhost:3000" } })).location, "http://localhost:3000/");
}

/* ── callback ──────────────────────────────────────────────────────────── */
console.log("\ncallback: Google Drive");
{
  calls.length = 0;
  const start = await startConnect("gdrive", sam, "?return_to=%2Ffiles%3Fx%3D1");
  const back = await call(`/cloud/gdrive/callback?code=good-code&state=${start.state}`, { cookie: sam });
  check("connected: back to the page, ?cloud=connected&app=gdrive", [back.res.status, back.location], [302, `${APP}/files?x=1&cloud=connected&app=gdrive`]);
  check("Referrer-Policy no-referrer, no-store", [back.res.headers.get("Referrer-Policy"), back.res.headers.get("Cache-Control")], ["no-referrer", "no-store"]);
  const ex = tokenCalls(GOOGLE_TOKEN_ENDPOINT)[0];
  check("code exchanged server side, with the client secret and the same callback", [ex.form.grant_type, ex.form.code, ex.form.client_id, ex.form.client_secret, ex.form.redirect_uri], ["authorization_code", "good-code", G_CLIENT, "google-client-secret-value", `${API}/cloud/gdrive/callback`]);
  check("PKCE: the verifier matches the challenge", await codeChallenge(ex.form.code_verifier), start.params.code_challenge);
  check("with a 15 s timeout signal", ex.signal, true);
  const st = await status(sam);
  check("status: connected, who, scopes", st.data.gdrive, { configured: true, connected: true, lost: false, email: "sam@example.com", name: "Sam Student", scopes: parseScopes("gdrive", G_SCOPE_GRANTED) });
  const raw = await objects.get(SAM)!.storage.get<string>("conn:gdrive");
  check("stored sealed (no token, no email in the clear)", [typeof raw, raw!.includes("g-rt-1"), raw!.includes("sam@example.com")], ["string", false, false]);
  const kept = await stored(SAM, "gdrive");
  check("stored: refresh token, scopes, email, name, when", [kept?.refresh, kept?.email, kept?.name, Math.abs(Date.now() - (kept?.connectedAt ?? 0)) < 5000, kept?.client], ["g-rt-1", "sam@example.com", "Sam Student", true, G_CLIENT]);
  const replay = await call(`/cloud/gdrive/callback?code=good-code&state=${start.state}`, { cookie: sam });
  check("the same state twice: failed", replay.location, `${APP}/settings?cloud=failed&app=gdrive`);

  const forged = await call(`/cloud/gdrive/callback?code=x&state=${"A".repeat(32)}`, { cookie: sam });
  check("a state we never handed out: failed", forged.location, `${APP}/settings?cloud=failed&app=gdrive`);
  check("a malformed state: failed", (await call("/cloud/gdrive/callback?code=x&state=__proto__", { cookie: sam })).location, `${APP}/settings?cloud=failed&app=gdrive`);
  check("no code: failed", (await call(`/cloud/gdrive/callback?state=${(await startConnect("gdrive", sam)).state}`, { cookie: sam })).location, `${APP}/settings?cloud=failed&app=gdrive`);

  const otherStudent = await startConnect("gdrive", await cookieFor("5555"));
  check("another student's state: failed (it's in their own object)", (await call(`/cloud/gdrive/callback?code=x&state=${otherStudent.state}`, { cookie: sam })).location, `${APP}/settings?cloud=failed&app=gdrive`);

  const msState = await startConnect("onedrive", sam, "?return_to=/files");
  check("a OneDrive state on the Google callback: failed", (await call(`/cloud/gdrive/callback?code=x&state=${msState.state}`, { cookie: sam })).location, `${APP}/settings?cloud=failed&app=gdrive`);

  const old = await startConnect("gdrive", sam, "?return_to=/files");
  const pending = (await objects.get(SAM)!.storage.get<Record<string, any>>("connect"))!;
  pending[old.state].exp = Math.floor(Date.now() / 1000) - 1;
  await objects.get(SAM)!.storage.put("connect", pending);
  calls.length = 0;
  check("an expired state (over 10 minutes): failed, Google not asked", [(await call(`/cloud/gdrive/callback?code=x&state=${old.state}`, { cookie: sam })).location, calls.length], [`${APP}/settings?cloud=failed&app=gdrive`, 0]);

  const cancel = await startConnect("gdrive", sam, "?return_to=/files");
  const cancelled = await call(`/cloud/gdrive/callback?error=access_denied&state=${cancel.state}`, { cookie: sam });
  check("cancelled: back to the page with cloud=cancelled", cancelled.location, `${APP}/files?cloud=cancelled&app=gdrive`);
  check("and that state is used up", (await call(`/cloud/gdrive/callback?code=x&state=${cancel.state}`, { cookie: sam })).location, `${APP}/settings?cloud=failed&app=gdrive`);
  check("another provider error: failed", (await call("/cloud/gdrive/callback?error=server_error", { cookie: sam })).location, `${APP}/settings?cloud=failed&app=gdrive`);
  check("no session at the callback: start page", (await call(`/cloud/gdrive/callback?code=x&state=${cancel.state}`)).location, `${APP}/`);
  check("Incognito at the callback", (await call("/cloud/gdrive/callback?code=x&state=y", { cookie: await cookieFor(SAM, { inc: true }) })).location, `${APP}/settings?cloud=incognito&app=gdrive`);
}
{
  const NEW = "6001";
  const c = await cookieFor(NEW);
  answer["google:authorization_code"] = (f) => json({ access_token: "g-at-x", expires_in: 3599, scope: G_SCOPE_GRANTED, id_token: idToken({ aud: f.client_id, email: "a@b.co" }) });
  const { back } = await connect("gdrive", c, "?return_to=/files");
  check("no refresh token from Google: failed, nothing stored", [back.location, await stored(NEW, "gdrive")], [`${APP}/files?cloud=failed&app=gdrive`, null]);
  answer["google:authorization_code"] = (f) => json({ access_token: "g-at-x", expires_in: 3599, refresh_token: "g-rt-x", scope: "openid https://www.googleapis.com/auth/userinfo.email", id_token: idToken({ aud: f.client_id }) });
  const noDrive = await connect("gdrive", c, "?return_to=/files");
  check("Drive unticked on Google's screen: drive_not_allowed, nothing stored", [noDrive.back.location, await stored(NEW, "gdrive")], [`${APP}/files?cloud=drive_not_allowed&app=gdrive`, null]);
  answer["google:authorization_code"] = () => json({ error: "invalid_grant" }, 400);
  check("code refused by Google: failed", (await connect("gdrive", c)).back.location, `${APP}/settings?cloud=failed&app=gdrive`);
  answer["google:authorization_code"] = () => { throw new Error("network down"); };
  check("Google unreachable: failed", (await connect("gdrive", c)).back.location, `${APP}/settings?cloud=failed&app=gdrive`);
  answer["google:authorization_code"] = (f) => json({ access_token: "g-at-x", expires_in: 3599, refresh_token: "g-rt-x", scope: G_SCOPE_GRANTED, id_token: idToken({ aud: "someone-else", email: "evil@x.co" }) });
  await connect("gdrive", c);
  check("an id_token for another client: connected, but no name or email taken from it", [(await stored(NEW, "gdrive"))?.email, (await stored(NEW, "gdrive"))?.refresh], ["", "g-rt-x"]);
  defaultAnswers();
}

/* ── tokens: Google ────────────────────────────────────────────────────── */
console.log("\ntokens: Google Drive");
{
  calls.length = 0;
  const t1 = await token("gdrive", sam);
  check("the cached access token while it has over 5 minutes", [t1.res.status, t1.data.access_token.startsWith("g-at-"), t1.data.expires_in > 3500, t1.data.email, t1.data.scopes.includes(DRIVE_FILE_SCOPE), tokenCalls(GOOGLE_TOKEN_ENDPOINT).length], [200, true, true, "sam@example.com", true, 0]);
  check("Cache-Control no-store", t1.res.headers.get("Cache-Control"), "no-store");
  check("answer has exactly the contract's fields", Object.keys(t1.data).sort(), ["access_token", "email", "expires_in", "scopes"]);

  await setAccessLeft(SAM, "gdrive", 200);
  const t2 = await token("gdrive", sam);
  const refresh = tokenCalls(GOOGLE_TOKEN_ENDPOINT);
  check("under 5 minutes left: refreshed", [t2.data.access_token !== t1.data.access_token, refresh.length, refresh[0]?.form.grant_type, refresh[0]?.form.refresh_token, refresh[0]?.form.client_secret], [true, 1, "refresh_token", "g-rt-1", "google-client-secret-value"]);
  check("Google sent no new refresh token: the old one kept", (await stored(SAM, "gdrive"))?.refresh, "g-rt-1");
  check("and the new access token is cached", (await token("gdrive", sam)).data.access_token, t2.data.access_token);

  await setAccessLeft(SAM, "gdrive", 10);
  calls.length = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  answer["google:refresh_token"] = async () => { await gate; return json({ access_token: "g-at-shared", expires_in: 3599 }); };
  const many = Promise.all([token("gdrive", sam), token("gdrive", sam), token("gdrive", sam)]);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const results = await many;
  check("three at once: one refresh, all get its token", [tokenCalls(GOOGLE_TOKEN_ENDPOINT).length, results.map((r) => r.data.access_token)], [1, ["g-at-shared", "g-at-shared", "g-at-shared"]]);
  check("scopes kept when Google leaves them out of a refresh", (await stored(SAM, "gdrive"))?.scopes.includes(DRIVE_FILE_SCOPE), true);
  defaultAnswers();

  await setAccessLeft(SAM, "gdrive", 10);
  answer["google:refresh_token"] = () => { throw new Error("connection reset"); };
  const down = await token("gdrive", sam);
  check("Google unreachable: 502 cloud_unavailable, still connected", [down.res.status, down.data, (await status(sam)).data.gdrive.connected], [502, { error: "cloud_unavailable" }, true]);
  answer["google:refresh_token"] = () => json({ error: "invalid_client", error_description: "The OAuth client was not found." }, 401);
  const ours = await token("gdrive", sam);
  check("our client misconfigured: 502 cloud_unavailable, still connected", [ours.res.status, ours.data, (await status(sam)).data.gdrive.connected], [502, { error: "cloud_unavailable" }, true]);
  check("no secret or token in any error answer", JSON.stringify([down.data, ours.data]).match(/secret|g-rt|g-at/), null);
  defaultAnswers();

  check("not configured: 503", [(await token("gdrive", sam, { ...BASE_ENV, GOOGLE_CLIENT_SECRET: "" })).res.status, (await token("gdrive", sam, { ...BASE_ENV, GOOGLE_CLIENT_SECRET: "" })).data], [503, { error: "cloud_not_configured" }]);
  check("never connected: 409 cloud_not_connected", [(await token("onedrive", await cookieFor("7777"))).res.status, (await token("onedrive", await cookieFor("7777"))).data], [409, { error: "cloud_not_connected" }]);
  const form = await call("/cloud/gdrive/token", { method: "POST", cookie: sam, body: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  check("a form post (not JSON): 415", [form.res.status, form.data], [415, { error: "json_required" }]);
  const foreign = await call("/cloud/gdrive/token", { method: "POST", cookie: sam, json: {}, headers: { Origin: "https://evil.example" } });
  check("another site: 403", [foreign.res.status, foreign.data], [403, { error: "forbidden_origin" }]);
  check("no session: 401", (await call("/cloud/gdrive/token", { method: "POST", json: {} })).res.status, 401);
}

/* ── OneDrive ──────────────────────────────────────────────────────────── */
console.log("\nOneDrive");
{
  calls.length = 0;
  const { start, back } = await connect("onedrive", sam, "?return_to=/files&read=1");
  check("connected", back.location, `${APP}/files?cloud=connected&app=onedrive`);
  const ex = tokenCalls(MS_TOKEN_URL)[0];
  check("exchange: secret, same scopes as asked, PKCE, callback", [ex.form.client_id, ex.form.client_secret, ex.form.scope, ex.form.redirect_uri, await codeChallenge(ex.form.code_verifier) === start.params.code_challenge], [MS_CLIENT, "ms-client-secret-value", start.params.scope, `${API}/cloud/onedrive/callback`, true]);
  const st = (await status(sam)).data.onedrive;
  check("status: who (preferred_username), short scope names", [st.connected, st.email, st.name, st.scopes], [true, "sam@outlook.com", "Sam O", ["Files.Read", "Files.ReadWrite.AppFolder", "User.Read", "openid", "profile", "email"]]);
  const again = await startConnect("onedrive", sam);
  check("reconnecting without read=1 keeps Files.Read they gave", again.params.scope, "openid profile email offline_access User.Read Files.ReadWrite.AppFolder Files.Read");

  await setAccessLeft(SAM, "onedrive", 60);
  calls.length = 0;
  const t = await token("onedrive", sam);
  const r1 = tokenCalls(MS_TOKEN_URL)[0];
  check("refresh: with the scopes (incl. offline_access, Files.Read) and the secret", [r1.form.grant_type, r1.form.refresh_token, r1.form.scope, r1.form.client_secret], ["refresh_token", "ms-rt-1", "openid profile email offline_access User.Read Files.ReadWrite.AppFolder Files.Read", "ms-client-secret-value"]);
  check("Microsoft's new refresh token is stored", (await stored(SAM, "onedrive"))?.refresh, "ms-rt-2");
  check("token answer", [t.res.status, t.data.access_token.startsWith("ms-at-"), t.data.email], [200, true, "sam@outlook.com"]);
  await setAccessLeft(SAM, "onedrive", 60);
  calls.length = 0;
  await token("onedrive", sam);
  check("the next refresh spends the new one", [tokenCalls(MS_TOKEN_URL)[0]?.form.refresh_token, (await stored(SAM, "onedrive"))?.refresh], ["ms-rt-2", "ms-rt-3"]);
  check("scopes after refreshes: still with Files.Read", (await stored(SAM, "onedrive"))?.scopes, ["openid", "profile", "email", "User.Read", "Files.ReadWrite.AppFolder", "Files.Read"]);
}
{
  const LOST = "6100";
  const c = await cookieFor(LOST);
  await connect("onedrive", c);
  await setAccessLeft(LOST, "onedrive", 0);
  answer["ms:refresh_token"] = () => json({ error: "invalid_grant", error_description: "AADSTS70000: secret stuff" }, 400);
  const gone = await token("onedrive", c);
  check("refresh refused (invalid_grant): 409 cloud_reconnect_needed", [gone.res.status, gone.data], [409, { error: "cloud_reconnect_needed" }]);
  check("and the connection is gone", [(await status(c)).data.onedrive.connected, await stored(LOST, "onedrive")], [false, null]);
  check("next time: cloud_not_connected", (await token("onedrive", c)).data, { error: "cloud_not_connected" });
  await connect("onedrive", c);
  await setAccessLeft(LOST, "onedrive", 0);
  answer["ms:refresh_token"] = () => json({ error: "interaction_required" }, 400);
  check("interaction_required: reconnect too", (await token("onedrive", c)).data, { error: "cloud_reconnect_needed" });
  defaultAnswers();
}

/* ── disconnect ────────────────────────────────────────────────────────── */
console.log("\ndisconnect");
{
  calls.length = 0;
  const del = await call("/cloud/gdrive/connection", { method: "DELETE", cookie: sam });
  check("Google, sign-in client: forgotten, not revoked (that would end Sign in with Google)", [del.res.status, del.data, tokenCalls(GOOGLE_REVOKE_URL).length, (await status(sam)).data.gdrive.connected], [200, { ok: true }, 0, false]);
  check("OneDrive untouched", (await status(sam)).data.onedrive.connected, true);

  const D = "6200";
  const c = await cookieFor(D);
  await connect("gdrive", c, "", DRIVE_ENV);
  check("Drive client connection stored with that client", (await stored(D, "gdrive"))?.client, G_DRIVE_CLIENT);
  await setAccessLeft(D, "gdrive", 0);
  calls.length = 0;
  await token("gdrive", c, DRIVE_ENV);
  check("its refresh uses the Drive client's own secret", [tokenCalls(GOOGLE_TOKEN_ENDPOINT)[0]?.form.client_id, tokenCalls(GOOGLE_TOKEN_ENDPOINT)[0]?.form.client_secret], [G_DRIVE_CLIENT, "drive-client-secret-value"]);
  calls.length = 0;
  const gone = await call("/cloud/gdrive/connection", { method: "DELETE", cookie: c, env: DRIVE_ENV });
  const revoke = tokenCalls(GOOGLE_REVOKE_URL);
  check("Drive client: revoked at Google (token in the body, not the URL), then forgotten", [gone.data, revoke.length, revoke[0]?.method, revoke[0]?.form.token, revoke[0]?.url, await stored(D, "gdrive")], [{ ok: true }, 1, "POST", "g-rt-1", GOOGLE_REVOKE_URL, null]);
  check("nothing left in the object once both are gone", objects.get(D)!.storage.data.size, 0);

  await connect("gdrive", c, "", DRIVE_ENV);
  answer.revoke = () => { throw new Error("Google down"); };
  const still = await call("/cloud/gdrive/connection", { method: "DELETE", cookie: c, env: DRIVE_ENV });
  check("revoke failing still forgets", [still.data, await stored(D, "gdrive")], [{ ok: true }, null]);
  defaultAnswers();

  calls.length = 0;
  const ms = await call("/cloud/onedrive/connection", { method: "DELETE", cookie: sam });
  check("OneDrive: forgotten, nothing sent to Microsoft", [ms.data, calls.length, (await status(sam)).data.onedrive.connected], [{ ok: true }, 0, false]);
  check("disconnecting when not connected: ok", (await call("/cloud/onedrive/connection", { method: "DELETE", cookie: sam })).data, { ok: true });
  check("another site can't disconnect", (await call("/cloud/onedrive/connection", { method: "DELETE", cookie: sam, headers: { Origin: "https://evil.example" } })).res.status, 403);

  // A refresh that was on its way when Disconnect was pressed doesn't bring the connection back.
  await connect("gdrive", sam);
  await setAccessLeft(SAM, "gdrive", 0);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  answer["google:refresh_token"] = async () => { await gate; return json({ access_token: "g-at-late", expires_in: 3599 }); };
  const late = token("gdrive", sam);
  await new Promise((r) => setTimeout(r, 20));
  await call("/cloud/gdrive/connection", { method: "DELETE", cookie: sam });
  release();
  const lateAnswer = await late;
  check("Disconnect beats a refresh in flight", [lateAnswer.res.status, await stored(SAM, "gdrive")], [409, null]);
  defaultAnswers();
}

/* ── reconnecting: forced refresh and lost connections (2026-10-09) ──── */
console.log("\nforced refresh and lost connections");
{
  const R = "6500";
  const c = await cookieFor(R);
  const force = (app: CloudApp, body: unknown = { refresh: true }, env?: any) => call(`/cloud/${app}/token`, { method: "POST", cookie: c, json: body, env });
  await connect("gdrive", c);
  const first = await token("gdrive", c);
  calls.length = 0;
  const forced = await force("gdrive");
  const refreshCalls = tokenCalls(GOOGLE_TOKEN_ENDPOINT);
  check("{refresh: true} with over 5 minutes left: refreshed anyway", [forced.res.status, forced.data.access_token !== first.data.access_token, refreshCalls.length, refreshCalls[0]?.form.grant_type], [200, true, 1, "refresh_token"]);
  check("same answer fields", Object.keys(forced.data).sort(), ["access_token", "email", "expires_in", "scopes"]);
  check("the refreshed token is the cached one now", (await token("gdrive", c)).data.access_token, forced.data.access_token);
  check("when it was refreshed is kept (sealed)", Math.abs(Date.now() - ((await stored(R, "gdrive"))?.refreshedAt ?? 0)) < 5000, true);

  calls.length = 0;
  const again = await force("gdrive");
  check("asked again within 30 s: the current token, Google not asked", [again.res.status, again.data.access_token, tokenCalls(GOOGLE_TOKEN_ENDPOINT).length], [200, forced.data.access_token, 0]);
  const conn = (await stored(R, "gdrive"))!;
  conn.refreshedAt = Date.now() - 31_000;
  await objects.get(R)!.storage.put("conn:gdrive", await sealConnection(conn, R, "gdrive", SECRET));
  calls.length = 0;
  const later = await force("gdrive");
  check("31 s later: refreshed again", [later.data.access_token !== forced.data.access_token, tokenCalls(GOOGLE_TOKEN_ENDPOINT).length], [true, 1]);

  calls.length = 0;
  const plain = await token("gdrive", c);
  check("old app's {} body: unchanged (cached token, no refresh)", [plain.res.status, plain.data.access_token, tokenCalls(GOOGLE_TOKEN_ENDPOINT).length], [200, later.data.access_token, 0]);
  const empty = await call("/cloud/gdrive/token", { method: "POST", cookie: c, body: "", headers: { "Content-Type": "application/json" } });
  check("no body at all: also unchanged", [empty.res.status, empty.data.access_token], [200, later.data.access_token]);
  check("refresh: \"yes\" (not true): no forced refresh", [(await force("gdrive", { refresh: "yes" })).data.access_token, tokenCalls(GOOGLE_TOKEN_ENDPOINT).length], [later.data.access_token, 0]);
  const broken = await call("/cloud/gdrive/token", { method: "POST", cookie: c, body: "{not json", headers: { "Content-Type": "application/json" } });
  check("a body that isn't JSON: 400 invalid_body", [broken.res.status, broken.data], [400, { error: "invalid_body" }]);
  check("a JSON array: 400", (await force("gdrive", [1])).res.status, 400);
  check("over 1 KB: 400", (await force("gdrive", { refresh: true, pad: "x".repeat(2000) })).res.status, 400);

  // Three forced asks at once (three tabs got a 401): one refresh, all share it.
  const shared = (await stored(R, "gdrive"))!;
  shared.refreshedAt = 0;
  await objects.get(R)!.storage.put("conn:gdrive", await sealConnection(shared, R, "gdrive", SECRET));
  calls.length = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  answer["google:refresh_token"] = async () => { await gate; return json({ access_token: "g-at-forced-shared", expires_in: 3599 }); };
  const many = Promise.all([force("gdrive"), force("gdrive"), force("gdrive")]);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const results = await many;
  check("three forced at once: one refresh, all get its token", [tokenCalls(GOOGLE_TOKEN_ENDPOINT).length, results.map((r) => r.data.access_token)], [1, ["g-at-forced-shared", "g-at-forced-shared", "g-at-forced-shared"]]);
  defaultAnswers();

  // The student removed Averages.io from their Google account: the cached token still looks good.
  const removed = (await stored(R, "gdrive"))!;
  removed.refreshedAt = 0;
  await objects.get(R)!.storage.put("conn:gdrive", await sealConnection(removed, R, "gdrive", SECRET));
  answer["google:refresh_token"] = () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
  const gone = await force("gdrive");
  check("forced refresh refused (invalid_grant): 409 cloud_reconnect_needed", [gone.res.status, gone.data], [409, { error: "cloud_reconnect_needed" }]);
  check("and the connection is forgotten", await stored(R, "gdrive"), null);
  const st = await status(c);
  check("status: lost, with the account that was connected", st.data.gdrive, { configured: true, connected: false, lost: true, email: "sam@example.com", name: "Sam Student", scopes: [] });
  check("the other app: not lost", [st.data.onedrive.connected, st.data.onedrive.lost], [false, false]);
  const marker = await objects.get(R)!.storage.get<string>("lost:gdrive");
  check("the marker is sealed and holds no token", [typeof marker, marker!.includes("sam@example.com"), marker!.includes("g-rt-1")], ["string", false, false]);
  check("next ask: 409 cloud_not_connected (still lost)", [(await token("gdrive", c)).data, (await status(c)).data.gdrive.lost], [{ error: "cloud_not_connected" }, true]);
  const inc = await status(await cookieFor(R, { inc: true }));
  check("Incognito: unchanged (not connected, not lost)", [inc.data.incognito, inc.data.gdrive.connected, inc.data.gdrive.lost, inc.data.gdrive.email], [true, false, false, ""]);
  defaultAnswers();

  await connect("gdrive", c);
  const back = await status(c);
  check("connecting again clears lost", [back.data.gdrive.connected, back.data.gdrive.lost, await objects.get(R)!.storage.get("lost:gdrive")], [true, false, undefined]);

  // OneDrive lost, then Disconnect pressed without reconnecting.
  await connect("onedrive", c);
  await setAccessLeft(R, "onedrive", 0);
  answer["ms:refresh_token"] = () => json({ error: "invalid_grant" }, 400);
  check("OneDrive refused on an ordinary refresh: lost too", [(await token("onedrive", c)).data, (await status(c)).data.onedrive], [{ error: "cloud_reconnect_needed" }, { configured: true, connected: false, lost: true, email: "sam@outlook.com", name: "Sam O", scopes: [] }]);
  defaultAnswers();
  const del = await call("/cloud/onedrive/connection", { method: "DELETE", cookie: c });
  check("Disconnect clears lost", [del.data, (await status(c)).data.onedrive.lost, await objects.get(R)!.storage.get("lost:onedrive")], [{ ok: true }, false, undefined]);
  check("and leaves Google Drive connected", (await status(c)).data.gdrive.connected, true);

  // Both gone, one of them only lost: the object keeps that marker until it's dismissed.
  const L = "6600";
  const lc = await cookieFor(L);
  await connect("gdrive", lc);
  await connect("onedrive", lc);
  await setAccessLeft(L, "onedrive", 0);
  answer["ms:refresh_token"] = () => json({ error: "invalid_grant" }, 400);
  await token("onedrive", lc);
  defaultAnswers();
  await call("/cloud/gdrive/connection", { method: "DELETE", cookie: lc });
  check("disconnecting Drive keeps OneDrive's lost marker", (await status(lc)).data.onedrive.lost, true);
  await call("/cloud/onedrive/connection", { method: "DELETE", cookie: lc });
  check("dismissing it too: nothing left in the object", [(await status(lc)).data.onedrive.lost, objects.get(L)!.storage.data.size], [false, 0]);

  // A marker can't be opened as anything else, or for another student.
  const sealedLost = await sealLost({ email: "a@b.co", name: "A", at: 1 }, R, "gdrive", SECRET);
  check("a sealed marker opens only as a marker, for its own student and app", [!!(await openLost(sealedLost, R, "gdrive", SECRET)), await openLost(sealedLost, "6501", "gdrive", SECRET), await openLost(sealedLost, R, "onedrive", SECRET), await openConnection(sealedLost, R, "gdrive", SECRET)], [true, null, null, null]);
}

/* ── demo, Incognito, the reviewer ─────────────────────────────────────── */
console.log("\ndemo, Incognito, reviewer");
{
  const demo = await cookieFor(DEMO_UID);
  check("demo: token and disconnect refused", [(await token("gdrive", demo)).data, (await call("/cloud/gdrive/connection", { method: "DELETE", cookie: demo })).data], [{ error: "not_available_in_demo" }, { error: "not_available_in_demo" }]);
  check("demo: callback goes to the start page", (await call("/cloud/gdrive/callback?code=x&state=y", { cookie: demo })).location, `${APP}/`);
  check("demo never opened a Durable Object", objects.has(DEMO_UID), false);

  const INC = "6300";
  await connect("gdrive", await cookieFor(INC));
  const inc = await cookieFor(INC, { inc: true });
  const st = await status(inc);
  check("Incognito: status says incognito, not connected", [st.data.incognito, st.data.gdrive.connected, st.data.onedrive.connected, st.data.gdrive.configured], [true, false, false, true]);
  check("Incognito: no token", [(await token("gdrive", inc)).res.status, (await token("gdrive", inc)).data], [403, { error: "incognito_mode" }]);
  const del = await call("/cloud/gdrive/connection", { method: "DELETE", cookie: inc });
  check("Incognito: can still disconnect", [del.data, await stored(INC, "gdrive")], [{ ok: true }, null]);

  const reviewer = await cookieFor(REVIEW_UID, { key: SANDBOX_KEY, secret: SANDBOX_SECRET });
  const { back } = await connect("gdrive", reviewer, "?return_to=/files");
  check("the reviewer account connects like any student", back.location, `${APP}/files?cloud=connected&app=gdrive`);
  const t = await token("gdrive", reviewer);
  check("and gets tokens", [t.res.status, t.data.email], [200, "sam@example.com"]);
  const om = await connect("onedrive", reviewer);
  check("OneDrive too", [om.back.location, (await status(reviewer)).data.onedrive.connected], [`${APP}/settings?cloud=connected&app=onedrive`, true]);
  check("kept under the reviewer's own uid", objects.has(REVIEW_UID), true);
}

/* ── nothing secret leaves in a redirect ───────────────────────────────── */
console.log("\nleaks");
{
  calls.length = 0;
  const { start, back } = await connect("gdrive", await cookieFor("6400"), "?return_to=/files");
  const everything = [start.location, back.location].join(" ");
  check("no client secret, code, refresh or access token in any redirect", /secret-value|good-code|g-rt-|g-at-/.test(everything), false);
  check("every outgoing call had a timeout signal", calls.every((c) => c.signal), true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
