/**
 * The schools the sign-in page lists (2026-10-06), served by
 * GET /config/schools?lms=schoology|canvas.
 *
 * Canvas: only schools whose Canvas admin has turned Averages.io on (each one
 * gives us its own Canvas app key), so a Canvas school can't sign in until
 * it's listed here. Schoology: districts added over time, to make finding
 * them easier; a student can always type their district's Schoology address
 * instead, listed or not.
 *
 * Both lists start empty. Add a school as { name, domain, aliases? }, where
 * `domain` is the address the school's Schoology or Canvas lives at and
 * `aliases` are other addresses it also answers on.
 */
export interface School {
  name: string;
  domain: string;
  aliases?: string[];
}

export const SCHOOLS: Readonly<Record<"schoology" | "canvas", readonly School[]>> = {
  schoology: [],
  canvas: [],
};

export function schoolsFor(lms: unknown): readonly School[] | null {
  return lms === "schoology" || lms === "canvas" ? SCHOOLS[lms] : null;
}

/* ── Applications (2026-10-06) ──────────────────────────────────────────
 * A school's IT team emails schools@averages.io, gets an automatic reply
 * with a link to app.averages.io/schools/apply, and applies there. Martin
 * approves by hand; the approval email asks for the Canvas developer key.
 */

export interface Application {
  id: string;
  /** Unix ms. */
  at: number;
  school: string;
  /** The Canvas address, as a host: "nmusd.instructure.com". */
  canvas: string;
  /** Where to email when it's approved. */
  email: string;
  /** Optional. */
  name: string;
  note: string;
}

export type ApplicationInput = Omit<Application, "id" | "at">;

/** Plain one-line text: no control characters, spaces collapsed. */
function line(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max + 1);
}

/** A school's Canvas address as a bare host, from whatever was pasted. */
export function canvasHost(value: unknown): string {
  let raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw.length > 300) return "";
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  // A public DNS name: labels of letters, digits and hyphens, a real top-level domain.
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(raw)) return "";
  if (/(^|\.)(localhost|local|internal|test|example|invalid)$/.test(raw)) return "";
  return raw;
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

/**
 * Checks an application from the form. `fields` says what's wrong with each
 * field the page should point at. `spam` is the hidden field a person never
 * sees: filled in means a bot, which gets a polite "ok" and nothing stored.
 */
export function validateApplication(body: unknown): { ok: true; value: ApplicationInput; spam: boolean } | { ok: false; fields: Record<string, string> } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const school = line(b.school, 120);
  if (school.length < 2) fields.school = "missing";
  else if (school.length > 120) fields.school = "too_long";
  const canvasRaw = String(b.canvas ?? "").trim();
  const canvas = canvasHost(canvasRaw);
  if (!canvasRaw) fields.canvas = "missing";
  else if (!canvas) fields.canvas = "invalid";
  const emailRaw = String(b.email ?? "").trim();
  if (!emailRaw) fields.email = "missing";
  else if (emailRaw.length > 254 || !EMAIL_RE.test(emailRaw)) fields.email = "invalid";
  const name = line(b.name, 80);
  if (name.length > 80) fields.name = "too_long";
  const note = String(b.note ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (note.length > 1000) fields.note = "too_long";
  if (Object.keys(fields).length) return { ok: false, fields };
  const at = emailRaw.lastIndexOf("@");
  const email = emailRaw.slice(0, at) + "@" + emailRaw.slice(at + 1).toLowerCase();
  const spam = typeof b.website === "string" && b.website.trim() !== "";
  return { ok: true, value: { school, canvas, email, name, note }, spam };
}
