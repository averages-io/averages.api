// Google files over 10 MB through our API (src/driveExport.ts).
import { exportFileName, exportHostOk, isDriveExportType, openDriveExport, DriveExportError } from "../src/driveExport.ts";

let passed = 0, failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected: ${JSON.stringify(want)}\n        actual:   ${JSON.stringify(got)}`);
}
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ID = "1AbCdEfGhIjKlMnOp";
type Call = { url: string; auth: string | null };
function fake(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as any)?.Authorization ?? null });
    for (const [k, v] of Object.entries(routes)) if (url.startsWith(k)) return v();
    return new Response("nope", { status: 500 });
  };
  return { f, calls };
}
const meta = (links: Record<string, string>, extra = {}) => () => new Response(JSON.stringify({ name: "Big essay", mimeType: "application/vnd.google-apps.document", exportLinks: links, ...extra }), { status: 200 });
const err = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof DriveExportError ? `${e.code} ${e.status}` : String(e); } };

console.log("checks");
check("docx is a type", isDriveExportType("docx"), true);
check("exe is not", isDriveExportType("exe"), false);
check("__proto__ is not", isDriveExportType("__proto__"), false);
check("docs.google.com with the token", exportHostOk("https://docs.google.com/feeds/download/x", true), true);
check("googleusercontent never gets the token", exportHostOk("https://doc-0s-1c-docs.googleusercontent.com/x", true), false);
check("googleusercontent ok without it", exportHostOk("https://doc-0s-1c-docs.googleusercontent.com/x", false), true);
check("http refused", exportHostOk("http://docs.google.com/x", false), false);
check("another host refused", exportHostOk("https://evil.example/x", false), false);
check("look-alike refused", exportHostOk("https://docs.google.com.evil.example/x", false), false);
check("a port refused", exportHostOk("https://docs.google.com:8443/x", false), false);
check("credentials refused", exportHostOk("https://a:b@docs.google.com/x", false), false);
check("name gets the type", exportFileName("Big essay", "docx"), "Big essay.docx");
check("old extension swapped", exportFileName("Report.pdf", "docx"), "Report.docx");
check("slashes and controls cleaned", exportFileName("a/b\u0007c", "pdf"), "a_bc.pdf");
check("empty name", exportFileName("", "xlsx"), "Google file.xlsx");

console.log("downloads");
{
  const { f, calls } = fake({
    "https://www.googleapis.com/drive/v3/files/": meta({ [DOCX]: "https://docs.google.com/feeds/download/documents/export/Export?id=x&exportFormat=docx" }),
    "https://docs.google.com/": () => new Response(null, { status: 302, headers: { Location: "https://doc-0s-1c-docs.googleusercontent.com/export/abc" } }),
    "https://doc-0s-1c-docs.googleusercontent.com/": () => new Response(new Uint8Array(20), { status: 200, headers: { "Content-Type": DOCX, "Content-Length": "20" } }),
  });
  const got = await openDriveExport("tok", ID, "docx", f as any);
  check("follows Google's redirect", [got.name, got.length, got.type], ["Big essay.docx", 20, DOCX]);
  check("token only to Google APIs and Docs", calls.map((c) => [new URL(c.url).hostname, !!c.auth]), [["www.googleapis.com", true], ["docs.google.com", true], ["doc-0s-1c-docs.googleusercontent.com", false]]);
}
check("redirect off Google refused", await err(openDriveExport("tok", ID, "docx", fake({
  "https://www.googleapis.com/drive/v3/files/": meta({ [DOCX]: "https://docs.google.com/x" }),
  "https://docs.google.com/": () => new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/latest" } }),
}).f as any)), "cloud_download_failed 502");
check("export link off Google refused", await err(openDriveExport("tok", ID, "docx", fake({
  "https://www.googleapis.com/drive/v3/files/": meta({ [DOCX]: "https://evil.example/x" }),
}).f as any)), "cloud_download_failed 502");
check("too many redirects", await err(openDriveExport("tok", ID, "docx", fake({
  "https://www.googleapis.com/drive/v3/files/": meta({ [DOCX]: "https://docs.google.com/x" }),
  "https://docs.google.com/": () => new Response(null, { status: 302, headers: { Location: "https://docs.google.com/again" } }),
}).f as any)), "cloud_download_failed 502");
check("type not offered", await err(openDriveExport("tok", ID, "xlsx", fake({ "https://www.googleapis.com/drive/v3/files/": meta({ [DOCX]: "https://docs.google.com/x" }) }).f as any)), "not_exportable 422");
check("gone", await err(openDriveExport("tok", ID, "docx", fake({ "https://www.googleapis.com/drive/v3/files/": () => new Response("{}", { status: 404 }) }).f as any)), "file_gone 404");
check("trashed", await err(openDriveExport("tok", ID, "docx", fake({ "https://www.googleapis.com/drive/v3/files/": meta({ [DOCX]: "https://docs.google.com/x" }, { trashed: true }) }).f as any)), "file_gone 404");
check("no access", await err(openDriveExport("tok", ID, "docx", fake({ "https://www.googleapis.com/drive/v3/files/": () => new Response("{}", { status: 403 }) }).f as any)), "download_blocked 403");
check("a sign-in page is not the file", await err(openDriveExport("tok", ID, "docx", fake({
  "https://www.googleapis.com/drive/v3/files/": meta({ [DOCX]: "https://docs.google.com/x" }),
  "https://docs.google.com/": () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
}).f as any)), "download_blocked 403");
check("over 95 MB", await err(openDriveExport("tok", ID, "docx", fake({
  "https://www.googleapis.com/drive/v3/files/": meta({ [DOCX]: "https://docs.google.com/x" }),
  "https://docs.google.com/": () => new Response(new Uint8Array(1), { status: 200, headers: { "Content-Type": DOCX, "Content-Length": String(96 * 1024 * 1024) } }),
}).f as any)), "file_too_large 413");
check("bad id", await err(openDriveExport("tok", "../x", "docx", fake({}).f as any)), "file_gone 404");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
