/**
 * Canva Connect integration (2026-10-05).
 *
 * Two halves, both free of Hono and of `cloudflare:workers` so the test suite
 * can import this file directly under `node --experimental-strip-types`:
 *
 *   1. `CanvaAccount` — everything stored for one student: the connect
 *      handshake (PKCE), their Canva tokens (encrypted), the short-lived
 *      "where was I" contexts for Canva's Return button, and their drafts.
 *      It runs INSIDE that student's CanvaStore Durable Object (canvaStore.ts),
 *      which lives in the "us" jurisdiction like Sync does. A Durable Object
 *      handles one student's requests one at a time, which is what makes token
 *      refresh safe: Canva refresh tokens are single use, and two refreshes
 *      racing each other would burn the token and force the student to
 *      reconnect. (The parked 2026-09-28 version kept tokens in KV and could
 *      only narrow that race with a lock key; this closes it.)
 *
 *   2. Plain functions that call Canva with an access token: importing a file,
 *      reading/listing designs, the account name, and checking the signed JWT
 *      Canva sends back when the student clicks Return.
 *
 * Reference: claude/canva-api-reference.md in the project.
 *
 * Scopes requested: design:content:write (import a file as a design),
 * design:meta:read (read/list designs) and profile:read (the "Connected as"
 * name). design:content:read (exporting a design as a PDF to turn it in) is
 * added only when CANVA_EXPORT_ENABLED is "1": see canvaScopes().
 */

export const CANVA_API = "https://api.canva.com/rest/v1";
const AUTHORIZE = "https://www.canva.com/api/oauth/authorize";

export const CANVA_SCOPES = ["design:content:write", "design:meta:read", "profile:read"].join(" ");

/** Needed to export a design (a PDF to turn in, 2026-10-06). */
export const EXPORT_SCOPE = "design:content:read";

/**
 * Exporting is switched on by the CANVA_EXPORT_ENABLED var (2026-10-06), and
 * only after design:content:read is ticked for the integration in Canva's
 * Developer Portal: asking for a scope the integration doesn't have makes
 * Canva refuse the whole connect, so it can't be requested ahead of time.
 */
export function canvaExportEnabled(env: { CANVA_EXPORT_ENABLED?: string }): boolean {
  return env.CANVA_EXPORT_ENABLED === "1";
}

/** Canva folders on the Files page (2026-10-06): browse, and new / rename / move. */
export const FOLDER_READ_SCOPE = "folder:read";
export const FOLDER_WRITE_SCOPE = "folder:write";

/**
 * Folders are switched on by CANVA_FOLDERS_ENABLED (2026-10-06), only after
 * folder:read and folder:write are ticked for the integration in Canva's
 * Developer Portal (and approved): same rule as exporting.
 */
export function canvaFoldersEnabled(env: { CANVA_FOLDERS_ENABLED?: string }): boolean {
  return env.CANVA_FOLDERS_ENABLED === "1";
}

/**
 * Permission probe (temporary, 2026-10-10): Canva lists design:permission and
 * folder:permission scopes but its published OpenAPI spec has no request that
 * uses them. These are the extra scopes GET /canva/connect?probe=1 asks for so
 * the developer can test, from the live site with his own real connection,
 * whether anything responds to them (see probePermissions and POST /canva/probe
 * in index.ts). Only ever added when CANVA_PERMISSION_PROBE is "1"; developer
 * only, off otherwise.
 */
export const PROBE_SCOPES = ["design:permission:read", "design:permission:write", "folder:permission:write"];

export function canvaProbeEnabled(env: { CANVA_PERMISSION_PROBE?: string }): boolean {
  return env.CANVA_PERMISSION_PROBE === "1";
}

/**
 * The scopes a new connection asks for. `opts.probe` adds the undocumented
 * permission scopes (see PROBE_SCOPES), but only while CANVA_PERMISSION_PROBE
 * is "1" — otherwise probe is silently ignored, so a normal Connect is never
 * affected.
 */
export function canvaScopes(
  env: { CANVA_EXPORT_ENABLED?: string; CANVA_FOLDERS_ENABLED?: string; CANVA_PERMISSION_PROBE?: string },
  opts: { probe?: boolean } = {},
): string {
  const scopes = [CANVA_SCOPES];
  if (canvaExportEnabled(env)) scopes.push(EXPORT_SCOPE);
  if (canvaFoldersEnabled(env)) scopes.push(FOLDER_READ_SCOPE, FOLDER_WRITE_SCOPE);
  if (opts.probe && canvaProbeEnabled(env)) scopes.push(...PROBE_SCOPES);
  return scopes.join(" ");
}

/** Every Canva call gives up after 20 seconds, the same rule as the Schoology calls. */
const TIMEOUT_MS = 20_000;

/**
 * Biggest file we'll hand to Canva: 25 MB. The whole file sits in the
 * Worker's memory while it's sent (a Worker has 128 MB shared by everything
 * it's handling), so this stays well below that even with a few at once.
 */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export interface CanvaConfig {
  CANVA_CLIENT_ID?: string;
  CANVA_CLIENT_SECRET?: string;
  CANVA_REDIRECT_URI?: string;
  /** Also seals the stored Canva tokens (see sealTokens). */
  SESSION_SECRET?: string;
  /** "1" once design:content:read is enabled in Canva's Developer Portal (see canvaScopes). */
  CANVA_EXPORT_ENABLED?: string;
  /** "1" once folder:read and folder:write are enabled there (see canvaScopes). */
  CANVA_FOLDERS_ENABLED?: string;
  /** "1" only while testing the undocumented permission scopes (see canvaProbeEnabled / probePermissions). */
  CANVA_PERMISSION_PROBE?: string;
}

export function canvaConfigured(env: CanvaConfig): boolean {
  return !!(env.CANVA_CLIENT_ID && env.CANVA_CLIENT_SECRET && env.CANVA_REDIRECT_URI && env.SESSION_SECRET);
}

/** Errors carry a short code as their message, which the routes hand to the app. */
export class CanvaError extends Error {
  status: number;
  constructor(code: string, status = 502) {
    super(code);
    this.name = "CanvaError";
    this.status = status;
  }
}

/**
 * HTTP status for an error code. Errors thrown inside the Durable Object reach
 * the Worker as plain Errors (the class and its status don't survive RPC, the
 * message does), so routes look the status up from the code instead.
 */
export function statusForCode(code: string): number {
  if (code === "canva_not_configured") return 503;
  if (code === "canva_not_connected" || code === "canva_reconnect_needed" || code === "canva_duplicate_import") return 409;
  if (code === "canva_item_in_multiple_folders" || code === "canva_folder_full") return 409;
  if (code === "canva_folder_gone") return 404;
  if (code === "canva_folder_not_allowed") return 403;
  if (code === "canva_missing_permission") return 403;
  if (code === "canva_rate_limited") return 429;
  if (code === "canva_invalid_file" || code === "canva_import_failed") return 422;
  if (code === "canva_timeout" || code === "canva_import_timeout" || code === "canva_unreachable") return 504;
  if (/^canva_(callback|state|jwt)_/.test(code)) return 400;
  return 502;
}

export async function canvaFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new CanvaError(timedOut ? "canva_timeout" : "canva_unreachable", 504);
  }
}

/** Error pages may not be JSON; read them as {} so the status check still says something useful. */
async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/* ── small helpers ─────────────────────────────────────────────────── */

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const rand = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function codeChallenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

/**
 * A path on our own app: "/x", never "//host", "/\host" or a scheme. Query
 * strings allowed. Printable ASCII only (no spaces, no control characters), so
 * it can always go into a Location header; anything else is already
 * percent-encoded by the browser.
 */
export function safeAppPath(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || raw.length > 512) return fallback;
  return /^\/(?![\/\\])[\x21-\x5b\x5d-\x7e]*$/.test(raw) ? raw : fallback;
}

/** The connect `state` and Return keys we hand out: base64url, fixed lengths. */
export const STATE_RE = /^[A-Za-z0-9_-]{32}$/;
export const RETURN_KEY_RE = /^[A-Za-z0-9_-]{24}$/;

/** Adds one query parameter to an app path, whether or not it already has a query. */
export function withQuery(path: string, key: string, value: string): string {
  const hash = path.indexOf("#");
  const base = hash === -1 ? path : path.slice(0, hash);
  const frag = hash === -1 ? "" : path.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}${encodeURIComponent(key)}=${encodeURIComponent(value)}${frag}`;
}

/**
 * Canva caps an import title at 50 characters BEFORE base64 encoding, and the
 * extension is noise. Truncating after encoding would corrupt the base64.
 */
export function importTitle(filename: string): string {
  const stem = filename.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim() || "Untitled";
  return Array.from(stem).slice(0, 50).join("");
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  heic: "image/heic",
};

export function mimeForName(filename: string): string | undefined {
  const m = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? MIME_BY_EXT[m[1]] : undefined;
}

/* ── token sealing ─────────────────────────────────────────────────── */

/**
 * Canva tokens are encrypted before they're stored (AES-GCM, key derived from
 * SESSION_SECRET with HKDF), with the student's uid bound in as additional
 * data: a sealed blob only opens for the student it was made for. Changing
 * SESSION_SECRET makes stored tokens unreadable, which simply reads as "not
 * connected" and the student reconnects.
 */
async function tokenKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("averages.io canva tokens"),
      info: new TextEncoder().encode("v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealTokens(tokens: CanvaTokens, uid: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(uid) },
    await tokenKey(secret),
    new TextEncoder().encode(JSON.stringify(tokens)),
  );
  return `${b64url(iv)}.${b64url(new Uint8Array(data))}`;
}

export async function openTokens(sealed: string, uid: string, secret: string): Promise<CanvaTokens | null> {
  try {
    const [iv, data] = sealed.split(".");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(iv), additionalData: new TextEncoder().encode(uid) },
      await tokenKey(secret),
      b64urlDecode(data),
    );
    const t = JSON.parse(new TextDecoder().decode(plain));
    return typeof t?.access_token === "string" && typeof t?.refresh_token === "string" ? (t as CanvaTokens) : null;
  } catch {
    return null;
  }
}

/* ── per-student storage ───────────────────────────────────────────── */

/** The part of DurableObjectStorage this file uses (a Map-backed fake in tests). */
export interface CanvaStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface CanvaTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch seconds. */
  expires_at: number;
  scope?: string;
}

interface PendingConnect {
  verifier: string;
  returnTo: string;
  exp: number;
}

/** Where the student was when they opened a design, so Return can bring them back. */
export interface ReturnContext {
  designId: string;
  returnTo: string;
  exp?: number;
}

export interface Draft {
  designId: string;
  title: string;
  /** The assignment attachment it was made from. */
  sourceName: string;
  fileId: string;
  section: string;
  assignment: string;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
}

const CONNECT_TTL_S = 10 * 60;
/** Canva's return JWT is valid about a day; the context lives as long. */
const RETURN_TTL_S = 24 * 60 * 60;
const MAX_DRAFTS = 200;
/** Refresh five minutes before the access token actually expires. */
const SKEW_S = 300;

const nowS = () => Math.floor(Date.now() / 1000);

function prune<T extends { exp?: number }>(map: Record<string, T> | undefined, keep: number): Record<string, T> {
  const now = nowS();
  const live = Object.entries(map ?? {}).filter(([, v]) => v && typeof v === "object" && (!v.exp || v.exp > now));
  // newest last; keep the most recent `keep`
  live.sort((a, b) => (a[1].exp ?? 0) - (b[1].exp ?? 0));
  // No prototype: a key like "constructor" or "__proto__" must never match something built in.
  return Object.assign(Object.create(null), Object.fromEntries(live.slice(-keep)));
}

/** Canva's space-separated `scope`, as a list; null when it wasn't sent. */
function scopesOf(tokens: CanvaTokens): string[] | null {
  return typeof tokens.scope === "string" && tokens.scope.trim() ? tokens.scope.trim().split(/\s+/) : null;
}

/** An entry that was really stored under `key`, never an inherited property. */
function own<T>(map: Record<string, T>, key: string): T | null {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

/**
 * One student's Canva connection and drafts. Every method takes the student's
 * uid: it seals/opens their tokens and guards against a Durable Object being
 * reached under the wrong name.
 */
export class CanvaAccount {
  storage: CanvaStorage;
  env: CanvaConfig;
  /** In-flight refresh, shared by concurrent callers so the refresh token is only spent once. */
  refreshing: Promise<string> | null = null;
  /**
   * Bumped by disconnect(). A token exchange or refresh that started before
   * Disconnect was pressed finds it changed and doesn't save, so Disconnect
   * can't be undone by a request that was already on its way to Canva.
   */
  generation = 0;

  constructor(storage: CanvaStorage, env: CanvaConfig) {
    this.storage = storage;
    this.env = env;
  }

  /* ── connect ── */

  async beginConnect(returnTo: string, opts: { probe?: boolean } = {}): Promise<string> {
    if (!canvaConfigured(this.env)) throw new CanvaError("canva_not_configured", 503);
    // 43-128 chars; 48 random bytes = 64 chars. Never leaves the server:
    // only `state` goes to the browser.
    const verifier = rand(48);
    const state = rand(24);
    const pending = prune(await this.storage.get<Record<string, PendingConnect>>("connect"), 4);
    pending[state] = { verifier, returnTo: safeAppPath(returnTo, "/settings"), exp: nowS() + CONNECT_TTL_S };
    await this.storage.put("connect", pending);

    // Built by hand: URLSearchParams encodes spaces as "+", and Canva's scope
    // separator has to be %20.
    const q = ([
      ["client_id", this.env.CANVA_CLIENT_ID!],
      ["response_type", "code"],
      ["code_challenge", await codeChallenge(verifier)],
      ["code_challenge_method", "S256"],
      ["scope", canvaScopes(this.env, opts)],
      ["state", state],
      ["redirect_uri", this.env.CANVA_REDIRECT_URI!],
    ] as [string, string][])
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${AUTHORIZE}?${q}`;
  }

  /**
   * Canva sent the student back with code + state. The state must be one this
   * same student started (it's looked up in their own storage, so a state from
   * someone else's browser simply isn't found) and is single use.
   * Returns the app path to send them to.
   */
  async finishConnect(uid: string, state: string, code: string): Promise<string> {
    if (!state || !code) throw new CanvaError("canva_callback_missing_params", 400);
    if (!STATE_RE.test(state) || code.length > 2048) throw new CanvaError("canva_state_not_found", 400);
    const pending = prune(await this.storage.get<Record<string, PendingConnect>>("connect"), 4);
    const entry = own(pending, state);
    delete pending[state];
    await this.storage.put("connect", pending);
    if (!entry || typeof entry.verifier !== "string" || entry.verifier.length < 43) {
      throw new CanvaError("canva_state_not_found", 400);
    }

    const gen = this.generation;
    const tokens = await tokenRequest(this.env, {
      grant_type: "authorization_code",
      code,
      code_verifier: entry.verifier,
      redirect_uri: this.env.CANVA_REDIRECT_URI!,
    });
    if (gen !== this.generation) throw new CanvaError("canva_not_connected", 409);
    await this.saveTokens(uid, tokens);
    // The name is only for "Connected as ..."; failing to read it isn't a failed connect.
    try {
      const name = await getProfileName(tokens.access_token);
      if (name) await this.storage.put("profile", { name });
    } catch {
      /* keep going */
    }
    return entry.returnTo;
  }

  async status(uid: string): Promise<{ connected: boolean; name: string }> {
    const tokens = await this.loadTokens(uid);
    if (!tokens) return { connected: false, name: "" };
    const profile = await this.storage.get<{ name?: string }>("profile");
    return { connected: true, name: profile?.name ?? "" };
  }

  /**
   * Forget everything: tokens, drafts, pending contexts. Deliberately does not
   * call Canva's /oauth/revoke, which would also withdraw the student's consent
   * for the whole integration; removing Averages.io in Canva's own settings is
   * where a full revoke belongs (Settings says so).
   */
  async disconnect(): Promise<void> {
    this.generation++;
    this.refreshing = null;
    await this.storage.deleteAll();
  }

  /* ── tokens ── */

  async saveTokens(uid: string, tokens: CanvaTokens): Promise<void> {
    await this.storage.put("tokens", await sealTokens(tokens, uid, this.env.SESSION_SECRET!));
  }

  async loadTokens(uid: string): Promise<CanvaTokens | null> {
    const sealed = await this.storage.get<string>("tokens");
    if (!sealed || !this.env.SESSION_SECRET) return null;
    return openTokens(sealed, uid, this.env.SESSION_SECRET);
  }

  /** A valid access token, refreshing it first if it's about to expire. */
  async accessToken(uid: string): Promise<string> {
    const tokens = await this.loadTokens(uid);
    if (!tokens) throw new CanvaError("canva_not_connected", 409);
    if (tokens.expires_at - SKEW_S > nowS()) return tokens.access_token;

    if (!this.refreshing) {
      const gen = this.generation;
      this.refreshing = (async () => {
        try {
          const fresh = await tokenRequest(this.env, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
          // Disconnected while this was on its way to Canva: don't bring the connection back.
          if (gen !== this.generation) throw new CanvaError("canva_not_connected", 409);
          // A refresh keeps the scopes the student granted; if Canva leaves
          // them out of the answer, keep the ones we knew (2026-10-06).
          if (!fresh.scope && tokens.scope) fresh.scope = tokens.scope;
          // Save BEFORE using it: the new refresh token is now the only valid one.
          await this.saveTokens(uid, fresh);
          return fresh.access_token;
        } catch (error) {
          // A refused refresh token won't work next time either: drop the
          // connection so the app shows "Connect" instead of failing forever.
          if (error instanceof CanvaError && error.message === "canva_reconnect_needed" && gen === this.generation) {
            await this.storage.delete("tokens");
            await this.storage.delete("profile");
          }
          throw error;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  /**
   * The scopes the student actually granted, from Canva's token answer
   * (2026-10-06). Null when we don't know (Canva didn't say).
   */
  async grantedScopes(uid: string): Promise<string[] | null> {
    const tokens = await this.loadTokens(uid);
    return tokens ? scopesOf(tokens) : null;
  }

  /**
   * An access token that can do `scope`. A connection made before the scope
   * was asked for can't: the student has to reconnect to grant it, so that's
   * canva_reconnect_needed (without dropping the connection, which still
   * works for everything else). Checked before any refresh, so a token that
   * can't do it never costs a refresh. When Canva never told us the scopes,
   * the call goes ahead and Canva's own answer decides.
   */
  async accessTokenWithScope(uid: string, scope: string): Promise<string> {
    const tokens = await this.loadTokens(uid);
    if (!tokens) throw new CanvaError("canva_not_connected", 409);
    const granted = scopesOf(tokens);
    if (granted && !granted.includes(scope)) throw new CanvaError("canva_reconnect_needed", 409);
    return this.accessToken(uid);
  }

  /* ── Return contexts ── */

  async saveReturn(ctx: ReturnContext): Promise<string> {
    const key = rand(18); // 24 characters; Canva allows up to 50
    const all = prune(await this.storage.get<Record<string, ReturnContext>>("returns"), 20);
    all[key] = { designId: ctx.designId, returnTo: safeAppPath(ctx.returnTo, "/"), exp: nowS() + RETURN_TTL_S };
    await this.storage.put("returns", all);
    return key;
  }

  /** Single use: the context is removed as it's read. */
  async takeReturn(key: string): Promise<ReturnContext | null> {
    if (!RETURN_KEY_RE.test(String(key))) return null;
    const all = prune(await this.storage.get<Record<string, ReturnContext>>("returns"), 20);
    const ctx = own(all, key);
    delete all[key];
    await this.storage.put("returns", all);
    return ctx;
  }

  /* ── which design each attachment became ── */

  /**
   * Kept apart from the drafts list on purpose: Canva refuses to import the
   * same file twice, so after a draft is deleted from Averages.io, Edit in
   * Canva on that file has to find the design it already made.
   */
  async rememberImport(section: string, assignment: string, fileId: string, designId: string): Promise<void> {
    const map = Object.assign(Object.create(null), (await this.storage.get<Record<string, string>>("imports")) ?? {});
    const key = `${section}:${assignment}:${fileId}`;
    delete map[key];
    map[key] = designId;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete map[k]; // keep the newest 500
    await this.storage.put("imports", { ...map });
  }

  async importedDesign(section: string, assignment: string, fileId: string): Promise<string | null> {
    const map = (await this.storage.get<Record<string, string>>("imports")) ?? {};
    const id = own(map, `${section}:${assignment}:${fileId}`);
    return typeof id === "string" ? id : null;
  }

  /* ── drafts ── */

  async drafts(): Promise<Draft[]> {
    return (await this.storage.get<Draft[]>("drafts")) ?? [];
  }

  async listDrafts(section: string, assignment: string): Promise<Draft[]> {
    return (await this.drafts())
      .filter((d) => d.section === section && d.assignment === assignment)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async findDraftForFile(section: string, assignment: string, fileId: string): Promise<Draft | null> {
    return (await this.drafts()).find((d) => d.section === section && d.assignment === assignment && d.fileId === fileId) ?? null;
  }

  async addDraft(draft: Draft): Promise<void> {
    const all = (await this.drafts()).filter((d) => d.designId !== draft.designId);
    all.push(draft);
    all.sort((a, b) => a.updatedAt - b.updatedAt);
    await this.storage.put("drafts", all.slice(-MAX_DRAFTS));
  }

  async touchDraft(designId: string, title?: string): Promise<void> {
    const all = await this.drafts();
    const d = all.find((x) => x.designId === designId);
    if (!d) return;
    d.updatedAt = Date.now();
    if (title) d.title = title;
    await this.storage.put("drafts", all);
  }

  async removeDraft(designId: string): Promise<boolean> {
    const all = await this.drafts();
    const next = all.filter((d) => d.designId !== designId);
    if (next.length === all.length) return false;
    await this.storage.put("drafts", next);
    return true;
  }
}

/* ── calls to Canva ────────────────────────────────────────────────── */

/** Code exchange and refresh. Server only: Canva blocks this from browsers, and it needs the client secret. */
export async function tokenRequest(env: CanvaConfig, body: Record<string, string>): Promise<CanvaTokens> {
  const res = await canvaFetch(`${CANVA_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.CANVA_CLIENT_ID}:${env.CANVA_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = await readJson(res);
  if (!res.ok || typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
    // Only invalid_grant means the student's code or refresh token is spent
    // (used, expired or revoked). Anything else, such as invalid_client from a
    // wrong client secret, is our problem: keep their tokens, they'll work
    // again once it's fixed.
    const kind = String(json?.error ?? json?.code ?? "");
    if (kind === "invalid_grant") throw new CanvaError("canva_reconnect_needed", 409);
    throw new CanvaError("canva_token_failed", 502);
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    // expires_in is 14400 today but documented as subject to change.
    expires_at: nowS() + Number(json.expires_in ?? 14400),
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

/** Maps a Canva error onto a code the app understands. Canva's own `code` beats the status. */
function failure(res: Response, what: string, json?: any): CanvaError {
  const code = String(json?.code ?? "");
  if (code === "duplicate_import") return new CanvaError("canva_duplicate_import", 409);
  if (code === "too_many_requests" || code.endsWith("_throttled")) return new CanvaError("canva_rate_limited", 429);
  if (code === "invalid_file") return new CanvaError("canva_invalid_file", 422);
  if (res.status === 401) return new CanvaError("canva_reconnect_needed", 409);
  if (res.status === 403) return new CanvaError("canva_missing_permission", 403);
  if (res.status === 429) return new CanvaError("canva_rate_limited", 429);
  return new CanvaError(`canva_${what}_failed`, 502);
}

export async function getProfileName(token: string): Promise<string> {
  const res = await canvaFetch(`${CANVA_API}/users/me/profile`, { headers: bearer(token) });
  if (!res.ok) throw failure(res, "profile");
  const json = await readJson(res);
  return String(json?.profile?.display_name ?? "").slice(0, 120);
}

export interface DesignInfo {
  id: string;
  title: string;
  editUrl: string;
  viewUrl: string;
  /** Expires after about 15 minutes: never store it. */
  thumbnailUrl: string;
  /** Epoch ms. */
  updatedAt: number;
}

function toDesign(d: any): DesignInfo {
  const updated = Number(d?.updated_at ?? 0);
  return {
    id: String(d?.id ?? ""),
    title: String(d?.title ?? ""),
    editUrl: String(d?.urls?.edit_url ?? ""),
    viewUrl: String(d?.urls?.view_url ?? ""),
    thumbnailUrl: String(d?.thumbnail?.url ?? ""),
    // Canva sends seconds; tolerate milliseconds too.
    updatedAt: updated > 1e12 ? updated : updated * 1000,
  };
}

/**
 * A PDF or Office file becomes a design through an import job: create it with
 * the file's bytes, then poll until it finishes. A long PDF can come back as
 * more than one design.
 */
export async function importFile(
  token: string,
  filename: string,
  bytes: ArrayBuffer,
  mimeType?: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<DesignInfo[]> {
  // Standard base64 with padding (Canva's own example ends in "=="), of the UTF-8 title.
  const titleBytes = new TextEncoder().encode(importTitle(filename));
  const meta: Record<string, string> = { title_base64: btoa(String.fromCharCode(...titleBytes)) };
  if (mimeType) meta.mime_type = mimeType;

  const create = await canvaFetch(`${CANVA_API}/imports`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/octet-stream", "Import-Metadata": JSON.stringify(meta) },
    body: bytes,
  });
  const created = await readJson(create);
  if (!create.ok || !created?.job?.id) throw failure(create, "import", created);
  const jobId = String(created.job.id);

  // Creating is limited to 20 a minute per student, polling to 120, so back off gently.
  let waitMs = 700;
  for (let attempt = 0; attempt < 14; attempt++) {
    await wait(waitMs);
    waitMs = Math.min(Math.round(waitMs * 1.6), 5000);
    const poll = await canvaFetch(`${CANVA_API}/imports/${encodeURIComponent(jobId)}`, { headers: bearer(token) });
    const job = await readJson(poll);
    if (!poll.ok) throw failure(poll, "import", job);
    const status = job?.job?.status;
    if (status === "success") return (job.job.result?.designs ?? []).map(toDesign).filter((d: DesignInfo) => d.id && d.editUrl);
    if (status === "failed") {
      const err = failure(poll, "import", job?.job?.error);
      throw err.message === "canva_import_failed" ? new CanvaError("canva_import_failed", 422) : err;
    }
  }
  throw new CanvaError("canva_import_timeout", 504);
}

/** One design, or null when it no longer exists (deleted in Canva). */
export async function getDesign(token: string, designId: string): Promise<DesignInfo | null> {
  const res = await canvaFetch(`${CANVA_API}/designs/${encodeURIComponent(designId)}`, { headers: bearer(token) });
  // 404: deleted (or never edited and expired). 403: belongs to a different
  // Canva account than the one connected now. Either way it's not openable.
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw failure(res, "design");
  const json = await readJson(res);
  return json?.design ? toDesign(json.design) : null;
}

/** The student's own designs, newest first. Thumbnails expire, so the route must not be cached. */
export async function listDesigns(
  token: string,
  continuation?: string,
  opts: { query?: string; ownership?: "any" | "owned" } = {},
): Promise<{ items: DesignInfo[]; continuation?: string }> {
  // Owned and shared with them ("any"), newest first, up to 50 a page.
  const q = new URLSearchParams({ sort_by: "modified_descending", ownership: opts.ownership ?? "any", limit: "50" });
  if (continuation) q.set("continuation", continuation);
  if (opts.query) q.set("query", opts.query.slice(0, 255));
  const res = await canvaFetch(`${CANVA_API}/designs?${q}`, { headers: bearer(token) });
  if (!res.ok) throw failure(res, "list", await readJson(res));
  const json = await readJson(res);
  return {
    items: (json?.items ?? []).map(toDesign).filter((d: DesignInfo) => d.id),
    continuation: typeof json?.continuation === "string" ? json.continuation : undefined,
  };
}

/**
 * After Canva refuses a repeat import (duplicate_import) and we have no record
 * of the design it made, look for the student's own design with that title.
 */
export async function findDesignByTitle(token: string, title: string): Promise<DesignInfo | null> {
  const page = await listDesigns(token, undefined, { query: title, ownership: "owned" });
  return page.items.find((d) => d.title === title && d.editUrl) ?? null;
}

/** Appends Canva's correlation_state so the editor shows a Return button that knows where to go. */
export function editUrlWithCorrelation(editUrl: string, key: string): string {
  return `${editUrl}${editUrl.includes("?") ? "&" : "?"}correlation_state=${encodeURIComponent(key)}`;
}

/* ── the Return JWT ────────────────────────────────────────────────── */

interface Jwk {
  kid: string;
  kty: string;
  crv: string;
  x: string;
}

/**
 * Canva's public keys, cached per Worker instance for an hour and re-fetched
 * early only for an unknown kid (at most every 10 seconds, so made-up kids
 * can't make us hammer Canva, nor block a real rotation for long).
 */
let jwksCache = new Map<string, CryptoKey>();
let jwksFetchedAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 10_000;

/** For tests. */
export function clearJwksCache(): void {
  jwksCache = new Map();
  jwksFetchedAt = 0;
}

async function keyForKid(kid: string): Promise<CryptoKey> {
  const fresh = Date.now() - jwksFetchedAt < JWKS_TTL_MS;
  const cached = fresh ? jwksCache.get(kid) : undefined;
  if (cached) return cached;
  if (!fresh || Date.now() - jwksFetchedAt > JWKS_MIN_REFETCH_MS) {
    jwksFetchedAt = Date.now();
    const res = await canvaFetch(`${CANVA_API}/connect/keys`);
    if (!res.ok) throw new CanvaError("canva_jwks_failed", 502);
    const keys: Jwk[] = (await readJson(res))?.keys ?? [];
    // Replace the whole set, so a key Canva has withdrawn stops being trusted.
    const next = new Map<string, CryptoKey>();
    for (const k of Array.isArray(keys) ? keys : []) {
      if (!k?.kid || k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string") continue;
      try {
        next.set(k.kid, await crypto.subtle.importKey("jwk", { kty: k.kty, crv: k.crv, x: k.x }, { name: "Ed25519" }, false, ["verify"]));
      } catch {
        // one malformed key mustn't stop the others from loading
      }
    }
    jwksCache = next;
  }
  const key = jwksCache.get(kid);
  if (!key) throw new CanvaError("canva_jwt_unknown_kid", 400);
  return key;
}

/**
 * Checks the correlation_jwt Canva puts on the Return URL: Ed25519 signature,
 * audience = our client ID, type "rti", not expired. Hostile until proven
 * otherwise. Returns the design and our own correlation_state key.
 */
export async function verifyReturnJwt(
  env: CanvaConfig,
  jwt: string,
): Promise<{ designId: string; correlationState: string }> {
  const parts = String(jwt).split(".");
  if (parts.length !== 3) throw new CanvaError("canva_jwt_malformed", 400);
  let header: any;
  let claims: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    throw new CanvaError("canva_jwt_malformed", 400);
  }
  const key = await keyForKid(String(header?.kid ?? ""));
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new CanvaError("canva_jwt_bad_signature", 400);
  if (claims.aud !== env.CANVA_CLIENT_ID) throw new CanvaError("canva_jwt_bad_audience", 400);
  if (claims.type !== "rti") throw new CanvaError("canva_jwt_bad_type", 400);
  if (typeof claims.exp !== "number" || claims.exp <= nowS()) throw new CanvaError("canva_jwt_expired", 400);
  if (typeof claims.design_id !== "string" || typeof claims.correlation_state !== "string") {
    throw new CanvaError("canva_jwt_malformed", 400);
  }
  return { designId: claims.design_id, correlationState: claims.correlation_state };
}

/* ── permission probe (temporary, 2026-10-10) ──────────────────────────
 *
 * Canva's published OpenAPI spec has no request that uses the
 * design:permission:* / folder:permission:write scopes. probePermissions()
 * tries the most likely addresses (modelled on how the rest of Canva's API is
 * laid out: comments and pages hang under …/designs/{id}, so permissions
 * probably do too) and returns what Canva answered, so POST /canva/probe can
 * hand it to the developer. Ported from the standalone reference script
 * (out/canva-permission-probe/canva-permission-probe.mjs), same guess lists
 * and behaviour.
 *
 * Safe by design:
 *   - Makes one throwaway test design and one test folder and ONLY ever tries
 *     to change those two ids. Nothing else is touched.
 *   - Read-only unless `write` is set, and even then only on the TEST design
 *     (and the TEST folder), stopping at the first write Canva accepts.
 *   - Each call gives up after PROBE_TIMEOUT_MS; a failed call is recorded as
 *     a row, never thrown, so one dead guess doesn't stop the rest.
 *   - Counts its Canva calls and stops before the Worker's 50-subrequest
 *     limit, noting in the results when it had to skip the remaining guesses.
 *   - The access token never appears in a result row (only Canva's response
 *     text, cut to 600 chars) and is never logged.
 */

/** A little tighter than the 20 s on the rest of Canva: these are guesses, not real work. */
const PROBE_TIMEOUT_MS = 9_000;

/** Well under the Worker's (and Canva's) 50-subrequest ceiling, counting the two creates. */
const PROBE_BUDGET = 45;

/** Same title for the test design and folder; says plainly it can be deleted. */
export const PROBE_TITLE = "Averages permission test (safe to delete)";

export interface ProbeResult {
  method: string;
  /** Relative to /v1, e.g. "/designs/{id}/permissions". */
  path: string;
  body: any;
  status: number;
  /** Canva's response text, cut to 600 chars. Never carries a token. */
  answer: string;
}

export async function probePermissions(
  token: string,
  opts: { write?: boolean } = {},
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ designId: string; folderId: string; results: ProbeResult[] }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const results: ProbeResult[] = [];
  let calls = 0;
  let skipped = 0;

  /** One Canva call, recorded as a row. Counts a subrequest; never throws. */
  async function call(method: string, path: string, body?: any): Promise<ProbeResult> {
    calls++;
    const headers: Record<string, string> = { ...(bearer(token) as Record<string, string>) };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let status = 0;
    let text = "";
    try {
      const r = await doFetch(`${CANVA_API}${path}`, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      status = r.status;
      text = await r.text();
    } catch (error) {
      // A timeout or network error is just another answer for a guess: record it.
      text = error instanceof Error ? error.message : String(error);
    }
    const row: ProbeResult = { method, path, body: body ?? null, status, answer: text.slice(0, 600) };
    results.push(row);
    return row;
  }

  /** Room for `need` more calls without passing the budget. */
  const budgetLeft = (need = 1) => calls + need <= PROBE_BUDGET;

  // A throwaway design and folder to try things on. Only these ids are touched.
  const mk = await call("POST", "/designs", { type: "type_and_asset", design_type: { type: "preset", name: "doc" }, title: PROBE_TITLE });
  let designId = "";
  try {
    designId = String(JSON.parse(mk.answer)?.design?.id ?? "");
  } catch {
    /* leave empty */
  }
  const mf = await call("POST", "/folders", { name: PROBE_TITLE, parent_folder_id: "root" });
  let folderId = "";
  try {
    folderId = String(JSON.parse(mf.answer)?.folder?.id ?? "");
  } catch {
    /* leave empty */
  }
  // No test design, nothing to probe against: stop here (the two rows above say why).
  if (!designId) return { designId, folderId, results };

  const D = `/designs/${designId}`;
  // Reading: where would the list of people / link access live? Canva nests
  // things under the design (…/comments, /pages, /export-formats), so the
  // likeliest home is …/designs/{id}/permissions. Then the two flat styles.
  const reads: string[] = [
    `${D}/permissions`,
    `${D}/permissions/link`,
    `${D}/access`,
    `${D}/access-list`,
    `${D}/sharing`,
    `${D}/share`,
    `${D}/share-settings`,
    `${D}/collaborators`,
    `${D}/members`,
    `${D}/links`,
    `${D}/share-links`,
    `${D}/public-link`,
    `/designs/permissions?design_id=${designId}`,
    `/permissions?resource_id=${designId}`,
  ];
  if (folderId) {
    reads.push(`/folders/${folderId}/permissions`, `/folders/${folderId}/access`, `/folders/${folderId}/collaborators`, `/folders/${folderId}/sharing`);
  }
  for (const p of reads) {
    if (!budgetLeft()) {
      skipped++;
      continue;
    }
    await call("GET", p, undefined);
  }
  // A full design read: does Canva now include sharing info in the design itself?
  if (budgetLeft()) await call("GET", D, undefined);
  else skipped++;

  if (opts.write) {
    // Write guesses on the TEST design only, stopping at the first Canva accepts.
    const writes: [string, string, any][] = [
      ["POST", `${D}/permissions`, { type: "anyone", role: "viewer" }],
      ["POST", `${D}/permissions`, { audience: "anyone_with_link", role: "view" }],
      ["POST", `${D}/permissions`, { grantee: { type: "anyone" }, role: "can_view" }],
      ["PATCH", `${D}/permissions`, { link_access: { audience: "anyone", role: "view" } }],
      ["PUT", `${D}/permissions/link`, { audience: "anyone", role: "view" }],
      ["PATCH", `${D}/permissions/link`, { audience: "anyone", role: "view" }],
      ["PATCH", `${D}/access`, { link: { audience: "anyone", role: "view" } }],
      ["PATCH", D, { sharing: { link_access: "view" } }],
    ];
    for (const [method, path, body] of writes) {
      if (!budgetLeft()) {
        skipped++;
        break;
      }
      const r = await call(method, path, body);
      if (r.status >= 200 && r.status < 300) break; // Canva accepted one: stop.
    }
    if (folderId) {
      const folderWrites: [string, string, any][] = [
        ["POST", `/folders/${folderId}/permissions`, { type: "anyone", role: "viewer" }],
        ["PATCH", `/folders/${folderId}/permissions`, { link_access: { audience: "anyone", role: "view" } }],
      ];
      for (const [method, path, body] of folderWrites) {
        if (!budgetLeft()) {
          skipped++;
          break;
        }
        await call(method, path, body);
      }
    }
  }

  if (skipped) {
    results.push({
      method: "NOTE",
      path: "",
      body: null,
      status: 0,
      answer: `Subrequest budget (${PROBE_BUDGET}) reached after ${calls} calls; skipped ${skipped} remaining guess(es).`,
    });
  }
  return { designId, folderId, results };
}
