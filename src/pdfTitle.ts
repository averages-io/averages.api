// A PDF shown in the browser is titled by its own document info, not by its file name: Firefox's and Chrome's PDF
// viewers show "<Title> - <file name>" in the tab. Teachers' PDFs (Google Docs, Word and Schoology's own preview copies)
// very often carry the title "Untitled", so every one of them opened as "Untitled - Lab Report.pdf".
//
// withoutPdfTitle() streams a PDF through unchanged and adds a small incremental update at its end (the standard way
// a PDF is edited without rewriting it): a new, empty document info dictionary. The viewer then has no title to show,
// so the tab shows the file's name. The pages, fonts, links and everything else are untouched.
//
// Only what's at the end of the file is needed (startxref and the trailer, or the cross-reference stream they point
// to), so the file is never held in memory: the last TAIL bytes are kept as it goes by. When anything about the end
// isn't what's expected (encrypted, damaged, a cross-reference stream too big for TAIL), nothing is added and the PDF
// goes through exactly as it came.

const TAIL = 256 * 1024;
const enc = new TextEncoder();

/** Latin-1 view of bytes (one char per byte, so string offsets are byte offsets). */
function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

/** The dictionary text starting at `at` ("<< ... >>", nested dictionaries counted), or "". */
function dictAt(s: string, at: number): string {
  const start = s.indexOf("<<", at);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < s.length - 1; i++) {
    if (s[i] === "<" && s[i + 1] === "<") { depth++; i++; continue; }
    if (s[i] === ">" && s[i + 1] === ">") { depth--; i++; if (depth === 0) return s.slice(start, i + 1); continue; }
  }
  return "";
}

/** The bytes to add at the end of a PDF of `total` bytes whose last bytes are `tail`, or null to add nothing. */
export function titleUpdate(tail: Uint8Array, total: number): Uint8Array | null {
  const s = latin1(tail), base = total - tail.length;
  const sx = s.lastIndexOf("startxref");
  if (sx < 0) return null;
  const m = /^startxref\s+(\d{1,12})/.exec(s.slice(sx));
  if (!m) return null;
  const prev = Number(m[1]);
  if (!Number.isSafeInteger(prev) || prev >= total) return null;

  let dict = "", xrefStream = false;
  if (prev >= base && /^xref\b/.test(s.slice(prev - base, prev - base + 4))) {
    // the trailer of the section startxref points to (a linearized file's is near the start, not the last one)
    const tr = s.indexOf("trailer", prev - base);
    if (tr < 0) return null;
    dict = dictAt(s, tr);
  } else if (prev >= base && /^\d+\s+\d+\s+obj\b/.test(s.slice(prev - base, prev - base + 40))) {
    dict = dictAt(s, prev - base);
    if (!/\/Type\s*\/XRef\b/.test(dict)) return null;
    xrefStream = true;
  } else if (prev < base) {
    // a classic section that started before the kept tail still ends in its trailer, just before startxref
    const tr = s.lastIndexOf("trailer", sx);
    if (tr < 0) return null;
    dict = dictAt(s, tr);
  } else {
    return null;
  }
  if (!dict || /\/Encrypt\b/.test(dict)) return null;
  const size = /\/Size\s+(\d{1,9})\b/.exec(dict), root = /\/Root\s+(\d{1,9}\s+\d{1,5}\s+R)\b/.exec(dict);
  if (!size || !root) return null;
  const n = Number(size[1]);
  const id = /\/ID\s*(\[[^\]]{0,600}\])/.exec(dict);
  const idPart = id ? ` /ID ${id[1]}` : "";

  // starts on a new line whatever the file ended with
  const head = `\n${n} 0 obj\n<<>>\nendobj\n`;
  const infoAt = total + 1; // after the "\n"
  if (!xrefStream) {
    const xrefAt = total + head.length;
    const text = head
      + `xref\n${n} 1\n${String(infoAt).padStart(10, "0")} 00000 n \n`
      + `trailer\n<< /Size ${n + 1} /Root ${root[1]} /Info ${n} 0 R /Prev ${prev}${idPart} >>\n`
      + `startxref\n${xrefAt}\n%%EOF\n`;
    return enc.encode(text);
  }
  const xrefAt = total + head.length;
  const rows = new Uint8Array(12);
  const put = (i: number, off: number) => { rows[i] = 1; rows[i + 1] = (off >>> 24) & 255; rows[i + 2] = (off >>> 16) & 255; rows[i + 3] = (off >>> 8) & 255; rows[i + 4] = off & 255; rows[i + 5] = 0; };
  if (xrefAt > 0xffffffff) return null;
  put(0, infoAt);
  put(6, xrefAt);
  const before = enc.encode(head
    + `${n + 1} 0 obj\n<< /Type /XRef /Size ${n + 2} /W [1 4 1] /Index [${n} 2] /Root ${root[1]} /Info ${n} 0 R /Prev ${prev}${idPart} /Length 12 >>\nstream\n`);
  const after = enc.encode(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
  const out = new Uint8Array(before.length + rows.length + after.length);
  out.set(before, 0);
  out.set(rows, before.length);
  out.set(after, before.length + rows.length);
  return out;
}

/** The PDF, as it streams by, with an empty document info added at its end (see the top of this file). */
export function withoutPdfTitle(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let total = 0;
  let tail = new Uint8Array(0);
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      ctl.enqueue(chunk);
      total += chunk.length;
      if (chunk.length >= TAIL) tail = chunk.slice(chunk.length - TAIL);
      else {
        const keep = Math.min(tail.length, TAIL - chunk.length);
        const next = new Uint8Array(keep + chunk.length);
        next.set(tail.subarray(tail.length - keep), 0);
        next.set(chunk, keep);
        tail = next;
      }
    },
    flush(ctl) {
      try {
        const add = titleUpdate(tail, total);
        if (add) ctl.enqueue(add);
      } catch {
        /* the PDF as it came */
      }
    },
  }));
}
