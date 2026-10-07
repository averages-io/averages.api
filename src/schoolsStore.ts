/**
 * School applications and the auto-reply log (2026-10-06): ONE Durable Object
 * for the whole app (named "schools"), in the "us" jurisdiction like every
 * other store (see schoolsStoreFor in index.ts).
 *
 * Holds:
 *   - "apps": the applications from app.averages.io/schools/apply, newest
 *     first, at most MAX_APPS. School contact details only, no student data.
 *   - "replied": when each sender last got the automatic reply, so a school
 *     gets it once (and two robots can't answer each other forever). Kept
 *     REPLY_EVERY_MS; at most MAX_REPLIED senders.
 *   - "codes" (2026-10-07): the "Verify your email" codes. Only a hash of
 *     each code, for CODE_TTL_MS; when codes were sent to each address, for
 *     CODE_SEND_WINDOW_MS (so an address can't be flooded); at most
 *     MAX_CODES addresses.
 */
import { DurableObject } from "cloudflare:workers";
import type { Application, ApplicationInput } from "./schools.ts";

export const MAX_APPS = 500;
export const MAX_REPLIED = 2000;
/** One automatic reply per sender per 30 days. */
export const REPLY_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
/** The same school and contact again within a day: an update, not a new one. */
export const DUPLICATE_MS = 24 * 60 * 60 * 1000;
/** A verification code works for 10 minutes and CODE_TRIES wrong guesses. */
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_TRIES = 5;
/** At most CODE_SENDS codes to one address per CODE_SEND_WINDOW_MS, CODE_GAP_MS apart. */
export const CODE_SENDS = 3;
export const CODE_SEND_WINDOW_MS = 10 * 60 * 1000;
export const CODE_GAP_MS = 45 * 1000;
export const MAX_CODES = 2000;

interface CodeEntry {
  /** SHA-256 of "<address>:<code>", hex; "" once used. */
  h: string;
  exp: number;
  tries: number;
  /** When codes were sent (Unix ms), newest last. */
  sends: number[];
}

export type CodeCheck = { result: "ok" } | { result: "wrong"; left: number } | { result: "expired" } | { result: "too_many" };

async function codeHash(email: string, code: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${email}:${code}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Six random digits, evenly spread (no modulo bias). */
export function newCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

export interface SchoolsStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

function newId(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
}

/** The logic, apart from the Durable Object, so tests can run it on a Map. */
export class SchoolsBook {
  storage: SchoolsStorage;
  constructor(storage: SchoolsStorage) {
    this.storage = storage;
  }

  /** Saves an application. The same Canvas address and contact within a day replaces the earlier one. */
  async add(input: ApplicationInput, now = Date.now()): Promise<{ app: Application; duplicate: boolean }> {
    const apps = (await this.storage.get<Application[]>("apps")) ?? [];
    const same = apps.findIndex((a) => a.canvas === input.canvas && a.email === input.email && now - a.at < DUPLICATE_MS);
    const duplicate = same !== -1;
    const app: Application = { ...input, id: duplicate ? apps[same].id : newId(), at: now };
    if (duplicate) apps.splice(same, 1);
    apps.unshift(app);
    await this.storage.put("apps", apps.slice(0, MAX_APPS));
    return { app, duplicate };
  }

  async list(): Promise<Application[]> {
    return (await this.storage.get<Application[]>("apps")) ?? [];
  }

  /**
   * A new code for `email` (already lowercased), or how many seconds to wait:
   * CODE_GAP_MS between codes and CODE_SENDS per CODE_SEND_WINDOW_MS. A new
   * code replaces the last one and resets the tries.
   */
  async issueCode(email: string, now = Date.now(), code = newCode()): Promise<{ code: string } | { wait: number }> {
    const codes = (await this.storage.get<Record<string, CodeEntry>>("codes")) ?? {};
    const entry = codes[email];
    const sends = (entry?.sends ?? []).filter((t) => now - t < CODE_SEND_WINDOW_MS && t <= now);
    const last = sends.at(-1);
    if (last !== undefined && now - last < CODE_GAP_MS) return { wait: Math.ceil((last + CODE_GAP_MS - now) / 1000) };
    if (sends.length >= CODE_SENDS) return { wait: Math.ceil((sends[0] + CODE_SEND_WINDOW_MS - now) / 1000) };
    sends.push(now);
    codes[email] = { h: await codeHash(email, code), exp: now + CODE_TTL_MS, tries: 0, sends };
    await this.storage.put("codes", pruneCodes(codes, now));
    return { code };
  }

  /** Checks a code. Right: it's used up. Wrong: one try fewer. */
  async checkCode(email: string, code: string, now = Date.now()): Promise<CodeCheck> {
    const codes = (await this.storage.get<Record<string, CodeEntry>>("codes")) ?? {};
    const entry = codes[email];
    if (!entry || !entry.h || entry.exp < now) return { result: "expired" };
    if (entry.tries >= CODE_TRIES) return { result: "too_many" };
    if (/^\d{6}$/.test(code) && (await codeHash(email, code)) === entry.h) {
      codes[email] = { ...entry, h: "" };
      await this.storage.put("codes", pruneCodes(codes, now));
      return { result: "ok" };
    }
    entry.tries += 1;
    await this.storage.put("codes", pruneCodes(codes, now));
    return entry.tries >= CODE_TRIES ? { result: "too_many" } : { result: "wrong", left: CODE_TRIES - entry.tries };
  }

  /**
   * True when `sender` may get the automatic reply now, and records that it
   * did. False when it already had one in the last 30 days.
   */
  async claimReply(sender: string, now = Date.now()): Promise<boolean> {
    const key = sender.toLowerCase();
    const replied = (await this.storage.get<Record<string, number>>("replied")) ?? {};
    const last = replied[key];
    if (typeof last === "number" && now - last < REPLY_EVERY_MS && last <= now) return false;
    replied[key] = now;
    // Forget old ones, and keep the newest MAX_REPLIED.
    const kept = Object.entries(replied)
      .filter(([, at]) => now - at < REPLY_EVERY_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_REPLIED);
    await this.storage.put("replied", Object.fromEntries(kept));
    return true;
  }
}

/** Drops codes nobody can use or be limited by any more; keeps the newest MAX_CODES. */
function pruneCodes(codes: Record<string, CodeEntry>, now: number): Record<string, CodeEntry> {
  const kept = Object.entries(codes)
    .filter(([, e]) => e.exp > now || e.sends.some((t) => now - t < CODE_SEND_WINDOW_MS))
    .sort((a, b) => (b[1].sends.at(-1) ?? 0) - (a[1].sends.at(-1) ?? 0))
    .slice(0, MAX_CODES);
  return Object.fromEntries(kept);
}

export class SchoolsStore extends DurableObject {
  book(): SchoolsBook {
    return new SchoolsBook(this.ctx.storage as unknown as SchoolsStorage);
  }
  add(input: ApplicationInput): Promise<{ app: Application; duplicate: boolean }> {
    return this.book().add(input);
  }
  list(): Promise<Application[]> {
    return this.book().list();
  }
  claimReply(sender: string): Promise<boolean> {
    return this.book().claimReply(sender);
  }
  issueCode(email: string): Promise<{ code: string } | { wait: number }> {
    return this.book().issueCode(email);
  }
  checkCode(email: string, code: string): Promise<CodeCheck> {
    return this.book().checkCode(email, code);
  }
}
