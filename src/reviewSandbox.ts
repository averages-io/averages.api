/**
 * The reviewer account's pretend Schoology (2026-10-07, Martin: "an API key
 * log in with all integrations on").
 *
 * Signing in with the REVIEW_KEY / REVIEW_SECRET dashboard secrets makes a
 * session whose Schoology credentials are the sandbox's own (SANDBOX_KEY /
 * SANDBOX_SECRET below) and whose uid is REVIEW_UID. Every place that would
 * call api.schoology.com asks isSandboxCreds first and, for this account,
 * gets its answer from sandboxFetch instead: the same JSON shapes Schoology
 * returns, built from sample classes. Nothing about the account ever leaves
 * the Worker, and the whole app runs in its normal live mode, so Canva,
 * Google Drive, OneDrive, notifications and Sync all work for it.
 *
 * The sign-in route refuses SANDBOX_KEY typed in as an ordinary API key, so
 * the only way in is the two secrets.
 *
 * The classes themselves are in reviewSandboxData.ts. What the reviewer does
 * here (messages sent, replies, files and text turned in) is kept in this
 * module's memory, per Worker isolate, so the sent folder and a submission's
 * history show it straight away. It's gone on the next deploy or when
 * Cloudflare recycles the isolate, which is fine for a sample account, and
 * each kind is capped (MAX_KEPT) so nobody can grow it without end.
 */
import type { Credentials } from "./oauth.ts";
import { schoologyLocalMs } from "./adapt.ts";
import {
  FILES,
  SANDBOX_ZONE,
  SCHOOL_EVENTS,
  SECTIONS,
  SEED_THREADS,
  SEEDED_REVISIONS,
  STUDENT,
  makePdf,
  titrationPng,
  type AssignmentDef,
  type DueSpec,
  type SectionDef,
} from "./reviewSandboxData.ts";

export const SANDBOX_KEY = "averages-review-sandbox";
export const SANDBOX_SECRET = "averages-review-sandbox-secret";
/** Not a Schoology uid (those are digits), so its stored data can never be a real student's. */
export const REVIEW_UID = "r:reviewer";

export function isSandboxCreds(creds: Pick<Credentials, "key" | "secret"> | null | undefined): boolean {
  return !!creds && creds.key === SANDBOX_KEY && creds.secret === SANDBOX_SECRET;
}

const API_HOST = "api.schoology.com";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const GRADING_PERIOD = "7010000101";
const SCHOOL_ID = "7010000001";
const SCHOOL_NAME = "Averages Sample High School";
/** Where this sandbox's files download from (an api.schoology.com URL, as isSchoologyApiUrl requires). */
const ATTACHMENT_BASE = `https://${API_HOST}/v1/attachment/sandbox/`;
/** Where its uploads go (isUploadLocation accepts any *.schoology.com https URL). */
const UPLOAD_BASE = `https://${API_HOST}/v1/upload/sandbox/`;
/** Most sent messages, uploads and revisions remembered, each. */
export const MAX_KEPT = 50;
/**
 * Turned-in files' bytes are kept (so the Files page's "Turned in" list can
 * download them, 2026-10-09) only up to 1 MB each and 8 MB in all, oldest
 * dropped first; anything else downloads as a one-page PDF that says so.
 */
export const MAX_KEPT_FILE_BYTES = 1024 * 1024;
export const MAX_KEPT_BYTES_TOTAL = 8 * 1024 * 1024;

type Raw = Record<string, any>;

/* ── What the reviewer did (per isolate) ───────────────────────────────── */

interface MessageRow {
  thread: string;
  subject: string;
  author: string;
  recipients: string;
  at: number;
  text: string;
  unread: boolean;
}

const state = {
  /** Messages and replies the reviewer sent, oldest first. */
  sent: [] as MessageRow[],
  /** Threads opened from the inbox (Schoology marks them read). */
  read: new Set<string>(),
  /** Files announced with POST /upload, by Schoology file id (with their bytes once sent, within the caps above). */
  uploads: new Map<string, { filename: string; filesize: number; md5: string; uploaded: boolean; at: number; bytes?: Uint8Array }>(),
  /** Turned-in revisions, oldest first. */
  revisions: [] as { section: string; assignment: string; raw: Raw }[],
  nextThread: 7800000100,
  nextFile: 7900000100,
  nextRevision: 7950000100,
};

/** Back to a fresh account (tests). */
export function resetSandbox(): void {
  state.sent = [];
  state.read.clear();
  state.uploads.clear();
  state.revisions = [];
}

function keep<T>(list: T[], item: T): void {
  list.push(item);
  while (list.length > MAX_KEPT) list.shift();
}

/* ── Time ──────────────────────────────────────────────────────────────── */

let zoneDate: Intl.DateTimeFormat | null = null;

/** "YYYY-MM-DD HH:MM:SS" in SANDBOX_ZONE for a day relative to today there, the way Schoology writes due dates. */
function wall(spec: DueSpec, now: number): string {
  zoneDate ??= new Intl.DateTimeFormat("en-US", { timeZone: SANDBOX_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const p: Record<string, number> = {};
  for (const part of zoneDate.formatToParts(new Date(now))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const [days, hour, minute] = spec;
  return new Date(Date.UTC(p.year, p.month - 1, p.day + days, hour, minute, 0)).toISOString().slice(0, 19).replace("T", " ");
}

/** Unix seconds, as a string (Schoology's timestamps). */
const unix = (ms: number) => String(Math.floor(ms / 1000));

/* ── Responses ─────────────────────────────────────────────────────────── */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function notFound(): Response {
  return json(404, { error: "Not found" });
}

/** A request body as text (signedFetch sends a JSON string; an upload's PUT sends bytes). */
function bodyBytes(body: unknown): number {
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  return 0;
}

function bodyJson(body: unknown): Raw | null {
  if (typeof body !== "string") return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/* ── Classes, assignments and grades ───────────────────────────────────── */

const sectionById = (id: string) => SECTIONS.find((s) => s.id === id) ?? null;
const assignmentIn = (s: SectionDef, id: string) => s.assignments.find((a) => a.id === id) ?? null;
const teacherName = (s: SectionDef) => `${s.teacher.title} ${s.teacher.last}`;

function sectionJson(s: SectionDef): Raw {
  return {
    id: s.id,
    course_title: s.title,
    course_code: s.code,
    course_id: s.courseId,
    school_id: SCHOOL_ID,
    section_title: `Period ${s.period}`,
    section_code: `P${s.period}`,
    section_school_code: `${s.code}-${s.period}`,
    active: 1,
    description: "",
    grading_periods: [GRADING_PERIOD],
    admin: 0,
  };
}

const fileBytes = new Map<string, Uint8Array>();
function bytesOf(fileId: string): Uint8Array | null {
  const def = FILES[fileId];
  if (!def) return null;
  let bytes = fileBytes.get(fileId);
  if (!bytes) {
    bytes = def.kind === "png" ? titrationPng() : makePdf(def.heading ?? def.title, def.lines ?? []);
    fileBytes.set(fileId, bytes);
  }
  return bytes;
}

const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png" };

function fileJson(fileId: string, now: number): Raw {
  const def = FILES[fileId];
  return {
    id: fileId,
    type: "file",
    title: def.title,
    filename: def.filename,
    filesize: bytesOf(fileId)!.byteLength,
    extension: def.kind,
    filemime: MIME[def.kind],
    timestamp: unix(now - def.daysAgo * DAY),
    download_path: `${ATTACHMENT_BASE}${fileId}`,
  };
}

function categoryId(s: SectionDef, a: AssignmentDef): string {
  return s.categories[a.category]?.id ?? "0";
}

function assignmentJson(s: SectionDef, a: AssignmentDef, now: number, withAttachments: boolean): Raw {
  const out: Raw = {
    id: a.id,
    title: a.title,
    description: a.description,
    due: a.due ? wall(a.due, now) : "",
    grading_scale: "0",
    grading_period: GRADING_PERIOD,
    grading_category: categoryId(s, a),
    max_points: String(a.maxPoints),
    factor: "1",
    is_final: "0",
    show_comments: "1",
    allow_dropbox: a.dropbox ? "1" : "0",
    allow_discussion: a.type === "discussion" ? "1" : "0",
    published: "1",
    type: a.type,
    grade_item_id: a.id,
    available: "1",
    completed: a.graded ? "1" : "0",
    dropbox_locked: "0",
    folder_id: a.folder ?? "0",
    assignment_type: "basic",
    count_in_grade: "1",
  };
  if (withAttachments && (a.files?.length || a.links?.length)) {
    out.attachments = {};
    if (a.files?.length) out.attachments.files = { file: a.files.map((f) => fileJson(f, now)) };
    if (a.links?.length) out.attachments.links = { link: a.links.map((l, i) => ({ id: `${a.id}${i}`, type: "link", title: l.title, url: l.url })) };
  }
  return out;
}

function documentJson(s: SectionDef, d: SectionDef["documents"][number], now: number, withAttachments: boolean): Raw {
  const out: Raw = { id: d.id, title: d.title, course_fid: d.folder ?? "0", available: 1, published: 1, section_id: s.id };
  if (withAttachments) out.attachments = { files: { file: [fileJson(d.file, now)] } };
  return out;
}

/** The class grade as Schoology reports it: weighted by category when it has weights, else total points. */
function finalPct(s: SectionDef): number {
  const graded = s.assignments.filter((a) => a.graded);
  const weighted = s.categories.filter((c) => c.weight > 0);
  if (!weighted.length) {
    const earned = graded.reduce((n, a) => n + a.graded!.earned, 0);
    const possible = graded.reduce((n, a) => n + a.maxPoints, 0);
    return possible ? Math.round((earned / possible) * 10000) / 100 : 0;
  }
  let sum = 0;
  let weights = 0;
  weighted.forEach((c) => {
    const inCat = graded.filter((a) => s.categories[a.category]?.id === c.id);
    const possible = inCat.reduce((n, a) => n + a.maxPoints, 0);
    if (!possible) return;
    sum += c.weight * (inCat.reduce((n, a) => n + a.graded!.earned, 0) / possible);
    weights += c.weight;
  });
  return weights ? Math.round((sum / weights) * 10000) / 100 : 0;
}

function gradesEntry(s: SectionDef, now: number): Raw {
  const graded = s.assignments.filter((a) => a.graded);
  const rows = graded.map((a) => ({
    enrollment_id: `${s.id.slice(-2)}${a.id.slice(-4)}`,
    assignment_id: a.id,
    grade: a.graded!.earned,
    exception: 0,
    max_points: a.maxPoints,
    is_final: 0,
    timestamp: unix(now - a.graded!.daysAgo * DAY),
    comment: "",
    override: null,
    pending: null,
    type: "assignment",
    category_id: categoryId(s, a),
  }));
  const newest = Math.min(...graded.map((a) => a.graded!.daysAgo));
  return {
    section_id: s.id,
    period: [{ period_id: GRADING_PERIOD, period_title: "Semester 1", assignment: rows }],
    final_grade: [{ period_id: GRADING_PERIOD, grade: finalPct(s), comment: "" }],
    grading_category: s.categories.map((c, i) => ({ id: c.id, title: c.title, weight: c.weight, delta: i })),
    timestamp: Number.isFinite(newest) ? unix(now - newest * DAY) : undefined,
  };
}

function teacherEnrollment(s: SectionDef): Raw {
  const t = s.teacher;
  return {
    id: `${t.uid.slice(-3)}${s.id.slice(-3)}`,
    uid: t.uid,
    name_title: t.title,
    name_first: t.first,
    name_last: t.last,
    name_display: teacherName(s),
    admin: 1,
    status: 1,
    picture_url: "",
  };
}

/** Events in [start, end] (YYYY-MM-DD, inclusive), both optional. */
function inRange(start: string, url: URL): boolean {
  const day = start.slice(0, 10);
  const from = url.searchParams.get("start_date");
  const to = url.searchParams.get("end_date");
  return (!from || day >= from) && (!to || day <= to);
}

function sectionEvents(s: SectionDef, now: number): Raw[] {
  const out: Raw[] = [];
  for (const a of s.assignments) {
    if (!a.due) continue;
    // Schoology lists an assignment on the calendar under the assignment's own id.
    out.push({ id: a.id, title: a.title, description: "", start: wall(a.due, now), has_end: 0, all_day: 0, type: a.type, assignment_id: a.id, max_points: a.maxPoints, realm: "section", section_id: s.id });
  }
  for (const e of s.events) {
    out.push({ id: e.id, title: e.title, description: e.description, start: wall(e.start, now), has_end: 0, all_day: e.allDay ? 1 : 0, type: "event", realm: "section", section_id: s.id });
  }
  return out;
}

/** A class's folder: its subfolders, documents and assignments (folder "0" is the top level). */
function folderJson(s: SectionDef, folderId: string): Raw | null {
  const folder = s.folders.find((f) => f.id === folderId);
  if (folderId !== "0" && !folder) return null;
  const here = (id: string | undefined) => (id ?? "0") === folderId;
  const items: Raw[] = [
    ...s.folders.filter((f) => f.parent === folderId).map((f) => ({ id: f.id, title: f.title, type: "folder", color: f.color, published: 1 })),
    ...s.documents.filter((d) => here(d.folder)).map((d) => ({ id: d.id, title: d.title, type: "document", published: 1 })),
    // Graded discussions are listed as assignments, the kind the app's Materials page files them under.
    ...s.assignments.filter((a) => here(a.folder)).map((a) => ({ id: a.id, title: a.title, type: a.type === "assessment" ? "assessment" : "assignment", published: 1 })),
  ];
  return { id: folderId, title: folder?.title ?? s.title, "folder-item": items };
}

/* ── Messages ──────────────────────────────────────────────────────────── */

const TEACHERS = SECTIONS.map((s) => ({ uid: s.teacher.uid, name: teacherName(s) }));

function allRows(now: number): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const t of SEED_THREADS) {
    for (const r of t.rows) {
      const mine = r.author === "me";
      rows.push({
        thread: t.id,
        subject: t.subject,
        author: mine ? REVIEW_UID : r.author,
        recipients: mine ? t.teacher : REVIEW_UID,
        at: now - r.hoursAgo * HOUR,
        text: r.text,
        unread: !!r.unread,
      });
    }
  }
  return rows.concat(state.sent);
}

function threadsOf(now: number): Map<string, MessageRow[]> {
  const threads = new Map<string, MessageRow[]>();
  for (const row of allRows(now)) {
    const list = threads.get(row.thread) ?? [];
    list.push(row);
    threads.set(row.thread, list);
  }
  for (const list of threads.values()) list.sort((a, b) => a.at - b.at);
  return threads;
}

const isMine = (r: MessageRow) => r.author === REVIEW_UID;
const threadUnread = (id: string, rows: MessageRow[]) => !state.read.has(id) && rows.some((r) => !isMine(r) && r.unread);

function rowJson(r: MessageRow, unread: boolean): Raw {
  return {
    id: r.thread,
    subject: r.subject,
    recipient_ids: r.recipients,
    last_updated: unix(r.at),
    author_id: r.author,
    message_status: unread ? "unread" : "read",
    message: r.text,
  };
}

/** The inbox or sent list: one entry per thread, newest first. */
function messageList(folder: "inbox" | "sent", now: number, limit: number): Raw[] {
  const out: Raw[] = [];
  for (const [id, rows] of threadsOf(now)) {
    const latest = rows[rows.length - 1];
    if (folder === "inbox") {
      const theirs = rows.filter((r) => !isMine(r));
      if (!theirs.length) continue;
      out.push({ ...rowJson(latest, threadUnread(id, rows)), author_id: theirs[theirs.length - 1].author, subject: rows[0].subject });
    } else {
      const mine = rows.filter(isMine);
      if (!mine.length) continue;
      out.push({ ...rowJson(mine[mine.length - 1], false), subject: rows[0].subject });
    }
  }
  out.sort((a, b) => Number(b.last_updated) - Number(a.last_updated));
  return out.slice(0, limit);
}

/** Recipient ids from a send: digits, each one a teacher of the student's. */
function recipientsOf(value: unknown): string[] | null {
  const ids = String(value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!ids.length || !ids.every((id) => TEACHERS.some((t) => t.uid === id))) return null;
  return ids;
}

function sendMessage(path: string[], body: Raw | null, now: number): Response {
  if (!body || typeof body.message !== "string" || !body.message.trim()) return json(400, { error: "Message is required" });
  const recipients = recipientsOf(body.recipient_ids);
  if (!recipients) return json(403, { error: "Recipient not allowed" });
  let thread: string;
  let subject = String(body.subject ?? "").slice(0, 200);
  if (path.length === 1) {
    if (!subject.trim()) return json(400, { error: "Subject is required" });
    thread = String(state.nextThread++);
  } else {
    thread = path[1];
    const rows = threadsOf(now).get(thread);
    if (!rows) return notFound();
    subject ||= rows[0].subject;
  }
  const row: MessageRow = { thread, subject, author: REVIEW_UID, recipients: recipients.join(","), at: now, text: body.message.slice(0, 20_000), unread: false };
  keep(state.sent, row);
  return json(201, rowJson(row, false));
}

/* ── Turning in work ───────────────────────────────────────────────────── */

const EXT_MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain" };
const extOf = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase() ?? "";

function revisionFile(id: string, filename: string, filesize: number, at: number): Raw {
  const ext = extOf(filename);
  // download_path (2026-10-09): Schoology's revision files carry one, and GET /data/submission-file uses it.
  return { id, type: "file", title: filename, filename, filesize, extension: ext, filemime: EXT_MIME[ext] ?? "application/octet-stream", timestamp: unix(at), download_path: `${ATTACHMENT_BASE}${id}` };
}

/** The sample work turned in before the review: a generated PDF named for it, made once. */
const seededBytes = new Map<string, Uint8Array>();
function seededFileBytes(fileId: string): Uint8Array | null {
  const seeded = SEEDED_REVISIONS.find((r) => r.file?.id === fileId);
  if (!seeded?.file) return null;
  let bytes = seededBytes.get(fileId);
  if (!bytes) {
    bytes = makePdf(seeded.file.filename.replace(/\.pdf$/i, ""), ["Sample work turned in on the reviewer account.", "", `${STUDENT.name_display}`]);
    seededBytes.set(fileId, bytes);
  }
  return bytes;
}

/**
 * A turned-in file's download: its own bytes when they were kept, else a
 * one-page PDF that says the sample account didn't keep it. Null for an id
 * no turn-in has.
 */
function turnedInDownload(fileId: string): Response | null {
  const seeded = seededFileBytes(fileId);
  if (seeded) return new Response(seeded.slice(), { status: 200, headers: { "Content-Type": "application/pdf", "Content-Length": String(seeded.byteLength) } });
  let file: Raw | undefined;
  for (const r of state.revisions) file ??= rawFiles(r.raw).find((f) => f.id === fileId);
  if (!file) return null;
  const upload = state.uploads.get(fileId);
  if (upload?.bytes) {
    const type = EXT_MIME[extOf(upload.filename)] ?? "application/octet-stream";
    return new Response(upload.bytes.slice(), { status: 200, headers: { "Content-Type": type, "Content-Length": String(upload.bytes.byteLength) } });
  }
  const stand = makePdf(String(file.filename ?? "File"), ["The sample account keeps turned-in files up to 1 MB (8 MB in all).", "This one wasn't kept, so here is a stand-in."]);
  return new Response(stand, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Length": String(stand.byteLength) } });
}

function rawFiles(raw: Raw): Raw[] {
  const list = raw?.attachments?.files?.file;
  return Array.isArray(list) ? list : [];
}

/** Keeps an upload's bytes within MAX_KEPT_FILE_BYTES / MAX_KEPT_BYTES_TOTAL, dropping the oldest kept first. */
function keepBytes(fileId: string, body: unknown): void {
  const upload = state.uploads.get(fileId);
  if (!upload) return;
  const view = body instanceof ArrayBuffer ? new Uint8Array(body) : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : typeof body === "string" ? new TextEncoder().encode(body) : null;
  if (!view || view.byteLength > MAX_KEPT_FILE_BYTES) return;
  upload.bytes = view.slice();
  let total = 0;
  for (const u of state.uploads.values()) total += u.bytes?.byteLength ?? 0;
  for (const [id, u] of state.uploads) {
    if (total <= MAX_KEPT_BYTES_TOTAL) break;
    if (!u.bytes || id === fileId) continue;
    total -= u.bytes.byteLength;
    delete u.bytes;
  }
}

function seededRevisions(section: string, assignment: string, now: number): Raw[] {
  return SEEDED_REVISIONS.filter((r) => r.section === section && r.assignment === assignment).map((r) => {
    const at = now - r.daysAgo * DAY;
    const raw: Raw = { revision_id: r.revisionId, uid: REVIEW_UID, created: unix(at), late: 0, draft: 0, num_items: r.file ? 1 : 0 };
    if (r.body) raw.body = r.body;
    // Its size is the PDF it downloads as (2026-10-09).
    if (r.file) raw.attachments = { files: { file: [revisionFile(r.file.id, r.file.filename, seededFileBytes(r.file.id)?.byteLength ?? r.file.filesize, at)] } };
    return raw;
  });
}

function startUpload(body: Raw | null, now: number): Response {
  const filename = body?.filename;
  const filesize = body?.filesize;
  if (typeof filename !== "string" || !filename.trim() || typeof filesize !== "number" || !Number.isInteger(filesize) || filesize < 1) {
    return json(400, { error: "filename and filesize are required" });
  }
  const id = String(state.nextFile++);
  state.uploads.set(id, { filename: filename.slice(0, 255), filesize, md5: String(body?.md5_checksum ?? ""), uploaded: false, at: now });
  while (state.uploads.size > MAX_KEPT) state.uploads.delete(state.uploads.keys().next().value!);
  return json(200, { id, upload_location: `${UPLOAD_BASE}${id}` });
}

function putUpload(fileId: string, body: unknown): Response {
  const upload = state.uploads.get(fileId);
  if (!upload) return notFound();
  // Schoology checks the bytes against what POST /upload announced.
  if (bodyBytes(body) !== upload.filesize) return json(400, { error: "File size does not match" });
  upload.uploaded = true;
  keepBytes(fileId, body);
  return json(200, { id: fileId, filename: upload.filename, filesize: upload.filesize, md5_checksum: upload.md5 });
}

function submit(s: SectionDef, a: AssignmentDef, kind: string, body: Raw | null, now: number): Response {
  if (!a.dropbox) return json(403, { error: "This assignment does not accept submissions" });
  const dueMs = a.due ? schoologyLocalMs(wall(a.due, now), SANDBOX_ZONE) : null;
  const raw: Raw = { revision_id: String(state.nextRevision++), uid: REVIEW_UID, created: unix(now), late: dueMs !== null && dueMs < now ? 1 : 0, draft: 0 };
  if (kind === "file") {
    const ids = body?.["file-attachment"]?.id;
    const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? ""));
    if (!list.length || !list.every((id) => state.uploads.get(id)?.uploaded)) return json(400, { error: "Unknown file" });
    raw.num_items = list.length;
    raw.attachments = { files: { file: list.map((id) => { const u = state.uploads.get(id)!; return revisionFile(id, u.filename, u.filesize, now); }) } };
  } else {
    if (typeof body?.body !== "string" || !body.body.trim()) return json(400, { error: "Body is required" });
    raw.body = body.body.slice(0, 200_000);
    raw.num_items = 1;
  }
  keep(state.revisions, { section: s.id, assignment: a.id, raw });
  return json(201, raw);
}

function history(s: SectionDef, a: AssignmentDef, now: number): Response {
  const mine = state.revisions.filter((r) => r.section === s.id && r.assignment === a.id).map((r) => r.raw);
  return json(200, { revision: [...seededRevisions(s.id, a.id, now), ...mine] });
}

/* ── The router ────────────────────────────────────────────────────────── */

const truthy = (v: string | null) => v !== null && v !== "" && v !== "0" && v !== "false";

function me(): Raw {
  return {
    uid: REVIEW_UID,
    id: REVIEW_UID,
    school_id: SCHOOL_ID,
    name_title: "",
    name_first: STUDENT.name_first,
    name_middle: "",
    name_last: STUDENT.name_last,
    name_display: STUDENT.name_display,
    primary_email: STUDENT.primary_email,
    picture_url: "",
    grad_year: STUDENT.grad_year,
    tz_name: SANDBOX_ZONE,
  };
}

function get(path: string[], url: URL, now: number): Response {
  const [realm, id, sub, subId, extra] = path;
  const withAttachments = truthy(url.searchParams.get("with_attachments"));

  if (realm === "users") {
    // Any uid answers as the reviewer: it's the only user this sandbox has.
    if (path.length === 2) return json(200, me());
    if (path.length !== 3) return notFound();
    if (sub === "sections") return json(200, { section: SECTIONS.map(sectionJson), total: SECTIONS.length });
    if (sub === "grades") {
      const only = url.searchParams.get("section_id");
      const list = SECTIONS.filter((s) => !only || s.id === only).map((s) => gradesEntry(s, now));
      return json(200, { section: list });
    }
    if (sub === "events") {
      const events = [
        ...SCHOOL_EVENTS.map((e) => ({ id: e.id, title: e.title, description: e.description, start: wall(e.start, now), has_end: 0, all_day: e.allDay ? 1 : 0, type: "event", realm: "school", school_id: SCHOOL_ID })),
        ...SECTIONS.flatMap((s) => sectionEvents(s, now)),
      ].filter((e) => inRange(e.start, url));
      return json(200, { event: events, total: events.length });
    }
    return notFound();
  }

  if (realm === "sections") {
    const s = sectionById(id ?? "");
    if (!s) return notFound();
    if (sub === "assignments" && path.length === 3) {
      return json(200, { assignment: s.assignments.map((a) => assignmentJson(s, a, now, withAttachments)), total: s.assignments.length });
    }
    if (sub === "assignments" && path.length === 4) {
      const a = assignmentIn(s, subId);
      return a ? json(200, assignmentJson(s, a, now, withAttachments)) : notFound();
    }
    if (sub === "documents" && path.length === 3) {
      return json(200, { document: s.documents.map((d) => documentJson(s, d, now, withAttachments)), total: s.documents.length });
    }
    if (sub === "documents" && path.length === 4) {
      const d = s.documents.find((x) => x.id === subId);
      return d ? json(200, documentJson(s, d, now, withAttachments)) : notFound();
    }
    if (path.length === 3) {
      // Teachers only, whatever `type` asks for: a classmate's name never comes from here.
      if (sub === "enrollments") return json(200, { enrollment: [teacherEnrollment(s)], total: 1 });
      if (sub === "updates") {
        const updates = [...s.updates]
          .sort((a, b) => a.hoursAgo - b.hoursAgo)
          .map((u) => ({ id: u.id, body: u.body, uid: s.teacher.uid, created: unix(now - u.hoursAgo * HOUR), last_updated: unix(now - u.hoursAgo * HOUR), likes: 0, realm: "section", section_id: s.id, num_comments: 0 }));
        return json(200, { update: updates, total: updates.length });
      }
      if (sub === "events") {
        const events = sectionEvents(s, now).filter((e) => inRange(e.start, url));
        return json(200, { event: events, total: events.length });
      }
      if (sub === "grading_categories") {
        return json(200, { grading_category: s.categories.map((c, i) => ({ id: c.id, title: c.title, weight: c.weight, delta: i, calculation_type: 2 })) });
      }
    }
    if (sub === "submissions" && path.length === 5 && extra) {
      const a = assignmentIn(s, subId);
      return a ? history(s, a, now) : notFound();
    }
    return notFound();
  }

  if (realm === "courses" && sub === "folder" && path.length === 4) {
    // In content URLs the `courses` realm is the section (see extras.ts getFolder).
    const s = sectionById(id ?? "");
    const folder = s ? folderJson(s, subId) : null;
    return folder ? json(200, folder) : notFound();
  }

  if (realm === "messages") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 20));
    if (path.length === 2 && id === "recipients") {
      return json(200, { recipients: TEACHERS.map((t) => ({ id: t.uid, name: t.name, school: SCHOOL_NAME, picture_url: "" })) });
    }
    if (path.length === 2 && (id === "inbox" || id === "sent")) return json(200, { message: messageList(id, now, limit) });
    if (path.length === 3 && (id === "inbox" || id === "sent")) {
      const rows = threadsOf(now).get(sub);
      const here = rows?.some((r) => (id === "sent" ? isMine(r) : !isMine(r)));
      if (!rows || !here) return notFound();
      const unread = threadUnread(sub, rows);
      // Opening a thread from the inbox marks it read, as it does on Schoology.
      if (id === "inbox") {
        state.read.add(sub);
        if (state.read.size > MAX_KEPT * 2) state.read.delete(state.read.values().next().value!);
      }
      return json(200, { message: rows.map((r) => rowJson(r, unread && !isMine(r))) });
    }
    return notFound();
  }

  if (realm === "attachment" && id === "sandbox" && path.length === 3) {
    const bytes = bytesOf(sub);
    // Not a teacher's file: maybe one the reviewer turned in (2026-10-09).
    if (!bytes) return turnedInDownload(sub) ?? notFound();
    return new Response(bytes.slice(), {
      status: 200,
      headers: { "Content-Type": MIME[FILES[sub].kind], "Content-Length": String(bytes.byteLength) },
    });
  }

  return notFound();
}

function post(path: string[], body: unknown, now: number): Response {
  const parsed = bodyJson(body);
  if (path[0] === "messages" && (path.length === 1 || (path.length === 2 && /^\d+$/.test(path[1])))) return sendMessage(path, parsed, now);
  if (path[0] === "upload" && path.length === 1) return startUpload(parsed, now);
  if (path[0] === "sections" && path[2] === "submissions" && path.length === 5 && (path[4] === "file" || path[4] === "create")) {
    const s = sectionById(path[1]);
    const a = s ? assignmentIn(s, path[3]) : null;
    if (!s || !a) return notFound();
    return submit(s, a, path[4], parsed, now);
  }
  return notFound();
}

/**
 * Schoology's answer for one request from the reviewer account.
 * `url` is the full URL the real call would go to (api.schoology.com/v1/...,
 * an attachment URL, or an upload location this sandbox handed out).
 */
export async function sandboxFetch(method: string, url: string, body?: unknown): Promise<Response> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return notFound();
  }
  if (u.protocol !== "https:" || u.hostname !== API_HOST || !u.pathname.startsWith("/v1/")) return notFound();
  let path: string[];
  try {
    path = u.pathname.slice(4).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return notFound();
  }
  const now = Date.now();
  try {
    switch (method.toUpperCase()) {
      case "GET":
        return get(path, u, now);
      case "POST":
        return post(path, body, now);
      case "PUT":
        if (path[0] === "upload" && path[1] === "sandbox" && path.length === 3) return putUpload(path[2], body);
        return notFound();
      default:
        return json(405, { error: "Method not allowed" });
    }
  } catch (error) {
    // Never a thrown error: the callers expect a Response, like fetch gives them.
    console.error("review_sandbox_failed", error instanceof Error ? error.message : String(error));
    return json(500, { error: "Sandbox error" });
  }
}
