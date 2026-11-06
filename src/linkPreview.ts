// Link previews: a link in a message shows the page's title, site and picture, like Messages does.

const UA = "Mozilla/5.0 (compatible; AveragesLinkPreview/1.0; +https://averages.io)";
const PAGE_MAX = 512 * 1024;
const IMAGE_MAX = 3 * 1024 * 1024;
const TIMEOUT_MS = 5000;
const MAX_HOPS = 4;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)$/i;
/** Bot-check pages ("Just a moment…") aren't the page: no preview from them. */
const CHALLENGE = /^(client challenge|just a moment|attention required|access denied|verify you are human|security check|please wait|checking your browser|403 forbidden|captcha)/i;

export interface LinkPreview {
  url: string;
  title: string;
  site: string;
  description: string;
  image: string;
  icon: string;
}

/** A public web address we may fetch: see the top of this file. */
export function isSafeWebTarget(u: URL): boolean {
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password || u.port !== "") return false;
  if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[") || host.includes(":")) return false; // IPv4 / IPv6 literals
  if (/^0x|^\d+$/.test(host.split(".")[0]) && /^[\dx.]+$/i.test(host)) return false;
  return true;
}

/** The address from the browser, as a URL we may fetch, or null. */
export function parseTarget(raw: string | undefined | null): URL | null {
  if (!raw || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  u.hash = "";
  return isSafeWebTarget(u) ? u : null;
}

/** GET with every redirect hop checked; null when a hop isn't allowed or it never settles. */
async function safeFetch(start: URL, accept: string): Promise<{ res: Response; url: URL } | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.8" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      await res.body?.cancel().catch(() => {});
      if (!loc) return null;
      let next: URL;
      try {
        next = new URL(loc, url);
      } catch {
        return null;
      }
      if (!isSafeWebTarget(next)) return null;
      url = next;
      continue;
    }
    return { res, url };
  }
  return null;
}

/** Up to `max` bytes of a body (the rest is never read). */
async function readUpTo(res: Response, max: number, failOver = false): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      await reader.cancel().catch(() => {});
      if (failOver) return null;
      parts.push(value.subarray(0, max - size));
      size = max;
      break;
    }
    parts.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeChar(Number(d)))
    .replace(/&([a-z]+|#39);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function safeChar(n: number): string {
  return n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
}
const clean = (s: string, max: number) => {
  const t = decode(s).replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

/** The attributes of one tag, lower-cased names. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  return out;
}

/** Reads the preview from a page's HTML (only its <head> matters). Exported for the tests. */
export function previewFromHtml(html: string, pageUrl: URL): LinkPreview {
  const head = html.slice(0, PAGE_MAX).split(/<\/head>/i)[0];
  const meta: Record<string, string> = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    const key = (a.property || a.name || a.itemprop || "").toLowerCase();
    if (key && a.content != null && !(key in meta)) meta[key] = a.content;
  }
  let icon = "";
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    const rel = (a.rel || "").toLowerCase();
    if (a.href && /(^|\s)(apple-touch-icon|icon)(\s|$)/.test(rel) && (!icon || rel.includes("apple-touch-icon"))) icon = a.href;
  }
  const abs = (v: string) => {
    if (!v) return "";
    try {
      const u = new URL(decode(v.trim()), pageUrl);
      return isSafeWebTarget(u) ? u.toString() : "";
    } catch {
      return "";
    }
  };
  const titleTag = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? "";
  const host = pageUrl.hostname.replace(/^www\./, "");
  const t0 = clean(meta["og:title"] || meta["twitter:title"] || titleTag || "", 140);
  if (CHALLENGE.test(t0)) return { url: pageUrl.toString(), title: "", site: host, description: "", image: "", icon: abs("/favicon.ico") };
  return {
    url: pageUrl.toString(),
    title: clean(meta["og:title"] || meta["twitter:title"] || titleTag || "", 140),
    site: clean(meta["og:site_name"] || meta["application-name"] || "", 60) || host,
    description: clean(meta["og:description"] || meta["twitter:description"] || meta["description"] || "", 220),
    image: abs(meta["og:image:secure_url"] || meta["og:image"] || meta["og:image:url"] || meta["twitter:image"] || meta["twitter:image:src"] || ""),
    icon: abs(icon || "/favicon.ico"),
  };
}

const cacheKey = (kind: string, u: URL) => `https://link-preview.averages.internal/${kind}?u=${encodeURIComponent(u.toString())}`;
async function cached(key: string): Promise<Response | undefined> {
  try {
    return await (globalThis as any).caches?.default?.match(key);
  } catch {
    return undefined;
  }
}
async function keep(key: string, res: Response): Promise<void> {
  try {
    await (globalThis as any).caches?.default?.put(key, res);
  } catch {
    /* no cache here (tests, local): fine */
  }
}

/** The preview for a page; a bare one (its address) when the page can't be read. */
export async function getLinkPreview(target: URL): Promise<LinkPreview> {
  const key = cacheKey("preview", target);
  const hit = await cached(key);
  if (hit) return (await hit.json()) as LinkPreview;
  const bare: LinkPreview = { url: target.toString(), title: "", site: target.hostname.replace(/^www\./, ""), description: "", image: "", icon: "" };
  let out = bare;
  try {
    const got = await safeFetch(target, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1");
    if (got && got.res.ok && /text\/html|application\/xhtml/i.test(got.res.headers.get("Content-Type") ?? "")) {
      const bytes = await readUpTo(got.res, PAGE_MAX);
      const html = new TextDecoder("utf-8").decode(bytes ?? new Uint8Array(0));
      out = previewFromHtml(html, got.url);
      out.url = target.toString();
    } else if (got) {
      await got.res.body?.cancel().catch(() => {});
    }
  } catch {
    out = bare;
  }
  // YouTube often answers a server with a consent page, so its videos ask YouTube's own oEmbed for the title and
  // thumbnail instead.
  if (!out.title && /(^|\.)(youtube\.com|youtu\.be)$/i.test(target.hostname)) {
    try {
      const o = new URL("https://www.youtube.com/oembed");
      o.searchParams.set("url", target.toString());
      o.searchParams.set("format", "json");
      const got = await safeFetch(o, "application/json");
      if (got && got.res.ok) {
        const j = JSON.parse(new TextDecoder().decode((await readUpTo(got.res, 64 * 1024)) ?? new Uint8Array(0)));
        const thumb = typeof j?.thumbnail_url === "string" ? parseTarget(j.thumbnail_url) : null;
        out = { ...out, title: clean(String(j?.title ?? ""), 140), site: "YouTube", image: thumb ? thumb.toString() : out.image };
      } else await got?.res.body?.cancel().catch(() => {});
    } catch {
      /* the bare card is fine */
    }
  }
  await keep(key, new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } }));
  return out;
}

/** The picture, or null when it isn't one we show. */
export async function getLinkImage(target: URL): Promise<Response | null> {
  const key = cacheKey("image", target);
  const hit = await cached(key);
  if (hit) return hit;
  const got = await safeFetch(target, "image/webp,image/png,image/jpeg,image/gif;q=0.9");
  if (!got || !got.res.ok) {
    await got?.res.body?.cancel().catch(() => {});
    return null;
  }
  const type = (got.res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.test(type)) {
    await got.res.body?.cancel().catch(() => {});
    return null;
  }
  const bytes = await readUpTo(got.res, IMAGE_MAX, true);
  if (!bytes) return null;
  const res = new Response(bytes, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
  await keep(key, res.clone());
  return res;
}
