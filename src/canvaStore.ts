/**
 * One Durable Object per student for their Canva connection (2026-10-05).
 *
 * Opened in the "us" jurisdiction (see index.ts's canvaStore()), the same as
 * Sync, so Canva tokens and drafts stay in the United States. Kept separate
 * from SyncStore on purpose: turning Sync off deletes everything in that
 * student's SyncStore, and it must not take their Canva connection with it.
 *
 * All of the logic lives in canva.ts's CanvaAccount, which the tests drive
 * with an in-memory store; this class only hands it the real storage and
 * exposes its methods over RPC. Because one object serves one student's
 * requests one at a time, the token refresh inside accessToken() can't race
 * itself.
 */

import { DurableObject } from "cloudflare:workers";
import { CanvaAccount, type CanvaConfig, type Draft, type ReturnContext } from "./canva.ts";

export class CanvaStore extends DurableObject<CanvaConfig> {
  account: CanvaAccount;

  constructor(ctx: DurableObjectState, env: CanvaConfig) {
    super(ctx, env);
    this.account = new CanvaAccount(ctx.storage, env);
  }

  beginConnect(returnTo: string): Promise<string> {
    return this.account.beginConnect(returnTo);
  }
  finishConnect(uid: string, state: string, code: string): Promise<string> {
    return this.account.finishConnect(uid, state, code);
  }
  status(uid: string): Promise<{ connected: boolean; name: string }> {
    return this.account.status(uid);
  }
  disconnect(): Promise<void> {
    return this.account.disconnect();
  }
  accessToken(uid: string): Promise<string> {
    return this.account.accessToken(uid);
  }
  /** For exporting designs (2026-10-06): refuses a connection made without that scope. */
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
}
