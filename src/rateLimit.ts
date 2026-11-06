// Rate limits on the API's own routes, as Hono middleware.

import type { MiddlewareHandler } from "hono";
import { DEMO_UID } from "./session.ts";

export interface RateRule {
  name: "signin" | "data" | "send" | "submit" | "push" | "canva" | "canvaPoll" | "canvaBrowse" | "cloud" | "media" | "billing" | "apply" | "applyCode" | "applyVerify" | "emailCode" | "emailVerify";
  limit: number;
  windowMs: number;
  by: "ip" | "student";
  /** The rule's own optional Workers Rate Limiting binding. */
  binding: string;
}

const MINUTE = 60 * 1000;

export const RATE_RULES: Record<RateRule["name"], RateRule> = {
  signin: { name: "signin", limit: 30, windowMs: MINUTE, by: "ip", binding: "RATE_LIMIT_SIGNIN" },
  data: { name: "data", limit: 90, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_DATA" },
  send: { name: "send", limit: 10, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_SEND" },
  submit: { name: "submit", limit: 90, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_SUBMIT" },
  push: { name: "push", limit: 20, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_PUSH" },
  canva: { name: "canva", limit: 30, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_CANVA" },
  canvaPoll: { name: "canvaPoll", limit: 120, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_CANVA_POLL" },
  canvaBrowse: { name: "canvaBrowse", limit: 90, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_CANVA_BROWSE" },
  cloud: { name: "cloud", limit: 60, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_CLOUD" },
  media: { name: "media", limit: 20, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_MEDIA" },
  billing: { name: "billing", limit: 20, windowMs: MINUTE, by: "student", binding: "RATE_LIMIT_BILLING" },
  apply: { name: "apply", limit: 5, windowMs: 10 * MINUTE, by: "ip", binding: "RATE_LIMIT_APPLY" },
  applyCode: { name: "applyCode", limit: 5, windowMs: 10 * MINUTE, by: "ip", binding: "RATE_LIMIT_APPLY_CODE" },
  applyVerify: { name: "applyVerify", limit: 20, windowMs: 10 * MINUTE, by: "ip", binding: "RATE_LIMIT_APPLY_VERIFY" },
  emailCode: { name: "emailCode", limit: 5, windowMs: 10 * MINUTE, by: "student", binding: "RATE_LIMIT_APPLY_CODE" },
  emailVerify: { name: "emailVerify", limit: 20, windowMs: 10 * MINUTE, by: "student", binding: "RATE_LIMIT_APPLY_VERIFY" },
};

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/** Which rule a request counts against, or null for one that's never limited. */
export function ruleFor(method: string, path: string): RateRule | null {
  if (method === "OPTIONS" || path === "/") return null;
  if ((method === "POST" && path === "/auth/session") || (method === "GET" && (path === "/auth/google/start" || path === "/auth/google/callback" || path === "/auth/schoology/start" || path === "/auth/schoology/callback"))) return RATE_RULES.signin;
  if (method === "POST" && path === "/schools/apply") return RATE_RULES.apply;
  if (method === "POST" && path === "/schools/apply/code") return RATE_RULES.applyCode;
  if (method === "POST" && path === "/schools/apply/verify") return RATE_RULES.applyVerify;
  if (method === "POST" && path === "/email/code") return RATE_RULES.emailCode;
  if (method === "POST" && path === "/email/verify") return RATE_RULES.emailVerify;
  if (path === "/schools/applications") return RATE_RULES.signin;
  if (path === "/auth/me" || under(path, "/sync")) return RATE_RULES.data;
  if (under(path, "/messages")) return method === "POST" ? RATE_RULES.send : RATE_RULES.data;
  if (method === "POST" && path === "/data/join") return RATE_RULES.send;
  if (under(path, "/data")) return RATE_RULES.data;
  if (under(path, "/account")) return method === "GET" ? RATE_RULES.data : RATE_RULES.send;
  if (under(path, "/submit")) return RATE_RULES.submit;
  if (under(path, "/push")) return method === "GET" && path === "/push/config" ? null : RATE_RULES.push;
  if (method === "GET" && /^\/canva\/exports\/[^/]+$/.test(path)) return RATE_RULES.canvaPoll;
  if (method === "GET" && /^\/canva\/save-folder\/[^/]+$/.test(path)) return RATE_RULES.canvaPoll;
  if (method === "GET" && /^\/canva\/folders\/[^/]+\/items$/.test(path)) return RATE_RULES.canvaBrowse;
  if (under(path, "/canva")) return RATE_RULES.canva;
  if (under(path, "/cloud")) return RATE_RULES.cloud;
  if (under(path, "/media")) return RATE_RULES.media;
  if (under(path, "/billing")) return RATE_RULES.billing;
  if (under(path, "/calendar")) return method === "GET" && path.endsWith(".ics") ? null : RATE_RULES.billing;
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
