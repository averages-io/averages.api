/**
 * Retries through Cloudflare Queues (2026-10-16, cloudflare-compute-plan.md
 * item 2): a send that failed for a passing reason is tried again a little
 * later, instead of being lost.
 *
 * Two kinds today:
 *   - "school_email": the email telling Martin about a new school application
 *     (POST /schools/apply). The application is already saved; only the email
 *     failed. The message carries the application's id, and the email is
 *     built again from the saved copy.
 *   - "push": a browser notification the push service refused for now (429,
 *     5xx, or no answer). The message carries the student's PushStore id (an
 *     opaque id, not their Schoology id), a short hash of the browser's
 *     subscription address and the notification's generic text ("A new grade
 *     was posted."). The PushStore sends it again to that one browser.
 *
 *   - "canva_save" (2026-10-16, src/canvaSave.ts): one file of a "Save folder
 *     to Canva" job. Not a retry: every file goes through the queue, spaced
 *     out so Canva's 20-imports-a-minute limit is never reached. The message
 *     carries the student's CanvaStore id (opaque), the job id and the file's
 *     number; the job itself is in the CanvaStore.
 *
 * So nothing in a queue message is student data: no names, grades, titles,
 * email addresses or subscription keys.
 *
 * Flow: the first try happens as before. Only a failure that may pass is put
 * on the queue (`enqueueRetry`), with a delay. The consumer (`handleRetryBatch`,
 * the Worker's `queue` handler) tries again; on another passing failure it
 * asks the queue for a later retry (RETRY_DELAYS), up to MAX_ATTEMPTS, then
 * gives up with a log line. A failure that won't pass (application deleted,
 * browser unsubscribed, notification too old) is dropped at once.
 *
 * Without the RETRY binding (local tests, or before the queue is created)
 * enqueueRetry does nothing and returns false: everything works as before.
 */

/** The queue's messages. Short keys: each delivery counts per 64 KB, but small is cheaper to log and read. */
export interface RetryNote {
  title: string;
  body: string;
  url: string;
  tag: string;
}
export type RetryMessage =
  | { k: "school_email"; id: string; dup: boolean; at: number }
  | { k: "push"; obj: string; ep: string; note: RetryNote; at: number }
  | { k: "canva_save"; obj: string; job: string; i: number; at: number };

/** What one try came to. `retryIn`: try again after that many seconds (a "slow down" with its own wait). */
export type RetryOutcome = "done" | "retry" | "drop" | { retryIn: number };

export interface RetryEnv {
  RETRY?: Queue<RetryMessage>;
}

/**
 * Seconds before each try from the queue: 1 min after the first failure, then
 * 5 min, 15 min, 30 min and 1 hour (about two hours in all).
 */
export const RETRY_DELAYS = [60, 300, 900, 1800, 3600] as const;
/** Tries made from the queue before giving up (the queue's own max_retries is higher, as a backstop). */
export const MAX_ATTEMPTS = RETRY_DELAYS.length;
/** A notification older than this isn't news any more (the push itself lives 12 hours). */
export const PUSH_RETRY_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** An application email is still worth sending for a day (the queue keeps messages 24 hours on Workers Free). */
export const EMAIL_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A Canva save job's sign-in lasts two hours (SAVE_CRED_TTL_S in canvaSave.ts); after that its files can't be fetched. */
export const SAVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Files in one save job (SAVE_MAX_FILES in canvaSave.ts). */
const SAVE_MAX_INDEX = 49;
const JOB_RE = /^[A-Za-z0-9_-]{8,40}$/;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OBJ_RE = /^[0-9a-f]{64}$/;
const EP_RE = /^[0-9a-f]{32}$/;

/** True for a message this consumer understands; anything else is dropped (and logged). */
export function isRetryMessage(body: unknown): body is RetryMessage {
  if (!body || typeof body !== "object") return false;
  const m = body as Record<string, unknown>;
  if (typeof m.at !== "number" || !Number.isFinite(m.at)) return false;
  if (m.k === "school_email") return typeof m.id === "string" && ID_RE.test(m.id) && typeof m.dup === "boolean";
  if (m.k === "push") {
    const n = m.note as Record<string, unknown> | null;
    return (
      typeof m.obj === "string" && OBJ_RE.test(m.obj) &&
      typeof m.ep === "string" && EP_RE.test(m.ep) &&
      !!n && typeof n === "object" &&
      ["title", "body", "url", "tag"].every((key) => typeof n[key] === "string" && (n[key] as string).length <= 200)
    );
  }
  if (m.k === "canva_save") {
    return (
      typeof m.obj === "string" && OBJ_RE.test(m.obj) &&
      typeof m.job === "string" && JOB_RE.test(m.job) &&
      Number.isInteger(m.i) && (m.i as number) >= 0 && (m.i as number) <= SAVE_MAX_INDEX
    );
  }
  return false;
}

/** The wait after the queue's try number `attempts` failed (1 = its first try): the next step in RETRY_DELAYS. */
export function delayFor(attempts: number): number {
  const i = Math.max(1, Math.min(RETRY_DELAYS.length - 1, Math.floor(attempts)));
  return RETRY_DELAYS[i];
}

/** A short, stable name for a browser's subscription address, so the address itself never goes on the queue. */
export async function endpointKey(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Puts a retry on the queue, after `delaySeconds` (default: the first delay).
 * Never throws; false when there's no queue or it refused (then the failure
 * stays what it was before Queues: logged).
 */
export async function enqueueRetry(env: RetryEnv, message: RetryMessage, delaySeconds: number = RETRY_DELAYS[0]): Promise<boolean> {
  if (!env.RETRY) return false;
  if (!isRetryMessage(message)) {
    console.error("retry_enqueue_refused", (message as { k?: unknown })?.k ?? "");
    return false;
  }
  try {
    await env.RETRY.send(message, { delaySeconds });
    console.log("retry_queued", message.k);
    return true;
  } catch (error) {
    console.error("retry_enqueue_failed", message.k, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Several messages at once, each with its own delay (a Canva save job's files,
 * spaced out). Never throws; false when there's no queue or it refused.
 */
export async function enqueueMany(env: RetryEnv, items: { message: RetryMessage; delaySeconds: number }[]): Promise<boolean> {
  if (!env.RETRY || items.length === 0) return false;
  if (!items.every((x) => isRetryMessage(x.message))) {
    console.error("retry_enqueue_refused", "batch");
    return false;
  }
  try {
    // The queue takes up to 100 messages a call.
    for (let n = 0; n < items.length; n += 100) {
      await env.RETRY.sendBatch(items.slice(n, n + 100).map((x) => ({ body: x.message, delaySeconds: Math.max(0, Math.min(43200, Math.round(x.delaySeconds))) })));
    }
    console.log("retry_queued_batch", items[0].message.k, items.length);
    return true;
  } catch (error) {
    console.error("retry_enqueue_failed", items[0].message.k, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** One try for each kind; real ones in index.ts, fakes in the tests. Each returns an outcome and doesn't throw on purpose (a throw counts as "retry"). */
export interface RetryHandlers {
  schoolEmail(id: string, duplicate: boolean): Promise<RetryOutcome>;
  push(obj: string, ep: string, note: RetryNote, at: number): Promise<RetryOutcome>;
  canvaSave(obj: string, job: string, i: number): Promise<RetryOutcome>;
  /** The last try failed too, or the message is too old: a chance to record that (a save job's file is marked failed). */
  gaveUp?(message: RetryMessage): Promise<void>;
}

/**
 * The Worker's `queue` handler. Every message is settled one by one (ack or
 * retry), so one bad message never makes the queue redeliver the others.
 */
export async function handleRetryBatch(batch: MessageBatch<unknown>, handlers: RetryHandlers, now: number = Date.now()): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body;
    if (!isRetryMessage(body)) {
      console.error("retry_bad_message");
      msg.ack();
      continue;
    }
    const maxAge = body.k === "push" ? PUSH_RETRY_MAX_AGE_MS : body.k === "canva_save" ? SAVE_MAX_AGE_MS : EMAIL_RETRY_MAX_AGE_MS;
    if (now - body.at > maxAge) {
      console.log("retry_too_old", body.k);
      await giveUp(handlers, body);
      msg.ack();
      continue;
    }
    let outcome: RetryOutcome;
    try {
      outcome =
        body.k === "school_email" ? await handlers.schoolEmail(body.id, body.dup)
        : body.k === "push" ? await handlers.push(body.obj, body.ep, body.note, body.at)
        : await handlers.canvaSave(body.obj, body.job, body.i);
    } catch (error) {
      console.error("retry_try_failed", body.k, error instanceof Error ? error.message : String(error));
      outcome = "retry";
    }
    if (outcome === "done") {
      console.log("retry_done", body.k, msg.attempts);
      msg.ack();
    } else if (outcome === "drop") {
      console.log("retry_dropped", body.k);
      msg.ack();
    } else if (msg.attempts >= MAX_ATTEMPTS) {
      console.error("retry_gave_up", body.k, msg.attempts);
      await giveUp(handlers, body);
      msg.ack();
    } else {
      msg.retry({ delaySeconds: typeof outcome === "object" ? Math.max(1, Math.min(3600, Math.round(outcome.retryIn))) : delayFor(msg.attempts) });
    }
  }
}

async function giveUp(handlers: RetryHandlers, body: RetryMessage): Promise<void> {
  if (!handlers.gaveUp) return;
  try {
    await handlers.gaveUp(body);
  } catch (error) {
    console.error("retry_give_up_failed", body.k, error instanceof Error ? error.message : String(error));
  }
}
