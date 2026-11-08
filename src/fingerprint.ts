// "Has anything changed?" for the background refresh: GET /data/bundle?since=<fp> and /updates?since=<fp>.
//
// Every answer carries a short fingerprint of what's in it (the X-Averages-Fp header). The page sends the last one
// back; when the new answer's fingerprint is the same, the API answers a tiny { unchanged: true } instead of the whole
// thing, and the page skips reading it. Schoology is still asked every time (it has no "anything new?"), so this saves
// the download and the page's work, not Schoology calls.
//
// What doesn't count as a change: when the answer was made (generatedAt), labels that only count time ("just now",
// "5m ago", "3h ago", "2d ago"), and times finer than the hour, which an answer worked out a moment later would
// differ in anyway. So those labels can't go stale for long, a full answer comes at least every FP_BUCKET_MS too.

export const FP_BUCKET_MS = 10 * 60 * 1000;
export const FP_RE = /^[a-f0-9]{16}$/;
export const FP_HEADER = "X-Averages-Fp";

const RELATIVE_RE = /^(just now|\d+[mhd] ago)$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;

/** The answer as it's compared: the parts that can't count as a change taken out or rounded. */
export function comparable(body: unknown): string {
  return JSON.stringify(body, (key, value) => {
    if (key === "generatedAt") return undefined;
    if (typeof value === "string") {
      if (RELATIVE_RE.test(value)) return "~";
      if (ISO_RE.test(value)) return value.slice(0, 13);
    }
    if (typeof value === "number" && value > 1e12 && value < 1e13) return Math.round(value / 36e5);
    return value;
  }) ?? "";
}

/** 16 hex characters: SHA-256 of the comparable answer and the 10-minute window it's in. */
export async function fingerprint(body: unknown, now: number = Date.now()): Promise<string> {
  const text = `${Math.floor(now / FP_BUCKET_MS)}|${comparable(body)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The answer, or { unchanged: true } when the page already has one with the same fingerprint (?since=). */
export async function answerUnlessSame(c: any, body: unknown, now: number = Date.now()): Promise<Response> {
  const fp = await fingerprint(body, now);
  c.header(FP_HEADER, fp);
  c.header("Cache-Control", "private, no-store");
  const since = c.req.query("since");
  return typeof since === "string" && FP_RE.test(since) && since === fp ? c.json({ unchanged: true }) : c.json(body);
}
