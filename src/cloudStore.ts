// One Durable Object per student for their Google Drive and OneDrive connections.

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
  disconnect(uid: string, app: CloudApp, opts: { revokeShared?: boolean } = {}): Promise<void> {
    return this.account.disconnect(uid, app, opts);
  }
}
