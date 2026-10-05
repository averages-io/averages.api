/**
 * Tests for the Canva integration (src/canva.ts) and the assignment-attachment
 * helpers it depends on (adapt.ts / schoology.ts).
 *
 * Run: node --experimental-strip-types test/canva.test.ts
 *
 * No Durable Object or network here: CanvaAccount runs against a Map-backed
 * stand-in for Durable Object storage, and `fetch` is replaced with a fake
 * that plays Canva and Schoology.
 */

import {
  CanvaAccount,
  clearJwksCache,
  codeChallenge,
  editUrlWithCorrelation,
  findDesignByTitle,
  importFile,
  importTitle,
  mimeForName,
  openTokens,
  safeAppPath,
  sealTokens,
  statusForCode,
  verifyReturnJwt,
  withQuery,
  b64url,
  type CanvaStorage,
} from "../src/canva.ts";
import { adaptAssignmentDetail, findAttachment } from "../src/adapt.ts";
import { downloadAttachment, isSchoologyApiUrl } from "../src/schoology.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`);
  }
}
const checkTrue = (name: string, v: boolean) => check(name, v, true);
async function rejects(name: string, p: Promise<unknown>, code: string) {
  try {
    await p;
    check(name, "resolved", code);
  } catch (e) {
    check(name, (e as Error).message, code);
  }
}

class MemoryStorage implements CanvaStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler = () => new Response("no handler", { status: 500 });
const calls: { url: string; init: RequestInit }[] = [];
globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input.url;
  calls.push({ url, init });
  return handler(url, init);
}) as typeof fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ENV = {
  CANVA_CLIENT_ID: "OC-test",
  CANVA_CLIENT_SECRET: "shh",
  CANVA_REDIRECT_URI: "https://api.averages.io/canva/callback",
  SESSION_SECRET: "a-long-random-session-secret-for-tests",
};
const UID = "4242";

/* ── helpers ── */
console.log("helpers");
check("safeAppPath keeps an app path with a query", safeAppPath("/assignment?course=1&title=Lab", "/x"), "/assignment?course=1&title=Lab");
check("safeAppPath refuses //host", safeAppPath("//evil.com", "/x"), "/x");
check("safeAppPath refuses /\\host", safeAppPath("/\\evil.com", "/x"), "/x");
check("safeAppPath refuses a scheme", safeAppPath("https://evil.com", "/x"), "/x");
check("safeAppPath refuses control characters", safeAppPath("/a\u0000b", "/x"), "/x");
check("safeAppPath refuses spaces and non-ASCII", [safeAppPath("/a b", "/x"), safeAppPath("/é", "/x")], ["/x", "/x"]);
check("withQuery adds ? when there's no query", withQuery("/settings", "canva", "connected"), "/settings?canva=connected");
check("withQuery adds & after an existing query", withQuery("/assignment?course=1", "canva", "saved"), "/assignment?course=1&canva=saved");
check("withQuery keeps a #fragment last", withQuery("/a?x=1#top", "k", "v"), "/a?x=1&k=v#top");
check("importTitle drops the extension", importTitle("Lab Report #4.pdf"), "Lab Report #4");
check("importTitle caps at 50 characters before encoding", importTitle("x".repeat(80) + ".docx").length, 50);
check("importTitle counts an emoji as one character", Array.from(importTitle("é".repeat(60))).length, 50);
check("mimeForName knows docx", mimeForName("Essay.DOCX"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
check("mimeForName leaves unknown types to Canva", mimeForName("thing.xyz"), undefined);
check(
  "PKCE matches the RFC 7636 test vector",
  await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
);
check("edit URL gets correlation_state", editUrlWithCorrelation("https://www.canva.com/design/D1/edit", "k1"), "https://www.canva.com/design/D1/edit?correlation_state=k1");
check("edit URL with a query gets &", editUrlWithCorrelation("https://x/edit?a=1", "k1"), "https://x/edit?a=1&correlation_state=k1");
check("not connected maps to 409", statusForCode("canva_not_connected"), 409);
check("a bad JWT maps to 400", statusForCode("canva_jwt_bad_signature"), 400);

/* ── token sealing ── */
console.log("token sealing");
{
  const t = { access_token: "AT", refresh_token: "RT", expires_at: 123 };
  const sealed = await sealTokens(t, UID, ENV.SESSION_SECRET);
  checkTrue("sealed tokens don't contain the token text", !sealed.includes("AT") || !sealed.includes("RT"));
  check("opens for the same student", await openTokens(sealed, UID, ENV.SESSION_SECRET), t);
  check("won't open for a different student", await openTokens(sealed, "9999", ENV.SESSION_SECRET), null);
  check("won't open with a different secret", await openTokens(sealed, UID, "other-secret"), null);
  check("garbage reads as nothing", await openTokens("nope", UID, ENV.SESSION_SECRET), null);
}

/* ── connect ── */
console.log("connect");
{
  const store = new MemoryStorage();
  const acct = new CanvaAccount(store, ENV);
  const url = new URL(await acct.beginConnect("/settings"));
  check("authorize goes to Canva", url.origin + url.pathname, "https://www.canva.com/api/oauth/authorize");
  check("asks for the three scopes", url.searchParams.get("scope"), "design:content:write design:meta:read profile:read");
  checkTrue("scope separator is %20, not +", url.search.includes("design%3Acontent%3Awrite%20design"));
  check("uses S256", url.searchParams.get("code_challenge_method"), "S256");
  check("sends our redirect URI", url.searchParams.get("redirect_uri"), ENV.CANVA_REDIRECT_URI);
  const state = url.searchParams.get("state")!;
  checkTrue("the verifier is not in the URL", !url.search.includes((Object.values((await store.get<any>("connect")) ?? {})[0] as any).verifier));

  await rejects("an unknown state is refused", acct.finishConnect(UID, "forged", "code"), "canva_state_not_found");

  let tokenBody = "";
  let tokenAuth = "";
  handler = (u, init) => {
    if (u.endsWith("/oauth/token")) {
      tokenBody = String(init.body);
      tokenAuth = String((init.headers as any).Authorization);
      return json({ access_token: "AT1", refresh_token: "RT1", expires_in: 14400, scope: "x" });
    }
    if (u.endsWith("/users/me/profile")) return json({ profile: { display_name: "Martin V" } });
    return json({}, 404);
  };
  const back = await acct.finishConnect(UID, state, "the-code");
  check("finishing returns to where they started", back, "/settings");
  checkTrue("code exchange sends the PKCE verifier", tokenBody.includes("code_verifier="));
  check("code exchange uses Basic client auth", tokenAuth, "Basic " + btoa("OC-test:shh"));
  check("status says connected, with the account name", await acct.status(UID), { connected: true, name: "Martin V" });
  checkTrue("tokens are stored sealed, not as JSON", typeof (await store.get("tokens")) === "string" && !String(await store.get("tokens")).includes("AT1"));
  await rejects("a state only works once", acct.finishConnect(UID, state, "the-code"), "canva_state_not_found");

  // Inherited property names must never count as a stored state (security review 2026-10-05).
  let tokenCalls = 0;
  handler = (u) => { if (u.endsWith("/oauth/token")) tokenCalls++; return json({ access_token: "X", refresh_token: "Y" }); };
  const fresh = new CanvaAccount(new MemoryStorage(), ENV);
  await fresh.beginConnect("/settings");
  for (const forged of ["constructor", "__proto__", "toString", "hasOwnProperty", "A".repeat(32)]) {
    await rejects(`a forged state "${forged.slice(0, 12)}" is refused`, fresh.finishConnect(UID, forged, "code"), "canva_state_not_found");
  }
  check("...without ever calling Canva", tokenCalls, 0);
  check("...and nothing gets connected", await fresh.status(UID), { connected: false, name: "" });

  const unconfigured = new CanvaAccount(new MemoryStorage(), { ...ENV, CANVA_CLIENT_SECRET: "" });
  await rejects("connecting without app credentials says so", unconfigured.beginConnect("/settings"), "canva_not_configured");
}

/* ── tokens and refresh ── */
console.log("tokens and refresh");
{
  const store = new MemoryStorage();
  const acct = new CanvaAccount(store, ENV);
  await rejects("no tokens means not connected", acct.accessToken(UID), "canva_not_connected");

  await acct.saveTokens(UID, { access_token: "FRESH", refresh_token: "R0", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  calls.length = 0;
  check("a fresh token is used as is", await acct.accessToken(UID), "FRESH");
  check("...with no call to Canva", calls.length, 0);

  await acct.saveTokens(UID, { access_token: "OLD", refresh_token: "R1", expires_at: Math.floor(Date.now() / 1000) + 60 });
  let refreshes = 0;
  handler = async (u, init) => {
    if (u.endsWith("/oauth/token")) {
      refreshes++;
      await new Promise((r) => setTimeout(r, 20));
      checkTrue("refresh sends the current refresh token", String(init.body).includes("refresh_token=R1"));
      return json({ access_token: "NEW", refresh_token: "R2", expires_in: 14400 });
    }
    return json({}, 404);
  };
  const got = await Promise.all([acct.accessToken(UID), acct.accessToken(UID), acct.accessToken(UID)]);
  check("three requests at once all get the new token", got, ["NEW", "NEW", "NEW"]);
  check("...but the refresh token is spent only once", refreshes, 1);
  check("the rotated refresh token is saved", (await acct.loadTokens(UID))?.refresh_token, "R2");

  await acct.saveTokens(UID, { access_token: "OLD", refresh_token: "DEAD", expires_at: 0 });
  await store.put("profile", { name: "X" });
  handler = (u) => (u.endsWith("/oauth/token") ? json({ code: "invalid_grant" }, 400) : json({}, 404));
  await rejects("a refused refresh token asks to reconnect", acct.accessToken(UID), "canva_reconnect_needed");
  check("...and the dead connection is dropped", await acct.status(UID), { connected: false, name: "" });

  await acct.saveTokens(UID, { access_token: "OLD", refresh_token: "STILL_GOOD", expires_at: 0 });
  handler = (u) => (u.endsWith("/oauth/token") ? json({ error: "invalid_client" }, 401) : json({}, 404));
  await rejects("a wrong client secret is our problem, not the student's", acct.accessToken(UID), "canva_token_failed");
  check("...so their refresh token is kept", (await acct.loadTokens(UID))?.refresh_token, "STILL_GOOD");

  // Disconnect pressed while a refresh is on its way to Canva.
  let release: () => void = () => {};
  handler = async (u) => {
    if (!u.endsWith("/oauth/token")) return json({}, 404);
    await new Promise<void>((r) => { release = r; });
    return json({ access_token: "LATE", refresh_token: "LATE_RT", expires_in: 14400 });
  };
  const pending = acct.accessToken(UID).catch((e) => (e as Error).message);
  await new Promise((r) => setTimeout(r, 10));
  await acct.disconnect();
  release();
  check("a refresh that lands after Disconnect fails", await pending, "canva_not_connected");
  check("...and doesn't reconnect them", await acct.status(UID), { connected: false, name: "" });
}

/* ── Return contexts and drafts ── */
console.log("returns and drafts");
{
  const store = new MemoryStorage();
  const acct = new CanvaAccount(store, ENV);
  const key = await acct.saveReturn({ designId: "D1", returnTo: "/assignment?course=1&title=Lab" });
  checkTrue("Return keys fit Canva's 50 character limit", key.length <= 50 && /^[A-Za-z0-9_-]+$/.test(key));
  check("a Return key resolves once", (await acct.takeReturn(key))?.returnTo, "/assignment?course=1&title=Lab");
  check("...and only once", await acct.takeReturn(key), null);
  const bad = await acct.saveReturn({ designId: "D2", returnTo: "//evil.com" });
  check("an unsafe return path is replaced", (await acct.takeReturn(bad))?.returnTo, "/");
  await store.put("returns", { old: { designId: "D3", returnTo: "/x", exp: 1 } });
  check("expired Return keys are gone", await acct.takeReturn("old"), null);

  const base = { title: "T", sourceName: "Lab.pdf", fileId: "9", createdAt: 1, updatedAt: 1 };
  await acct.addDraft({ ...base, designId: "A", section: "1", assignment: "10" });
  await acct.addDraft({ ...base, designId: "B", section: "1", assignment: "10", fileId: "8", updatedAt: 5 });
  await acct.addDraft({ ...base, designId: "C", section: "1", assignment: "11" });
  check("drafts are per assignment, newest first", (await acct.listDrafts("1", "10")).map((d) => d.designId), ["B", "A"]);
  check("finds the draft made from a file", (await acct.findDraftForFile("1", "10", "9"))?.designId, "A");
  await acct.touchDraft("A", "Renamed");
  check("touching a draft moves it to the top", (await acct.listDrafts("1", "10"))[0].designId, "A");
  check("...and keeps the new title", (await acct.listDrafts("1", "10"))[0].title, "Renamed");
  check("removing a draft says so", await acct.removeDraft("A"), true);
  check("removing it again says nothing was there", await acct.removeDraft("A"), false);
  await acct.addDraft({ ...base, designId: "C", section: "1", assignment: "11", updatedAt: 9 });
  check("adding the same design again replaces it", (await acct.drafts()).filter((d) => d.designId === "C").length, 1);
  await acct.rememberImport("1", "10", "9", "A");
  await acct.removeDraft("A");
  check("the design a file became is remembered after its draft is deleted", await acct.importedDesign("1", "10", "9"), "A");
  check("an unknown file has no design", await acct.importedDesign("1", "10", "8"), null);
  check("an inherited name isn't a file", await acct.importedDesign("constructor", "", ""), null);
  await acct.disconnect();
  check("disconnect forgets everything", store.data.size, 0);
}

/* ── importing a file ── */
console.log("import");
{
  let meta: any = null;
  let polls = 0;
  handler = (u, init) => {
    if (u.endsWith("/imports") && init.method === "POST") {
      meta = JSON.parse(String((init.headers as any)["Import-Metadata"]));
      return json({ job: { id: "J1", status: "in_progress" } });
    }
    if (u.endsWith("/imports/J1")) {
      polls++;
      if (polls < 2) return json({ job: { id: "J1", status: "in_progress" } });
      return json({
        job: {
          id: "J1",
          status: "success",
          result: { designs: [{ id: "DES1", title: "Lab Report", urls: { edit_url: "https://canva/e", view_url: "https://canva/v" }, updated_at: 1700000000 }] },
        },
      });
    }
    return json({}, 404);
  };
  const designs = await importFile("TOKEN", "Lab Report #4.pdf", new ArrayBuffer(4), "application/pdf", async () => {});
  check("import returns the design", designs.map((d) => [d.id, d.editUrl]), [["DES1", "https://canva/e"]]);
  check("Canva's seconds become milliseconds", designs[0].updatedAt, 1700000000000);
  check("the title is standard base64 of the trimmed name", atob(meta.title_base64), "Lab Report #4");
  check("the mime type is passed along", meta.mime_type, "application/pdf");

  handler = (u, init) =>
    u.endsWith("/imports") && init.method === "POST" ? json({ code: "duplicate_import", message: "dup" }, 400) : json({}, 404);
  await rejects("Canva refusing a repeat import is its own code", importFile("T", "a.pdf", new ArrayBuffer(1), undefined, async () => {}), "canva_duplicate_import");

  handler = (u, init) => {
    if (u.endsWith("/imports") && init.method === "POST") return json({ job: { id: "J2" } });
    return json({ job: { id: "J2", status: "failed", error: { code: "invalid_file" } } });
  };
  await rejects("a file Canva can't read says so", importFile("T", "a.pdf", new ArrayBuffer(1), undefined, async () => {}), "canva_invalid_file");

  handler = () => json({ message: "nope" }, 401);
  await rejects("an expired access token asks to reconnect", importFile("T", "a.pdf", new ArrayBuffer(1), undefined, async () => {}), "canva_reconnect_needed");

  let asked = "";
  handler = (u) => {
    asked = u;
    return json({ items: [{ id: "OTHER", title: "Lab Report #4 copy", urls: { edit_url: "https://e/1" } }, { id: "MINE", title: "Lab Report #4", urls: { edit_url: "https://e/2" } }] });
  };
  check("after a repeat import, the earlier design is found by its exact title", (await findDesignByTitle("T", "Lab Report #4"))?.id, "MINE");
  checkTrue("...searching only the student's own designs", asked.includes("ownership=owned") && asked.includes("query=Lab+Report"));
}

/* ── the Return JWT ── */
console.log("return JWT");
{
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as any;
  handler = (u) => (u.endsWith("/connect/keys") ? json({ keys: [{ kid: "k1", kty: "OKP", crv: "Ed25519", x: pub.x }] }) : json({}, 404));
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  async function jwt(claims: Record<string, unknown>, kid = "k1", key = pair.privateKey) {
    const head = enc({ alg: "EdDSA", kid });
    const body = enc(claims);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  }
  const good = { aud: "OC-test", type: "rti", exp: Math.floor(Date.now() / 1000) + 600, design_id: "DES1", correlation_state: "key1" };
  clearJwksCache();
  check("a good JWT gives the design and our key", await verifyReturnJwt(ENV, await jwt(good)), { designId: "DES1", correlationState: "key1" });
  await rejects("wrong audience is refused", verifyReturnJwt(ENV, await jwt({ ...good, aud: "someone-else" })), "canva_jwt_bad_audience");
  await rejects("wrong type is refused", verifyReturnJwt(ENV, await jwt({ ...good, type: "x" })), "canva_jwt_bad_type");
  await rejects("expired is refused", verifyReturnJwt(ENV, await jwt({ ...good, exp: 5 })), "canva_jwt_expired");
  const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  await rejects("signed by someone else is refused", verifyReturnJwt(ENV, await jwt(good, "k1", other.privateKey)), "canva_jwt_bad_signature");
  const tampered = (await jwt(good)).split(".");
  tampered[1] = enc({ ...good, design_id: "SOMEONE_ELSES" });
  await rejects("a changed payload is refused", verifyReturnJwt(ENV, tampered.join(".")), "canva_jwt_bad_signature");
  await rejects("an unknown key id is refused", verifyReturnJwt(ENV, await jwt(good, "k9")), "canva_jwt_unknown_kid");
  await rejects("junk is refused", verifyReturnJwt(ENV, "not.a.jwt"), "canva_jwt_malformed");
  clearJwksCache();
  handler = (u) => (u.endsWith("/connect/keys") ? json({ keys: [{ kid: "bad", kty: "OKP", crv: "Ed25519", x: "!!not-base64!!" }, { kid: "k1", kty: "OKP", crv: "Ed25519", x: pub.x }] }) : json({}, 404));
  check("one malformed key doesn't stop the good ones", (await verifyReturnJwt(ENV, await jwt(good))).designId, "DES1");
}

/* ── assignment attachments ── */
console.log("attachments");
{
  const raw = {
    id: 55,
    title: "Lab <b>Report</b>",
    description: "<p>Write it up.</p>",
    due: "2026-08-21 23:59:00",
    type: "assignment",
    attachments: {
      files: { file: [{ id: 901, title: "Titration Data Sheet", filename: "titration.pdf", filesize: 2048, download_path: "https://api.schoology.com/v1/attachment/901/source/x.pdf" }] },
      links: { link: { id: 3, title: "Simulator", url: "https://phet.colorado.edu/" } },
    },
  };
  const detail = adaptAssignmentDetail(raw, "12");
  check("files come back with id, name, type and size", detail.files, [{ id: "901", name: "Titration Data Sheet", ext: "pdf", size: 2048 }]);
  checkTrue("no download path reaches the browser", !JSON.stringify(detail).includes("download_path") && !JSON.stringify(detail).includes("attachment/901"));
  check("a single link (not in an array) still counts", detail.links, [{ title: "Simulator", url: "https://phet.colorado.edu/" }]);
  check("title and description are plain text", [detail.title, detail.description], ["Lab Report", "Write it up."]);
  const flat = adaptAssignmentDetail({ attachments: { files: [{ id: 1, filename: "a.docx" }], links: [{ url: "javascript:alert(1)" }] } }, "1");
  check("the flat array shape works too", flat.files.map((f) => f.ext), ["docx"]);
  check("non-http links are dropped", flat.links, []);
  check("findAttachment adds the real extension to a bare title", findAttachment(raw, "901")?.name, "Titration Data Sheet.pdf");
  check("findAttachment only finds that assignment's files", findAttachment(raw, "902"), null);
}

/* ── downloading an attachment ── */
console.log("download");
{
  const creds = { key: "k", secret: "s" };
  check("only api.schoology.com is a Schoology API URL", [isSchoologyApiUrl("https://api.schoology.com/v1/x"), isSchoologyApiUrl("https://evil.com/v1/x"), isSchoologyApiUrl("http://api.schoology.com/x")], [true, false, false]);
  await rejects("a URL off Schoology is never fetched", downloadAttachment("https://evil.com/file", creds, 100), "Attachment is not on api.schoology.com");

  const seen: { url: string; auth: boolean }[] = [];
  handler = (u, init) => {
    seen.push({ url: u, auth: !!(init.headers as any)?.Authorization });
    if (u.startsWith("https://api.schoology.com/")) return new Response(null, { status: 302, headers: { Location: "https://files.example-storage.com/abc?sig=1" } });
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "Content-Type": "application/pdf" } });
  };
  const file = await downloadAttachment("https://api.schoology.com/v1/attachment/901/source/x.pdf", creds, 100);
  check("the file's bytes come back", file.bytes.byteLength, 4);
  check("its type comes back", file.contentType, "application/pdf");
  check("the signature goes to Schoology only, not to the storage it redirects to", seen.map((s) => s.auth), [true, false]);

  handler = () => new Response(new Uint8Array(60), { headers: { "Content-Length": "10" } });
  check("a body bigger than announced (decompressed) still arrives whole", (await downloadAttachment("https://api.schoology.com/v1/attachment/1/source/y.pdf", creds, 100)).bytes.byteLength, 60);
  handler = () => new Response(new Uint8Array(200), { headers: { "Content-Length": "50" } });
  await rejects("...but not past the cap", downloadAttachment("https://api.schoology.com/v1/attachment/1/source/y.pdf", creds, 100), "Attachment is too large");
  handler = () => new Response(new Uint8Array(200));
  await rejects("a file over the cap is refused", downloadAttachment("https://api.schoology.com/v1/attachment/1/source/y.pdf", creds, 100), "Attachment is too large");
  handler = (u) => new Response(null, { status: 302, headers: { Location: "http://insecure.example.com/x" } });
  await rejects("an http redirect is refused", downloadAttachment("https://api.schoology.com/v1/attachment/1/source/y.pdf", creds, 100), "Attachment redirect is not https");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
