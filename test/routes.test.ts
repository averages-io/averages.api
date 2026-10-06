/**
 * Route tests for the 2026-10-06 additions, through the real Worker
 * (src/index.ts) with Schoology, Google and the PUSH Durable Object faked:
 * the bundle's new fields, the per-page extras, Schoology messages, sign-out
 * forgetting notifications, schoologyPost, and the rate limits.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/routes.test.ts
 *
 * Every id, name, key and token below is made up.
 */

import app from "../src/index.ts";
import { buildBaseString, hmacSha1, percentEncode } from "../src/oauth.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { schoologyPost, schoologyRequest, SchoologyError } from "../src/schoology.ts";
import { DEMO_UID, sealSession, SESSION_COOKIE } from "../src/session.ts";

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

const SECRET = "routes-test-session-secret";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const unix = (ms: number) => String(Math.floor(ms / 1000));

/* ── Fake PUSH Durable Object (sign-out) ───────────────────────────────── */

const forgotten: string[] = [];
const PUSH = {
  jurisdiction() {
    return PUSH;
  },
  idFromName(name: string) {
    return name;
  },
  get(id: string) {
    return {
      async deleteAll() {
        forgotten.push(id);
      },
    };
  },
};

const ENV: Record<string, unknown> = { SESSION_SECRET: SECRET, PUSH, GOOGLE_CLIENT_ID: "123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "x", GOOGLE_REDIRECT_URI: "https://api.averages.io/auth/google/callback" };
let pending: Promise<unknown>[] = [];
const CTX = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} };
const API = "https://api.averages.io";

async function call(path: string, init: RequestInit & { cookie?: string; ip?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  headers.set("CF-Connecting-IP", init.ip ?? "203.0.113.7");
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (!headers.has("Origin")) headers.set("Origin", "https://app.averages.io");
  }
  return app.fetch(new Request(API + path, { ...init, body, headers, redirect: "manual" }), ENV as any, CTX as any);
}
async function json(res: Response): Promise<any> {
  return res.json();
}

/* ── Fake Schoology and Google ─────────────────────────────────────────── */

type Call = { method: string; host: string; path: string; query: URLSearchParams; auth: string; body: string; contentType: string; url: string };
const calls: Call[] = [];
let inFlight = 0;
let maxInFlight = 0;
const reply = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ME = "1001";
const world = {
  sections: [] as any[],
  grades: [] as any[],
  assignments: {} as Record<string, any[]>,
  inbox: [] as any[],
  sent: [] as any[],
  recipients: [] as any[] | number,
  threads: {} as Record<string, any[]>,
  enrollments: {} as Record<string, any[] | number>,
  updates: {} as Record<string, any[] | number>,
  events: {} as Record<string, any[] | number>,
  userEvents: [] as any[] | number,
  folders: {} as Record<string, any | number>,
  categories: {} as Record<string, any[] | number>,
  posted: [] as { path: string; body: any }[],
};

function resetWorld() {
  world.sections = [
    { id: "101", course_title: "AP Chemistry", course_code: "CHEM-AP", section_title: "Period 3" },
    { id: "102", course_title: "English 10", section_title: "English 10 - Honors" },
  ];
  world.grades = [
    {
      section_id: "101",
      final_grade: [{ grade: 90 }],
      grading_category: [{ id: "c1", title: "Tests" }, { id: "c2", title: "Labs" }],
      period: [{ assignment: [{ assignment_id: 601, grade: 18, max_points: 20, category_id: "c2", timestamp: unix(NOW - 2 * HOUR) }] }],
    },
  ];
  world.assignments = {
    "101": [
      { id: 601, title: "Titration Lab", max_points: 20, grading_category: "c2", due: "2026-10-05 23:59:00" },
      { id: 602, title: "Unit 2 Test", max_points: 50, grading_category: "c1", due: "2099-10-20 08:00:00" },
    ],
    "102": [],
  };
  world.inbox = [{ id: 88, subject: "Lab report", recipient_ids: ME, last_updated: unix(NOW - HOUR), author_id: "5001", message_status: "unread", message: "<p>Nice work</p>" }];
  world.sent = [{ id: 95, subject: "Question", recipient_ids: "5002", last_updated: unix(NOW - 2 * HOUR), author_id: ME, message: "Lunch?" }];
  world.recipients = [{ id: "5001", name: "Mr. Cho", school: "Lincoln", picture_url: "" }, { id: "5002", name: "Ms. Whitfield" }];
  world.threads = {
    "inbox/88": [
      { id: 88, subject: "Lab report", recipient_ids: ME, last_updated: unix(NOW - 3 * HOUR), author_id: "5001", message: "First" },
      { id: 88, subject: "Lab report", recipient_ids: `${ME},7001`, last_updated: unix(NOW - HOUR), author_id: "5001", message: "Nice work" },
    ],
    "sent/95": [{ id: 95, subject: "Question", recipient_ids: "5002", last_updated: unix(NOW - 2 * HOUR), author_id: ME, message: "Lunch?" }],
  };
  world.enrollments = {
    "101": [
      { uid: "5001", name_display: "Mr. Cho", admin: "1", status: "1" },
      // Schoology was asked for admins only; a student slipping through must still never show.
      { uid: "7001", name_display: "Sam Classmate", name_first: "Sam", name_last: "Classmate", admin: "0", status: "1" },
    ],
    "102": 403,
  };
  world.updates = {
    "101": [
      { id: 1, body: "Rubric posted", uid: "5001", created: unix(NOW - 2 * HOUR) },
      { id: 2, body: "anyone have notes?", uid: "7001", created: unix(NOW - HOUR) },
    ],
    "102": [{ id: 3, body: "Read chapter 6", uid: "5009", display_name: "Ms. Park", created: unix(NOW - 3 * HOUR) }],
  };
  world.events = {
    "101": [{ id: 991, title: "Lab Report 4", start: "2026-10-09 15:00:00", all_day: 0, type: "assignment", section_id: "101" }],
    "102": [{ id: 992, title: "Essay", start: "2026-10-10 23:59:00", type: "assignment" }],
  };
  world.userEvents = [{ id: 12, title: "Picture Day", start: "2026-10-12 00:00:00", all_day: 1, type: "event", realm: "school" }];
  world.folders = {
    "101/0": { self: { id: 0 }, "folder-item": [{ id: 77, title: "Unit 1", type: "folder" }, { id: 501, title: "Syllabus", type: "document" }] },
    "101/77": { self: { id: 77 }, "folder-item": [{ id: 601, title: "Titration Lab", type: "assignment" }, { id: 78, title: "Labs", type: "folder" }] },
    "101/78": { "folder-item": [{ id: 502, title: "Lab sheet", type: "document" }] },
    "102/0": 404,
  };
  world.categories = { "101": [{ id: "c1", title: "Tests", weight: 70 }, { id: "c2", title: "Labs", weight: 30 }] };
  world.posted = [];
}

function schoology(method: string, path: string, query: URLSearchParams, body: string): Response {
  const pick = (v: any) => (typeof v === "number" ? reply({ error: "x" }, v) : null);
  if (method === "POST") {
    world.posted.push({ path, body: JSON.parse(body || "null") });
    if (path === "/messages") return reply({ id: 120, subject: "x" }, 201);
    if (/^\/messages\/\d+$/.test(path)) return reply(null, 204);
    return reply({ error: "x" }, 404);
  }
  if (path === `/users/${ME}/sections`) return reply({ section: world.sections });
  if (path === `/users/${ME}/grades`) {
    const only = query.get("section_id");
    return reply({ section: only ? world.grades.filter((g) => g.section_id === only) : world.grades });
  }
  if (path === "/messages/inbox") return reply({ message: world.inbox });
  if (path === "/messages/sent") return reply({ message: world.sent });
  if (path === "/messages/recipients") return pick(world.recipients) ?? reply({ recipients: world.recipients });
  if (path === `/users/${ME}/events`) return pick(world.userEvents) ?? reply({ event: world.userEvents });
  let m = path.match(/^\/messages\/(inbox|sent)\/(\d+)$/);
  if (m) {
    const rows = world.threads[`${m[1]}/${m[2]}`];
    return rows ? reply({ message: rows }) : reply({ error: "not found" }, 404);
  }
  m = path.match(/^\/sections\/(\d+)\/(assignments|enrollments|updates|events|grading_categories)$/);
  if (m) {
    const [, id, what] = m;
    if (what === "assignments") return world.assignments[id] ? reply({ assignment: world.assignments[id] }) : reply({ error: "x" }, 403);
    if (what === "enrollments") return pick(world.enrollments[id]) ?? reply({ enrollment: world.enrollments[id] ?? [] });
    if (what === "updates") return pick(world.updates[id]) ?? reply({ update: world.updates[id] ?? [] });
    if (what === "events") return pick(world.events[id]) ?? reply({ event: world.events[id] ?? [] });
    return pick(world.categories[id]) ?? reply({ grading_category: world.categories[id] ?? [] });
  }
  m = path.match(/^\/courses\/(\d+)\/folder\/(\d+)$/);
  if (m) {
    const f = world.folders[`${m[1]}/${m[2]}`];
    return f === undefined ? reply({ error: "x" }, 404) : pick(f) ?? reply(f);
  }
  return reply({ error: "unexpected" }, 500);
}

const C = "https://classroom.googleapis.com/v1";
function classroom(path: string, query: URLSearchParams): Response {
  const p = path.replace(/^\/v1/, "");
  if (p === "/courses") return reply({ courses: [{ id: "111", name: "Biology", section: "Period 2", room: "214" }] });
  if (p === "/courses/111/teachers") return reply({ teachers: [{ userId: "100000000000000000001", profile: { id: "100000000000000000001", name: { fullName: "Ms. Rivera" } } }] });
  if (p === "/courses/111/courseWork") {
    return reply({
      courseWork: [
        { id: "1", title: "Unit Test", topicId: "5", maxPoints: 50, dueDate: { year: 2026, month: 10, day: 10 }, dueTime: { hours: 6, minutes: 59 } },
        { id: "2", title: "Essay", dueDate: { year: 2026, month: 10, day: 20 }, dueTime: { hours: 18, minutes: 0 } },
      ],
    });
  }
  if (p === "/courses/111/topics") return reply({ topic: [{ topicId: "5", name: "Unit 1" }] });
  if (p === "/courses/111/courseWorkMaterials") return reply({ courseWorkMaterial: [{ id: "950", topicId: "5" }] });
  if (p === "/courses/111/courseWork/-/studentSubmissions") return reply({ studentSubmissions: [] });
  if (p === "/courses/111/announcements") return reply({ announcements: [] });
  return reply({ error: { code: 404 } }, 404);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const body = typeof init.body === "string" ? init.body : "";
  calls.push({ method, host: url.hostname, path: url.pathname.replace(/^\/v1/, ""), query: url.searchParams, auth: headers.get("Authorization") ?? "", body, contentType: headers.get("Content-Type") ?? "", url: url.toString() });
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise((r) => setTimeout(r, 1)); // let calls overlap, like the real thing
    if (url.hostname === "api.schoology.com") return schoology(method, url.pathname.replace(/^\/v1/, ""), url.searchParams, body);
    if (url.href.startsWith(C)) return classroom(url.pathname, url.searchParams);
    return reply({ error: "unexpected host" }, 500);
  } finally {
    inFlight--;
  }
}) as typeof fetch;

function freshCalls() {
  calls.length = 0;
  maxInFlight = 0;
}
const schoologyCalls = () => calls.filter((x) => x.host === "api.schoology.com");

/* ── Sessions ──────────────────────────────────────────────────────────── */

const schoologySession = `${SESSION_COOKIE}=${await sealSession({ key: "consumer-key-xyz", secret: "consumer-secret-xyz", uid: ME }, SECRET)}`;
const demoSession = `${SESSION_COOKIE}=${await sealSession({ key: "", secret: "", uid: DEMO_UID }, SECRET)}`;
const googleSessionWith = async (sc: string) =>
  `${SESSION_COOKIE}=${await sealSession({ key: "", secret: "", uid: "g:109876543210", g: { at: "ya29.test", rt: "1//r", ax: Math.floor(NOW / 1000) + 3600, sc, name: "Sam", email: "s@x.example", pic: "" } } as any, SECRET)}`;
const googleBasic = await googleSessionWith("cwma");
const googleAll = await googleSessionWith("cwmart");

/* ── The bundle ────────────────────────────────────────────────────────── */

console.log("\n/data/bundle (Schoology)");
resetWorld();
resetRateLimits();
freshCalls();
{
  const res = await call("/data/bundle", { cookie: schoologySession });
  const b = await json(res);
  check("200", res.status, 200);
  check("COURSES code / period / section / teacher", b.COURSES.map((c: any) => [c.id, c.code, c.period, c.section, c.teacher]), [["101", "CHEM-AP", 3, "", ""], ["102", "", "", "English 10 - Honors", ""]]);
  check("Home messages: sender named from the recipients list", b.MESSAGES.map((m: any) => [m.from, m.subject]), [["Mr. Cho", "Lab report"]]);
  check("RECENT_GRADES from data already fetched", b.RECENT_GRADES.map((g: any) => [g.title, g.courseId, g.pts, g.letter, g.isNew]), [["Titration Lab", "101", "18/20", "A-", true]]);
  check("GRADEBOOK per course (no weights in the grades payload: All work)", Object.keys(b.GRADEBOOK), ["101", "102"]);
  check("GRADEBOOK rows", b.GRADEBOOK["101"].categories.map((c: any) => [c.name, c.weight, c.assignments.map((a: any) => [a.title, a.graded])]), [["All work", 100, [["Titration Lab", true], ["Unit 2 Test", false]]]]);
  check("no GPA snapshot any more (weekly email removed)", ["gpaVsLastWeek" in b, typeof b.projectedGPA], [false, "number"]);
  const paths = schoologyCalls().map((x) => x.path).sort();
  check("one recipients call; no grading-category or other extra calls", paths, ["/messages/inbox", "/messages/recipients", "/sections/101/assignments", "/sections/102/assignments", `/users/${ME}/grades`, `/users/${ME}/sections`]);
  world.recipients = 403;
  const refusedNames = await json(await call("/data/bundle", { cookie: schoologySession }));
  check("recipients refused: still a bundle, sender is Teacher (never the id)", refusedNames.MESSAGES.map((m: any) => m.from), ["Teacher"]);
  const demo = await call("/data/bundle", { cookie: demoSession });
  check("demo bundle unchanged (not caught by the extras' demo refusal)", [demo.status, (await json(demo)).demo], [200, true]);
}

console.log("\n/data/bundle (Classroom)");
{
  const b = await json(await call("/data/bundle?tz=UTC", { cookie: googleBasic }));
  check("Classroom class: period from section, room as the section line", b.COURSES.map((c: any) => [c.code, c.period, c.section, c.teacher]), [["", 2, "Room 214", ""]]);
  check("section and room are asked for", calls.some((x) => x.path === "/courses" && (x.query.get("fields") ?? "").includes("section,room")), true);
  check("no GPA snapshot", "gpaVsLastWeek" in b, false);
}

/* ── Extras: demo, auth, caching ───────────────────────────────────────── */

console.log("\nextras: who may call them");
resetRateLimits();
{
  const routes = ["/data/people", "/data/updates", "/data/events?start=2026-10-01&end=2026-10-31", "/data/folders?course=101", "/data/gradebook?course=101", "/messages", "/messages/thread?id=88", "/messages/recipients"];
  const demo = await Promise.all(routes.map(async (r) => { const res = await call(r, { cookie: demoSession }); return [res.status, (await json(res)).error]; }));
  check("demo: 403 not_available_in_demo everywhere", demo, routes.map(() => [403, "not_available_in_demo"]));
  const demoPosts = await Promise.all(["/messages", "/messages/reply"].map(async (r) => (await call(r, { method: "POST", cookie: demoSession, json: { id: "88", message: "x" } })).status));
  check("demo can't send", demoPosts, [403, 403]);
  const anon = await Promise.all(routes.map(async (r) => (await call(r)).status));
  check("no session: 401", anon, routes.map(() => 401));
  const res = await call("/data/updates", { cookie: schoologySession });
  check("answers are private, no-store", res.headers.get("Cache-Control"), "private, no-store");
}

/* ── People ────────────────────────────────────────────────────────────── */

console.log("\n/data/people");
resetWorld();
resetRateLimits();
freshCalls();
{
  const res = await call("/data/people", { cookie: schoologySession });
  const p = await json(res);
  const text = JSON.stringify(p);
  check("teachers from admin enrollments", [res.status, p.platform, p.TEACHERS, p.courseTeachers], [200, "schoology", { "5001": { name: "Mr. Cho", course: "101", color: p.TEACHERS["5001"]?.color } }, { "101": "Mr. Cho" }]);
  check("contacts", p.CONTACTS.map((c: any) => [c.id, c.name, c.role, c.dept, c.category, c.courses]), [["5001", "Mr. Cho", "Teacher", "AP Chemistry", "myTeachers", ["101"]]]);
  check("a student's name never leaks (admin = 0)", [text.includes("Sam"), text.includes("Classmate"), text.includes("7001")], [false, false, false]);
  check("a refused class (403) is no names, not partial; needsPermission false", [p.partial, p.needsPermission], [false, false]);
  check("asked Schoology for admins", schoologyCalls().filter((x) => x.path.endsWith("/enrollments")).every((x) => x.query.get("type") === "admin"), true);

  world.enrollments["102"] = 500;
  check("a class that errors: partial", (await json(await call("/data/people", { cookie: schoologySession }))).partial, true);
}
{
  // 14 classes: only the first 12 are read, never more than 3 Schoology calls at once.
  world.sections = Array.from({ length: 14 }, (_, i) => ({ id: String(200 + i), course_title: `Class ${i}` }));
  world.enrollments = {};
  freshCalls();
  await call("/data/people", { cookie: schoologySession });
  const enrollmentCalls = schoologyCalls().filter((x) => x.path.endsWith("/enrollments"));
  check("at most 12 classes, at most 3 calls in flight", [enrollmentCalls.length, maxInFlight <= 3], [12, true]);
}
{
  freshCalls();
  const basic = await json(await call("/data/people", { cookie: googleBasic }));
  check("Classroom without the rosters permission: empty, needsPermission, no Classroom calls", [basic.platform, basic.CONTACTS, basic.needsPermission, calls.length], ["classroom", [], true, 0]);
  const all = await json(await call("/data/people", { cookie: googleAll }));
  check("Classroom with it: the class's teachers", [all.needsPermission, all.courseTeachers, all.CONTACTS.map((c: any) => [c.name, c.dept, c.email])], [false, { "111": "Ms. Rivera" }, [["Ms. Rivera", "Biology", ""]]]);
}

/* ── Updates ───────────────────────────────────────────────────────────── */

console.log("\n/data/updates");
resetWorld();
resetRateLimits();
freshCalls();
{
  const u = await json(await call("/data/updates", { cookie: schoologySession }));
  check("newest first; teacher named from the class's admins; a classmate isn't named", u.COURSE_UPDATES.map((x: any) => [x.id, x.from, x.courseId, x.unread]), [["2", "Classmate", "101", true], ["1", "Mr. Cho", "101", true], ["3", "Ms. Park", "102", true]]);
  check("limit=5 per class; enrollments only for the class whose posts had no name", [schoologyCalls().filter((x) => x.path.endsWith("/updates")).every((x) => x.query.get("limit") === "5"), schoologyCalls().filter((x) => x.path.endsWith("/enrollments")).map((x) => x.path)], [true, ["/sections/101/enrollments"]]);
  check("no student name", JSON.stringify(u).includes("Sam"), false);
  const g = await json(await call("/data/updates", { cookie: googleBasic }));
  check("Classroom: null (the bundle has them)", g, { COURSE_UPDATES: null, partial: false });
}

/* ── Events ────────────────────────────────────────────────────────────── */

console.log("\n/data/events");
resetRateLimits();
freshCalls();
{
  const e = await json(await call("/data/events?start=2026-10-01&end=2026-10-31", { cookie: schoologySession }));
  check("classes plus the student's own calendar, sorted", e.EVENTS.map((x: any) => [x.id, x.source, x.type, x.time ?? "all day", x.assignmentId ?? null]), [
    ["s-991", "101", "assignment", "3:00 PM", "991"],
    ["s-992", "102", "assignment", "11:59 PM", "992"],
    ["s-12", "school", "teacher", "all day", null],
  ]);
  const evCalls = schoologyCalls().filter((x) => x.path.endsWith("/events"));
  check("date range and limit=200 sent to Schoology", evCalls.every((x) => x.query.get("start_date") === "2026-10-01" && x.query.get("end_date") === "2026-10-31" && x.query.get("limit") === "200"), true);
  freshCalls();
  const one = await json(await call("/data/events?start=2026-10-01&end=2026-10-31&course=101", { cookie: schoologySession }));
  check("one class: only its events, one call", [one.EVENTS.map((x: any) => x.id), schoologyCalls().map((x) => x.path)], [["s-991"], ["/sections/101/events"]]);
  const bad = await Promise.all(
    ["", "?start=2026-10-01", "?start=2026-10-01&end=2027-11-06", "?start=2026-10-31&end=2026-10-01", "?start=2026-02-30&end=2026-03-01", "?start=2026-10-01&end=2026-10-31&course=1;2", "?start=2026-10-01&end=2026-10-31&course=../x"].map(async (q) => {
      const res = await call(`/data/events${q}`, { cookie: schoologySession });
      return [res.status, (await json(res)).error];
    })
  );
  check("bad ranges and ids: 400 before any call", bad, [[400, "bad_range"], [400, "bad_range"], [400, "bad_range"], [400, "bad_range"], [400, "bad_range"], [400, "bad_request"], [400, "bad_request"]]);
  const g = await json(await call("/data/events?start=2026-10-01&end=2026-10-31&tz=America/Los_Angeles", { cookie: googleBasic }));
  check("Classroom: dated coursework in the student's zone", g.EVENTS.map((x: any) => [x.id, x.date, x.time, x.type, x.source, x.points ?? null]), [["c-1", "2026-10-09", "11:59 PM", "assessment", "111", 50], ["c-2", "2026-10-20", "11:00 AM", "assignment", "111", null]]);
}

/* ── Folders ───────────────────────────────────────────────────────────── */

console.log("\n/data/folders");
resetRateLimits();
freshCalls();
{
  const f = await json(await call("/data/folders?course=101", { cookie: schoologySession }));
  check("walked from the root, breadth first", f.folders, [{ id: "77", title: "Unit 1", parent: "", color: "" }, { id: "78", title: "Labs", parent: "77", color: "" }]);
  check("placement (root items sit at the top: not listed)", f.placement, { "assignment:601": "77", "document:502": "78" });
  check("course echoed, not partial", [f.course, f.partial], ["101", false]);
  check("folder calls use the section id", schoologyCalls().map((x) => x.path), ["/courses/101/folder/0", "/courses/101/folder/77", "/courses/101/folder/78"]);
  const none = await call("/data/folders?course=102", { cookie: schoologySession });
  check("root 404: no folders, not an error", [none.status, await json(none)], [200, { course: "102", folders: [], placement: {}, partial: false }]);
  check("ids digits only", [(await call("/data/folders?course=../1", { cookie: schoologySession })).status, (await call("/data/folders", { cookie: schoologySession })).status], [400, 400]);

  // A deep tree: at most 40 folders read, 3 at a time.
  // A binary tree of folders: folder n holds folders 2n+1 and 2n+2.
  world.folders = {};
  for (let n = 0; n < 300; n++) world.folders[`101/${n}`] = { "folder-item": [{ id: 2 * n + 1, type: "folder", title: `F${2 * n + 1}` }, { id: 2 * n + 2, type: "folder", title: `F${2 * n + 2}` }] };
  freshCalls();
  const deep = await json(await call("/data/folders?course=101", { cookie: schoologySession }));
  check("at most 40 folder reads, 3 in flight, partial", [schoologyCalls().length, maxInFlight <= 3, deep.partial], [40, true, true]);

  const basic = await json(await call("/data/folders?course=111", { cookie: googleBasic }));
  check("Classroom without the topics permission", basic, { course: "111", folders: [], placement: {}, partial: false, needsPermission: true });
  const topics = await json(await call("/data/folders?course=111", { cookie: googleAll }));
  check("Classroom topics as folders", [topics.folders, topics.placement], [[{ id: "t5", title: "Unit 1", parent: "", color: "" }], { "assignment:1": "t5", "material:950": "t5" }]);
  check("Classroom ids checked", (await call("/data/folders?course=abc", { cookie: googleAll })).status, 400);
}

/* ── Gradebook ─────────────────────────────────────────────────────────── */

console.log("\n/data/gradebook");
resetWorld();
resetRateLimits();
freshCalls();
{
  const g = await json(await call("/data/gradebook?course=101", { cookie: schoologySession }));
  check("exact weights from grading_categories", g.GRADEBOOK["101"].categories.map((c: any) => [c.name, c.weight, c.assignments.map((a: any) => [a.title, a.score ?? null])]), [["Tests", 70, [["Unit 2 Test", null]]], ["Labs", 30, [["Titration Lab", 18]]]]);
  check("three calls: categories, this section's grades, assignments", schoologyCalls().map((x) => x.path + (x.query.get("section_id") ? `?section_id=${x.query.get("section_id")}` : "")).sort(), [`/sections/101/assignments`, `/sections/101/grading_categories`, `/users/${ME}/grades?section_id=101`]);
  world.categories["101"] = 403;
  const fallback = await json(await call("/data/gradebook?course=101", { cookie: schoologySession }));
  check("categories refused: the grades payload's list, not partial", [fallback.GRADEBOOK["101"].categories[0].name, fallback.partial], ["All work", false]);
  check("bad id", (await call("/data/gradebook?course=10a", { cookie: schoologySession })).status, 400);
  check("Classroom: null (the bundle's is exact)", await json(await call("/data/gradebook?course=111", { cookie: googleBasic })), { GRADEBOOK: null, partial: false });
}

/* ── Messages ──────────────────────────────────────────────────────────── */

console.log("\n/messages");
resetWorld();
resetRateLimits();
freshCalls();
{
  const list = await json(await call("/messages", { cookie: schoologySession }));
  check("inbox and sent merged, named", [list.CONVERSATIONS.map((c: any) => [c.id, c.personId, c.unread]), list.PEOPLE, list.me, list.partial], [[["88", "5001", true], ["95", "5002", false]], { "5001": { name: "Mr. Cho" }, "5002": { name: "Ms. Whitfield" } }, ME, false]);
  check("asked for 50 per folder", schoologyCalls().filter((x) => /^\/messages\/(inbox|sent)$/.test(x.path)).every((x) => x.query.get("limit") === "50"), true);

  const thread = await json(await call("/messages/thread?id=88&tz=UTC", { cookie: schoologySession }));
  check("a thread, oldest first; opened from the inbox (marks it read)", [thread.subject, thread.messages.map((m: any) => [m.from, m.text])], ["Lab report", [["them", "First"], ["them", "Nice work"]]]);
  check("no keep_unread", calls.filter((x) => x.path === "/messages/inbox/88").every((x) => !x.query.has("keep_unread")), true);
  const started = await json(await call("/messages/thread?id=95", { cookie: schoologySession }));
  check("a thread only in sent", started.messages.map((m: any) => m.from), ["me"]);
  const missing = await call("/messages/thread?id=77", { cookie: schoologySession });
  check("not in either folder: 404", [missing.status, (await json(missing)).error], [404, "not_found"]);
  check("thread id digits only", [(await call("/messages/thread?id=88;1", { cookie: schoologySession })).status, (await call("/messages/thread", { cookie: schoologySession })).status], [400, 400]);

  const recips = await json(await call("/messages/recipients", { cookie: schoologySession }));
  check("recipients", recips, { recipients: [{ id: "5001", name: "Mr. Cho" }, { id: "5002", name: "Ms. Whitfield" }] });
  world.recipients = 403;
  check("recipients refused: an empty list, not an error", await json(await call("/messages/recipients", { cookie: schoologySession })), { recipients: [] });
  world.recipients = [{ id: "5001", name: "Mr. Cho" }, { id: "5002", name: "Ms. Whitfield" }];

  const g = await call("/messages", { cookie: googleBasic });
  check("Classroom: 404 not_available", [g.status, (await json(g)).error, (await call("/messages", { method: "POST", cookie: googleBasic, json: {} })).status], [404, "not_available", 404]);
}

console.log("\nsending");
resetRateLimits();
{
  world.posted = [];
  freshCalls();
  const sent = await call("/messages", { method: "POST", cookie: schoologySession, json: { recipientIds: ["5001"], subject: "Lab", message: "Hi <b>there</b>\nThanks" } });
  check("sent", [sent.status, await json(sent)], [200, { ok: true, id: "120" }]);
  check("Schoology got the subject, escaped text and the ids", world.posted, [{ path: "/messages", body: { subject: "Lab", message: "Hi &lt;b&gt;there&lt;/b&gt;<br />Thanks", recipient_ids: "5001" } }]);
  const post = calls.find((x) => x.method === "POST")!;
  check("a JSON POST", [post.contentType, post.url], ["application/json", "https://api.schoology.com/v1/messages"]);
  // The OAuth signature covers method, URL and query only (not a JSON body); recompute it.
  const params = Object.fromEntries([...post.auth.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2])]));
  const { oauth_signature: sig, realm: _realm, ...oauth } = params;
  const expected = await hmacSha1(`${percentEncode("consumer-secret-xyz")}&`, buildBaseString("POST", new URL(post.url), oauth));
  check("signed as POST with the student's key", [oauth.oauth_consumer_key, sig === expected], ["consumer-key-xyz", true]);

  world.posted = [];
  const stranger = await call("/messages", { method: "POST", cookie: schoologySession, json: { recipientIds: ["5001", "9999"], subject: "Hi", message: "x" } });
  check("someone not in the student's recipients: 403, nothing sent", [stranger.status, (await json(stranger)).error, world.posted.length], [403, "recipient_not_allowed", 0]);
  world.recipients = 403;
  const unlisted = await call("/messages", { method: "POST", cookie: schoologySession, json: { recipientIds: ["5001"], subject: "Hi", message: "x" } });
  check("recipients can't be read: refused (502), nothing sent", [unlisted.status, world.posted.length], [502, 0]);
  world.recipients = [{ id: "5001", name: "Mr. Cho" }, { id: "5002", name: "Ms. Whitfield" }];

  const bad = async (body: unknown) => {
    const res = await call("/messages", { method: "POST", cookie: schoologySession, json: body });
    return [res.status, (await json(res)).error];
  };
  check("validation", [
    await bad({ recipientIds: ["5001"], subject: "s".repeat(201), message: "m" }),
    await bad({ recipientIds: ["5001"], subject: "s", message: "m".repeat(10001) }),
    await bad({ recipientIds: Array.from({ length: 21 }, (_, i) => String(5000 + i)), subject: "s", message: "m" }),
    await bad({ recipientIds: ["50a1"], subject: "s", message: "m" }),
    await bad({ recipientIds: ["5001"], subject: "", message: "m" }),
  ], [[400, "subject_too_long"], [400, "message_too_long"], [400, "bad_recipients"], [400, "bad_recipients"], [400, "empty_subject"]]);
  check("nothing posted for any of them", world.posted.length, 0);

  const foreign = await call("/messages", { method: "POST", cookie: schoologySession, json: { recipientIds: ["5001"], subject: "s", message: "m" }, headers: { Origin: "https://evil.example" } });
  check("another site: 403 forbidden_origin", [foreign.status, (await json(foreign)).error], [403, "forbidden_origin"]);
  const form = await call("/messages", { method: "POST", cookie: schoologySession, body: "recipientIds=5001", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  check("not JSON: 415", form.status, 415);

  resetRateLimits(); // the checks above used up this minute's 10 sends
  world.posted = [];
  const replied = await call("/messages/reply", { method: "POST", cookie: schoologySession, json: { id: "88", message: "Thanks!", recipientIds: ["9999"], subject: "ignored" } });
  check("reply ok", [replied.status, await json(replied)], [200, { ok: true }]);
  check("reply goes to the thread's own participants and subject (never the browser's)", world.posted, [{ path: "/messages/88", body: { subject: "Lab report", message: "Thanks!", recipient_ids: "5001,7001" } }]);
  const gone = await call("/messages/reply", { method: "POST", cookie: schoologySession, json: { id: "77", message: "x" } });
  check("reply to a thread that isn't there: 404", gone.status, 404);
  check("reply validation", [(await call("/messages/reply", { method: "POST", cookie: schoologySession, json: { id: "8 8", message: "x" } })).status, (await call("/messages/reply", { method: "POST", cookie: schoologySession, json: { id: "88", message: "" } })).status], [400, 400]);
}

/* ── schoologyPost / schoologyRequest ──────────────────────────────────── */

console.log("\nschoologyPost");
{
  const creds = { key: "k", secret: "s" };
  const saved = globalThis.fetch;
  let answer: Response = reply({ id: 5 }, 201);
  let seen: RequestInit = {};
  globalThis.fetch = (async (_input: any, init: RequestInit = {}) => {
    seen = init;
    return answer;
  }) as typeof fetch;
  check("JSON answer", await schoologyPost("/upload", creds, { filename: "a.pdf" }), { id: 5 });
  check("body sent as JSON, redirects not followed", [seen.method, seen.body, seen.redirect], ["POST", '{"filename":"a.pdf"}', "manual"]);
  answer = new Response(null, { status: 204 });
  check("204: null", await schoologyPost("/x", creds, {}), null);
  answer = new Response(null, { status: 303, headers: { Location: "https://api.schoology.com/v1/x/1" } });
  check("303: done, null (not followed as a GET)", await schoologyRequest("PUT", "/x", creds, {}), null);
  answer = reply({ error: "nope" }, 403);
  let error: unknown = null;
  await schoologyPost("/x", creds, {}).catch((e) => (error = e));
  check("an error status is a SchoologyError with it", [error instanceof SchoologyError, (error as SchoologyError)?.status], [true, 403]);
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  error = null;
  await schoologyPost("/x", creds, {}).catch((e) => (error = e));
  check("unreachable: 503", (error as SchoologyError)?.status, 503);
  globalThis.fetch = saved;
}

/* ── Sign-out forgets notifications ────────────────────────────────────── */

console.log("\nsign-out");
resetRateLimits();
{
  forgotten.length = 0;
  pending = [];
  const out = await call("/auth/session", { method: "DELETE", cookie: schoologySession });
  await Promise.all(pending);
  check("signed out, and the student's PushStore emptied", [out.status, forgotten], [200, [ME]]);
  forgotten.length = 0;
  pending = [];
  await call("/auth/session", { method: "DELETE", cookie: demoSession });
  await call("/auth/session", { method: "DELETE" });
  await Promise.all(pending);
  check("demo or no session: nothing to forget", forgotten, []);
  const { PUSH: _p, ...noPush } = ENV;
  const res = await app.fetch(new Request(API + "/auth/session", { method: "DELETE", headers: { Cookie: schoologySession } }), noPush as any, CTX as any);
  await Promise.all(pending);
  check("without the PUSH binding sign-out still works", res.status, 200);
  check("push routes are mounted", (await call("/push/config")).status, 200);
}

/* ── Login CSRF (2026-10-06 review) ───────────────────────────────────── */

console.log("\nsign-in only from our app");
{
  const evil = await call("/auth/session", { method: "POST", body: JSON.stringify({ key: "k", secret: "s" }), headers: { "Content-Type": "text/plain", Origin: "https://evil.example" }, ip: "198.51.100.40" });
  check("another site's form: refused, no cookie", [evil.status, evil.headers.get("Set-Cookie")], [403, null]);
  const plain = await call("/auth/session", { method: "POST", body: JSON.stringify({ key: "k", secret: "s" }), headers: { "Content-Type": "text/plain" }, ip: "198.51.100.41" });
  check("not JSON: 415, no cookie", [plain.status, plain.headers.get("Set-Cookie")], [415, null]);
  const ours = await call("/auth/session", { method: "POST", json: {}, ip: "198.51.100.42" });
  check("our app's JSON still reaches the checks (missing key: 400)", ours.status, 400);
}

/* ── Rate limits on the real Worker ────────────────────────────────────── */

console.log("\nrate limits");
resetRateLimits();
{
  const statuses: number[] = [];
  for (let i = 0; i < 91; i++) statuses.push((await call("/data/updates", { cookie: googleBasic })).status);
  const limited = await call("/data/updates", { cookie: googleBasic });
  check("/data/*: 90 a minute per student, then 429", [statuses.slice(0, 90).every((s) => s === 200), statuses[90], limited.status, (await json(limited)).error], [true, 429, 429, "rate_limited"]);
  check("Retry-After, readable by the app (CORS)", [Number(limited.headers.get("Retry-After")) > 0, (await call("/data/updates", { cookie: googleBasic, headers: { Origin: "https://app.averages.io" } })).headers.get("Access-Control-Expose-Headers")], [true, "Retry-After,Content-Disposition"]);
  check("the same student signed in again (another cookie) is still limited", (await call("/data/updates", { cookie: googleAll })).status, 429);
  check("a different student isn't", (await call("/data/bundle", { cookie: schoologySession })).status, 200);
  const preflight = await app.fetch(new Request(API + "/data/updates", { method: "OPTIONS", headers: { Origin: "https://app.averages.io", "Access-Control-Request-Method": "GET", Cookie: googleBasic } }), ENV as any, CTX as any);
  check("preflights never limited", preflight.status, 204);
  check("GET / never limited", (await call("/")).status, 200);

  resetRateLimits();
  const sends: number[] = [];
  for (let i = 0; i < 11; i++) sends.push((await call("/messages", { method: "POST", cookie: schoologySession, json: { recipientIds: [] } })).status);
  check("POST /messages*: 10 a minute, then 429", [sends.slice(0, 10).every((s) => s === 400), sends[10]], [true, 429]);

  resetRateLimits();
  const signins: number[] = [];
  for (let i = 0; i < 31; i++) signins.push((await call("/auth/session", { method: "POST", json: {}, ip: "198.51.100.20" })).status);
  check("sign-in: 30 a minute per IP, then 429; another IP is fine", [signins.slice(0, 30).every((s) => s === 400), signins[30], (await call("/auth/session", { method: "POST", json: {}, ip: "198.51.100.21" })).status], [true, 429, 400]);
}

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
