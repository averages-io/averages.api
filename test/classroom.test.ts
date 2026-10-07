/**
 * Tests for the Google Classroom adapters (src/classroom.ts) and the Google
 * sign-in helpers (src/google.ts) that need no network.
 *
 * Run: node --experimental-strip-types test/classroom.test.ts
 *
 * The data below is shaped like Classroom's documented responses; every id,
 * name and token is made up.
 */

import {
  adaptClassroomAssignment,
  adaptClassroomBundle,
  adaptClassroomFiles,
  classroomUrl,
  dayKey,
  driveExt,
  dueMs,
  formatDueIn,
  materialLink,
  overallPct,
  plain,
  safeTimeZone,
  safeUrl,
  type CourseRaw,
} from "../src/classroom.ts";
import {
  CLASSROOM_SCOPES,
  grantedLetters,
  hasRequiredScopes,
  idTokenClaims,
  newSignInState,
  validSignInState,
  authorizationUrl,
  codeChallenge,
  googleConfig,
} from "../src/google.ts";

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

console.log("\ndates and time zones");
// Due Friday Oct 9 2026, 11:59 PM in Los Angeles = Saturday 06:59 UTC.
const lateFriday = { dueDate: { year: 2026, month: 10, day: 10 }, dueTime: { hours: 6, minutes: 59 } };
check("due date + time are UTC", dueMs(lateFriday), Date.UTC(2026, 9, 10, 6, 59));
check("shown in the student's zone (Friday, not Saturday)", formatDueIn(dueMs(lateFriday)!, "America/Los_Angeles"), "Fri Oct 9");
check("UTC shows the UTC day", formatDueIn(dueMs(lateFriday)!, "UTC"), "Sat Oct 10");
check("no time means end of that UTC day", dueMs({ dueDate: { year: 2026, month: 10, day: 9 } }), Date.UTC(2026, 9, 9, 23, 59));
check("no due date is null", dueMs({ title: "x" }), null);
check("a nonsense date is null", dueMs({ dueDate: { year: 2026, month: 13, day: 1 } }), null);
check("day key in a zone", dayKey(Date.UTC(2026, 9, 10, 6, 59), "America/Los_Angeles"), "2026-10-9");
check("half-hour zone: the day changes at local midnight (18:30 UTC in India)", [dayKey(Date.UTC(2026, 9, 9, 18, 29), "Asia/Kolkata"), dayKey(Date.UTC(2026, 9, 9, 18, 31), "Asia/Kolkata")], ["2026-10-9", "2026-10-10"]);
check("45-minute zone (Nepal)", [formatDueIn(Date.UTC(2026, 9, 9, 18, 14), "Asia/Kathmandu"), formatDueIn(Date.UTC(2026, 9, 9, 18, 16), "Asia/Kathmandu")], ["Fri Oct 9", "Sat Oct 10"]);
check("a real zone is kept", safeTimeZone("America/Chicago"), "America/Chicago");
check("an unknown zone falls through to the next", safeTimeZone("Mars/Base", "America/Denver"), "America/Denver");
check("junk falls back to UTC", safeTimeZone("<script>", 42, undefined), "UTC");

console.log("\ntext and links");
check("whitespace collapses, nothing stripped", plain("  Read  <ch. 3>\n\n& answer  ", 100), "Read <ch. 3> & answer");
check("control characters go", plain("a\u0000b\u0007c", 10), "abc");
check("cut by character, not mid-emoji", plain("😀😀😀", 2), "😀😀");
check("https link kept", safeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
check("javascript: link refused", safeUrl("javascript:alert(1)"), "");
check("data: link refused", safeUrl("data:text/html,hi"), "");
check("Turn in link must be Classroom", classroomUrl("https://classroom.google.com/c/abc/a/def/details"), "https://classroom.google.com/c/abc/a/def/details");
check("Turn in link elsewhere refused", classroomUrl("https://classroom.google.com.evil.example/c"), "");
check("Turn in link http refused", classroomUrl("http://classroom.google.com/c/abc"), "");

console.log("\nmaterials");
check("Drive file opens in Drive", materialLink({ driveFile: { driveFile: { id: "1AbCdEfGhIjK", title: "Lab 3.pdf", alternateLink: "https://drive.google.com/open?id=1AbCdEfGhIjK" } } }), { kind: "drive", title: "Lab 3.pdf", url: "https://drive.google.com/open?id=1AbCdEfGhIjK" });
check("YouTube", materialLink({ youtubeVideo: { id: "x", title: "Mitosis", alternateLink: "https://www.youtube.com/watch?v=x" } })?.kind, "youtube");
check("Form", materialLink({ form: { formUrl: "https://docs.google.com/forms/d/e/x/viewform", title: "Quiz 2" } }), { kind: "form", title: "Quiz 2", url: "https://docs.google.com/forms/d/e/x/viewform" });
check("Link with a bad URL is dropped", materialLink({ link: { url: "javascript:alert(1)", title: "x" } }), null);
check("Google Doc type from its link", driveExt("Essay draft", "https://docs.google.com/document/d/abc/edit"), "gdoc");
check("Slides", driveExt("Deck", "https://docs.google.com/presentation/d/abc/edit"), "gslides");
check("Uploaded file keeps its extension", driveExt("Lab 3.PDF", "https://drive.google.com/file/d/abc/view"), "pdf");

console.log("\ngrades");
const items = [
  { earned: 9, possible: 10, category: "hw", at: 1 },
  { earned: 18, possible: 20, category: "hw", at: 2 },
  { earned: 35, possible: 50, category: "test", at: 3 },
];
check("total points", overallPct(items, { calculationType: "TOTAL_POINTS" }), 77.5);
check("no settings = total points", overallPct(items, undefined), 77.5);
const weighted = { calculationType: "WEIGHTED_CATEGORIES", gradeCategories: [{ id: "hw", weight: 400000 }, { id: "test", weight: 600000 }] };
// hw 27/30 = 90% x 40% + test 70% x 60% = 36 + 42 = 78
check("weighted categories", overallPct(items, weighted), 78);
// Only homework graded so far: its weight scales up to 100%.
check("weights of empty categories are left out", overallPct(items.slice(0, 2), weighted), 90);
check("uncategorized work doesn't count in a weighted grade", overallPct([...items, { earned: 0, possible: 100, category: "", at: 4 }], weighted), 78);
check("nothing graded is null", overallPct([], weighted), null);
check("weighted, but only uncategorized work graded: no overall grade (as Classroom)", overallPct([{ earned: 5, possible: 10, category: "", at: 1 }], weighted), null);

console.log("\nbundle");
const NOW = Date.UTC(2026, 9, 7, 18, 0); // Wed Oct 7 2026, 11 AM in Los Angeles
const day = (d: number, h = 6, m = 59) => ({ dueDate: { year: 2026, month: 10, day: d }, dueTime: { hours: h, minutes: m } });
const raw: CourseRaw[] = [
  {
    course: { id: "111", name: "Biology", alternateLink: "https://classroom.google.com/c/MTEx", updateTime: "2026-10-06T10:00:00Z", gradebookSettings: weighted },
    work: [
      { id: "1", title: "Cell worksheet", maxPoints: 10, gradeCategory: { id: "hw" }, ...day(1) },
      { id: "2", title: "Lab report", maxPoints: 20, gradeCategory: { id: "hw" }, ...day(3) },
      { id: "3", title: "Unit test", maxPoints: 50, gradeCategory: { id: "test" }, ...day(5) },
      { id: "4", title: "Missing reading", maxPoints: 5, ...day(6) },
      { id: "5", title: "Due tonight", maxPoints: 10, ...day(8) }, // Oct 7 11:59 PM LA
      { id: "6", title: "Next week", maxPoints: 10, ...day(15) },
      { id: "7", title: "Turned in, not graded", maxPoints: 10, ...day(9) },
      { id: "8", title: "Undated", maxPoints: 10 },
      { id: "bad id", title: "Skipped", ...day(9) },
    ],
    submissions: [
      { courseWorkId: "1", state: "RETURNED", assignedGrade: 9, updateTime: "2026-10-02T00:00:00Z" },
      { courseWorkId: "2", state: "RETURNED", assignedGrade: 18, updateTime: "2026-10-04T00:00:00Z" },
      { courseWorkId: "3", state: "RETURNED", assignedGrade: 35, updateTime: "2026-10-06T00:00:00Z" },
      { courseWorkId: "4", state: "CREATED" },
      { courseWorkId: "5", state: "NEW" },
      { courseWorkId: "6", state: "NEW" },
      { courseWorkId: "7", state: "TURNED_IN", updateTime: "2026-10-07T01:00:00Z" },
    ],
    announcements: [{ id: "a1", text: "Field trip forms\n due Friday!", updateTime: "2026-10-07T15:00:00Z", alternateLink: "https://classroom.google.com/c/MTEx/p/a1" }],
    complete: true,
  },
  {
    course: { id: "222", name: "New elective", updateTime: "2026-10-01T00:00:00Z" },
    work: [],
    submissions: [],
    announcements: [],
    complete: true,
  },
];
const b = adaptClassroomBundle(raw, NOW, "America/Los_Angeles");
check("courses", b.COURSES.map((c) => [c.id, c.name, c.grade, c.pct, c.graded, c.platform]), [["111", "Biology", "C+", 78, true, "classroom"], ["222", "New elective", "—", 0, false, "classroom"]]);
check("course color assigned", /^#[0-9a-f]{6}$/.test(b.COURSES[0].color), true);
check("history: last graded, oldest first", b.HISTORY["111"], { points: [90, 90, 70], dates: ["Oct 1", "Oct 3", "Oct 5"] });
check("overdue: past due and not turned in", b.OVERDUE.map((x) => x.title), ["Missing reading"]);
check("overdue item shape", b.OVERDUE[0], { type: "assignment", title: "Missing reading", courseId: "111", due: "Mon Oct 5", dueAt: "2026-10-06T06:59:00.000Z", id: "4", platform: "classroom" });
check("upcoming: soonest first, turned-in work left out", b.UPCOMING.map((x) => x.title), ["Due tonight", "Next week"]);
check("today, in the student's zone", b.TODAY, [{ title: "Due tonight", courseId: "111", id: "5" }]);
check("submitted", b.SUBMITTED, [{ type: "assignment", title: "Turned in, not graded", courseId: "111", submittedOn: "Tue Oct 6", id: "7", platform: "classroom" }]);
check("announcement as a course update (Classroom has no messages)", [b.MESSAGES, b.COURSE_UPDATES], [[], [{ from: "Announcement", courseId: "111", body: "Field trip forms due Friday!", when: "3h ago", unread: true, id: "a1", link: "https://classroom.google.com/c/MTEx/p/a1" }]]);
check("recent grades, newest first", b.RECENT_GRADES.map((g: any) => [g.title, g.letter, g.pct, g.pts, g.isNew]), [["Unit test", "C-", 70, "35/50", true], ["Lab report", "A-", 90, "18/20", false], ["Cell worksheet", "A-", 90, "9/10", false]]);
// Predicted grade trends down (90, 90, 70 -> 63, a D), and the ungraded class is left out.
check("GPA counts graded classes only", [b.COURSES[0].predicted, b.projectedGPA], ["D", 1]);
check("not partial", b.partial, false);
check("gradebook: weighted categories in the teacher's order, plus uncategorized", (b.GRADEBOOK as any)["111"].categories.map((c: any) => [c.name ?? "", c.weight, c.assignments.map((a: any) => [a.title, a.graded ? `${a.score}/${a.points}` : `-/${a.points}`])]), [
  ["Category", 40, [["Cell worksheet", "9/10"], ["Lab report", "18/20"]]],
  ["Category", 60, [["Unit test", "35/50"]]],
  ["No category", 0, [["Missing reading", "-/5"], ["Due tonight", "-/10"], ["Turned in, not graded", "-/10"], ["Next week", "-/10"], ["Undated", "-/10"]]],
]);
check("gradebook: a class with nothing yet still has an entry", (b.GRADEBOOK as any)["222"], { categories: [{ name: "All work", weight: 100, assignments: [] }] });
check("a test is marked as one for Home's Next test", (await import("../src/classroom.ts")).itemType("Unit 3 Test"), "assessment");
check("a contest isn't a test", (await import("../src/classroom.ts")).itemType("Poetry contest entry"), "assignment");
check("unreadable coursework marks partial", adaptClassroomBundle([{ ...raw[1], work: null }], NOW, "UTC").partial, true);
{
  // Submissions only partly arrived: work with no submission in hand isn't called missing.
  const cut = adaptClassroomBundle([{ ...raw[0], submissions: raw[0].submissions!.filter((s: any) => s.courseWorkId !== "4"), submissionsComplete: false, complete: false }], NOW, "America/Los_Angeles");
  check("incomplete submissions: no false Missing", [cut.OVERDUE.length, cut.partial], [0, true]);
  check("incomplete submissions: future work still listed", cut.UPCOMING.map((x) => x.title), ["Due tonight", "Next week"]);
  const noSubs = adaptClassroomBundle([{ ...raw[0], submissions: null }], NOW, "America/Los_Angeles");
  check("submissions unreadable: nothing called missing, no grade", [noSubs.OVERDUE.length, noSubs.TODAY.length, noSubs.COURSES[0].grade], [0, 0, "—"]);
  const hidden = adaptClassroomBundle([{ ...raw[0], course: { ...raw[0].course, gradebookSettings: { ...weighted, displaySetting: "HIDE_OVERALL_GRADE" } } }], NOW, "America/Los_Angeles");
  check("teacher hid the overall grade: hidden here too, left out of GPA", [hidden.COURSES[0].grade, hidden.COURSES[0].graded, hidden.projectedGPA, hidden.RECENT_GRADES.length], ["—", false, 0, 3]);
}

console.log("\none assignment");
const detail = adaptClassroomAssignment(
  {
    id: "4",
    title: "Missing reading",
    description: "Read chapter 3.\n\nAnswer the questions.",
    maxPoints: 5,
    alternateLink: "https://classroom.google.com/c/MTEx/a/NA/details",
    materials: [
      { driveFile: { driveFile: { id: "1AbCdEfGhIjK", title: "Chapter 3.pdf", alternateLink: "https://drive.google.com/open?id=1AbCdEfGhIjK" } } },
      { link: { url: "javascript:alert(1)", title: "bad" } },
      { link: { url: "https://example.com/reading", title: "Reading" } },
    ],
    ...day(6),
  },
  { state: "CREATED", late: true, alternateLink: "https://classroom.google.com/c/MTEx/a/NA/submissions/by-status/and-sort-first-name/student/X" },
  "111",
  "America/Los_Angeles"
);
check("detail", { ...detail, materials: detail.materials.map((m) => m.kind) }, {
  id: "4",
  sectionId: "111",
  title: "Missing reading",
  description: "Read chapter 3.\n\nAnswer the questions.",
  due: "Mon Oct 5",
  dueAt: "2026-10-06T06:59:00.000Z",
  type: "assignment",
  files: [],
  links: [{ title: "Chapter 3.pdf", url: "https://drive.google.com/open?id=1AbCdEfGhIjK" }, { title: "Reading", url: "https://example.com/reading" }],
  materials: ["drive", "link"],
  platform: "classroom",
  classroomUrl: "https://classroom.google.com/c/MTEx/a/NA/submissions/by-status/and-sort-first-name/student/X",
  submission: { state: "not_turned_in", late: true, grade: null, maxPoints: 5 },
});
check("returned with a grade", adaptClassroomAssignment({ id: "3", maxPoints: 50 }, { state: "RETURNED", assignedGrade: 35 }, "111", "UTC").submission, { state: "returned", late: false, grade: 35, maxPoints: 50 });
check("submission couldn't be read: unknown (the page keeps its status)", adaptClassroomAssignment({ id: "3" }, null, "111", "UTC").submission.state, "unknown");
check("description keeps paragraphs, at most one blank line", adaptClassroomAssignment({ id: "3", description: "a  b\r\n\r\n\r\n\nc\u0007" }, undefined, "111", "UTC").description, "a b\n\nc");
check("no submission: Turn in link falls back to the assignment's", adaptClassroomAssignment({ id: "3", alternateLink: "https://classroom.google.com/c/x/a/y/details" }, undefined, "111", "UTC").classroomUrl, "https://classroom.google.com/c/x/a/y/details");

console.log("\nfiles");
const files = adaptClassroomFiles({
  "111": {
    materials: [
      {
        id: "900",
        title: "Unit 2 notes",
        updateTime: "2026-10-05T00:00:00Z",
        materials: [
          { driveFile: { driveFile: { id: "1NotesDocAbc", title: "Unit 2 notes", alternateLink: "https://docs.google.com/document/d/1NotesDocAbc/edit" } } },
          { link: { url: "https://example.com" } },
        ],
      },
    ],
    work: [
      {
        id: "2",
        title: "Lab report",
        updateTime: "2026-10-03T00:00:00Z",
        materials: [
          { driveFile: { driveFile: { id: "1LabTemplate", title: "Lab template.docx", alternateLink: "https://drive.google.com/file/d/1LabTemplate/view" } } },
          { driveFile: { driveFile: { id: "1LabTemplate", title: "Lab template.docx", alternateLink: "https://drive.google.com/file/d/1LabTemplate/view" } } },
          { driveFile: { driveFile: { id: "../etc", title: "x", alternateLink: "https://drive.google.com/x" } } },
        ],
      },
    ],
  },
  "222": { materials: null, work: [] },
});
check("Drive files only, newest first, no duplicates", files.files.map((f) => [f.name, f.ext, f.kind, f.parent, f.course]), [["Unit 2 notes", "gdoc", "material", "900", "111"], ["Lab template.docx", "docx", "assignment", "2", "111"]]);
check("files carry their Drive link", files.files[0].url, "https://docs.google.com/document/d/1NotesDocAbc/edit");
check("a class that failed marks partial", files.partial, true);

console.log("\nsign-in helpers");
const all = Object.values(CLASSROOM_SCOPES).join(" ") + " openid https://www.googleapis.com/auth/userinfo.email";
check("granted letters (rosters and topics added 2026-10-06)", grantedLetters(all), "cwmart");
check("required present", hasRequiredScopes("cwma"), true);
check("coursework unticked: refused", hasRequiredScopes(grantedLetters(CLASSROOM_SCOPES.c + " " + CLASSROOM_SCOPES.a)), false);
check("letters ignore look-alikes", grantedLetters(CLASSROOM_SCOPES.c + "x " + CLASSROOM_SCOPES.w.toUpperCase()), "");
const s = newSignInState(true);
check("new state is valid", validSignInState(s), true);
check("tampered state shape refused", validSignInState({ ...s, state: "short" }), false);
check("verifier is 64 characters", s.verifier.length, 64);

const CLIENT = "123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com";
check("config needs the secret", googleConfig({ GOOGLE_CLIENT_ID: CLIENT, GOOGLE_REDIRECT_URI: "https://api.averages.io/auth/google/callback" }), null);
check("config refuses another callback", googleConfig({ GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: "x", GOOGLE_REDIRECT_URI: "https://evil.example/auth/google/callback" }), null);
check("config accepts ours", googleConfig({ GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: "x", GOOGLE_REDIRECT_URI: "https://api.averages.io/auth/google/callback" })?.redirectUri, "https://api.averages.io/auth/google/callback");
const url = new URL(await authorizationUrl({ clientId: CLIENT, redirectUri: "https://api.averages.io/auth/google/callback" }, s));
check("consent URL: offline + consent", [url.searchParams.get("access_type"), url.searchParams.get("prompt")], ["offline", "consent select_account"]);
check("consent URL: PKCE", [url.searchParams.get("code_challenge"), url.searchParams.get("code_challenge_method")], [await codeChallenge(s.verifier), "S256"]);
check("consent URL: every Classroom scope, read-only", url.searchParams.get("scope")!.split(" ").filter((x) => x.includes("classroom")).every((x) => x.endsWith(".readonly")), true);

const jwt = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const future = Math.floor(Date.now() / 1000) + 3600;
check("ID token claims", idTokenClaims(jwt({ iss: "https://accounts.google.com", aud: CLIENT, exp: future, sub: "1234567890", email: "s@school.org", name: "Sam\u0007 Student", picture: "https://lh3.googleusercontent.com/a/x" }), CLIENT), { sub: "1234567890", email: "s@school.org", name: "Sam Student", picture: "https://lh3.googleusercontent.com/a/x" });
check("ID token for another app refused", idTokenClaims(jwt({ iss: "https://accounts.google.com", aud: "other", exp: future, sub: "1" }), CLIENT), null);
check("ID token from another issuer refused", idTokenClaims(jwt({ iss: "https://evil.example", aud: CLIENT, exp: future, sub: "1" }), CLIENT), null);
check("non-Google picture dropped", idTokenClaims(jwt({ iss: "accounts.google.com", aud: CLIENT, exp: future, sub: "1", picture: "https://evil.example/x.png" }), CLIENT)?.picture, "");
check("garbage refused", idTokenClaims("not.a.jwt", CLIENT), null);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
