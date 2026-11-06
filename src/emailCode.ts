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
