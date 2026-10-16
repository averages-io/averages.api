/**
 * Save a folder to Canva (2026-10-16): every file in one of the teacher's
 * Course Materials folders becomes a design in the student's Canva, inside a
 * new Canva folder with the same name. A single file works the same way (a
 * folder of one, without the Canva folder).
 *
 * Too slow to do while the student waits (Canva lets one student start 20
 * imports a minute, and each takes a few seconds), so it runs on the retry
 * queue (src/retryQueue.ts): one message per file, spaced SAVE_SPACING_S
 * apart so Canva's limit is never reached. A file Canva or Schoology answers
 * "slow down" or "try later" for waits and goes again; one that can't work
 * (too big, not a file Canva opens) is marked failed and the rest carry on.
 * The student can leave the page: the job keeps going and the page shows its
 * progress when it's opened again.
 *
 *   POST   /canva/save-folder        { name, files: [{ section, kind, parent, file }] }  ->  { job, total }
 *   GET    /canva/save-folder/:job   progress: { total, done, failed, waiting, items: [{ name, state }] }
 *   DELETE /canva/save-folder/:job   stop (files already saved stay in Canva)
 *
 * Where things are kept: the job lives in the student's own CanvaStore (US),
 * with file ids, names and results only. To download the files from
 * Schoology later, the job holds the student's sign-in sealed with
 * SESSION_SECRET (AES-GCM) for at most SAVE_CRED_TTL_S; it's deleted as soon
 * as the last file is done or the job is stopped. The queue messages carry
 * the CanvaStore id, the job id and a file number, nothing else.
 */

import type { RetryOutcome } from "./retryQueue.ts";

/** Files in one job. A bigger folder is refused (the page says to pick a smaller one). */
export const SAVE_MAX_FILES = 50;
/** Jobs still running at once, per student. */
export const SAVE_MAX_ACTIVE = 2;
/** Seconds between files: 15 imports a minute, under Canva's 20 per student. */
export const SAVE_SPACING_S = 4;
/** How long the sealed sign-in may live (and so how long a job can take). */
export const SAVE_CRED_TTL_S = 2 * 60 * 60;
/** Finished jobs are kept this long, so the page can still show how it went. */
export const SAVE_KEEP_MS = 24 * 60 * 60 * 1000;
/** Jobs kept per student, newest first. */
export const SAVE_MAX_JOBS = 10;
/** Canva's own wait after a "slow down": a minute. */
export const SAVE_RATE_WAIT_S = 60;

export const SAVE_JOB_RE = /^[A-Za-z0-9_-]{8,40}$/;
const ID_RE = /^\d{1,24}$/;

export type SaveKind = "assignment" | "document";
export type SaveState = "waiting" | "done" | "failed";

export interface SaveFile {
  section: string;
  kind: SaveKind;
  parent: string;
  file: string;
}

export interface SaveItem extends SaveFile {
  state: SaveState;
  /** The file's name, once read from Schoology. */
  name?: string;
  /** Designs made from it (a long PDF can make more than one). */
  designs?: string[];
  /** Why it failed: a short code (file_too_large, canva_invalid_file, ...). */
  error?: string;
}

export interface SaveJob {
  id: string;
  name: string;
  /** The Canva folder the designs go into; null: Canva's Projects (no folder permission, or one file). */
  folderId: string | null;
  items: SaveItem[];
  /** The student's sign-in, sealed; null once the job is finished or stopped. */
  sealed: string | null;
  uid: string;
  createdAt: number;
  stopped?: boolean;
  finishedAt?: number;
}

/** What the page sees. */
export interface SaveStatus {
  job: string;
  name: string;
  total: number;
  done: number;
  failed: number;
  waiting: number;
  stopped: boolean;
  finished: boolean;
  folder: boolean;
  items: { name: string; state: SaveState; error?: string }[];
}

/** The files from a request body, checked: ids only, at most SAVE_MAX_FILES, no repeats. Null when anything is off. */
export function parseSaveFiles(input: unknown): SaveFile[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > SAVE_MAX_FILES) return null;
  const out: SaveFile[] = [];
  const seen = new Set<string>();
  for (const f of input) {
    if (!f || typeof f !== "object") return null;
    const { section, kind, parent, file } = f as Record<string, unknown>;
    if (typeof section !== "string" || typeof parent !== "string" || typeof file !== "string") return null;
    if (!ID_RE.test(section) || !ID_RE.test(parent) || !ID_RE.test(file)) return null;
    if (kind !== "assignment" && kind !== "document") return null;
    const key = `${section}/${kind}/${parent}/${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ section, kind, parent, file });
  }
  return out;
}

/** A folder name Canva will take: plain text, 1 to 100 characters. */
export function cleanFolderName(input: unknown): string {
  const name = String(input ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(name).slice(0, 100).join("") || "From Averages.io";
}

export function newJobId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

export function publicStatus(job: SaveJob): SaveStatus {
  const count = (s: SaveState) => job.items.filter((i) => i.state === s).length;
  return {
    job: job.id,
    name: job.name,
    total: job.items.length,
    done: count("done"),
    failed: count("failed"),
    waiting: count("waiting"),
    stopped: !!job.stopped,
    finished: !!job.finishedAt,
    folder: !!job.folderId,
    items: job.items.map((i) => ({ name: i.name ?? "", state: i.state, ...(i.error ? { error: i.error } : {}) })),
  };
}

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** The jobs in one student's CanvaStore, under the "savejobs" key (CanvaAccount's keys are separate). */
export class SaveJobs {
  storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  private async all(now: number): Promise<SaveJob[]> {
    const jobs = (await this.storage.get<SaveJob[]>("savejobs")) ?? [];
    // Old finished jobs go; a job whose sign-in ran out can't finish: it's closed.
    return jobs
      .map((j) => (!j.finishedAt && now - j.createdAt > SAVE_CRED_TTL_S * 1000 ? close(j, now, "expired") : j))
      .filter((j) => !j.finishedAt || now - j.finishedAt < SAVE_KEEP_MS);
  }
  private async save(jobs: SaveJob[]): Promise<void> {
    await this.storage.put("savejobs", jobs.slice(0, SAVE_MAX_JOBS));
  }

  /** A new job, or null when SAVE_MAX_ACTIVE are already running. */
  async create(input: { id: string; name: string; folderId: string | null; files: SaveFile[]; sealed: string; uid: string }, now = Date.now()): Promise<SaveJob | null> {
    const jobs = await this.all(now);
    if (jobs.filter((j) => !j.finishedAt).length >= SAVE_MAX_ACTIVE) return null;
    const job: SaveJob = {
      id: input.id,
      name: input.name,
      folderId: input.folderId,
      items: input.files.map((f) => ({ ...f, state: "waiting" as const })),
      sealed: input.sealed,
      uid: input.uid,
      createdAt: now,
    };
    await this.save([job, ...jobs]);
    return job;
  }

  async status(id: string, now = Date.now()): Promise<SaveStatus | null> {
    const job = (await this.all(now)).find((j) => j.id === id);
    return job ? publicStatus(job) : null;
  }

  /** What one queue message should do: the file and the sealed sign-in, or null (stopped, finished, gone). */
  async take(id: string, i: number, now = Date.now()): Promise<{ item: SaveItem; sealed: string; uid: string; folderId: string | null } | null> {
    const jobs = await this.all(now);
    const job = jobs.find((j) => j.id === id);
    const item = job?.items[i];
    if (!job || !item || item.state !== "waiting" || job.stopped || job.finishedAt || !job.sealed) {
      await this.save(jobs);
      return null;
    }
    return { item, sealed: job.sealed, uid: job.uid, folderId: job.folderId };
  }

  /** One file's result. The last one closes the job and deletes the sealed sign-in. */
  async record(id: string, i: number, result: { state: "done" | "failed"; name?: string; designs?: string[]; error?: string }, now = Date.now()): Promise<void> {
    const jobs = await this.all(now);
    const job = jobs.find((j) => j.id === id);
    const item = job?.items[i];
    if (!job || !item) return;
    if (item.state === "waiting") {
      item.state = result.state;
      if (result.name) item.name = result.name;
      if (result.designs?.length) item.designs = result.designs;
      if (result.error) item.error = result.error;
    } else if (result.name && !item.name) item.name = result.name;
    if (!job.finishedAt && job.items.every((x) => x.state !== "waiting")) Object.assign(job, close(job, now));
    await this.save(jobs);
  }

  /** Stops a job: files not started yet are left, the sign-in is deleted. */
  async stop(id: string, now = Date.now()): Promise<SaveStatus | null> {
    const jobs = await this.all(now);
    const job = jobs.find((j) => j.id === id);
    if (!job) return null;
    if (!job.finishedAt) {
      job.stopped = true;
      Object.assign(job, close(job, now));
    }
    await this.save(jobs);
    return publicStatus(job);
  }
}

function close(job: SaveJob, now: number, why?: string): SaveJob {
  return {
    ...job,
    sealed: null,
    finishedAt: now,
    items: why ? job.items.map((i) => (i.state === "waiting" ? { ...i, state: "failed" as const, error: why } : i)) : job.items,
  };
}

/* ── One file, from the queue ─────────────────────────────────────────── */

/** Everything one file needs, so the tests can run it without Schoology or Canva. */
export interface SaveFileDeps {
  take(): Promise<{ item: SaveItem; sealed: string; uid: string; folderId: string | null } | null>;
  record(result: { state: "done" | "failed"; name?: string; designs?: string[]; error?: string }): Promise<void>;
  /** The sealed sign-in, opened; null when it can't be (expired, tampered). */
  openSession(sealed: string): Promise<unknown | null>;
  /** The file's name, size and download path from its assignment or document; null when it isn't there. */
  findFile(session: unknown, item: SaveItem): Promise<{ name: string; size: number; downloadPath: string } | null>;
  download(session: unknown, downloadPath: string): Promise<{ bytes: ArrayBuffer; contentType: string }>;
  canvaToken(uid: string): Promise<string>;
  importFile(token: string, name: string, bytes: ArrayBuffer, contentType: string): Promise<{ id: string }[]>;
  /** The design already imported from a file of that name (Canva refuses the same import twice). */
  findImported(token: string, name: string): Promise<{ id: string } | null>;
  moveToFolder(uid: string, designId: string, folderId: string): Promise<void>;
  maxBytes: number;
}

/** Error codes that mean "try this file again later". */
function passing(code: string, status: number): boolean {
  return code === "canva_rate_limited" || code === "canva_import_timeout" || status === 429 || status === 503 || status === 504 || (status >= 500 && !code.startsWith("canva_invalid"));
}

function codeOf(error: unknown): { code: string; status: number } {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = Number((error as { status?: unknown })?.status) || 0;
  const code = message.match(/\bcanva_[a-z_]+/)?.[0] ?? (status === 413 ? "file_too_large" : status ? `upstream_${status}` : "save_failed");
  return { code, status: code === "canva_rate_limited" ? 429 : status };
}

/**
 * Saves one file. "retry" (or { retryIn }) leaves it waiting for the queue to
 * bring back; "done" and "drop" have recorded the result.
 */
export async function saveOneFile(deps: SaveFileDeps): Promise<RetryOutcome> {
  const work = await deps.take();
  if (!work) return "drop";
  const session = await deps.openSession(work.sealed);
  if (!session) {
    await deps.record({ state: "failed", error: "signed_out" });
    return "drop";
  }
  let name = "";
  try {
    const file = await deps.findFile(session, work.item);
    if (!file) {
      await deps.record({ state: "failed", error: "file_not_found" });
      return "drop";
    }
    name = file.name;
    if (file.size > deps.maxBytes) {
      await deps.record({ state: "failed", name, error: "file_too_large" });
      return "drop";
    }
    const token = await deps.canvaToken(work.uid);
    let designs: { id: string }[];
    try {
      const { bytes, contentType } = await deps.download(session, file.downloadPath);
      designs = await deps.importFile(token, name, bytes, contentType);
    } catch (error) {
      // Saved before (this folder, an earlier try, or Edit in Canva): use that design.
      if (!(error instanceof Error && error.message.includes("canva_duplicate_import"))) throw error;
      const found = await deps.findImported(token, name);
      if (!found) throw error;
      designs = [found];
    }
    if (!designs.length) {
      await deps.record({ state: "failed", name, error: "canva_import_failed" });
      return "drop";
    }
    if (work.folderId) {
      // A folder that couldn't take them leaves the designs in Projects: still saved.
      for (const d of designs) await deps.moveToFolder(work.uid, d.id, work.folderId).catch(() => {});
    }
    await deps.record({ state: "done", name, designs: designs.map((d) => d.id) });
    return "done";
  } catch (error) {
    const { code, status } = codeOf(error);
    if (passing(code, status)) {
      console.log("canva_save_later", code);
      return status === 429 ? { retryIn: SAVE_RATE_WAIT_S } : "retry";
    }
    console.error("canva_save_failed", code);
    await deps.record({ state: "failed", ...(name ? { name } : {}), error: code });
    return "drop";
  }
}
