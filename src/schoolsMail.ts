/**
 * The words of the schools emails (2026-10-06):
 *   - the automatic reply a school's IT team gets after writing to
 *     schools@averages.io, with the link to the application;
 *   - the email Martin gets for each application.
 *
 * Table layout and inline styles only (what email apps reliably show), no
 * images (nothing to load, nothing that tracks), a text version of each for
 * clients that don't show HTML. Everything a sender typed goes through
 * escapeHtml. No em dashes in the copy.
 */
import { escapeHtml } from "./mail.ts";
import type { Application } from "./schools.ts";

export const APPLY_URL = "https://app.averages.io/schools/apply";
const PRIVACY_URL = "https://averages.io/privacy-policy";
const TERMS_URL = "https://averages.io/terms";

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const BLUE = "#0a1d9e";
const INK = "#14151f";
const MUTED = "#4b4d63";

/** The shared frame: a light page, one white card with a blue title band. */
function frame(title: string, inner: string, footer: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#eef1f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f6;">
<tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;">
<tr><td style="background:${BLUE};padding:22px 28px;font-family:${FONT};font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.01em;">Averages.io</td></tr>
<tr><td style="padding:26px 28px 8px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK};">${inner}</td></tr>
<tr><td style="padding:8px 28px 26px;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">${footer}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 20px;"><tr><td style="border-radius:999px;background:${BLUE};">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
</td></tr></table>`;
}

/** "Re: <their subject>", so it lands in the same thread; a default when they gave none. */
export function replySubject(original: unknown): string {
  const s = String(original ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 150);
  if (!s) return "Averages.io for your school";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** The automatic reply to a school's first email. */
export function autoReplyEmail(originalSubject: unknown): { subject: string; text: string; html: string } {
  const subject = replySubject(originalSubject);
  const steps = [
    ["Apply for your school.", "It takes a minute: your school or district's name, your Canvas address and the email address we should write to."],
    ["We review it and email you.", "When it's approved, the email has the steps to finish setting up in Canvas (a developer key for Averages.io)."],
    ["Students sign in.", "Your school shows up when students pick Canvas on the Averages.io sign-in page."],
  ];
  const inner = `
<p style="margin:0 0 14px;font-size:20px;font-weight:800;color:${INK};">Thanks for getting in touch</p>
<p style="margin:0 0 14px;">A student at your school would like to use Averages.io with Canvas. Averages.io is a free, student-built app that shows each student their own classes, grades and assignments in one place.</p>
<p style="margin:0 0 14px;">It only sees what a student's own Canvas account lets it see, it doesn't keep grades on its servers, and nothing is sold.</p>
<p style="margin:18px 0 8px;font-weight:800;">Turning it on for your school</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${steps
  .map(
    ([title, body], i) => `<tr><td valign="top" style="width:30px;padding:6px 0;"><div style="width:22px;height:22px;border-radius:999px;background:#e6e9f6;color:${BLUE};font-family:${FONT};font-size:12px;font-weight:800;line-height:22px;text-align:center;">${i + 1}</div></td>
<td style="padding:6px 0;font-family:${FONT};font-size:15px;line-height:1.5;color:${INK};"><strong>${escapeHtml(title)}</strong> ${escapeHtml(body)}</td></tr>`
  )
  .join("\n")}
</table>
${button(APPLY_URL, "Apply for your school")}
<p style="margin:0 0 6px;color:${MUTED};font-size:13px;">Or open this link: <a href="${APPLY_URL}" style="color:${BLUE};">${APPLY_URL.replace("https://", "")}</a></p>
<p style="margin:14px 0 0;">Questions? Just reply to this email.</p>`;
  const footer = `This is an automatic reply to your email to schools@averages.io. Averages.io is an independent app made by a student. It isn't made by or affiliated with your school or Instructure.<br>
<a href="${PRIVACY_URL}" style="color:${MUTED};">Privacy Policy</a> &nbsp;·&nbsp; <a href="${TERMS_URL}" style="color:${MUTED};">Terms of Use</a>`;
  const text = [
    "Thanks for getting in touch",
    "",
    "A student at your school would like to use Averages.io with Canvas. Averages.io is a free, student-built app that shows each student their own classes, grades and assignments in one place.",
    "",
    "It only sees what a student's own Canvas account lets it see, it doesn't keep grades on its servers, and nothing is sold.",
    "",
    "Turning it on for your school:",
    ...steps.map(([title, body], i) => `${i + 1}. ${title} ${body}`),
    "",
    `Apply here: ${APPLY_URL}`,
    "",
    "Questions? Just reply to this email.",
    "",
    "This is an automatic reply to your email to schools@averages.io. Averages.io is an independent app made by a student. It isn't made by or affiliated with your school or Instructure.",
    `Privacy Policy: ${PRIVACY_URL}`,
    `Terms of Use: ${TERMS_URL}`,
    "",
  ].join("\r\n");
  return { subject, text, html: frame(subject, inner, footer) };
}

/** Martin's copy of one application. Reply-To is the school's address. */
export function applicationEmail(app: Application, duplicate: boolean): { subject: string; text: string; html: string } {
  const subject = `${duplicate ? "Updated" : "New"} school application: ${app.school}`.slice(0, 180);
  const when = new Date(app.at).toUTCString();
  const rows: [string, string][] = [
    ["School or district", app.school],
    ["Canvas address", app.canvas],
    ["Email when approved", app.email],
    ["Name", app.name || "(not given)"],
    ["Anything else", app.note || "(nothing)"],
    ["Sent", when],
    ["Application id", app.id],
  ];
  const inner = `
<p style="margin:0 0 14px;font-size:20px;font-weight:800;color:${INK};">${duplicate ? "An application was sent again" : "New school application"}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
${rows
  .map(
    ([k, v]) => `<tr><td valign="top" style="padding:8px 12px 8px 0;border-bottom:1px solid #e6e8ef;font-family:${FONT};font-size:13px;font-weight:800;color:${MUTED};white-space:nowrap;">${escapeHtml(k)}</td>
<td style="padding:8px 0;border-bottom:1px solid #e6e8ef;font-family:${FONT};font-size:14px;color:${INK};white-space:pre-wrap;word-break:break-word;">${escapeHtml(v)}</td></tr>`
  )
  .join("\n")}
</table>
<p style="margin:16px 0 0;">Reply to this email to answer ${escapeHtml(app.email)}. To approve, email them the Canvas developer key steps, then add the school to <code>src/schools.ts</code> in the API.</p>`;
  const footer = "Sent by the Averages.io API from app.averages.io/schools/apply.";
  const text = [
    duplicate ? "An application was sent again" : "New school application",
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    `Reply to this email to answer ${app.email}. To approve, email them the Canvas developer key steps, then add the school to src/schools.ts in the API.`,
    "",
  ].join("\r\n");
  return { subject, text, html: frame(subject, inner, footer) };
}
