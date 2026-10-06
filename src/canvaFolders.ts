/**
 * Canva folders on the Files page (2026-10-06, per Martin: "folder is for
 * finder"). Students browse their Canva Projects folder by folder, make a
 * folder, rename one and move a design into one. Nothing is deleted: Canva
 * moves a deleted folder's contents to the Trash, so that stays in Canva.
 *
 * A Hono sub-app that index.ts mounts with
 * `app.route("/canva", canvaFolderRoutes(deps))`, like canvaExport.ts, with
 * the same deps (requireSession, canvaGuard, fromOurApp, storeFor).
 *
 *   GET  /canva/folders/:id/items     a folder's folders and designs ("root" is the top)
 *   POST /canva/folders               { name, parentId }  a new folder
 *   POST /canva/folders/:id/rename    { name }
 *   POST /canva/folders/move          { itemId, toFolderId }
 *
 * Needs the scopes folder:read and folder:write. Asking Canva for a scope the
 * integration doesn't have breaks Connect for everyone, so they're only asked
 * for once CANVA_FOLDERS_ENABLED is "1" (see canvaScopes in canva.ts); until
 * then, and for a connection made before then, every route here answers 409
 * canva_reconnect_needed and the Files page lists designs without folders.
 *
 * Canva Connect: GET /v1/folders/{id}/items (folder:read, 100/min per user),
 * POST /v1/folders and PATCH /v1/folders/{id} (folder:write, 20/min),
 * POST /v1/folders/move (folder:write, 100/min, 204).
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  CANVA_API,
  CanvaError,
  canvaFetch,
  canvaFoldersEnabled,
  FOLDER_READ_SCOPE,
  FOLDER_WRITE_SCOPE,
  statusForCode,
} from "./canva.ts";
import type { SessionData } from "./session.ts";

export interface CanvaFolderStore {
  status(uid: string): Promise<{ connected: boolean; name: string }>;
  accessTokenWithScope(uid: string, scope: string): Promise<string>;
}

export interface CanvaFolderDeps {
  requireSession: MiddlewareHandler<any>;
  canvaGuard: (c: Context<any>) => Response | null;
  fromOurApp: (c: Context<any>) => Response | null;
  storeFor: (c: Context<any>, uid: string) => CanvaFolderStore;
}

type FolderEnv = {
  Bindings: { CANVA_FOLDERS_ENABLED?: string };
  Variables: { session: SessionData };
};
type C = Context<FolderEnv>;

/** Canva folder ids, and the two named ones: "root" (Projects) and "uploads". */
export const FOLDER_ID_RE = /^[A-Za-z0-9_-]{1,50}$/;
/** Designs and folders: the ids moved. */
export const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,50}$/;
const CONTINUATION_RE = /^[A-Za-z0-9_\-=.~+/:]{1,1024}$/;

/** A folder name as Canva takes it: 1 to 255 characters, no line breaks or control characters. */
export function cleanFolderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 255 ? name : null;
}

export interface FolderItem {
  type: "folder" | "design";
  id: string;
  /** A folder's name or a design's title. */
  name: string;
  /** Epoch ms. */
  updatedAt: number;
  /** Expires after about 15 minutes: never stored. */
  thumbnailUrl: string;
}

const ms = (v: unknown) => {
  const n = Number(v ?? 0);
  return n > 1e12 ? n : n * 1000;
};

/** Canva's folder items, kept to what the page shows. Images and brand templates are skipped. */
export function adaptFolderItems(json: any): { items: FolderItem[]; continuation?: string } {
  const items: FolderItem[] = [];
  for (const it of Array.isArray(json?.items) ? json.items : []) {
    if (it?.type === "folder" && it.folder && FOLDER_ID_RE.test(String(it.folder.id ?? ""))) {
      items.push({ type: "folder", id: String(it.folder.id), name: String(it.folder.name ?? "").slice(0, 255) || "Untitled folder", updatedAt: ms(it.folder.updated_at), thumbnailUrl: String(it.folder.thumbnail?.url ?? "") });
    } else if (it?.type === "design" && it.design && ITEM_ID_RE.test(String(it.design.id ?? ""))) {
      items.push({ type: "design", id: String(it.design.id), name: String(it.design.title ?? "").slice(0, 255), updatedAt: ms(it.design.updated_at), thumbnailUrl: String(it.design.thumbnail?.url ?? "") });
    }
  }
  const continuation = typeof json?.continuation === "string" && CONTINUATION_RE.test(json.continuation) ? json.continuation : undefined;
  return { items, continuation };
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** A failed folder call, as an error code the app knows. */
export function folderFailure(res: Response, json: any): CanvaError {
  const code = String(json?.code ?? "");
  if (code === "too_many_requests" || code.endsWith("_throttled") || res.status === 429) return new CanvaError("canva_rate_limited", 429);
  if (code === "item_in_multiple_folders") return new CanvaError("canva_item_in_multiple_folders", 409);
  if (code === "quota_exceeded") return new CanvaError("canva_folder_full", 409);
  if (code === "folder_not_found" || code === "not_found" || res.status === 404) return new CanvaError("canva_folder_gone", 404);
  if (res.status === 401) return new CanvaError("canva_reconnect_needed", 409);
  // 403: no folder scope on this token, a folder that isn't theirs, or Canva's own folders (Uploads can't move).
  if (res.status === 403) return new CanvaError("canva_folder_not_allowed", 403);
  if (res.status === 400) return new CanvaError("bad_request", 400);
  return new CanvaError("canva_folder_failed", 502);
}

const auth = (token: string, json = false): HeadersInit =>
  json ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { Authorization: `Bearer ${token}` };

export async function listFolderItems(token: string, folderId: string, continuation?: string) {
  const q = new URLSearchParams({ item_types: "design,folder", sort_by: "modified_descending", limit: "100" });
  if (continuation) q.set("continuation", continuation);
  const res = await canvaFetch(`${CANVA_API}/folders/${encodeURIComponent(folderId)}/items?${q}`, { headers: auth(token) });
  const json = await readJson(res);
  if (!res.ok) throw folderFailure(res, json);
  return adaptFolderItems(json);
}

export async function createFolder(token: string, name: string, parentId: string): Promise<FolderItem> {
  const res = await canvaFetch(`${CANVA_API}/folders`, { method: "POST", headers: auth(token, true), body: JSON.stringify({ name, parent_folder_id: parentId }) });
  const json = await readJson(res);
  if (!res.ok) throw folderFailure(res, json);
  const f = json?.folder ?? {};
  return { type: "folder", id: String(f.id ?? ""), name: String(f.name ?? name), updatedAt: ms(f.updated_at) || Date.now(), thumbnailUrl: "" };
}

export async function renameFolder(token: string, folderId: string, name: string): Promise<{ id: string; name: string }> {
  const res = await canvaFetch(`${CANVA_API}/folders/${encodeURIComponent(folderId)}`, { method: "PATCH", headers: auth(token, true), body: JSON.stringify({ name }) });
  const json = await readJson(res);
  if (!res.ok) throw folderFailure(res, json);
  return { id: folderId, name: String(json?.folder?.name ?? name) };
}

export async function moveItem(token: string, itemId: string, toFolderId: string): Promise<void> {
  const res = await canvaFetch(`${CANVA_API}/folders/move`, { method: "POST", headers: auth(token, true), body: JSON.stringify({ to_folder_id: toFolderId, item_id: itemId }) });
  if (!res.ok) throw folderFailure(res, await readJson(res));
  await res.body?.cancel().catch(() => {});
}

/* ── routes ────────────────────────────────────────────────────────── */

function failure(c: C, error: unknown, fallback: string) {
  if (error instanceof CanvaError) return c.json({ error: error.message }, error.status as any);
  // From the Durable Object over RPC the class is gone but the code survives in the message.
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = message.match(/\bcanva_[a-z_]+/)?.[0];
  if (code) return c.json({ error: code }, (code === "canva_reconnect_needed" ? 409 : statusForCode(code)) as any);
  console.error(fallback, error);
  return c.json({ error: fallback }, 502);
}

async function jsonBody(c: C): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export function canvaFolderRoutes(deps: CanvaFolderDeps) {
  const app = new Hono<FolderEnv>();

  const begin = (c: C, write: boolean) => {
    c.header("Cache-Control", "private, no-store");
    const blocked = deps.canvaGuard(c) ?? (write ? deps.fromOurApp(c) : null);
    if (blocked) return blocked;
    if (!canvaFoldersEnabled(c.env)) return c.json({ error: "canva_reconnect_needed" }, 409);
    return null;
  };

  /** A folder's folders and designs, newest first, 100 a page. */
  app.get("/folders/:id/items", deps.requireSession, async (c) => {
    const blocked = begin(c, false);
    if (blocked) return blocked;
    const folderId = c.req.param("id");
    const continuation = c.req.query("continuation");
    if (!FOLDER_ID_RE.test(folderId) || (continuation !== undefined && !CONTINUATION_RE.test(continuation))) return c.json({ error: "bad_request" }, 400);
    const session = c.get("session");
    try {
      const store = deps.storeFor(c, session.uid);
      const { connected } = await store.status(session.uid);
      if (!connected) return c.json({ connected: false, items: [] });
      const token = await store.accessTokenWithScope(session.uid, FOLDER_READ_SCOPE);
      const page = await listFolderItems(token, folderId, continuation);
      return c.json({ connected: true, ...page });
    } catch (error) {
      return failure(c, error, "canva_folder_failed");
    }
  });

  /** A new folder inside `parentId` ("root" for the top of Projects). */
  app.post("/folders", deps.requireSession, async (c) => {
    const blocked = begin(c, true);
    if (blocked) return blocked;
    const body = await jsonBody(c);
    const name = cleanFolderName(body?.name);
    const parentId = String(body?.parentId ?? "");
    if (!name || !FOLDER_ID_RE.test(parentId) || parentId === "uploads") return c.json({ error: "bad_request" }, 400);
    const session = c.get("session");
    try {
      const token = await deps.storeFor(c, session.uid).accessTokenWithScope(session.uid, FOLDER_WRITE_SCOPE);
      return c.json({ folder: await createFolder(token, name, parentId) });
    } catch (error) {
      return failure(c, error, "canva_folder_failed");
    }
  });

  /** Renames one of the student's folders. Canva's own folders ("root", "uploads") can't be renamed. */
  app.post("/folders/:id/rename", deps.requireSession, async (c) => {
    const blocked = begin(c, true);
    if (blocked) return blocked;
    const folderId = c.req.param("id");
    const body = await jsonBody(c);
    const name = cleanFolderName(body?.name);
    if (!name || !FOLDER_ID_RE.test(folderId) || folderId === "root" || folderId === "uploads") return c.json({ error: "bad_request" }, 400);
    const session = c.get("session");
    try {
      const token = await deps.storeFor(c, session.uid).accessTokenWithScope(session.uid, FOLDER_WRITE_SCOPE);
      return c.json({ folder: await renameFolder(token, folderId, name) });
    } catch (error) {
      return failure(c, error, "canva_folder_failed");
    }
  });

  /** Moves a design (or folder) into another folder ("root" is the top of Projects). */
  app.post("/folders/move", deps.requireSession, async (c) => {
    const blocked = begin(c, true);
    if (blocked) return blocked;
    const body = await jsonBody(c);
    const itemId = String(body?.itemId ?? "");
    const toFolderId = String(body?.toFolderId ?? "");
    if (!ITEM_ID_RE.test(itemId) || !FOLDER_ID_RE.test(toFolderId) || toFolderId === "uploads" || itemId === toFolderId || itemId === "root" || itemId === "uploads") {
      return c.json({ error: "bad_request" }, 400);
    }
    const session = c.get("session");
    try {
      const token = await deps.storeFor(c, session.uid).accessTokenWithScope(session.uid, FOLDER_WRITE_SCOPE);
      await moveItem(token, itemId, toFolderId);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error, "canva_folder_failed");
    }
  });

  return app;
}
