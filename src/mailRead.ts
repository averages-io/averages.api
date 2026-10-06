/**
 * Reading an incoming email well enough to show it (2026-10-06): the sender,
 * the subject and the message text, out of the raw MIME Email Routing hands
 * the Worker. Used for Martin's copy of each email to schools@averages.io
 * (index.ts's handleSchoolsEmail), which also carries the original as an
 * attachment, so this only has to be good, never perfect.
 *
 * No library: a small reader for what school email actually looks like
 * (plain text and/or HTML, multipart/alternative inside multipart/mixed,
 * base64 or quoted-printable, utf-8 or another charset). Bounded on purpose:
 * at most 2 MB is read, 6 levels deep, 40 parts, and 20,000 characters kept.
 */

const MAX_READ = 2 * 1024 * 1024;
const MAX_DEPTH = 6;
const MAX_PARTS = 40;
export const MAX_TEXT = 20_000;

interface Part {
  headers: Map<string, string>;
  body: string;
}

/** Bytes as a "binary" string (one char per byte), so parts can be cut by index. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function splitPart(raw: string): Part {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : "";
  const headers = new Map<string, string>();
  // Unfold continuation lines, then keep the first of each header.
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(i + 1).trim());
  }
  return { headers, body };
}

/** A header parameter, like boundary="x" or charset=utf-8. */
function param(value: string, name: string): string {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(value);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

function decodeTransfer(body: string, encoding: string): string {
  const enc = encoding.toLowerCase();
  if (enc === "base64") {
    try {
      return atob(body.replace(/[^A-Za-z0-9+/=]/g, ""));
    } catch {
      return "";
    }
  }
  if (enc === "quoted-printable") {
    return body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

function decodeCharset(binary: string, charset: string): string {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** HTML to readable text: line breaks for blocks, tags out, entities in. Linear: no nested quantifiers. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^<>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The message text: the first text/plain part, else the first text/html one as text. */
export function readEmailText(bytes: Uint8Array): string {
  const raw = latin1(bytes.subarray(0, MAX_READ));
  let plain = "";
  let html = "";
  let parts = 0;
  const walk = (chunk: string, depth: number) => {
    if (depth > MAX_DEPTH || parts++ > MAX_PARTS || (plain && html)) return;
    const part = splitPart(chunk);
    const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
    if (type.startsWith("multipart/")) {
      const boundary = param(part.headers.get("content-type") ?? "", "boundary");
      if (!boundary) return;
      const pieces = part.body.split("--" + boundary);
      // pieces[0] is the preamble; the last one starts with "--" (the end marker).
      for (const piece of pieces.slice(1)) {
        if (piece.startsWith("--")) break;
        walk(piece.replace(/^\r?\n/, ""), depth + 1);
      }
      return;
    }
    if ((part.headers.get("content-disposition") ?? "").toLowerCase().startsWith("attachment")) return;
    const charset = param(part.headers.get("content-type") ?? "", "charset");
    const encoding = part.headers.get("content-transfer-encoding") ?? "";
    if (type.startsWith("text/plain") && !plain) plain = decodeCharset(decodeTransfer(part.body, encoding), charset);
    else if (type.startsWith("text/html") && !html) html = decodeCharset(decodeTransfer(part.body, encoding), charset);
  };
  walk(raw, 0);
  const text = (plain.trim() ? plain : htmlToText(html.slice(0, 200_000))).replace(/\r\n/g, "\n").trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n\n[cut short: the full email is attached]" : text;
}
