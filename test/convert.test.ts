/**
 * The file converter's Worker side (src/convert.ts, 2026-10-15): when it's on,
 * what goes to the container, and how its answers become errors. The
 * container itself (container/server.py) is tested by running it; see
 * container/README.md.
 *
 * Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/convert.test.ts
 */
import { ConvertError, converterOn, pdfToDocx } from "../src/convert.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

const PDF = new TextEncoder().encode("%PDF-1.7 a doc");
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9]);
let answer: () => Response | Promise<Response> = () => new Response(DOCX);
const sent: { url: string; method: string; type: string | null; body: number[] }[] = [];
const CONVERTER: any = {
  idFromName: (n: string) => n,
  get: () => ({
    async fetch(req: Request) {
      sent.push({ url: req.url, method: req.method, type: req.headers.get("Content-Type"), body: Array.from(new Uint8Array(await req.arrayBuffer())) });
      return answer();
    },
  }),
};
const ON = { CONVERT_ENABLED: "1", CONVERTER };
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof ConvertError ? [e.message, e.status] : String(e);
  }
};

console.log("switch");
check("on with the binding and \"1\"", converterOn(ON), true);
check("off without the binding", converterOn({ CONVERT_ENABLED: "1" }), false);
check("off unless exactly \"1\"", [converterOn({ CONVERT_ENABLED: "0", CONVERTER }), converterOn({ CONVERT_ENABLED: "true", CONVERTER }), converterOn({ CONVERTER })], [false, false, false]);

console.log("\nconverting");
{
  const out = await pdfToDocx(ON, PDF);
  check("the .docx comes back", Array.from(out), Array.from(DOCX));
  check("the PDF was POSTed to /pdf-to-docx as a PDF", [sent[0].url, sent[0].method, sent[0].type, sent[0].body], ["http://converter/pdf-to-docx", "POST", "application/pdf", Array.from(PDF)]);
  sent.length = 0;
  check("off: convert_unavailable, nothing sent", [await codeOf(pdfToDocx({ CONVERTER }, PDF)), sent.length], [["convert_unavailable", 503], 0]);
  check("not a PDF: refused before the container", [await codeOf(pdfToDocx(ON, new TextEncoder().encode("<html>"))), sent.length], [["convert_failed", 422], 0]);
  answer = () => new Response('{"error":"too_many_pages"}', { status: 413 });
  check("too big / too many pages: file_too_large", await codeOf(pdfToDocx(ON, PDF)), ["file_too_large", 413]);
  answer = () => new Response('{"error":"convert_failed"}', { status: 422 });
  check("the container couldn't: convert_failed", await codeOf(pdfToDocx(ON, PDF)), ["convert_failed", 422]);
  answer = () => new Response("oops", { status: 500 });
  check("the container broke: convert_unavailable", await codeOf(pdfToDocx(ON, PDF)), ["convert_unavailable", 503]);
  answer = () => { throw new Error("container not running"); };
  check("can't reach it: convert_unavailable", await codeOf(pdfToDocx(ON, PDF)), ["convert_unavailable", 503]);
  answer = () => new Response("not a zip");
  check("an answer that isn't a .docx: convert_failed", await codeOf(pdfToDocx(ON, PDF)), ["convert_failed", 422]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
