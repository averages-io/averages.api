// "Show my photo to classmates": the markers, the signed photo addresses, and the routes end to end through the Worker
// with the review sandbox's account (its classes and classmates; no Schoology) and an in-memory bucket.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/classmatePhotos.test.ts
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { REVIEW_UID, SANDBOX_KEY, SANDBOX_SECRET } from "../src/reviewSandbox.ts";
import { sealSession, SESSION_COOKIE } from "../src/session.ts";
import { addSharedPhotos, deleteAllMedia, mediaKey, peerPhotoOk, peerPhotoUrl, readShare, setShare, shareKey, sharedInSection, shareRecordKey, syncShareSections, type MediaBucket } from "../src/media.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

globalThis.fetch = (async (input: RequestInfo | URL) => { throw new Error(`unexpected call: ${String(input)}`); }) as typeof fetch;

/** An in-memory R2 bucket: strings and bytes, custom metadata, lists of two per page. */
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; type?: string; meta?: Record<string, string>; etag: string }>();
  let n = 0;
  const counts = { list: 0, get: 0, put: 0 };
  const bucket: MediaBucket & { objects: typeof objects; counts: typeof counts } = {
    objects,
    counts,
    async put(key, value, options) {
      counts.put++;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
      const etag = `e${++n}`;
      objects.set(key, { bytes: bytes.slice(), type: options?.httpMetadata?.contentType, meta: options?.customMetadata, etag });
      return { etag };
    },
    async get(key) {
      counts.get++;
      const o = objects.get(key);
      if (!o) return null;
      return { body: new Response(o.bytes).body!, etag: o.etag, httpMetadata: { contentType: o.type }, size: o.bytes.byteLength, text: async () => new TextDecoder().decode(o.bytes) };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { etag: o.etag } : null;
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(options) {
      counts.list++;
      const all = [...objects.keys()].filter((k) => k.startsWith(options?.prefix ?? "")).sort();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = all.slice(start, start + 2);
      const truncated = start + 2 < all.length;
      const withMeta = (options?.include ?? []).includes("customMetadata");
      return { objects: page.map((key) => (withMeta ? { key, customMetadata: objects.get(key)!.meta } : { key })), truncated, cursor: truncated ? String(start + 2) : undefined };
    },
  };
  return bucket;
}

const SECRET = "classmate-photos-test-secret";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

console.log("markers");
{
  const b = fakeBucket();
  check("off to start with", await readShare(b, "500"), null);
  await setShare(b, "500", ["11", "22", "bad/id", "11"]);
  check("on without a photo: the record, no markers", [await readShare(b, "500"), b.objects.has(shareKey("11", "500"))], [["11", "22"], false]);
  await b.put(mediaKey("500", "photo"), PNG);
  await setShare(b, "500", ["11", "22"]);
  check("with a photo: one marker per class, carrying its version", [b.objects.get(shareKey("11", "500"))?.meta, b.objects.get(shareKey("22", "500"))?.meta], [{ v: b.objects.get(mediaKey("500", "photo"))!.etag }, { v: b.objects.get(mediaKey("500", "photo"))!.etag }]);
  await setShare(b, "500", ["22", "33"]);
  check("classes change: the old marker goes, the new one comes", [b.objects.has(shareKey("11", "500")), b.objects.has(shareKey("22", "500")), b.objects.has(shareKey("33", "500"))], [false, true, true]);
  for (const u of ["501", "502", "503"]) { await b.put(mediaKey(u, "photo"), PNG); await setShare(b, u, ["33"]); }
  const m = await sharedInSection(b, "33");
  check("a class's shared photos, over several pages", [...m.keys()].sort(), ["500", "501", "502", "503"]);
  check("a strange class id lists nothing", (await sharedInSection(b, "../u")).size, 0);
  await syncShareSections(b, "500", ["33"]);
  check("syncing the class list moves the markers", [await readShare(b, "500"), b.objects.has(shareKey("22", "500"))], [["33"], false]);
  const puts = b.counts.put;
  await syncShareSections(b, "500", ["33"]);
  check("the same classes: nothing written", b.counts.put, puts);
  await syncShareSections(b, "999", ["33"]);
  check("someone who never turned it on: nothing written", [b.counts.put, await readShare(b, "999")], [puts, null]);
  await setShare(b, "500", null);
  check("off: record and markers gone", [await readShare(b, "500"), b.objects.has(shareKey("33", "500")), b.objects.has(mediaKey("500", "photo"))], [null, false, true]);
  await deleteAllMedia(b, "501");
  check("Delete account / Sync off: the markers in classmates' lists go too", [b.objects.has(shareKey("33", "501")), b.objects.has(shareRecordKey("501")), b.objects.has(mediaKey("501", "photo"))], [false, false, false]);
}

console.log("\nphoto addresses");
{
  const now = 1_800_000_000;
  const u = new URL(await peerPhotoUrl("https://api.averages.io", SECRET, "viewer", "owner", "e7", now));
  const v = u.searchParams.get("v")!, e = Number(u.searchParams.get("e")), s = u.searchParams.get("s")!;
  check("the address names the owner and the version", [u.pathname, v], ["/media/peer/owner", "e7"]);
  check("same address all day (browsers reuse it)", await peerPhotoUrl("https://api.averages.io", SECRET, "viewer", "owner", "e7", now + 3600), u.href);
  check("good for the viewer it was made for", await peerPhotoOk(SECRET, "viewer", "owner", v, e, s, now), true);
  check("not for anyone else", await peerPhotoOk(SECRET, "someone", "owner", v, e, s, now), false);
  check("not for another photo or version", [await peerPhotoOk(SECRET, "viewer", "other", v, e, s, now), await peerPhotoOk(SECRET, "viewer", "owner", "e8", e, s, now)], [false, false]);
  check("not after it runs out", await peerPhotoOk(SECRET, "viewer", "owner", v, e, s, e + 1), false);
  check("not with a stretched end date", await peerPhotoOk(SECRET, "viewer", "owner", v, e + 30 * 86400, s, now), false);
  check("not with another secret", await peerPhotoOk("other-secret", "viewer", "owner", v, e, s, now), false);
}

console.log("\nclassmates lists");
{
  const b = fakeBucket();
  await b.put(mediaKey("700", "photo"), PNG); await setShare(b, "700", ["11"]);
  await b.put(mediaKey("701", "photo"), PNG); await setShare(b, "701", ["99"]);
  const lists: Record<string, { id: string; photo: string }[]> = {
    "11": [{ id: "700", photo: "https://x.schoology.com/p.jpg" }, { id: "702", photo: "" }, { id: "701", photo: "" }],
    "12": [{ id: "700", photo: "https://x.schoology.com/p.jpg" }],
  };
  await addSharedPhotos(b, lists, { origin: "https://api.averages.io", secret: SECRET, viewer: "800" });
  check("a classmate who shows their photo gets it in place of Schoology's", lists["11"][0].photo.startsWith("https://api.averages.io/media/peer/700?"), true);
  check("one who doesn't keeps Schoology's (or none)", lists["11"][1].photo, "");
  check("one who shows it only in another class: not here", lists["11"][2].photo, "");
  check("a class they're both in, but marked only in one: Schoology's there", lists["12"][0].photo, "https://x.schoology.com/p.jpg");
}

console.log("\nthe routes (review sandbox)");
{
  const MEDIA = fakeBucket();
  const ENV: any = { SESSION_SECRET: SECRET, MEDIA, REVIEW_KEY: "review-key-0123456789abcdef", REVIEW_SECRET: "review-secret-0123456789abcdef" };
  const CTX: any = { waitUntil() {}, passThroughOnException() {} };
  const API = "https://api.averages.io", APP = "https://app.averages.io";
  const reviewer = `${SESSION_COOKIE}=${await sealSession({ key: SANDBOX_KEY, secret: SANDBOX_SECRET, uid: REVIEW_UID }, SECRET)}`;
  const CREDS = { key: "abcdef0123456789abcdef0123456789", secret: "0123456789abcdef0123456789abcdef" };
  const kid = `${SESSION_COOKIE}=${await sealSession({ ...CREDS, uid: "1003", inc: true }, SECRET)}`;
  async function call(path: string, init: { method?: string; json?: unknown; cookie?: string; raw?: boolean } = {}) {
    resetRateLimits();
    const headers = new Headers();
    headers.set("Cookie", init.cookie ?? reviewer);
    headers.set("Origin", APP);
    let body: string | undefined;
    if (init.json !== undefined) { headers.set("Content-Type", "application/json"); body = JSON.stringify(init.json); }
    const res = (await worker.fetch(new Request(path.startsWith("http") ? path : API + path, { method: init.method ?? (body ? "POST" : "GET"), headers, body }), ENV, CTX)) as Response;
    if (init.raw) return { res, data: new Uint8Array(await res.arrayBuffer()) as any };
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { res, data };
  }

  let r = await call("/media/photo/share");
  check("GET share: off to start with", [r.res.status, r.data.on, r.data.available], [200, false, true]);
  r = await call("/media/photo/share", { json: { on: "yes" } });
  check("POST share needs on: true or false", [r.res.status, r.data.error], [400, "bad_request"]);
  r = await call("/media/photo/share", { json: { on: true } });
  const mine = await readShare(MEDIA, REVIEW_UID);
  check("POST share on: the record lists the student's own classes", [r.res.status, r.data.on, Array.isArray(mine) && mine.length > 0], [200, true, true]);
  r = await call("/media/photo/share");
  check("GET share: on", r.data.on, true);
  r = await call("/media/photo/share", { cookie: kid, json: { on: true } });
  check("Incognito (under 13): never", [r.res.status, r.data.error], [403, "incognito_mode"]);

  // a classmate in the reviewer's first class shows their photo
  r = await call("/data/classmates");
  const first = Object.keys(r.data.CLASSMATES).find((k) => r.data.CLASSMATES[k].length)!;
  const mate = r.data.CLASSMATES[first][0];
  check("before: Schoology's picture (none in the sandbox)", mate.photo, "");
  await MEDIA.put(mediaKey(mate.id, "photo"), JPEG, { httpMetadata: { contentType: "image/jpeg" } });
  await setShare(MEDIA, mate.id, [first]);
  r = await call("/data/classmates");
  const url = (r.data.CLASSMATES[first] as any[]).find((m) => m.id === mate.id).photo;
  check("after: their own photo, at a signed address on the API", url.startsWith(`${API}/media/peer/${mate.id}?v=`), true);
  const others = Object.entries(r.data.CLASSMATES).filter(([k]) => k !== first).flatMap(([, l]: any) => l).filter((m: any) => m.id === mate.id);
  check("in a class where they didn't mark it: not shown there", others.every((m: any) => m.photo === ""), true);

  let p = await call(url, { raw: true });
  check("the photo loads for the student it was given to", [p.res.status, p.res.headers.get("Content-Type"), Array.from(p.data as Uint8Array)], [200, "image/jpeg", Array.from(JPEG)]);
  check("kept by the browser for this version, never anywhere shared", [p.res.headers.get("Cache-Control"), p.res.headers.get("Cross-Origin-Resource-Policy"), p.res.headers.get("X-Content-Type-Options")], ["private, max-age=604800, immutable", "same-site", "nosniff"]);
  p = await call(url, { cookie: kid, raw: true });
  check("another student with the same address: 404", p.res.status, 404);
  p = await call(url.replace(/s=[0-9a-f]+/, "s=" + "0".repeat(32)), { raw: true });
  check("a made-up signature: 404", p.res.status, 404);
  p = await call(`${API}/media/peer/${mate.id}`, { raw: true });
  check("no signature: 404", p.res.status, 404);

  await MEDIA.put(mediaKey(mate.id, "photo"), PNG);
  p = await call(url, { raw: true });
  check("a new photo: the old address stops (the next list has the new one)", p.res.status, 404);
  await setShare(MEDIA, mate.id, [first]);
  r = await call("/data/classmates");
  const url2 = (r.data.CLASSMATES[first] as any[]).find((m) => m.id === mate.id).photo;
  p = await call(url2, { raw: true });
  check("the new address has the new photo", [url2 !== url, p.res.status, Array.from(p.data as Uint8Array)], [true, 200, Array.from(PNG)]);

  await setShare(MEDIA, mate.id, null);
  p = await call(url2, { raw: true });
  check("turned off: the photo stops at once", p.res.status, 404);
  r = await call("/data/classmates");
  check("and the list is back to Schoology's", (r.data.CLASSMATES[first] as any[]).find((m) => m.id === mate.id).photo, "");

  r = await call("/media/photo/share", { json: { on: false } });
  check("POST share off: record gone", [r.res.status, r.data.on, await readShare(MEDIA, REVIEW_UID)], [200, false, null]);

  // a new photo while on updates the markers
  await call("/media/photo/share", { json: { on: true } });
  resetRateLimits();
  const put = await worker.fetch(new Request(API + "/media/photo", { method: "PUT", headers: { Cookie: reviewer, Origin: APP, "Content-Type": "image/png" }, body: PNG }), ENV, CTX);
  const v = (await put.json() as any).v;
  const sec = (await readShare(MEDIA, REVIEW_UID))![0];
  check("PUT photo while on: the markers carry the new version", [put.status, MEDIA.objects.get(shareKey(sec, REVIEW_UID))?.meta?.v], [200, v]);
  resetRateLimits();
  await worker.fetch(new Request(API + "/media/photo", { method: "DELETE", headers: { Cookie: reviewer, Origin: APP } }), ENV, CTX);
  check("DELETE photo: the markers go, sharing stays on for a new photo", [MEDIA.objects.has(shareKey(sec, REVIEW_UID)), (await readShare(MEDIA, REVIEW_UID)) !== null], [false, true]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
