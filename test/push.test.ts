/**
 * Tests for browser notifications (2026-10-05): src/notify.ts (what changed),
 * src/pushStore.ts (the per-student Durable Object, on a Map-backed fake
 * storage with Schoology, Google and a push service faked behind fetch) and
 * src/push.ts (the routes, mounted on a bare Hono app with stub deps).
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/push.test.ts
 *
 * Every id, key, token and secret below is made up.
 */

import { Hono } from "hono";
import {
  classroomObservation,
  DEFAULT_TYPES,
  diffSnapshots,
  DUE_WINDOW_MS,
  halfSipHash64,
  hashWith,
  MAX_SET,
  mergeSnapshot,
  notificationFor,
  NOTIFY_TYPES,
  parseTypeChanges,
  parseTypes,
  readSnapshot,
  schoologyObservation,
  snapshotHasher,
  STALE_MS,
  TEST_NOTIFICATION,
  type Change,
  type NotifyTypes,
  type Snapshot,
} from "../src/notify.ts";
import {
  BACKOFF_EVERY_MS,
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  JITTER_MS,
  PUSH_PURPOSE,
  PushStore,
  pushConfigured,
  vapidFrom,
} from "../src/pushStore.ts";
import { forgetPush, pushRoutes, type PushStoreApi } from "../src/push.ts";
import { b64urlEncode, generateVapidKeys } from "../src/webpush.ts";
import { openSession, openValue, readCookie, sealSession, sealValue, SESSION_COOKIE, type SessionData } from "../src/session.ts";

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
function section(title: string) {
  console.log(`\n${title}`);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const ALL: NotifyTypes = { ...DEFAULT_TYPES };
const only = (...types: (keyof NotifyTypes)[]): NotifyTypes =>
  Object.fromEntries(NOTIFY_TYPES.map((t) => [t, types.includes(t)])) as NotifyTypes;
const identity = (s: string) => s;
const sorted = (c: Change[]) => c.map((x) => `${x.type}:${x.count}`);
const HOUR = 60 * 60 * 1000;

/* ════════════════════════════════════════════════════════════════════════
 * notify.ts
 * ════════════════════════════════════════════════════════════════════════ */

section("HalfSipHash-2-4 (reference vectors: key 00..07, message 00..n-1)");
{
  const key = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const VECTORS: Record<number, string> = {
    0: "218d1f59b9b83cc8",
    1: "be552412f8387315",
    3: "ce0f1a45f7060679",
    4: "d5e78a175be52ea1",
    5: "cb9d7c3f2f3db580",
    7: "ff202728b07bc684",
    8: "edfee820bce4858c",
    15: "217d0bcb4e81c902",
    31: "863c7f155c34117c",
    63: "2ea63c71bf326087",
  };
  for (const [n, hex] of Object.entries(VECTORS)) {
    const msg = Uint8Array.from({ length: Number(n) }, (_, i) => i);
    check(`vector ${n}`, Buffer.from(halfSipHash64(key, msg)).toString("hex"), hex);
  }
  // hashWith: the first 6 bytes, base64url, whether the text is ASCII or not.
  for (const text of ["", "g|123|456|18|20|0", "é ünïcode ✓", "x".repeat(300)]) {
    const ref = Buffer.from(halfSipHash64(key, enc.encode(text)).slice(0, 6)).toString("base64url");
    check(`hashWith is 48 bits of HalfSipHash (${JSON.stringify(text.slice(0, 12))})`, hashWith(key, text), ref);
  }
  const a = await snapshotHasher("push-secret-1", "1001");
  const b = await snapshotHasher("push-secret-1", "1002");
  const c = await snapshotHasher("push-secret-2", "1001");
  const a2 = await snapshotHasher("push-secret-1", "1001");
  check("hasher: 8 base64url characters", /^[A-Za-z0-9_-]{8}$/.test(a("g|1|2|18|20|0")), true);
  check("hasher: same student and secret, same hash", a("x"), a2("x"));
  check("hasher: another student, another hash", a("x") === b("x"), false);
  check("hasher: another secret, another hash", a("x") === c("x"), false);
}

section("parseTypes");
{
  check("only the five known keys, booleans only", parseTypes({ grades: false, due: "no", extra: true, messages: 0 }), { ...ALL, grades: false });
  check("not an object: null", [parseTypes(null), parseTypes("grades"), parseTypes([true])], [null, null, null]);
  check("inherited keys ignored", parseTypes(Object.create({ grades: false })), ALL);
  check("base kept for missing keys", parseTypes({ messages: true }, only("grades")), only("grades", "messages"));
  check("a JSON __proto__ key does nothing", parseTypes(JSON.parse('{"__proto__":{"grades":false},"due":false}')), { ...ALL, due: false });
  check("changes: only what was sent", parseTypeChanges({ grades: false, due: "no", junk: true }), { grades: false });
  check("changes: not an object", parseTypeChanges(5), null);
}

/* Schoology raw data helpers */
const NOW = Date.UTC(2026, 9, 5, 15, 0, 0);
const sGrade = (assignment: number, grade: unknown, max = 20, extra: Record<string, unknown> = {}) => ({
  assignment_id: assignment,
  grade,
  max_points: max,
  exception: 0,
  timestamp: Math.floor(NOW / 1000) - 3600 + assignment,
  comment: "Great job on the lab write-up, Martin",
  ...extra,
});
const sGrades = (...assignments: unknown[]) => [{ section_id: "111", period: [{ period_id: "p1", assignment: assignments }], final_grade: [{ grade: 93 }] }];
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const sAssignment = (id: number, due: number | null, title = "Molarity Practice Set") => ({ id, title, due: due === null ? "" : ymd(due), description: "Secret description" });
const sMessage = (id: number, updated: number, status: "read" | "unread", subject = "About your lab") => ({
  id,
  subject,
  message_status: status,
  last_updated: updated,
  author_name: "Ms. Rivera",
});
const sUpdate = (id: number, uid = "2002", body = "Field trip forms due Friday") => ({ id, uid, body, created: 1 });

section("Schoology: grades");
{
  const enabled = only("grades");
  const base = schoologyObservation({ uid: "1001", grades: sGrades(sGrade(1, 18), sGrade(2, 15)) }, enabled, identity, NOW);
  check("first look is a baseline", diffSnapshots(null, base, enabled, NOW), []);
  const snap = mergeSnapshot(null, base, enabled);
  const same = schoologyObservation({ uid: "1001", grades: sGrades(sGrade(2, 15), sGrade(1, 18)) }, enabled, identity, NOW);
  check("nothing changed (order doesn't matter)", diffSnapshots(snap, same, enabled, NOW), []);
  const newOne = schoologyObservation({ uid: "1001", grades: sGrades(sGrade(1, 18), sGrade(2, 15), sGrade(3, 20)) }, enabled, identity, NOW);
  check("a new grade", sorted(diffSnapshots(snap, newOne, enabled, NOW)), ["grades:1"]);
  const changed = schoologyObservation({ uid: "1001", grades: sGrades(sGrade(1, 19), sGrade(2, 15)) }, enabled, identity, NOW);
  check("a changed score", sorted(diffSnapshots(snap, changed, enabled, NOW)), ["grades:1"]);
  const maxChanged = schoologyObservation({ uid: "1001", grades: sGrades(sGrade(1, 18, 25), sGrade(2, 15)) }, enabled, identity, NOW);
  check("changed points possible counts as changed", sorted(diffSnapshots(snap, maxChanged, enabled, NOW)), ["grades:1"]);
  const ungraded = schoologyObservation({ uid: "1001", grades: sGrades(sGrade(1, 18), sGrade(2, 15), sGrade(4, null), sGrade(5, "")) }, enabled, identity, NOW);
  check("ungraded work isn't a grade", diffSnapshots(snap, ungraded, enabled, NOW), []);
  const excused = schoologyObservation({ uid: "1001", grades: sGrades(sGrade(1, 18), sGrade(2, 15), sGrade(6, null, 20, { exception: 1 })) }, enabled, identity, NOW);
  check("excused work is a grade", sorted(diffSnapshots(snap, excused, enabled, NOW)), ["grades:1"]);
  const removed = schoologyObservation({ uid: "1001", grades: sGrades(sGrade(1, 18)) }, enabled, identity, NOW);
  check("a removed grade notifies nothing", diffSnapshots(snap, removed, enabled, NOW), []);
  check("bad ids are skipped", schoologyObservation({ uid: "1", grades: [{ section_id: "x/../1", period: [{ assignment: [sGrade(1, 1)] }] }] }, enabled, identity, NOW).sets.grades, []);
  check("a failed read leaves the type out", schoologyObservation({ uid: "1001", grades: null }, enabled, identity, NOW).sets.grades, undefined);
}

section("Schoology: assignments and due dates");
{
  const enabled = only("assignments", "due");
  const in3h = NOW + 3 * HOUR;
  const in30h = NOW + 30 * HOUR;
  const raw = (lists: Record<string, any[] | null>) => schoologyObservation({ uid: "1001", assignments: lists }, enabled, identity, NOW);
  const base = raw({ "111": [sAssignment(10, in3h), sAssignment(11, in30h)], "222": [sAssignment(20, null)] });
  check("baseline: nothing, even what's due soon", diffSnapshots(null, base, enabled, NOW), []);
  const snap = mergeSnapshot(null, base, enabled);
  check("due set holds only what's due within a day", base.sets.due!.length, 1);
  const posted = raw({ "111": [sAssignment(10, in3h), sAssignment(11, in30h), sAssignment(12, NOW + 5 * HOUR)], "222": [sAssignment(20, null)] });
  check("a new assignment due tomorrow: new + due", sorted(diffSnapshots(snap, posted, enabled, NOW)), ["assignments:1", "due:1"]);
  const snap2 = mergeSnapshot(snap, posted, enabled);
  check("once per item: the next check is quiet", diffSnapshots(snap2, posted, enabled, NOW), []);
  // Later: #11 comes inside the window.
  const later = NOW + 8 * HOUR;
  const moved = schoologyObservation({ uid: "1001", assignments: { "111": [sAssignment(10, in3h), sAssignment(11, in30h), sAssignment(12, NOW + 5 * HOUR)], "222": [sAssignment(20, null)] } }, enabled, identity, later);
  check("something coming within a day is reminded about", sorted(diffSnapshots(snap2, moved, enabled, later)), ["due:1"]);
  const extended = raw({ "111": [sAssignment(10, NOW + 4 * HOUR), sAssignment(11, in30h), sAssignment(12, NOW + 5 * HOUR)], "222": [sAssignment(20, null)] });
  check("a changed due date is a new reminder", sorted(diffSnapshots(snap2, extended, enabled, NOW)), ["due:1"]);
  const past = raw({ "111": [sAssignment(13, NOW - HOUR)], "222": [] });
  check("already past due: no reminder", past.sets.due, []);

  // A class that failed: partial, and what it had is kept, so it isn't "new" next time.
  const partialRead = raw({ "111": [sAssignment(10, in3h), sAssignment(11, in30h), sAssignment(12, NOW + 5 * HOUR)], "222": null });
  check("a failed class marks the type partial", [partialRead.partial.assignments, partialRead.partial.due], [true, true]);
  check("a failed class notifies nothing", diffSnapshots(snap2, partialRead, enabled, NOW), []);
  const snap3 = mergeSnapshot(snap2, partialRead, enabled);
  check("its old hashes are kept", snap3.sets.assignments!.includes("a|222|20"), true);
  const back = raw({ "111": [sAssignment(10, in3h), sAssignment(11, in30h), sAssignment(12, NOW + 5 * HOUR)], "222": [sAssignment(20, null)] });
  check("and it isn't re-announced when it's back", diffSnapshots(snap3, back, enabled, NOW), []);
  check("a full read forgets what's gone", mergeSnapshot(snap3, raw({ "111": [sAssignment(10, in3h)], "222": [] }), enabled).sets.assignments, ["a|111|10"]);
  check("sections missing entirely: type left out", schoologyObservation({ uid: "1", assignments: null }, enabled, identity, NOW).sets.assignments, undefined);
}

section("Schoology: messages");
{
  const enabled = only("messages");
  const t0 = Math.floor(NOW / 1000) - 7200;
  const read = (list: any[]) => schoologyObservation({ uid: "1001", inbox: list }, enabled, identity, NOW);
  const snap = mergeSnapshot(null, read([sMessage(1, t0, "read"), sMessage(2, t0, "unread")]), enabled);
  check("a new unread thread", sorted(diffSnapshots(snap, read([sMessage(1, t0, "read"), sMessage(2, t0, "unread"), sMessage(3, t0 + 60, "unread")]), enabled, NOW)), ["messages:1"]);
  check("a new thread that's already read: nothing", diffSnapshots(snap, read([sMessage(1, t0, "read"), sMessage(2, t0, "unread"), sMessage(4, t0, "read")]), enabled, NOW), []);
  check("a reply to a read thread (unread again, newer time)", sorted(diffSnapshots(snap, read([sMessage(1, t0 + 300, "unread"), sMessage(2, t0, "unread")]), enabled, NOW)), ["messages:1"]);
  check("last_updated moved but it's read: nothing", diffSnapshots(snap, read([sMessage(1, t0 + 300, "read"), sMessage(2, t0, "unread")]), enabled, NOW), []);
  check("marked unread without a new message: nothing", diffSnapshots(snap, read([sMessage(1, t0, "unread"), sMessage(2, t0, "unread")]), enabled, NOW), []);
  check("two at once", sorted(diffSnapshots(snap, read([sMessage(1, t0, "read"), sMessage(2, t0 + 10, "unread"), sMessage(5, t0, "unread")]), enabled, NOW)), ["messages:2"]);
}

section("Schoology: announcements (section updates)");
{
  const enabled = only("announcements");
  const read = (lists: Record<string, any[] | null>) => schoologyObservation({ uid: "1001", updates: lists }, enabled, identity, NOW);
  const snap = mergeSnapshot(null, read({ "111": [sUpdate(1)], "222": [] }), enabled);
  check("a teacher's new post", sorted(diffSnapshots(snap, read({ "111": [sUpdate(1), sUpdate(2)], "222": [] }), enabled, NOW)), ["announcements:1"]);
  check("the student's own post: nothing", diffSnapshots(snap, read({ "111": [sUpdate(1), sUpdate(3, "1001")], "222": [] }), enabled, NOW), []);
  check("a failed class: partial, nothing", [read({ "111": null, "222": [] }).partial.announcements, diffSnapshots(snap, read({ "111": null, "222": [] }), enabled, NOW)], [true, []]);
}

section("Baselines, switched-off types, staleness, caps");
{
  const prev = mergeSnapshot(null, schoologyObservation({ uid: "1", grades: sGrades(sGrade(1, 18)) }, only("grades"), identity, NOW), only("grades"));
  const next = schoologyObservation({ uid: "1", grades: sGrades(sGrade(1, 18), sGrade(2, 20)), inbox: [sMessage(9, 1, "unread")] }, only("grades", "messages"), identity, NOW);
  check("a type turned on later starts with a baseline", sorted(diffSnapshots(prev, next, only("grades", "messages"), NOW)), ["grades:1"]);
  check("a switched-off type never notifies", diffSnapshots(prev, next, only("messages"), NOW), []);
  check("a switched-off type isn't kept", Object.keys(mergeSnapshot(prev, next, only("messages")).sets), ["messages"]);
  check("a type not read this time keeps its old hashes", mergeSnapshot(prev, schoologyObservation({ uid: "1", grades: null }, only("grades"), identity, NOW), only("grades")).sets.grades, prev.sets.grades);
  check("days of failed checks: grades look again as a baseline", diffSnapshots(prev, next, only("grades"), NOW + STALE_MS + 1), []);
  const duePrev = mergeSnapshot(null, schoologyObservation({ uid: "1", assignments: { "1": [] } }, only("due"), identity, NOW), only("due"));
  const dueNext = schoologyObservation({ uid: "1", assignments: { "1": [sAssignment(5, NOW + STALE_MS + 2 * HOUR)] } }, only("due"), identity, NOW + STALE_MS + HOUR);
  check("...but due reminders still come", sorted(diffSnapshots(duePrev, dueNext, only("due"), NOW + STALE_MS + HOUR)), ["due:1"]);

  // 700 assignments: the newest 600 are kept, and an old one never comes back as new.
  const many = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => sAssignment(from + i, null));
  const capRead = schoologyObservation({ uid: "1", assignments: { "1": many(1, 701) } }, only("assignments"), identity, NOW);
  check(`capped at ${MAX_SET}`, capRead.sets.assignments!.length, MAX_SET);
  check("the newest are kept", [capRead.sets.assignments![0], capRead.sets.assignments!.includes("a|1|1"), capRead.sets.assignments!.includes("a|1|101")], ["a|1|700", false, true]);
  const capSnap = mergeSnapshot(null, capRead, only("assignments"));
  const capNext = schoologyObservation({ uid: "1", assignments: { "1": many(1, 702) } }, only("assignments"), identity, NOW);
  check("one more posted: exactly one new (the dropped oldest isn't news)", sorted(diffSnapshots(capSnap, capNext, only("assignments"), NOW)), ["assignments:1"]);
  const capPartial = mergeSnapshot(capSnap, { ...capNext, partial: { assignments: true } }, only("assignments"));
  check("a partial merge stays capped", capPartial.sets.assignments!.length, MAX_SET);
  check("readSnapshot rejects junk", [readSnapshot(null), readSnapshot({ v: 2 }), readSnapshot("x")], [null, null, null]);
  check("readSnapshot drops non-strings and unknown types", readSnapshot({ v: 1, at: { grades: 5 }, sets: { grades: ["a", 3, "b"], bogus: ["x"] } }), { v: 1, at: { grades: 5 }, sets: { grades: ["a", "b"] } });
}

section("Privacy: a stored snapshot holds hashes only");
{
  const hash = await snapshotHasher("push-secret-1", "1001");
  const obs = schoologyObservation(
    {
      uid: "1001",
      grades: sGrades(sGrade(1, 18.5), sGrade(2, "B+")),
      assignments: { "111": [sAssignment(10, NOW + HOUR, "Molarity Practice Set")] },
      inbox: [sMessage(3, 1, "unread", "Your grade in Chemistry")],
      updates: { "111": [sUpdate(4, "2002", "Field trip forms due Friday")] },
    },
    ALL,
    hash,
    NOW,
  );
  const stored = JSON.stringify(mergeSnapshot(null, obs, ALL));
  const all = Object.values(mergeSnapshot(null, obs, ALL).sets).flat();
  check("every entry is an 8-character hash", all.every((h) => /^[A-Za-z0-9_-]{8}$/.test(h)), true);
  check("no grades, titles, names, subjects or ids", ["18.5", "B+", "Molarity", "Chemistry", "Rivera", "Field trip", "Martin", "111", "1001"].filter((w) => stored.includes(w)), []);
}

/* Classroom raw data helpers */
const cWork = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: "Cell Diagram", maxPoints: 20, creationTime: new Date(NOW - Number(id) * 1000).toISOString(), ...extra });
const cDue = (ms: number) => {
  const d = new Date(ms);
  return { dueDate: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, dueTime: { hours: d.getUTCHours(), minutes: d.getUTCMinutes() } };
};
const cSub = (workId: string, extra: Record<string, unknown> = {}) => ({ id: "s" + workId, courseWorkId: workId, state: "CREATED", updateTime: new Date(NOW - 1000).toISOString(), ...extra });
const cCourse = (id: string, work: any[] | null, subs: any[] | null, anns: any[] | null = [], extra: Record<string, unknown> = {}) => ({
  course: { id, name: "Biology" },
  work,
  submissions: subs,
  announcements: anns,
  complete: work !== null && subs !== null,
  submissionsComplete: subs !== null,
  ...extra,
});

section("Classroom");
{
  const opts = { announcementsRead: true, cut: false };
  const raw1 = [cCourse("500", [cWork("1"), cWork("2", cDue(NOW + 2 * HOUR))], [cSub("1", { state: "RETURNED", assignedGrade: 17 })], [{ id: "900", text: "Hi", updateTime: new Date(NOW).toISOString() }])];
  const base = classroomObservation(raw1 as any, ALL, identity, NOW, opts);
  check("baseline", diffSnapshots(null, base, ALL, NOW), []);
  check("graded work is a grade; due work not turned in is due", [base.sets.grades, base.sets.due!.length], [["g|500|1|17|20"], 1]);
  check("Classroom has no messages", base.sets.messages, undefined);
  const snap = mergeSnapshot(null, base, ALL);
  const raw2 = [
    cCourse(
      "500",
      [cWork("1"), cWork("2", cDue(NOW + 2 * HOUR)), cWork("3", cDue(NOW + 5 * HOUR)), cWork("4", cDue(NOW + 6 * HOUR))],
      [cSub("1", { state: "RETURNED", assignedGrade: 18 }), cSub("4", { state: "TURNED_IN" })],
      [{ id: "900" }, { id: "901" }],
    ),
  ];
  check(
    "changed grade, two new assignments, one new reminder (the turned-in one isn't), one announcement",
    sorted(diffSnapshots(snap, classroomObservation(raw2 as any, ALL, identity, NOW, opts), ALL, NOW)),
    ["grades:1", "assignments:2", "due:1", "announcements:1"],
  );
  const graded = classroomObservation([cCourse("500", [cWork("5", cDue(NOW + HOUR))], [cSub("5", { assignedGrade: 3 })])] as any, ALL, identity, NOW, opts);
  check("graded work isn't due", graded.sets.due, []);
  const noAnn = classroomObservation(raw1 as any, ALL, identity, NOW, { announcementsRead: false, cut: false });
  check("announcements not read without the permission", noAnn.sets.announcements, undefined);
  const cut = classroomObservation(raw1 as any, ALL, identity, NOW, { announcementsRead: true, cut: true });
  check("budget cut: everything partial", [cut.partial.grades, cut.partial.assignments, cut.partial.due, cut.partial.announcements], [true, true, true, true]);
  const failedCourse = classroomObservation([cCourse("500", null, null, null)] as any, ALL, identity, NOW, opts);
  check("a class that failed: partial", [failedCourse.partial.grades, failedCourse.partial.assignments, failedCourse.partial.announcements], [true, true, true]);
  const unknownSubs = classroomObservation([cCourse("500", [cWork("6", cDue(NOW + HOUR))], [], [], { submissionsComplete: false, complete: false })] as any, ALL, identity, NOW, opts);
  check("can't tell if it's turned in: still reminded", unknownSubs.sets.due!.length, 1);
}

section("The notification");
{
  const one = (type: keyof NotifyTypes, count: number) => notificationFor([{ type, count }]);
  check("grade", one("grades", 1), { title: "Averages", body: "A new grade was posted.", url: "/grades", tag: "averages-grades" });
  check("grades", one("grades", 3)!.body, "3 new grades were posted.");
  check("assignment", one("assignments", 1), { title: "Averages", body: "A new assignment was posted.", url: "/assignments", tag: "averages-assignments" });
  check("assignments", one("assignments", 2)!.body, "2 new assignments were posted.");
  check("due", one("due", 1), { title: "Averages", body: "An assignment is due within a day.", url: "/assignments", tag: "averages-due" });
  check("due (several)", one("due", 4)!.body, "4 assignments are due within a day.");
  check("message", one("messages", 1), { title: "Averages", body: "You have a new message.", url: "/messages", tag: "averages-messages" });
  check("messages", one("messages", 2)!.body, "You have 2 new messages.");
  check("announcement", one("announcements", 1), { title: "Averages", body: "Your teacher posted an update.", url: "/home", tag: "averages-announcements" });
  check("announcements", one("announcements", 5)!.body, "5 new class updates were posted.");
  check("two kinds", notificationFor([{ type: "messages", count: 1 }, { type: "grades", count: 2 }]), { title: "Averages", body: "New grades and messages. Open Averages to see them.", url: "/home", tag: "averages-updates" });
  check(
    "all kinds",
    notificationFor(NOTIFY_TYPES.map((type) => ({ type, count: 1 })))!.body,
    "New grades, assignments, due date reminders, messages and class updates. Open Averages to see them.",
  );
  check("assignments and due go to Assignments", notificationFor([{ type: "due", count: 1 }, { type: "assignments", count: 1 }])!.url, "/assignments");
  check("nothing changed: no notification", [notificationFor([]), notificationFor([{ type: "grades", count: 0 }])], [null, null]);
  const everyText = [
    ...NOTIFY_TYPES.flatMap((t) => [one(t, 1)!.body, one(t, 9)!.body]),
    notificationFor(NOTIFY_TYPES.map((type) => ({ type, count: 1 })))!.body,
    TEST_NOTIFICATION.body,
  ].join(" ");
  check("no em or en dashes in any copy", /[—–]/.test(everyText), false);
  check("test copy", TEST_NOTIFICATION, { title: "Averages", body: "Notifications are on. Averages will let you know when something changes.", url: "/settings", tag: "averages-test" });
}

/* ════════════════════════════════════════════════════════════════════════
 * PushStore, on fake storage, with Schoology / Google / a push service faked
 * ════════════════════════════════════════════════════════════════════════ */

/** Map-backed stand-in for DurableObjectStorage (key-value API + alarms). Values are cloned like real storage. */
class FakeStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get(key: string | string[]): Promise<any> {
    if (Array.isArray(key)) {
      const out = new Map<string, unknown>();
      for (const k of key) if (this.data.has(k)) out.set(k, structuredClone(this.data.get(k)));
      return out;
    }
    return this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.data.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

const SESSION_SECRET = "push-test-session-secret";
const PUSH_SECRET = "push-test-push-secret";
const vapidKeys = await generateVapidKeys();
const GOOGLE_CLIENT_ID = "123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com";
const ENV: Record<string, unknown> = {
  SESSION_SECRET,
  PUSH_SECRET,
  VAPID_PUBLIC_KEY: vapidKeys.publicKey,
  VAPID_PRIVATE_JWK: JSON.stringify(vapidKeys.privateKeyJwk),
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: "GOCSPX-push-test-not-real",
  GOOGLE_REDIRECT_URI: "https://api.averages.io/auth/google/callback",
};

function newStore(env: Record<string, unknown> = ENV) {
  const storage = new FakeStorage();
  const store = new PushStore({ storage } as any, env as any);
  return { store, storage };
}

/** A "browser": an ECDH key pair and auth secret, so the test can read what was pushed to it. */
async function makeBrowser(name: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair,
    uaPublic,
    auth,
    subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(auth) } },
  };
}
type Browser = Awaited<ReturnType<typeof makeBrowser>>;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
/** RFC 8291 decryption, as the browser does it. */
async function readPush(body: Uint8Array, browser: Browser): Promise<any> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as any, browser.pair.privateKey, 256));
  const ikm = await hkdf(browser.auth, secret, new Uint8Array([...enc.encode("WebPush: info\0"), ...browser.uaPublic, ...asPublic]), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.slice(21 + idlen)));
  return JSON.parse(dec.decode(padded.slice(0, padded.length - 1)));
}

/* The fake internet */
type Sent = { endpoint: string; headers: Record<string, string>; body: Uint8Array };
const world = {
  calls: [] as URL[],
  sent: [] as Sent[],
  inFlight: 0,
  maxInFlight: 0,
  /** Schoology */
  sections: [{ id: "111" }, { id: "222" }] as any[],
  grades: sGrades(sGrade(1, 18)) as any[],
  assignments: { "111": [sAssignment(10, null)], "222": [] } as Record<string, any[]>,
  inbox: [] as any[],
  updates: { "111": [], "222": [] } as Record<string, any[]>,
  schoologyStatus: {} as Record<string, number>,
  /** Google */
  tokenError: "" as string,
  tokenScope: "https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  courseWork: [] as any[],
  submissions: [] as any[],
  announcements: [] as any[],
  /** push service: status per endpoint name */
  pushStatus: {} as Record<string, number>,
  /** Called during a Schoology grades request (to simulate the student acting mid-check). */
  duringGrades: null as null | (() => Promise<void>),
};
function resetWorld() {
  world.calls = [];
  world.sent = [];
  world.maxInFlight = 0;
  world.schoologyStatus = {};
  world.pushStatus = {};
  world.tokenError = "";
  world.duringGrades = null;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  world.calls.push(url);
  world.inFlight++;
  world.maxInFlight = Math.max(world.maxInFlight, world.inFlight);
  try {
    await new Promise((r) => setTimeout(r, 1)); // let other requests overlap, like the real thing
    if (url.hostname === "api.schoology.com") {
      const path = url.pathname.replace(/^\/v1/, "");
      const forced = world.schoologyStatus[path];
      if (forced) return json({ error: "forced" }, forced);
      if (path === "/users/1001/sections") return json({ section: world.sections });
      if (path === "/users/1001/grades") {
        if (world.duringGrades) await world.duringGrades();
        return json({ section: world.grades });
      }
      if (path === "/messages/inbox") return json({ message: world.inbox });
      let m = path.match(/^\/sections\/(\d+)\/assignments$/);
      if (m) return json({ assignment: world.assignments[m[1]] ?? [] });
      m = path.match(/^\/sections\/(\d+)\/updates$/);
      if (m) return json({ update: world.updates[m[1]] ?? [] });
      return json({ error: "not_found" }, 404);
    }
    if (url.href === "https://oauth2.googleapis.com/token") {
      if (world.tokenError) return json({ error: world.tokenError }, 400);
      return json({ access_token: "ya29.fresh", expires_in: 3599, scope: world.tokenScope });
    }
    if (url.hostname === "classroom.googleapis.com") {
      const auth = new Headers(init.headers).get("Authorization");
      if (auth !== "Bearer ya29.fresh") return json({ error: "unauthenticated" }, 401);
      const path = url.pathname.replace(/^\/v1/, "");
      if (path === "/courses") return json({ courses: [{ id: "500", name: "Biology" }] });
      if (path === "/courses/500/courseWork") return json({ courseWork: world.courseWork });
      if (path === "/courses/500/courseWork/-/studentSubmissions") return json({ studentSubmissions: world.submissions });
      if (path === "/courses/500/announcements") return json({ announcements: world.announcements });
      return json({ error: "not_found" }, 404);
    }
    if (url.hostname === "fcm.googleapis.com") {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      world.sent.push({ endpoint: url.href, headers, body: new Uint8Array(init.body as Uint8Array) });
      const name = url.pathname.split("/").pop()!;
      return new Response(null, { status: world.pushStatus[name] ?? 201 });
    }
    return json({ error: "unexpected host" }, 500);
  } finally {
    world.inFlight--;
  }
}) as typeof fetch;

/** Console output during store runs, kept rather than printed (and checked for secrets). */
const logged: string[] = [];
const realLog = console.log;
const realError = console.error;
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  const restore = () => {
    console.error = realError;
  };
  return fn().finally(restore);
}
console.log = (...a: unknown[]) => {
  const text = a.map(String).join(" ");
  if (text.startsWith("push_")) logged.push(text);
  else realLog(...a);
};

const SCHOOLOGY_SESSION: SessionData = { key: "consumer-key-xyz", secret: "consumer-secret-xyz", uid: "1001", exp: Math.floor(Date.now() / 1000) + 30 * 86400 };
async function credentialFor(session: SessionData, secret = PUSH_SECRET, ttl?: number) {
  const left = ttl ?? session.exp - Math.floor(Date.now() / 1000);
  return { sealed: await sealValue(JSON.stringify(session), secret, PUSH_PURPOSE, left), exp: session.exp };
}

/** What the browser shows for the last notification sent to it. */
async function lastShown(browser: Browser) {
  const s = [...world.sent].reverse().find((x) => x.endpoint === browser.subscription.endpoint);
  return s ? readPush(s.body, browser) : null;
}

section("PushStore: subscribe");
const phone = await makeBrowser("phone");
const laptop = await makeBrowser("laptop");
{
  resetWorld();
  const { store, storage } = newStore();
  const before = Date.now();
  const status = await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
  check("on, in this browser", [status.on, status.here, status.devices], [true, true, 1]);
  check("first check (the baseline) is soon", storage.alarm! >= before + FIRST_CHECK_MS && storage.alarm! <= Date.now() + FIRST_CHECK_MS + 15_000, true);
  check("stores subscription, types, sealed sign-in and meta only", [...storage.data.keys()].sort(), ["cred", "meta", "subs", "types"]);
  check("only endpoint and keys are kept", Object.keys((storage.data.get("subs") as any[])[0]).sort(), ["addedAt", "endpoint", "keys"]);
  const stored = JSON.stringify([...storage.data.values()]);
  check("the stored sign-in isn't readable", [stored.includes("consumer-secret-xyz"), stored.includes("consumer-key-xyz")], [false, false]);
  const sealed = (storage.data.get("cred") as any).sealed;
  check("it opens with PUSH_SECRET", JSON.parse(String(await openValue(sealed, PUSH_SECRET, PUSH_PURPOSE))).secret, "consumer-secret-xyz");
  check("...and not with SESSION_SECRET", await openValue(sealed, SESSION_SECRET, PUSH_PURPOSE), null);
  check("...and isn't a session cookie", await openSession(sealed, SESSION_SECRET), null);

  const firstAlarm = storage.alarm;
  await store.subscribe({ subscription: laptop.subscription, types: only("grades"), ...(await credentialFor(SCHOOLOGY_SESSION)) });
  check("a second browser keeps the schedule", storage.alarm, firstAlarm);
  check("types are the student's, last one set wins", storage.data.get("types"), only("grades"));
  await store.subscribe({ subscription: { ...phone.subscription }, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
  check("same endpoint replaces", (storage.data.get("subs") as any[]).map((s) => s.endpoint.split("/").pop()), ["laptop", "phone"]);
  for (const n of ["b3", "b4", "b5", "b6"]) {
    const b = await makeBrowser(n);
    await store.subscribe({ subscription: b.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
  }
  check("at most 5 browsers: the oldest goes", (storage.data.get("subs") as any[]).map((s) => s.endpoint.split("/").pop()), ["phone", "b3", "b4", "b5", "b6"]);
  let threw = "";
  try {
    await store.subscribe({ subscription: { endpoint: "http://localhost/x", keys: phone.subscription.keys }, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("a subscription we can't send to is refused", threw, "push_bad_subscription");
}

section("PushStore: Schoology checks");
{
  resetWorld();
  world.grades = sGrades(sGrade(1, 18));
  world.assignments = { "111": [sAssignment(10, null)], "222": [] };
  world.inbox = [sMessage(1, 100, "read")];
  world.updates = { "111": [sUpdate(1)], "222": [] };
  const { store, storage } = newStore();
  await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
  await store.subscribe({ subscription: laptop.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });

  const t0 = Date.now();
  await quiet(() => store.alarm());
  check("baseline: read everything, sent nothing", [world.sent.length, world.calls.filter((u) => u.hostname === "api.schoology.com").length], [0, 7]);
  check("snapshot saved", Object.keys((storage.data.get("snap") as Snapshot).sets).sort(), ["announcements", "assignments", "due", "grades", "messages"]);
  check("next check in 20 to 24 minutes", storage.alarm! >= t0 + CHECK_EVERY_MS && storage.alarm! <= Date.now() + CHECK_EVERY_MS + JITTER_MS, true);
  check("at most 3 Schoology calls at once", world.maxInFlight <= 3, true);

  resetWorld();
  await quiet(() => store.alarm());
  check("nothing changed: nothing sent", world.sent.length, 0);

  resetWorld();
  world.grades = sGrades(sGrade(1, 18), sGrade(2, 19));
  await quiet(() => store.alarm());
  check("a new grade: one notification per browser", world.sent.map((s) => s.endpoint.split("/").pop()).sort(), ["laptop", "phone"]);
  check("what the phone shows", await lastShown(phone), { title: "Averages", body: "A new grade was posted.", url: "/grades", tag: "averages-grades" });
  check("what the laptop shows", (await lastShown(laptop)).body, "A new grade was posted.");
  const h = world.sent[0].headers;
  check("push headers", [h["content-encoding"], h["ttl"], h["urgency"], h["topic"], h["authorization"].startsWith("vapid t=")], ["aes128gcm", "43200", "normal", "averages-grades", true]);

  resetWorld();
  world.inbox = [sMessage(1, 100, "read"), sMessage(2, 200, "unread")];
  world.assignments = { "111": [sAssignment(10, null), sAssignment(11, Date.now() + 2 * HOUR)], "222": [] };
  await quiet(() => store.alarm());
  check("several kinds: one combined notification", await lastShown(phone), {
    title: "Averages",
    body: "New assignments, due date reminders and messages. Open Averages to see them.",
    url: "/home",
    tag: "averages-updates",
  });

  // 15 classes: only 12 are read, and the whole check stays under the subrequest limit.
  resetWorld();
  world.sections = Array.from({ length: 15 }, (_, i) => ({ id: String(300 + i) }));
  await quiet(() => store.alarm());
  const schoologyCalls = world.calls.filter((u) => u.hostname === "api.schoology.com").length;
  check("15 classes: 12 read (3 lists + 12 assignments + 12 updates)", schoologyCalls, 27);
  check("...at most 3 at once", world.maxInFlight <= 3, true);
  check("...plus a push to each of 5 browsers, still under 50 subrequests", schoologyCalls + 5 <= 50, true);
  world.sections = [{ id: "111" }, { id: "222" }];
  resetWorld();
  await quiet(() => store.alarm()); // settle back to two classes

  // A browser whose subscription has expired is forgotten; the other keeps working.
  resetWorld();
  world.pushStatus = { laptop: 410 };
  world.grades = sGrades(sGrade(1, 18), sGrade(2, 19), sGrade(3, 12));
  await quiet(() => store.alarm());
  check("410: that browser is dropped", (storage.data.get("subs") as any[]).map((s) => s.endpoint.split("/").pop()), ["phone"]);
  check("the rest is kept", storage.data.has("cred"), true);

  // Turning types off: their reads stop and their hashes are forgotten.
  await store.setTypes(only("grades"));
  check("switched-off types' hashes are forgotten", Object.keys((storage.data.get("snap") as Snapshot).sets), ["grades"]);
  resetWorld();
  await quiet(() => store.alarm());
  check("only what the enabled types need is read", world.calls.map((u) => u.pathname), ["/v1/users/1001/grades"]);

  // A failing Schoology: the old snapshot stays, and checks slow down after six in a row.
  const snapBefore = JSON.stringify(storage.data.get("snap"));
  resetWorld();
  world.schoologyStatus = { "/users/1001/grades": 503 };
  for (let i = 0; i < 5; i++) await quiet(() => store.alarm());
  check("a failing upstream keeps the snapshot", JSON.stringify(storage.data.get("snap")), snapBefore);
  check("five failures: still every ~20 minutes", storage.alarm! <= Date.now() + CHECK_EVERY_MS + JITTER_MS, true);
  await quiet(() => store.alarm());
  check("six: hourly", storage.alarm! >= Date.now() + BACKOFF_EVERY_MS - 1000, true);
  check("failures counted", (storage.data.get("meta") as any).failures, 6);
  resetWorld();
  await quiet(() => store.alarm());
  check("one that works resets it", [(storage.data.get("meta") as any).failures, storage.alarm! <= Date.now() + CHECK_EVERY_MS + JITTER_MS], [0, true]);

  // The last browser gone: everything deleted.
  resetWorld();
  world.pushStatus = { phone: 404 };
  world.grades = sGrades(sGrade(1, 18), sGrade(2, 19), sGrade(3, 12), sGrade(4, 20));
  await quiet(() => store.alarm());
  check("no browsers left: nothing kept, no alarm", [storage.data.size, storage.alarm], [0, null]);
}

section("PushStore: when to stop for good");
{
  for (const [name, setup] of [
    ["Schoology 401 (key revoked)", () => (world.schoologyStatus = { "/users/1001/grades": 401 })],
    ["Schoology 401 on the inbox", () => (world.schoologyStatus = { "/messages/inbox": 401 })],
  ] as const) {
    resetWorld();
    const { store, storage } = newStore();
    await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
    setup();
    await quiet(() => store.alarm());
    check(`${name}: everything deleted`, [storage.data.size, storage.alarm], [0, null]);
  }
  {
    resetWorld();
    const { store, storage } = newStore();
    await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
    world.schoologyStatus = { "/sections/111/assignments": 403 };
    await quiet(() => store.alarm());
    check("one class refusing (403) is not a reason to stop", [storage.data.has("cred"), (storage.data.get("snap") as any) !== undefined], [true, true]);
  }
  {
    resetWorld();
    const { store, storage } = newStore();
    const expired = { ...SCHOOLOGY_SESSION, exp: Math.floor(Date.now() / 1000) - 10 };
    await store.subscribe({ subscription: phone.subscription, types: ALL, sealed: (await credentialFor(SCHOOLOGY_SESSION)).sealed, exp: expired.exp });
    await quiet(() => store.alarm());
    check("expired sign-in: everything deleted, nothing fetched", [storage.data.size, storage.alarm, world.calls.length], [0, null, 0]);
  }
  {
    resetWorld();
    const { store, storage } = newStore();
    await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION, "an-old-push-secret")) });
    await quiet(() => store.alarm());
    check("sealed under another PUSH_SECRET: everything deleted", [storage.data.size, storage.alarm, world.calls.length], [0, null, 0]);
  }
  {
    resetWorld();
    const { store, storage } = newStore({ ...ENV, PUSH_SECRET: "" });
    await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
    await quiet(() => store.alarm());
    check("PUSH_SECRET missing (a deploy mistake): kept, checked again later", [storage.data.has("cred"), storage.alarm !== null, world.calls.length], [true, true, 0]);
  }
  {
    resetWorld();
    const { store, storage } = newStore();
    await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
    // The student turns notifications off while Schoology is still answering.
    world.duringGrades = () => store.deleteAll();
    await quiet(() => store.alarm());
    check("turned off mid-check: nothing written back, no alarm", [storage.data.size, storage.alarm], [0, null]);
  }
  {
    resetWorld();
    const { store, storage } = newStore();
    await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
    const oldGen = (storage.data.get("meta") as any).gen;
    world.duringGrades = async () => {
      await store.deleteAll();
      await store.subscribe({ subscription: laptop.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
    };
    await quiet(() => store.alarm());
    check("off and on again mid-check: the new baseline isn't overwritten", [(storage.data.get("meta") as any).gen !== oldGen, storage.data.has("snap")], [true, false]);
  }
  {
    resetWorld();
    world.grades = sGrades(sGrade(1, 18));
    world.inbox = [];
    const { store, storage } = newStore();
    await store.subscribe({ subscription: phone.subscription, types: only("grades", "messages"), ...(await credentialFor(SCHOOLOGY_SESSION)) });
    await quiet(() => store.alarm()); // baseline
    resetWorld();
    world.grades = sGrades(sGrade(1, 18), sGrade(2, 11));
    world.inbox = [sMessage(7, 500, "unread")];
    world.duringGrades = async () => void (await store.setTypes({ grades: false }));
    await quiet(() => store.alarm());
    check("a type switched off mid-check doesn't notify", (await lastShown(phone))?.body, "You have a new message.");
    check("...and isn't kept", Object.keys((storage.data.get("snap") as Snapshot).sets), ["messages"]);
    world.grades = sGrades(sGrade(1, 18));
    world.inbox = [];
  }
  {
    resetWorld();
    const { store, storage } = newStore();
    await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    let threw = false;
    try {
      await quiet(() => store.alarm());
    } catch {
      threw = true;
    } finally {
      globalThis.fetch = realFetch;
    }
    check("alarm() never throws (no hot retries); next check scheduled", [threw, storage.alarm !== null, storage.data.has("cred")], [false, true, true]);
  }
  check("something was logged (the failures above)", logged.some((l) => l.startsWith("push_check_failed")), true);
  check("nothing logged contains the sign-in or the student's id", logged.some((l) => /consumer-secret-xyz|consumer-key-xyz|1001/.test(l)), false);
}

section("PushStore: Google Classroom checks");
const GOOGLE_SESSION: SessionData = {
  key: "",
  secret: "",
  uid: "g:1234567890",
  exp: Math.floor(Date.now() / 1000) + 30 * 86400,
  g: { at: "ya29.old", rt: "1//refresh-token", ax: 0, sc: "cwma", name: "Martin", email: "m@example.com", pic: "" },
};
{
  resetWorld();
  world.tokenScope += " https://www.googleapis.com/auth/classroom.announcements.readonly";
  world.courseWork = [cWork("1"), cWork("2")];
  world.submissions = [cSub("1", { state: "RETURNED", assignedGrade: 17 })];
  world.announcements = [{ id: "900", updateTime: new Date().toISOString() }];
  const { store, storage } = newStore();
  await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(GOOGLE_SESSION)) });
  await quiet(() => store.alarm());
  const refreshes = world.calls.filter((u) => u.hostname === "oauth2.googleapis.com");
  check("baseline: one token refresh, Classroom read, nothing sent", [refreshes.length, world.calls.some((u) => u.hostname === "classroom.googleapis.com"), world.sent.length], [1, true, 0]);
  check("...well under 50 subrequests", world.calls.length < 50, true);
  resetWorld();
  world.submissions = [cSub("1", { state: "RETURNED", assignedGrade: 19 })];
  world.announcements = [{ id: "900" }, { id: "901" }];
  await quiet(() => store.alarm());
  check("a changed grade and an announcement", (await lastShown(phone)).body, "New grades and class updates. Open Averages to see them.");

  resetWorld();
  world.tokenScope = "https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly";
  await quiet(() => store.alarm());
  check("announcements permission gone: not read any more", world.calls.some((u) => u.pathname.endsWith("/announcements")), false);
  check("...and the student isn't cut off", storage.data.has("cred"), true);

  resetWorld();
  await store.setTypes(only("messages"));
  await quiet(() => store.alarm());
  check("only Messages on (Classroom has none): no calls, not a failure", [world.calls.length, (storage.data.get("meta") as any).failures ?? 0, storage.alarm !== null], [0, 0, true]);

  await store.setTypes(ALL);
  resetWorld();
  world.tokenError = "invalid_grant";
  await quiet(() => store.alarm());
  check("Google access removed (invalid_grant): everything deleted", [storage.data.size, storage.alarm], [0, null]);
}
{
  resetWorld();
  world.tokenScope = "https://www.googleapis.com/auth/classroom.courses.readonly";
  const { store, storage } = newStore();
  await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(GOOGLE_SESSION)) });
  await quiet(() => store.alarm());
  check("required Classroom permission gone: everything deleted", storage.data.size, 0);
  world.tokenScope = "https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly";
}
{
  resetWorld();
  const { store, storage } = newStore({ ...ENV, GOOGLE_CLIENT_SECRET: "" });
  await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(GOOGLE_SESSION)) });
  await quiet(() => store.alarm());
  check("Google sign-in not configured: kept, tried later", [storage.data.has("cred"), storage.alarm !== null, (storage.data.get("meta") as any).failures], [true, true, 1]);
}

section("PushStore: touch, test, status, unsubscribe");
{
  resetWorld();
  const { store, storage } = newStore();
  check("touch with nothing stored: nothing kept", [await store.touch(await credentialFor(SCHOOLOGY_SESSION)), storage.data.size], [false, 0]);
  await store.subscribe({ subscription: phone.subscription, types: ALL, ...(await credentialFor(SCHOOLOGY_SESSION)) });
  const later = { ...SCHOOLOGY_SESSION, exp: SCHOOLOGY_SESSION.exp + 86400 };
  check("touch with a longer-lasting session replaces the sign-in", [await store.touch(await credentialFor(later)), (storage.data.get("cred") as any).exp], [true, later.exp]);
  const sooner = { ...SCHOOLOGY_SESSION, exp: SCHOOLOGY_SESSION.exp - 86400 };
  await store.touch(await credentialFor(sooner));
  check("an older session can't swap in one that ends sooner", (storage.data.get("cred") as any).exp, later.exp);

  const test1 = await store.test(phone.subscription.endpoint);
  check("test notification sent", [test1, await lastShown(phone)], [{ ok: true }, TEST_NOTIFICATION]);
  check("test TTL is short", world.sent[world.sent.length - 1].headers["ttl"], "300");
  check("again right away: too soon", await store.test(phone.subscription.endpoint), { ok: false, code: "too_soon" });
  check("another browser: not subscribed", await store.test(laptop.subscription.endpoint), { ok: false, code: "not_subscribed" });
  (storage.data.get("meta") as any).lastTestAt = 0;
  world.pushStatus = { phone: 410 };
  check("expired subscription: gone, and forgotten", [await store.test(phone.subscription.endpoint), storage.data.size], [{ ok: false, code: "subscription_gone" }, 0]);
  world.pushStatus = {};

  await store.subscribe({ subscription: phone.subscription, types: only("grades", "due"), ...(await credentialFor(SCHOOLOGY_SESSION)) });
  await store.subscribe({ subscription: laptop.subscription, types: only("grades", "due"), ...(await credentialFor(SCHOOLOGY_SESSION)) });
  const st = await store.status(phone.subscription.endpoint);
  check("status", [st.on, st.here, st.devices, st.types], [true, true, 2, only("grades", "due")]);
  check("status for an unknown browser", (await store.status("https://fcm.googleapis.com/fcm/send/other")).here, false);
  const afterOne = await store.unsubscribe(phone.subscription.endpoint);
  check("one browser off: still on in the other", [afterOne.on, afterOne.here, afterOne.devices, storage.data.has("cred")], [true, false, 1, true]);
  const afterAll = await store.unsubscribe(laptop.subscription.endpoint);
  check("the last browser off: everything deleted", [afterAll.on, storage.data.size, storage.alarm], [false, 0, null]);
  check("setTypes with nothing stored", await store.setTypes(ALL), null);
}

/* ════════════════════════════════════════════════════════════════════════
 * Routes (src/push.ts) on a bare Hono app
 * ════════════════════════════════════════════════════════════════════════ */

const API = "https://api.averages.io";
const stores = new Map<string, { store: PushStore; storage: FakeStorage }>();
let storeThrows = false;
const storeFor = (env: any, uid: string): PushStoreApi => {
  if (storeThrows) throw new Error("durable object unreachable");
  if (!stores.has(uid)) stores.set(uid, newStore(env));
  return stores.get(uid)!.store as unknown as PushStoreApi;
};
async function requireSession(c: any, next: () => Promise<void>) {
  const token = readCookie(c.req.header("Cookie") ?? null, SESSION_COOKIE);
  const session = token ? await openSession(token, c.env.SESSION_SECRET) : null;
  if (!session) return c.json({ error: "not_authenticated" }, 401);
  c.set("session", session);
  await next();
}
/** Same rules as index.ts's notFromOurApp. */
function fromOurApp(c: any) {
  const origin = c.req.header("Origin");
  if (origin && !["https://app.averages.io", "https://averages.io"].includes(origin)) return c.json({ error: "forbidden_origin" }, 403);
  if (c.req.method === "POST" && !(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "json_required" }, 415);
  return null;
}
const app = new Hono();
app.route("/push", pushRoutes({ requireSession, fromOurApp, storeFor }));

const cookieFor = async (data: Omit<SessionData, "exp">) => `${SESSION_COOKIE}=${await sealSession(data, SESSION_SECRET)}`;
const live = await cookieFor({ key: "consumer-key-xyz", secret: "consumer-secret-xyz", uid: "1001" });
const demo = await cookieFor({ key: "", secret: "", uid: "__demo__" });
const incognito = await cookieFor({ key: "k2", secret: "s2", uid: "1002", inc: true });
async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; env?: Record<string, unknown>; origin?: string; contentType?: string } = {}) {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  headers.set("Origin", opts.origin ?? "https://app.averages.io");
  if (opts.body !== undefined) headers.set("Content-Type", opts.contentType ?? "application/json");
  const res = await app.fetch(new Request(API + path, { method, headers, body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }), (opts.env ?? ENV) as any, { waitUntil() {}, passThroughOnException() {} } as any);
  let data: any = null;
  try {
    data = await res.clone().json();
  } catch {}
  return { status: res.status, data, res };
}

section("Routes: GET /push/config");
{
  check("set up: the public key", (await call("GET", "/push/config")).data, { publicKey: vapidKeys.publicKey });
  check("public and cacheable", (await call("GET", "/push/config")).res.headers.get("Cache-Control"), "public, max-age=300");
  for (const missing of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_JWK", "PUSH_SECRET"]) {
    check(`no ${missing}: null`, (await call("GET", "/push/config", { env: { ...ENV, [missing]: "" } })).data, { publicKey: null });
  }
  check("PUSH_SECRET the same as SESSION_SECRET: null (it must be separate)", (await call("GET", "/push/config", { env: { ...ENV, PUSH_SECRET: SESSION_SECRET } })).data, { publicKey: null });
  check("a malformed public key: null", (await call("GET", "/push/config", { env: { ...ENV, VAPID_PUBLIC_KEY: "short" } })).data, { publicKey: null });
  check("vapidFrom default subject", vapidFrom(ENV as any)!.subject, "mailto:help@averages.io");
  check("pushConfigured", pushConfigured(ENV as any), true);
}

section("Routes: POST /push/subscribe");
{
  const body = { subscription: phone.subscription, types: { grades: true, messages: false, junk: 1, due: "yes" } };
  check("signed out: 401", (await call("POST", "/push/subscribe", { body })).status, 401);
  check("demo: 403", (await call("POST", "/push/subscribe", { cookie: demo, body })).data, { error: "not_available_in_demo" });
  check("incognito: 403", (await call("POST", "/push/subscribe", { cookie: incognito, body })).data, { error: "incognito_mode" });
  check("not set up: 503", (await call("POST", "/push/subscribe", { cookie: live, body, env: { ...ENV, VAPID_PRIVATE_JWK: "" } })).data, { error: "push_not_configured" });
  check("another site: 403", (await call("POST", "/push/subscribe", { cookie: live, body, origin: "https://evil.example" })).status, 403);
  check("not JSON: 415", (await call("POST", "/push/subscribe", { cookie: live, body: "subscription=x", contentType: "application/x-www-form-urlencoded" })).status, 415);
  check("bad JSON: 400", (await call("POST", "/push/subscribe", { cookie: live, body: "{nope" })).data, { error: "invalid_body" });
  for (const [name, sub] of [
    ["http endpoint", { ...phone.subscription, endpoint: "http://fcm.googleapis.com/fcm/send/x" }],
    ["localhost endpoint", { ...phone.subscription, endpoint: "https://localhost/push" }],
    ["IP endpoint", { ...phone.subscription, endpoint: "https://10.0.0.1/push" }],
    ["bad keys", { endpoint: phone.subscription.endpoint, keys: { p256dh: "abc", auth: "def" } }],
    ["no keys", { endpoint: phone.subscription.endpoint }],
    ["huge endpoint", { ...phone.subscription, endpoint: "https://fcm.googleapis.com/" + "x".repeat(3000) }],
  ] as const) {
    check(`${name}: 400`, (await call("POST", "/push/subscribe", { cookie: live, body: { subscription: sub } })).data, { error: "bad_subscription" });
  }
  check("nothing stored by refused calls", stores.size, 0);
  const ok = await call("POST", "/push/subscribe", { cookie: live, body });
  check("on", [ok.status, ok.data.ok, ok.data.on, ok.data.here, ok.data.devices], [200, true, true, true, 1]);
  check("types: only the known keys, booleans only", ok.data.types, { ...ALL, messages: false });
  check("no caching", ok.res.headers.get("Cache-Control"), "private, no-store");
  const { storage } = stores.get("1001")!;
  const cred = storage.data.get("cred") as any;
  const opened = JSON.parse(String(await openValue(cred.sealed, PUSH_SECRET, PUSH_PURPOSE)));
  check("the stored sign-in is this session, sealed with PUSH_SECRET", [opened.uid, opened.key, opened.secret], ["1001", "consumer-key-xyz", "consumer-secret-xyz"]);
  check("it expires with the session", cred.exp, (await openSession(readCookie(live, SESSION_COOKIE)!, SESSION_SECRET))!.exp);
  check("baseline check scheduled", storage.alarm !== null, true);
  storeThrows = true;
  check("store unreachable: 502", (await quiet(() => call("POST", "/push/subscribe", { cookie: live, body }))).data, { error: "push_unavailable" });
  storeThrows = false;
}

section("Routes: types, test, touch, status");
{
  check("PUT /push/types: only the switches sent change", (await call("PUT", "/push/types", { cookie: live, body: { types: { grades: false, junk: true } } })).data.types, { ...ALL, grades: false, messages: false });
  check("PUT /push/types: back on", (await call("PUT", "/push/types", { cookie: live, body: { types: { grades: true, messages: true } } })).data.types, ALL);
  check("PUT /push/types: not an object", (await call("PUT", "/push/types", { cookie: live, body: { types: "all" } })).data, { error: "bad_types" });
  const other = await cookieFor({ key: "k3", secret: "s3", uid: "1003" });
  check("PUT /push/types: nothing stored", (await call("PUT", "/push/types", { cookie: other, body: { types: {} } })).data, { error: "not_subscribed" });
  check("PUT /push/types: demo", (await call("PUT", "/push/types", { cookie: demo, body: { types: {} } })).status, 403);

  resetWorld();
  check("POST /push/test", (await call("POST", "/push/test", { cookie: live, body: { endpoint: phone.subscription.endpoint } })).data, { ok: true });
  check("...arrives", (await lastShown(phone)).body, TEST_NOTIFICATION.body);
  check("POST /push/test: too soon", (await call("POST", "/push/test", { cookie: live, body: { endpoint: phone.subscription.endpoint } })).status, 429);
  check("POST /push/test: another browser", (await call("POST", "/push/test", { cookie: live, body: { endpoint: laptop.subscription.endpoint } })).status, 404);
  check("POST /push/test: no endpoint", (await call("POST", "/push/test", { cookie: live, body: {} })).status, 400);

  check("POST /push/touch: on", (await call("POST", "/push/touch", { cookie: live, body: {} })).data, { ok: true, on: true });
  check("POST /push/touch: nothing stored (turned off meanwhile)", (await call("POST", "/push/touch", { cookie: other, body: {} })).data, { ok: true, on: false });
  check("...and nothing created", stores.get("1003")!.storage.data.size, 0);
  check("POST /push/touch: incognito", (await call("POST", "/push/touch", { cookie: incognito, body: {} })).status, 403);
  check("POST /push/touch: must be JSON", (await call("POST", "/push/touch", { cookie: live })).status, 415);

  const st = await call("POST", "/push/status", { cookie: live, body: { endpoint: phone.subscription.endpoint } });
  check("POST /push/status: here", [st.data.on, st.data.here, st.data.configured], [true, true, true]);
  check("POST /push/status: another browser", (await call("POST", "/push/status", { cookie: live, body: { endpoint: laptop.subscription.endpoint } })).data.here, false);
  check("POST /push/status: demo is simply off", (await call("POST", "/push/status", { cookie: demo, body: {} })).data.on, false);
  check("POST /push/status: not set up", (await call("POST", "/push/status", { cookie: live, body: {}, env: { ...ENV, PUSH_SECRET: "" } })).data.configured, false);
}

section("Routes: turning off, and signing out");
{
  await call("POST", "/push/subscribe", { cookie: live, body: { subscription: laptop.subscription } });
  const offOne = await call("DELETE", "/push/subscribe", { cookie: live, body: { endpoint: phone.subscription.endpoint } });
  check("DELETE /push/subscribe: one browser off", [offOne.data.on, offOne.data.devices], [true, 1]);
  check("DELETE /push/subscribe: no endpoint", (await call("DELETE", "/push/subscribe", { cookie: live, body: {} })).status, 400);
  check("DELETE /push/subscribe: another site", (await call("DELETE", "/push/subscribe", { cookie: live, body: { endpoint: laptop.subscription.endpoint }, origin: "https://evil.example" })).status, 403);
  const offLast = await call("DELETE", "/push/subscribe", { cookie: live, body: { endpoint: laptop.subscription.endpoint } });
  check("the last browser off: everything deleted", [offLast.data.on, stores.get("1001")!.storage.data.size, stores.get("1001")!.storage.alarm], [false, 0, null]);

  await call("POST", "/push/subscribe", { cookie: live, body: { subscription: phone.subscription } });
  check("DELETE /push: everything", [(await call("DELETE", "/push", { cookie: live })).data, stores.get("1001")!.storage.data.size], [{ ok: true }, 0]);
  check("DELETE /push: incognito may delete", (await call("DELETE", "/push", { cookie: incognito })).status, 200);
  check("DELETE /push: demo", (await call("DELETE", "/push", { cookie: demo })).status, 403);

  await call("POST", "/push/subscribe", { cookie: live, body: { subscription: phone.subscription } });
  await forgetPush(ENV as any, "1001", API + "/auth/session", storeFor);
  check("forgetPush (sign-out) deletes everything", [stores.get("1001")!.storage.data.size, stores.get("1001")!.storage.alarm], [0, null]);
  const before = stores.size;
  await forgetPush(ENV as any, "__demo__", API + "/auth/session", storeFor);
  check("forgetPush: demo does nothing", stores.size, before);
  await forgetPush(ENV as any, "1001", API + "/auth/session"); // no PUSH binding: a no-op, not an error
  storeThrows = true;
  let threw = false;
  try {
    await quiet(() => forgetPush(ENV as any, "1001", API + "/auth/session", storeFor));
  } catch {
    threw = true;
  }
  storeThrows = false;
  check("forgetPush never throws (sign-out must still work)", threw, false);
}

console.log = realLog;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
