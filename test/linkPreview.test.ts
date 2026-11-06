// Link previews: which addresses may be fetched, what a page's tags give, and that redirects and pictures are checked too.
import { getLinkImage, getLinkPreview, isSafeWebTarget, parseTarget, previewFromHtml } from "../src/linkPreview.ts";

let passed = 0, failed = 0;
function check(name: string, a: unknown, e: unknown) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${E}\n        actual:   ${A}`); }
}

console.log("which addresses");
const ok = (s: string) => { try { return isSafeWebTarget(new URL(s)); } catch { return false; } };
check("public https and http pages", [ok("https://www.khanacademy.org/math"), ok("http://example.com/a?b=1")], [true, true]);
check("never: IP literals, localhost, private names, ports, logins, other schemes",
  ["http://127.0.0.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://0x7f.0.0.1/", "http://2130706433/", "http://localhost/", "http://printer.local/", "http://db.internal/", "https://example.com:8443/", "https://u:p@example.com/", "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/x", "http://intranet/"].map(ok),
  Array(14).fill(false));
check("parseTarget drops the #part and refuses junk", [parseTarget("https://example.com/a#b")?.toString(), parseTarget("not a url"), parseTarget("x".repeat(3000)), parseTarget(undefined)], ["https://example.com/a", null, null, null]);

console.log("reading a page");
const page = new URL("https://www.example.com/articles/one");
const p1 = previewFromHtml(`<!doctype html><html><head><title>Fallback title</title>
  <meta property="og:title" content="The &amp; Real &#x2019;Title&#39;">
  <meta property="og:site_name" content="Example News">
  <meta name="description" content="A &lt;b&gt;short&lt;/b&gt; description">
  <meta property="og:image" content="/img/card.png">
  <link rel="icon" href="//cdn.example.com/fav.png">
  </head><body><meta property="og:title" content="not in head"></body></html>`, page);
check("og tags, entities decoded, relative picture made absolute",
  [p1.title, p1.site, p1.description, p1.image, p1.icon],
  ["The & Real ’Title'", "Example News", "A short description", "https://www.example.com/img/card.png", "https://cdn.example.com/fav.png"]);
const p2 = previewFromHtml(`<head><title> Just a title </title></head>`, page);
check("only a <title>: it, the host as the site, /favicon.ico", [p2.title, p2.site, p2.image, p2.icon], ["Just a title", "example.com", "", "https://www.example.com/favicon.ico"]);
const p3 = previewFromHtml(`<head><meta property="og:image" content="http://10.0.0.5/x.png"><meta property="og:title" content="${"A".repeat(400)}"></head>`, page);
check("a picture on a private address is dropped; long titles are cut", [p3.image, p3.title.length <= 140, p3.title.endsWith("…")], ["", true, true]);

const p4 = previewFromHtml(`<head><title>Just a moment...</title><meta property="og:image" content="/x.png"></head>`, page);
check("a bot-check page gives no title or picture", [p4.title, p4.image, p4.site], ["", "", "example.com"]);

console.log("fetching");
let seen: string[] = [];
let answer: (u: string) => Response = () => new Response("");
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input);
  seen.push(u + " " + JSON.stringify(Object.keys((init?.headers as Record<string, string>) ?? {}).sort()));
  return answer(u);
}) as typeof fetch;
answer = (u) => u.includes("/start") ? new Response(null, { status: 301, headers: { Location: "/final" } })
  : new Response(`<head><meta property="og:title" content="Landed"></head>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const r1 = await getLinkPreview(new URL("https://example.com/start"));
check("follows a redirect on the same public site", [r1.title, r1.url, seen.length], ["Landed", "https://example.com/start", 2]);
check("no cookies or credentials are sent", seen.every((s) => !/Cookie|Authorization/.test(s)), true);
seen = [];
answer = () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } });
const r2 = await getLinkPreview(new URL("https://example.com/sneaky"));
check("a redirect to a private address is never followed (a bare preview)", [r2.title, r2.site, seen.length], ["", "example.com", 1]);
seen = [];
answer = () => new Response(null, { status: 302, headers: { Location: "https://example.com/loop" } });
await getLinkPreview(new URL("https://example.com/loop0"));
check("a redirect loop stops after 4 more hops", seen.length, 5);
answer = () => new Response("%PDF-1.4", { headers: { "Content-Type": "application/pdf" } });
check("not a web page: a bare preview", (await getLinkPreview(new URL("https://example.com/file.pdf"))).title, "");

console.log("pictures");
answer = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
const i1 = await getLinkImage(new URL("https://example.com/a.png"));
check("a PNG comes through, marked nosniff and sandboxed", [i1?.status, i1?.headers.get("Content-Type"), i1?.headers.get("X-Content-Type-Options"), /sandbox/.test(i1?.headers.get("Content-Security-Policy") ?? "")], [200, "image/png", "nosniff", true]);
answer = () => new Response("<svg onload=alert(1)>", { headers: { "Content-Type": "image/svg+xml" } });
check("SVG never (it can carry script)", await getLinkImage(new URL("https://example.com/a.svg")), null);
answer = () => new Response("<html>", { headers: { "Content-Type": "text/html" } });
check("a page pretending to be a picture: no", await getLinkImage(new URL("https://example.com/a.png")), null);
answer = () => new Response(new Uint8Array(3 * 1024 * 1024 + 10), { headers: { "Content-Type": "image/jpeg" } });
check("over 3 MB: no", await getLinkImage(new URL("https://example.com/big.jpg")), null);

answer = () => new Response(new Uint8Array([0, 0, 1, 0]), { headers: { "Content-Type": "image/x-icon" } });
check("a site icon (.ico) comes through", (await getLinkImage(new URL("https://example.com/favicon.ico")))?.status, 200);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
