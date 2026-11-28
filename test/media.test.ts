// Profile photo and background in file storage, through the real Worker routes with an in-memory bucket.
// Run: node --experimental-strip-types --import ./test/cf-loader.mjs test/media.test.ts
import worker from "../src/index.ts";
import { resetRateLimits } from "../src/rateLimit.ts";
import { DEMO_UID, sealSession, SESSION_COOKIE } from "../src/session.ts";
import { deleteAllMedia, imageSize, mediaKey, photoProblem, sniffImage, type MediaBucket } from "../src/media.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual:   ${a}`); }
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`network call during the media test: ${String(input)}`);
}) as typeof fetch;

/** An in-memory R2 bucket with the calls src/media.ts makes. */
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; type?: string; etag: string }>();
  let n = 0;
  let broken = false;
  const bucket: MediaBucket & { objects: typeof objects; break(on: boolean): void } = {
    objects,
    break(on) { broken = on; },
    async put(key, value, options) {
      if (broken) throw new Error("R2 down");
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      const etag = `e${++n}`;
      objects.set(key, { bytes: bytes.slice(), type: options?.httpMetadata?.contentType, etag });
      return { etag };
    },
    async get(key) {
      if (broken) throw new Error("R2 down");
      const o = objects.get(key);
      if (!o) return null;
      return { body: new Response(o.bytes).body!, etag: o.etag, httpMetadata: { contentType: o.type }, size: o.bytes.byteLength };
    },
    async delete(keys) {
      if (broken) throw new Error("R2 down");
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(options) {
      const all = [...objects.keys()].filter((k) => k.startsWith(options?.prefix ?? "")).sort();
      // Two per page, so the paging loop is exercised.
      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = all.slice(start, start + 2);
      const truncated = start + 2 < all.length;
      return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + 2) : undefined };
    },
  };
  return bucket;
}

/** Sync's Durable Object, in memory (only DELETE /sync/settings is used here). */
function fakeSync() {
  const records = new Map<string, string>();
  const ns: any = {
    records,
    jurisdiction: () => ns,
    idFromName: (name: string) => name,
    get: (id: string) => ({
      getRecord: async (key: string) => records.get(`${id}|${key}`) ?? null,
      putRecord: async (key: string, value: string) => void records.set(`${id}|${key}`, value),
      deleteRecord: async () => { for (const k of [...records.keys()]) if (k.startsWith(`${id}|`)) records.delete(k); },
    }),
  };
  return ns;
}

const SECRET = "media-test-session-secret";
const MEDIA = fakeBucket();
const ENV: any = { SESSION_SECRET: SECRET, MEDIA, SYNC: fakeSync() };
const CTX: any = { waitUntil() {}, passThroughOnException() {} };
const API = "https://api.averages.io";
const APP = "https://app.averages.io";

const CREDS = { key: "abcdef0123456789abcdef0123456789", secret: "0123456789abcdef0123456789abcdef" };
const alice = `${SESSION_COOKIE}=${await sealSession({ ...CREDS, uid: "1001", p: { n: "Alice A", f: "Alice" } }, SECRET)}`;
const bob = `${SESSION_COOKIE}=${await sealSession({ ...CREDS, uid: "1002" }, SECRET)}`;
const kid = `${SESSION_COOKIE}=${await sealSession({ ...CREDS, uid: "1003", inc: true }, SECRET)}`;
const demo = `${SESSION_COOKIE}=${await sealSession({ key: "", secret: "", uid: DEMO_UID }, SECRET)}`;

async function call(method: string, path: string, init: { cookie?: string; body?: Uint8Array; type?: string; origin?: string; env?: any } = {}) {
  resetRateLimits();
  const headers = new Headers();
  if (init.cookie) headers.set("Cookie", init.cookie);
  headers.set("Origin", init.origin ?? APP);
  if (init.type) headers.set("Content-Type", init.type);
  const res = await worker.fetch(new Request(API + path, { method, headers, body: init.body }), init.env ?? ENV, CTX);
  return res;
}
const json = async (res: Response) => res.json().catch(() => null);

const b64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
/** Real (tiny, 4 x 4) pictures: photos are checked for their size in pixels now. */
const PNG = b64("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFUlEQVR4XmM8EWDDAANMcBYDAx4OAEP4AVzA+QYSAAAAAElFTkSuQmCC");
const JPEG = b64("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDMooor50/Rz//Z");
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

console.log("what counts as a picture");
check("JPEG, PNG, GIF, WebP recognised by their bytes", [sniffImage(JPEG), sniffImage(PNG), sniffImage(GIF), sniffImage(WEBP)], ["image/jpeg", "image/png", "image/gif", "image/webp"]);
check("SVG, HTML and empty refused", [sniffImage(SVG), sniffImage(new TextEncoder().encode("<html>")), sniffImage(new Uint8Array())], [null, null, null]);

console.log("\nputting and getting");
{
  const res = await call("PUT", "/media/photo", { cookie: alice, body: PNG, type: "image/png" });
  const data = await json(res);
  check("PUT photo: 200 with a version", [res.status, data.ok, typeof data.v === "string" && data.v.length > 0], [200, true, true]);
  check("stored under the student's own key, typed from its bytes", [MEDIA.objects.has(mediaKey("1001", "photo")), MEDIA.objects.get(mediaKey("1001", "photo"))?.type], [true, "image/png"]);
  check("no caching on the answer", res.headers.get("Cache-Control"), "private, no-store");
}
{
  const res = await call("PUT", "/media/photo", { cookie: alice, body: JPEG, type: "image/png" });
  check("a new photo replaces the old (one object, typed by its bytes not the header)", [res.status, [...MEDIA.objects.keys()].filter((k) => k.startsWith("u/1001/")).length, MEDIA.objects.get("u/1001/photo")?.type], [200, 1, "image/jpeg"]);
}
{
  const res = await call("GET", "/media/photo", { cookie: alice });
  const bytes = new Uint8Array(await res.arrayBuffer());
  check("GET photo: the same bytes back", [res.status, res.headers.get("Content-Type"), Array.from(bytes)], [200, "image/jpeg", Array.from(JPEG)]);
  check("GET: nosniff, sandboxed, same-site only, not cached", [res.headers.get("X-Content-Type-Options"), res.headers.get("Content-Security-Policy"), res.headers.get("Cross-Origin-Resource-Policy"), res.headers.get("Cache-Control")], ["nosniff", "default-src 'none'; sandbox", "same-site", "private, no-store"]);
  check("GET: the version, readable by the app (CORS)", [res.headers.get("X-Media-Version"), res.headers.get("Access-Control-Allow-Origin"), (res.headers.get("Access-Control-Expose-Headers") ?? "").includes("X-Media-Version")], ["e2", APP, true]);
}
{
  const res = await call("GET", "/media/photo", { cookie: bob });
  check("another student can't see it: their own (empty) photo is 404", [res.status, (await json(res))?.error], [404, "not_found"]);
}
{
  const res = await call("PUT", "/media/background", { cookie: alice, body: WEBP, type: "image/webp" });
  check("PUT background (WebP)", [res.status, MEDIA.objects.get("u/1001/background")?.type], [200, "image/webp"]);
  const gif = await call("PUT", "/media/photo", { cookie: bob, body: GIF, type: "image/gif" });
  check("an animated GIF photo goes up as it is", [gif.status, MEDIA.objects.get("u/1002/photo")?.type], [200, "image/gif"]);
}

console.log("\nphotos are kept small");
{
  const WEBP_LOSSY = b64("UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoEAAQAAUAmJaACdLoB+AAETAAA/uX6P+3Jl5wR/9cB+cB+cB/KwAAA"), WEBP_LOSSLESS = b64("UklGRiAAAABXRUJQVlA4TBQAAAAvP8ALAAcQEf0PAAnh/3oxov+pHw=="), WEBP_EXT = b64("UklGRtIAAABXRUJQVlA4WAoAAAAQAAAAKwEAxwAAQUxQSBEAAAABBxAREQBQpP//KaL/qf9fAwBWUDggmgAAAHAQAJ0BKiwByAA+bTaZSaQjIqEgKACADYlpbuF2sRtACewD32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snCgAP7/1gAAAAAAAAAAAAA="), JPEG_PROG = b64("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAC0AUADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAVAQEBAAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEAMQAAABgAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//xAAUEAEAAAAAAAAAAAAAAAAAAACQ/9oACAEBAAEFAmY//8QAFBEBAAAAAAAAAAAAAAAAAAAAcP/aAAgBAwEBPwFw/8QAFBEBAAAAAAAAAAAAAAAAAAAAcP/aAAgBAgEBPwFw/8QAFBABAAAAAAAAAAAAAAAAAAAAkP/aAAgBAQAGPwJmP//EABQQAQAAAAAAAAAAAAAAAAAAAJD/2gAIAQEAAT8hZj//2gAMAwEAAgADAAAAEAwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww//EABQRAQAAAAAAAAAAAAAAAAAAAHD/2gAIAQMBAT8QcP/EABQRAQAAAAAAAAAAAAAAAAAAAHD/2gAIAQIBAT8QcP/EABQQAQAAAAAAAAAAAAAAAAAAAJD/2gAIAQEAAT8QZj//2Q==");
  check("sizes in pixels, read from the first bytes", [imageSize(PNG, "image/png"), imageSize(JPEG, "image/jpeg"), imageSize(JPEG_PROG, "image/jpeg"), imageSize(WEBP_LOSSY, "image/webp"), imageSize(WEBP_LOSSLESS, "image/webp"), imageSize(WEBP_EXT, "image/webp"), imageSize(GIF, "image/gif")],
    [{ w: 4, h: 4 }, { w: 4, h: 4 }, { w: 320, h: 180 }, { w: 4, h: 4 }, { w: 64, h: 48 }, { w: 300, h: 200 }, { w: 1, h: 1 }]);
  const wide = PNG.slice(); wide[16] = 0; wide[17] = 0; wide[18] = 0x02; wide[19] = 0x58;   // 600 px wide
  check("a photo over 512 px a side: photo_too_big", photoProblem(wide, "image/png"), { status: 422, error: "photo_too_big", max: 512 });
  const heavy = new Uint8Array(160 * 1024); heavy.set(PNG);
  check("a still photo over 150 KB: too_large", photoProblem(heavy, "image/png"), { status: 413, error: "too_large", max: 150 * 1024 });
  const bigGif = new TextEncoder().encode("GIF89a\x00\x05\x00\x05");   // 1280 x 1280
  check("an animated GIF can be bigger, up to 1024 px", [photoProblem(GIF, "image/gif"), photoProblem(bigGif, "image/gif")?.error], [null, "photo_too_big"]);
  check("a JPEG with no frame header: not_an_image", photoProblem(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 2, 3, 4]), "image/jpeg")?.error, "not_an_image");
  let res = await call("PUT", "/media/photo", { cookie: bob, body: wide, type: "image/png" });
  check("PUT a 600 px photo: 422 photo_too_big", [res.status, (await json(res))?.maxSide], [422, 512]);
  res = await call("PUT", "/media/photo", { cookie: bob, body: heavy, type: "image/png" });
  check("PUT a 160 KB photo: 413 too_large", [res.status, (await json(res))?.maxBytes], [413, 150 * 1024]);
  res = await call("PUT", "/media/photo", { cookie: bob, body: WEBP_LOSSY, type: "image/webp" });
  check("PUT the app's small WebP: 200", res.status, 200);
  res = await call("PUT", "/media/background", { cookie: bob, body: wide, type: "image/png" });
  check("backgrounds keep their own rules (a 600 px one is fine)", res.status, 200);
}

console.log("\nrefusals");
{
  const svg = await call("PUT", "/media/photo", { cookie: alice, body: SVG, type: "image/svg+xml" });
  check("SVG refused (415)", [svg.status, (await json(svg))?.error], [415, "not_an_image"]);
  const empty = await call("PUT", "/media/photo", { cookie: alice, body: new Uint8Array(), type: "image/png" });
  check("empty body refused", [empty.status, (await json(empty))?.error], [400, "empty"]);
  const big = new Uint8Array(2 * 1024 * 1024 + 1); big.set(PNG);
  const tooBig = await call("PUT", "/media/photo", { cookie: alice, body: big, type: "image/png" });
  check("photo over 2 MB refused (413)", [tooBig.status, (await json(tooBig))?.error], [413, "too_large"]);
  const bigBg = new Uint8Array(4 * 1024 * 1024 + 1); bigBg.set(JPEG);
  const tooBigBg = await call("PUT", "/media/background", { cookie: alice, body: bigBg, type: "image/jpeg" });
  check("background over 4 MB refused (413)", tooBigBg.status, 413);
  const okBg = new Uint8Array(3 * 1024 * 1024); okBg.set(JPEG);
  check("a 3 MB background is fine", (await call("PUT", "/media/background", { cookie: alice, body: okBg, type: "image/jpeg" })).status, 200);
  const kind = await call("PUT", "/media/avatar", { cookie: alice, body: PNG, type: "image/png" });
  check("unknown kind: 404", [kind.status, (await json(kind))?.error], [404, "unknown_kind"]);
  const none = await call("PUT", "/media/photo", { body: PNG, type: "image/png" });
  check("signed out: 401", none.status, 401);
  const other = await call("PUT", "/media/photo", { cookie: alice, body: PNG, type: "image/png", origin: "https://evil.example" });
  check("another site's page: 403", [other.status, (await json(other))?.error], [403, "forbidden_origin"]);
  const inc = await call("PUT", "/media/photo", { cookie: kid, body: PNG, type: "image/png" });
  check("Incognito (under 13) stores nothing", [inc.status, (await json(inc))?.error, MEDIA.objects.has("u/1003/photo")], [403, "incognito_mode", false]);
  const incGet = await call("GET", "/media/photo", { cookie: kid });
  check("Incognito can't read either", incGet.status, 403);
  const dem = await call("PUT", "/media/photo", { cookie: demo, body: PNG, type: "image/png" });
  check("demo stores nothing", [dem.status, (await json(dem))?.error], [403, "not_available_in_demo"]);
  const noBucket = await call("PUT", "/media/photo", { cookie: alice, body: PNG, type: "image/png", env: { ...ENV, MEDIA: undefined } });
  check("no bucket set up yet: 503 (the app keeps pictures in Sync as before)", [noBucket.status, (await json(noBucket))?.error], [503, "media_unavailable"]);
  MEDIA.break(true);
  const down = await call("PUT", "/media/photo", { cookie: alice, body: PNG, type: "image/png" });
  const downGet = await call("GET", "/media/photo", { cookie: alice });
  MEDIA.break(false);
  check("R2 failing: 503 for put and get", [down.status, downGet.status], [503, 503]);
}

console.log("\ndeleting");
{
  const del = await call("DELETE", "/media/background", { cookie: alice });
  check("DELETE background", [del.status, MEDIA.objects.has("u/1001/background"), MEDIA.objects.has("u/1001/photo")], [200, false, true]);
  const again = await call("DELETE", "/media/background", { cookie: alice });
  check("deleting what isn't there is fine", again.status, 200);
  const inc = await call("DELETE", "/media/photo", { cookie: kid });
  check("Incognito may delete", inc.status, 200);
}
{
  await call("PUT", "/media/background", { cookie: alice, body: JPEG, type: "image/jpeg" });
  await call("PUT", "/media/photo", { cookie: bob, body: PNG, type: "image/png" });
  const off = await call("DELETE", "/sync/settings", { cookie: alice });
  check("turning Sync off deletes all of this student's pictures", [off.status, [...MEDIA.objects.keys()].filter((k) => k.startsWith("u/1001/"))], [200, []]);
  check("and only theirs", MEDIA.objects.has("u/1002/photo"), true);
  const noBucket = await call("DELETE", "/sync/settings", { cookie: bob, env: { ...ENV, MEDIA: undefined } });
  check("turning Sync off still works with no bucket", noBucket.status, 200);
  MEDIA.break(true);
  const broken = await call("DELETE", "/sync/settings", { cookie: bob });
  MEDIA.break(false);
  check("and with R2 failing (Sync's own record is still deleted)", broken.status, 200);
}
{
  const many = fakeBucket();
  for (const k of ["u/7/a", "u/7/b", "u/7/c", "u/7/d", "u/7/e", "u/70/x"]) await many.put(k, JPEG);
  await deleteAllMedia(many, "7");
  check("deleteAllMedia pages through everything, and not u/70/", [...many.objects.keys()], ["u/70/x"]);
}

console.log("\nrate limit");
{
  // The in-memory limit (the binding isn't in this env): 20 a minute per student.
  const { resetRateLimits: reset } = await import("../src/rateLimit.ts");
  reset();
  let last = 0;
  for (let i = 0; i < 21; i++) {
    const headers = new Headers({ Cookie: alice, Origin: APP, "Content-Type": "image/png" });
    last = (await worker.fetch(new Request(API + "/media/photo", { method: "PUT", headers, body: PNG }), ENV, CTX)).status;
  }
  check("the 21st upload in a minute is refused (429)", last, 429);
}

console.log("\nsynced settings keep the added calendar dates (2026-11-26)");
{
  const put = async (settings: unknown) => json(await call("PUT", "/sync/settings", { cookie: bob, type: "application/json", body: new TextEncoder().encode(JSON.stringify({ settings })) }));
  const dates = [{ id: "up1", t: "Winter Break", kind: "off", date: "2026-12-21" }];
  const a = await put({ settingsOptions: { syncAcrossDevices: true }, calendarDates: dates });
  check("a device with dates: they're saved", a?.settings?.calendarDates, dates);
  const b = await put({ settingsOptions: { syncAcrossDevices: true, potatoMode: true } });
  check("a device without the field (new, or an older page): the list is kept", [b?.settings?.calendarDates, b?.settings?.settingsOptions?.potatoMode], [dates, true]);
  const c = await put({ settingsOptions: {}, calendarDates: [] });
  check("an empty list (all removed): saved as empty", c?.settings?.calendarDates, []);
  const d = await put({ settingsOptions: {} });
  check("and stays empty", d?.settings?.calendarDates, []);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
