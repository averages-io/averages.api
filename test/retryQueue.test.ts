/**
 * The retry queue (src/retryQueue.ts, 2026-10-16): what goes on it, and how
 * the consumer settles each message. The two kinds are tested where their
 * senders are: push.test.ts (notifications) and canvaSave.test.ts (Canva
 * save-folder files).
 *
 * Run: node --experimental-strip-types test/retryQueue.test.ts
 */
import {
  delayFor,
  endpointKey,
  enqueueRetry,
  handleRetryBatch,
  isRetryMessage,
  MAX_ATTEMPTS,
  PUSH_RETRY_MAX_AGE_MS,
  RETRY_DELAYS,
  type RetryHandlers,
  type RetryMessage,
  type RetryOutcome,
} from "../src/retryQueue.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}
const quietLogs: string[] = [];
const realLog = console.log;
const realError = console.error;
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  console.log = (...a: unknown[]) => void quietLogs.push(a.map(String).join(" "));
  console.error = console.log;
  try { return await fn(); } finally { console.log = realLog; console.error = realError; }
}

const NOW = Date.parse("2026-10-16T18:00:00Z");
const NOTE = { title: "Averages", body: "A new grade was posted.", url: "/grades", tag: "averages-grades" };
const PUSH: RetryMessage = { k: "push", obj: "ab".repeat(32), ep: "0123456789abcdef0123456789abcdef", note: NOTE, at: NOW - 60_000 };
const SAVE: RetryMessage = { k: "canva_save", obj: "cd".repeat(32), job: "job_abcd1234", i: 0, at: NOW - 60_000 };

console.log("messages");
check("both kinds are understood", [isRetryMessage(PUSH), isRetryMessage(SAVE)], [true, true]);
check("anything else isn't", [
  isRetryMessage(null), isRetryMessage("x"), isRetryMessage({ ...SAVE, k: "other" }),
  isRetryMessage({ ...SAVE, job: "x" }), isRetryMessage({ ...SAVE, at: "now" }),
  isRetryMessage({ ...PUSH, obj: "1001" }), isRetryMessage({ ...PUSH, ep: "https://fcm.googleapis.com/x" }),
  isRetryMessage({ ...PUSH, note: { ...NOTE, body: "x".repeat(201) } }), isRetryMessage({ ...PUSH, note: null }),
], [false, false, false, false, false, false, false, false, false]);
check("delays: 1 min first, then 5, 15, 30, 60, never past the last", [RETRY_DELAYS[0], delayFor(1), delayFor(2), delayFor(3), delayFor(4), delayFor(9), delayFor(0)], [60, 300, 900, 1800, 3600, 3600, 300]);
const key = await endpointKey("https://fcm.googleapis.com/fcm/send/phone");
check("endpoint key: 32 hex characters, stable, not the address", [key.length, /^[0-9a-f]{32}$/.test(key), key === (await endpointKey("https://fcm.googleapis.com/fcm/send/phone")), key === (await endpointKey("https://fcm.googleapis.com/fcm/send/laptop"))], [32, true, true, false]);

console.log("\nputting a retry on the queue");
{
  const sent: { body: unknown; opts: unknown }[] = [];
  const RETRY: any = { send: async (body: unknown, opts: unknown) => void sent.push({ body, opts }) };
  check("no queue bound: false, nothing thrown", await enqueueRetry({}, SAVE), false);
  check("queued, a minute out by default", [await quiet(() => enqueueRetry({ RETRY }, SAVE)), sent[0]?.opts], [true, { delaySeconds: 60 }]);
  check("a delay can be given", [await quiet(() => enqueueRetry({ RETRY }, PUSH, 300)), sent[1]?.opts], [true, { delaySeconds: 300 }]);
  check("a malformed message is refused before the queue", [await quiet(() => enqueueRetry({ RETRY }, { ...SAVE, job: "" } as RetryMessage)), sent.length], [false, 2]);
  const broken: any = { send: async () => { throw new Error("queue unavailable"); } };
  check("the queue refusing: false, never thrown", await quiet(() => enqueueRetry({ RETRY: broken }, SAVE)), false);
}

console.log("\nthe consumer");
type Settled = { id: string; ack: number; retry: unknown[] };
function batch(bodies: { body: unknown; attempts?: number }[]) {
  const settled: Settled[] = [];
  const messages = bodies.map((b, i) => {
    const s: Settled = { id: `m${i}`, ack: 0, retry: [] };
    settled.push(s);
    return { id: s.id, timestamp: new Date(NOW), body: b.body, attempts: b.attempts ?? 1, ack: () => void s.ack++, retry: (o?: unknown) => void s.retry.push(o ?? null) };
  });
  return { b: { queue: "averages-retry", messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<unknown>, settled };
}
function handlers(outcome: RetryOutcome | "throw", seen: string[] = []): RetryHandlers {
  const run = async (what: string) => {
    seen.push(what);
    if (outcome === "throw") throw new Error("boom");
    return outcome;
  };
  return { push: (obj, ep) => run("push " + ep.slice(0, 4)), canvaSave: (obj, job) => run("save " + job) };
}
{
  const seen: string[] = [];
  const { b, settled } = batch([{ body: SAVE }, { body: PUSH }]);
  await quiet(() => handleRetryBatch(b, handlers("done", seen), NOW));
  check("done: each tried once and acknowledged", [seen, settled.map((s) => [s.ack, s.retry.length])], [["save job_abcd1234", "push 0123"], [[1, 0], [1, 0]]]);
}
{
  const { b, settled } = batch([{ body: SAVE, attempts: 1 }, { body: PUSH, attempts: 3 }]);
  await quiet(() => handleRetryBatch(b, handlers("retry"), NOW));
  check("retry: asked again later, the wait growing", settled.map((s) => [s.ack, s.retry]), [[0, [{ delaySeconds: 300 }]], [0, [{ delaySeconds: 1800 }]]]);
}
{
  const { b, settled } = batch([{ body: SAVE, attempts: MAX_ATTEMPTS }]);
  await quiet(() => handleRetryBatch(b, handlers("retry"), NOW));
  check("the last try failed too: given up (acknowledged, logged)", [settled[0].ack, settled[0].retry.length, quietLogs.some((l) => l.startsWith("retry_gave_up canva_save"))], [1, 0, true]);
}
{
  const { b, settled } = batch([{ body: PUSH }]);
  await quiet(() => handleRetryBatch(b, handlers("drop"), NOW));
  check("drop: acknowledged, not retried", [settled[0].ack, settled[0].retry.length], [1, 0]);
}
{
  const { b, settled } = batch([{ body: SAVE }, { body: PUSH }]);
  await quiet(() => handleRetryBatch(b, handlers("throw"), NOW));
  check("a try that throws: retried, and the other message still settled", settled.map((s) => [s.ack, s.retry.length]), [[0, 1], [0, 1]]);
}
{
  const seen: string[] = [];
  const { b, settled } = batch([
    { body: { k: "nope" } },
    { body: { ...PUSH, at: NOW - PUSH_RETRY_MAX_AGE_MS - 1 } },
    { body: { ...SAVE, at: NOW - 3 * 3600e3 } },
    { body: SAVE },
  ]);
  await quiet(() => handleRetryBatch(b, handlers("done", seen), NOW));
  check("bad or too-old messages: acknowledged without a try; the good one tried", [settled.map((s) => s.ack), seen], [[1, 1, 1, 1], ["save job_abcd1234"]]);
}
check("logs never carry message contents", quietLogs.some((l) => /grade|fcm|job_abcd1234|cdcd|abab/.test(l)), false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
