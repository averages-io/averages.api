/**
 * Rate limits on the API's own routes (2026-10-06), as Hono middleware.
 *
 * Why: every route here fans out to Schoology or Google with the student's
 * own credentials, and Schoology's rate limit is unpublished. A runaway page
 * (or a script holding a session cookie) could otherwise get a student's key
 * throttled by Schoology for everyone at their school, and sign-in could be
 * used to hammer Schoology with guesses.
 *
 * Limits, per minute (a sliding 60-second window):
 *
 *   sign-in   POST /auth/session, GET /auth/google/start   30 per IP
 *   data      /data/*, GET /messages*, /auth/me, /sync     90 per student
 *   send      POST /messages*                              10 per student
 *   submit    /submit/*                                    90 per student
 *   push      /push/* (not GET /push/config)               20 per student
 *   canva     /canva/*                                     30 per student
 *   canvaPoll GET /canva/exports/:job                     120 per student
 *   canvaBrowse GET /canva/folders/:id/items               90 per student
 *   apply     POST /schools/apply                  5 per 10 min per IP
 *
 * Sign-in is per IP because there's no student yet. It's 30 rather than 10
 * because a whole class usually signs in from one school IP at the start of
 * a period. "Per student" is the session's uid; requests without a valid
 * session (which those routes refuse anyway) count against their IP instead,
 * and so do demo sessions, which all share one uid. Never limited: CORS
 * preflights, GET /, and the public config reads (GET /config/cloud,
 * GET /push/config), which are cacheable and carry nothing personal.
 *
 * Over the limit: 429 `{ "error": "rate_limited" }` with Retry-After (seconds).
 *
 * Counting: an in-memory sliding window per Worker isolate, always on. That's
 * approximate (Cloudflare runs many isolates, each with its own count) but it
 * works today with nothing to set up, and it's what stops a single runaway
 * client, which tends to stay on one isolate. The Map is bounded
 * (MAX_KEYS, least recently used dropped first), so it can't grow without end.
 *
 * Counts shared across isolates (2026-10-07): Workers Rate Limiting
 * bindings, one per rule, declared in wrangler.jsonc under "unsafe" (the
 * repo's Wrangler 3 doesn't know the newer "ratelimits" key): RATE_LIMIT_SIGNIN,
 * _DATA, _SEND, _SUBMIT, _PUSH, _CANVA, _CANVA_POLL, _CANVA_BROWSE, _APPLY,
 * then a shared RATE_LIMITER if one is ever added. Each is asked after the
 * in-memory count and a request over either limit is refused. A binding has
 * one fixed limit and a 10 or 60 second period, counted per Cloudflare
 * location; applications keep their 10-minute window in memory. A binding
 * that errors is ignored (the in-memory count still applies).
 */

import type { MiddlewareHandler } from "hono";
import { DEMO_UID } from "./session.ts";

export interface RateRule {
  name: "signin" | "data" | "send" | "submit" | "push" | "canva" | "canvaPoll" | "canvaBrowse" | "apply";
  limit: number;
  windowMs: number;
  by: "ip" | "student";
  /** The rule's own optional Workers Rate Limiting binding. */
  binding: string;
}

const MINUTE = 60 * 1000;

export const RATE_RULES: Record<RateRule["name"], RateRule> = {
  signin: { name: "signin", limit: 30, windowMs: MINUTE, by: "ip", binding: "RATE_LIMIT_SIGNIN" },
  // Every page asks /auth/me, the bundle and up to three extras (2026-10-06 review: 90).
  data: { name: "data", limit: 90, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_DATA" },
  send: { name: "send", limit: 10, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_SEND" },
  // Two calls per file plus one to attach them all, plus history: 20 files is 42 (2026-10-06 review: 90).
  submit: { name: "submit", limit: 90, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_SUBMIT" },
  push: { name: "push", limit: 20, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_PUSH" },
  canva: { name: "canva", limit: 30, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_CANVA" },
  // Checking on a PDF export: the app asks every 1.5 s for up to 2 minutes
  // (2026-10-06 review). Its own rule, so it can't use up the Canva one.
  canvaPoll: { name: "canvaPoll", limit: 120, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_CANVA_POLL" },
  // Opening Canva folders on the Files page (2026-10-06): one call per folder
  // opened. Canva allows 100 a minute; this stays under it.
  canvaBrowse: { name: "canvaBrowse", limit: 90, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_CANVA_BROWSE" },
  // School applications (2026-10-06): a few per school network per 10 minutes is plenty.
  apply: { name: "apply", limit: 5, windowMs: 10 * MINUTE, by: "ip", binding: "RATE_LIMIT_APPLY" },
};

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/** Which rule a request counts against, or null for one that's never limited. */
export function ruleFor(method: string, path: string): RateRule | null {
  if (method === "OPTIONS" || path === "/") return null;
  if ((method === "POST" && path === "/auth/session") || (method === "GET" && (path === "/auth/google/start" || path === "/auth/google/callback"))) return RATE_RULES.signin;
  if (method === "POST" && path === "/schools/apply") return RATE_RULES.apply;
  // Martin's list: per IP like sign-in, so its key can't be guessed quickly.
  if (path === "/schools/applications") return RATE_RULES.signin;
  // Who's signed in, and Sync Across Devices: per student like the data (2026-10-06 review).
  if (path === "/auth/me" || under(path, "/sync")) return RATE_RULES.data;
  if (under(path, "/messages")) return method === "POST" ? RATE_RULES.send : RATE_RULES.data;
  if (under(path, "/data")) return RATE_RULES.data;
  if (under(path, "/submit")) return RATE_RULES.submit;
  if (under(path, "/push")) return method === "GET" && path === "/push/config" ? null : RATE_RULES.push;
  if (method === "GET" && /^\/canva\/exports\/[^/]+$/.test(path)) return RATE_RULES.canvaPoll;
  if (method === "GET" && /^\/canva\/folders\/[^/]+\/items$/.test(path)) return RATE_RULES.canvaBrowse;
  if (under(path, "/canva")) return RATE_RULES.canva;
  return null;
}

/**
 * Sliding-window log per key: the times of the requests let through in the
 * last window. Refused requests aren't recorded, so a client that keeps
 * hammering gets back in as soon as its window clears. Keys are kept in
 * least-recently-used order and the oldest dropped past `maxKeys`.
 */
export class SlidingWindow {
  maxKeys: number;
  hits = new Map<string, number[]>();
  constructor(maxKeys = 5000) {
    this.maxKeys = maxKeys;
  }

  /** Counts one request for `key` if it's under `limit`; otherwise how long until it would be. */
  hit(key: string, limit: number, windowMs: number, now: number): { ok: boolean; retryAfter: number } {
    let times = this.hits.get(key) ?? [];
    this.hits.delete(key); // re-inserted below: most recently used goes last
    const cutoff = now - windowMs;
    let drop = 0;
    while (drop < times.length && times[drop] <= cutoff) drop++;
    if (drop) times = times.slice(drop);
    if (times.length >= limit) {
      this.hits.set(key, times);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000)) };
    }
    times.push(now);
    this.hits.set(key, times);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
    return { ok: true, retryAfter: 0 };
  }

  clear(): void {
    this.hits.clear();
  }
}

/** This isolate's counts. */
const memory = new SlidingWindow();

/** Test hook: forget every count. */
export function resetRateLimits(): void {
  memory.clear();
}

/** A Workers Rate Limiting binding. */
interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

function bindingFor(env: unknown, rule: RateRule): RateLimiterBinding | null {
  const e = (env ?? {}) as Record<string, unknown>;
  const candidate = (e[rule.binding] ?? e.RATE_LIMITER) as RateLimiterBinding | undefined;
  return candidate && typeof candidate.limit === "function" ? candidate : null;
}

export interface RateLimitDeps {
  /** The signed-in student's uid for this request, or null (no session, or an invalid one). */
  studentOf: (c: any) => Promise<string | null>;
  /** Defaults to this isolate's shared counts. */
  store?: SlidingWindow;
  now?: () => number;
}

export function rateLimit(deps: RateLimitDeps): MiddlewareHandler {
  const store = deps.store ?? memory;
  const now = deps.now ?? Date.now;
  return async (c, next) => {
    const rule = ruleFor(c.req.method, c.req.path);
    if (!rule) return next();
    const ip = (c.req.header("CF-Connecting-IP") ?? "").trim().slice(0, 64) || "unknown";
    let who = `ip:${ip}`;
    if (rule.by === "student") {
      const uid = await deps.studentOf(c);
      if (uid && uid !== DEMO_UID) who = `u:${uid}`;
    }
    const key = `${rule.name}|${who}`;
    let { ok, retryAfter } = store.hit(key, rule.limit, rule.windowMs, now());
    if (ok) {
      const binding = bindingFor(c.env, rule);
      if (binding) {
        try {
          if (!(await binding.limit({ key })).success) {
            ok = false;
            retryAfter = Math.ceil(rule.windowMs / 1000);
          }
        } catch {
          // The binding misbehaving never blocks anyone; the in-memory count still applied.
        }
      }
    }
    if (ok) return next();
    c.header("Retry-After", String(retryAfter));
    c.header("Cache-Control", "no-store");
    return c.json({ error: "rate_limited" }, 429);
  };
}
