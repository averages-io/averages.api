/**
 * Google Classroom data for a Google sign-in (2026-10-05): the same shapes the
 * pages already render for Schoology (see adapt.ts), so the app needs no
 * second set of pages. Read-only, nothing stored: each request reads
 * Classroom with the student's own token and maps the answer.
 *
 * Two Cloudflare limits shape the fetching:
 *   - A Worker request on the Free plan may make at most 50 subrequests, so
 *     every Classroom call is counted against a budget (CALL_BUDGET). The
 *     first page of everything fits; extra pages only while budget is left,
 *     and the answer says `partial` when something was cut.
 *   - CPU time is short, so every call asks Classroom for only the fields it
 *     needs (`fields=`); descriptions and materials only come with the one
 *     assignment that's opened.
 *
 * Dates: Classroom gives due dates in UTC. They're shown in the student's
 * time zone (the app sends it; Cloudflare's guess from the connection
 * otherwise), so 11:59 PM homework doesn't show as due the next day.
 */

import { colorForCourse, computeProjectedGPA, letterFromPct, parsePeriod, predict, sectionLabel, type AdaptedCourse } from "./adapt.ts";

export const CLASSROOM_API = "https://classroom.googleapis.com/v1";

/** Classroom calls one bundle may make (the token refresh and Sync add a few more, under 50). */
export const CALL_BUDGET = 42;
/** The most classes read, same as Schoology. */
export const MAX_COURSES = 12;

export class ClassroomError extends Error {
  status: number;
  constructor(status: number, message = "classroom_error") {
    super(message);
    this.name = "ClassroomError";
    this.status = status;
  }
}

export class CallBudget {
  left: number;
  cut = false;
  constructor(left: number) {
    this.left = left;
  }
  take(): boolean {
    if (this.left <= 0) {
      this.cut = true;
      return false;
    }
    this.left--;
    return true;
  }
}

type Raw = Record<string, any>;

/** Classroom ids are numbers in practice; anything else is refused before it reaches a URL. */
export const CLASSROOM_ID_RE = /^[0-9]{1,24}$/;

export async function classroomGet(path: string, params: Record<string, string>, accessToken: string, budget: CallBudget): Promise<Raw> {
  if (!budget.take()) throw new ClassroomError(429, "classroom_budget");
  const url = new URL(CLASSROOM_API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ClassroomError(504, "classroom_unreachable");
  }
  if (!response.ok) {
    // Drain the body so the connection can be reused; its text isn't passed on.
    await response.text().catch(() => "");
    throw new ClassroomError(response.status);
  }
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object") throw new ClassroomError(502, "classroom_bad_response");
  return data as Raw;
}

/**
 * Pages of a list, starting at `startToken` (up to maxPages, and only while
 * the budget lasts). `next` is the token to carry on from, "" when done.
 */
export async function classroomList(path: string, key: string, params: Record<string, string>, accessToken: string, budget: CallBudget, maxPages: number, startToken = ""): Promise<{ items: Raw[]; next: string }> {
  const items: Raw[] = [];
  let token = startToken;
  for (let page = 0; page < maxPages; page++) {
    // The first page has to come (or fail); later pages are skipped quietly when the budget is gone.
    if (page > 0 && budget.left <= 0) {
      budget.cut = true;
      return { items, next: token };
    }
    const data = await classroomGet(path, token ? { ...params, pageToken: token } : params, accessToken, budget);
    const list = data[key];
    if (Array.isArray(list)) items.push(...list.filter((x) => x && typeof x === "object"));
    token = typeof data.nextPageToken === "string" && data.nextPageToken.length <= 1024 ? data.nextPageToken : "";
    if (!token) return { items, next: "" };
  }
  return { items, next: token };
}

// `section` and `room` (2026-10-06): the course cards' period and section line.
const COURSE_FIELDS = "courses(id,name,section,room,alternateLink,updateTime,gradebookSettings),nextPageToken";
const WORK_FIELDS = "courseWork(id,title,workType,maxPoints,dueDate,dueTime,alternateLink,gradeCategory(id),updateTime,creationTime),nextPageToken";
const SUB_FIELDS = "studentSubmissions(id,courseWorkId,state,late,assignedGrade,alternateLink,updateTime),nextPageToken";
const ANN_FIELDS = "announcements(id,text,alternateLink,updateTime),nextPageToken";

/** The student's active classes (first 12, in Classroom's order). Throws when Classroom can't be read at all. */
export async function listCourses(accessToken: string, budget: CallBudget): Promise<Raw[]> {
  const { items } = await classroomList("/courses", "courses", { studentId: "me", courseStates: "ACTIVE", pageSize: "50", fields: COURSE_FIELDS }, accessToken, budget, 2);
  return items.filter((c) => CLASSROOM_ID_RE.test(String(c.id ?? ""))).slice(0, MAX_COURSES);
}

export interface CourseRaw {
  course: Raw;
  work: Raw[] | null;
  submissions: Raw[] | null;
  announcements: Raw[] | null;
  complete: boolean;
  /**
   * Every page of the student's submissions arrived. When not, work with no
   * submission in hand is NOT called missing: it may well be turned in.
   */
  submissionsComplete?: boolean;
}

/**
 * Everything the bundle needs. Classes are required; a class whose
 * coursework can't be read keeps its name and shows no grade.
 *
 * Every class's first page comes first; then, while budget is left, the
 * classes with more coursework or submissions get their next pages, so one
 * class with a long history can't use up the calls the others need.
 */
export async function fetchClassroomBundle(accessToken: string, letters: string, budget: CallBudget): Promise<CourseRaw[]> {
  const courses = await listCourses(accessToken, budget);
  const enc = encodeURIComponent;
  const workList = (id: string, token = "") => classroomList(`/courses/${id}/courseWork`, "courseWork", { pageSize: "100", fields: WORK_FIELDS }, accessToken, budget, 1, token);
  const subList = (id: string, token = "") => classroomList(`/courses/${id}/courseWork/-/studentSubmissions`, "studentSubmissions", { userId: "me", pageSize: "100", fields: SUB_FIELDS }, accessToken, budget, 1, token);
  const first = await Promise.all(
    courses.map(async (course) => {
      const id = enc(String(course.id));
      const [work, submissions, announcements] = await Promise.all([
        workList(id).catch(() => null),
        subList(id).catch(() => null),
        letters.includes("a")
          ? classroomList(`/courses/${id}/announcements`, "announcements", { pageSize: "10", fields: ANN_FIELDS }, accessToken, budget, 1).catch(() => null)
          : Promise.resolve({ items: [], next: "" }),
      ]);
      return { course, id, work, submissions, announcements };
    })
  );
  // More pages, one at a time per list, while there's budget.
  for (let round = 0; round < 3; round++) {
    const pending = first.filter((c) => (c.work?.next && !(c.work as any).failed) || (c.submissions?.next && !(c.submissions as any).failed));
    if (pending.length === 0 || budget.left <= 0) break;
    for (const c of pending) {
      for (const which of ["work", "submissions"] as const) {
        const list = c[which] as ({ items: Raw[]; next: string; failed?: boolean } | null);
        if (!list?.next || list.failed || budget.left <= 0) continue;
        const more = await (which === "work" ? workList(c.id, list.next) : subList(c.id, list.next)).catch(() => null);
        if (!more) {
          // Keep the pages already here; this list just stays incomplete (its `next` is kept).
          list.failed = true;
          continue;
        }
        list.items.push(...more.items);
        list.next = more.next;
      }
    }
  }
  return first.map((c) => ({
    course: c.course,
    work: c.work?.items ?? null,
    submissions: c.submissions?.items ?? null,
    announcements: c.announcements?.items ?? null,
    complete: !!c.work && !!c.submissions && !c.work.next && !c.submissions.next,
    submissionsComplete: !!c.submissions && !c.submissions.next,
  }));
}

/* ── Dates ─────────────────────────────────────────────────────────────── */

/** The student's time zone if it's one this runtime knows, else UTC. */
export function safeTimeZone(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c !== "string" || !c || c.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(c)) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: c });
      return c;
    } catch {
      /* not a zone this runtime knows */
    }
  }
  return "UTC";
}

/** A due date + time (both UTC in Classroom) as ms, or null. No time means the end of that UTC day. */
export function dueMs(work: Raw): number | null {
  const d = work?.dueDate;
  if (!d || typeof d !== "object") return null;
  const y = Number(d.year), m = Number(d.month), day = Number(d.day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(day) || y < 1970 || m < 1 || m > 12 || day < 1 || day > 31) return null;
  const t = work?.dueTime && typeof work.dueTime === "object" ? work.dueTime : null;
  const hours = t ? Number(t.hours ?? 0) || 0 : 23;
  const minutes = t ? Number(t.minutes ?? 0) || 0 : 59;
  return Date.UTC(y, m - 1, day, hours, minutes);
}

export function timeMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * One formatter per zone and shape, reused: building an Intl.DateTimeFormat
 * is slow, and a bundle formats a few hundred dates inside the Worker's short
 * CPU allowance (second-pass review, 2026-10-05).
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string, kind: "day" | "key"): Intl.DateTimeFormat {
  const id = `${kind}|${tz}`;
  let f = FORMATTERS.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", kind === "day"
      ? { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" }
      : { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" });
    if (FORMATTERS.size > 50) FORMATTERS.clear();
    FORMATTERS.set(id, f);
  }
  return f;
}

/**
 * Every time zone's offset is a multiple of 15 minutes, so the local date is
 * the same for a whole UTC quarter-hour. Classroom work tends to share due
 * times, so formatting each quarter-hour once saves most of the work.
 */
const QUARTER_HOUR = 15 * 60 * 1000;
const PARTS = new Map<string, Record<string, string>>();
function parts(ms: number, tz: string): Record<string, string> {
  const key = `${tz}|${Math.floor(ms / QUARTER_HOUR)}`;
  let out = PARTS.get(key);
  if (!out) {
    out = {};
    for (const p of formatter(tz, "day").formatToParts(new Date(ms))) out[p.type] = p.value;
    if (PARTS.size > 5000) PARTS.clear();
    PARTS.set(key, out);
  }
  return out;
}

/** "Fri Aug 21", the format the lists render, in the student's time zone. */
export function formatDueIn(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.weekday} ${p.month} ${p.day}`;
}

/** "Aug 4", the prediction chart's axis format. */
export function formatShortIn(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.month} ${p.day}`;
}

/** The calendar day (YYYY-M-D) of an instant in the student's time zone. */
export function dayKey(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${MONTH_NUMBER[p.month] ?? p.month}-${p.day}`;
}
const MONTH_NUMBER: Record<string, string> = { Jan: "1", Feb: "2", Mar: "3", Apr: "4", May: "5", Jun: "6", Jul: "7", Aug: "8", Sep: "9", Oct: "10", Nov: "11", Dec: "12" };

/** "2h ago", the "Updated" column's format. */
export function relativeFrom(ms: number | null, now: number, tz: string): string {
  if (ms === null) return "";
  const seconds = Math.floor((now - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatShortIn(ms, tz);
}

/* ── Text ──────────────────────────────────────────────────────────────── */

/**
 * Classroom text is plain text (no HTML), so unlike Schoology's nothing is
 * stripped: control characters go, whitespace collapses, and the page escapes
 * it when it renders.
 */
export function plain(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, max).join("");
}

/** Like plain(), but keeps line breaks (at most one blank line in a row): for descriptions. */
export function paragraphs(value: unknown, max: number): string {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return Array.from(text).slice(0, max).join("");
}

/** Only http(s) links ever reach the page. */
export function safeUrl(value: unknown): string {
  const s = String(value ?? "").trim();
  if (s.length > 2048 || !/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

/** Only links into Classroom itself, for the Turn in button. */
export function classroomUrl(value: unknown): string {
  const s = safeUrl(value);
  return /^https:\/\/classroom\.google\.com\//.test(s) ? s : "";
}

/* ── Grades ────────────────────────────────────────────────────────────── */

const DONE_STATES = new Set(["TURNED_IN", "RETURNED"]);

export interface GradedItem {
  earned: number;
  possible: number;
  category: string;
  at: number;
}

/** A returned grade on work worth points, else null. Students only ever see `assignedGrade`. */
export function gradedItem(work: Raw, sub: Raw | undefined): GradedItem | null {
  const possible = Number(work?.maxPoints);
  const earned = sub ? Number(sub.assignedGrade) : NaN;
  if (!sub || sub.assignedGrade === undefined || sub.assignedGrade === null) return null;
  if (!Number.isFinite(possible) || possible <= 0 || !Number.isFinite(earned) || earned < 0) return null;
  const at = timeMs(sub.updateTime) ?? dueMs(work) ?? timeMs(work.updateTime) ?? 0;
  return { earned, possible, category: String(work?.gradeCategory?.id ?? ""), at };
}

/**
 * The overall grade the way Classroom works it out: total points, or the
 * weighted average of category averages (weights of categories with no grades
 * yet are left out and the rest scaled up, as Classroom does). Work with no
 * category doesn't count toward a weighted grade. Null when nothing's graded.
 */
export function overallPct(items: GradedItem[], settings: Raw | undefined): number | null {
  if (items.length === 0) return null;
  const weighted = settings?.calculationType === "WEIGHTED_CATEGORIES";
  if (weighted) {
    const weights = new Map<string, number>();
    for (const cat of Array.isArray(settings?.gradeCategories) ? settings.gradeCategories : []) {
      const w = Number(cat?.weight);
      if (cat?.id && Number.isFinite(w) && w > 0) weights.set(String(cat.id), w);
    }
    const sums = new Map<string, { earned: number; possible: number }>();
    for (const it of items) {
      if (!weights.has(it.category)) continue;
      const s = sums.get(it.category) ?? { earned: 0, possible: 0 };
      s.earned += it.earned;
      s.possible += it.possible;
      sums.set(it.category, s);
    }
    let total = 0;
    let weightUsed = 0;
    for (const [cat, s] of sums) {
      if (s.possible <= 0) continue;
      const w = weights.get(cat)!;
      total += (s.earned / s.possible) * w;
      weightUsed += w;
    }
    // Weighted, but nothing graded is in a weighted category yet: no overall grade (as in Classroom).
    return weightUsed > 0 ? Math.round((total / weightUsed) * 1000) / 10 : null;
  }
  const earned = items.reduce((a, it) => a + it.earned, 0);
  const possible = items.reduce((a, it) => a + it.possible, 0);
  return possible > 0 ? Math.round((earned / possible) * 1000) / 10 : null;
}

/* ── The bundle ────────────────────────────────────────────────────────── */

export interface ClassroomCourse extends AdaptedCourse {
  platform: "classroom";
  /** False when nothing has been graded yet (grade shows "—"). */
  graded: boolean;
  link: string;
}

export interface ClassroomItem {
  type: "assignment" | "assessment";
  title: string;
  courseId: string;
  due: string;
  dueAt: string;
  id: string;
  platform: "classroom";
}

/**
 * Classroom has no quiz type (a quiz is an assignment with a Google Form), so
 * a title that says quiz/test/exam marks it as one, for Home's "Next test".
 */
export function itemType(title: string): "assignment" | "assessment" {
  return /\b(quiz|quizzes|test|exam|midterm)\b/i.test(title) ? "assessment" : "assignment";
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function adaptClassroomBundle(raw: CourseRaw[], now: number, tz: string) {
  const COURSES: ClassroomCourse[] = [];
  const HISTORY: Record<string, { points: number[]; dates: string[] }> = {};
  const overdue: { at: number; item: ClassroomItem }[] = [];
  const upcoming: { at: number; item: ClassroomItem }[] = [];
  const submitted: { at: number; item: Raw }[] = [];
  const TODAY: { title: string; courseId: string; id?: string }[] = [];
  const announcements: { at: number; update: Raw }[] = [];
  const recentGrades: { at: number; grade: Raw }[] = [];
  const GRADEBOOK: Record<string, { categories: GradebookCategory[] }> = {};
  let partial = false;
  const today = dayKey(now, tz);

  for (const entry of raw) {
    const course = entry.course;
    const courseId = String(course.id);
    const name = plain(course.name, 120) || "Untitled class";
    if (!entry.complete || entry.work === null || entry.submissions === null || entry.announcements === null) partial = true;

    // Unknown (not "missing") when the submissions list didn't fully arrive.
    const subsKnown = entry.submissions !== null && entry.submissionsComplete !== false;
    const subs = new Map<string, Raw>();
    for (const s of entry.submissions ?? []) {
      const key = String(s?.courseWorkId ?? "");
      if (key) subs.set(key, s);
    }

    const graded: (GradedItem & { title: string; id: string })[] = [];
    const pointsWork: GradebookRow[] = [];
    for (const work of entry.work ?? []) {
      const id = String(work?.id ?? "");
      if (!CLASSROOM_ID_RE.test(id)) continue;
      const sub = subs.get(id);
      const title = plain(work.title, 200) || "Untitled";
      const g = gradedItem(work, sub);
      if (g) graded.push({ ...g, title, id });
      const possible = Number(work.maxPoints);
      if (Number.isFinite(possible) && possible > 0) {
        pointsWork.push({
          row: g ? { title, score: g.earned, points: possible, graded: true, id } : { title, points: possible, graded: false, id },
          category: String(work?.gradeCategory?.id ?? ""),
          at: dueMs(work) ?? timeMs(work.creationTime) ?? timeMs(work.updateTime) ?? Number.MAX_SAFE_INTEGER,
        });
      }

      const state = String(sub?.state ?? "");
      const done = DONE_STATES.has(state) || !!g;
      const due = dueMs(work);
      // Built only for work that's listed (formatting dates costs CPU).
      const listed = (): ClassroomItem => ({
        type: itemType(title),
        title,
        courseId,
        due: due === null ? "" : formatDueIn(due, tz),
        dueAt: due === null ? "" : new Date(due).toISOString(),
        id,
        platform: "classroom",
      });

      if (state === "TURNED_IN" && !g) {
        const at = timeMs(sub?.updateTime) ?? due ?? 0;
        submitted.push({ at, item: { type: itemType(title), title, courseId, submittedOn: at ? formatDueIn(at, tz) : "", id, platform: "classroom" } });
      }
      // Undated work isn't in either list (same as Schoology).
      if (due === null || done) continue;
      if (due < now) {
        if (sub || subsKnown) overdue.push({ at: due, item: listed() });
      } else upcoming.push({ at: due, item: listed() });
      // With its id (2026-10-07): Home links to it as assignment?id=<id>.
      if (dayKey(due, tz) === today && (sub || subsKnown)) TODAY.push({ title, courseId, id });
    }

    for (const g of graded) {
      const pct = Math.round((g.earned / g.possible) * 100);
      recentGrades.push({
        at: g.at,
        grade: {
          title: g.title,
          courseId,
          letter: letterFromPct(pct),
          pct,
          pts: `${trimNumber(g.earned)}/${trimNumber(g.possible)}`,
          when: relativeFrom(g.at || null, now, tz),
          isNew: g.at > now - 2 * DAY_MS,
          id: g.id,
        },
      });
    }

    GRADEBOOK[courseId] = { categories: gradebookCategories(pointsWork, course.gradebookSettings) };

    graded.sort((a, b) => a.at - b.at);
    const recent = graded.slice(-5);
    HISTORY[courseId] = {
      points: recent.map((g) => Math.round((g.earned / g.possible) * 100)),
      dates: recent.map((g) => (g.at ? formatShortIn(g.at, tz) : "")),
    };

    // A teacher can hide the overall grade from students in Classroom; it's
    // hidden here too (Google: respect displaySetting). Individual grades
    // still show, as they do in Classroom.
    const hidden = ["HIDE_OVERALL_GRADE", "SHOW_TEACHERS_ONLY"].includes(String(course.gradebookSettings?.displaySetting ?? ""));
    const pct = hidden ? null : overallPct(graded, course.gradebookSettings);
    const { predictedPct, trend } = predict(HISTORY[courseId].points);
    const latest = Math.max(timeMs(course.updateTime) ?? 0, ...graded.map((g) => g.at));
    COURSES.push({
      id: courseId,
      name,
      color: colorForCourse(courseId),
      grade: pct === null ? "—" : letterFromPct(pct),
      pct: pct === null ? 0 : Math.round(pct),
      predicted: pct === null ? "—" : letterFromPct(predictedPct || pct),
      predictedPct: pct === null ? 0 : predictedPct || Math.round(pct),
      trend,
      updated: relativeFrom(latest || null, now, tz),
      code: "",
      period: parsePeriod(course.section),
      section: classroomSection(course.section, course.room, name),
      teacher: "",
      platform: "classroom",
      graded: pct !== null,
      link: classroomUrl(course.alternateLink),
    });

    // Teachers' announcements are Home's "Course updates". (Classroom has no
    // messages, so MESSAGES stays empty.)
    for (const a of entry.announcements ?? []) {
      const at = timeMs(a?.updateTime) ?? 0;
      const body = plain(a?.text, 280);
      if (!body) continue;
      announcements.push({
        at,
        update: {
          from: "Announcement",
          courseId,
          body,
          when: relativeFrom(at || null, now, tz),
          unread: at > now - DAY_MS,
          id: String(a?.id ?? ""),
          link: classroomUrl(a?.alternateLink),
        },
      });
    }
  }

  overdue.sort((a, b) => a.at - b.at);
  upcoming.sort((a, b) => a.at - b.at);
  submitted.sort((a, b) => b.at - a.at);
  announcements.sort((a, b) => b.at - a.at);
  recentGrades.sort((a, b) => b.at - a.at);

  return {
    COURSES,
    HISTORY,
    OVERDUE: overdue.map((x) => x.item),
    UPCOMING: upcoming.slice(0, 25).map((x) => x.item),
    TODAY,
    SUBMITTED: submitted.slice(0, 25).map((x) => x.item),
    // Classroom has no messages or contact list: empty, so those pages show
    // their empty states instead of the preview's sample teachers.
    MESSAGES: [] as Raw[],
    CONVERSATIONS: [] as Raw[],
    CONTACTS: [] as Raw[],
    TEACHERS: {} as Raw,
    COURSE_UPDATES: announcements.slice(0, 20).map((x) => x.update),
    GRADEBOOK,
    RECENT_GRADES: recentGrades.slice(0, 10).map((x) => x.grade),
    // Only classes with grades count: a new class with nothing graded isn't an F.
    projectedGPA: computeProjectedGPA(COURSES.filter((c) => c.graded)),
    partial,
  };
}

export interface GradebookCategory {
  name: string;
  /** Percent of the overall grade. */
  weight: number;
  assignments: ({ title: string; score?: number; points: number; graded: boolean; id: string })[];
}
interface GradebookRow {
  row: GradebookCategory["assignments"][number];
  category: string;
  at: number;
}

/** Most graded items listed per category on a course's Grades tab. */
const GRADEBOOK_PER_CATEGORY = 60;

/**
 * A course's Grades tab (the gradebook page's GRADEBOOK shape): the class's
 * weighted categories, in the teacher's order, with the work worth points in
 * each (oldest first); work with no category goes in "No category" (it
 * doesn't count toward a weighted grade). A total-points class is one "All
 * work" group worth 100%.
 */
export function gradebookCategories(rows: GradebookRow[], settings: Raw | undefined): GradebookCategory[] {
  rows.sort((a, b) => a.at - b.at);
  const list = (rs: GradebookRow[]) => rs.slice(-GRADEBOOK_PER_CATEGORY).map((r) => r.row);
  if (settings?.calculationType === "WEIGHTED_CATEGORIES" && Array.isArray(settings.gradeCategories)) {
    const cats: GradebookCategory[] = [];
    const known = new Set<string>();
    for (const cat of settings.gradeCategories) {
      const id = String(cat?.id ?? "");
      if (!id || known.has(id)) continue;
      known.add(id);
      const w = Number(cat?.weight);
      cats.push({ name: plain(cat?.name, 80) || "Category", weight: Number.isFinite(w) && w > 0 ? Math.round(w / 100) / 100 : 0, assignments: list(rows.filter((r) => r.category === id)) });
    }
    const other = rows.filter((r) => !known.has(r.category));
    if (other.length) cats.push({ name: "No category", weight: 0, assignments: list(other) });
    return cats;
  }
  return [{ name: "All work", weight: 100, assignments: list(rows) }];
}

/**
 * A Classroom class's section line (2026-10-06): its "Section" text when that
 * says more than the period, else its room ("Room 214" when the room is just
 * a number).
 */
export function classroomSection(section: unknown, room: unknown, name: string): string {
  const label = sectionLabel(plain(section, 120), name);
  if (label) return label;
  const r = plain(room, 60);
  return /^[0-9][0-9A-Za-z-]*$/.test(r) ? `Room ${r}` : r;
}

/** 18 -> "18", 7.5 -> "7.5" (Classroom grades have at most two decimals). */
function trimNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/* ── One assignment ────────────────────────────────────────────────────── */

export interface ClassroomMaterial {
  kind: "drive" | "youtube" | "link" | "form";
  title: string;
  url: string;
}

/** A Classroom material as a link the page can open (Drive files open in Google Drive). */
export function materialLink(m: Raw): ClassroomMaterial | null {
  if (m?.driveFile?.driveFile) {
    const f = m.driveFile.driveFile;
    const url = safeUrl(f.alternateLink);
    return url ? { kind: "drive", title: plain(f.title, 255) || "Google Drive file", url } : null;
  }
  if (m?.youtubeVideo) {
    const url = safeUrl(m.youtubeVideo.alternateLink);
    return url ? { kind: "youtube", title: plain(m.youtubeVideo.title, 255) || "YouTube video", url } : null;
  }
  if (m?.form) {
    const url = safeUrl(m.form.formUrl);
    return url ? { kind: "form", title: plain(m.form.title, 255) || "Google Form", url } : null;
  }
  if (m?.link) {
    const url = safeUrl(m.link.url);
    return url ? { kind: "link", title: plain(m.link.title, 255) || url, url } : null;
  }
  return null;
}

const SUBMISSION_STATE: Record<string, string> = {
  NEW: "not_turned_in",
  CREATED: "not_turned_in",
  RECLAIMED_BY_STUDENT: "not_turned_in",
  TURNED_IN: "turned_in",
  RETURNED: "returned",
};

export async function fetchClassroomAssignment(courseId: string, workId: string, accessToken: string): Promise<{ work: Raw; submission: Raw | undefined | null }> {
  const budget = new CallBudget(3);
  const enc = encodeURIComponent;
  const [work, subs] = await Promise.all([
    classroomGet(`/courses/${enc(courseId)}/courseWork/${enc(workId)}`, { fields: "id,courseId,title,description,materials,dueDate,dueTime,maxPoints,alternateLink,updateTime" }, accessToken, budget),
    classroomGet(`/courses/${enc(courseId)}/courseWork/${enc(workId)}/studentSubmissions`, { userId: "me", fields: "studentSubmissions(id,state,late,assignedGrade,alternateLink,updateTime)" }, accessToken, budget).catch(() => null),
  ]);
  // null: couldn't tell (the page keeps the status it already had); undefined: no submission yet.
  if (subs === null) return { work, submission: null };
  const list = Array.isArray(subs.studentSubmissions) ? subs.studentSubmissions : [];
  return { work, submission: list[0] };
}

export function adaptClassroomAssignment(work: Raw, sub: Raw | undefined | null, courseId: string, tz: string) {
  const materials = (Array.isArray(work?.materials) ? work.materials : []).map(materialLink).filter((m: ClassroomMaterial | null): m is ClassroomMaterial => m !== null).slice(0, 20);
  const due = dueMs(work);
  const possible = Number(work?.maxPoints);
  const grade = sub && sub.assignedGrade !== undefined && sub.assignedGrade !== null && Number.isFinite(Number(sub.assignedGrade)) ? Number(sub.assignedGrade) : null;
  return {
    id: String(work?.id ?? ""),
    sectionId: courseId,
    title: plain(work?.title, 200) || "Untitled",
    description: paragraphs(work?.description, 20000),
    due: due === null ? "" : formatDueIn(due, tz),
    dueAt: due === null ? "" : new Date(due).toISOString(),
    type: "assignment",
    // Classroom files live in Google Drive: they open there, never through our server.
    files: [],
    links: materials.map((m: ClassroomMaterial) => ({ title: m.title, url: m.url })),
    materials,
    platform: "classroom",
    classroomUrl: classroomUrl(sub?.alternateLink) || classroomUrl(work?.alternateLink),
    submission: {
      state: sub === null ? "unknown" : SUBMISSION_STATE[String(sub?.state ?? "")] ?? "not_turned_in",
      late: sub?.late === true,
      grade,
      maxPoints: Number.isFinite(possible) && possible > 0 ? possible : null,
    },
  };
}

/* ── Files page ────────────────────────────────────────────────────────── */

export interface ClassroomFile {
  id: string;
  name: string;
  ext: string;
  size: number;
  course: string;
  kind: "material" | "assignment";
  parent: string;
  parentTitle: string;
  at: number;
  url: string;
}

/** Google's own file types have no extension; the link says which they are. */
export function driveExt(title: string, url: string): string {
  if (/^https:\/\/docs\.google\.com\/document\//.test(url)) return "gdoc";
  if (/^https:\/\/docs\.google\.com\/spreadsheets\//.test(url)) return "gsheet";
  if (/^https:\/\/docs\.google\.com\/presentation\//.test(url)) return "gslides";
  if (/^https:\/\/docs\.google\.com\/drawings\//.test(url)) return "gdraw";
  const m = title.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}

export async function fetchClassroomFiles(accessToken: string, letters: string, budget: CallBudget): Promise<{ courses: Raw[]; byCourse: Record<string, { materials: Raw[] | null; work: Raw[] | null }>; complete: boolean }> {
  const courses = await listCourses(accessToken, budget);
  const byCourse: Record<string, { materials: Raw[] | null; work: Raw[] | null }> = {};
  let complete = true;
  const enc = encodeURIComponent;
  await Promise.all(
    courses.map(async (course) => {
      const id = enc(String(course.id));
      const [materials, work] = await Promise.all([
        letters.includes("m")
          ? classroomList(`/courses/${id}/courseWorkMaterials`, "courseWorkMaterial", { pageSize: "100", fields: "courseWorkMaterial(id,title,materials,updateTime),nextPageToken" }, accessToken, budget, 2).catch(() => null)
          : Promise.resolve({ items: [], next: "" }),
        classroomList(`/courses/${id}/courseWork`, "courseWork", { pageSize: "100", fields: "courseWork(id,title,materials,updateTime),nextPageToken" }, accessToken, budget, 2).catch(() => null),
      ]);
      if (!materials || !work || materials.next || work.next) complete = false;
      byCourse[String(course.id)] = { materials: materials?.items ?? null, work: work?.items ?? null };
    })
  );
  return { courses, byCourse, complete };
}

export const MAX_CLASSROOM_FILES = 1000;

/** Every Google Drive file posted in the student's classes, newest first, as links. */
export function adaptClassroomFiles(byCourse: Record<string, { materials: Raw[] | null; work: Raw[] | null }>): { files: ClassroomFile[]; partial: boolean } {
  const files: ClassroomFile[] = [];
  const seen = new Set<string>();
  let partial = false;
  for (const [course, lists] of Object.entries(byCourse)) {
    if (!lists.materials || !lists.work) partial = true;
    for (const [kind, list] of [["material", lists.materials ?? []], ["assignment", lists.work ?? []]] as const) {
      for (const item of list) {
        const parent = String(item?.id ?? "");
        if (!CLASSROOM_ID_RE.test(parent)) continue;
        const parentTitle = plain(item?.title, 255) || (kind === "material" ? "Material" : "Assignment");
        const at = timeMs(item?.updateTime) ?? 0;
        for (const m of Array.isArray(item?.materials) ? item.materials : []) {
          const f = m?.driveFile?.driveFile;
          if (!f) continue;
          const id = String(f.id ?? "");
          const url = safeUrl(f.alternateLink);
          if (!/^[A-Za-z0-9_-]{10,128}$/.test(id) || !url) continue;
          const key = `${course}|${parent}|${id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const name = plain(f.title, 240) || "Google Drive file";
          files.push({ id, name, ext: driveExt(name, url), size: 0, course, kind, parent, parentTitle, at, url });
        }
      }
    }
  }
  files.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  if (files.length > MAX_CLASSROOM_FILES) partial = true;
  return { files: files.slice(0, MAX_CLASSROOM_FILES), partial };
}
