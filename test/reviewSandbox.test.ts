/**
 * The reviewer account (2026-10-07): signing in with the REVIEW_KEY /
 * REVIEW_SECRET secrets and using the whole app on reviewSandbox.ts's
 * pretend Schoology, through the real Worker routes. Bundle, assignment,
 * downloads, Files, the per-page extras, messages, turning in, and the
 * integrations (Canva, Sync, notifications) that demo mode refuses.
 *
 * globalThis.fetch is replaced for the whole run: once the reviewer is signed
 * in, any outgoing request at all fails the test (and throws), so nothing
 * about the account can reach api.schoology.com or anywhere else.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/reviewSandbox.test.ts
 */
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { REVIEW_UID, SANDBOX_KEY, SANDBOX_SECRET, resetSandbox, sandboxFetch } from "../src/reviewSandbox.ts";
import { SANDBOX_ZONE } from "../src/reviewSandboxData.ts";
import { SESSION_COOKIE } from "../src/session.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

/* ── No network ────────────────────────────────────────────────────────── */

/**
 * "refusals": the ordinary-key sign-ins below do call Schoology (that's how
 * a wrong key is found out), so a fake Schoology answers 401 to them.
 * "reviewer": nothing may leave the Worker at all.
 */
let phase: "refusals" | "reviewer" = "refusals";
const outgoing: { phase: string; url: string }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  outgoing.push({ phase, url });
  if (phase === "refusals" && new URL(url).hostname === "api.schoology.com") {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`network call during the reviewer test: ${url}`);
}) as typeof fetch;

/* ── Worker plumbing ───────────────────────────────────────────────────── */

const REVIEW_KEY = "review-key-0123456789abcdef";
const REVIEW_SECRET = "review-secret-0123456789abcdef";

/** Sync Across Devices' Durable Object, in memory. */
function fakeSync() {
  const records = new Map<string, string>();
  const ns: any = {
    records,
    jurisdiction: () => ns,
    idFromName: (name: string) => name,
    get: (id: string) => ({
      getRecord: async (key: string) => records.get(`${id}|${key}`) ?? null,
      putRecord: async (key: string, value: string) => void records.set(`${id}|${key}`, value),
      deleteRecord: async () => { for (const k of [...records.keys()]) if (k.startsWith(`${id}|`)) records.delete(k); },
    }),
  };
  return ns;
}

const SYNC = fakeSync();
const ENV: any = { SESSION_SECRET: "review-test-session-secret", REVIEW_KEY, REVIEW_SECRET, SYNC };
const waits: Promise<unknown>[] = [];
const CTX: any = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} };
const API = "https://api.averages.io";

type Init = { method?: string; cookie?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; env?: any };
async function call(path: string, init: Init = {}) {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", "203.0.113.9");
  headers.set("Origin", "https://app.averages.io");
  if (init.cookie) headers.set("Cookie", init.cookie);
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("Content-Type", "application/json");
  }
  const res = await worker.fetch(new Request(API + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" }), init.env ?? ENV, CTX);
  const type = res.headers.get("Content-Type") ?? "";
  const data: any = type.includes("json") ? await res.clone().json() : null;
  return { res, data };
}

/** Today's date in the sandbox's zone, moved `days`, as YYYY-MM-DD. */
function zoneDay(days: number): string {
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: SANDBOX_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date())) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return new Date(Date.UTC(p.year, p.month - 1, p.day + days)).toISOString().slice(0, 10);
}

const TZ = encodeURIComponent(SANDBOX_ZONE);
const CHEM = "7000000001";
const ALG = "7000000002";
const ENG = "7000000003";
const PE = "7000000006";
const LAB4 = "7100000106";
const ESSAY = "7100000307";
resetRateLimits();
resetSandbox();

/* ── Signing in ────────────────────────────────────────────────────────── */
console.log("\nsign-in");
let cookie = "";
{
  phase = "reviewer";
  const { res, data } = await call("/auth/session", { json: { key: REVIEW_KEY, secret: ` ${REVIEW_SECRET} ` } });
  const set = res.headers.get("Set-Cookie") ?? "";
  check("the review secrets sign in", [res.status, data.ok, data.user], [200, true, { uid: REVIEW_UID, name: "Alex Rivera", firstName: "Alex", email: "reviewer@averages.io", pictureUrl: "" }]);
  check("with a session cookie", set.startsWith(`${SESSION_COOKIE}=`) && /HttpOnly/i.test(set), true);
  cookie = set.split(";")[0];
  check("not demo mode", data.demo, undefined);
  check("signing in called nothing outside the Worker", outgoing.length, 0);
}
{
  phase = "refusals";
  const wrong = await call("/auth/session", { json: { key: REVIEW_KEY, secret: "review-secret-wrong-0123456789" } });
  check("wrong secret: 401 (it's just an unknown Schoology key)", [wrong.res.status, wrong.data.error, wrong.res.headers.get("Set-Cookie")], [401, "invalid_credentials", null]);
  const sandboxKey = await call("/auth/session", { json: { key: SANDBOX_KEY, secret: SANDBOX_SECRET } });
  check("the sandbox's own key typed in: 401", [sandboxKey.res.status, sandboxKey.data.error], [401, "invalid_credentials"]);
  const sandboxSecret = await call("/auth/session", { json: { key: REVIEW_KEY, secret: SANDBOX_SECRET } });
  check("the sandbox's own secret typed in: 401", [sandboxSecret.res.status, sandboxSecret.data.error], [401, "invalid_credentials"]);
  const short = await call("/auth/session", { json: { key: "short", secret: "short" }, env: { ...ENV, REVIEW_KEY: "short", REVIEW_SECRET: "short" } });
  check("secrets under 16 characters: the reviewer account is off", [short.res.status, short.data.error], [401, "invalid_credentials"]);
  const unset = await call("/auth/session", { json: { key: REVIEW_KEY, secret: REVIEW_SECRET }, env: { ...ENV, REVIEW_KEY: undefined, REVIEW_SECRET: undefined } });
  check("secrets not set: the reviewer account is off", [unset.res.status, unset.data.error], [401, "invalid_credentials"]);
  check("only the ordinary-key attempts reached (fake) Schoology", outgoing.map((o) => new URL(o.url).pathname), ["/v1/users/me", "/v1/users/me", "/v1/users/me"]);
  outgoing.length = 0;
  phase = "reviewer";
}

/* ── The app's pages ───────────────────────────────────────────────────── */
console.log("\nwho's signed in, the bundle");
{
  const { res, data } = await call("/auth/me", { cookie });
  check("/auth/me", [res.status, data.uid, data.name, data.firstName, data.email, data.provider, data.incognito, data.demo], [200, REVIEW_UID, "Alex Rivera", "Alex", "reviewer@averages.io", "schoology", false, undefined]);
}
{
  const { res, data } = await call(`/data/bundle?tz=${TZ}`, { cookie });
  check("bundle: 200, live (not demo)", [res.status, data.demo, data.error], [200, undefined, undefined]);
  check("six classes, in order", data.COURSES.map((c: any) => c.name), ["AP Chemistry", "Algebra II", "English 10", "U.S. History", "Spanish III", "PE"]);
  check("section ids", data.COURSES.map((c: any) => c.id), ["7000000001", "7000000002", "7000000003", "7000000004", "7000000005", "7000000006"]);
  check("every class has a real grade", data.COURSES.every((c: any) => c.pct > 60 && c.pct <= 100 && /^[A-D][+-]?$/.test(c.grade)), true);
  check("periods and codes", data.COURSES.map((c: any) => [c.period, c.code]), [[1, "CHEM-AP"], [2, "MATH-ALG2"], [3, "ENG10"], [4, "HIST-US"], [5, "SPAN3"], [6, "PE-10"]]);
  check("trends: chemistry up, English down", [data.COURSES[0].trend, data.COURSES[2].trend], ["up", "down"]);
  check("five graded points behind every prediction", Object.values(data.HISTORY).map((h: any) => h.points.length), [5, 5, 5, 5, 5, 5]);
  check("chemistry's scores", data.HISTORY[CHEM].points, [72, 79, 84, 88, 90]);
  const overdue = data.OVERDUE.map((o: any) => o.title);
  // Starts with these three (the quiz due today joins them in the last minute of a Pacific day).
  check("overdue: the three past-due items, oldest first", overdue.slice(0, 3), ["Reading Response", "Chapter 6 Discussion", "Lab Report #4"]);
  check("graded work is never overdue", overdue.some((t: string) => /Lab Report #3|Gas Laws/.test(t)), false);
  check("today: the Algebra II quiz", data.TODAY, [{ title: "Unit 2 Quiz", courseId: ALG, id: "7100000206" }]);
  const upcoming = data.UPCOMING.map((u: any) => u.title);
  check("upcoming: this week and next, soonest first", [upcoming.length >= 10, upcoming.indexOf("Titration Lab Prep") < upcoming.indexOf("Unit 3 Test: Thermochemistry"), upcoming.includes("Practice Set 8")], [true, true, true]);
  const lab4 = data.OVERDUE.find((o: any) => o.title === "Lab Report #4");
  check("an overdue item's shape", [lab4.id, lab4.courseId, lab4.type, lab4.time, typeof lab4.dueAt], [LAB4, CHEM, "assignment", "11:59 PM", "string"]);
  check("types: quiz is an assessment, discussion stays one", [data.UPCOMING.concat(data.OVERDUE).find((x: any) => x.title === "Unit 2 Quiz").type, data.OVERDUE[0].type], ["assessment", "discussion"]);
  check("Home's messages: four teacher threads, senders named", data.MESSAGES.map((m: any) => [m.from, m.unread]), [["Sra. Morales", true], ["Dr. Park", true], ["Ms. Bennett", false], ["Coach Mitchell", false]]);
  check("recent grades: newest first, the fresh one marked new", [data.RECENT_GRADES.length, data.RECENT_GRADES[0].title, data.RECENT_GRADES[0].isNew, data.RECENT_GRADES[0].pts], [10, "Lab Report #3", true, "45/50"]);
  check("a gradebook for every class", Object.keys(data.GRADEBOOK).length, 6);
  check("projected GPA", data.projectedGPA > 2 && data.projectedGPA <= 4, true);
}

console.log("\nassignment, attachments, files");
{
  const { res, data } = await call(`/data/assignment?section=${CHEM}&id=${LAB4}&tz=${TZ}`, { cookie });
  check("assignment: 200", res.status, 200);
  check("its details", [data.id, data.sectionId, data.title, data.type, data.time], [LAB4, CHEM, "Lab Report #4", "assignment", "11:59 PM"]);
  check("description flattened to text", data.description.startsWith("Write up the acid-base titration lab."), true);
  check("two attached files, ids and names only", data.files, [
    { id: "7400000001", name: "Lab Report #4 Instructions", ext: "pdf", size: data.files[0].size },
    { id: "7400000002", name: "Titration Setup", ext: "png", size: data.files[1].size },
  ]);
  check("no download paths reach the browser", JSON.stringify(data).includes("attachment/sandbox"), false);
  check("and a link", data.links, [{ title: "Acid-Base Solutions simulation (PhET)", url: "https://phet.colorado.edu/en/simulations/acid-base-solutions" }]);
  const missing = await call(`/data/assignment?section=${CHEM}&id=7100009999`, { cookie });
  check("an assignment that isn't there: 404", missing.res.status, 404);
}
{
  const { res } = await call(`/data/attachment?section=${CHEM}&assignment=${LAB4}&file=7400000001`, { cookie });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  check("PDF download: 200 application/pdf", [res.status, res.headers.get("Content-Type")], [200, "application/pdf"]);
  check("named for the file, with its length", [res.headers.get("Content-Disposition")?.includes('filename="Lab Report #4 Instructions.pdf"'), res.headers.get("Content-Length")], [true, String(bytes.byteLength)]);
  check("real PDF bytes", [text.startsWith("%PDF-1.4"), text.trimEnd().endsWith("%%EOF"), text.includes("(Lab Report #4: Acid-Base Titration) Tj")], [true, true, true]);
  const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1]);
  check("its cross-reference table is where it says", text.slice(xrefAt, xrefAt + 4), "xref");
}
{
  const { res } = await call(`/data/attachment?section=${CHEM}&assignment=${LAB4}&file=7400000002`, { cookie });
  const bytes = new Uint8Array(await res.arrayBuffer());
  check("PNG download", [res.status, res.headers.get("Content-Type"), Array.from(bytes.slice(0, 8)), bytes.byteLength < 30_000], [200, "image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], true]);
  const doc = await call(`/data/attachment?section=${CHEM}&document=7300000101&file=7400000003`, { cookie });
  check("a Materials document's file", [doc.res.status, doc.res.headers.get("Content-Type"), new TextDecoder().decode(await doc.res.arrayBuffer()).includes("AP Chemistry Syllabus 2026-2027")], [200, "application/pdf", true]);
  const wrongParent = await call(`/data/attachment?section=${ALG}&assignment=${LAB4}&file=7400000001`, { cookie });
  check("a file asked for under the wrong class: refused", wrongParent.res.status, 502);
}
{
  const { res, data } = await call("/data/files", { cookie });
  check("Files: 200, complete", [res.status, data.partial, data.courses.length], [200, false, 6]);
  check("nine files across the classes", data.files.length, 9);
  check("documents and assignment attachments both", [...new Set(data.files.map((f: any) => f.kind))].sort(), ["assignment", "document"]);
  const lab = data.files.find((f: any) => f.id === "7400000001");
  check("an attachment's entry", [lab.name, lab.ext, lab.course, lab.kind, lab.parent, lab.parentTitle], ["Lab Report #4 Instructions.pdf", "pdf", CHEM, "assignment", LAB4, "Lab Report #4"]);
}

console.log("\nper-page extras");
{
  const { res, data } = await call("/data/people", { cookie });
  check("people: one teacher per class", [res.status, data.CONTACTS.length, data.partial, data.courseTeachers[CHEM], data.courseTeachers[PE]], [200, 6, false, "Dr. Park", "Coach Mitchell"]);
  check("no classmates, no reviewer", data.CONTACTS.every((c: any) => /^81\d{8}$/.test(c.id) && c.role === "Teacher"), true);
}
{
  const { res, data } = await call("/data/updates", { cookie });
  check("updates: every class's posts, newest first", [res.status, data.partial, data.COURSE_UPDATES.length, data.COURSE_UPDATES[0].from, data.COURSE_UPDATES[0].courseId], [200, false, 7, "Mr. Okafor", ALG]);
  check("the last day's posts are unread", data.COURSE_UPDATES.filter((u: any) => u.unread).length, 3);
}
{
  const { res, data } = await call(`/data/events?start=${zoneDay(-7)}&end=${zoneDay(30)}`, { cookie });
  const titles = data.EVENTS.map((e: any) => e.title);
  check("calendar: 200, complete", [res.status, data.partial], [200, false]);
  check("assignments, class and school events", ["Lab Report #4", "Unit 2 Quiz", "Spanish Club (Room 302)", "Minimum Day: early dismissal", "Museum field trip"].every((t) => titles.includes(t)), true);
  check("each event once", titles.length, new Set(data.EVENTS.map((e: any) => e.id)).size);
  const quiz = data.EVENTS.find((e: any) => e.title === "Unit 2 Quiz");
  check("an assignment on the calendar", [quiz.date, quiz.time, quiz.source, quiz.type, quiz.assignmentId, quiz.points], [zoneDay(0), "11:59 PM", ALG, "assessment", "7100000206", 50]);
  const school = data.EVENTS.find((e: any) => e.title === "Minimum Day: early dismissal");
  check("a school event", [school.date, school.allDay, school.source], [zoneDay(5), true, "school"]);
  const narrow = await call(`/data/events?start=${zoneDay(0)}&end=${zoneDay(0)}`, { cookie });
  check("the range is respected", narrow.data.EVENTS.map((e: any) => e.title), ["Unit 2 Quiz"]);
  const one = await call(`/data/events?start=${zoneDay(-7)}&end=${zoneDay(30)}&course=${CHEM}`, { cookie });
  check("one class's calendar", [...new Set(one.data.EVENTS.map((e: any) => e.source))], [CHEM]);
}
{
  const { res, data } = await call(`/data/folders?course=${CHEM}`, { cookie });
  check("folders: three, one nested", [res.status, data.partial, data.folders.map((f: any) => [f.title, f.parent])], [200, false, [["Course Info", ""], ["Unit 3: Thermochemistry", ""], ["Lab Handouts", "7500000012"]]]);
  check("what's in them", [data.placement[`assignment:${LAB4}`], data.placement["document:7300000101"], data.placement["assignment:7100000108"], data.placement["assignment:7100000101"]], ["7500000013", "7500000011", "7500000012", undefined]);
  const none = await call(`/data/folders?course=${ENG}`, { cookie });
  check("a class with no folders", [none.res.status, none.data.folders, none.data.partial], [200, [], false]);
}
{
  const { res, data } = await call(`/data/gradebook?course=${CHEM}`, { cookie });
  const cats = data.GRADEBOOK[CHEM].categories;
  check("gradebook: exact categories and weights", [res.status, data.partial, cats.map((c: any) => [c.name, c.weight])], [200, false, [["Tests & Quizzes", 40], ["Labs", 35], ["Homework & Discussions", 25]]]);
  check("graded and upcoming work in them, by date", cats[1].assignments.map((a: any) => [a.title, a.graded, a.score ?? null]), [["Lab Report #4", false, null], ["Lab Report #3", true, 45]]);
  const pe = await call(`/data/gradebook?course=${PE}`, { cookie });
  check("PE counts total points", pe.data.GRADEBOOK[PE].categories.map((c: any) => [c.name, c.weight, c.assignments.length]), [["All work", 100, 6]]);
  const unknown = await call("/data/gradebook?course=7000009999", { cookie });
  check("a class that isn't theirs: 404", unknown.res.status, 404);
}

console.log("\nmessages");
{
  const { res, data } = await call("/messages", { cookie });
  check("conversations: inbox and sent, newest first", [res.status, data.partial, data.me, data.CONVERSATIONS.map((c: any) => [c.subject, c.unread])], [200, false, REVIEW_UID, [
    ["Composición 2 topics", true],
    ["Lab Report #4 rubric", true],
    ["Question about Problem Set 7", false],
    ["Chapter 6 discussion", false],
    ["Fitness test", false],
  ]]);
  check("everyone named", Object.values(data.PEOPLE).map((p: any) => p.name).sort(), ["Coach Mitchell", "Dr. Park", "Mr. Okafor", "Ms. Bennett", "Sra. Morales"]);
  check("the thread the student started is with its teacher", data.CONVERSATIONS[2].personId, "8100000002");
}
{
  const { res, data } = await call(`/messages/thread?id=7800000001&tz=${TZ}`, { cookie });
  check("a thread with replies", [res.status, data.subject, data.participants, data.messages.map((m: any) => m.from)], [200, "Lab Report #4 rubric", ["8100000001"], ["them", "me", "them"]]);
  check("text and time", [data.messages[1].text.startsWith("Thanks Dr. Park!"), /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} · \d{1,2}:\d{2} [AP]M$/.test(data.messages[0].time)], [true, true]);
  const after = await call("/messages", { cookie });
  check("opening it marked it read", after.data.CONVERSATIONS.find((c: any) => c.id === "7800000001").unread, false);
  const sentOnly = await call("/messages/thread?id=7800000005", { cookie });
  check("a thread only in sent", [sentOnly.res.status, sentOnly.data.messages.map((m: any) => m.from)], [200, ["me"]]);
  const nope = await call("/messages/thread?id=7800009999", { cookie });
  check("no such thread: 404", nope.res.status, 404);
}
{
  const { data } = await call("/messages/recipients", { cookie });
  check("recipients: the six teachers", data.recipients.map((r: any) => r.name), ["Coach Mitchell", "Dr. Park", "Mr. Okafor", "Mr. Whitfield", "Ms. Bennett", "Sra. Morales"]);
}
{
  const sent = await call("/messages", { cookie, json: { recipientIds: ["8100000004"], subject: "Field trip form", message: "Hi Mr. Whitfield,\nI turned in my permission slip <today>." } });
  check("send a new message", [sent.res.status, sent.data.ok, /^\d+$/.test(sent.data.id)], [200, true, true]);
  const list = await call("/messages", { cookie });
  const conv = list.data.CONVERSATIONS[0];
  check("it's at the top of the list, with that teacher", [conv.id, conv.subject, conv.personId, list.data.PEOPLE["8100000004"].name], [sent.data.id, "Field trip form", "8100000004", "Mr. Whitfield"]);
  const thread = await call(`/messages/thread?id=${sent.data.id}`, { cookie });
  check("and opens, line breaks and text kept", [thread.data.messages.length, thread.data.messages[0].from, thread.data.messages[0].text], [1, "me", "Hi Mr. Whitfield,\nI turned in my permission slip <today>."]);
  const notAllowed = await call("/messages", { cookie, json: { recipientIds: ["8100000099"], subject: "Hi", message: "Hello" } });
  check("someone not on the recipients list: refused", [notAllowed.res.status, notAllowed.data.error], [403, "recipient_not_allowed"]);
}
{
  const reply = await call("/messages/reply", { cookie, json: { id: "7800000001", message: "Got it, thank you!" } });
  check("reply", [reply.res.status, reply.data.ok], [200, true]);
  const thread = await call("/messages/thread?id=7800000001", { cookie });
  check("the thread shows it last", [thread.data.messages.length, thread.data.messages[3].from, thread.data.messages[3].text], [4, "me", "Got it, thank you!"]);
  const nope = await call("/messages/reply", { cookie, json: { id: "7800009999", message: "Hello?" } });
  check("reply to a thread that isn't there: 404", [nope.res.status, nope.data.error], [404, "not_found"]);
}

console.log("\nturning in");
{
  const file = new TextEncoder().encode("%PDF-1.4\nAlex's lab report\n%%EOF\n");
  const start = await call("/submit/upload", { cookie, json: { section: CHEM, assignment: LAB4, filename: "Lab Report 4 - Alex.pdf", filesize: file.byteLength, md5: "0123456789abcdef0123456789abcdef" } });
  check("start an upload", [start.res.status, typeof start.data.upload, /^\d+$/.test(start.data.fileId)], [200, "string", true]);
  check("the upload location stays on the server", JSON.stringify(start.data).includes("upload/sandbox"), false);
  const put = await call(`/submit/upload/${start.data.upload}`, { method: "PUT", cookie, body: file, headers: { "Content-Type": "application/pdf", "Content-Length": String(file.byteLength) } });
  check("send the bytes", [put.res.status, put.data], [200, { fileId: start.data.fileId }]);
  const attach = await call(`/submit/file?tz=${TZ}`, { cookie, json: { section: CHEM, assignment: LAB4, fileIds: [start.data.fileId] } });
  check("turn it in", [attach.res.status, attach.data.ok, attach.data.revision.late, attach.data.revision.draft, attach.data.revision.files], [200, true, true, false, [{ id: start.data.fileId, name: "Lab Report 4 - Alex.pdf", size: file.byteLength }]]);
  const history = await call(`/submit/history?section=${CHEM}&assignment=${LAB4}&tz=${TZ}`, { cookie });
  check("history shows the new revision", [history.res.status, history.data.revisions.length, history.data.revisions[0].id, history.data.revisions[0].files[0].name], [200, 1, attach.data.revision.id, "Lab Report 4 - Alex.pdf"]);
  const notUploaded = await call("/submit/file", { cookie, json: { section: CHEM, assignment: LAB4, fileIds: ["7900009999"] } });
  check("a file that was never uploaded: refused", [notUploaded.res.status, notUploaded.data.error, notUploaded.data.status], [502, "schoology_error", 400]);
}
{
  const text = await call(`/submit/text?tz=${TZ}`, { cookie, json: { section: ENG, assignment: ESSAY, body: "<p>Schools should start later.</p><script>alert(1)</script>" } });
  check("a text answer", [text.res.status, text.data.ok, text.data.revision.text, text.data.revision.late], [200, true, "Schools should start later.", false]);
  const history = await call(`/submit/history?section=${ENG}&assignment=${ESSAY}`, { cookie });
  check("its history", history.data.revisions.map((r: any) => r.text), ["Schools should start later."]);
  const seeded = await call(`/submit/history?section=${CHEM}&assignment=7100000105`, { cookie });
  check("work turned in before the review shows too", seeded.data.revisions.map((r: any) => r.files.map((f: any) => f.name)), [["Lab Report 3 - Alex Rivera.pdf"]]);
  const none = await call(`/submit/history?section=${ALG}&assignment=7100000207`, { cookie });
  check("nothing turned in yet: empty", none.data.revisions, []);
  const quiz = await call("/submit/text", { cookie, json: { section: ALG, assignment: "7100000206", body: "answer" } });
  check("a quiz takes no submissions", [quiz.res.status, quiz.data.status], [502, 403]);
  const wrongClass = await call("/submit/text", { cookie, json: { section: ALG, assignment: ESSAY, body: "answer" } });
  check("an assignment from another class: 404", wrongClass.res.status, 404);
}

console.log("\nwhat was turned in (Files page, 2026-10-09)");
{
  const { res, data } = await call("/data/submissions", { cookie });
  check("submissions: 200, complete, the six classes", [res.status, data.platform, data.partial, data.courses.length], [200, "schoology", false, 6]);
  check("the file just turned in comes first, then the one from before the review", data.files.map((f: any) => f.name), ["Lab Report 4 - Alex.pdf", "Lab Report 3 - Alex Rivera.pdf"]);
  const just = data.files[0];
  check("its entry", [just.course, just.assignment, just.assignmentTitle, just.ext, just.late, /^\d+$/.test(just.revision), just.at > Date.now() - 60_000], [CHEM, LAB4, "Lab Report #4", "pdf", true, true, true]);
  check("no download paths reach the browser", JSON.stringify(data).includes("attachment/sandbox"), false);

  const dl = await call(`/data/submission-file?section=${CHEM}&assignment=${LAB4}&revision=${just.revision}&file=${just.id}`, { cookie });
  const text = new TextDecoder().decode(await dl.res.arrayBuffer());
  check("it downloads, byte for byte", [dl.res.status, text, dl.res.headers.get("Content-Type")], [200, "%PDF-1.4\nAlex's lab report\n%%EOF\n", "application/pdf"]);
  check("under the name the list shows", dl.res.headers.get("Content-Disposition")?.includes('filename="Lab Report 4 - Alex.pdf"'), true);

  const old = data.files[1];
  const seeded = await call(`/data/submission-file?section=${old.course}&assignment=${old.assignment}&revision=${old.revision}&file=${old.id}`, { cookie });
  const bytes = new Uint8Array(await seeded.res.arrayBuffer());
  check("the earlier one downloads as a PDF of the size the list says", [seeded.res.status, new TextDecoder().decode(bytes.slice(0, 8)), bytes.byteLength, old.size], [200, "%PDF-1.4", old.size, old.size]);
  const wrong = await call(`/data/submission-file?section=${CHEM}&assignment=${LAB4}&revision=${old.revision}&file=${just.id}`, { cookie });
  check("a revision that isn't that assignment's: 404", [wrong.res.status, wrong.data.error], [404, "not_found"]);
  const teacher = await call(`/data/submission-file?section=${CHEM}&assignment=${LAB4}&revision=${just.revision}&file=7400000001`, { cookie });
  check("a teacher's file isn't in the student's turn-ins: 404", teacher.res.status, 404);
}

console.log("\nintegrations aren't refused as demo");
{
  const notDemo = (r: { data: any }) => r.data?.error !== "not_available_in_demo";
  const canva = await call("/canva/status", { cookie });
  check("Canva status: answers (not set up here)", [canva.res.status, canva.data.configured, notDemo(canva)], [200, false, true]);
  const edit = await call("/canva/edit", { cookie, json: { section: CHEM, assignment: LAB4, fileId: "7400000001" } });
  check("Edit in Canva: not configured, not refused", [edit.data.error, notDemo(edit)], ["canva_not_configured", true]);
  const drafts = await call("/canva/drafts", { cookie });
  check("Canva drafts: not refused", notDemo(drafts), true);
  const put = await call("/sync/settings", { method: "PUT", cookie, json: { settings: { theme: "dark" } } });
  check("Sync: saves", [put.res.status, put.data.settings], [200, { theme: "dark" }]);
  const got = await call("/sync/settings", { cookie });
  check("Sync: reads back, stored under the reviewer's uid", [got.res.status, got.data.settings, [...SYNC.records.keys()][0]?.startsWith(REVIEW_UID)], [200, { theme: "dark" }, true]);
  const status = await call("/push/status", { cookie, json: {} });
  check("notifications: status answers", [status.res.status, status.data.configured, notDemo(status)], [200, false, true]);
  const sub = await call("/push/subscribe", { cookie, json: { subscription: {} } });
  check("notifications: not configured here, not refused", [sub.data.error, notDemo(sub)], ["push_not_configured", true]);
}

console.log("\nthe sandbox itself");
{
  check("unknown paths are a JSON 404", [(await sandboxFetch("GET", "https://api.schoology.com/v1/schools/1")).status, (await sandboxFetch("GET", "https://api.schoology.com/v1/schools/1")).headers.get("Content-Type")], [404, "application/json"]);
  check("anything not on api.schoology.com: 404", (await sandboxFetch("GET", "https://example.com/v1/users/me")).status, 404);
  check("other methods: 405", (await sandboxFetch("DELETE", "https://api.schoology.com/v1/messages/7800000001")).status, 405);
  const big = new Uint8Array(4);
  const start = await (await sandboxFetch("POST", "https://api.schoology.com/v1/upload", JSON.stringify({ filename: "a.txt", filesize: 3 }))).json();
  check("an upload with the wrong size is refused", (await sandboxFetch("PUT", start.upload_location, big.buffer)).status, 400);
  for (let i = 0; i < 70; i++) await sandboxFetch("POST", "https://api.schoology.com/v1/messages", JSON.stringify({ subject: `s${i}`, message: "m", recipient_ids: "8100000001" }));
  const sentList = await (await sandboxFetch("GET", "https://api.schoology.com/v1/messages/sent?limit=200")).json();
  check("what's remembered is capped", sentList.message.length <= 50 + 2, true);
  // A turned-in file over 1 MB isn't kept: it downloads as a stand-in PDF.
  const bigFile = new Uint8Array(1024 * 1024 + 1);
  const bigStart = await (await sandboxFetch("POST", "https://api.schoology.com/v1/upload", JSON.stringify({ filename: "big.mov", filesize: bigFile.byteLength }))).json();
  await sandboxFetch("PUT", bigStart.upload_location, bigFile.buffer);
  const bigRev = await (await sandboxFetch("POST", `https://api.schoology.com/v1/sections/${PE}/submissions/7100000606/file`, JSON.stringify({ "file-attachment": { id: [bigStart.id] } }))).json();
  const bigPath = bigRev.attachments.files.file[0].download_path;
  const bigDl = await sandboxFetch("GET", bigPath);
  check("a turned-in file over 1 MB: a stand-in PDF", [bigDl.status, bigDl.headers.get("Content-Type"), (await bigDl.arrayBuffer()).byteLength < 5000], [200, "application/pdf", true]);
  check("an upload never turned in doesn't download", (await sandboxFetch("GET", `https://api.schoology.com/v1/attachment/sandbox/${start.id}`)).status, 404);
  const out = await sandboxFetch("GET", "https://api.schoology.com/v1/users/r%3Areviewer/sections");
  check("an encoded uid in the path still answers", (await out.json()).section.length, 6);
}

// Links are assignment?id=<id> (2026-10-07): the page asks which class it's in.
{
  const found = await call(`/data/assignment/locate?id=${LAB4}`, { cookie });
  check("locate: finds the class and title", [found.res.status, found.data], [200, { section: CHEM, title: "Lab Report #4" }]);
  const none = await call(`/data/assignment/locate?id=7100009999`, { cookie });
  check("locate: unknown id = 404", [none.res.status, none.data.error], [404, "not_found"]);
  const bad = await call(`/data/assignment/locate?id=abc`, { cookie });
  check("locate: not an id = 400", bad.res.status, 400);
}

{
  const out = await call("/auth/session", { method: "DELETE", cookie });
  check("sign out", out.res.status, 200);
  await Promise.all(waits);
}

check("nothing left the Worker while signed in as the reviewer", outgoing.filter((o) => o.phase === "reviewer").map((o) => o.url), []);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
