/**
 * Tests for the Sync Across Devices / Projected-GPA-snapshot storage layer.
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
  recordGpaSnapshot,
  saveSyncRecord,
  syncEnabledIn,
  weeklyGradeSummaryEnabledIn,
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
    gpaSnapshot: { current: null, previous: null },
    updatedAt: "",
    settingsUpdatedAt: "",
  });

  await saveSyncRecord(kv, "u1", {
    settings: { syncAcrossDevices: true, accent: "#d94a2b" },
    gpaSnapshot: { current: null, previous: null },
    updatedAt: "2026-09-08T00:00:00.000Z",
    settingsUpdatedAt: "2026-09-08T00:00:00.000Z",
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

console.log("\nloadSyncRecord defensiveness against malformed/pre-migration stored JSON");
{
  const kv = fakeKV();
  // @ts-ignore — deliberately writing something not shaped like a SyncRecord,
  // simulating either an old format or hand-edited KV data.
  await kv.put("sync:u3", JSON.stringify({ settings: { a: 1 } })); // no gpaSnapshot/updatedAt at all
  const loaded = await loadSyncRecord(kv, "u3");
  check("missing gpaSnapshot falls back to {current: null, previous: null}", loaded.gpaSnapshot, {
    current: null,
    previous: null,
  });
  check("missing updatedAt falls back to ''", loaded.updatedAt, "");
  check("missing settingsUpdatedAt falls back to '' — an old, pre-migration record", loaded.settingsUpdatedAt, "");
  check("settings still comes through", loaded.settings, { a: 1 });

  // A record written by the PRE-2026-09-12 code — the old multi-week
  // `gpaHistory` array — must not be carried forward into the new shape.
  // That's the whole point of shrinking retention: an old record with
  // months of entries sitting in KV should read back with none of them,
  // not have them silently translated into `current`/`previous`.
  const kv2 = fakeKV();
  await kv2.put(
    "sync:u4",
    JSON.stringify({
      settings: { syncAcrossDevices: true },
      gpaHistory: [
        { isoWeek: "2026-W20", date: "2026-05-11", gpa: 3.4 },
        { isoWeek: "2026-W21", date: "2026-05-18", gpa: 3.5 },
      ],
      updatedAt: "2026-05-18T00:00:00.000Z",
      settingsUpdatedAt: "2026-05-18T00:00:00.000Z",
    })
  );
  const loaded2 = await loadSyncRecord(kv2, "u4");
  check("an old gpaHistory array is dropped, not translated, on load", loaded2.gpaSnapshot, {
    current: null,
    previous: null,
  });
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
  const empty = { settings: null, gpaSnapshot: { current: null, previous: null }, updatedAt: "", settingsUpdatedAt: "" };
  const first = recordGpaSnapshot(empty, 3.45, new Date("2026-09-01T12:00:00Z"));
  check("first-ever snapshot has no 'last week' to compare against", first.lastWeek, null);
  check("...so no delta either", first.deltaVsLastWeek, null);
  check("current is exactly what was passed in", first.current, 3.45);
  check("record now holds exactly one snapshot, as 'current'", first.record.gpaSnapshot, {
    current: { isoWeek: "2026-W36", date: "2026-09-01", gpa: 3.45 },
    previous: null,
  });

  const second = recordGpaSnapshot(first.record, 3.52, new Date("2026-09-08T12:00:00Z"));
  check("second week's 'last week' is the first snapshot", second.lastWeek, 3.45);
  check("delta is current minus last week", second.deltaVsLastWeek, 0.07);
  check("a new week rotates current into previous — never more than two on file", second.record.gpaSnapshot, {
    current: { isoWeek: "2026-W37", date: "2026-09-08", gpa: 3.52 },
    previous: { isoWeek: "2026-W36", date: "2026-09-01", gpa: 3.45 },
  });

  const sameWeekAgain = recordGpaSnapshot(second.record, 3.6, new Date("2026-09-09T09:00:00Z"));
  check(
    "a reload later in the SAME ISO week updates 'current' in place, still only two snapshots total",
    sameWeekAgain.record.gpaSnapshot,
    {
      current: { isoWeek: "2026-W37", date: "2026-09-09", gpa: 3.6 },
      previous: { isoWeek: "2026-W36", date: "2026-09-01", gpa: 3.45 },
    }
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
  check("...and the gap-week entry itself is gone — only ever two on file, never a longer trail", gapped.record.gpaSnapshot, {
    current: { isoWeek: "2026-W43", date: "2026-10-20", gpa: 3.8 },
    previous: { isoWeek: "2026-W37", date: "2026-09-09", gpa: 3.6 },
  });

  // settingsUpdatedAt must survive every GPA-snapshot write untouched — the
  // whole point of splitting it from updatedAt (see sync.ts's own comment)
  // is that /data/bundle's snapshot piggyback runs on nearly every page
  // load and must never look, to a client comparing settingsUpdatedAt, like
  // a settings change happened.
  const withStamp = recordGpaSnapshot(
    {
      settings: { accent: "#2e8ae5" },
      gpaSnapshot: { current: null, previous: null },
      updatedAt: "",
      settingsUpdatedAt: "2026-09-08T00:00:00.000Z",
    },
    3.9,
    new Date("2026-09-09T12:00:00Z")
  );
  check(
    "recordGpaSnapshot leaves settingsUpdatedAt exactly as it found it",
    withStamp.record.settingsUpdatedAt,
    "2026-09-08T00:00:00.000Z"
  );
  checkTrue(
    "...even though updatedAt itself does move",
    withStamp.record.updatedAt !== "2026-09-08T00:00:00.000Z" && withStamp.record.updatedAt.length > 0
  );
}

console.log("\nrecordGpaSnapshot never grows past two snapshots");
{
  let record = { settings: null, gpaSnapshot: { current: null, previous: null } as any, updatedAt: "", settingsUpdatedAt: "" };
  let date = new Date("2026-01-05T12:00:00Z"); // a Monday
  for (let i = 0; i < 17; i++) {
    const result = recordGpaSnapshot(record, 3.0 + i * 0.01, date);
    record = result.record;
    date = new Date(date.getTime() + 7 * 86400000); // +1 week
  }
  const entryCount = [record.gpaSnapshot.current, record.gpaSnapshot.previous].filter(Boolean).length;
  check("never holds more than 2 snapshots, no matter how many weeks pass", entryCount, 2);
  checkTrue(
    "current is the most recent value, previous the one right before it",
    record.gpaSnapshot.current.gpa > record.gpaSnapshot.previous.gpa
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

console.log("\nweeklyGradeSummaryEnabledIn");
{
  checkTrue(
    "explicit true, nested under settingsOptions (the real collectSyncedSettings() shape)",
    weeklyGradeSummaryEnabledIn({ settingsOptions: { weeklyGradeSummary: true } })
  );
  check(
    "explicit false",
    weeklyGradeSummaryEnabledIn({ settingsOptions: { weeklyGradeSummary: false } }),
    false
  );
  check("missing settingsOptions entirely", weeklyGradeSummaryEnabledIn({ syncAcrossDevices: true }), false);
  check("settingsOptions present but missing the key", weeklyGradeSummaryEnabledIn({ settingsOptions: {} }), false);
  check("null settings", weeklyGradeSummaryEnabledIn(null), false);
  check("settings that isn't even an object", weeklyGradeSummaryEnabledIn("nonsense"), false);
  check(
    "truthy-but-not-literally-true doesn't count",
    weeklyGradeSummaryEnabledIn({ settingsOptions: { weeklyGradeSummary: "true" } }),
    false
  );
  checkTrue(
    "sync being on doesn't imply the email is on — the two are checked independently",
    !weeklyGradeSummaryEnabledIn({ syncAcrossDevices: true, settingsOptions: {} })
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
