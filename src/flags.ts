/**
 * Switches you can flip without a deploy (2026-10-08, Martin): Cloudflare
 * Flagship. Each flag stands in for one wrangler.jsonc var:
 *
 *   canva-export           CANVA_EXPORT_ENABLED   turning in Canva designs as PDFs
 *   canva-folders          CANVA_FOLDERS_ENABLED  Canva folders on the Files page
 *   schools-verify-email   SCHOOLS_VERIFY_EMAIL   "Verify your email" on the school form
 *
 * With the FLAGS binding (wrangler.jsonc "flagship"), every request asks
 * Flagship first; the var is the default, used when the flag doesn't exist,
 * Flagship can't be reached in time, or the binding isn't set up at all. So
 * the vars keep working exactly as before, and a flag only has to be created
 * in the dashboard to take over. The answers are written back as "1" / "0"
 * on a copy of env, so the rest of the code keeps reading the vars.
 */

export const FLAG_VARS = {
  "canva-export": "CANVA_EXPORT_ENABLED",
  "canva-folders": "CANVA_FOLDERS_ENABLED",
  "schools-verify-email": "SCHOOLS_VERIFY_EMAIL",
} as const;

/** How long a request waits for Flagship before using the vars. */
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

/** env with the flagged vars replaced by Flagship's answers (or env itself when there's no FLAGS binding). */
export async function withFlags<E extends object>(env: E, ms = FLAG_WAIT_MS): Promise<E> {
  const flags = (env as any).FLAGS as FlagshipLike | undefined;
  if (!flags || typeof flags.getBooleanValue !== "function") return env;
  const pairs = await Promise.all(
    Object.entries(FLAG_VARS).map(async ([key, name]) => {
      const fallback = (env as any)[name] === "1";
      let on = fallback;
      try {
        on = await answer(flags.getBooleanValue(key, fallback), fallback, ms);
      } catch {
        on = fallback;
      }
      return [name, on ? "1" : "0"] as const;
    })
  );
  return { ...env, ...Object.fromEntries(pairs) } as E;
}
