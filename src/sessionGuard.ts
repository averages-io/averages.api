// "Sign out everywhere". Sessions are sealed cookies with nothing on the server, so on
// their own they can't be ended early: a copied cookie kept working for its 15 days. One small Durable Object per
// student now holds a single time, "every sign-in before this has ended", set by POST /auth/signout-everywhere.
// It holds nothing else, and deletes itself once no session from before that time can still be alive (15 days).

import { DurableObject } from "cloudflare:workers";
import { SESSION_TTL_SECONDS, sessionIssuedAt, type SessionData } from "./session.ts";

export class SessionGuard extends DurableObject {
  /** Unix seconds: sign-ins at or before this have ended (0: none). */
  async endedAt(): Promise<number> {
    return (await this.ctx.storage.get<number>("t")) ?? 0;
  }

  async endAll(at: number): Promise<void> {
    await this.ctx.storage.put("t", at);
    // gone when the last session it could stop would have run out anyway
    await this.ctx.storage.setAlarm(Date.now() + (SESSION_TTL_SECONDS + 3600) * 1000);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export interface GuardLike {
  endedAt(): Promise<number>;
  endAll(at: number): Promise<void>;
}

/* Each Worker copy keeps the answer a minute, so this costs one small read per student per copy per minute; signing
 * out everywhere reaches every copy within that minute (this copy at once). */
const SEEN = new Map<string, { t: number; at: number }>();
const KEEP_MS = 60_000, SEEN_MAX = 5000;

/** Whether this session was ended by "Sign out everywhere". Fails open: a guard that can't answer never signs anyone out. */
export async function sessionEnded(session: SessionData, guard: () => GuardLike, now = Date.now()): Promise<boolean> {
  let hit = SEEN.get(session.uid);
  if (!hit || now - hit.at >= KEEP_MS) {
    try {
      hit = { t: await guard().endedAt(), at: now };
    } catch (err) {
      console.error("session_guard_unavailable", err);
      return false;
    }
    if (SEEN.size >= SEEN_MAX) SEEN.delete(SEEN.keys().next().value as string);
    SEEN.set(session.uid, hit);
  }
  return hit.t > 0 && sessionIssuedAt(session) <= hit.t;
}

/** Ends every session of this student signed in up to now. */
export async function endAllSessions(uid: string, guard: GuardLike, now = Date.now()): Promise<number> {
  const at = Math.floor(now / 1000);
  await guard.endAll(at);
  SEEN.set(uid, { t: at, at: now });
  return at;
}

/** Tests: forget what this copy has seen. */
export function forgetGuards(): void {
  SEEN.clear();
}
