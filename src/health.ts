// Automatic outage notices (2026-11-10, Martin: "have the maintenance banners be automatically on if a connector or
// login is down", then "just have it auto refresh on the server every 15 min").
//
// Every 15 minutes (a Cron Trigger, wrangler.jsonc) the API checks each part of Averages.io once and keeps the answer
// in one small record (HealthStore, US):
//  - outside services: each one's API is asked something harmless with no sign-in. Any real answer (even "please
//    sign in") means it's up; an error on their side (5xx), a timeout or no connection means it's down.
//    Schoology sign-in asks Schoology for a sign-in request token with our own app key, the first step every
//    "Sign in with Schoology" takes, so a broken key shows too.
//  - our own pieces: Sync, notifications and calendar sync each read their own test record; profile pictures list
//    the picture storage. An error means it's down.
// While anything is down, the pages' banner says what (unless the maintenance switch is on: its message wins), and
// api.averages.io/status shows each part. No student data is touched: the test records hold nothing.

export const HEALTH_SERVICES = [
  "schoology-signin",
  "schoology",
  "canva",
  "gdrive",
  "onedrive",
  "sync",
  "notifications",
  "calendar",
  "pictures",
] as const;
export type HealthService = (typeof HEALTH_SERVICES)[number];

/** How often the check runs (the cron), and when a saved answer is too old to trust (two checks missed). */
export const HEALTH_EVERY_MS = 15 * 60_000;
export const HEALTH_STALE_MS = 2 * HEALTH_EVERY_MS + 5 * 60_000;
export const HEALTH_TIMEOUT_MS = 8000;

export type HealthAnswer = "ok" | "down" | "off";
export interface HealthRecord {
  /** When the check ran (epoch ms). */
  checked: number;
  services: Partial<Record<HealthService, HealthAnswer>>;
  /** When each part went down (epoch ms), while it's down. */
  since: Partial<Record<HealthService, number>>;
}

export function isHealthService(x: unknown): x is HealthService {
  return typeof x === "string" && (HEALTH_SERVICES as readonly string[]).includes(x);
}

/** An answer that means the service itself is in trouble (not just "please sign in"). */
export function upstreamTrouble(status: number): boolean {
  return status >= 500 && status !== 501;
}

/** The new record from one round of checks: when each part went down carries over while it stays down. */
export function nextRecord(prev: HealthRecord | null, services: Partial<Record<HealthService, HealthAnswer>>, now: number): HealthRecord {
  const since: Partial<Record<HealthService, number>> = {};
  for (const s of HEALTH_SERVICES) if (services[s] === "down") since[s] = prev?.since?.[s] && prev.services?.[s] === "down" ? prev.since[s]! : now;
  return { checked: now, services, since };
}

/** What's down by a saved record, or nothing when there's no record or it's too old to trust. */
export function downNow(rec: HealthRecord | null, now: number): HealthService[] {
  if (!rec || typeof rec.checked !== "number" || now - rec.checked > HEALTH_STALE_MS) return [];
  return HEALTH_SERVICES.filter((s) => rec.services?.[s] === "down");
}

/** What the banner says while something's down (the friendliest line for each, joined when there are several). */
export const HEALTH_MESSAGES: Record<HealthService, string> = {
  "schoology-signin": "Signing in with Schoology is having trouble right now. If you're already signed in, you can keep going.",
  schoology: "Schoology isn't answering right now, so grades, assignments and messages may not update.",
  canva: "Canva isn't working right now. You can still turn in files from your computer.",
  gdrive: "Google Drive isn't working right now. You can still turn in files from your computer.",
  onedrive: "OneDrive isn't working right now. You can still turn in files from your computer.",
  sync: "Syncing across devices isn't working right now. Your changes are saved on this device.",
  notifications: "Notifications may be late right now.",
  calendar: "Calendar sync isn't updating right now.",
  pictures: "Profile pictures and backgrounds may not load right now.",
};
const HEALTH_NAMES: Record<HealthService, string> = {
  "schoology-signin": "signing in",
  schoology: "Schoology",
  canva: "Canva",
  gdrive: "Google Drive",
  onedrive: "OneDrive",
  sync: "syncing across devices",
  notifications: "notifications",
  calendar: "calendar sync",
  pictures: "profile pictures",
};

/** The banner's line for what's down, or "" when nothing is. */
export function healthMessage(down: HealthService[]): string {
  // Schoology being down explains sign-in being down too
  const list = down.filter((s) => !(s === "schoology-signin" && down.includes("schoology")));
  if (!list.length) return "";
  if (list.length === 1) return HEALTH_MESSAGES[list[0]];
  const names = list.map((s) => HEALTH_NAMES[s]);
  const joined = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `A few things are having trouble right now: ${joined}. Everything else still works.`;
}

/* ── the checks ───────────────────────────────────────────────────────── */

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** An outside API, asked without signing in: any answer but a server error means it's up. */
export async function reachable(url: string, f: Fetcher = fetch, init: RequestInit = {}): Promise<HealthAnswer> {
  try {
    const res = await f(url, { method: "GET", redirect: "manual", ...init, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    await res.body?.cancel().catch(() => {});
    return upstreamTrouble(res.status) ? "down" : "ok";
  } catch {
    return "down";
  }
}

/** A check that's up when it finishes without an error (our own pieces), within the time limit. */
export async function works(run: () => Promise<unknown>): Promise<HealthAnswer> {
  try {
    await Promise.race([run(), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), HEALTH_TIMEOUT_MS))]);
    return "ok";
  } catch {
    return "down";
  }
}

export interface HealthChecks {
  /** Schoology sign-in: the first step of "Sign in with Schoology"; null when sign-in with Schoology isn't set up. */
  signin: (() => Promise<HealthAnswer>) | null;
  fetcher?: Fetcher;
  /** Our own pieces: null when not set up here (their answer is "off"). */
  sync: (() => Promise<unknown>) | null;
  notifications: (() => Promise<unknown>) | null;
  calendar: (() => Promise<unknown>) | null;
  pictures: (() => Promise<unknown>) | null;
  /** Which connections are set up at all (a connection that isn't is "off", never "down"). */
  canva: boolean;
  gdrive: boolean;
  onedrive: boolean;
}

/** One round: every part at once. */
export async function runChecks(c: HealthChecks): Promise<Partial<Record<HealthService, HealthAnswer>>> {
  const f = c.fetcher ?? fetch;
  const own = (run: (() => Promise<unknown>) | null) => (run ? works(run) : Promise.resolve<HealthAnswer>("off"));
  const [signin, schoology, canva, gdrive, onedrive, sync, notifications, calendar, pictures] = await Promise.all([
    c.signin ? c.signin().catch((): HealthAnswer => "down") : Promise.resolve<HealthAnswer>("off"),
    reachable("https://api.schoology.com/v1/users/me", f),
    c.canva ? reachable("https://api.canva.com/rest/v1/users/me", f) : Promise.resolve<HealthAnswer>("off"),
    c.gdrive ? reachable("https://www.googleapis.com/drive/v3/about?fields=user", f) : Promise.resolve<HealthAnswer>("off"),
    c.onedrive ? reachable("https://graph.microsoft.com/v1.0/me", f) : Promise.resolve<HealthAnswer>("off"),
    own(c.sync),
    own(c.notifications),
    own(c.calendar),
    own(c.pictures),
  ]);
  return { "schoology-signin": signin, schoology, canva, gdrive, onedrive, sync, notifications, calendar, pictures };
}

/* ── where it's kept: HealthStore, one for the whole app ───────────────── */

interface HealthEnv {
  HEALTH?: { idFromName(n: string): unknown; get(id: unknown): any; jurisdiction?(j: string): any };
}
export function healthStore(env: HealthEnv, local: boolean): any | null {
  const ns = env.HEALTH;
  if (!ns) return null;
  let n = ns;
  if (!local && typeof ns.jurisdiction === "function") try { n = ns.jurisdiction("us"); } catch { n = ns; }   // local dev has no jurisdictions
  return n.get(n.idFromName("health"));
}

/** The saved record, cached for a minute per Worker (it only changes every 15). */
let cached: { at: number; rec: HealthRecord | null } = { at: 0, rec: null };
export async function readHealth(env: HealthEnv, local: boolean): Promise<HealthRecord | null> {
  const now = Date.now();
  if (now - cached.at < 60_000) return cached.rec;
  let rec: HealthRecord | null = null;
  try {
    const store = healthStore(env, local);
    if (store) rec = await Promise.race([store.read(), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
  } catch {
    rec = null;
  }
  cached = { at: now, rec };
  return rec;
}
export function resetHealthCache(): void {
  cached = { at: 0, rec: null };
}
