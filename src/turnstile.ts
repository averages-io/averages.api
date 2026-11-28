// Bot check on the sign-in page.
// The page runs the bot check without showing anything to almost everyone (an invisible widget); the API asks
// whether the token is real before starting a sign-in. On only when both TURNSTILE_SITE_KEY (public, a
// wrangler var) and TURNSTILE_SECRET (npx wrangler secret put TURNSTILE_SECRET) are set.

export const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const SIGNIN_ACTION = "signin";

export interface TurnstileEnv {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** The hostnames a token may come from, comma-separated (production: app.averages.io only, never localhost). */
  TURNSTILE_HOSTNAMES?: string;
}

export function turnstileOn(env: TurnstileEnv): boolean {
  return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
}

/** The allowed hostnames: TURNSTILE_HOSTNAMES, plus localhost only while testing on this machine (wrangler dev). */
export function turnstileHosts(env: TurnstileEnv, local = false): Set<string> {
  const set = new Set(String(env.TURNSTILE_HOSTNAMES ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (local) { set.add("localhost"); set.add("127.0.0.1"); }
  return set;
}

/**
 * Is this token real, fresh, from our sign-in page, made on an allowed hostname? "ok"; "failed" (missing, used,
 * expired, another action or another site); or "unavailable" (Cloudflare couldn't be asked, or our secret was
 * refused: logged). Both of the last two refuse the sign-in (Cloudflare's guidance), with different messages.
 */
export async function checkTurnstile(
  token: unknown,
  secret: string,
  opts: { ip?: string | null; hosts: Set<string>; fetcher?: typeof fetch },
): Promise<"ok" | "failed" | "unavailable"> {
  if (typeof token !== "string" || !token || token.length > 2048 || !opts.hosts.size) return "failed";
  const form = new URLSearchParams({ secret: secret.trim(), response: token });
  if (opts.ip) form.set("remoteip", opts.ip);
  let json: any;
  try {
    const res = await (opts.fetcher ?? fetch)(TURNSTILE_VERIFY, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return "unavailable";
    json = await res.json();
  } catch {
    return "unavailable";
  }
  const codes: string[] = Array.isArray(json?.["error-codes"]) ? json["error-codes"] : [];
  if (codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret")) {
    console.error("turnstile_secret_rejected");   // the secret didn't reach us right: npx wrangler secret list
    return "unavailable";
  }
  if (json?.success !== true) return "failed";
  if (json.action !== SIGNIN_ACTION) return "failed";
  return opts.hosts.has(String(json.hostname ?? "").toLowerCase()) ? "ok" : "failed";
}
