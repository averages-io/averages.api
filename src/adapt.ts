/**
 * Maps Schoology's API shapes into the exact data shapes Schoolagy's pages
 * already render.
 *
 * This is deliberately the ONLY place that knows about both sides. The pages
 * keep their existing sample-data structures untouched (`COURSES`, `HISTORY`,
 * `OVERDUE`, ...), and real data is poured into those same shapes — so the UI
 * needed no rewrite to go from mock to live, and mock mode stays a genuine
 * apples-to-apples preview of the real thing rather than a separate codepath
 * that drifts.
 *
 * Everything here is defensive about missing/oddly-shaped fields: Schoology
 * varies its response nesting by endpoint and district configuration, and a
 * single unexpected null should degrade one course's grade display, not blank
 * the whole page.
 */

/**
 * The muted per-course palette the app already uses (see home.html/courses.html).
 * Assigned by stable hash of the course id so a given course keeps the same
 * color across pages and across sessions, the way the hand-picked sample
 * colors do.
 */
const COURSE_PALETTE = [
  "#a67a22",
  "#5b6ea3",
  "#6b8f5e",
  "#a15c4f",
  "#8a6ba1",
  "#4f8c8a",
  "#8c6f4f",
  "#4f6b8c",
];

export function colorForCourse(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return COURSE_PALETTE[hash % COURSE_PALETTE.length];
}

/**
 * Standard US letter-grade cutoffs with +/- bands. Schoology can carry a
 * per-section custom grading scale; when a section reports its own letter
 * grade we prefer that and only fall back to this.
 */
export function letterFromPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "—";
  if (pct >= 97) return "A+";
  if (pct >= 93) return "A";
  if (pct >= 90) return "A-";
  if (pct >= 87) return "B+";
  if (pct >= 83) return "B";
  if (pct >= 80) return "B-";
  if (pct >= 77) return "C+";
  if (pct >= 73) return "C";
  if (pct >= 70) return "C-";
  if (pct >= 67) return "D+";
  if (pct >= 63) return "D";
  if (pct >= 60) return "D-";
  return "F";
}

/**
 * Standard unweighted 4.0 scale — same cutoffs `grades.html`'s own
 * client-side `GPA_SCALE` uses for its (current-grade) Estimated GPA, kept
 * here so the server-side Projected GPA below (used for the weekly-report
 * email's GPA snapshot, not shown elsewhere in the app) uses an identical
 * mapping rather than a second hand-typed copy silently drifting from it.
 */
export const GPA_SCALE: Record<string, number> = {
  "A+": 4.0,
  A: 4.0,
  "A-": 3.7,
  "B+": 3.3,
  B: 3.0,
  "B-": 2.7,
  "C+": 2.3,
  C: 2.0,
  "C-": 1.7,
  "D+": 1.3,
  D: 1.0,
  "D-": 0.7,
  F: 0.0,
};

/**
 * Unweighted GPA averaged across each course's *predicted* letter grade
 * (`AdaptedCourse.predicted`), not the current one — "Projected GPA" is
 * meant to answer "where is this trending," matching the per-course
 * Predicted-grade chip's own framing elsewhere in the app. Rounded to 2
 * decimals so a week-over-week delta (`current - lastWeek`) doesn't carry
 * meaningless float noise into the email.
 *
 * Returns 0 for no courses rather than NaN — an empty course list producing
 * a silent "0.0" in a snapshot is a far easier bug to spot later than a NaN
 * that poisons every subsequent delta calculation.
 */
export function computeProjectedGPA(courses: { predicted: string }[]): number {
  if (courses.length === 0) return 0;
  const total = courses.reduce((sum, c) => sum + (GPA_SCALE[c.predicted] ?? 0), 0);
  return Math.round((total / courses.length) * 100) / 100;
}

/**
 * Predicted grade = least-squares trend across recent graded assignments,
 * projected one step forward — NOT a copy of the current grade.
 *
 * This matches the documented spec ("extrapolating the trend so far"), and is
 * why a student pulling their scores up sees a predicted grade above their
 * current one. Falls back to the current average when there aren't enough
 * graded points to establish a direction (a single score is not a trend).
 */
export function predict(points: number[]): {
  predictedPct: number;
  trend: "up" | "down" | "flat";
} {
  const clean = points.filter((p) => typeof p === "number" && !Number.isNaN(p));
  if (clean.length === 0) return { predictedPct: 0, trend: "flat" };

  const average = clean.reduce((a, b) => a + b, 0) / clean.length;
  if (clean.length < 3) {
    return { predictedPct: Math.round(average), trend: "flat" };
  }

  const n = clean.length;
  const meanX = (n - 1) / 2;
  const meanY = average;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (clean[i] - meanY);
    den += (i - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  const projected = intercept + slope * n;

  // Clamp: a steep upward run shouldn't project a 140%, and a collapse
  // shouldn't project a negative.
  const predictedPct = Math.max(0, Math.min(100, Math.round(projected)));

  // A trend arrow should reflect a real move, not float noise — one third of
  // a point per assignment is the threshold for calling it a direction.
  const trend = slope > 0.33 ? "up" : slope < -0.33 ? "down" : "flat";
  return { predictedPct, trend };
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Fri Aug 21" — the format the assignment lists already render. */
export function formatDue(value: string | number | undefined): string {
  const date = toDate(value);
  if (!date) return "";
  return `${DOW[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** "Aug 4" — the format the prediction chart's X axis already renders. */
export function formatShortDate(value: string | number | undefined): string {
  const date = toDate(value);
  if (!date) return "";
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** "2h ago" — the format the "Updated" column already renders. */
export function relativeTime(value: string | number | undefined): string {
  const date = toDate(value);
  if (!date) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatShortDate(value);
}

function toDate(value: string | number | undefined): Date | null {
  if (value === undefined || value === null || value === "") return null;
  // Schoology returns both unix timestamps (numeric strings) and
  // "YYYY-MM-DD HH:MM:SS" strings depending on the field.
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const seconds = Number(value);
    if (!seconds) return null;
    return new Date(seconds * 1000);
  }
  const normalized = String(value).replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

type Raw = Record<string, any>;

export interface AdaptedCourse {
  id: string;
  name: string;
  color: string;
  grade: string;
  pct: number;
  predicted: string;
  predictedPct: number;
  trend: "up" | "down" | "flat";
  updated: string;
}

export interface AdaptedBundle {
  COURSES: AdaptedCourse[];
  HISTORY: Record<string, { points: number[]; dates: string[] }>;
  OVERDUE: Raw[];
  UPCOMING: Raw[];
  TODAY: Raw[];
  MESSAGES: Raw[];
}

/**
 * Pulls the last few graded assignments for one section out of a grades
 * payload and turns them into the percentage series the prediction chart draws.
 */
function historyForSection(gradeEntry: Raw): { points: number[]; dates: string[] } {
  const buckets: Raw[] = [];
  for (const period of asArray(gradeEntry?.period)) {
    for (const assignment of asArray(period?.assignment)) {
      buckets.push(assignment);
    }
  }

  const scored = buckets
    .map((a) => {
      const earned = num(a?.grade);
      const possible = num(a?.max_points);
      if (earned === null || !possible) return null;
      // `exception` marks excused (1) / incomplete (2) work — neither is a
      // real score and including them would drag the trend line down.
      if (num(a?.exception)) return null;
      return {
        pct: Math.round((earned / possible) * 100),
        at: toDate(a?.timestamp ?? a?.created)?.getTime() ?? 0,
        raw: a?.timestamp ?? a?.created,
      };
    })
    .filter((x): x is { pct: number; at: number; raw: any } => x !== null)
    .sort((a, b) => a.at - b.at)
    .slice(-5);

  return {
    points: scored.map((s) => s.pct),
    dates: scored.map((s) => formatShortDate(s.raw)),
  };
}

function asArray(value: unknown): Raw[] {
  if (Array.isArray(value)) return value as Raw[];
  if (value && typeof value === "object") return [value as Raw];
  return [];
}

export function adaptCourses(
  sections: Raw[],
  grades: Raw[]
): { COURSES: AdaptedCourse[]; HISTORY: AdaptedBundle["HISTORY"] } {
  const gradesBySection = new Map<string, Raw>();
  for (const entry of grades) {
    const id = String(entry?.section_id ?? entry?.id ?? "");
    if (id) gradesBySection.set(id, entry);
  }

  const COURSES: AdaptedCourse[] = [];
  const HISTORY: AdaptedBundle["HISTORY"] = {};

  for (const section of sections) {
    const id = String(section?.id ?? section?.section_id ?? "");
    if (!id) continue;

    const gradeEntry = gradesBySection.get(id) ?? {};
    const history = historyForSection(gradeEntry);
    HISTORY[id] = history;

    // Prefer the section's own reported final grade; fall back to averaging
    // the graded assignments we could see.
    const finalGrade = asArray(gradeEntry?.final_grade)[0];
    const reportedPct = num(finalGrade?.grade);
    const fallbackPct = history.points.length
      ? Math.round(
          history.points.reduce((a, b) => a + b, 0) / history.points.length
        )
      : null;
    const pct = reportedPct ?? fallbackPct ?? 0;

    const { predictedPct, trend } = predict(history.points);

    COURSES.push({
      id,
      name:
        section?.course_title ||
        section?.section_title ||
        section?.title ||
        "Untitled course",
      color: colorForCourse(id),
      grade: letterFromPct(pct),
      pct,
      predicted: letterFromPct(predictedPct || pct),
      predictedPct: predictedPct || pct,
      trend,
      updated: relativeTime(gradeEntry?.timestamp ?? section?.last_updated),
    });
  }

  return { COURSES, HISTORY };
}

const TYPE_MAP: Record<string, string> = {
  assignment: "assignment",
  discussion: "discussion",
  assessment: "assessment",
  quiz: "assessment",
  test: "assessment",
};

export function adaptAssignments(
  assignmentsBySection: Record<string, Raw[]>
): { OVERDUE: Raw[]; UPCOMING: Raw[]; TODAY: Raw[] } {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = startOfToday.getTime() + 24 * 60 * 60 * 1000;

  const OVERDUE: Raw[] = [];
  const UPCOMING: Raw[] = [];
  const TODAY: Raw[] = [];

  for (const [courseId, assignments] of Object.entries(assignmentsBySection)) {
    for (const assignment of assignments) {
      const dueDate = toDate(assignment?.due);
      if (!dueDate) continue; // undated work belongs in neither bucket

      const item = {
        type: TYPE_MAP[String(assignment?.type ?? "").toLowerCase()] ?? "assignment",
        title: assignment?.title ?? "Untitled",
        courseId,
        due: formatDue(assignment?.due),
        id: String(assignment?.id ?? ""),
      };

      const dueMs = dueDate.getTime();
      if (dueMs >= startOfToday.getTime() && dueMs < endOfToday) {
        TODAY.push({ title: item.title, courseId });
      }

      // "Completed" is deliberately not inferred here — Schoology reports
      // submission state per grade item, and guessing from the assignment
      // alone would mark submitted work as overdue.
      if (dueMs < now) {
        OVERDUE.push(item);
      } else {
        UPCOMING.push(item);
      }
    }
  }

  const byDue = (a: Raw, b: Raw) => String(a.due).localeCompare(String(b.due));
  OVERDUE.sort(byDue);
  UPCOMING.sort(byDue);

  // The lists are previews on Home; the full set lives on /assignments.
  return { OVERDUE, UPCOMING: UPCOMING.slice(0, 25), TODAY };
}

export function adaptMessages(messages: Raw[]): Raw[] {
  return messages.slice(0, 25).map((message) => ({
    from: message?.author_name ?? message?.author_id ?? "Unknown sender",
    courseId: "",
    preview: String(message?.message ?? message?.subject ?? "").slice(0, 140),
    time: relativeTime(message?.last_updated ?? message?.created),
    subject: message?.subject ?? "",
    unread: String(message?.message_status ?? "").toLowerCase() === "unread",
    id: String(message?.id ?? ""),
  }));
}
