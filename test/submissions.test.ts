/**
 * What the student turned in, on the Files page (2026-10-09): GET
 * /data/submissions and GET /data/submission-file through the real Worker,
 * with Schoology faked, plus the helpers in src/submit.ts they use.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/submissions.test.ts
 *
 * Every id, name, key and token below is made up.
 */
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { DEMO_UID, sealSession, SESSION_COOKIE } from "../src/session.ts";
import {
  findSubmittedFile,
  MAX_SUBMITTED_FILES,
  newestSubmittedFiles,
  SUBMISSION_CALL_BUDGET,
  submittedFiles,
  turnInAssignments,
} from "../src/submit.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

const ME = "1001";
const SECRET = "submissions-test-session-secret";
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const unix = (ms: number) => String(Math.floor(ms / 1000));
/** "YYYY-MM-DD HH:MM:SS", `days` from now (UTC), the way Schoology writes due dates. */
const due = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 19).replace("T", " ");
const DL = (id: string) => `https://api.schoology.com/v1/attachment/${id}/source/x`;
const file = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, type: "file", title, filename: title, filesize: 1234, download_path: DL(id), ...extra });

/* ── helpers ───────────────────────────────────────────────────────────── */
console.log("\nhelpers");
{
  const picked = turnInAssignments({
    "101": [
      { id: 1, title: "Old essay", type: "assignment", allow_dropbox: "1", due: due(-30) },
      { id: 2, title: "Unit test", type: "assessment", allow_dropbox: "1", due: due(-1) },
      { id: 3, title: "Discussion", type: "discussion", due: due(-1) },
      { id: 4, title: "No dropbox", type: "assignment", allow_dropbox: "0", due: due(-1) },
      { id: 5, title: "<b>Lab</b> report", type: "assignment", due: due(-2) },
      { id: 6, title: "Far ahead", type: "assignment", allow_dropbox: 1, due: due(60) },
      { id: 7, title: "Next week", type: "assignment", allow_dropbox: "1", due: due(5) },
      { id: 8, title: "No due date", type: "assignment", last_updated: unix(NOW - 3 * DAY) },
      { id: 9, title: "Quiz", type: "quiz" },
      { id: "abc", title: "Bad id" },
      { id: 10, title: "Further ahead", type: "assignment", due: due(90) },
      { id: 11, title: "New quiz", type: "assessment_v2" },
      { id: 12, title: "Nothing at all" },
      null,
    ],
    "102": null,
    "bad": [{ id: 13, title: "Bad section" }],
  }, NOW);
  check("dropbox work only, most relevant first; far-ahead work last, soonest first", picked.map((a) => a.id), ["7", "5", "8", "1", "12", "6", "10"]);
  check("titles flattened, with their class", [picked[1].title, picked[1].course], ["Lab report", "101"]);
}
{
  const history = {
    revision: [
      { revision_id: 71, uid: ME, created: unix(NOW - DAY), late: 1, draft: 0, attachments: { files: { file: [file("901", "Essay.DOCX"), file("902", "Notes", { extension: "PDF" })] } } },
      { revision_id: 72, uid: ME, created: unix(NOW - 2 * DAY), draft: 1, attachments: { files: { file: file("903", "Draft.pdf") } } },
      { revision_id: 73, uid: "2002", created: unix(NOW), attachments: { files: [file("904", "Someone else.pdf")] } },
      { revision_id: 74, created: unix(NOW - 3 * DAY), attachments: { files: [file("905", "No uid.png")] } },
    ],
  };
  const files = submittedFiles(history, ME, { course: "101", id: "601", title: "Essay" });
  check("own revisions only, drafts left out, newest revision first", files.map((f) => [f.id, f.revision]), [["901", "71"], ["902", "71"], ["905", "74"]]);
  check("a file's entry", files[0], { id: "901", name: "Essay.DOCX", ext: "docx", size: 1234, course: "101", assignment: "601", assignmentTitle: "Essay", revision: "71", at: Math.floor((NOW - DAY) / 1000) * 1000, late: true });
  check("named with the extension Schoology gives, like /data/files", [files[1].name, files[1].ext], ["Notes.pdf", "pdf"]);
  check("no download path in an entry", JSON.stringify(files).includes("download"), false);
  check("findSubmittedFile: the raw download path", findSubmittedFile(history, ME, "71", "902"), { name: "Notes.pdf", downloadPath: DL("902"), size: 1234 });
  check("findSubmittedFile: a bare single file object", findSubmittedFile(history, ME, "72", "903")?.downloadPath, DL("903"));
  check("findSubmittedFile: someone else's revision: null", findSubmittedFile(history, ME, "73", "904"), null);
  check("findSubmittedFile: a file from another revision: null", findSubmittedFile(history, ME, "74", "901"), null);
  check("findSubmittedFile: odd ids: null", [findSubmittedFile(history, ME, "7x", "901"), findSubmittedFile(history, ME, "71", "")], [null, null]);
  check("findSubmittedFile: not a history: null", [findSubmittedFile(null, ME, "71", "901"), findSubmittedFile({ revision: "x" }, ME, "71", "901")], [null, null]);
  const many = Array.from({ length: MAX_SUBMITTED_FILES + 5 }, (_, i) => ({ ...files[0], id: String(5000 + i), at: i }));
  const cut = newestSubmittedFiles(many);
  check("at most 500, newest first, cut said", [cut.files.length, cut.files[0].at, cut.cut, newestSubmittedFiles(files).cut], [500, MAX_SUBMITTED_FILES + 4, true, false]);
}

/* ── fake Schoology ────────────────────────────────────────────────────── */

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const world = {
  sections: [] as any[],
  assignments: {} as Record<string, any[] | number>,
  /** "section/assignment" → history payload or a status. */
  histories: {} as Record<string, any | number>,
};
type Call = { url: URL; auth: string };
const calls: Call[] = [];
let inFlight = 0;
let maxInFlight = 0;

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const auth = new Headers(init.headers).get("Authorization") ?? "";
  calls.push({ url, auth });
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise((r) => setTimeout(r, 1));
    if (url.hostname === "files.schoology.example") {
      if (url.pathname === "/stored/902") return new Response("%PDF-1.4 notes", { status: 200, headers: { "Content-Type": "application/pdf", "Content-Length": "14" } });
      return reply({ error: "x" }, 404);
    }
    if (url.hostname !== "api.schoology.com") return reply({ error: "unexpected host" }, 500);
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === `/users/${ME}/sections`) return typeof world.sections === "number" ? reply({ error: "x" }, world.sections) : reply({ section: world.sections });
    let m = path.match(/^\/sections\/(\d+)\/assignments$/);
    if (m) {
      const a = world.assignments[m[1]];
      return typeof a === "number" ? reply({ error: "x" }, a) : reply({ assignment: a ?? [] });
    }
    m = path.match(/^\/sections\/(\d+)\/submissions\/(\d+)\/(\d+)$/);
    if (m) {
      if (m[3] !== ME) return reply({ error: "not yours" }, 403);
      const h = world.histories[`${m[1]}/${m[2]}`];
      if (h === undefined) return reply({ error: "none" }, 404);
      return typeof h === "number" ? reply({ error: "x" }, h) : reply(h);
    }
    m = path.match(/^\/attachment\/(\d+)\/source\/x$/);
    if (m) {
      // Schoology sends the student on to its file storage.
      if (m[1] === "902") return new Response(null, { status: 302, headers: { Location: "https://files.schoology.example/stored/902" } });
      if (m[1] === "906") return new Response(null, { status: 302, headers: { Location: "http://files.schoology.example/stored/906" } });
      return new Response("PNG bytes", { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return reply({ error: "unexpected" }, 500);
  } finally {
    inFlight--;
  }
}) as typeof fetch;

function resetWorld() {
  world.sections = [
    { id: "101", course_title: "AP Chemistry", section_title: "Period 3" },
    { id: "102", course_title: "English 10" },
    { id: "103", course_title: "Art" },
  ];
  world.assignments = {
    "101": [
      { id: 601, title: "Lab Report", type: "assignment", allow_dropbox: "1", due: due(-1) },
      { id: 602, title: "Unit Test", type: "assessment", allow_dropbox: "1", due: due(-2) },
      { id: 603, title: "Lab Discussion", type: "discussion", due: due(-2) },
      { id: 604, title: "Worksheet", type: "assignment", allow_dropbox: "0", due: due(-2) },
      { id: 605, title: "Problem Set", type: "assignment", allow_dropbox: "1", due: due(-5) },
    ],
    "102": [
      { id: 701, title: "Essay", type: "assignment", allow_dropbox: "1", due: due(-3) },
      { id: 702, title: "Poem", type: "assignment", allow_dropbox: "1", due: due(-4) },
    ],
    "103": [],
  };
  world.histories = {
    "101/601": {
      revision: [
        { revision_id: 81, uid: ME, created: unix(NOW - DAY), late: 0, draft: 0, attachments: { files: { file: [file("901", "Lab Report.PDF"), file("902", "Notes", { extension: "pdf" })] } } },
        { revision_id: 82, uid: ME, created: unix(NOW - 2 * DAY), draft: 1, attachments: { files: { file: [file("903", "Draft.pdf")] } } },
        { revision_id: 83, uid: "2002", created: unix(NOW), attachments: { files: { file: [file("904", "Classmate.pdf")] } } },
        { revision_id: 84, uid: ME, created: unix(NOW - 3 * DAY), attachments: { files: { file: [file("906", "Insecure.pdf"), file("907", "Elsewhere.pdf", { download_path: "https://evil.example/x" })] } } },
      ],
    },
    "101/605": 500,
    "102/701": { revision: { revision_id: 85, uid: ME, created: unix(NOW - 4 * DAY), late: 1, attachments: { files: [file("905", "Essay final.docx")] } } },
    // 102/702: nothing turned in (404)
  };
}

/* ── through the Worker ────────────────────────────────────────────────── */

const ENV: any = { SESSION_SECRET: SECRET };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";
const cookieFor = async (data: Record<string, unknown>) => `${SESSION_COOKIE}=${await sealSession(data as any, SECRET)}`;
const student = await cookieFor({ key: "consumer-key-xyz", secret: "consumer-secret-xyz", uid: ME });
const demo = await cookieFor({ key: "", secret: "", uid: DEMO_UID });
const google = await cookieFor({ key: "", secret: "", uid: "g:109876543210", g: { at: "ya29.test", rt: "1//r", ax: Math.floor(NOW / 1000) + 3600, sc: "cwma", name: "Sam", email: "s@x.example", pic: "" } });

async function call(path: string, cookie?: string) {
  resetRateLimits();
  const headers = new Headers({ "CF-Connecting-IP": "203.0.113.8" });
  if (cookie) headers.set("Cookie", cookie);
  const res = await worker.fetch(new Request(API + path, { headers, redirect: "manual" }), ENV, CTX);
  const type = res.headers.get("Content-Type") ?? "";
  const data: any = type.includes("json") ? await res.clone().json() : null;
  return { res, data };
}
const histories = () => calls.filter((c) => /\/submissions\//.test(c.url.pathname));
const fresh = () => { calls.length = 0; maxInFlight = 0; };

console.log("\nGET /data/submissions");
resetWorld();
{
  fresh();
  const { res, data } = await call("/data/submissions", student);
  check("200, private no-store", [res.status, res.headers.get("Cache-Control")], [200, "private, no-store"]);
  check("platform and courses shaped like /data/files'", [data.platform, data.courses.map((c: any) => Object.keys(c).join(",")), data.courses.map((c: any) => c.name)], ["schoology", ["id,name,color", "id,name,color", "id,name,color"], ["AP Chemistry", "English 10", "Art"]]);
  check("only dropbox assignments asked about", histories().map((c) => c.url.pathname.split("/")[5]).sort(), ["601", "605", "701", "702"]);
  check("the student's own history, with attachments", histories().every((c) => c.url.pathname.endsWith(`/${ME}`) && c.url.searchParams.get("with_attachments") === "1"), true);
  check("own, non-draft files, newest first (then by name)", data.files.map((f: any) => f.id), ["901", "902", "907", "906", "905"]);
  check("an entry", data.files[0], { id: "901", name: "Lab Report.PDF", ext: "pdf", size: 1234, course: "101", assignment: "601", assignmentTitle: "Lab Report", revision: "81", at: Math.floor((NOW - DAY) / 1000) * 1000, late: false });
  check("late carried", data.files.find((f: any) => f.id === "905").late, true);
  check("no download paths or URLs in the answer", /download|https?:/.test(JSON.stringify(data.files)), false);
  check("a history that failed (500): partial; nothing turned in (404) isn't a failure", data.partial, true);
}
{
  world.histories["101/605"] = { revision: [] };
  const { data } = await call("/data/submissions", student);
  check("every history answered (404 = nothing turned in): not partial", data.partial, false);
  world.assignments["103"] = 403;
  check("a class whose assignments didn't load: partial", (await call("/data/submissions", student)).data.partial, true);
  resetWorld();
}
{
  // 12 classes, 10 dropbox assignments each: more than one request may read.
  world.sections = Array.from({ length: 14 }, (_, i) => ({ id: String(200 + i), course_title: `Class ${i}` }));
  world.assignments = Object.fromEntries(world.sections.map((s, i) => [s.id, Array.from({ length: 10 }, (_, j) => ({ id: 3000 + i * 10 + j, title: `Work ${j}`, type: "assignment", allow_dropbox: "1", due: due(-(i * 10 + j)) }))]));
  world.histories = {};
  fresh();
  const { data } = await call("/data/submissions", student);
  const read = histories().map((c) => Number(c.url.pathname.split("/")[5]));
  check("12 classes at most", data.courses.length, 12);
  check(`every Schoology call within the budget (${SUBMISSION_CALL_BUDGET}, under the Free plan's 50)`, calls.length, SUBMISSION_CALL_BUDGET);
  check("the most recent work is read first", Math.max(...read) - Math.min(...read) < 40 && read.includes(3000), true);
  check("at most 6 histories at once", maxInFlight <= 6, true);
  check("cut: partial", data.partial, true);
  resetWorld();
}
{
  // One assignment with more than 500 files.
  world.histories["101/601"] = { revision: Array.from({ length: 11 }, (_, r) => ({ revision_id: 100 + r, uid: ME, created: unix(NOW - r * DAY), attachments: { files: Array.from({ length: 50 }, (_, f) => file(String(10000 + r * 100 + f), `f${f}.txt`)) } })) };
  world.histories["101/605"] = { revision: [] };
  const { data } = await call("/data/submissions", student);
  check("at most 500 files, then partial", [data.files.length, data.partial], [500, true]);
  resetWorld();
}
{
  check("no cookie: 401", (await call("/data/submissions")).res.status, 401);
  check("demo: 403", (await call("/data/submissions", demo)).data, { error: "not_available_in_demo" });
  fresh();
  const g = await call("/data/submissions", google);
  check("Google Classroom: nothing to list, nothing called", [g.res.status, g.data, calls.length], [200, { platform: "classroom", courses: [], files: [], partial: false }, 0]);
  world.sections = 401 as any;
  const down = await call("/data/submissions", student);
  check("sections refused: 502 schoology_error", [down.res.status, down.data.error], [502, "schoology_error"]);
  resetWorld();
}

console.log("\nGET /data/submission-file");
const q = (s: string, a: string, r: string, f: string) => `/data/submission-file?section=${s}&assignment=${a}&revision=${r}&file=${f}`;
{
  fresh();
  const { res } = await call(q("101", "601", "81", "902"), student);
  const body = await res.text();
  check("streamed through, Schoology's redirect followed by hand", [res.status, body, res.headers.get("Content-Type"), res.headers.get("Content-Length")], [200, "%PDF-1.4 notes", "application/pdf", "14"]);
  check("same headers as /data/attachment", [res.headers.get("Content-Disposition"), res.headers.get("Cache-Control"), res.headers.get("X-Content-Type-Options")], [`attachment; filename="Notes.pdf"; filename*=UTF-8''Notes.pdf`, "private, no-store", "nosniff"]);
  check("signed only for api.schoology.com, never for the file store", calls.map((c) => [c.url.hostname, c.auth.startsWith("OAuth ")]), [["api.schoology.com", true], ["api.schoology.com", true], ["files.schoology.example", false]]);
  const direct = await call(q("101", "601", "81", "901"), student);
  check("a file Schoology serves directly", [direct.res.status, direct.res.headers.get("Content-Type"), direct.res.headers.get("Content-Disposition")?.includes('filename="Lab Report.PDF"')], [200, "image/png", true]);
  const unicode = await call(q("102", "701", "85", "905"), student);
  check("named as the list names it", unicode.res.headers.get("Content-Disposition"), `attachment; filename="Essay final.docx"; filename*=UTF-8''Essay%20final.docx`);
}
{
  check("someone else's revision: 404 not_found", (await call(q("101", "601", "83", "904"), student)).data, { error: "not_found" });
  check("a file not in that revision: 404", (await call(q("101", "601", "81", "905"), student)).data, { error: "not_found" });
  check("a revision that isn't there: 404", (await call(q("101", "601", "99", "901"), student)).res.status, 404);
  check("nothing turned in (history 404): 404 not_found", (await call(q("102", "702", "81", "901"), student)).data, { error: "not_found" });
  check("a draft's file is still the student's own", (await call(q("101", "601", "82", "903"), student)).res.status, 200);
  fresh();
  const elsewhere = await call(q("101", "601", "84", "907"), student);
  check("a download path off api.schoology.com: refused, never fetched", [elsewhere.res.status, calls.some((c) => c.url.hostname === "evil.example")], [502, false]);
  const insecure = await call(q("101", "601", "84", "906"), student);
  check("an http redirect: refused", [insecure.res.status, insecure.data.error], [502, "schoology_error"]);
  world.histories["101/601"] = 500;
  check("history fails: 502", (await call(q("101", "601", "81", "901"), student)).res.status, 502);
  resetWorld();
}
{
  for (const [name, path] of [
    ["no section", "/data/submission-file?assignment=601&revision=81&file=901"],
    ["letters in assignment", q("101", "60a", "81", "901")],
    ["no revision", q("101", "601", "", "901")],
    ["a path in file", q("101", "601", "81", "..%2F901")],
    ["21 digits", q("101", "601", "81", "1".repeat(21))],
  ]) {
    fresh();
    const r = await call(path, student);
    check(`${name}: 400 bad_request, Schoology not asked`, [r.res.status, r.data, calls.length], [400, { error: "bad_request" }, 0]);
  }
  check("no cookie: 401", (await call(q("101", "601", "81", "901"))).res.status, 401);
  check("demo: 403", (await call(q("101", "601", "81", "901"), demo)).res.status, 403);
  check("Google Classroom: 404 like /data/attachment", (await call(q("101", "601", "81", "901"), google)).data, { error: "classroom_files_open_in_drive" });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
