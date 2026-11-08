// "Has anything changed?" fingerprints (src/fingerprint.ts).
import { comparable, fingerprint, FP_BUCKET_MS, FP_RE } from "../src/fingerprint.ts";

let passed = 0, failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected: ${JSON.stringify(want)}\n        actual:   ${JSON.stringify(got)}`);
}

const T = Date.UTC(2026, 10, 8, 15, 2, 0);
const body = (o: Record<string, unknown> = {}) => ({ generatedAt: new Date(T).toISOString(), COURSES: [{ id: "1", pct: 91.2, updated: "3h ago" }], due: "2026-11-09T07:59:00Z", at: T, ...o });

console.log("what counts as a change");
check("16 hex", FP_RE.test(await fingerprint(body(), T)), true);
check("same answer, same fingerprint", await fingerprint(body(), T), await fingerprint(body(), T + 1000));
check("made a moment later: same", await fingerprint(body({ generatedAt: new Date(T + 25_000).toISOString() }), T), await fingerprint(body(), T));
check("a label that only counts time: same", await fingerprint(body({ COURSES: [{ id: "1", pct: 91.2, updated: "4h ago" }] }), T), await fingerprint(body(), T));
check("'just now' and '5m ago': same", comparable({ a: "just now" }), comparable({ a: "5m ago" }));
check("a time a few minutes off: same", await fingerprint(body({ at: T + 120_000 }), T), await fingerprint(body(), T));
check("a grade changed: different", (await fingerprint(body({ COURSES: [{ id: "1", pct: 92.4, updated: "3h ago" }] }), T)) !== (await fingerprint(body(), T)), true);
check("a new due date: different", (await fingerprint(body({ due: "2026-11-12T07:59:00Z" }), T)) !== (await fingerprint(body(), T)), true);
check("next 10 minutes: different (labels catch up)", (await fingerprint(body(), T + FP_BUCKET_MS)) !== (await fingerprint(body(), T)), true);
check("plain words kept", comparable({ t: "Lab report" }), '{"t":"Lab report"}');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
