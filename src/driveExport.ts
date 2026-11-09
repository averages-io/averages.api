// Google files over 10 MB as Word, Excel, PowerPoint, PDF or CSV (2026-11-09, Martin: "google only makes pdf up to 10 mb").
//
// Drive's files.export, which the browser uses, stops at 10 MB (exportSizeLimitExceeded). A Google file's own
// export links on docs.google.com don't have that limit. They can't be fetched from the browser (no CORS), so the
// API fetches one here with the student's own Drive token and streams it back, never stored.
//
// Safety: the browser sends only a file id and a type. The link comes from Google's own answer for that file and
// must be https on docs.google.com; redirects are followed by hand (3 at most) and only to docs.google.com or
// *.googleusercontent.com, and the token is only ever sent to docs.google.com.

export const DRIVE_EXPORT_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  png: "image/png",
} as const;
export type DriveExportType = keyof typeof DRIVE_EXPORT_TYPES;

export const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
/** The same cap as a turn-in upload (submit.ts MAX_UPLOAD_BYTES). */
export const DRIVE_EXPORT_MAX_BYTES = 95 * 1024 * 1024;
const MAX_HOPS = 3;
const TIMEOUT_MS = 60_000;

export class DriveExportError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function isDriveExportType(x: unknown): x is DriveExportType {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(DRIVE_EXPORT_TYPES, x);
}

/** A host the export may come from. `withToken`: only Google Docs itself gets the student's token. */
export function exportHostOk(raw: string, withToken: boolean): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  if (h === "docs.google.com") return true;
  return !withToken && h.endsWith(".googleusercontent.com");
}

/** A plain file name for the download (no folders, no control characters), with the type's extension. */
export function exportFileName(name: unknown, as: DriveExportType): string {
  const base = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .replace(/\.(pdf|docx|xlsx|pptx|csv|png)$/i, "")
    .slice(0, 180);
  return `${base || "Google file"}.${as}`;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The file as `as`: { body, length (null when Google doesn't say), name, type }. Throws DriveExportError:
 * file_gone (404), download_blocked (403: no access, or the owner turned downloads off),
 * not_exportable (that type isn't offered for this file), file_too_large, cloud_download_failed.
 */
export async function openDriveExport(token: string, fileId: string, as: DriveExportType, f: FetchLike = fetch) {
  if (!DRIVE_FILE_ID_RE.test(fileId)) throw new DriveExportError("file_gone", 404);
  const auth = { Authorization: `Bearer ${token}` };
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType,trashed,exportLinks&supportsAllDrives=true`;
  const meta = await f(metaUrl, { headers: auth, signal: AbortSignal.timeout(15_000) });
  if (meta.status === 404) throw new DriveExportError("file_gone", 404);
  if (meta.status === 401 || meta.status === 403) throw new DriveExportError("download_blocked", 403);
  if (!meta.ok) throw new DriveExportError("cloud_download_failed", 502);
  const info: any = await meta.json().catch(() => ({}));
  if (info?.trashed) throw new DriveExportError("file_gone", 404);
  const type = DRIVE_EXPORT_TYPES[as];
  const link = info?.exportLinks && typeof info.exportLinks[type] === "string" ? info.exportLinks[type] : "";
  if (!link) throw new DriveExportError("not_exportable", 422);
  if (!exportHostOk(link, true)) throw new DriveExportError("cloud_download_failed", 502);

  let url = link;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const toDocs = exportHostOk(url, true);
    res = await f(url, { headers: toDocs ? auth : {}, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status < 300 || res.status >= 400) break;
    const next = res.headers.get("Location");
    await res.body?.cancel().catch(() => {});
    if (!next || hop === MAX_HOPS) throw new DriveExportError("cloud_download_failed", 502);
    const resolved = new URL(next, url).toString();
    if (!exportHostOk(resolved, false)) throw new DriveExportError("cloud_download_failed", 502);
    url = resolved;
  }
  if (!res) throw new DriveExportError("cloud_download_failed", 502);
  if (res.status === 404) throw new DriveExportError("file_gone", 404);
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw new DriveExportError("download_blocked", 403);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new DriveExportError("cloud_download_failed", 502);
  }
  // A sign-in page instead of the file means Google didn't take the token.
  const got = (res.headers.get("Content-Type") || "").toLowerCase();
  if (got.startsWith("text/html")) {
    await res.body.cancel().catch(() => {});
    throw new DriveExportError("download_blocked", 403);
  }
  const declared = res.headers.get("Content-Length");
  const length = declared && /^\d{1,12}$/.test(declared) ? Number(declared) : null;
  if (length !== null && length > DRIVE_EXPORT_MAX_BYTES) {
    await res.body.cancel().catch(() => {});
    throw new DriveExportError("file_too_large", 413);
  }
  return { body: res.body, length, name: exportFileName(info?.name, as), type };
}

/** Passes bytes through and fails the stream past `max` (when Google didn't say the size). */
export function capStream(max: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > max) ctl.error(new DriveExportError("file_too_large", 413));
      else ctl.enqueue(chunk);
    },
  });
}
