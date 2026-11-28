// One Durable Object per student for their Canva connection.

import { DurableObject } from "cloudflare:workers";
import { CanvaAccount, type CanvaConfig, type Draft, type ReturnContext } from "./canva.ts";
import { SaveJobs, type SaveFile, type SaveItem, type SaveStatus } from "./canvaSave.ts";

export class CanvaStore extends DurableObject<CanvaConfig> {
  account: CanvaAccount;

  constructor(ctx: DurableObjectState, env: CanvaConfig) {
    super(ctx, env);
    this.account = new CanvaAccount(ctx.storage, env);
  }

  beginConnect(
    returnTo: string,
    switches?: { CANVA_EXPORT_ENABLED?: string; CANVA_FOLDERS_ENABLED?: string; CANVA_PERMISSION_PROBE?: string },
    probe?: boolean,
  ): Promise<string> {
    if (switches) this.account.env = { ...this.account.env, ...switches };
    return this.account.beginConnect(returnTo, { probe });
  }
  finishConnect(uid: string, state: string, code: string): Promise<string> {
    return this.account.finishConnect(uid, state, code);
  }
  connectReturn(state: string, consume?: boolean): Promise<string> {
    return this.account.connectReturn(state, consume);
  }
  status(uid: string): Promise<{ connected: boolean; name: string }> {
    return this.account.status(uid);
  }
  disconnect(uid?: string): Promise<void> {
    return this.account.disconnect(uid);
  }
  accessToken(uid: string): Promise<string> {
    return this.account.accessToken(uid);
  }
  accessTokenWithScope(uid: string, scope: string): Promise<string> {
    return this.account.accessTokenWithScope(uid, scope);
  }
  grantedScopes(uid: string): Promise<string[] | null> {
    return this.account.grantedScopes(uid);
  }
  saveReturn(ctx: ReturnContext): Promise<string> {
    return this.account.saveReturn(ctx);
  }
  takeReturn(key: string): Promise<ReturnContext | null> {
    return this.account.takeReturn(key);
  }
  rememberImport(section: string, assignment: string, fileId: string, designId: string): Promise<void> {
    return this.account.rememberImport(section, assignment, fileId, designId);
  }
  importedDesign(section: string, assignment: string, fileId: string): Promise<string | null> {
    return this.account.importedDesign(section, assignment, fileId);
  }
  listDrafts(section: string, assignment: string): Promise<Draft[]> {
    return this.account.listDrafts(section, assignment);
  }
  findDraftForFile(section: string, assignment: string, fileId: string): Promise<Draft | null> {
    return this.account.findDraftForFile(section, assignment, fileId);
  }
  addDraft(draft: Draft): Promise<void> {
    return this.account.addDraft(draft);
  }
  touchDraft(designId: string, title?: string): Promise<void> {
    return this.account.touchDraft(designId, title);
  }
  removeDraft(designId: string): Promise<boolean> {
    return this.account.removeDraft(designId);
  }

  private jobs(): SaveJobs {
    return new SaveJobs(this.ctx.storage);
  }
  /** The new job's status, or null when two are already running. */
  async saveCreate(input: { id: string; name: string; folderId: string | null; files: SaveFile[]; sealed: string; uid: string }): Promise<SaveStatus | null> {
    const job = await this.jobs().create(input);
    return job ? this.jobs().status(job.id) : null;
  }
  saveStatus(id: string): Promise<SaveStatus | null> {
    return this.jobs().status(id);
  }
  saveTake(id: string, i: number): Promise<{ item: SaveItem; sealed: string; uid: string; folderId: string | null } | null> {
    return this.jobs().take(id, i);
  }
  saveRecord(id: string, i: number, result: { state: "done" | "failed"; name?: string; designs?: string[]; error?: string }): Promise<void> {
    return this.jobs().record(id, i, result);
  }
  saveStop(id: string): Promise<SaveStatus | null> {
    return this.jobs().stop(id);
  }
}
