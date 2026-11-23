// "Verify your email" codes.

export const EMAIL_CODE_PURPOSE = "email-code-v1";
export const EMAIL_CODE_TTL = 10 * 60;
export const DEFAULT_EMAIL_FROM = "no-reply@averages.io";

/** The Email Service binding's shape (only what's used here). */
export interface SendEmailBinding {
  send(message: {
    to: string;
    from: string | { email: string; name?: string };
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

/** An address we'll send to: one plain address, nothing that could add a second recipient or a header. */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(e)) return null;
  if (/\.\./.test(e) || e.startsWith(".") || e.split("@")[0].endsWith(".")) return null;
  return e;
}

/** Six digits, every value equally likely. */
export function newCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_294_000_000) return String(buf[0] % 1_000_000).padStart(6, "0"); // 4,294,000,000 is a multiple of 1,000,000
  }
}

/** HMAC-SHA256 of the code for this student and address (hex). */
export async function codeHash(secret: string, uid: string, email: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret + ":" + EMAIL_CODE_PURPOSE), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${uid}\n${email}\n${code}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Same length and same characters, without stopping at the first difference. */
export function sameHash(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The email itself: plain words, the code big, nothing to click. */
export function codeMessage(code: string): { subject: string; text: string; html: string } {
  const subject = `${code} is your Averages.io code`;
  const text = [
    `Your Averages.io code is ${code}.`,
    "",
    "Type it in Averages.io to confirm this is your email. It works for 10 minutes.",
    "",
    "If you didn't ask for this, you can ignore this email. Nobody can use it without the code.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14151f">
<div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
<p style="margin:0 0 8px;font-size:15px;font-weight:700">Your Averages.io code</p>
<p style="margin:0 0 16px;font-size:34px;font-weight:800;letter-spacing:6px">${code}</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#44465a">Type it in Averages.io to confirm this is your email. It works for 10 minutes.</p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#6b6d82">If you didn't ask for this, you can ignore this email. Nobody can use it without the code.</p>
</div></body></html>`;
  return { subject, text, html };
}

/** Email Service's error codes, as what the app says. */
export function sendFailure(err: unknown): { status: 400 | 429 | 502; error: string } {
  const code = String((err as { code?: unknown })?.code ?? "");
  if (code === "E_RECIPIENT_SUPPRESSED" || code === "E_RECIPIENT_NOT_ALLOWED" || code === "E_VALIDATION_ERROR" || code === "E_FIELD_MISSING") return { status: 400, error: "email_rejected" };
  if (code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED") return { status: 429, error: "email_busy" };
  return { status: 502, error: "email_failed" };
}

/* ── Is this address worth a code? (2026-11-18, Martin: check it's real before spending one of the month's emails) ──
 * Nothing can prove a mailbox exists without emailing it, but three quick checks stop most bad addresses first:
 *  1. throwaway inboxes (mailinator and the like): turned down;
 *  2. a typo of a big email provider (gmial.com): "did you mean gmail.com?", once; sending again with force goes ahead;
 *  3. the domain must be able to get email: DNS (over HTTPS, Cloudflare's resolver, ~10-50 ms) must show mail servers
 *     (MX), or at least an address for the domain itself. A resolver that doesn't answer never blocks anyone. */
export const THROWAWAY_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "sharklasers.com", "grr.la", "10minutemail.com",
  "10minutemail.net", "temp-mail.org", "tempmail.com", "tempmail.net", "tempmailo.com", "tempr.email", "yopmail.com", "yopmail.net",
  "trashmail.com", "trashmail.de", "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com",
  "mintemail.com", "mohmal.com", "emailondeck.com", "burnermail.io", "mailnesia.com", "mytemp.email", "spamgourmet.com",
  "discard.email", "mailcatch.com", "inboxkitten.com", "tmail.ws", "moakt.com", "emailfake.com", "fakemail.net", "luxusmail.org",
  "minuteinbox.com", "trash-mail.com", "spambox.us", "1secmail.com", "1secmail.net", "1secmail.org", "mail.tm", "linshiyouxiang.net",
]);
/** The big providers students use: an address one or two letters off one of these is probably a typo. */
const COMMON_DOMAINS = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "live.com", "msn.com", "me.com", "proton.me", "protonmail.com", "comcast.net", "att.net", "verizon.net"];

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // swapped letters
  }
  return d[a.length][b.length];
}
/** A likely typo of a big provider: the corrected address, or null. */
export function typoFix(email: string): string | null {
  const at = email.lastIndexOf("@"), user = email.slice(0, at), dom = email.slice(at + 1);
  if (COMMON_DOMAINS.includes(dom)) return null;
  let best = "", bestD = 3;
  for (const c of COMMON_DOMAINS) { const dd = editDistance(dom, c); if (dd < bestD) { best = c; bestD = dd; } }
  // gmail.co, gmail.con, gmal.com... but not a real school domain that merely looks close (needs 1-2 letters off)
  return best && bestD <= (best.length >= 9 ? 2 : 1) ? `${user}@${best}` : null;
}

type DnsFetch = (url: string, init?: RequestInit) => Promise<Response>;
const domainCache = new Map<string, { ok: boolean | null; at: number }>();
/** Can this domain get email? true / false, or null when DNS didn't answer (never blocks). Cached 6 hours. */
export async function domainTakesMail(domain: string, f: DnsFetch = fetch): Promise<boolean | null> {
  const hit = domainCache.get(domain);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.ok;
  const ask = async (type: string): Promise<{ status: number; answers: number } | null> => {
    try {
      const r = await f(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(2500) });
      if (!r.ok) return null;
      const j = (await r.json()) as { Status?: number; Answer?: { type?: number }[] };
      const want = type === "MX" ? 15 : type === "A" ? 1 : 28;
      return { status: Number(j.Status ?? -1), answers: (j.Answer || []).filter((x) => x && x.type === want).length };
    } catch {
      return null;
    }
  };
  let ok: boolean | null;
  const mx = await ask("MX");
  if (!mx) ok = null;
  else if (mx.status === 3) ok = false;   // NXDOMAIN: the domain doesn't exist
  else if (mx.answers > 0) ok = true;
  else {
    // no mail servers listed: mail goes to the domain's own address, if it has one (RFC 5321)
    const [a, aaaa] = await Promise.all([ask("A"), ask("AAAA")]);
    ok = !a && !aaaa ? null : (a?.answers ?? 0) + (aaaa?.answers ?? 0) > 0;
  }
  domainCache.set(domain, { ok, at: Date.now() });
  return ok;
}
export function clearDomainCache(): void { domainCache.clear(); }

/** Before sending a code: null when it's fine, else the reason (and a fix for a typo). */
export async function addressProblem(email: string, opts: { force?: boolean; fetcher?: DnsFetch } = {}): Promise<{ error: "throwaway_email" | "email_typo" | "email_domain"; suggest?: string } | null> {
  const dom = email.slice(email.lastIndexOf("@") + 1);
  if (THROWAWAY_DOMAINS.has(dom) || [...THROWAWAY_DOMAINS].some((d) => dom.endsWith("." + d))) return { error: "throwaway_email" };
  if (!opts.force) { const fix = typoFix(email); if (fix) return { error: "email_typo", suggest: fix }; }
  if ((await domainTakesMail(dom, opts.fetcher)) === false) return { error: "email_domain" };
  return null;
}
