/**
 * Tests for the Schoology -> Schoolagy data adapter.
 *
 * Run: node --experimental-strip-types test/adapt.test.ts
 *
 * The adapter is what makes live mode render correctly, and it's the piece most
 * exposed to Schoology's shape quirks (single results returned as bare objects
 * instead of arrays, timestamps in two different formats, excused work carrying
 * a null grade). Each of those is pinned here.
 */

import {
  adaptAssignments,
  adaptCourses,
  adaptMessages,
  colorForCourse,
  formatDue,
  letterFromPct,
  predict,
  relativeTime,
} from "../src/adapt.ts";
import { listOf } from "../src/schoology.ts";

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

console.log("\nletter grades");
check("97 is A+", letterFromPct(97), "A+");
check("93 is A", letterFromPct(93), "A");
check("92.9 rounds down to A-", letterFromPct(92.9), "A-");
check("90 is A-", letterFromPct(90), "A-");
check("87 is B+", letterFromPct(87), "B+");
check("70 is C-", letterFromPct(70), "C-");
check("59 is F", letterFromPct(59), "F");
check("0 is F", letterFromPct(0), "F");
// A missing grade must not render as "F" — an ungraded course is not a failing
// one, and showing it as such would be alarming and wrong.
check("null is em dash, not F", letterFromPct(null), "—");
check("undefined is em dash", letterFromPct(undefined), "—");

console.log("\ngrade prediction (trend extrapolation, not a copy of current)");
const rising = predict([72, 79, 84, 88, 90]);
checkTrue("rising scores predict above the average", rising.predictedPct > 82);
check("rising trend is up", rising.trend, "up");

const falling = predict([88, 82, 79, 76, 73]);
check("falling trend is down", falling.trend, "down");
checkTrue("falling scores predict below the average", falling.predictedPct < 79);

const steady = predict([94, 96, 93, 97, 95]);
check("steady trend is flat", steady.trend, "flat");

// Guard rails: a steep run must not project impossible percentages.
const steep = predict([10, 40, 70, 95, 99]);
checkTrue("prediction is capped at 100", steep.predictedPct <= 100);
const collapse = predict([90, 60, 30, 10, 2]);
checkTrue("prediction floors at 0", collapse.predictedPct >= 0);

// One or two scores is not a trend; claiming a direction from them would be
// noise dressed up as insight.
check("a single score has no trend", predict([85]).trend, "flat");
check("a single score predicts itself", predict([85]).predictedPct, 85);
check("no scores is handled", predict([]), { predictedPct: 0, trend: "flat" });

console.log("\ncourse colors");
checkTrue("assigns a hex color", /^#[0-9a-f]{6}$/i.test(colorForCourse("12345")));
check("same course gets the same color every time", colorForCourse("s1"), colorForCourse("s1"));
checkTrue(
  "different courses generally differ",
  new Set(["a", "b", "c", "d", "e"].map(colorForCourse)).size > 1
);

console.log("\ndate formatting");
// 2026-08-21 is a Friday.
check("unix timestamp to 'Fri Aug 21'", formatDue(String(Date.UTC(2026, 7, 21) / 1000)), "Fri Aug 21");
check("datetime string form", formatDue("2026-08-21 23:59:00"), "Fri Aug 21");
check("empty due date is empty", formatDue(undefined), "");
check("relative time handles missing values", relativeTime(undefined), "");

console.log("\nSchoology response unwrapping");
// Schoology returns a bare object rather than an array when there's one result.
check("array form", listOf({ section: [{ id: 1 }, { id: 2 }] }, "section").length, 2);
check("single-object form is wrapped", listOf({ section: { id: 1 } }, "section").length, 1);
check("missing key is empty", listOf({}, "section").length, 0);
check("null payload is empty", listOf(null, "section").length, 0);

console.log("\ncourses + history from a realistic grades payload");
const sections = [
  { id: 101, course_title: "AP Chemistry", section_title: "Period 3" },
  { id: 102, course_title: "Algebra II" },
];
const grades = [
  {
    section_id: 101,
    final_grade: [{ grade: 87 }],
    period: [
      {
        assignment: [
          { assignment_id: 1, grade: 72, max_points: 100, timestamp: Date.UTC(2026, 7, 4) / 1000 },
          { assignment_id: 2, grade: 40, max_points: 50, timestamp: Date.UTC(2026, 7, 8) / 1000 },
          { assignment_id: 3, grade: 90, max_points: 100, timestamp: Date.UTC(2026, 7, 12) / 1000 },
          // Excused work: carries an exception flag and must be ignored, or it
          // drags the trend line down with a score the student never earned.
          { assignment_id: 4, grade: 0, max_points: 100, exception: 1, timestamp: Date.UTC(2026, 7, 13) / 1000 },
        ],
      },
    ],
  },
];

const { COURSES, HISTORY } = adaptCourses(sections, grades);
check("one course per section", COURSES.length, 2);
check("uses the course title", COURSES[0].name, "AP Chemistry");
check("carries the reported final grade", COURSES[0].pct, 87);
check("letter matches the percentage", COURSES[0].grade, "B+");
check("history excludes excused work", HISTORY["101"].points, [72, 80, 90]);
check("history dates are short-form", HISTORY["101"].dates, ["Aug 4", "Aug 8", "Aug 12"]);
check("scores are percentages, not raw points", HISTORY["101"].points[1], 80);

// A section with no grade data must still appear — a course you're enrolled in
// but haven't been graded in yet should show up, just without a grade.
check("ungraded section still listed", COURSES[1].name, "Algebra II");
check("ungraded section has empty history", HISTORY["102"].points, []);

console.log("\nassignments bucketing");
const dayMs = 24 * 60 * 60 * 1000;
const past = Math.floor((Date.now() - 5 * dayMs) / 1000);
const future = Math.floor((Date.now() + 5 * dayMs) / 1000);
const { OVERDUE, UPCOMING } = adaptAssignments({
  "101": [
    { id: 1, title: "Lab Report #4", due: String(past), type: "assignment" },
    { id: 2, title: "Unit 2 Quiz", due: String(future), type: "assessment" },
    // No due date — belongs in neither bucket rather than being guessed into one.
    { id: 3, title: "Extra Credit", type: "assignment" },
  ],
});
check("past-due work is overdue", OVERDUE.length, 1);
check("overdue item keeps its title", OVERDUE[0].title, "Lab Report #4");
check("future work is upcoming", UPCOMING.length, 1);
check("quiz type maps to assessment", UPCOMING[0].type, "assessment");
check("undated work is in neither bucket", OVERDUE.length + UPCOMING.length, 2);
check("items carry their course id", OVERDUE[0].courseId, "101");

console.log("\nmessages");
const messages = adaptMessages([
  {
    id: 9,
    subject: "Lab rubric",
    message: "The rubric is posted under Materials.",
    message_status: "unread",
    author_name: "Mr. Alvarez",
    last_updated: Math.floor((Date.now() - 3600 * 1000) / 1000),
  },
]);
check("maps the sender", messages[0].from, "Mr. Alvarez");
check("marks unread", messages[0].unread, true);
check("relative time", messages[0].time, "1h ago");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
