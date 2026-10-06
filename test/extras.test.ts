/**
 * Tests for the per-page extras' adapters (src/extras.ts) and the bundle
 * additions in src/adapt.ts and src/classroom.ts (2026-10-06): course code,
 * period and section; Schoology RECENT_GRADES and GRADEBOOK; Home's message
 * senders; people, updates, events, folders and gradebook.
 *
 * Run: node --experimental-strip-types test/extras.test.ts
 *
 * Payloads are shaped like Schoology's and Classroom's documented responses;
 * every id and name is made up.
 */

import {
  adaptCourses,
  adaptMessages,
  adaptRecentGrades,
  adaptSchoologyGradebook,
  parsePeriod,
  sectionLabel,
} from "../src/adapt.ts";
import { adaptClassroomBundle, classroomSection, type CourseRaw } from "../src/classroom.ts";
import {
  adaptClassroomEvents,
  adaptClassroomFolders,
  adaptPeople,
  adaptSchoologyEvents,
  adaptUpdates,
  classroomTeacherRows,
  localDateTime,
  MAX_RANGE_DAYS,
  parseFolder,
  parseRange,
  refused,
  runPool,
  schoologyEvent,
  teacherRows,
} from "../src/extras.ts";
import { SchoologyError } from "../src/schoology.ts";

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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 6, 18, 0); // Tue Oct 6 2026, 18:00 UTC
const unix = (ms: number) => String(Math.floor(ms / 1000));

/* ── Period and section ────────────────────────────────────────────────── */

console.log("\nperiod parsing");
check("Period 3", parsePeriod("Period 3"), 3);
check("P3", parsePeriod("P3"), 3);
check("Pd 3 / Pd. 3", [parsePeriod("Pd 3"), parsePeriod("Pd. 3")], [3, 3]);
check("Per 4", parsePeriod("English 10 - Per 4"), 4);
check("3rd Period", parsePeriod("3rd Period"), 3);
check("Period 03 and P10", [parsePeriod("Period 03"), parsePeriod("P10")], [3, 10]);
check("Period 0 (zero period)", parsePeriod("Period 0"), 0);
check("letter after the number is fine: Period 3A", parsePeriod("Period 3A"), 3);
check("not a period: AP3, Physics 1, P123, Room 214", [parsePeriod("AP3"), parsePeriod("Physics 1"), parsePeriod("P123"), parsePeriod("Room 214")], ["", "", "", ""]);
check("nothing given", [parsePeriod(undefined), parsePeriod("")], ["", ""]);

console.log("\nsection label");
check("just the period: empty", [sectionLabel("Period 3", "Biology"), sectionLabel("P3", "Biology"), sectionLabel("3rd Period", "Biology")], ["", "", ""]);
check("more than the period: kept whole", sectionLabel("Period 3 - Honors", "Biology"), "Period 3 - Honors");
check("only the course's own name again: empty", sectionLabel("biology", "Biology"), "");
check("plain text (tags and entities)", sectionLabel("<b>Honors</b> &amp; AP", "Biology"), "Honors & AP");
check("Classroom: section text, else the room", [classroomSection("Period 2", "214", "Bio"), classroomSection("Honors", "214", "Bio"), classroomSection("", "Gym", "PE"), classroomSection("", "", "PE")], ["Room 214", "Honors", "Gym", ""]);

console.log("\nCOURSES code / period / section / teacher (Schoology)");
{
  const { COURSES } = adaptCourses(
    [
      { id: 101, course_title: "AP Chemistry", course_code: "CHEM-AP", section_title: "Period 3" },
      { id: 102, course_title: "Algebra II", section_title: "Algebra II", section_code: "P5" },
      { id: 103, course_title: "Journalism", section_title: "Yearbook Staff" },
      { id: 104, course_title: "PE" },
    ],
    []
  );
  check(
    "fields on every course, never undefined",
    COURSES.map((c) => [c.code, c.period, c.section, c.teacher]),
    [
      ["CHEM-AP", 3, "", ""],
      ["", 5, "", ""],
      ["", "", "Yearbook Staff", ""],
      ["", "", "", ""],
    ]
  );
}

/* ── Home: RECENT_GRADES, GRADEBOOK, message senders ───────────────────── */

const grades = [
  {
    section_id: "101",
    final_grade: [{ grade: 88 }],
    grading_category: [
      { id: "c1", title: "Tests", weight: 60 },
      { id: "c2", title: "Labs", weight: 40 },
    ],
    period: [
      {
        assignment: [
          { assignment_id: 601, grade: 18, max_points: 20, category_id: "c2", timestamp: unix(NOW - 2 * HOUR) },
          { assignment_id: 602, grade: 45, max_points: 50, category_id: "c1", timestamp: unix(NOW - 3 * DAY) },
          // Excused: never a score.
          { assignment_id: 603, grade: 0, max_points: 10, category_id: "c2", exception: 1, timestamp: unix(NOW - HOUR) },
          // A score for work not in the assignments list (no title known).
          { assignment_id: 699, grade: 7.5, max_points: 10, category_id: "c2", timestamp: unix(NOW - 4 * DAY) },
        ],
      },
    ],
  },
  // A class beyond the 12 whose assignments the bundle reads: no titles, not listed.
  { section_id: "999", period: [{ assignment: [{ assignment_id: 1, grade: 10, max_points: 10, timestamp: unix(NOW) }] }] },
];
const assignmentsBySection = {
  "101": [
    { id: 601, title: "Titration <b>Lab</b>", max_points: 20, grading_category: "c2", due: "2026-10-05 23:59:00" },
    { id: 602, title: "Unit 2 Test", max_points: 50, grading_category: "c1", due: "2026-10-02 08:00:00" },
    { id: 603, title: "Safety Quiz", max_points: 10, grading_category: "c2", due: "2026-10-04 08:00:00" },
    { id: 604, title: "Lab Report 5", max_points: 20, grading_category: "c2", due: "2026-10-20 23:59:00" },
    { id: 605, title: "Practice (not counted)", max_points: 10, grading_category: "c1", count_in_grade: "0" },
    { id: 606, title: "Hidden draft", max_points: 10, published: 0 },
    { id: 607, title: "Ungraded reading", max_points: 0 },
  ],
};

console.log("\nRECENT_GRADES (Schoology)");
{
  const recent = adaptRecentGrades(grades, assignmentsBySection, NOW);
  check(
    "newest first, titles from the assignments, excused and untitled left out",
    recent.map((g) => [g.title, g.courseId, g.pct, g.letter, g.pts, g.when, g.isNew, g.id]),
    [
      ["Titration Lab", "101", 90, "A-", "18/20", "2h ago", true, "601"],
      ["Unit 2 Test", "101", 90, "A-", "45/50", "3d ago", false, "602"],
    ]
  );
  const many = adaptRecentGrades(
    [{ section_id: "1", period: [{ assignment: Array.from({ length: 15 }, (_, i) => ({ assignment_id: i + 1, grade: 5, max_points: 10, timestamp: unix(NOW - i * HOUR) })) }] }],
    { "1": Array.from({ length: 15 }, (_, i) => ({ id: i + 1, title: `Work ${i + 1}` })) },
    NOW
  );
  check("at most 10", [many.length, many[0].title], [10, "Work 1"]);
}

console.log("\nGRADEBOOK (Schoology)");
{
  const book = adaptSchoologyGradebook({ categories: null, gradeEntry: grades[0], assignments: assignmentsBySection["101"] });
  check(
    "weighted categories from the grades payload, work oldest first, scores where real",
    book.categories.map((c) => [c.name, c.weight, c.assignments.map((a) => [a.title, a.score ?? null, a.points, a.graded, a.id])]),
    [
      ["Tests", 60, [["Unit 2 Test", 45, 50, true, "602"]]],
      [
        "Labs",
        40,
        [
          ["Assignment", 7.5, 10, true, "699"],
          ["Safety Quiz", null, 10, false, "603"],
          ["Titration Lab", 18, 20, true, "601"],
          ["Lab Report 5", null, 20, false, "604"],
        ],
      ],
    ]
  );
  const exact = adaptSchoologyGradebook({
    categories: [
      { id: "c2", title: "Labs &amp; Projects", weight: "35.5", delta: 2 },
      { id: "c1", title: "Tests", weight: "64.5", delta: 1 },
    ],
    gradeEntry: grades[0],
    assignments: [...assignmentsBySection["101"], { id: 700, title: "Extra", max_points: 5, grading_category: "c9" }],
  });
  check("exact categories: names, weights, the teacher's order, and No category", exact.categories.map((c) => [c.name, c.weight, c.assignments.length]), [["Tests", 64.5, 1], ["Labs & Projects", 35.5, 4], ["No category", 0, 1]]);
  const totalPoints = adaptSchoologyGradebook({ categories: [{ id: "c1", title: "Tests", weight: 0 }], gradeEntry: undefined, assignments: [{ id: 1, title: "Quiz", max_points: 10 }] });
  check("no weights: one All work group at 100", totalPoints.categories.map((c) => [c.name, c.weight, c.assignments.map((a) => [a.title, a.graded])]), [["All work", 100, [["Quiz", false]]]]);
  check("nothing at all", adaptSchoologyGradebook({ categories: null, gradeEntry: undefined, assignments: [] }), { categories: [{ name: "All work", weight: 100, assignments: [] }] });
}

console.log("\nHome's message senders");
{
  const inbox = [
    { id: 88, subject: "Lab", message: "See you", author_id: "5001", message_status: "unread", last_updated: unix(Date.now() - HOUR) },
    { id: 89, subject: "Hi", message: "x", author_id: "5002" },
  ];
  const named = adaptMessages(inbox, new Map([["5001", "Mr. Cho"]]));
  check("named from the recipients list, else Teacher: never the raw id", named.map((m) => m.from), ["Mr. Cho", "Teacher"]);
  check("no list at all: Teacher", adaptMessages(inbox).map((m) => m.from), ["Teacher", "Teacher"]);
}

console.log("\nClassroom courses carry the new fields too");
{
  const raw: CourseRaw[] = [
    { course: { id: "111", name: "Biology", section: "Period 2", room: "214" }, work: [], submissions: [], announcements: [], complete: true },
  ];
  const b = adaptClassroomBundle(raw, NOW, "UTC");
  check("code, period, section, teacher", [b.COURSES[0].code, b.COURSES[0].period, b.COURSES[0].section, b.COURSES[0].teacher], ["", 2, "Room 214", ""]);
}

/* ── People ────────────────────────────────────────────────────────────── */

console.log("\npeople");
{
  const enrollments = [
    { uid: "5001", name_display: "Mr. Cho", admin: "1", status: "1" },
    { uid: "7001", name_display: "Sam Classmate", name_first: "Sam", name_last: "Classmate", admin: "0", status: "1" },
    { uid: "7002", name_display: "Riley Student", admin: 0 },
    { uid: "5003", name_first: "Dana", name_last: "Lee", admin: 1 },
    { uid: "5004", name_display: "Former Teacher", admin: "1", status: "5" },
    { uid: "1001", name_display: "Me Myself", admin: "1" },
    { uid: "../x", name_display: "Bad Id", admin: "1" },
  ];
  const teachers = teacherRows(enrollments, "1001");
  check("admins only (never students), active, not the student, ids digits only", teachers, [
    { id: "5001", name: "Mr. Cho" },
    { id: "5003", name: "Dana Lee" },
  ]);
  check("no student name anywhere in the result", JSON.stringify(teachers).includes("Classmate") || JSON.stringify(teachers).includes("Riley"), false);

  const courses = [
    { id: "101", name: "English 10", color: "#6b8f5e" },
    { id: "102", name: "Journalism", color: "#a67a22" },
    { id: "103", name: "Chemistry", color: "#5b6ea3" },
    { id: "104", name: "Art", color: "#8a6ba1" },
  ];
  const people = adaptPeople("schoology", courses, {
    "101": [{ id: "5001", name: "Mr. Cho" }, { id: "5003", name: "Dana Lee" }, { id: "5009", name: "Third" }],
    "102": [{ id: "5001", name: "Mr. Cho" }],
    "103": null,
    "104": [],
  });
  check("TEACHERS keyed by id, first class's color", people.TEACHERS, {
    "5001": { name: "Mr. Cho", course: "101", color: "#6b8f5e" },
    "5003": { name: "Dana Lee", course: "101", color: "#6b8f5e" },
    "5009": { name: "Third", course: "101", color: "#6b8f5e" },
  });
  check("a teacher of two classes is one contact with both in dept", people.CONTACTS[0], {
    id: "5001", name: "Mr. Cho", role: "Teacher", dept: "English 10, Journalism", school: "", email: "", phone: "", color: "#6b8f5e", category: "myTeachers", courses: ["101", "102"],
  });
  check("courseTeachers: up to two names", people.courseTeachers, { "101": "Mr. Cho, Dana Lee", "102": "Mr. Cho" });
  check("a class that failed: partial; refused (empty): not", [people.partial, people.needsPermission, people.platform], [true, false, "schoology"]);

  check("Classroom teacher rows", classroomTeacherRows([
    { userId: "100000000000000000001", profile: { id: "100000000000000000001", name: { fullName: "Ms. Rivera" } } },
    { userId: "bad" },
    { profile: { id: "100000000000000000002", name: {} } },
  ]), [{ id: "100000000000000000001", name: "Ms. Rivera" }, { id: "100000000000000000002", name: "Teacher" }]);
}

/* ── Updates ───────────────────────────────────────────────────────────── */

console.log("\ncourse updates");
{
  const { COURSE_UPDATES, partial } = adaptUpdates(
    {
      "101": [
        { id: 1, body: "<p>Rubric posted &amp; ready.</p>", uid: "5001", display_name: "Mr. Cho", created: unix(NOW - 2 * HOUR) },
        { id: 2, body: "Field trip forms due", uid: "5001", created: unix(NOW - 2 * DAY) },
        { id: 3, body: "anyone have the notes?", uid: "7001", created: unix(NOW - HOUR) },
        { id: 4, body: "", uid: "5001", created: unix(NOW) },
      ],
      "102": [{ id: 5, body: "x".repeat(400), uid: "6001", created: unix(NOW - 3 * HOUR) }],
      "103": null,
    },
    { "101": [{ id: "5001", name: "Mr. Cho" }], "102": null },
    NOW
  );
  check(
    "newest first; display_name, else the teacher, else Classmate / Your teacher; empty posts skipped",
    COURSE_UPDATES.map((u) => [u.id, u.from, u.courseId, u.when, u.unread]),
    [
      ["3", "Classmate", "101", "1h ago", true],
      ["1", "Mr. Cho", "101", "2h ago", true],
      ["5", "Your teacher", "102", "3h ago", true],
      ["2", "Mr. Cho", "101", "2d ago", false],
    ]
  );
  check("plain text, at most 280", [COURSE_UPDATES[1].body, COURSE_UPDATES[2].body.length], ["Rubric posted & ready.", 280]);
  check("a class that failed: partial", partial, true);
  check("each has its time in ms", COURSE_UPDATES[0].at, Math.floor((NOW - HOUR) / 1000) * 1000);
  // 2026-10-06 review: the student's own post (no display_name) is "You", not "Classmate".
  const own = adaptUpdates({ "1": [{ id: 5, body: "My post", uid: 123, created: unix(NOW - HOUR) }] }, { "1": [{ id: "900", name: "Ms. Lee" } as any] }, NOW, "123");
  check("own post: You", own.COURSE_UPDATES.map((u) => u.from), ["You"]);
  const other = adaptUpdates({ "1": [{ id: 6, body: "Hi", uid: 456, created: unix(NOW - HOUR) }] }, { "1": [{ id: "900", name: "Ms. Lee" } as any] }, NOW, "123");
  check("someone else's post: still Classmate", other.COURSE_UPDATES.map((u) => u.from), ["Classmate"]);
  const many = adaptUpdates({ "1": Array.from({ length: 40 }, (_, i) => ({ id: i + 1, body: "b", created: unix(NOW - i * HOUR) })) }, {}, NOW);
  check("at most 30", many.COURSE_UPDATES.length, 30);
}

/* ── Events ────────────────────────────────────────────────────────────── */

console.log("\nevent range");
check("a real range", parseRange("2026-06-08", "2027-06-03"), { start: "2026-06-08", end: "2027-06-03" });
check("400 days is fine, 401 is not", [parseRange("2026-01-01", "2027-02-05") !== null, parseRange("2026-01-01", "2027-02-06")], [true, null]);
check("max range constant", MAX_RANGE_DAYS, 400);
check("end before start", parseRange("2026-10-06", "2026-10-05"), null);
check("not real dates", [parseRange("2026-02-30", "2026-03-01"), parseRange("2026-13-01", "2026-13-02"), parseRange("2026-1-1", "2026-1-2"), parseRange(undefined, "2026-10-06")], [null, null, null, null]);

console.log("\nSchoology events");
{
  const e = schoologyEvent({ id: 991, title: "Lab Report 4", description: "<p>Write it up</p>", start: "2026-10-09 15:00:00", has_end: 0, all_day: 0, type: "assignment", realm: "section", section_id: "101" }, "101");
  check("an assignment event", e, { id: "s-991", title: "Lab Report 4", date: "2026-10-09", allDay: false, source: "101", type: "assignment", desc: "Write it up", createdBy: "", time: "3:00 PM", assignmentId: "991", assignmentTitle: "Lab Report 4" });
  check("assignment_id wins when given; quiz titles are assessments", [schoologyEvent({ id: 5, assignment_id: 77, title: "Unit 2 Quiz", start: "2026-10-09 08:05:00", type: "assignment" }, "101")?.assignmentId, schoologyEvent({ id: 5, title: "Unit 2 Quiz", start: "2026-10-09 08:05:00", type: "assignment" }, "101")?.type], ["77", "assessment"]);
  const teacher = schoologyEvent({ id: 12, title: "Picture Day", start: "2026-10-12 00:00:00", all_day: "1", type: "event" }, "school");
  check("a school event: all day, teacher type, no time or assignment", teacher, { id: "s-12", title: "Picture Day", date: "2026-10-12", allDay: true, source: "school", type: "teacher", desc: "", createdBy: "" });
  check("midnight, noon, evening", ["00:00", "12:30", "23:59"].map((t) => schoologyEvent({ id: 1, start: `2026-10-09 ${t}:00`, type: "event" }, "school")?.time), ["12:00 AM", "12:30 PM", "11:59 PM"]);
  check("bad ids and dates are dropped", [schoologyEvent({ id: "x", start: "2026-10-09 10:00:00" }, "1"), schoologyEvent({ id: 1, start: "soon" }, "1"), schoologyEvent({ id: 1, start: "2026-02-31 10:00:00" }, "1")], [null, null, null]);

  const answer = adaptSchoologyEvents({
    bySection: {
      "101": [
        { id: 2, title: "Essay", start: "2026-10-09 23:59:00", type: "assignment" },
        { id: 1, title: "Lab", start: "2026-10-09 08:00:00", type: "assignment" },
        { id: 9, title: "Out of range", start: "2026-12-01 08:00:00", type: "assignment" },
      ],
      "102": null,
    },
    user: [
      { id: 1, title: "Lab", start: "2026-10-09 08:00:00", type: "assignment", realm: "section", section_id: "101" },
      { id: 3, title: "Club meeting", start: "2026-10-09 00:00:00", all_day: 1, type: "event", realm: "school" },
      { id: 4, title: "Old class", start: "2026-10-10 09:00:00", type: "assignment", realm: "section", section_id: "555" },
    ],
    courses: ["101", "102"],
    range: { start: "2026-10-01", end: "2026-10-31" },
  });
  check("sorted by day, all-day first, then time; each once; classes vs school", answer.EVENTS.map((x) => [x.id, x.source, x.time ?? "all day"]), [
    ["s-3", "school", "all day"],
    ["s-1", "101", "8:00 AM"],
    ["s-2", "101", "11:59 PM"],
    ["s-4", "school", "9:00 AM"],
  ]);
  check("a school item has no assignment link", answer.EVENTS[3].assignmentId, undefined);
  check("a class that failed: partial", answer.partial, true);
}

console.log("\nClassroom events");
{
  check("local date and time in the student's zone", [localDateTime(Date.UTC(2026, 9, 10, 6, 59), "America/Los_Angeles"), localDateTime(Date.UTC(2026, 9, 10, 6, 59), "UTC")], [{ date: "2026-10-09", time: "11:59 PM" }, { date: "2026-10-10", time: "6:59 AM" }]);
  const answer = adaptClassroomEvents(
    {
      "111": [
        { id: "1", title: "Unit Test", maxPoints: 50, dueDate: { year: 2026, month: 10, day: 10 }, dueTime: { hours: 6, minutes: 59 }, description: "Chapters 1-3" },
        { id: "2", title: "Undated" },
        { id: "3", title: "Later", dueDate: { year: 2027, month: 1, day: 1 }, dueTime: { hours: 12 } },
        { id: "x", title: "Bad id", dueDate: { year: 2026, month: 10, day: 10 }, dueTime: {} },
      ],
      "222": null,
    },
    { start: "2026-10-01", end: "2026-10-31" },
    "America/Los_Angeles"
  );
  check("dated work in range, in LA time, type from the title", answer.EVENTS, [
    { id: "c-1", title: "Unit Test", date: "2026-10-09", time: "11:59 PM", allDay: false, source: "111", type: "assessment", desc: "Chapters 1-3", createdBy: "", assignmentId: "1", assignmentTitle: "Unit Test", points: 50 },
  ]);
  check("a class that failed: partial", answer.partial, true);
}

/* ── Folders ───────────────────────────────────────────────────────────── */

console.log("\nfolders");
{
  const root = parseFolder({
    self: { id: 0 },
    "folder-item": [
      { id: 77, title: "Unit 1", type: "folder", color: "blue" },
      { id: 78, title: "<i>Unit 2</i>", type: "folder", color: "javascript:x" },
      { id: 601, title: "Lab", type: "assignment" },
      { id: 501, title: "Notes", type: "document" },
      { id: 502, title: "Quiz", type: "assessment" },
      { id: 503, title: "Board", type: "discussion" },
      { id: 504, title: "Draft", type: "document", published: "0" },
      { id: "x", title: "Bad", type: "document" },
    ],
  });
  check("subfolders (titles plain, colors only when plain)", root.folders, [{ id: "77", title: "Unit 1", color: "blue" }, { id: "78", title: "Unit 2", color: "" }]);
  check("items by kind:id (assessments are assignments; unpublished and bad ids skipped)", root.items, ["assignment:601", "document:501", "assignment:502", "discussion:503"]);
  check("one item as a bare object; nested once", [parseFolder({ "folder-item": { id: 1, type: "document" } }).items, parseFolder({ "folder-item": { "folder-item": [{ id: 2, type: "folder", title: "A" }] } }).folders], [["document:1"], [{ id: "2", title: "A", color: "" }]]);
  check("nothing there", parseFolder({ self: {} }), { folders: [], items: [] });

  const topics = adaptClassroomFolders(
    [{ topicId: "5", name: "Unit 1" }, { topicId: "6", name: "Unit 2" }, { topicId: "bad" }],
    [{ id: "900", topicId: "5" }, { id: "901" }, { id: "902", topicId: "99" }],
    [{ id: "950", topicId: "6" }]
  );
  check("Classroom topics as top-level folders", topics.folders, [{ id: "t5", title: "Unit 1", parent: "", color: "" }, { id: "t6", title: "Unit 2", parent: "", color: "" }]);
  check("placement for coursework and materials in known topics", topics.placement, { "assignment:900": "t5", "material:950": "t6" });
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

console.log("\nhelpers");
check("refused: 401/403 only", [refused(new SchoologyError("x", 401)), refused(new SchoologyError("x", 403)), refused(new SchoologyError("x", 404)), refused(new Error("x"))], [true, true, false, false]);
{
  let inFlight = 0;
  let max = 0;
  const done: number[] = [];
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    done.push(n);
    inFlight--;
  });
  check("runPool: every item, never more than 3 at once", [done.sort(), max], [[1, 2, 3, 4, 5, 6, 7], 3]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
