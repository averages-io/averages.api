/**
 * Tests for the Schoology -> Averages.io data adapter.
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
  computeProjectedGPA,
  formatDue,
  letterFromPct,
  predict,
  relativeTime,
  toPlainText,
} from "../src/adapt.ts";
import { messageText } from "../src/messages.ts";
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

console.log("\ndue times in the student's zone (2026-10-07)");
{
  const { schoologyLocalMs, timeLabel } = await import("../src/adapt.ts");
  const LA = "America/Los_Angeles";
  // 11:59 PM in California on Oct 9 (PDT, UTC-7) is 06:59 UTC on Oct 10.
  check("local wall time read in the student's zone", new Date(schoologyLocalMs("2026-10-09 23:59:00", LA)!).toISOString(), "2026-10-10T06:59:00.000Z");
  check("and in winter (PST, UTC-8)", new Date(schoologyLocalMs("2026-12-09 23:59:00", LA)!).toISOString(), "2026-12-10T07:59:00.000Z");
  check("New York", new Date(schoologyLocalMs("2026-10-09 08:00:00", "America/New_York")!).toISOString(), "2026-10-09T12:00:00.000Z");
  check("unknown zone: UTC", new Date(schoologyLocalMs("2026-10-09 08:00:00", "Not/AZone")!).toISOString(), "2026-10-09T08:00:00.000Z");
  check("just after the spring-forward gap", new Date(schoologyLocalMs("2026-03-08 03:30:00", LA)!).toISOString(), "2026-03-08T10:30:00.000Z");
  check("unix seconds pass through", schoologyLocalMs("1791000000", LA), 1791000000000);
  check("date only: end of that day", new Date(schoologyLocalMs("2026-10-09", LA)!).toISOString(), "2026-10-10T06:59:00.000Z");
  check("junk: null", [schoologyLocalMs("soon", LA), schoologyLocalMs("", LA), schoologyLocalMs(undefined, LA)], [null, null, null]);
  check("time label", timeLabel(Date.parse("2026-10-10T06:59:00Z"), LA), "11:59 PM");

  // It's 5 PM in California on Oct 9: work due 11:59 PM tonight is NOT overdue yet (it was, read as UTC).
  const now = Date.parse("2026-10-10T00:00:00Z");
  const r = adaptAssignments({ "101": [
    { id: 1, title: "Tonight", due: "2026-10-09 23:59:00", type: "assignment" },
    { id: 2, title: "This morning", due: "2026-10-09 08:00:00", type: "assignment" },
    { id: 3, title: "Next week", due: "2026-10-16 23:59:00", type: "assignment" },
    { id: 4, title: "Monday", due: "2026-10-12 08:00:00", type: "assignment" },
  ] }, LA, now);
  check("due tonight is upcoming in its own zone", r.UPCOMING.map((x: any) => x.title), ["Tonight", "Monday", "Next week"]);
  check("sorted by real time, not by the label's words", r.UPCOMING.map((x: any) => x.due), ["Fri Oct 9", "Mon Oct 12", "Fri Oct 16"]);
  check("earlier today is overdue", r.OVERDUE.map((x: any) => x.title), ["This morning"]);
  check("items carry dueAt and time", [r.UPCOMING[0].dueAt, r.UPCOMING[0].time], ["2026-10-10T06:59:00.000Z", "11:59 PM"]);
  check("today is the student's today", r.TODAY.map((x: any) => x.title).sort(), ["This morning", "Tonight"]);
}

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

console.log("\nprojected GPA (weekly-report email's GPA card)");
check(
  "averages predicted letter grades on the standard 4.0 scale, matching grades.html's own GPA_SCALE",
  computeProjectedGPA([{ predicted: "A" }, { predicted: "B+" }, { predicted: "C" }]),
  Math.round(((4.0 + 3.3 + 2.0) / 3) * 100) / 100
);
check("all A's is a clean 4.0, not 3.999-something", computeProjectedGPA([{ predicted: "A" }, { predicted: "A+" }]), 4.0);
check("an unrecognized/blank letter (—) contributes 0, doesn't throw", computeProjectedGPA([{ predicted: "—" }, { predicted: "A" }]), 2.0);
check("empty course list is 0, not NaN", computeProjectedGPA([]), 0);
// `predicted` can be a section's own reported letter grade, i.e. a data-derived
// string. An inherited Object key resolves to a function, which `?? 0` would
// have waved through and turned the whole sum into NaN.
check(
  "an inherited key like 'constructor' contributes 0 rather than poisoning the sum with NaN",
  computeProjectedGPA([{ predicted: "constructor" }, { predicted: "A" }]),
  2.0
);
check(
  "same for 'toString'",
  computeProjectedGPA([{ predicted: "toString" }, { predicted: "A" }]),
  2.0
);

console.log("\nmessage bodies are flattened to plain text (they arrive as HTML)");
{
  const html = adaptMessages([
    {
      id: 11,
      subject: "<b>Lab rubric</b>",
      message: "<p>The rubric is <strong>posted</strong> under Materials.</p><br>See me if stuck.",
      author_name: "Mr. Alvarez",
    },
  ]);
  check(
    "tags are stripped from the preview, not shown as text",
    html[0].preview,
    "The rubric is posted under Materials. See me if stuck."
  );
  check("and from the subject", html[0].subject, "Lab rubric");
}
{
  const entities = adaptMessages([
    { id: 12, message: "Ben &amp; Jerry&#39;s &lt;not a tag&gt;", author_name: "Ms. Cho" },
  ]);
  // Decoded here, re-escaped by the page on render — so this shows as
  // characters, never as markup.
  check(
    "entities are decoded to their characters",
    entities[0].preview,
    "Ben & Jerry's <not a tag>"
  );
}
{
  const nested = adaptMessages([
    { id: 13, message: "&amp;lt;script&amp;gt;", author_name: "x" },
  ]);
  check(
    "a double-encoded sequence decodes exactly one level, not two",
    nested[0].preview,
    "&lt;script&gt;"
  );
}
{
  const long = adaptMessages([
    { id: 14, message: `<div class="${"x".repeat(200)}">Hello there</div>`, author_name: "x" },
  ]);
  check(
    "truncation counts visible characters — a long opening tag can't eat the whole preview",
    long[0].preview,
    "Hello there"
  );
}

// 2026-10-06 review: a long run of "<" with no ">" used to take quadratic time
// (a second of CPU for 40 KB). Linear now, so it's milliseconds.
{
  const nasty = "<".repeat(40000) + "x";
  let t0 = performance.now();
  const plain = toPlainText(nasty);
  const tPlain = performance.now() - t0;
  t0 = performance.now();
  messageText("<br".repeat(13000) + "<" .repeat(1000));
  const tMsg = performance.now() - t0;
  check("toPlainText: 40 KB of '<' is fast", tPlain < 50, true);
  check("messageText: a flood of unclosed tags is fast", tMsg < 50, true);
  check("...and still plain text", plain.endsWith("x"), true);
  check("normal markup still flattened", toPlainText("<p>Hi <b>there</b></p><br>next &amp; last"), "Hi there next & last");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
