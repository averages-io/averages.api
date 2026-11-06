/**
 * Tests for the Sync Across Devices storage layer. (The Projected-GPA
 * snapshot for the weekly email lived here too until 2026-10-06; the tests
 * below now check that an old record's snapshot is ignored and dropped.)
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
  cleanSeen,
  deleteSyncRecord,
  loadSyncRecord,
  mergeSeen,
  SEEN_CAP,
  saveSyncRecord,
  kvFromSyncStore,
  type KVLike,
  type SyncStoreLike,
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

function fakeKV(): KVLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
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
    updatedAt: "",
    settingsUpdatedAt: "",
  });

  await saveSyncRecord(kv, "u1", {
    settings: { syncAcrossDevices: true, accent: "#d94a2b" },
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
  await kv.put("sync:u3", JSON.stringify({ settings: { a: 1 } })); // no updatedAt at all
  const loaded = await loadSyncRecord(kv, "u3");
  check("missing updatedAt falls back to ''", loaded.updatedAt, "");
  check("missing settingsUpdatedAt falls back to '' — an old, pre-migration record", loaded.settingsUpdatedAt, "");
  check("settings still comes through", loaded.settings, { a: 1 });
}

console.log("\nan old record's GPA snapshot (weekly email, removed 2026-10-06) is ignored and dropped");
{
  const kv = fakeKV();
  await kv.put(
    "sync:u4",
    JSON.stringify({
      settings: { syncAcrossDevices: true, settingsOptions: { weeklyGradeSummary: true } },
      gpaSnapshot: {
        current: { isoWeek: "2026-W40", date: "2026-10-01", gpa: 3.6 },
        previous: { isoWeek: "2026-W39", date: "2026-09-24", gpa: 3.5 },
      },
      gpaHistory: [{ isoWeek: "2026-W20", date: "2026-05-11", gpa: 3.4 }],
      updatedAt: "2026-10-01T00:00:00.000Z",
      settingsUpdatedAt: "2026-09-30T00:00:00.000Z",
    })
  );
  const loaded = await loadSyncRecord(kv, "u4");
  check("loads only settings and the two timestamps", Object.keys(loaded), ["settings", "updatedAt", "settingsUpdatedAt", "seen"]); // + the seen notifications (2026-11-03)
  check("the timestamps come through as they were", [loaded.updatedAt, loaded.settingsUpdatedAt], ["2026-10-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z"]);
  await saveSyncRecord(kv, "u4", { ...loaded, updatedAt: "2026-10-06T00:00:00.000Z" });
  const stored = JSON.parse(kv.store.get("sync:u4")!);
  check("the next save writes the record without gpaSnapshot or gpaHistory", Object.keys(stored), ["settings", "updatedAt", "settingsUpdatedAt", "seen"]); // + the seen notifications (2026-11-03)
  // Even when something passes a record that still has one (a caller spreading an old object).
  await saveSyncRecord(kv, "u4", { ...(loaded as any), gpaSnapshot: { current: 1 } });
  check("saveSyncRecord writes exactly the three fields, whatever it's given", Object.keys(JSON.parse(kv.store.get("sync:u4")!)), ["settings", "updatedAt", "settingsUpdatedAt", "seen"]); // + the seen notifications (2026-11-03)
}

// ---------------------------------------------------------------------------
// kvFromSyncStore (2026-10-04): the per-student Durable Object (syncStore.ts),
// wrapped as KVLike. A plain in-memory stand-in for the Durable Object, with
// the same three methods syncStore.ts has.
// ---------------------------------------------------------------------------
function fakeStore(): SyncStoreLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async getRecord(key) { return data.has(key) ? data.get(key)! : null; },
    async putRecord(key, value) { data.set(key, value); },
    async deleteRecord() { data.clear(); },
  };
}

console.log("\nkvFromSyncStore (Durable Object storage)");
{
  const store = fakeStore();
  const kv = kvFromSyncStore(() => store);
  check("nothing saved yet reads as an empty record", await loadSyncRecord(kv, "77"), {
    settings: null, updatedAt: "", settingsUpdatedAt: "",
  });
  const rec = { settings: { theme: "dark" }, updatedAt: "t1", settingsUpdatedAt: "t1", seen: {} };
  await saveSyncRecord(kv, "77", rec);
  check("a saved record comes back exactly as written", await loadSyncRecord(kv, "77"), rec);
  checkTrue("it's stored as a JSON string, same as KV was", typeof [...store.data.values()][0] === "string");
  await deleteSyncRecord(kv, "77");
  check("delete leaves nothing behind", store.data.size, 0);
  store.data.set("sync:77", "{not json");
  check("a damaged record reads as nothing saved instead of throwing", (await loadSyncRecord(kv, "77")).settings, null);
}
{
  let opened = 0;
  const kv = kvFromSyncStore(() => { opened++; throw new Error("SYNC binding missing"); });
  check("making the wrapper doesn't touch the Durable Object yet", opened, 0);
  let rejected = false;
  await loadSyncRecord(kv, "77").catch(() => { rejected = true; });
  checkTrue("a missing binding is a rejected promise the caller can catch, not a thrown error", rejected);
}

console.log("\nseen notifications (2026-11-03)");
{
  check("merge keeps everything from both devices, once", mergeSeen({ g: ["1", "2"], m: ["9"] }, { g: ["2", "3"], u: ["5"] }), { u: ["5"], g: ["1", "2", "3"], m: ["9"] });
  check("only the known kinds and id-looking values", cleanSeen({ g: ["123", "<script>", "a b", 7], x: ["1"], m: "nope" }), { g: ["123", "7"] });
  const many = Array.from({ length: SEEN_CAP + 50 }, (_, i) => String(i));
  const merged = mergeSeen({ g: many }, { g: ["new"] });
  check("capped at SEEN_CAP, oldest dropped, newest kept", [merged.g!.length, merged.g![0], merged.g![merged.g!.length - 1]], [SEEN_CAP, "51", "new"]);
  check("new work and new files are kept too (2026-11-06)", mergeSeen({ a: ["71"] }, { f: ["74"], a: ["72"] }), { a: ["71", "72"], f: ["74"] });
  check("nothing in, nothing out", [mergeSeen(null, undefined), cleanSeen("x")], [{}, {}]);
  const store = new Map<string, string>();
  const kv: KVLike = { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)!) : null), put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } };
  await saveSyncRecord(kv, "77", { settings: { a: 1 }, updatedAt: "t", settingsUpdatedAt: "t", seen: { g: ["1"] } });
  const back = await loadSyncRecord(kv, "77");
  check("saved and read back with the record", [back.settings, back.seen], [{ a: 1 }, { g: ["1"] }]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
