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
export function validateApplication(body: unknown, endings: readonly string[] = [], allow: readonly string[] = []): { ok: true; value: ApplicationInput; spam: boolean } | { ok: false; fields: Record<string, string> } {
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
  const emailBad = emailProblem(emailRaw, endings, allow);
  if (emailBad) fields.email = emailBad;
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

/* ── Which email addresses can apply (2026-10-07, Martin) ──────────────
 * Only school-style addresses: the endings listed in SCHOOLS_EMAIL_ENDINGS
 * (wrangler.jsonc vars, comma-separated, e.g. "edu,org,us,net"). ".us" also
 * covers state-style school domains like k12.ca.us. Unset or empty: any
 * ending is allowed.
 */
export function emailEndings(raw: unknown): string[] {
  const list = String(raw ?? "")
    .split(/[\s,]+/)
    .map((e) => e.trim().replace(/^\.+/, "").toLowerCase())
    .filter((e) => /^[a-z]{2,24}$/.test(e));
  return [...new Set(list)];
}

/** True when the address ends in one of `endings` (or there's no list). */
export function emailEndingAllowed(email: string, endings: readonly string[]): boolean {
  if (!endings.length) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const last = domain.slice(domain.lastIndexOf(".") + 1);
  return endings.includes(last);
}

/**
 * Exact addresses that may apply whatever their ending (2026-10-07, Martin's
 * own for testing): SCHOOLS_EMAIL_ALLOW, comma-separated, a dashboard SECRET
 * so it stays out of this public repo and out of GET /config/apply.
 */
export function emailAllowList(raw: unknown): string[] {
  return String(raw ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length <= 254 && EMAIL_RE.test(e));
}

/** The one email check the form, the code and the application all share: "" when fine. */
export function emailProblem(value: unknown, endings: readonly string[], allow: readonly string[] = []): "" | "missing" | "invalid" | "ending" {
  const raw = String(value ?? "").trim();
  if (!raw) return "missing";
  if (raw.length > 254 || !EMAIL_RE.test(raw)) return "invalid";
  if (!emailEndingAllowed(raw, endings) && !allow.includes(raw.toLowerCase())) return "ending";
  return "";
}

/** Lowercased for comparing and keying (the form keeps what was typed). */
export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/* ── Cloudflare Turnstile on the application (2026-10-07, Martin) ──────
 * The form shows Cloudflare's check (no puzzle for most people); the API
 * asks Cloudflare whether the token it produced is real before saving
 * anything. On only when both TURNSTILE_SITE_KEY (public, shown to the
 * page) and TURNSTILE_SECRET (a secret) are set.
 */
export const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileOn(env: { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string }): boolean {
  return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
}

/** Where the form lives. The widget (site key 0x4AAAAAAFP990oRx5vTqbEf) is set
 *  up for averages.io and its subdomains. Local hostnames count only when the
 *  API itself is running locally (Cloudflare: "Do not allow local hostnames in
 *  production"). */
const TURNSTILE_HOSTS = new Set(["app.averages.io"]);
const TURNSTILE_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const TURNSTILE_ACTION = "school-apply";

/**
 * Is this Turnstile token real, fresh and from our form? "ok", "failed"
 * (missing, used, expired, or made somewhere else) or "unavailable"
 * (Cloudflare couldn't be asked, or our secret is wrong: the school is told
 * to try again, and a wrong secret is logged so it gets noticed).
 *
 * Tokens work once: Cloudflare answers a replayed token with
 * "timeout-or-duplicate", which is a "failed" here.
 */
export async function checkTurnstile(
  token: unknown,
  secret: string,
  ip: string | null,
  fetcher: typeof fetch = fetch,
  allowLocal = false
): Promise<"ok" | "failed" | "unavailable"> {
  if (typeof token !== "string" || !token || token.length > 2048) return "failed";
  const form = new FormData();
  // Trimmed: a secret pasted into the dashboard with a stray newline is otherwise "invalid".
  form.append("secret", secret.trim());
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  let json: any;
  try {
    const res = await fetcher(TURNSTILE_VERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return "unavailable";
    json = await res.json();
  } catch {
    return "unavailable";
  }
  if (json?.success !== true) {
    const codes: string[] = Array.isArray(json?.["error-codes"]) ? json["error-codes"].map(String) : [];
    // Our side's fault, not the school's: don't make them redo the check forever.
    if (codes.some(c => c === "invalid-input-secret" || c === "missing-input-secret")) {
      console.error("turnstile_secret_rejected", codes.join(","));
      return "unavailable";
    }
    return "failed";
  }
  // Made on our own form (this action, this host), not a token from another
  // form or site. Both must be present: siteverify always returns them.
  if (json.action !== TURNSTILE_ACTION) return "failed";
  const host = String(json.hostname ?? "");
  if (!TURNSTILE_HOSTS.has(host) && !(allowLocal && TURNSTILE_LOCAL_HOSTS.has(host))) return "failed";
  return "ok";
}
