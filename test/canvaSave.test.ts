/**
 * Save folder to Canva (src/canvaSave.ts, 2026-10-16): the job store, one
 * file's run from the queue (with fakes for Schoology and Canva), and the
 * routes through the real Worker with a fake CanvaStore and queue.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/canvaSave.test.ts
 */
import app, { retryHandlers } from "../src/index.ts";
import { openValue, sealSession } from "../src/session.ts";
import {
  cleanFolderName,
  parseSaveFiles,
  SAVE_CRED_TTL_S,
  SAVE_KEEP_MS,
  SAVE_MAX_ACTIVE,
  SAVE_MAX_FILES,
  SAVE_RATE_WAIT_S,
  SAVE_SPACING_S,
  SaveJobs,
  saveOneFile,
  type SaveFileDeps,
  type SaveFile,
} from "../src/canvaSave.ts";
import { handleRetryBatch, isRetryMessage } from "../src/retryQueue.ts";
import { ruleFor } from "../src/rateLimit.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}
const realLog = console.log;
const realError = console.error;
const logs: string[] = [];
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = console.log;
  try { return await fn(); } finally { console.log = realLog; console.error = realError; }
}
function memStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(k: string) => (map.has(k) ? JSON.parse(JSON.stringify(map.get(k))) : undefined) as T | undefined,
    put: async (k: string, v: unknown) => void map.set(k, JSON.parse(JSON.stringify(v))),
  };
}
const F = (file: string, kind: "assignment" | "document" = "document", parent = "7300000101", section = "7000000001"): SaveFile => ({ section, kind, parent, file });

console.log("checking what comes in");
check("good files", parseSaveFiles([F("1"), { ...F("2"), kind: "assignment" }]), [F("1"), { ...F("2"), kind: "assignment" }]);
check("repeats kept once", parseSaveFiles([F("1"), F("1")])?.length, 1);
check("bad: empty, not ids, other kinds, too many", [
  parseSaveFiles([]), parseSaveFiles("x"), parseSaveFiles([{ ...F("1"), file: "../x" }]), parseSaveFiles([{ ...F("1"), kind: "page" }]),
  parseSaveFiles(Array.from({ length: SAVE_MAX_FILES + 1 }, (_, i) => F(String(i + 1)))),
], [null, null, null, null, null]);
check("folder names: plain, trimmed, capped, never empty", [cleanFolderName("  Unit\u0000 3 \n Notes "), cleanFolderName(""), Array.from(cleanFolderName("é".repeat(300))).length], ["Unit 3 Notes", "From Averages.io", 100]);

console.log("\nthe job store");
{
  const st = memStorage();
  const jobs = new SaveJobs(st);
  const t0 = Date.parse("2026-10-16T18:00:00Z");
  const j = await jobs.create({ id: "job0000001", name: "Unit 3", folderId: "FOLD1", files: [F("1"), F("2")], sealed: "SEALED", uid: "123" }, t0);
  check("created, both files waiting", [j?.items.map((i) => i.state), j?.sealed], [["waiting", "waiting"], "SEALED"]);
  check("take: the file and the sign-in", await jobs.take("job0000001", 0, t0 + 1000), { item: { ...F("1"), state: "waiting" }, sealed: "SEALED", uid: "123", folderId: "FOLD1" });
  await jobs.record("job0000001", 0, { state: "done", name: "Notes.pdf", designs: ["D1"] }, t0 + 2000);
  check("one done", (await jobs.status("job0000001", t0 + 2000))?.done, 1);
  check("a file already done isn't taken again", await jobs.take("job0000001", 0, t0 + 3000), null);
  await jobs.record("job0000001", 1, { state: "failed", name: "Huge.pdf", error: "file_too_large" }, t0 + 4000);
  const s = await jobs.status("job0000001", t0 + 4000);
  check("the last file closes the job", [s?.finished, s?.done, s?.failed, s?.waiting, s?.folder], [true, 1, 1, 0, true]);
  check("status shows names and why, never ids or the sign-in", s?.items, [{ name: "Notes.pdf", state: "done" }, { name: "Huge.pdf", state: "failed", error: "file_too_large" }]);
  check("the sealed sign-in is deleted when it finishes", JSON.stringify(st.map.get("savejobs")).includes("SEALED"), false);
  check("kept a day for the page, then gone", [!!(await jobs.status("job0000001", t0 + 4000 + SAVE_KEEP_MS - 1)), await jobs.status("job0000001", t0 + 4001 + SAVE_KEEP_MS)], [true, null]);

  const k = new SaveJobs(memStorage());
  for (let n = 0; n < SAVE_MAX_ACTIVE; n++) await k.create({ id: `jobactive${n}`, name: "x", folderId: null, files: [F("1")], sealed: "S", uid: "1" }, t0);
  check(`at most ${SAVE_MAX_ACTIVE} running at once`, await k.create({ id: "jobextra01", name: "x", folderId: null, files: [F("1")], sealed: "S", uid: "1" }, t0), null);
  const stopped = await k.stop("jobactive0", t0 + 5);
  check("stop: finished, sign-in gone, a new one fits", [stopped?.stopped, stopped?.finished, !!(await k.create({ id: "jobextra02", name: "x", folderId: null, files: [F("1")], sealed: "S", uid: "1" }, t0 + 6))], [true, true, true]);
  check("a stopped job's files aren't taken", await k.take("jobactive0", 0, t0 + 7), null);
  const late = await k.status("jobactive1", t0 + SAVE_CRED_TTL_S * 1000 + 1);
  check("past two hours: closed, waiting files failed as expired", [late?.finished, late?.items[0]], [true, { name: "", state: "failed", error: "expired" }]);
}

console.log("\none file from the queue");
function deps(over: Partial<SaveFileDeps> = {}, log: string[] = []): SaveFileDeps {
  return {
    take: async () => ({ item: { ...F("1"), state: "waiting" }, sealed: "S", uid: "123", folderId: "FOLD1" }),
    record: async (r) => void log.push("record " + JSON.stringify(r)),
    openSession: async () => ({ uid: "123" }),
    findFile: async () => ({ name: "Notes.pdf", size: 1000, downloadPath: "https://api.schoology.com/v1/attachment/1" }),
    download: async () => ({ bytes: new ArrayBuffer(8), contentType: "application/pdf" }),
    canvaToken: async () => "TOKEN",
    importFile: async (_t, name) => (log.push("import " + name), [{ id: "D1" }, { id: "D2" }]),
    findImported: async () => ({ id: "DOLD" }),
    moveToFolder: async (_u, d, f) => void log.push(`move ${d} ${f}`),
    maxBytes: 25 * 1024 * 1024,
    ...over,
  };
}
{
  let log: string[] = [];
  check("saved: imported, both designs moved into the folder", [await saveOneFile(deps({}, log)), log], ["done", ["import Notes.pdf", "move D1 FOLD1", "move D2 FOLD1", 'record {"state":"done","name":"Notes.pdf","designs":["D1","D2"]}']]);
  log = [];
  await saveOneFile(deps({ take: async () => ({ item: { ...F("1"), state: "waiting" }, sealed: "S", uid: "123", folderId: null }) }, log));
  check("no folder: saved to Projects, nothing moved", log.some((l) => l.startsWith("move")), false);
  log = [];
  check("the folder refusing a move: still saved", await saveOneFile(deps({ moveToFolder: async () => { throw new Error("canva_folder_failed"); } }, log)), "done");
  log = [];
  check("saved before: that design is used", [await saveOneFile(deps({ importFile: async () => { throw new Error("canva_duplicate_import"); } }, log)), log.at(-1)], ["done", 'record {"state":"done","name":"Notes.pdf","designs":["DOLD"]}']);
  log = [];
  check("job stopped or file done: nothing happens", [await saveOneFile(deps({ take: async () => null }, log)), log], ["drop", []]);
  log = [];
  check("sign-in can't be opened: failed, signed_out", [await saveOneFile(deps({ openSession: async () => null }, log)), log], ["drop", ['record {"state":"failed","error":"signed_out"}']]);
  log = [];
  check("not in the folder any more: failed", [await saveOneFile(deps({ findFile: async () => null }, log)), log], ["drop", ['record {"state":"failed","error":"file_not_found"}']]);
  log = [];
  check("too big: failed before downloading", [await saveOneFile(deps({ findFile: async () => ({ name: "Big.pdf", size: 30e6, downloadPath: "x" }), download: async () => { throw new Error("should not download"); } }, log)), log], ["drop", ['record {"state":"failed","name":"Big.pdf","error":"file_too_large"}']]);
  log = [];
  const rate = Object.assign(new Error("canva_rate_limited"), { status: 429 });
  check("Canva says slow down: wait a minute, nothing recorded", [await quiet(() => saveOneFile(deps({ importFile: async () => { throw rate; } }, log))), log.filter((l) => l.startsWith("record"))], [{ retryIn: SAVE_RATE_WAIT_S }, []]);
  log = [];
  const busy = Object.assign(new Error("Schoology returned 503"), { status: 503 });
  check("Schoology busy: try again later", await quiet(() => saveOneFile(deps({ download: async () => { throw busy; } }, log))), "retry");
  log = [];
  check("not a file Canva opens: failed with Canva's reason", [await quiet(() => saveOneFile(deps({ importFile: async () => { throw new Error("canva_invalid_file"); } }, log))), log.at(-1)], ["drop", 'record {"state":"failed","name":"Notes.pdf","error":"canva_invalid_file"}']);
  log = [];
  check("Canva disconnected: failed", [await quiet(() => saveOneFile(deps({ canvaToken: async () => { throw new Error("canva_not_connected"); } }, log))), log.at(-1)], ["drop", 'record {"state":"failed","name":"Notes.pdf","error":"canva_not_connected"}']);
}

console.log("\nthe queue message");
{
  const m = { k: "canva_save", obj: "cd".repeat(32), job: "abcdefgh12", i: 3, at: Date.now() };
  check("understood", isRetryMessage(m), true);
  check("refused: bad job id, file number out of range, a uid as the object", [isRetryMessage({ ...m, job: "x" }), isRetryMessage({ ...m, i: 50 }), isRetryMessage({ ...m, i: 1.5 }), isRetryMessage({ ...m, obj: "123" })], [false, false, false, false]);
  // Through the consumer: retryIn becomes the queue's own delay, a give-up marks the file failed.
  const settled: any[] = [];
  const gaveUp: any[] = [];
  const batch = (attempts: number) => ({ queue: "q", messages: [{ id: "1", timestamp: new Date(), body: m, attempts, ack: () => settled.push("ack"), retry: (o: any) => settled.push(o) }], ackAll() {}, retryAll() {} }) as any;
  const handlers = { push: async () => "done" as const, canvaSave: async () => ({ retryIn: 60 }), gaveUp: async (b: any) => void gaveUp.push(b.i) };
  await quiet(() => handleRetryBatch(batch(1), handlers));
  await quiet(() => handleRetryBatch(batch(5), handlers));
  check("slow down: retried after Canva's minute; the last try gives up and marks it", [settled, gaveUp], [[{ delaySeconds: 60 }, "ack"], [3]]);
  settled.length = 0;
  gaveUp.length = 0;
  await quiet(() => handleRetryBatch({ ...batch(1), messages: [{ ...batch(1).messages[0], body: { ...m, at: Date.now() - 3 * 3600e3 } }] }, handlers));
  check("older than the sign-in's two hours: marked failed, not tried", [settled, gaveUp], [["ack"], [3]]);
}

console.log("\nthe routes");
const SECRET = "canva-save-test-secret";
const store = memStorage();
const jobs = new SaveJobs(store);
const canvaState = { connected: true, scopeOk: true, asked: [] as string[] };
const stub: any = {
  id: { toString: () => "ef".repeat(32) },
  accessToken: async () => { if (!canvaState.connected) throw new Error("canva_not_connected"); return "TOKEN"; },
  accessTokenWithScope: async (_u: string, scope: string) => { canvaState.asked.push(scope); if (!canvaState.scopeOk) throw new Error("canva_reconnect_needed"); return "TOKEN"; },
  saveCreate: async (input: any) => { const j = await jobs.create(input); return j ? jobs.status(j.id) : null; },
  saveStatus: (id: string) => jobs.status(id),
  saveTake: (id: string, i: number) => jobs.take(id, i),
  saveRecord: (id: string, i: number, r: any) => jobs.record(id, i, r),
  saveStop: (id: string) => jobs.stop(id),
};
const ns: any = { idFromName: (n: string) => n, idFromString: (s: string) => s, get: () => stub, jurisdiction: () => ns };
const sent: { body: any; delaySeconds: number }[] = [];
const RETRY = { send: async () => {}, sendBatch: async (msgs: any[]) => void sent.push(...msgs) };
const canvaCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.canva.com/") && (init.method ?? "GET") === "POST" && url.endsWith("/folders")) {
    canvaCalls.push(JSON.parse(init.body).name);
    return Response.json({ folder: { id: "FOLDNEW", name: JSON.parse(init.body).name } });
  }
  return realFetch(input, init);
}) as typeof fetch;
const ENV: any = { SESSION_SECRET: SECRET, CANVA_CLIENT_ID: "OC-x", CANVA_CLIENT_SECRET: "y", CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback", CANVA: ns, CANVA_FOLDERS_ENABLED: "1", RETRY };
async function call(path: string, opts: { method?: string; body?: unknown; env?: any; session?: any; origin?: string } = {}) {
  const token = await sealSession(opts.session ?? ({ uid: "123", key: "k", secret: "s", exp: Math.floor(Date.now() / 1000) + 3600 } as any), SECRET);
  const headers: Record<string, string> = { Cookie: `schoolagy_session=${token}`, Origin: opts.origin ?? "https://app.averages.io" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.fetch(new Request("https://api.averages.io" + path, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), { ...ENV, ...opts.env }, { waitUntil() {}, passThroughOnException() {} } as any);
  return { status: res.status, data: await res.json().catch(() => null) as any };
}
{
  const r = await quiet(() => call("/canva/save-folder", { method: "POST", body: { name: "AP Chem · Unit 3", files: [F("11"), F("12"), F("13")] } }));
  check("started: 200 with the job's status", [r.status, r.data.total, r.data.waiting, r.data.folder], [200, 3, 3, true]);
  check("a Canva folder with the folder's name", canvaCalls, ["AP Chem · Unit 3"]);
  check("one message per file, spaced 4 s apart", sent.map((m) => [m.body.k, m.body.i, m.delaySeconds]), [["canva_save", 0, 0], ["canva_save", 1, SAVE_SPACING_S], ["canva_save", 2, 2 * SAVE_SPACING_S]]);
  check("messages carry the store id and job only", Object.keys(sent[0].body).sort(), ["at", "i", "job", "k", "obj"]);
  const saved = JSON.parse(JSON.stringify(store.map.get("savejobs")))[0];
  const opened = await openValue(saved.sealed, SECRET, "canva-save");
  check("the sign-in is kept sealed, and opens to this student", [saved.sealed.includes("123"), JSON.parse(String(opened)).uid], [false, "123"]);
  const status = await call(`/canva/save-folder/${r.data.job}`);
  check("progress", [status.status, status.data.total, status.data.done], [200, 3, 0]);

  // The queue runs file 0 against fake Schoology and Canva.
  const h = retryHandlers({ ...ENV } as any);
  check("handler: a message for a file already finished or gone is dropped", await quiet(() => h.canvaSave("ef".repeat(32), "nosuchjob1", 0)), "drop");

  const stop = await quiet(() => call(`/canva/save-folder/${r.data.job}`, { method: "DELETE" }));
  check("stop: finished, nothing more taken", [stop.status, stop.data.stopped, await jobs.take(r.data.job, 1)], [200, true, null]);

  sent.length = 0;
  canvaCalls.length = 0;
  const one = await quiet(() => call("/canva/save-folder", { method: "POST", body: { name: "Notes.pdf", files: [F("21")] } }));
  check("one file: no Canva folder", [one.status, one.data.folder, canvaCalls.length], [200, false, 0]);
  canvaState.scopeOk = false;
  const noScope = await quiet(() => call("/canva/save-folder", { method: "POST", body: { name: "Unit 4", files: [F("31"), F("32")] } }));
  check("connected without folder permission: still saves, into Projects", [noScope.status, noScope.data.folder], [200, false]);
  canvaState.scopeOk = true;
  check(`a third job while ${SAVE_MAX_ACTIVE} run: 429`, (await quiet(() => call("/canva/save-folder", { method: "POST", body: { name: "x", files: [F("41")] } }))).status, 429);

  check("too many files: 413", (await call("/canva/save-folder", { method: "POST", body: { name: "x", files: Array.from({ length: SAVE_MAX_FILES + 1 }, (_, i) => F(String(i + 1))) } })).data, { error: "too_many_files", max: SAVE_MAX_FILES });
  check("bad files: 400", (await call("/canva/save-folder", { method: "POST", body: { name: "x", files: [{ ...F("1"), file: "x" }] } })).status, 400);
  check("another site: 403", (await call("/canva/save-folder", { method: "POST", origin: "https://evil.example", body: { name: "x", files: [F("1")] } })).status, 403);
  canvaState.connected = false;
  check("Canva not connected: 409", (await quiet(() => call("/canva/save-folder", { method: "POST", body: { name: "x", files: [F("51")] } }))).status, 409);
  canvaState.connected = true;
  check("no queue bound: 503", (await call("/canva/save-folder", { method: "POST", env: { RETRY: undefined }, body: { name: "x", files: [F("1")] } })).data, { error: "save_unavailable" });
  check("Incognito: 403", (await call("/canva/save-folder", { method: "POST", session: { uid: "123", key: "k", secret: "s", exp: Math.floor(Date.now() / 1000) + 3600, inc: true }, body: { name: "x", files: [F("1")] } })).status, 403);
  check("unknown job: 404, bad id: 400", [(await call("/canva/save-folder/abcdefgh99")).status, (await call("/canva/save-folder/x")).status], [404, 400]);
  check("progress is polled under the poll rule", ruleFor("GET", "/canva/save-folder/abcdefgh12")?.name, "canvaPoll");
}

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
