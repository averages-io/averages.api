/**
 * The file converter (2026-10-15): a small container that turns a PDF into a
 * Word document, for the type pill's "Word" on Canva Docs. Canva's API can
 * export a PDF, a PowerPoint or images, but not Word (Canva's own Download
 * menu can); so the PDF Canva makes goes through here on its way to the
 * student's turn-in.
 *
 * - Cloudflare Containers: `Converter` is a container-backed Durable Object
 *   (wrangler.jsonc "containers"), built from container/Dockerfile: Python
 *   with pdf2docx, a tiny HTTP server on port 8080 (container/server.py).
 * - Nothing is kept: the PDF goes in, the .docx comes out, both only in
 *   memory and a temporary folder that's deleted at once. No internet from
 *   inside the container.
 * - It sleeps after a few minutes with nothing to do, so a conversion after a
 *   quiet spell waits a few seconds for it to start.
 * - Switched by CONVERT_ENABLED ("1" on) and the CONVERTER binding. Off, the
 *   app doesn't offer Word.
 */

import { Container, getRandom } from "@cloudflare/containers";

export class Converter extends Container {
  defaultPort = 8080;
  sleepAfter = "3m";
  enableInternet = false;
}

/** How many containers share the work (wrangler.jsonc max_instances is the ceiling). */
export const CONVERTER_INSTANCES = 3;
/** A conversion that takes longer than this has gone wrong (a huge or odd PDF). */
export const CONVERT_TIMEOUT_MS = 150_000;

export class ConvertError extends Error {
  status: number;
  constructor(code: "convert_failed" | "convert_unavailable" | "file_too_large", status: number) {
    super(code);
    this.name = "ConvertError";
    this.status = status;
  }
}

export interface ConvertEnv {
  CONVERT_ENABLED?: string;
  CONVERTER?: DurableObjectNamespace<Converter>;
}

export function converterOn(env: ConvertEnv): boolean {
  return env.CONVERT_ENABLED === "1" && !!env.CONVERTER;
}

const isPdf = (b: Uint8Array) => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d; // "%PDF-"
const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; // a .docx is a zip

/** PDF bytes in, .docx bytes out. Throws ConvertError. */
export async function pdfToDocx(env: ConvertEnv, pdf: Uint8Array): Promise<Uint8Array> {
  if (!converterOn(env)) throw new ConvertError("convert_unavailable", 503);
  if (!isPdf(pdf)) throw new ConvertError("convert_failed", 422);
  let res: Response;
  try {
    const stub = await getRandom(env.CONVERTER!, CONVERTER_INSTANCES);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("convert_timeout")), CONVERT_TIMEOUT_MS);
    });
    try {
      res = await Promise.race([
        stub.fetch(
          new Request("http://converter/pdf-to-docx", {
            method: "POST",
            headers: { "Content-Type": "application/pdf", "Content-Length": String(pdf.byteLength) },
            body: pdf,
          }),
        ),
        late,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (error) {
    console.error("convert_unreachable", error instanceof Error ? error.message : String(error));
    throw new ConvertError("convert_unavailable", 503);
  }
  if (res.status === 413) throw new ConvertError("file_too_large", 413);
  if (res.status === 422) throw new ConvertError("convert_failed", 422);
  if (!res.ok) {
    console.error("convert_failed_status", res.status);
    await res.body?.cancel().catch(() => {});
    throw new ConvertError("convert_unavailable", 503);
  }
  const out = new Uint8Array(await res.arrayBuffer());
  if (!isZip(out)) throw new ConvertError("convert_failed", 422);
  return out;
}
