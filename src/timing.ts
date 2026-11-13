// Where a request's time goes, as a Server-Timing header (2026-11-13). DevTools shows it in a request's Timing tab
// ("Server Timing"): our Worker's total, the feature switches (Flagship), and the time spent waiting on Schoology.
// Durations, counts and Schoology paths with the ids taken out only: nothing about the student.
import { AsyncLocalStorage } from "node:async_hooks";

export interface Timing {
  t0: number;
  /** This Worker had served nothing before this request (a cold start). */
  cold: boolean;
  colo: string;
  flagsMs: number;
  flagsFrom: "asked" | "kept" | "none";
  calls: number;
  /** Reads answered from the shared copy (another request asked Schoology the same thing moments ago). */
  reused: number;
  /** Waited after Schoology said "too many requests" (429). */
  waitMs: number;
  firstAt: number;
  lastAt: number;
  slowestMs: number;
  slowestPath: string;
}

const store = new AsyncLocalStorage<Timing>();
let served = 0;

export function newTiming(now = Date.now(), colo = ""): Timing {
  return { t0: now, cold: served++ === 0, colo, flagsMs: 0, flagsFrom: "none", calls: 0, reused: 0, waitMs: 0, firstAt: 0, lastAt: 0, slowestMs: 0, slowestPath: "" };
}
export function runTimed<T>(t: Timing, fn: () => T): T {
  return store.run(t, fn);
}
export function timing(): Timing | undefined {
  return store.getStore();
}

/** A Schoology path without ids or query: /users/123/sections -> /users/:id/sections. */
export function pathShape(path: string): string {
  return String(path).split("?")[0].replace(/\/[^/]*\d{3,}[^/]*/g, "/:id").slice(0, 60);
}

/** One call to Schoology, from start to end (ms timestamps). */
export function noteSchoology(start: number, end: number, path: string): void {
  const t = timing();
  if (!t) return;
  t.calls++;
  if (!t.firstAt || start < t.firstAt) t.firstAt = start;
  if (end > t.lastAt) t.lastAt = end;
  if (end - start > t.slowestMs) { t.slowestMs = end - start; t.slowestPath = pathShape(path); }
}
export function noteReused(): void {
  const t = timing();
  if (t) t.reused++;
}
export function noteWait(ms: number): void {
  const t = timing();
  if (t) t.waitMs += ms;
}

const q = (s: string) => `"${String(s).replace(/["\\\r\n]/g, "")}"`;

export function serverTiming(t: Timing, now = Date.now()): string {
  const parts = [`app;dur=${now - t.t0};desc=${q(`Averages API, ${t.cold ? "cold start" : "warm"}${t.colo ? ", " + t.colo : ""}`)}`];
  if (t.flagsFrom !== "none") parts.push(`flags;dur=${t.flagsMs};desc=${q(t.flagsFrom === "kept" ? "Feature switches (kept)" : "Feature switches (asked Flagship)")}`);
  if (t.calls || t.reused) {
    const wall = t.calls ? t.lastAt - t.firstAt : 0;
    const bits = [`${t.calls} call${t.calls === 1 ? "" : "s"}`];
    if (t.reused) bits.push(`${t.reused} reused`);
    if (t.slowestPath) bits.push(`slowest ${t.slowestMs}ms ${t.slowestPath}`);
    parts.push(`schoology;dur=${wall};desc=${q("Waiting on Schoology: " + bits.join(", "))}`);
  }
  if (t.waitMs) parts.push(`ratelimit;dur=${t.waitMs};desc=${q("Schoology said slow down (429)")}`);
  return parts.join(", ");
}

/** The response with the Server-Timing header (and Timing-Allow-Origin for our own pages, so they can read it too). */
export function withServerTiming(res: Response, t: Timing, origin: string | null, allowed: string[]): Response {
  const add = (r: Response) => {
    r.headers.append("Server-Timing", serverTiming(t));
    if (origin && allowed.includes(origin)) r.headers.set("Timing-Allow-Origin", origin);
    return r;
  };
  try {
    return add(res);
  } catch {
    // headers that can't change (a response passed straight through): copy it
    try { return add(new Response(res.body, res)); } catch { return res; }
  }
}
