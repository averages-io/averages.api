/**
 * Email for the schools flow (2026-10-06): building messages by hand (no
 * library), and deciding whether an incoming email may get an automatic
 * reply.
 *
 * Cloudflare Email Routing hands the Worker raw messages and takes raw
 * messages back (`message.reply`, `env.SCHOOLS_MAIL.send`), so this writes
 * plain RFC 5322 / MIME: a multipart/alternative with a text part and an HTML
 * part, both base64 (safe for any characters and any line length). Every
 * header value is stripped of line breaks first, so nothing a sender wrote can
 * add a header of its own.
 */

/** The address schools write to. Email Routing sends it to this Worker. */
export const SCHOOLS_ADDRESS = "schools@averages.io";

/** A plain email address: something@domain.tld, nothing that could break a header. */
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

/** The address on its own, lower-cased domain, or "" when it isn't one. */
export function cleanEmail(value: unknown): string {
  const raw = String(value ?? "").trim();
  // "Name <a@b.org>" as well as a bare address.
  const inner = /<([^<>\s]+)>\s*$/.exec(raw)?.[1] ?? raw;
  if (inner.length > 254 || !EMAIL_RE.test(inner)) return "";
  const at = inner.lastIndexOf("@");
  return inner.slice(0, at) + "@" + inner.slice(at + 1).toLowerCase();
}

/** One header line's value: no CR/LF (header injection), trimmed, capped. */
function headerText(value: unknown, max = 300): string {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** RFC 2047 for anything that isn't plain ASCII ("=?UTF-8?B?...?="), else as is. */
export function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  // Split so no encoded word passes 75 characters (RFC 2047 §2), never mid-character.
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (utf8(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(utf8(w))}?=`).join(" ");
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** base64 body, wrapped at 76 characters per line (RFC 2045). */
function b64Body(s: string): string {
  return (b64(utf8(s)).match(/.{1,76}/g) ?? [""]).join("\r\n");
}

function randomId(bytes = 12): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** "Averages.io <schools@averages.io>": the display name quoted only when it needs to be. */
function mailbox(name: string, address: string): string {
  const n = headerText(name, 80);
  if (!n) return address;
  const shown = /^[A-Za-z0-9 .!#$%&'*+/=?^_`{|}~-]+$/.test(n) ? n : encodeHeaderWord(n);
  return `${shown} <${address}>`;
}

export interface MailParts {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  /** The Message-ID this answers (In-Reply-To / References). */
  inReplyTo?: string;
  /** Marks it as an automatic reply (RFC 3834), so other robots don't answer it. */
  autoReply?: boolean;
  /** Files sent along (2026-10-06: the original email, on Martin's copy of a school's email). */
  attachments?: MailAttachment[];
  /** For tests: a fixed date and boundary. */
  now?: Date;
  boundary?: string;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/** An attachment's name, safe inside a quoted header parameter. */
function attachmentName(name: string): string {
  return headerText(name, 120).replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_") || "attachment";
}

function b64Bytes(bytes: Uint8Array): string {
  return (b64(bytes).match(/.{1,76}/g) ?? [""]).join("\r\n");
}

/** A complete raw message, CRLF line endings, ready for EmailMessage. */
export function buildMime(p: MailParts): string {
  const from = cleanEmail(p.from);
  const to = cleanEmail(p.to);
  if (!from || !to) throw new Error("mail_bad_address");
  const boundary = p.boundary ?? `averages_${randomId(10)}`;
  const domain = from.slice(from.lastIndexOf("@") + 1);
  const headers: string[] = [
    `From: ${mailbox(p.fromName ?? "", from)}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(headerText(p.subject, 200))}`,
    `Date: ${(p.now ?? new Date()).toUTCString()}`,
    `Message-ID: <${randomId(16)}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  const replyTo = p.replyTo ? cleanEmail(p.replyTo) : "";
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  // A Message-ID is "<...>" with nothing that could end the header.
  const parent = /^<[^<>\s]{1,250}>$/.test(headerText(p.inReplyTo ?? "")) ? headerText(p.inReplyTo) : "";
  if (parent) headers.push(`In-Reply-To: ${parent}`, `References: ${parent}`);
  if (p.autoReply) headers.push("Auto-Submitted: auto-replied", "X-Auto-Response-Suppress: All", "Precedence: auto_reply");
  const files = (p.attachments ?? []).filter((a) => a && a.data instanceof Uint8Array);
  if (files.length) {
    // multipart/mixed: the text and HTML (as before) first, then each file.
    const outer = `${boundary}_mixed`;
    headers.push(`Content-Type: multipart/mixed; boundary="${outer}"`);
    return [
      ...headers,
      "",
      `--${outer}`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      ...alternative(boundary, p),
      ...files.flatMap((f) => [
        `--${outer}`,
        `Content-Type: ${/^[a-z]+\/[a-z0-9.+-]+$/i.test(f.contentType) ? f.contentType : "application/octet-stream"}; name="${attachmentName(f.filename)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${attachmentName(f.filename)}"`,
        "",
        b64Bytes(f.data),
      ]),
      `--${outer}--`,
      "",
    ].join("\r\n");
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [...headers, "", ...alternative(boundary, p), ""].join("\r\n");
}

/** The text and HTML versions, as the lines of a multipart/alternative body. */
function alternative(boundary: string, p: MailParts): string[] {
  return [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Body(p.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Body(p.html),
    `--${boundary}--`,
  ];
}

/** Anything that only reads headers (the incoming message's are a Headers object). */
export interface HeaderSource {
  get(name: string): string | null;
}

/**
 * May this incoming email get our automatic reply? Never for robots (other
 * auto-replies, bounces, mailing lists, no-reply senders) or our own domain,
 * so two robots can't answer each other forever. The once-per-sender rule is
 * kept by the SchoolsStore.
 */
export function autoReplyAllowed(fromRaw: unknown, headers: HeaderSource): { ok: boolean; reason: string } {
  const from = cleanEmail(fromRaw);
  if (!from) return { ok: false, reason: "no_sender" };
  const [local, domain] = [from.slice(0, from.lastIndexOf("@")).toLowerCase(), from.slice(from.lastIndexOf("@") + 1)];
  if (domain === "averages.io" || domain.endsWith(".averages.io")) return { ok: false, reason: "our_domain" };
  if (/^(mailer-daemon|postmaster|bounces?|abuse|root)$/.test(local) || /no-?reply|do-?not-?reply|bounce/.test(local)) return { ok: false, reason: "robot_sender" };
  const auto = (headers.get("Auto-Submitted") ?? "").trim().toLowerCase();
  if (auto && auto !== "no") return { ok: false, reason: "auto_submitted" };
  const precedence = (headers.get("Precedence") ?? "").trim().toLowerCase();
  if (["bulk", "junk", "list", "auto_reply"].includes(precedence)) return { ok: false, reason: "bulk" };
  if (headers.get("List-Id") || headers.get("List-Unsubscribe")) return { ok: false, reason: "mailing_list" };
  const suppress = (headers.get("X-Auto-Response-Suppress") ?? "").toLowerCase();
  if (/\b(all|autoreply|oof)\b/.test(suppress)) return { ok: false, reason: "suppressed" };
  if (headers.get("X-Autoreply") || headers.get("X-Autorespond") || headers.get("X-Autoresponse")) return { ok: false, reason: "auto_submitted" };
  if ((headers.get("Return-Path") ?? "").trim() === "<>") return { ok: false, reason: "bounce" };
  return { ok: true, reason: "" };
}

/** Text for HTML (element content and quoted attributes). */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
