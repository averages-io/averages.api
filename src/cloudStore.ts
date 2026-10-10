/**
 * One Durable Object per student for their Google Drive and OneDrive
 * connections (2026-10-08).
 *
 * Opened in the "us" jurisdiction (see index.ts's cloudStore()), like Sync and
 * Canva, so the stored tokens stay in the United States. Separate from
 * SyncStore (turning Sync off deletes everything there) and from CanvaStore
 * (Disconnect in Canva wipes that object), so neither takes these with it.
 *
 * All of the logic lives in cloudConnect.ts's CloudAccount, which the tests
 * drive with an in-memory store; this class only hands it the real storage
 * and exposes its methods over RPC. One object serves one student's requests
 * one at a time, so a token refresh can't race itself.
 */

import { DurableObject } from "cloudflare:workers";
import {
  CloudAccount,
  type AppStatus,
  type CloudApp,
  type CloudConnectEnv,
  type CloudToken,
  type ConnectOptions,
  type FinishResult,
  type TokenOptions,
} from "./cloudConnect.ts";

export class CloudStore extends DurableObject<CloudConnectEnv> {
  account: CloudAccount;

  constructor(ctx: DurableObjectState, env: CloudConnectEnv) {
    super(ctx, env);
    this.account = new CloudAccount(ctx.storage, env);
  }

  beginConnect(uid: string, app: CloudApp, opts: ConnectOptions): Promise<string> {
    return this.account.beginConnect(uid, app, opts);
  }
  cancelConnect(app: CloudApp, state: string): Promise<string> {
    return this.account.cancelConnect(app, state);
  }
  finishConnect(uid: string, app: CloudApp, state: string, code: string): Promise<FinishResult> {
    return this.account.finishConnect(uid, app, state, code);
  }
  status(uid: string): Promise<Record<CloudApp, AppStatus>> {
    return this.account.status(uid);
  }
  accessToken(uid: string, app: CloudApp, opts: TokenOptions = {}): Promise<CloudToken> {
    return this.account.accessToken(uid, app, opts);
  }
  disconnect(uid: string, app: CloudApp): Promise<void> {
    return this.account.disconnect(uid, app);
  }
}
