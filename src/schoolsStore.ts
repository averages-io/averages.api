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
 */
import { DurableObject } from "cloudflare:workers";
import type { Application, ApplicationInput } from "./schools.ts";

export const MAX_APPS = 500;
export const MAX_REPLIED = 2000;
/** One automatic reply per sender per 30 days. */
export const REPLY_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
/** The same school and contact again within a day: an update, not a new one. */
export const DUPLICATE_MS = 24 * 60 * 60 * 1000;

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
}
