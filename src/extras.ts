/**
 * Per-page extras (2026-10-06): what some pages need beyond GET /data/bundle,
 * loaded by the app in parallel with it and cached in the browser for a few
 * minutes (see WAVES-CONTRACT "Extras endpoints"). Each one reads only what
 * its page shows, maps it into the page's existing sample-data shape, and
 * stores nothing.
 *
 *   people    the student's teachers (Contacts, course cards, Messages)
 *   updates   teachers' posts in each class (Home, course home)
 *   events    the calendar
 *   folders   a class's folders, for Materials
 *   gradebook one class's grading categories with exact weights
 *
 * Fetching follows the same limits as the bundle: at most 12 classes, and
 * never more than 3 Schoology calls in flight (Schoology's rate limit is
 * unpublished). A class that fails is left out and the answer says
 * `partial: true`.
 *
 * Personal Schoology API keys are often refused (401/403) when reading other
 * people's data, such as a class's enrollments. A refused call is treated as
 * "nothing to show" (no names), never as a failure.
 *
 * Privacy: enrollments are read with `type=admin` (the teachers) and every
 * row that isn't an admin is dropped again here, so a classmate's name never
 * comes from this module's roster reads.
 */

import { adaptCourses, adaptSchoologyGradebook, clip, colorForCourse, relativeTime, schoologyTime, toPlainText } from "./adapt.ts";
import { CallBudget, CLASSROOM_ID_RE, ClassroomError, classroomList, dueMs, itemType, listCourses, plain, type GradebookCategory } from "./classroom.ts";
import type { Credentials } from "./oauth.ts";
import { getAssignments, getSections, listOf, SchoologyError, schoologyGet } from "./schoology.ts";

type Raw = Record<string, any>;

export const MAX_SECTIONS = 12;
export const SCHOOLOGY_CONCURRENCY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Schoology ids are plain numbers. */
export const SCHOOLOGY_ID_RE = /^\d{1,20}$/;

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Schoology refused to show this (401/403): "nothing here" for an extra, not a failure. */
export function refused(error: unknown): boolean {
  return error instanceof SchoologyError && (error.status === 401 || error.status === 403);
}

export interface ExtraCourse {
  id: string;
  name: string;
  color: string;
}

/** The student's first 12 classes (same as the bundle), names and colors only. */
async function schoologyCourses(uid: string, creds: Credentials): Promise<ExtraCourse[]> {
  const { COURSES } = adaptCourses(await getSections(uid, creds), []);
  return COURSES.slice(0, MAX_SECTIONS).map((c) => ({ id: c.id, name: c.name, color: c.color }));
}

/* ── People ────────────────────────────────────────────────────────────── */

export interface Teacher {
  id: string;
  name: string;
}

export interface PeopleAnswer {
  platform: "schoology" | "classroom";
  TEACHERS: Record<string, { name: string; course: string; color: string }>;
  CONTACTS: {
    id: string;
    name: string;
    role: string;
    dept: string;
    school: string;
    email: string;
    phone: string;
    color: string;
    category: "myTeachers";
    courses: string[];
  }[];
  courseTeachers: Record<string, string>;
  needsPermission: boolean;
  partial: boolean;
}

export async function getAdminEnrollments(sectionId: string, creds: Credentials): Promise<Raw[]> {
  const payload = await schoologyGet(`/sections/${sectionId}/enrollments`, creds, { type: "admin", limit: 50 });
  return listOf(payload, "enrollment");
}

/**
 * A section's teachers from its enrollments: admins only (admin = 1), active
 * ones (status 1 when given), never the student themself. Everyone else is
 * dropped here even though the request already asked for admins only.
 */
export function teacherRows(enrollments: Raw[], me: string): Teacher[] {
  const out: Teacher[] = [];
  for (const e of enrollments) {
    if (String(e?.admin ?? "") !== "1") continue;
    if (e?.status !== undefined && e?.status !== null && String(e.status) !== "1") continue;
    const id = String(e?.uid ?? "");
    if (!SCHOOLOGY_ID_RE.test(id) || id === me || out.some((t) => t.id === id)) continue;
    const name = clip(toPlainText(e?.name_display ?? "") || toPlainText(`${e?.name_first ?? ""} ${e?.name_last ?? ""}`), 120) || "Teacher";
    out.push({ id, name });
  }
  return out;
}

/** A Classroom class's teachers (GET /courses/{id}/teachers). */
export function classroomTeacherRows(teachers: Raw[]): Teacher[] {
  const out: Teacher[] = [];
  for (const t of teachers) {
    const id = String(t?.userId ?? t?.profile?.id ?? "");
    if (!CLASSROOM_ID_RE.test(id) || out.some((x) => x.id === id)) continue;
    out.push({ id, name: plain(t?.profile?.name?.fullName, 120) || "Teacher" });
  }
  return out;
}

/**
 * The people answer, the same for both platforms. `byCourse[id]` is that
 * class's teachers, or null when they couldn't be read (partial). A teacher
 * of several classes is one contact whose `dept` lists the classes; the
 * course card shows up to two teachers' names.
 */
export function adaptPeople(platform: "schoology" | "classroom", courses: ExtraCourse[], byCourse: Record<string, Teacher[] | null>, needsPermission = false): PeopleAnswer {
  const TEACHERS: PeopleAnswer["TEACHERS"] = {};
  const contacts = new Map<string, PeopleAnswer["CONTACTS"][number] & { names: string[] }>();
  const courseTeachers: Record<string, string> = {};
  let partial = false;
  for (const course of courses) {
    const teachers = byCourse[course.id];
    if (teachers === null || teachers === undefined) {
      if (teachers === null) partial = true;
      continue;
    }
    if (teachers.length) courseTeachers[course.id] = teachers.slice(0, 2).map((t) => t.name).join(", ");
    for (const t of teachers) {
      let contact = contacts.get(t.id);
      if (!contact) {
        contact = { id: t.id, name: t.name, role: "Teacher", dept: "", school: "", email: "", phone: "", color: course.color, category: "myTeachers", courses: [], names: [] };
        contacts.set(t.id, contact);
        TEACHERS[t.id] = { name: t.name, course: course.id, color: course.color };
      }
      if (!contact.courses.includes(course.id)) {
        contact.courses.push(course.id);
        contact.names.push(course.name);
      }
    }
  }
  const CONTACTS = [...contacts.values()].map(({ names, ...c }) => ({ ...c, dept: clip(names.join(", "), 200) }));
  return { platform, TEACHERS, CONTACTS, courseTeachers, needsPermission, partial };
}

export async function fetchSchoologyPeople(uid: string, creds: Credentials): Promise<PeopleAnswer> {
  const courses = await schoologyCourses(uid, creds);
  const byCourse: Record<string, Teacher[] | null> = {};
  await runPool(courses, SCHOOLOGY_CONCURRENCY, async (course) => {
    try {
      byCourse[course.id] = teacherRows(await getAdminEnrollments(course.id, creds), uid);
    } catch (error) {
      byCourse[course.id] = refused(error) ? [] : null;
    }
  });
  return adaptPeople("schoology", courses, byCourse);
}

/** Classroom teachers need the optional rosters permission (letter `r`); without it, nothing and needsPermission. */
export async function fetchClassroomPeople(accessToken: string, letters: string, budget: CallBudget): Promise<PeopleAnswer> {
  if (!letters.includes("r")) return adaptPeople("classroom", [], {}, true);
  const raw = await listCourses(accessToken, budget);
  const courses = raw.map((c) => ({ id: String(c.id), name: plain(c.name, 120) || "Untitled class", color: colorForCourse(String(c.id)) }));
  const byCourse: Record<string, Teacher[] | null> = {};
  await Promise.all(
    courses.map(async (course) => {
      try {
        const { items } = await classroomList(`/courses/${encodeURIComponent(course.id)}/teachers`, "teachers", { pageSize: "30", fields: "teachers(userId,profile(id,name(fullName))),nextPageToken" }, accessToken, budget, 1);
        byCourse[course.id] = classroomTeacherRows(items);
      } catch (error) {
        // A class whose roster can't be shown to students: no names there.
        byCourse[course.id] = error instanceof ClassroomError && (error.status === 403 || error.status === 404) ? [] : null;
      }
    })
  );
  return adaptPeople("classroom", courses, byCourse);
}

/* ── Course updates ────────────────────────────────────────────────────── */

export interface CourseUpdate {
  from: string;
  courseId: string;
  body: string;
  when: string;
  unread: boolean;
  id: string;
  at: number;
}

export async function getSectionUpdates(sectionId: string, creds: Credentials): Promise<Raw[]> {
  return listOf(await schoologyGet(`/sections/${sectionId}/updates`, creds, { limit: 5 }), "update");
}

/**
 * Home's and course home's Course updates for Schoology: each class's
 * newest posts, newest first, at most 30. Named by Schoology's display_name,
 * else the teacher's name from the class's admins, else "Classmate" (the
 * class's admins are known and the poster isn't one) or "Your teacher".
 * Posted in the last 24 hours counts as unread.
 */
export function adaptUpdates(
  updates: Record<string, Raw[] | null>,
  admins: Record<string, Teacher[] | null>,
  now: number = Date.now(),
  /** The student's own id: their own posts say "You", not "Classmate" (2026-10-06 review). */
  me = ""
): { COURSE_UPDATES: CourseUpdate[]; partial: boolean } {
  const out: CourseUpdate[] = [];
  let partial = false;
  for (const [courseId, list] of Object.entries(updates)) {
    if (list === null) {
      partial = true;
      continue;
    }
    const known = admins[courseId] ?? null;
    for (const u of list) {
      const id = String(u?.id ?? "");
      if (!SCHOOLOGY_ID_RE.test(id)) continue;
      const body = clip(toPlainText(u?.body ?? ""), 280);
      if (!body) continue;
      const at = schoologyTime(u?.created ?? u?.last_updated) ?? 0;
      const uid = String(u?.uid ?? "");
      const admin = known?.find((t) => t.id === uid);
      const from =
        clip(toPlainText(u?.display_name ?? ""), 120) ||
        (me && uid === me ? "You" : "") ||
        admin?.name ||
        (known && known.length > 0 && !admin ? "Classmate" : "Your teacher");
      out.push({ from, courseId, body, when: at ? relativeTime(String(Math.floor(at / 1000)), now) : "", unread: at > now - DAY_MS, id, at });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return { COURSE_UPDATES: out.slice(0, 30), partial };
}

export async function fetchSchoologyUpdates(uid: string, creds: Credentials, now = Date.now()) {
  const courses = await schoologyCourses(uid, creds);
  const updates: Record<string, Raw[] | null> = {};
  await runPool(courses, SCHOOLOGY_CONCURRENCY, async (course) => {
    try {
      updates[course.id] = await getSectionUpdates(course.id, creds);
    } catch (error) {
      updates[course.id] = refused(error) ? [] : null;
    }
  });
  // The teachers' names, only for classes with a post that doesn't carry one.
  const needNames = courses.filter((c) => (updates[c.id] ?? []).some((u) => !toPlainText(u?.display_name ?? "")));
  const admins: Record<string, Teacher[] | null> = {};
  await runPool(needNames, SCHOOLOGY_CONCURRENCY, async (course) => {
    try {
      admins[course.id] = teacherRows(await getAdminEnrollments(course.id, creds), uid);
    } catch {
      admins[course.id] = null; // unknown: their posts say "Your teacher"
    }
  });
  return adaptUpdates(updates, admins, now, uid);
}

/* ── Events ────────────────────────────────────────────────────────────── */

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  allDay: boolean;
  source: string;
  type: "assignment" | "discussion" | "assessment" | "teacher";
  points?: number;
  desc: string;
  createdBy: string;
  assignmentId?: string;
  assignmentTitle?: string;
}

export const MAX_RANGE_DAYS = 400;
export const MAX_EVENTS = 1500;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

/** The calendar range from the query: two real YYYY-MM-DD dates, start first, at most 400 days apart. */
export function parseRange(start: unknown, end: unknown): { start: string; end: string } | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const a = dayNumber(start);
  const b = dayNumber(end);
  if (a === null || b === null || b < a || b - a > MAX_RANGE_DAYS) return null;
  return { start, end };
}

/** "15:00:00" -> "3:00 PM". */
function clock(hours: number, minutes: number): string {
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

const SCHOOLOGY_EVENT_TYPE: Record<string, CalendarEvent["type"]> = {
  assignment: "assignment",
  discussion: "discussion",
  assessment: "assessment",
  quiz: "assessment",
  test: "assessment",
  event: "teacher",
};

export async function getSectionEvents(sectionId: string, creds: Credentials, range: { start: string; end: string }): Promise<Raw[]> {
  return listOf(await schoologyGet(`/sections/${sectionId}/events`, creds, { start_date: range.start, end_date: range.end, limit: 200 }), "event");
}

export async function getUserEvents(uid: string, creds: Credentials, range: { start: string; end: string }): Promise<Raw[]> {
  return listOf(await schoologyGet(`/users/${uid}/events`, creds, { start_date: range.start, end_date: range.end, limit: 200 }), "event");
}

/**
 * One Schoology event in the calendar's shape. `start` is the wall-clock
 * "YYYY-MM-DD HH:MM:SS" Schoology shows the student, used as-is (the same
 * way the bundle reads due dates). Gradable items carry their assignment id
 * for "Open Assignment": the event's `assignment_id` when Schoology gives
 * one, else its own id (Schoology lists an assignment on the calendar under
 * the assignment's id).
 */
export function schoologyEvent(e: Raw, source: string): CalendarEvent | null {
  const id = String(e?.id ?? "");
  if (!SCHOOLOGY_ID_RE.test(id)) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(e?.start ?? ""));
  if (!m || dayNumber(m[1]) === null) return null;
  const title = clip(toPlainText(e?.title ?? ""), 200) || "Untitled";
  const allDay = ["1", "true"].includes(String(e?.all_day ?? "").toLowerCase()) || !m[2];
  let type = SCHOOLOGY_EVENT_TYPE[String(e?.type ?? "").toLowerCase()] ?? "teacher";
  if (type === "assignment") type = itemType(title);
  const gradable = type !== "teacher" && source !== "school";
  const assignmentId = String(e?.assignment_id ?? e?.grade_item_id ?? id);
  const points = Number(e?.max_points);
  const event: CalendarEvent = {
    id: `s-${id}`,
    title,
    date: m[1],
    allDay,
    source,
    type,
    desc: clip(toPlainText(String(e?.description ?? "").slice(0, 4000)), 400),
    createdBy: "",
  };
  if (!allDay) event.time = clock(Number(m[2]), Number(m[3]));
  if (gradable && Number.isFinite(points) && points > 0) event.points = points;
  if (gradable && SCHOOLOGY_ID_RE.test(assignmentId)) {
    event.assignmentId = assignmentId;
    event.assignmentTitle = title;
  }
  return event;
}

function minutesOf(time: string | undefined): number {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(time ?? "");
  if (!m) return -1;
  return ((Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]);
}

function sortEvents(events: CalendarEvent[]): void {
  events.sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || minutesOf(a.time) - minutesOf(b.time) || a.title.localeCompare(b.title));
}

/**
 * The calendar for Schoology: each class's events (source = the class) and
 * the student's own calendar (`/users/{uid}/events`: a class event there
 * counts for that class, anything else is "school"), each event once, in the
 * range, sorted by day and time.
 */
export function adaptSchoologyEvents(input: {
  bySection: Record<string, Raw[] | null>;
  user: Raw[] | null;
  courses: string[];
  range: { start: string; end: string };
}): { EVENTS: CalendarEvent[]; partial: boolean } {
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  let partial = input.user === null;
  const inRange = (e: CalendarEvent) => e.date >= input.range.start && e.date <= input.range.end;
  const add = (raw: Raw, source: string) => {
    if (events.length >= MAX_EVENTS) {
      partial = true;
      return;
    }
    const e = schoologyEvent(raw, source);
    if (!e || seen.has(e.id) || !inRange(e)) return;
    seen.add(e.id);
    events.push(e);
  };
  for (const [section, list] of Object.entries(input.bySection)) {
    if (list === null) {
      partial = true;
      continue;
    }
    if (list.length >= 200) partial = true; // a full page: there may be more
    for (const raw of list) add(raw, section);
  }
  const mine = new Set(input.courses);
  for (const raw of input.user ?? []) {
    const section = String(raw?.section_id ?? "");
    add(raw, mine.has(section) ? section : "school");
  }
  if ((input.user?.length ?? 0) >= 200) partial = true;
  sortEvents(events);
  return { EVENTS: events, partial };
}

export async function fetchSchoologyEvents(uid: string, creds: Credentials, range: { start: string; end: string }, course: string | null) {
  // One class (course home): that class's events only.
  const courses = course ? [course] : (await schoologyCourses(uid, creds)).map((c) => c.id);
  const bySection: Record<string, Raw[] | null> = {};
  let user: Raw[] | null = [];
  const tasks: (() => Promise<void>)[] = courses.map((id) => async () => {
    try {
      bySection[id] = await getSectionEvents(id, creds, range);
    } catch (error) {
      // One class asked for by id that can't be read is the answer's failure, not a gap in it.
      if (course) throw error;
      bySection[id] = refused(error) ? [] : null;
    }
  });
  if (!course) {
    tasks.push(async () => {
      try {
        user = await getUserEvents(uid, creds, range);
      } catch (error) {
        user = refused(error) ? [] : null;
      }
    });
  }
  await runPool(tasks, SCHOOLOGY_CONCURRENCY, (task) => task());
  return adaptSchoologyEvents({ bySection, user, courses, range });
}

const LOCAL_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** An instant's calendar date (YYYY-MM-DD) and clock time ("3:00 PM") in the student's time zone. */
export function localDateTime(ms: number, tz: string): { date: string; time: string } {
  let f = LOCAL_FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true });
    if (LOCAL_FORMATS.size > 50) LOCAL_FORMATS.clear();
    LOCAL_FORMATS.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute} ${String(p.dayPeriod ?? "").toUpperCase()}` };
}

/**
 * The calendar for Classroom: each class's dated coursework in the range,
 * due date and time in the student's time zone (same as the bundle), type
 * from the title like the bundle's.
 */
export function adaptClassroomEvents(byCourse: Record<string, Raw[] | null>, range: { start: string; end: string }, tz: string): { EVENTS: CalendarEvent[]; partial: boolean } {
  const events: CalendarEvent[] = [];
  let partial = false;
  for (const [courseId, list] of Object.entries(byCourse)) {
    if (list === null) {
      partial = true;
      continue;
    }
    for (const work of list) {
      const id = String(work?.id ?? "");
      if (!CLASSROOM_ID_RE.test(id)) continue;
      const due = dueMs(work);
      if (due === null) continue;
      const { date, time } = localDateTime(due, tz);
      if (date < range.start || date > range.end) continue;
      if (events.length >= MAX_EVENTS) {
        partial = true;
        break;
      }
      const title = plain(work?.title, 200) || "Untitled";
      const points = Number(work?.maxPoints);
      const event: CalendarEvent = {
        id: `c-${id}`,
        title,
        date,
        time,
        allDay: false,
        source: courseId,
        type: itemType(title),
        desc: plain(String(work?.description ?? "").slice(0, 2000), 400),
        createdBy: "",
        assignmentId: id,
        assignmentTitle: title,
      };
      if (Number.isFinite(points) && points > 0) event.points = points;
      events.push(event);
    }
  }
  sortEvents(events);
  return { EVENTS: events, partial };
}

const EVENT_WORK_FIELDS = "courseWork(id,title,description,maxPoints,dueDate,dueTime),nextPageToken";

export async function fetchClassroomEvents(accessToken: string, budget: CallBudget, range: { start: string; end: string }, tz: string, course: string | null) {
  const ids = course ? [course] : (await listCourses(accessToken, budget)).map((c) => String(c.id));
  const byCourse: Record<string, Raw[] | null> = {};
  let cut = false;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const { items, next } = await classroomList(`/courses/${encodeURIComponent(id)}/courseWork`, "courseWork", { pageSize: "100", fields: EVENT_WORK_FIELDS }, accessToken, budget, 2);
        if (next) cut = true;
        byCourse[id] = items;
      } catch (error) {
        if (course) throw error;
        byCourse[id] = null;
      }
    })
  );
  const answer = adaptClassroomEvents(byCourse, range, tz);
  return { ...answer, partial: answer.partial || cut || budget.cut };
}

/* ── Folders ───────────────────────────────────────────────────────────── */

export interface Folder {
  id: string;
  title: string;
  parent: string;
  color: string;
}

export interface FoldersAnswer {
  folders: Folder[];
  placement: Record<string, string>;
  partial: boolean;
  needsPermission?: boolean;
}

export const MAX_FOLDERS = 40;

/** Schoology folder item types, as the Files/Materials items' kinds (`assignment`, `document`). */
const ITEM_KIND: Record<string, string> = { assignment: "assignment", assessment: "assignment", assessment_v2: "assignment", document: "document" };

/** A folder's own color, when it's a plain color name or hex value. */
function folderColor(value: unknown): string {
  const c = String(value ?? "").trim();
  return /^(#[0-9a-f]{6}|[a-z]{3,16})$/i.test(c) ? c.toLowerCase() : "";
}

/** The items in a folder answer (`folder-item`, as an array, one object, or nested once). */
function folderItems(payload: unknown): Raw[] {
  if (!payload || typeof payload !== "object") return [];
  const value = (payload as Raw)["folder-item"];
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const inner = (value as Raw)["folder-item"];
    if (inner !== undefined) return Array.isArray(inner) ? inner : inner && typeof inner === "object" ? [inner] : [];
    return [value as Raw];
  }
  return [];
}

/** One folder's subfolders and the other things in it (by `kind:id`). */
export function parseFolder(payload: unknown): { folders: { id: string; title: string; color: string }[]; items: string[] } {
  const folders: { id: string; title: string; color: string }[] = [];
  const items: string[] = [];
  for (const item of folderItems(payload)) {
    const id = String(item?.id ?? "");
    if (!SCHOOLOGY_ID_RE.test(id) || String(item?.published ?? "1") === "0") continue;
    const type = String(item?.type ?? "").toLowerCase();
    if (type === "folder") {
      folders.push({ id, title: clip(toPlainText(item?.title ?? ""), 120) || "Folder", color: folderColor(item?.color) });
      continue;
    }
    const kind = ITEM_KIND[type] ?? (/^[a-z][a-z_-]{0,30}$/.test(type) ? type : "");
    if (kind) items.push(`${kind}:${id}`);
  }
  return { folders, items };
}

export async function getFolder(sectionId: string, folderId: string, creds: Credentials): Promise<Raw> {
  // Schoology's docs call this a course id; in content URLs the `courses` realm is the section.
  return schoologyGet<Raw>(`/courses/${sectionId}/folder/${folderId}`, creds);
}

/**
 * A class's folders for Materials, walked breadth first from the root
 * (folder 0), at most 40 folders read, 3 at a time. A class with no folders
 * (the root answers 404, or isn't shown to students) has none. An item not
 * in `placement` sits at the top level.
 */
export async function fetchSchoologyFolders(sectionId: string, creds: Credentials): Promise<FoldersAnswer> {
  const folders: Folder[] = [];
  const placement: Record<string, string> = {};
  let partial = false;
  let read = 0;
  let level = ["0"];
  while (level.length) {
    const next: string[] = [];
    const room = MAX_FOLDERS - read;
    if (room <= 0) {
      partial = true; // listed, but what's inside them isn't known
      break;
    }
    if (level.length > room) partial = true;
    const batch = level.slice(0, room);
    read += batch.length;
    const pages: Record<string, ReturnType<typeof parseFolder> | null> = {};
    await runPool(batch, SCHOOLOGY_CONCURRENCY, async (folderId) => {
      try {
        pages[folderId] = parseFolder(await getFolder(sectionId, folderId, creds));
      } catch (error) {
        const none = error instanceof SchoologyError && [401, 403, 404].includes(error.status);
        if (folderId === "0") {
          if (none) {
            pages[folderId] = { folders: [], items: [] };
            return;
          }
          throw error;
        }
        pages[folderId] = null;
        partial = true;
      }
    });
    for (const folderId of batch) {
      const page = pages[folderId];
      if (!page) continue;
      for (const f of page.folders) {
        if (folders.some((x) => x.id === f.id)) continue;
        folders.push({ id: f.id, title: f.title, parent: folderId === "0" ? "" : folderId, color: f.color });
        next.push(f.id);
      }
      if (folderId !== "0") for (const key of page.items) placement[key] ??= folderId;
    }
    level = next;
  }
  return { folders, placement, partial };
}

/**
 * Classroom's topics as folders (ids "t" + the topic id, all top level),
 * and which coursework and materials sit in each. Topics need the optional
 * topics permission (letter `t`); materials need `m`.
 */
export function adaptClassroomFolders(topics: Raw[], work: Raw[], materials: Raw[]): { folders: Folder[]; placement: Record<string, string> } {
  const folders: Folder[] = [];
  const known = new Set<string>();
  for (const t of topics) {
    const id = String(t?.topicId ?? "");
    if (!CLASSROOM_ID_RE.test(id) || known.has(id)) continue;
    known.add(id);
    folders.push({ id: `t${id}`, title: plain(t?.name, 120) || "Topic", parent: "", color: "" });
  }
  const placement: Record<string, string> = {};
  for (const [kind, list] of [["assignment", work], ["material", materials]] as const) {
    for (const item of list) {
      const id = String(item?.id ?? "");
      const topic = String(item?.topicId ?? "");
      if (CLASSROOM_ID_RE.test(id) && known.has(topic)) placement[`${kind}:${id}`] = `t${topic}`;
    }
  }
  return { folders, placement };
}

export async function fetchClassroomFolders(accessToken: string, letters: string, budget: CallBudget, course: string): Promise<FoldersAnswer> {
  if (!letters.includes("t")) return { folders: [], placement: {}, partial: false, needsPermission: true };
  const enc = encodeURIComponent(course);
  const [topics, work, materials] = await Promise.all([
    classroomList(`/courses/${enc}/topics`, "topic", { pageSize: "100", fields: "topic(topicId,name),nextPageToken" }, accessToken, budget, 2),
    classroomList(`/courses/${enc}/courseWork`, "courseWork", { pageSize: "100", fields: "courseWork(id,topicId),nextPageToken" }, accessToken, budget, 3).catch(() => null),
    letters.includes("m")
      ? classroomList(`/courses/${enc}/courseWorkMaterials`, "courseWorkMaterial", { pageSize: "100", fields: "courseWorkMaterial(id,topicId),nextPageToken" }, accessToken, budget, 3).catch(() => null)
      : Promise.resolve({ items: [], next: "" }),
  ]);
  const { folders, placement } = adaptClassroomFolders(topics.items, work?.items ?? [], materials?.items ?? []);
  return { folders, placement, partial: !work || !materials || !!topics.next || !!work.next || !!materials.next || budget.cut };
}

/* ── Gradebook ─────────────────────────────────────────────────────────── */

export async function getGradingCategories(sectionId: string, creds: Credentials): Promise<Raw[]> {
  return listOf(await schoologyGet(`/sections/${sectionId}/grading_categories`, creds), "grading_category");
}

export async function getSectionGrades(uid: string, sectionId: string, creds: Credentials): Promise<Raw[]> {
  return listOf(await schoologyGet(`/users/${uid}/grades`, creds, { section_id: sectionId }), "section");
}

/**
 * One class's Grades tab with exact category names and weights (3 calls at
 * once): the section's grading categories, the student's grades in it and
 * its assignments. The assignments are required; without the categories the
 * grades payload's own list is used, and without the grades nothing shows a
 * score (both make the answer partial unless Schoology refused them).
 */
export async function fetchSchoologyGradebook(uid: string, sectionId: string, creds: Credentials): Promise<{ GRADEBOOK: Record<string, { categories: GradebookCategory[] }>; partial: boolean }> {
  let partial = false;
  const soft = <T>(p: Promise<T>): Promise<T | null> =>
    p.catch((error) => {
      if (!refused(error)) partial = true;
      return null;
    });
  const [categories, grades, assignments] = await Promise.all([
    soft(getGradingCategories(sectionId, creds)),
    soft(getSectionGrades(uid, sectionId, creds)),
    getAssignments(sectionId, creds),
  ]);
  const gradeEntry = (grades ?? []).find((g) => String(g?.section_id ?? g?.id ?? "") === sectionId);
  return {
    GRADEBOOK: { [sectionId]: adaptSchoologyGradebook({ categories: categories && categories.length ? categories : null, gradeEntry, assignments }) },
    partial: partial || assignments.length >= 200,
  };
}
