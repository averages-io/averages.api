/**
 * Feature switches you can flip without a deploy (2026-10-09, Martin's list):
 * Cloudflare Flagship. Replaces the first three flags (canva-export,
 * canva-folders, schools-verify-email), which are plain vars again.
 *
 *   canva-integration              all of Canva (connect, designs, folders, export)
 *   onedrive-integration           all of OneDrive
 *   drive-integration              all of Google Drive
 *   schoology-signin               signing in with a Schoology API key
 *   gclassroom-signin              "Sign in with Google" (Classroom)
 *   canvas-signin                  the Canvas option on the sign-in page (app only for now)
 *   test-signin                    the reviewer account (REVIEW_KEY / REVIEW_SECRET)
 *   maintenance-banner             a banner across the app (text: MAINTENANCE_MESSAGE)
 *   schoolsform-page               the school application form
 *   coursematerialpreview-feature  previews of course materials (not built yet: off)
 *   turnin-feature                 turning in work (history stays readable)
 *   messaging-features             Messages
 *   notifications-features         browser notifications (and the checks that send them)
 *
 * Turning one off: the API answers that feature's routes with 503
 * { error: "feature_off", feature } (gate() in index.ts), and the app hides
 * it (GET /config/features, read by public/js/averages-features.js). People
 * already signed in stay signed in when a sign-in option goes off.
 *
 * Where the answer comes from, first match wins:
 *   1. Flagship, when the FLAGS binding is set up (wrangler.jsonc "flagship")
 *      and answers within FLAG_WAIT_MS with a boolean;
 *   2. the FEATURES_OFF / FEATURES_ON vars (comma-separated keys), for
 *      flipping one without Flagship;
 *   3. DEFAULTS below.
 * So nothing changes until a flag is created, and a Flagship outage changes nothing.
 */

export const DEFAULTS = {
  "canva-integration": true,
  "onedrive-integration": true,
  "drive-integration": true,
  "schoology-signin": true,
  "gclassroom-signin": true,
  "canvas-signin": true,
  "test-signin": true,
  "maintenance-banner": false,
  "schoolsform-page": true,
  "coursematerialpreview-feature": false,
  "turnin-feature": true,
  "messaging-features": true,
  "notifications-features": true,
} as const;

export type FeatureKey = keyof typeof DEFAULTS;
export type Features = Record<FeatureKey, boolean>;
export const FEATURE_KEYS = Object.keys(DEFAULTS) as FeatureKey[];

/** How long a request waits for Flagship before using the fallbacks. */
export const FLAG_WAIT_MS = 400;

interface FlagshipLike {
  getBooleanValue(key: string, defaultValue: boolean, context?: Record<string, unknown>): Promise<boolean>;
}

function answer(p: Promise<boolean>, fallback: boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(typeof v === "boolean" ? v : fallback); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

function listed(value: unknown): Set<string> {
  return new Set(typeof value === "string" ? value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
}

/** Without Flagship: DEFAULTS, then FEATURES_ON / FEATURES_OFF (off wins if a key is in both). */
export function fallbackFeatures(env: object): Features {
  const on = listed((env as any).FEATURES_ON);
  const off = listed((env as any).FEATURES_OFF);
  const out = {} as Features;
  for (const k of FEATURE_KEYS) out[k] = off.has(k) ? false : on.has(k) ? true : DEFAULTS[k];
  return out;
}

/** Every switch's current answer. Never throws. */
export async function readFeatures(env: object, ms = FLAG_WAIT_MS): Promise<Features> {
  const base = fallbackFeatures(env);
  const flags = (env as any).FLAGS as FlagshipLike | undefined;
  if (!flags || typeof flags.getBooleanValue !== "function") return base;
  const pairs = await Promise.all(
    FEATURE_KEYS.map(async (k) => {
      let on = base[k];
      try {
        on = await answer(flags.getBooleanValue(k, base[k]), base[k], ms);
      } catch {
        on = base[k];
      }
      return [k, on] as const;
    })
  );
  return Object.fromEntries(pairs) as Features;
}

/** env plus FEATURES (the answers for this request). */
export async function withFlags<E extends object>(env: E, ms = FLAG_WAIT_MS): Promise<E & { FEATURES: Features }> {
  return { ...env, FEATURES: await readFeatures(env, ms) };
}

/** One switch, from env.FEATURES when this request has it, else the fallbacks. */
export function featureOn(env: object, key: FeatureKey): boolean {
  const f = (env as any).FEATURES as Features | undefined;
  return f && typeof f[key] === "boolean" ? f[key] : fallbackFeatures(env)[key];
}

/**
 * Which switch a request needs, or null. Reading what you already turned in
 * (/submit/history), turning notifications off (DELETE /push...) and the
 * push config stay open, so nothing gets stuck on.
 */
export function featureForRoute(method: string, path: string): FeatureKey[] {
  const m = method.toUpperCase();
  const need: FeatureKey[] = [];
  if (path === "/canva" || path.startsWith("/canva/")) {
    need.push("canva-integration");
    // Exporting a design as a PDF is how a Canva design gets turned in.
    if (/^\/canva\/(designs\/[^/]+\/export|exports\/)/.test(path)) need.push("turnin-feature");
  }
  if (/^\/cloud\/gdrive(\/|$)/.test(path)) need.push("drive-integration");
  if (/^\/cloud\/onedrive(\/|$)/.test(path)) need.push("onedrive-integration");
  if (path.startsWith("/submit/") && !(m === "GET" && path === "/submit/history")) need.push("turnin-feature");
  if (path === "/messages" || path.startsWith("/messages/")) need.push("messaging-features");
  if (path.startsWith("/push/") && m !== "DELETE" && path !== "/push/config") need.push("notifications-features");
  if (path.startsWith("/schools/apply")) need.push("schoolsform-page");
  if (m === "GET" && path === "/auth/google/start") need.push("gclassroom-signin");
  return need;
}
