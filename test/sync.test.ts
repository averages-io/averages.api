/**
 * Tests for the Sync Across Devices / Projected-GPA-history storage layer.
 *
 * Run: node --experimental-strip-types test/sync.test.ts
 *
 * No real Cloudflare KV binding is available in this sandbox (same
 * npm-install constraint noted elsewhere in this repo), so these run against
 * a tiny in-memory stand-in that satisfies the same get/put/delete shape a
 * real KV namespace does — sync.ts is written against that minimal interface
 * for exactly this reason.
 */

import {
  deleteSyncRecord,
  isoWeekOf,
  loadSyncRecord,
  MAX_GPA_HISTORY,
  recordGpaSnapshot,
  saveSyncRecord,
  syncEnabledIn,
  type KVLike,
} from "../src/sync.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`);
  }
}
const checkTrue = (name: string, v: boolean) => check(name, v, true);

function fakeKV(): KVLike {
  const store = new Map<string, string>();
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

console.log("\nloadSyncRecord / saveSyncRecord");
{
  const kv = fakeKV();
  const empty = await loadSyncRecord(kv, "u1");
  check("no record yet -> empty shape, not null/undefined", empty, {
    settings: null,
    gpaHistory: [],
    updatedAt: "",
  });

  await saveSyncRecord(kv, "u1", {
    settings: { syncAcrossDevices: true, accent: "#d94a2b" },
    gpaHistory: [],
    updatedAt: "2026-09-08T00:00:00.000Z",
  });
  const loaded = await loadSyncRecord(kv, "u1");
  check("round-trips exactly what was saved", loaded.settings, {
    syncAcrossDevices: true,
    accent: "#d94a2b",
  });

  const other = await loadSyncRecord(kv, "u2");
  check("a different uid's record is unaffected (per-user keying)", other.settings, null);

  await deleteSyncRecord(kv, "u1");
  const afterDelete = await loadSyncRecord(kv, "u1");
  check("delete actually removes it", afterDelete.settings, null);
}

console.log("\nloadSyncRecord defensiveness against malformed stored JSON");
{
  const kv = fakeKV();
  // @ts-ignore — deliberately writing something not shaped like a SyncRecord,
  // simulating either an old format or hand-edited KV data.
  await kv.put("sync:u3", JSON.stringify({ settings: { a: 1 } })); // no gpaHistory/updatedAt at all
  const loaded = await loadSyncRecord(kv, "u3");
  checkTrue("missing gpaHistory falls back to []", Array.isArray(loaded.gpaHistory));
  check("missing gpaHistory falls back to [] (value)", loaded.gpaHistory, []);
  check("missing updatedAt falls back to ''", loaded.updatedAt, "");
  check("settings still comes through", loaded.settings, { a: 1 });
}

console.log("\nisoWeekOf");
{
  // 2026-09-08 is a Tuesday. Spot-check against a known ISO week rather than
  // re-deriving the algorithm in the test.
  check("2026-09-08 (Tue) is week 37", isoWeekOf(new Date("2026-09-08T12:00:00Z")), "2026-W37");
  check(
    "same calendar week, different weekday, same ISO week (ISO weeks run Mon-Sun)",
    isoWeekOf(new Date("2026-09-07T12:00:00Z")), // that week's Monday
    isoWeekOf(new Date("2026-09-13T12:00:00Z")) // that week's Sunday
  );
  check("Jan 1 2026 (a Thursday) is week 01", isoWeekOf(new Date("2026-01-01T12:00:00Z")), "2026-W01");
}

console.log("\nrecordGpaSnapshot");
{
  const empty = { settings: null, gpaHistory: [], updatedAt: "" };
  const first = recordGpaSnapshot(empty, 3.45, new Date("2026-09-01T12:00:00Z"));
  check("first-ever snapshot has no 'last week' to compare against", first.lastWeek, null);
  check("...so no delta either", first.deltaVsLastWeek, null);
  check("current is exactly what was passed in", first.current, 3.45);
  check("history now has one entry", first.record.gpaHistory.length, 1);

  const second = recordGpaSnapshot(first.record, 3.52, new Date("2026-09-08T12:00:00Z"));
  check("second week's 'last week' is the first snapshot", second.lastWeek, 3.45);
  check("delta is current minus last week", second.deltaVsLastWeek, 0.07);
  check("history now has two entries (one per distinct week)", second.record.gpaHistory.length, 2);

  const sameWeekAgain = recordGpaSnapshot(second.record, 3.6, new Date("2026-09-09T09:00:00Z"));
  check(
    "a reload later in the SAME ISO week overwrites that week's entry, doesn't add a third",
    sameWeekAgain.record.gpaHistory.length,
    2
  );
  check("...and 'last week' still means the prior week, not the earlier same-week value", sameWeekAgain.lastWeek, 3.45);
  check("delta reflects the overwritten value", sameWeekAgain.deltaVsLastWeek, Math.round((3.6 - 3.45) * 100) / 100);

  // A gap: no snapshot recorded for several weeks, then one more.
  const gapped = recordGpaSnapshot(sameWeekAgain.record, 3.8, new Date("2026-10-20T12:00:00Z"));
  check(
    "after a multi-week gap, 'last week' is still the most recent PRIOR snapshot, not null",
    gapped.lastWeek,
    3.6
  );
}

console.log("\nrecordGpaSnapshot history cap");
{
  let record = { settings: null, gpaHistory: [] as any[], updatedAt: "" };
  let date = new Date("2026-01-05T12:00:00Z"); // a Monday
  for (let i = 0; i < MAX_GPA_HISTORY + 5; i++) {
    const result = recordGpaSnapshot(record, 3.0 + i * 0.01, date);
    record = result.record;
    date = new Date(date.getTime() + 7 * 86400000); // +1 week
  }
  check(`never grows past MAX_GPA_HISTORY (${MAX_GPA_HISTORY}) entries`, record.gpaHistory.length, MAX_GPA_HISTORY);
  checkTrue(
    "the oldest entries are the ones dropped, not the newest",
    record.gpaHistory[record.gpaHistory.length - 1].gpa > record.gpaHistory[0].gpa
  );
}

console.log("\nsyncEnabledIn");
{
  checkTrue("explicit true", syncEnabledIn({ syncAcrossDevices: true }));
  check("explicit false", syncEnabledIn({ syncAcrossDevices: false }), false);
  check("missing key defaults to NOT enabled — an unconfirmed blob should never trigger snapshotting", syncEnabledIn({}), false);
  check("null settings (never synced)", syncEnabledIn(null), false);
  check("settings that isn't even an object", syncEnabledIn("nonsense"), false);
  check("truthy-but-not-literally-true doesn't count", syncEnabledIn({ syncAcrossDevices: "true" }), false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
