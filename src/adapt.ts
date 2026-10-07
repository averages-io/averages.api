/**
 * Maps Schoology's API shapes into the exact data shapes Averages.io's pages
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

import type { GradebookCategory } from "./classroom.ts";

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
 * here so the server-side Projected GPA below uses an identical mapping
 * rather than a second hand-typed copy silently drifting from it.
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
 * decimals. Sent as the bundle's `projectedGPA`.
 *
 * (2026-10-06: this used to also feed a weekly-email "vs last week" GPA
 * snapshot. The Weekly Grade Summary email was replaced by browser
 * notifications on 2026-10-04 and the snapshot is gone; the number itself
 * stays in the bundle.)
 *
 * Returns 0 for no courses rather than NaN.
 */
export function computeProjectedGPA(courses: { predicted: string }[]): number {
  if (courses.length === 0) return 0;
  // `?? 0` alone isn't enough: `predicted` can come from Schoology data, and an
  // inherited key like "constructor" resolves to a function, not undefined,
  // which would turn the whole sum into NaN (security audit, 2026-09-15).
  const total = courses.reduce((sum, c) => {
    const points = Object.prototype.hasOwnProperty.call(GPA_SCALE, c.predicted) ? GPA_SCALE[c.predicted] : 0;
    return sum + (typeof points === "number" ? points : 0);
  }, 0);
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
export function relativeTime(value: string | number | undefined, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return "";
  const seconds = Math.floor((now - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatShortDate(value);
}

/** A Schoology timestamp (unix seconds, or "YYYY-MM-DD HH:MM:SS") as ms, or null. */
export function schoologyTime(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return toDate(value)?.getTime() ?? null;
}

/**
 * Schoology's due dates come with a time: "2026-10-09 23:59:00", in the
 * student's own time zone (2026-10-07, Martin: "then how does the Schoology
 * app have times"). Until now the bundle kept only "Fri Oct 9" and read the
 * rest as UTC, so in California work turned overdue seven hours early. This
 * is that moment as epoch ms, read in `tz` (the zone the app sends as ?tz=);
 * unix timestamps pass through.
 */
export function schoologyLocalMs(value: unknown, tz: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const seconds = Number(value);
    return seconds ? seconds * 1000 : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value).trim());
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 23), +(m[5] ?? 59), +(m[6] ?? 0));
  if (Number.isNaN(wall)) return null;
  // The zone's offset at that moment, checked twice so a time right at a
  // daylight-saving change lands on the right side of it.
  let ms = wall - zoneOffset(wall, tz);
  ms = wall - zoneOffset(ms, tz);
  return ms;
}

const ZONE_PARTS = new Map<string, Intl.DateTimeFormat>();
/** How far `tz` is ahead of UTC at `ms`, in ms. Unknown zones count as UTC. */
function zoneOffset(ms: number, tz: string): number {
  let f = ZONE_PARTS.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return 0;
    }
    if (ZONE_PARTS.size > 50) ZONE_PARTS.clear();
    ZONE_PARTS.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const TIME_FORMATS = new Map<string, Intl.DateTimeFormat>();
/** "11:59 PM" in the student's zone. */
export function timeLabel(ms: number, tz: string): string {
  let f = TIME_FORMATS.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: true });
    }
    if (TIME_FORMATS.size > 50) TIME_FORMATS.clear();
    TIME_FORMATS.set(tz, f);
  }
  return f.format(new Date(ms));
}

/** dueAt (ISO) and time ("11:59 PM") for a Schoology due date, or nothing when it has none. */
function dueParts(value: unknown, tz: string): { dueAt?: string; time?: string } {
  const ms = schoologyLocalMs(value, tz);
  return ms === null ? {} : { dueAt: new Date(ms).toISOString(), time: timeLabel(ms, tz) };
}

/** The calendar day ("2026-10-09") of `ms` in `tz`. */
function dayIn(ms: number, tz: string): string {
  const off = zoneOffset(ms, tz);
  return new Date(ms + off).toISOString().slice(0, 10);
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
  /** Schoology's course code ("ENG10"); "" for Classroom. (2026-10-06) */
  code: string;
  /** The class period from the section's title ("Period 3", "P3", "3rd Period"), else "". */
  period: number | "";
  /** The section's own name when it says more than the period, else "". */
  section: string;
  /** Always "" in the bundle; the app fills it from GET /data/people. */
  teacher: string;
}

/**
 * The class period in a section title, for the course cards (2026-10-06):
 * "Period 3", "Per. 3", "Pd 3", "P3", "3rd Period", "Period 03" all give 3.
 * Schools write this many ways and nothing else in Schoology or Classroom
 * says which period a class meets, so this only reads the obvious forms and
 * gives "" otherwise (a wrong period is worse than none).
 */
const PERIOD_RE = /\b(?:period|per|pd|p)\.?\s*0?(\d{1,2})(?![0-9])|\b0?(\d{1,2})(?:st|nd|rd|th)\s+(?:period|per\b|pd\b)/i;

export function parsePeriod(text: unknown): number | "" {
  const m = String(text ?? "").match(PERIOD_RE);
  if (!m) return "";
  const n = Number(m[1] ?? m[2]);
  return Number.isInteger(n) && n >= 0 && n <= 15 ? n : "";
}

/**
 * What a section title adds beyond the period: "" for "Period 3" or "P3"
 * alone (the card already shows the period), and "" when it only repeats
 * the course's own name.
 */
export function sectionLabel(text: unknown, courseName: string): string {
  const label = toPlainText(text ?? "").slice(0, 120);
  if (!label) return "";
  if (label.toLowerCase() === courseName.trim().toLowerCase()) return "";
  const rest = label.replace(PERIOD_RE, "").replace(/[\s\-–—:|,.()#]+/g, "");
  return rest ? label : "";
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
    const name =
      section?.course_title ||
      section?.section_title ||
      section?.title ||
      "Untitled course";
    // The period and section name (2026-10-06): the section title first
    // ("Period 3", "Biology - Honors"), then the section code when the title
    // doesn't say ("P3").
    const period = parsePeriod(section?.section_title);
    const titleLabel = sectionLabel(section?.section_title, String(name));

    COURSES.push({
      id,
      name,
      color: colorForCourse(id),
      grade: letterFromPct(pct),
      pct,
      predicted: letterFromPct(predictedPct || pct),
      predictedPct: predictedPct || pct,
      trend,
      updated: relativeTime(gradeEntry?.timestamp ?? section?.last_updated),
      code: toPlainText(section?.course_code ?? "").slice(0, 40),
      period: period === "" ? parsePeriod(section?.section_code) : period,
      section: titleLabel || (section?.section_title ? "" : sectionLabel(section?.section_code, String(name))),
      teacher: "",
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
  assignmentsBySection: Record<string, Raw[]>,
  tz = "UTC",
  now = Date.now()
): { OVERDUE: Raw[]; UPCOMING: Raw[]; TODAY: Raw[] } {
  const today = dayIn(now, tz);

  const OVERDUE: Raw[] = [];
  const UPCOMING: Raw[] = [];
  const TODAY: Raw[] = [];

  for (const [courseId, assignments] of Object.entries(assignmentsBySection)) {
    for (const assignment of assignments) {
      const dueMs = schoologyLocalMs(assignment?.due, tz);
      if (dueMs === null) continue; // undated work belongs in neither bucket

      const item = {
        type: TYPE_MAP[String(assignment?.type ?? "").toLowerCase()] ?? "assignment",
        title: assignment?.title ?? "Untitled",
        courseId,
        due: formatDue(assignment?.due),
        // The exact moment and its time (2026-10-07): "Due in 3 hours", "11:59 PM".
        dueAt: new Date(dueMs).toISOString(),
        time: timeLabel(dueMs, tz),
        id: String(assignment?.id ?? ""),
      };

      if (dayIn(dueMs, tz) === today) {
        // With its id (2026-10-07): Home links to it as assignment?id=<id>.
        TODAY.push({ title: item.title, courseId, id: item.id });
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

  // By the real due time (the "Fri Oct 9" labels sorted as words before 2026-10-07).
  const byDue = (a: Raw, b: Raw) => Date.parse(a.dueAt) - Date.parse(b.dueAt);
  OVERDUE.sort(byDue);
  UPCOMING.sort(byDue);

  // The lists are previews on Home; the full set lives on /assignments.
  return { OVERDUE, UPCOMING: UPCOMING.slice(0, 25), TODAY };
}

/**
 * Schoology message bodies arrive as HTML (a teacher's rich-text editor
 * produces <p>, <br>, entities). The app escapes everything it renders, so raw
 * markup would show up as visible tags; this flattens it to plain text first
 * (security audit, 2026-09-15).
 *
 * Order matters: tags are stripped BEFORE entities are decoded, and entities
 * are decoded exactly one level, so someone who literally typed "&lt;script&gt;"
 * ends up with the text "<script>", which the page then escapes on render.
 */
export function toPlainText(html: unknown): string {
  // Linear on any input (2026-10-06 review): a tag can't contain "<", so a
  // long run of "<" with no ">" (which made /<[^>]*>/ quadratic, a second of
  // CPU on 40 KB) is passed over in one step. Capped at 100 KB first: nothing
  // shown anywhere needs more.
  const withBreaks = String(html ?? "").slice(0, 100_000).replace(/<\s*(br|\/p|\/div|\/li)\b[^<>]*>/gi, " ");
  const noTags = withBreaks.replace(/<[^<>]*>/g, "");
  return decodeEntities(noTags).replace(/\s+/g, " ").trim();
}

/** HTML entities to characters, exactly one level (see toPlainText). Run only on text whose tags are already gone. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return Object.prototype.hasOwnProperty.call(named, code.toLowerCase()) ? named[code.toLowerCase()] : whole;
  });
}

/** The first `max` characters (never half an emoji). */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/**
 * Home's Messages widget. Schoology's message lists carry the author's id
 * but not their name, so the sender is named from `names` (GET
 * /messages/recipients, the people this student can message, read in the
 * bundle's first wave): until 2026-10-06 this showed the raw id. Someone not
 * on that list, or a district where it can't be read, shows as "Teacher".
 */
export function adaptMessages(messages: Raw[], names?: Map<string, string>): Raw[] {
  return messages.slice(0, 25).map((message) => ({
    from:
      (typeof message?.author_name === "string" && toPlainText(message.author_name).slice(0, 120)) ||
      names?.get(String(message?.author_id ?? "")) ||
      "Teacher",
    courseId: "",
    // Flattened before truncating, so the 140 characters are visible text and
    // a long opening tag can't use them all up.
    preview: toPlainText(message?.message ?? message?.subject ?? "").slice(0, 140),
    time: relativeTime(message?.last_updated ?? message?.created),
    subject: toPlainText(message?.subject ?? ""),
    unread: String(message?.message_status ?? "").toLowerCase() === "unread",
    id: String(message?.id ?? ""),
  }));
}

export interface AttachmentFile {
  id: string;
  name: string;
  ext: string;
  /** Bytes; 0 when Schoology doesn't say. */
  size: number;
}

export interface AssignmentDetail {
  id: string;
  sectionId: string;
  title: string;
  description: string;
  due: string;
  /** The exact due moment (ISO) and its time in the student's zone (2026-10-07). */
  dueAt?: string;
  time?: string;
  type: string;
  files: AttachmentFile[];
  links: { title: string; url: string }[];
}

/**
 * Schoology nests list-ish things two ways depending on the endpoint:
 * `files: [...]` or `files: { file: [...] }` (and a bare object for one).
 */
function nestedList(container: unknown, inner: string): Raw[] {
  if (Array.isArray(container)) return container as Raw[];
  if (container && typeof container === "object") {
    const value = (container as Raw)[inner];
    if (value !== undefined) return asArray(value);
  }
  return [];
}

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}

/**
 * The assignment page's description and Attached Materials. Download paths
 * are deliberately NOT included: the browser only ever gets a file's id, and
 * the Worker looks the real path up again when a file is opened in Canva.
 */
export function adaptAssignmentDetail(raw: Raw, sectionId: string, tz = "UTC"): AssignmentDetail {
  const attachments = raw?.attachments ?? {};
  const files = nestedList(attachments?.files, "file")
    .map((f) => {
      const filename = String(f?.filename ?? f?.title ?? "");
      const name = Array.from(String(f?.title || filename || "File")).slice(0, 255).join(""); // never cut an emoji in half
      const ext = String(f?.extension ?? "").toLowerCase().replace(/^\./, "") || extOf(filename) || extOf(name);
      return { id: String(f?.id ?? ""), name, ext, size: num(f?.filesize) ?? 0 };
    })
    .filter((f) => f.id);
  const links = nestedList(attachments?.links, "link")
    .map((l) => ({ title: toPlainText(l?.title ?? l?.url ?? "Link").slice(0, 255), url: String(l?.url ?? "") }))
    .filter((l) => /^https?:\/\//i.test(l.url));
  return {
    id: String(raw?.id ?? ""),
    sectionId,
    title: toPlainText(raw?.title ?? "Untitled"),
    description: toPlainText(raw?.description ?? ""),
    due: formatDue(raw?.due),
    ...dueParts(raw?.due, tz),
    type: TYPE_MAP[String(raw?.type ?? "").toLowerCase()] ?? "assignment",
    files,
    links,
  };
}

/** The raw file entry for an attachment id, with its Schoology download path (Worker only). */
export function findAttachment(raw: Raw, fileId: string): { name: string; downloadPath: string; size: number } | null {
  for (const f of nestedList(raw?.attachments?.files, "file")) {
    if (String(f?.id ?? "") !== fileId) continue;
    // Same name as the Files list shows, with the real extension even when the title has none.
    return { name: fileNameOf(f).name, downloadPath: String(f?.download_path ?? ""), size: num(f?.filesize) ?? 0 };
  }
  return null;
}

/* ── Course files (Files page, 2026-10-05) ─────────────────────────────── */

export interface CourseFile {
  /** Schoology's attachment id. */
  id: string;
  /** Shown name, always with its extension. */
  name: string;
  ext: string;
  /** Bytes; 0 when Schoology doesn't say. */
  size: number;
  /** Section id. */
  course: string;
  /** Where it's attached: a Materials document or an assignment. */
  kind: "document" | "assignment";
  /** That document's or assignment's id (needed to download it again). */
  parent: string;
  parentTitle: string;
  /** Upload time in ms, 0 when unknown. */
  at: number;
}

export const MAX_COURSE_FILES = 1000;

/**
 * A file's shown name and extension, the same in the Files list and on the
 * downloaded file: plain-text title (else the filename), cut by character
 * (never mid-emoji), with its extension on the end. The extension must look
 * like one (letters and digits, up to 8).
 */
function fileNameOf(f: Raw): { name: string; ext: string } {
  const filename = String(f?.filename ?? "");
  const title = toPlainText(f?.title ?? "").trim();
  const given = String(f?.extension ?? "").toLowerCase().replace(/^\./, "");
  const ext = (/^[a-z0-9]{1,8}$/.test(given) ? given : "") || extOf(filename) || extOf(title);
  let name = Array.from(title || filename || "File").slice(0, 240).join("");
  if (ext && !extOf(name)) name = `${name}.${ext}`;
  return { name, ext };
}

/** The file attachments on one document or assignment, named with their extension. */
function attachedFiles(raw: Raw): { id: string; name: string; ext: string; size: number; at: number }[] {
  return nestedList(raw?.attachments?.files, "file")
    .map((f) => {
      const { name, ext } = fileNameOf(f);
      const at = toDate(f?.timestamp ?? undefined)?.getTime() ?? 0;
      return { id: String(f?.id ?? ""), name, ext, size: num(f?.filesize) ?? 0, at };
    })
    .filter((f) => /^\d{1,20}$/.test(f.id));
}

/**
 * Every file in the student's courses: teachers' Materials documents and the
 * files attached to assignments, newest first. No download paths: the
 * browser gets ids, and the Worker looks the file up again to download it.
 */
export function adaptCourseFiles(
  bySection: Record<string, { documents: Raw[] | null; assignments: Raw[] | null }>,
): { files: CourseFile[]; partial: boolean } {
  const files: CourseFile[] = [];
  let partial = false;
  for (const [course, lists] of Object.entries(bySection)) {
    if (!lists.documents || !lists.assignments) partial = true;
    // A full page (200) may mean Schoology has more than it sent.
    if ((lists.documents?.length ?? 0) >= 200 || (lists.assignments?.length ?? 0) >= 200) partial = true;
    for (const [kind, list] of [["document", lists.documents ?? []], ["assignment", lists.assignments ?? []]] as const) {
      for (const item of list) {
        const parent = String(item?.id ?? "");
        if (!/^\d{1,20}$/.test(parent)) continue;
        const parentTitle = toPlainText(item?.title ?? "").slice(0, 255) || (kind === "document" ? "Document" : "Assignment");
        for (const f of attachedFiles(item)) {
          files.push({ ...f, course, kind, parent, parentTitle });
        }
      }
    }
  }
  files.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  if (files.length > MAX_COURSE_FILES) partial = true;
  return { files: files.slice(0, MAX_COURSE_FILES), partial };
}

/* ── Recent grades and the gradebook (2026-10-06) ──────────────────────── */


const DAY_MS = 24 * 60 * 60 * 1000;
/** Most graded items listed per category, same as Classroom's. */
const GRADEBOOK_PER_CATEGORY = 60;
/** Exceptions that mean "no score": 1 excused, 2 incomplete. (3 is missing.) */
const NO_SCORE_EXCEPTIONS = new Set([1, 2]);

/** 18 -> "18", 7.5 -> "7.5". */
function trimNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Every graded-assignment row in one section's grades entry (all grading periods). */
function gradeRows(entry: Raw | undefined): Raw[] {
  const rows: Raw[] = [];
  for (const period of asArray(entry?.period)) rows.push(...asArray(period?.assignment));
  return rows;
}

/** A row's score, when it has a real one: a number, points possible, and not excused/incomplete. */
function scoreOf(row: Raw | undefined): { earned: number; possible: number } | null {
  if (!row) return null;
  const earned = num(row.grade);
  const possible = num(row.max_points);
  if (earned === null || possible === null || possible <= 0 || earned < 0) return null;
  if (NO_SCORE_EXCEPTIONS.has(num(row.exception) ?? 0)) return null;
  return { earned, possible };
}

/** Assignment titles by id for one section's assignments list. */
function titlesOf(assignments: Raw[] | undefined): Map<string, string> {
  const titles = new Map<string, string>();
  for (const a of assignments ?? []) {
    const id = String(a?.id ?? "");
    if (/^\d{1,20}$/.test(id)) titles.set(id, toPlainText(a?.title ?? "").slice(0, 200) || "Untitled");
  }
  return titles;
}

export interface RecentGrade {
  title: string;
  courseId: string;
  letter: string;
  pct: number;
  pts: string;
  when: string;
  isNew: boolean;
  id: string;
}

/**
 * Home's Recent Grades for Schoology (the same shape Classroom's bundle
 * sends): the newest scores across every class, at most 10. Built from the
 * grades and assignments the bundle already fetched, so it costs no extra
 * Schoology calls. Grades read from Schoology carry no title, so a score is
 * only listed when its assignment's title is known (the first 12 classes,
 * whose assignments the bundle reads).
 */
export function adaptRecentGrades(grades: Raw[], assignmentsBySection: Record<string, Raw[]>, now: number = Date.now()): RecentGrade[] {
  const out: { at: number; grade: RecentGrade }[] = [];
  for (const entry of grades) {
    const courseId = String(entry?.section_id ?? entry?.id ?? "");
    if (!courseId || !Object.prototype.hasOwnProperty.call(assignmentsBySection, courseId)) continue;
    const titles = titlesOf(assignmentsBySection[courseId]);
    for (const row of gradeRows(entry)) {
      const id = String(row?.assignment_id ?? "");
      const title = titles.get(id);
      const score = scoreOf(row);
      if (!title || !score) continue;
      const at = schoologyTime(row?.timestamp) ?? 0;
      const pct = Math.round((score.earned / score.possible) * 100);
      out.push({
        at,
        grade: {
          title,
          courseId,
          letter: letterFromPct(pct),
          pct,
          pts: `${trimNumber(score.earned)}/${trimNumber(score.possible)}`,
          when: at ? relativeTime(String(Math.floor(at / 1000)), now) : "",
          isNew: at > now - 2 * DAY_MS,
          id,
        },
      });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, 10).map((x) => x.grade);
}

/**
 * One course's Grades tab for Schoology (the gradebook page's GRADEBOOK
 * shape, same as Classroom's): the class's grading categories with their
 * weights, each holding the work worth points in it, oldest first.
 *
 * `categories` is GET /sections/{id}/grading_categories when the gradebook
 * extra read it (exact names and weights), else the grades payload's own
 * `grading_category` list (the bundle, which reads nothing extra; weights are
 * sometimes missing there). A class with no weighted categories counts total
 * points: one "All work" group worth 100. Work in no known category goes
 * in "No category" (weight 0), as in Classroom.
 *
 * Unpublished work and work that doesn't count toward the grade are left
 * out; a score is shown only when it's a real one (not excused/incomplete).
 */
export function adaptSchoologyGradebook(input: { categories: Raw[] | null; gradeEntry: Raw | undefined; assignments: Raw[] }): { categories: GradebookCategory[] } {
  const scores = new Map<string, Raw>();
  for (const row of gradeRows(input.gradeEntry)) {
    const id = String(row?.assignment_id ?? "");
    if (/^\d{1,20}$/.test(id)) scores.set(id, row);
  }

  type Row = { row: GradebookCategory["assignments"][number]; category: string; at: number };
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const a of input.assignments) {
    const id = String(a?.id ?? "");
    if (!/^\d{1,20}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    if (String(a?.published ?? "1") === "0" || String(a?.count_in_grade ?? "1") === "0") continue;
    const graded = scores.get(id);
    const points = num(a?.max_points) ?? num(graded?.max_points);
    if (points === null || points <= 0) continue;
    const title = toPlainText(a?.title ?? "").slice(0, 200) || "Untitled";
    const score = scoreOf(graded);
    rows.push({
      row: score ? { title, score: score.earned, points, graded: true, id } : { title, points, graded: false, id },
      category: String(a?.grading_category ?? graded?.category_id ?? ""),
      at: schoologyTime(a?.due) ?? schoologyTime(graded?.timestamp) ?? Number.MAX_SAFE_INTEGER,
    });
  }
  // Scores for work the assignments list didn't include (a long list's later
  // pages): they count toward the grade, so they're listed too.
  for (const [id, row] of scores) {
    if (seen.has(id)) continue;
    const score = scoreOf(row);
    if (!score) continue;
    rows.push({
      row: { title: "Assignment", score: score.earned, points: score.possible, graded: true, id },
      category: String(row?.category_id ?? ""),
      at: schoologyTime(row?.timestamp) ?? Number.MAX_SAFE_INTEGER,
    });
  }
  rows.sort((a, b) => a.at - b.at);
  const list = (rs: Row[]) => rs.slice(-GRADEBOOK_PER_CATEGORY).map((r) => r.row);

  const cats: { id: string; name: string; weight: number; order: number }[] = [];
  const known = new Set<string>();
  asArray(input.categories ?? input.gradeEntry?.grading_category).forEach((cat, index) => {
    const id = String(cat?.id ?? "");
    if (!id || known.has(id)) return;
    known.add(id);
    const weight = num(cat?.weight);
    const delta = num(cat?.delta);
    cats.push({
      id,
      name: toPlainText(cat?.title ?? cat?.name ?? "").slice(0, 80) || "Category",
      weight: weight !== null && weight > 0 ? Math.round(weight * 100) / 100 : 0,
      order: delta ?? index,
    });
  });
  if (!cats.some((c) => c.weight > 0)) return { categories: [{ name: "All work", weight: 100, assignments: list(rows) }] };

  cats.sort((a, b) => a.order - b.order);
  const categories: GradebookCategory[] = cats.map((c) => ({ name: c.name, weight: c.weight, assignments: list(rows.filter((r) => r.category === c.id)) }));
  const other = rows.filter((r) => !known.has(r.category));
  if (other.length) categories.push({ name: "No category", weight: 0, assignments: list(other) });
  return { categories };
}
