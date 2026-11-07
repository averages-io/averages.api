// Schoology private messages for the Messages page: the inbox and sent threads, one thread at a time.

import { clip, decodeEntities, relativeTime, schoologyTime, toPlainText } from "./adapt.ts";
import type { Credentials } from "./oauth.ts";
import { getMessages, getSections, listOf, SchoologyError, schoologyGet, schoologyPost, schoologyRequest } from "./schoology.ts";
import { getAdminEnrollments, teacherRows } from "./extras.ts";

type Raw = Record<string, any>;

export const MAX_SUBJECT = 200;
export const MAX_MESSAGE = 10000;
export const MAX_RECIPIENTS = 20;
export const MAX_CONVERSATIONS = 50;
/** Most participants a reply goes to (Schoology's own thread; a sanity cap, not a policy). */
export const MAX_REPLY_RECIPIENTS = 100;
/** Most people GET /messages/recipients hands back. */
export const MAX_RECIPIENT_LIST = 500;
/** Schoology user, thread and message ids: digits only. */
export const ID_RE = /^\d{1,20}$/;

const FALLBACK_AUTHOR = "Teacher";
const FALLBACK_OTHER = "Classmate";

/* ── Recipients ────────────────────────────────────────────────────────── */

function isObject(value: unknown): value is Raw {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The person rows in a GET /messages/recipients answer. Schoology's docs show
 * `{id, name, school, picture_url}` per person but not the wrapper key, so the
 * usual list shapes are all accepted (`recipients`/`recipient`/`users`/`user`,
 * an array, a single object, or one nested level).
 */
export function recipientRows(payload: unknown): Raw[] {
  if (Array.isArray(payload)) return payload.filter(isObject);
  if (!isObject(payload)) return [];
  for (const key of ["recipients", "recipient", "users", "user"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isObject);
    if (!isObject(value)) continue;
    for (const inner of ["recipient", "user"]) {
      if (Array.isArray(value[inner])) return value[inner].filter(isObject);
      if (isObject(value[inner])) return [value[inner]];
    }
    if (value.id !== undefined || value.uid !== undefined) return [value];
  }
  return [];
}

export async function getRecipients(creds: Credentials): Promise<Raw[]> {
  // limit=200: Schoology's default page is small; a bigger one costs nothing when unsupported.
  return recipientRows(await schoologyGet("/messages/recipients", creds, { limit: 200 }));
}

/**
 * People in Schoology by name, as its own search finds them for this student (GET /search?type=user): counselors,
 * librarians, other teachers. Schoology decides who shows up. Ids digits only, each once, never the student.
 */
export async function searchPeople(creds: Credentials & { uid?: string }, query: string): Promise<{ id: string; name: string; school: string; picture: string }[]> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 60);
  if (q.length < 2) return [];
  const payload: any = await schoologyGet("/search", creds, { keywords: q, type: "user", limit: 20 });
  const rows = listOf<Raw>(payload?.users ?? payload, "search_result");
  const out: { id: string; name: string; school: string; picture: string }[] = [];
  for (const row of rows) {
    const id = String(row?.uid ?? row?.id ?? "");
    if (!ID_RE.test(id) || id === creds.uid || out.some((p) => p.id === id)) continue;
    const name = personName(row);
    if (!name) continue;
    const pic = typeof row?.picture_url === "string" && /^https:\/\//.test(row.picture_url) && !/user-default/.test(row.picture_url) ? row.picture_url.slice(0, 600) : "";
    out.push({ id, name, school: clip(toPlainText(row?.school ?? ""), 120), picture: pic });
  }
  return out;
}

function personName(row: Raw): string {
  const full = row.name ?? row.name_display ?? `${row.name_first ?? ""} ${row.name_last ?? ""}`;
  return clip(toPlainText(full), 120);
}

/** The people this student can message, by name, ids digits only, each once. */
export function adaptRecipients(rows: Raw[]): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const row of rows) {
    const id = String(row.id ?? row.uid ?? "");
    if (!ID_RE.test(id) || seen.has(id)) continue;
    const name = personName(row);
    if (!name) continue;
    seen.add(id);
    out.push({ id, name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out.slice(0, MAX_RECIPIENT_LIST);
}

/** Names by user id from a recipients answer (null when it couldn't be read: no names). */
export function namesFrom(rows: Raw[] | null): Map<string, string> {
  const names = new Map<string, string>();
  for (const r of adaptRecipients(rows ?? [])) names.set(r.id, r.name);
  return names;
}

/* ── Threads ───────────────────────────────────────────────────────────── */

/** The ids in a "1,2, 3" recipient list (or an array), digits only. */
function idList(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(",");
  return parts.map((x) => String(x ?? "").trim()).filter((x) => ID_RE.test(x));
}

/** Everyone in a set of message rows (authors and recipients) except the student. */
export function threadParticipants(rows: Raw[], me: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([me]);
  for (const row of rows) {
    for (const id of [String(row?.author_id ?? ""), ...idList(row?.recipient_ids)]) {
      if (!ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** A thread's subject as plain text (the first message that has one). */
export function threadSubject(rows: Raw[]): string {
  for (const row of rows) {
    const subject = clip(toPlainText(row?.subject ?? ""), MAX_SUBJECT);
    if (subject) return subject;
  }
  return "";
}

/**
 * A message body as plain text that keeps its line breaks (the thread view
 * shows paragraphs). Same order as toPlainText: tags out first, then entities
 * decoded exactly one level, so typed "&lt;b&gt;" stays the text "<b>".
 */
export function messageFiles(row: Raw): { id: string; name: string; size: number }[] {
  const out: { id: string; name: string; size: number }[] = [];
  for (const f of listOf<Raw>(row?.attachments?.files, "file").slice(0, 20)) {
    const id = String(f?.id ?? "");
    if (!ID_RE.test(id) || out.some((x) => x.id === id)) continue;
    const name = clip(toPlainText(f?.filename || f?.title || "File").replace(/[\\/]/g, "_"), 200) || "File";
    const size = Number(f?.filesize);
    out.push({ id, name, size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0 });
  }
  return out;
}

/** A link someone attached, made a full web address ("google.com" → https://google.com); anything that isn't one is left out. */
export function webAddress(raw: unknown): string {
  const t = String(raw ?? "").trim();
  if (!t || t.length > 2000 || /\s/.test(t)) return "";
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : "https://" + t);
  } catch {
    return "";
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname.includes(".") || u.username || u.password) return "";
  return u.href;
}

/** A message's attached links: the address and the title the sender gave it. */
export function messageLinks(row: Raw): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  for (const l of listOf<Raw>(row?.attachments?.links, "link").slice(0, 20)) {
    const url = webAddress(l?.url);
    if (!url || out.some((x) => x.url === url)) continue;
    out.push({ url, title: clip(toPlainText(l?.title ?? ""), 200) });
  }
  return out;
}

/** One file from a conversation, found again in the student's own copy of it: its name and download path, or null. */
export function findMessageFile(rows: Raw[], fileId: string): { name: string; downloadPath: string } | null {
  for (const row of rows) {
    for (const f of listOf<Raw>(row?.attachments?.files, "file")) {
      if (String(f?.id ?? "") !== fileId) continue;
      const downloadPath = String(f?.download_path ?? "");
      if (!downloadPath) return null;
      return { name: clip(toPlainText(f?.filename || f?.title || "File"), 200) || "File", downloadPath };
    }
  }
  return null;
}

export function messageText(html: unknown, max = MAX_MESSAGE): string {
  const withBreaks = String(html ?? "")
    .slice(0, 100_000)
    .replace(/\r\n?/g, "\n")
    .replace(/<\s*br\b[^<>]*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<a\b[^<>]*?\bhref\s*=\s*["']([^"'<>]{1,2000})["'][^<>]*>([^<]{0,500})<\s*\/\s*a\s*>/gi, (_m, href: string, label: string) => {
      const url = webAddress(decodeEntities(href));
      const text = label.trim();
      if (!url) return label;
      if (!text) return url;
      return decodeEntities(text).replace(/\/$/, "") === url.replace(/\/$/, "") ? label : `${label} (${url})`;
    });
  const text = decodeEntities(withBreaks.replace(/<[^<>]*>/g, ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clip(text, max);
}

/** What the student typed, as the HTML Schoology stores message bodies in: escaped, line breaks kept. */
export function messageHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n/g, "<br />");
}

const TIME_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** "Tue, Oct 6 · 2:05 PM" in the student's time zone (the thread view's format). */
export function formatMessageTime(ms: number, tz: string): string {
  let f = TIME_FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    if (TIME_FORMATS.size > 50) TIME_FORMATS.clear();
    TIME_FORMATS.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.weekday}, ${p.month} ${p.day} · ${p.hour}:${p.minute} ${String(p.dayPeriod ?? "").toUpperCase()}`.trim();
}

export interface Conversation {
  id: string;
  personId: string;
  subject: string;
  unread: boolean;
  preview: string;
  time: string;
  at: number;
  participants: string[];
  messages: never[];
}

/**
 * The thread list: inbox and sent merged by thread id, newest first, at most
 * 50. Each thread's preview and time are its newest row's; it's unread when
 * Schoology says so for the inbox copy. `personId` is who the thread is
 * with: its newest author who isn't the student, else its first other
 * participant. PEOPLE names everyone in the list (see the top of this file
 * for the fallbacks). `messages` stays empty: the page loads a thread when
 * it's opened.
 */
export function adaptConversations(input: {
  inbox: Raw[];
  sent: Raw[] | null;
  names: Map<string, string>;
  me: string;
  now?: number;
}): { CONVERSATIONS: Conversation[]; PEOPLE: Record<string, { name: string }> } {
  const { me, names } = input;
  const now = input.now ?? Date.now();
  type Entry = { conv: Conversation; rows: Raw[]; authors: string[]; latestAuthor: string };
  const threads = new Map<string, Entry>();

  const rows: [Raw, boolean][] = [...input.inbox.map((r): [Raw, boolean] => [r, true]), ...(input.sent ?? []).map((r): [Raw, boolean] => [r, false])];
  for (const [row, inInbox] of rows) {
    const id = String(row?.id ?? "");
    if (!ID_RE.test(id)) continue;
    const at = schoologyTime(row?.last_updated) ?? 0;
    let entry = threads.get(id);
    if (!entry) {
      entry = {
        conv: { id, personId: "", subject: "", unread: false, preview: "", time: "", at: -1, participants: [], messages: [] },
        rows: [],
        authors: [],
        latestAuthor: "",
      };
      threads.set(id, entry);
    }
    entry.rows.push(row);
    const author = String(row?.author_id ?? "");
    if (ID_RE.test(author) && author !== me && !entry.authors.includes(author)) entry.authors.push(author);
    if (inInbox && String(row?.message_status ?? "").toLowerCase() === "unread") entry.conv.unread = true;
    if (at > entry.conv.at) {
      entry.conv.at = at;
      entry.conv.preview = clip(toPlainText(row?.message ?? ""), 140);
      entry.conv.time = at ? relativeTime(String(Math.floor(at / 1000)), now) : "";
      entry.latestAuthor = ID_RE.test(author) ? author : entry.latestAuthor;
    }
  }

  const CONVERSATIONS: Conversation[] = [];
  const PEOPLE: Record<string, { name: string }> = {};
  const authorsSeen = new Set<string>();
  for (const entry of threads.values()) {
    entry.conv.subject = threadSubject(entry.rows) || "No subject";
    entry.conv.participants = threadParticipants(entry.rows, me).slice(0, MAX_REPLY_RECIPIENTS);
    entry.conv.personId = (entry.latestAuthor && entry.latestAuthor !== me ? entry.latestAuthor : "") || entry.authors[0] || entry.conv.participants[0] || "";
    if (entry.conv.at < 0) entry.conv.at = 0;
    for (const a of entry.authors) authorsSeen.add(a);
    CONVERSATIONS.push(entry.conv);
  }
  CONVERSATIONS.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  const kept = CONVERSATIONS.slice(0, MAX_CONVERSATIONS);
  for (const conv of kept) {
    for (const id of [conv.personId, ...conv.participants]) {
      if (!id || PEOPLE[id]) continue;
      PEOPLE[id] = { name: names.get(id) ?? (authorsSeen.has(id) ? FALLBACK_AUTHOR : FALLBACK_OTHER) };
    }
  }
  return { CONVERSATIONS: kept, PEOPLE };
}

/** One thread, oldest message first, for the thread view. */
export function adaptThread(id: string, rows: Raw[], me: string, tz: string) {
  const ordered = rows
    .map((row, index) => ({ row, index, at: schoologyTime(row?.last_updated) ?? 0 }))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  return {
    id,
    subject: threadSubject(rows) || "No subject",
    participants: threadParticipants(rows, me),
    messages: ordered.map(({ row, at }) => {
      const authorId = String(row?.author_id ?? "");
      return {
        from: authorId === me ? ("me" as const) : ("them" as const),
        authorId: ID_RE.test(authorId) ? authorId : "",
        text: messageText(row?.message),
        time: at ? formatMessageTime(at, tz) : "",
        at,
        files: messageFiles(row),
        links: messageLinks(row),
      };
    }),
  };
}

/* ── Reading from Schoology ────────────────────────────────────────────── */

/** Inbox, sent and the recipients list together (3 calls). The inbox is required; the others degrade. */
export async function loadConversations(creds: Credentials, me: string, now = Date.now()) {
  const [inbox, sent, recipients] = await Promise.all([
    getMessages("inbox", creds, MAX_CONVERSATIONS),
    getMessages("sent", creds, MAX_CONVERSATIONS).catch(() => null),
    getRecipients(creds).catch(() => null),
  ]);
  const { CONVERSATIONS, PEOPLE } = adaptConversations({ inbox, sent, names: namesFrom(recipients), me, now });
  return { CONVERSATIONS, PEOPLE, me, partial: sent === null };
}

/** True for an answer that means "not in this folder" rather than a failure. */
function notHere(error: unknown): boolean {
  return error instanceof SchoologyError && (error.status === 403 || error.status === 404);
}

/**
 * A thread's messages, from the inbox (which marks it read on Schoology, as
 * opening it there would) or, for a thread the student started that has no
 * reply yet, from sent. Null when it's in neither.
 */
export async function getThread(id: string, creds: Credentials, opts: { keepUnread?: boolean } = {}): Promise<Raw[] | null> {
  // keep_unread: Schoology marks a thread read when it's viewed; looking one up for a file shouldn't.
  const q: Record<string, string | number> = opts.keepUnread ? { with_attachments: 1, keep_unread: "TRUE" } : { with_attachments: 1 };
  let firstError: unknown = null;
  try {
    const rows = listOf(await schoologyGet(`/messages/inbox/${id}`, creds, q), "message");
    if (rows.length) return rows;
  } catch (error) {
    if (!notHere(error)) throw error;
    firstError = error;
  }
  try {
    const rows = listOf(await schoologyGet(`/messages/sent/${id}`, creds, q), "message");
    return rows.length ? rows : null;
  } catch (error) {
    if (!notHere(error)) throw error;
    // Refused in both folders for a reason other than "not found": say so.
    if (firstError instanceof SchoologyError && firstError.status === 403 && error instanceof SchoologyError && error.status === 403) throw error;
    return null;
  }
}

// Marks a conversation read or unread on Schoology too (PUT /messages/inbox/{id} { message_status }), so the dot
// matches on Schoology's own site. Inbox only: a thread only in Sent has nothing to mark. False when it isn't there.
export async function setThreadStatus(id: string, unread: boolean, creds: Credentials): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  try {
    await schoologyRequest("PUT", `/messages/inbox/${id}`, creds, { message_status: unread ? "unread" : "read" });
    return true;
  } catch (error) {
    if (notHere(error)) return false;
    throw error;
  }
}

export async function deleteThread(id: string, creds: Credentials): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  let gone = false;
  const errors: unknown[] = [];
  for (const folder of ["inbox", "sent"]) {
    try {
      await schoologyRequest("DELETE", `/messages/${folder}/${id}`, creds);
      gone = true;
    } catch (error) {
      if (!notHere(error)) throw error;
      errors.push(error);
    }
  }
  if (!gone && errors.length === 2 && errors.every((e) => e instanceof SchoologyError && e.status === 403)) throw errors[0];
  return gone;
}

/* ── Sending ───────────────────────────────────────────────────────────── */

type Parsed<T> = ({ ok: true } & T) | { ok: false; error: string };

/** A subject line: one line, control characters out, spaces collapsed. */
function cleanSubject(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A message body: Windows line endings unified, control characters (but tabs and line breaks) out. */
function cleanMessage(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export const MAX_MESSAGE_FILES = 10;
/** Files uploaded for a message (POST /submit/upload with purpose "message"): their ids, digits only, each once. */
function parseFileIds(value: unknown): Parsed<{ fileIds: string[] }> {
  if (value === undefined || value === null) return { ok: true, fileIds: [] };
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_FILES) return { ok: false, error: "bad_files" };
  const fileIds: string[] = [];
  for (const raw of value) {
    const id = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "bad_files" };
    if (!fileIds.includes(id)) fileIds.push(id);
  }
  return { ok: true, fileIds };
}
/** The words, which may be empty when files go with them. */
function parseTextWith(value: unknown, files: string[]): Parsed<{ message: string }> {
  if (files.length && (value === undefined || value === null || (typeof value === "string" && !value.trim()))) return { ok: true, message: "" };
  return parseText(value);
}

function parseText(value: unknown): Parsed<{ message: string }> {
  if (typeof value !== "string") return { ok: false, error: "empty_message" };
  const message = cleanMessage(value);
  if (message.length > MAX_MESSAGE) return { ok: false, error: "message_too_long" };
  if (!message.trim()) return { ok: false, error: "empty_message" };
  return { ok: true, message: message.trim() };
}

/**
 * POST /messages's body: `{ recipientIds: ["123"], subject, message }`.
 * 1 to 20 recipients, ids digits only (the student's own id is dropped),
 * a subject of 1 to 200 characters and a message of up to 10000.
 */
export function parseNewMessage(body: unknown, me: string): Parsed<{ recipientIds: string[]; subject: string; message: string; fileIds: string[] }> {
  if (!isObject(body)) return { ok: false, error: "invalid_body" };
  const ids = body.recipientIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_RECIPIENTS) return { ok: false, error: "bad_recipients" };
  const recipientIds: string[] = [];
  for (const raw of ids) {
    const id = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "bad_recipients" };
    if (id !== me && !recipientIds.includes(id)) recipientIds.push(id);
  }
  if (recipientIds.length === 0) return { ok: false, error: "bad_recipients" };
  if (typeof body.subject !== "string") return { ok: false, error: "empty_subject" };
  const subject = cleanSubject(body.subject);
  if (subject.length > MAX_SUBJECT) return { ok: false, error: "subject_too_long" };
  if (!subject) return { ok: false, error: "empty_subject" };
  const files = parseFileIds(body.fileIds);
  if (!files.ok) return files;
  const text = parseTextWith(body.message, files.fileIds);
  if (!text.ok) return text;
  return { ok: true, recipientIds, subject, message: text.message, fileIds: files.fileIds };
}

/** POST /messages/reply's body: `{ id, message }`. */
export function parseReply(body: unknown): Parsed<{ id: string; message: string; fileIds: string[] }> {
  if (!isObject(body)) return { ok: false, error: "invalid_body" };
  const id = typeof body.id === "number" && Number.isSafeInteger(body.id) ? String(body.id) : body.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "bad_request" };
  const files = parseFileIds(body.fileIds);
  if (!files.ok) return files;
  const text = parseTextWith(body.message, files.fileIds);
  if (!text.ok) return text;
  return { ok: true, id, message: text.message, fileIds: files.fileIds };
}

export type SendResult = { ok: true; id: string } | { ok: false; error: "recipient_not_allowed" | "school_blocks_new_messages" | "not_found" | "no_recipients" | "too_many_recipients" };

/**
 * A new thread. Every recipient must be someone GET /messages/recipients
 * lists for this student, so this can't be used to message arbitrary users.
 * A recipients list that can't be read throws (the route answers 502): with
 * no list there's nothing to check against.
 */
async function allowedRecipients(creds: Credentials & { uid?: string }, wanted: string[]): Promise<Set<string>> {
  const allowed = new Set(adaptRecipients(await getRecipients(creds).catch(() => [])).map((r) => r.id));
  if (wanted.every((id) => allowed.has(id)) || !creds.uid) return allowed;
  const sections = (await getSections(creds.uid, creds).catch(() => [])).slice(0, 15);
  await Promise.all(sections.map(async (sec: Raw) => {
    const id = String(sec?.id ?? "");
    if (!ID_RE.test(id)) return;
    const rows = await getAdminEnrollments(id, creds).catch(() => []);
    for (const t of teacherRows(rows, creds.uid!)) allowed.add(t.id);
  }));
  // someone they found with Add contacts: Schoology still shows them their profile (GET /users/{id}); Schoology has
  // the last word on the send itself
  const rest = wanted.filter((id) => !allowed.has(id) && ID_RE.test(id)).slice(0, 5);
  await Promise.all(rest.map(async (id) => {
    const u: any = await schoologyGet(`/users/${id}`, creds).catch(() => null);
    if (u && String(u.uid ?? u.id ?? "") === id) allowed.add(id);
  }));
  return allowed;
}

export async function sendNewMessage(creds: Credentials & { uid?: string }, input: { recipientIds: string[]; subject: string; message: string; fileIds?: string[] }): Promise<SendResult> {
  const allowed = await allowedRecipients(creds, input.recipientIds);
  if (!input.recipientIds.every((id) => allowed.has(id))) return { ok: false, error: "recipient_not_allowed" };
  let answer: Raw | null;
  try {
    answer = await schoologyPost<Raw>("/messages", creds, {
      subject: input.subject,
      message: messageHtml(input.message),
      recipient_ids: input.recipientIds.join(","),
      ...(input.fileIds && input.fileIds.length ? { "file-attachment": { id: input.fileIds } } : {}),
    });
  } catch (error) {
    // Schoology's own "no": "Some or all of the recipients you entered are invalid" (400) is
    // the school's messaging permissions, not a broken request. Replies still work.
    if (error instanceof SchoologyError && (error.status === 400 || error.status === 403) && /recipient/i.test(String(error.body ?? ""))) return { ok: false, error: "school_blocks_new_messages" };
    throw error;
  }
  const first = Array.isArray(answer?.message) ? answer?.message[0] : answer?.message;
  const id = String(answer?.id ?? first?.id ?? "");
  return { ok: true, id: ID_RE.test(id) ? id : "" };
}

/**
 * A reply: the thread is read from Schoology for its subject and the other
 * participants (never from the browser), then the reply goes to them.
 */
export async function sendReply(creds: Credentials, me: string, input: { id: string; message: string; fileIds?: string[] }): Promise<SendResult> {
  const rows = await getThread(input.id, creds);
  if (!rows) return { ok: false, error: "not_found" };
  const recipients = threadParticipants(rows, me);
  if (recipients.length === 0) return { ok: false, error: "no_recipients" };
  if (recipients.length > MAX_REPLY_RECIPIENTS) return { ok: false, error: "too_many_recipients" };
  await schoologyPost(`/messages/${input.id}`, creds, {
    subject: threadSubject(rows) || "No subject",
    message: messageHtml(input.message),
    recipient_ids: recipients.join(","),
    ...(input.fileIds && input.fileIds.length ? { "file-attachment": { id: input.fileIds } } : {}),
  });
  return { ok: true, id: input.id };
}
