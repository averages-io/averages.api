// Google Drive and OneDrive that stay connected.

import { b64url, b64urlDecode, codeChallenge, safeAppPath, STATE_RE, type CanvaStorage } from "./canva.ts";
import { GOOGLE_CLIENT_ID_RE, MS_CLIENT_ID_RE, pick } from "./cloud.ts";

export type CloudApp = "gdrive" | "onedrive";
export const CLOUD_APPS: readonly CloudApp[] = ["gdrive", "onedrive"];

export function isCloudApp(value: unknown): value is CloudApp {
  return value === "gdrive" || value === "onedrive";
}

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const MS_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/** Only files the app creates or the student picks: never their whole Drive. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_INSTALL_SCOPE = "https://www.googleapis.com/auth/drive.install";
export const GOOGLE_SCOPES = ["openid", "email", "profile", DRIVE_FILE_SCOPE, DRIVE_INSTALL_SCOPE];
/** offline_access is what makes Microsoft hand back a refresh token. */
export const MS_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read", "Files.ReadWrite.AppFolder"];
/** Reading the student's own OneDrive files (adding one from OneDrive), asked for only when the app needs it. */
export const MS_READ_SCOPE = "Files.Read";
export const MS_WRITE_SCOPE = "Files.ReadWrite";

/** Every call to Google or Microsoft gives up after 15 seconds. */
const TIMEOUT_MS = 15_000;
/** A connect started more than 10 minutes ago can't be finished. */
const CONNECT_TTL_S = 10 * 60;
/** A cached access token is handed out only while it has more than 5 minutes left. */
const SKEW_S = 300;
export const FORCED_REFRESH_GAP_MS = 30_000;

const nowS = () => Math.floor(Date.now() / 1000);

export interface CloudConnectEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  /** Seals the stored tokens (see sealConnection). */
  SESSION_SECRET?: string;
}

/* ── which OAuth client ────────────────────────────────────────────── */

export interface CloudClient {
  clientId: string;
  clientSecret: string;
  /**
   * Google only: true when this is the Sign in with Google client
   * (GOOGLE_CLIENT_ID). A Google token belongs to its client's whole grant,
   * so with that client Drive must not merge in earlier grants (which would
   * hand the browser a token that can read Classroom) and Disconnect must not
   * revoke (which would also end the student's Classroom sign-in).
   */
  shared: boolean;
}

function secretOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The OAuth clients this Worker could use for `app`, best first.
 *
 * Google: the Drive-only client (GOOGLE_DRIVE_CLIENT_ID, which /config/cloud
 * also serves) when it has its own secret, GOOGLE_DRIVE_CLIENT_SECRET; then
 * the sign-in client, GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET. A Drive client
 * set up for the browser only (no secret) falls through to the sign-in client
 * instead of leaving Drive "not set up". Both are in the same Google Cloud
 * project, so drive.file sees the same files either way.
 *
 * Microsoft: MS_CLIENT_ID + MS_CLIENT_SECRET. Everything needs SESSION_SECRET
 * too, which seals what's stored.
 */
function clientsFor(env: CloudConnectEnv, app: CloudApp): CloudClient[] {
  if (!secretOf(env.SESSION_SECRET)) return [];
  if (app === "onedrive") {
    const id = pick(env.MS_CLIENT_ID, MS_CLIENT_ID_RE);
    const secret = secretOf(env.MS_CLIENT_SECRET);
    return id && secret ? [{ clientId: id.toLowerCase(), clientSecret: secret, shared: false }] : [];
  }
  const signIn = pick(env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_ID_RE);
  const out: CloudClient[] = [];
  const drive = pick(env.GOOGLE_DRIVE_CLIENT_ID, GOOGLE_CLIENT_ID_RE);
  const driveSecret = secretOf(env.GOOGLE_DRIVE_CLIENT_SECRET);
  if (drive && driveSecret) out.push({ clientId: drive, clientSecret: driveSecret, shared: drive === signIn });
  const signInSecret = secretOf(env.GOOGLE_CLIENT_SECRET);
  if (signIn && signInSecret && signIn !== drive) out.push({ clientId: signIn, clientSecret: signInSecret, shared: true });
  return out;
}

/** The client a new connection uses, or null when `app` isn't set up on this Worker. */
export function cloudClient(env: CloudConnectEnv, app: CloudApp): CloudClient | null {
  return clientsFor(env, app)[0] ?? null;
}

export function cloudConfigured(env: CloudConnectEnv, app: CloudApp): boolean {
  return cloudClient(env, app) !== null;
}

/* ── errors ────────────────────────────────────────────────────────── */

export class CloudError extends Error {
  status: number;
  constructor(code: string, status = 502) {
    super(code);
    this.name = "CloudError";
    this.status = status;
  }
}

/** HTTP status for a code (the class doesn't survive the Durable Object's RPC; the message does). */
export function statusForCloudCode(code: string): number {
  if (code === "cloud_not_configured") return 503;
  if (code === "cloud_not_connected" || code === "cloud_reconnect_needed") return 409;
  return 502;
}

/** Timeouts and network failures become cloud_unavailable: the URL (and so nothing secret) is never in the error. */
async function cloudFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new CloudError("cloud_unavailable", 502);
  }
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/* ── small helpers ─────────────────────────────────────────────────── */

const rand = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** A plausible email for login_hint; anything else is left out rather than sent to Google or Microsoft. */
export function validLoginHint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v.length <= 254 && /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(v) ? v : null;
}

/**
 * The granted scopes as a list. Microsoft sometimes names Graph scopes in
 * full ("https://graph.microsoft.com/Files.Read"); they're shortened to the
 * names the app asks for, so a check for "Files.Read" works either way.
 */
export function parseScopes(app: CloudApp, raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  for (let s of raw.trim().split(/\s+/)) {
    if (!s || s.length > 200) continue;
    if (app === "onedrive") s = s.replace(/^https:\/\/graph\.microsoft\.com\//i, "");
    if (!out.includes(s)) out.push(s);
    if (out.length >= 40) break;
  }
  return out;
}

function hasScope(list: string[], scope: string): boolean {
  const want = scope.toLowerCase();
  return list.some((s) => s.toLowerCase() === want);
}

/** OneDrive's scopes for a connect or a refresh. Files.Read / Files.ReadWrite only when wanted: a scope they gave is never dropped (see beginConnect). */
export function msScopes(withRead: boolean, withWrite = false): string {
  return [...MS_SCOPES, ...(withRead ? [MS_READ_SCOPE] : []), ...(withWrite ? [MS_WRITE_SCOPE] : [])].join(" ");
}

/** Strips control characters and caps the length, for names and emails shown in Settings. */
function text(value: unknown, max: number): string {
  return Array.from(typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "").slice(0, max).join("");
}

/**
 * Who connected, from the id_token. Only decoded, not signature-checked: it
 * came straight from Google's or Microsoft's token endpoint over TLS in
 * answer to our own client secret (OpenID Connect allows this), and it only
 * labels the connection in Settings. The audience must still be our client.
 */
export function identityFrom(app: CloudApp, idToken: unknown, clientId: string): { email: string; name: string } {
  try {
    if (typeof idToken !== "string") return { email: "", name: "" };
    const parts = idToken.split(".");
    if (parts.length !== 3) return { email: "", name: "" };
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    const aud = (Array.isArray(claims?.aud) ? claims.aud : [claims?.aud]).map((a: unknown) => String(a).toLowerCase());
    if (!aud.includes(clientId.toLowerCase())) return { email: "", name: "" };
    const rawEmail = app === "onedrive" ? claims.email || claims.preferred_username : claims.email;
    const email = text(rawEmail, 254);
    return { email: email.includes("@") ? email : "", name: text(claims.name, 120) };
  } catch {
    return { email: "", name: "" };
  }
}

/* ── sealing ───────────────────────────────────────────────────────── */

/** One app's stored connection. */
export interface Connection {
  /** The OAuth client it was made with (its refresh token only works with that client). */
  client: string;
  refresh: string;
  access: string;
  /** Epoch seconds. */
  accessExp: number;
  scopes: string[];
  email: string;
  name: string;
  /** Epoch ms. */
  connectedAt: number;
  refreshedAt?: number;
}

export interface LostConnection {
  email: string;
  name: string;
  /** Epoch ms. */
  at: number;
}

/**
 * AES-GCM with a key derived from SESSION_SECRET (HKDF, its own salt, so it's
 * a different key from Canva's), and the uid and app bound in as additional
 * data: a sealed connection only opens for the student and the app it was
 * made for. A changed SESSION_SECRET reads as "not connected".
 */
async function sealKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("averages.io cloud tokens"), info: new TextEncoder().encode("v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The lost-connection marker gets its own additional data, so a sealed marker can never open as a connection (or back). */
const aad = (uid: string, app: CloudApp, kind = "") => new TextEncoder().encode(kind ? `${uid}\n${app}\n${kind}` : `${uid}\n${app}`);

async function sealJson(value: unknown, additional: Uint8Array, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additional },
    await sealKey(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${b64url(iv)}.${b64url(new Uint8Array(data))}`;
}

/** The sealed JSON, or throws (wrong key, student, app or kind; tampered). */
async function openJson(sealed: string, additional: Uint8Array, secret: string): Promise<any> {
  const [iv, data] = sealed.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlDecode(iv), additionalData: additional },
    await sealKey(secret),
    b64urlDecode(data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

export function sealConnection(conn: Connection, uid: string, app: CloudApp, secret: string): Promise<string> {
  return sealJson(conn, aad(uid, app), secret);
}

export async function openConnection(sealed: string, uid: string, app: CloudApp, secret: string): Promise<Connection | null> {
  try {
    const c = await openJson(sealed, aad(uid, app), secret);
    if (typeof c?.refresh !== "string" || typeof c?.access !== "string" || typeof c?.client !== "string") return null;
    return {
      client: c.client,
      refresh: c.refresh,
      access: c.access,
      accessExp: Number(c.accessExp) || 0,
      scopes: Array.isArray(c.scopes) ? c.scopes.filter((s: unknown) => typeof s === "string") : [],
      email: typeof c.email === "string" ? c.email : "",
      name: typeof c.name === "string" ? c.name : "",
      connectedAt: Number(c.connectedAt) || 0,
      refreshedAt: Number(c.refreshedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function sealLost(lost: LostConnection, uid: string, app: CloudApp, secret: string): Promise<string> {
  return sealJson(lost, aad(uid, app, "lost"), secret);
}

export async function openLost(sealed: string, uid: string, app: CloudApp, secret: string): Promise<LostConnection | null> {
  try {
    const v = await openJson(sealed, aad(uid, app, "lost"), secret);
    if (!v || typeof v !== "object") return null;
    return { email: typeof v.email === "string" ? v.email : "", name: typeof v.name === "string" ? v.name : "", at: Number(v.at) || 0 };
  } catch {
    return null;
  }
}

/* ── calls to Google and Microsoft ─────────────────────────────────── */

/**
 * Code exchange and refresh, server only (they need the client secret).
 * Only invalid_grant (and Microsoft's interaction_required/consent_required)
 * means the student's grant is gone; anything else, such as invalid_client
 * from a wrong secret, is our problem, and their connection is kept.
 */
async function tokenCall(app: CloudApp, body: Record<string, string>): Promise<any> {
  const res = await cloudFetch(app === "gdrive" ? GOOGLE_TOKEN_ENDPOINT : MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const json = await readJson(res);
  if (!res.ok || typeof json?.access_token !== "string" || !json.access_token) {
    const kind = String(json?.error ?? "");
    if (kind === "invalid_grant" || kind === "interaction_required" || kind === "consent_required") {
      throw new CloudError("cloud_reconnect_needed", 409);
    }
    throw new CloudError("cloud_unavailable", 502);
  }
  return json;
}

function expiresIn(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), 60), 24 * 60 * 60) : 3600;
}

/**
 * Google's revoke. The token goes in the form body rather than the URL
 * (Google accepts either), so it can't end up in a logged URL.
 */
async function revokeGoogle(token: string): Promise<boolean> {
  const res = await cloudFetch(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  return res.ok;
}

/* ── per-student storage ───────────────────────────────────────────── */

interface PendingConnect {
  app: CloudApp;
  verifier: string;
  returnTo: string;
  redirectUri: string;
  /** The client and scopes asked for: the code exchange must use the same. */
  client: string;
  scope: string;
  exp: number;
}

export interface ConnectOptions {
  returnTo: string;
  /** OneDrive: also ask for Files.Read. */
  read?: boolean;
  write?: boolean;
  loginHint?: string | null;
  /** This Worker's own /cloud/:app/callback, as the browser reached it. */
  redirectUri: string;
}

export type ConnectOutcome = "connected" | "failed" | "drive_not_allowed";

export interface FinishResult {
  outcome: ConnectOutcome;
  /** The app page to go back to (/settings when the state wasn't found). */
  returnTo: string;
  /** Why it failed, for the Worker's log (a short code, never anything secret). */
  code?: string;
}

export interface AppStatus {
  connected: boolean;
  lost: boolean;
  email: string;
  name: string;
  scopes: string[];
}

/** Options for accessToken (POST /cloud/:app/token's body). */
export interface TokenOptions {
  /** Refresh even when the cached token looks fine (the browser just got a 401 with it). */
  refresh?: boolean;
}

export interface CloudToken {
  access_token: string;
  expires_in: number;
  email: string;
  scopes: string[];
}

/** An entry that was really stored under `key`, never an inherited property. */
function own<T>(map: Record<string, T>, key: string): T | null {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

const connKey = (app: CloudApp) => `conn:${app}`;
const lostKey = (app: CloudApp) => `lost:${app}`;

/** One student's Google Drive and OneDrive connections. */
export class CloudAccount {
  storage: CanvaStorage;
  env: CloudConnectEnv;
  /** In-flight refresh per app, shared by concurrent callers so a refresh token is only spent once. */
  refreshing: Record<CloudApp, Promise<Connection | null> | null> = { gdrive: null, onedrive: null };
  /**
   * Bumped by Disconnect and by a finished connect. A refresh or code
   * exchange that started before finds it changed and doesn't save, so
   * Disconnect can't be undone by a request already on its way, and an old
   * connection's refresh can't overwrite a new one.
   */
  generation: Record<CloudApp, number> = { gdrive: 0, onedrive: 0 };

  constructor(storage: CanvaStorage, env: CloudConnectEnv) {
    this.storage = storage;
    this.env = env;
  }

  async load(uid: string, app: CloudApp): Promise<Connection | null> {
    const sealed = await this.storage.get<string>(connKey(app));
    const secret = secretOf(this.env.SESSION_SECRET);
    if (typeof sealed !== "string" || !secret) return null;
    return openConnection(sealed, uid, app, secret);
  }

  async save(uid: string, app: CloudApp, conn: Connection): Promise<void> {
    await this.storage.put(connKey(app), await sealConnection(conn, uid, app, secretOf(this.env.SESSION_SECRET)!));
  }

  /** The "connection was lost" marker for `app`, or null. */
  async loadLost(uid: string, app: CloudApp): Promise<LostConnection | null> {
    const sealed = await this.storage.get<string>(lostKey(app));
    const secret = secretOf(this.env.SESSION_SECRET);
    if (typeof sealed !== "string" || !secret) return null;
    return openLost(sealed, uid, app, secret);
  }

  /** Remembers that `conn` was dropped because the provider refused its grant (no tokens kept). Never throws. */
  async markLost(uid: string, app: CloudApp, conn: Connection): Promise<void> {
    const secret = secretOf(this.env.SESSION_SECRET);
    if (!secret) return;
    try {
      await this.storage.put(lostKey(app), await sealLost({ email: conn.email, name: conn.name, at: Date.now() }, uid, app, secret));
    } catch {
      /* only a label for Settings: the connection is dropped either way */
    }
  }

  async pending(): Promise<Record<string, PendingConnect>> {
    const now = nowS();
    const stored = (await this.storage.get<Record<string, PendingConnect>>("connect")) ?? {};
    const live = Object.entries(stored).filter(([, v]) => v && typeof v === "object" && v.exp > now);
    live.sort((a, b) => a[1].exp - b[1].exp);
    // Newest 6 (a few tabs, both apps). No prototype: a state like "__proto__" never matches something built in.
    return Object.assign(Object.create(null), Object.fromEntries(live.slice(-6)));
  }

  /** Removes and returns the pending connect for `state`, if it's this app's and still live. Single use. */
  async takePending(app: CloudApp, state: string): Promise<PendingConnect | null> {
    if (!STATE_RE.test(String(state))) return null;
    const all = await this.pending();
    const entry = own(all, state);
    delete all[state];
    await this.storage.put("connect", { ...all });
    if (!entry || entry.app !== app || typeof entry.verifier !== "string" || entry.verifier.length < 43) return null;
    return entry;
  }

  /* ── connect ── */

  async beginConnect(uid: string, app: CloudApp, opts: ConnectOptions): Promise<string> {
    const client = cloudClient(this.env, app);
    if (!client) throw new CloudError("cloud_not_configured", 503);
    const verifier = rand(48); // 64 characters; never leaves the Worker
    const state = rand(24); // 32 characters, matches STATE_RE
    const returnTo = safeAppPath(opts.returnTo, "/settings");
    const hint = validLoginHint(opts.loginHint);

    let scope: string;
    let params: [string, string][];
    if (app === "gdrive") {
      scope = GOOGLE_SCOPES.join(" ");
      params = [
        ["client_id", client.clientId],
        ["redirect_uri", opts.redirectUri],
        ["response_type", "code"],
        ["scope", scope],
        ["state", state],
        ["code_challenge", await codeChallenge(verifier)],
        ["code_challenge_method", "S256"],
        // A refresh token every time: Google only sends one with
        // access_type=offline, and only on a consent screen.
        ["access_type", "offline"],
        ["prompt", "consent"],
      ];
      // Merging earlier grants is fine for a Drive-only client; with the
      // sign-in client it would fold Classroom into the token the browser gets.
      if (!client.shared) params.push(["include_granted_scopes", "true"]);
    } else {
      // Never drop a scope they already gave: reconnecting without "read"
      // mustn't take away adding files from OneDrive.
      const existing = await this.load(uid, app);
      scope = msScopes(
        !!opts.read || !!opts.write || (!!existing && hasScope(existing.scopes, MS_READ_SCOPE)),
        !!opts.write || (!!existing && hasScope(existing.scopes, MS_WRITE_SCOPE)),
      );
      params = [
        ["client_id", client.clientId],
        ["response_type", "code"],
        ["redirect_uri", opts.redirectUri],
        ["response_mode", "query"],
        ["scope", scope],
        ["state", state],
        ["code_challenge", await codeChallenge(verifier)],
        ["code_challenge_method", "S256"],
        ["prompt", "select_account"],
      ];
    }
    if (hint) params.push(["login_hint", hint]);

    const all = await this.pending();
    all[state] = { app, verifier, returnTo, redirectUri: opts.redirectUri, client: client.clientId, scope, exp: nowS() + CONNECT_TTL_S };
    await this.storage.put("connect", { ...all });

    // Built by hand: URLSearchParams writes spaces as "+", and scopes are
    // safest as %20 for both providers.
    const q = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return `${app === "gdrive" ? GOOGLE_AUTHORIZE_URL : MS_AUTHORIZE_URL}?${q}`;
  }

  /** The student cancelled (or the provider refused): forget the state, answer where they were. */
  async cancelConnect(app: CloudApp, state: string): Promise<string> {
    const entry = await this.takePending(app, state);
    return entry ? safeAppPath(entry.returnTo, "/settings") : "/settings";
  }

  /**
   * Google or Microsoft sent the student back with code + state. The state
   * is looked up in this student's own storage (one from someone else's
   * browser simply isn't found), must be for this app, and works once.
   * Never throws: the route always redirects, and needs the page to go back to.
   */
  async finishConnect(uid: string, app: CloudApp, state: string, code: string): Promise<FinishResult> {
    const fail = (returnTo: string, why: string, outcome: ConnectOutcome = "failed"): FinishResult => ({ outcome, returnTo, code: why });
    if (!state || !code || code.length > 4096) return fail("/settings", "cloud_callback_missing_params");
    const entry = await this.takePending(app, state);
    if (!entry) return fail("/settings", "cloud_state_not_found");
    const returnTo = safeAppPath(entry.returnTo, "/settings");
    const client = clientsFor(this.env, app).find((c) => c.clientId === entry.client);
    if (!client) return fail(returnTo, "cloud_not_configured");

    const gen = this.generation[app];
    const body: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      code_verifier: entry.verifier,
      redirect_uri: entry.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    };
    if (app === "onedrive") body.scope = entry.scope;
    let json: any;
    try {
      json = await tokenCall(app, body);
    } catch (error) {
      return fail(returnTo, error instanceof CloudError ? error.message : "cloud_unavailable");
    }

    const scopes = parseScopes(app, typeof json.scope === "string" ? json.scope : entry.scope);
    // Google lets the student untick Drive on the consent screen.
    if (app === "gdrive" && !scopes.includes(DRIVE_FILE_SCOPE)) return fail(returnTo, "drive_not_allowed", "drive_not_allowed");
    const refresh = typeof json.refresh_token === "string" ? json.refresh_token : "";
    // Without one the student would be back to signing in every hour.
    if (!refresh) return fail(returnTo, "no_refresh_token");
    // Disconnected (or connected again elsewhere) while this was on its way.
    if (gen !== this.generation[app]) return fail(returnTo, "cloud_not_connected");

    const who = identityFrom(app, json.id_token, client.clientId);
    await this.save(uid, app, {
      client: client.clientId,
      refresh,
      access: json.access_token,
      accessExp: nowS() + expiresIn(json.expires_in),
      scopes,
      email: who.email,
      name: who.name,
      connectedAt: Date.now(),
      refreshedAt: 0,
    });
    // Connected again: no longer "lost".
    await this.storage.delete(lostKey(app));
    this.generation[app]++;
    this.refreshing[app] = null;
    return { outcome: "connected", returnTo };
  }

  async status(uid: string): Promise<Record<CloudApp, AppStatus>> {
    const out = {} as Record<CloudApp, AppStatus>;
    for (const app of CLOUD_APPS) {
      const conn = await this.load(uid, app);
      const lost = conn ? null : await this.loadLost(uid, app);
      out[app] = conn
        ? { connected: true, lost: false, email: conn.email, name: conn.name, scopes: conn.scopes }
        : lost
          ? { connected: false, lost: true, email: lost.email, name: lost.name, scopes: [] }
          : { connected: false, lost: false, email: "", name: "", scopes: [] };
    }
    return out;
  }

  /* ── tokens ── */

  async accessToken(uid: string, app: CloudApp, opts: TokenOptions = {}): Promise<CloudToken> {
    if (!cloudConfigured(this.env, app)) throw new CloudError("cloud_not_configured", 503);
    const forced = opts?.refresh === true;
    // Twice at most: a refresh whose answer was discarded because the
    // connection changed meanwhile reads the new connection once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      const conn = await this.load(uid, app);
      if (!conn) throw new CloudError("cloud_not_connected", 409);
      const stale = conn.accessExp - SKEW_S <= nowS();
      const justRefreshed = !!conn.refreshedAt && Date.now() - conn.refreshedAt < FORCED_REFRESH_GAP_MS;
      // Forced or not, a refresh goes through refresh(), which shares one already on its way.
      const fresh = !stale && !(forced && !justRefreshed) ? conn : await this.refresh(uid, app, conn);
      if (fresh) {
        return { access_token: fresh.access, expires_in: Math.max(0, fresh.accessExp - nowS()), email: fresh.email, scopes: fresh.scopes };
      }
    }
    throw new CloudError("cloud_not_connected", 409);
  }

  /** One refresh per app at a time; everyone asking meanwhile shares it. Null = the connection changed, read it again. */
  refresh(uid: string, app: CloudApp, conn: Connection): Promise<Connection | null> {
    const running = this.refreshing[app];
    if (running) return running;
    const gen = this.generation[app];
    let run: Promise<Connection | null> | null = null;
    run = (async (): Promise<Connection | null> => {
      await null; // so `finally` below always runs after `run` is assigned
      try {
        const client = clientsFor(this.env, app).find((c) => c.clientId === conn.client);
        // The client this connection was made with is gone from the config:
        // its refresh token can't work with another one.
        if (!client) throw new CloudError("cloud_reconnect_needed", 409);
        const body: Record<string, string> = {
          grant_type: "refresh_token",
          refresh_token: conn.refresh,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        };
        if (app === "onedrive") body.scope = msScopes(hasScope(conn.scopes, MS_READ_SCOPE), hasScope(conn.scopes, MS_WRITE_SCOPE));
        const json = await tokenCall(app, body);
        if (gen !== this.generation[app]) return null;
        const next: Connection = {
          ...conn,
          access: json.access_token,
          accessExp: nowS() + expiresIn(json.expires_in),
          // Microsoft sends a new refresh token each time and the old one is
          // then on its way out: save it BEFORE handing out the access token.
          refresh: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : conn.refresh,
          scopes: typeof json.scope === "string" && json.scope.trim() ? parseScopes(app, json.scope) : conn.scopes,
          refreshedAt: Date.now(),
        };
        await this.save(uid, app, next);
        return next;
      } catch (error) {
        if (error instanceof CloudError && error.message === "cloud_reconnect_needed" && gen === this.generation[app]) {
          this.generation[app]++;
          await this.storage.delete(connKey(app));
          await this.markLost(uid, app, conn);
        }
        throw error;
      } finally {
        if (this.refreshing[app] === run) this.refreshing[app] = null;
      }
    })();
    this.refreshing[app] = run;
    return run!;
  }

  /* ── disconnect ── */

  async disconnect(uid: string, app: CloudApp, opts: { revokeShared?: boolean } = {}): Promise<void> {
    this.generation[app]++;
    this.refreshing[app] = null;
    const conn = await this.load(uid, app);
    const shared = !!conn && conn.client === pick(this.env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_ID_RE);
    if (conn && app === "gdrive" && (!shared || opts.revokeShared === true)) {
      try {
        const ok = await revokeGoogle(conn.refresh);
        if (!ok && conn.access && conn.accessExp > nowS()) await revokeGoogle(conn.access);
      } catch {
        /* forgotten either way */
      }
    }
    await this.storage.delete(connKey(app));
    await this.storage.delete(lostKey(app));
    const other: CloudApp = app === "gdrive" ? "onedrive" : "gdrive";
    if ((await this.storage.get(connKey(other))) === undefined && (await this.storage.get(lostKey(other))) === undefined) {
      await this.storage.deleteAll();
    }
  }
}
