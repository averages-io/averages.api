/**
 * Google Drive and OneDrive run in the student's browser (2026-10-05): their
 * Google and Microsoft tokens never reach this Worker. The app only needs a
 * few PUBLIC identifiers to start those sign-ins, which GET /config/cloud
 * serves.
 *
 * Every value is checked against the shape it should have before it's served.
 * These names sit next to real secrets in the Cloudflare dashboard, so if a
 * client secret were ever pasted into the wrong box, it must not end up on a
 * public endpoint: anything that doesn't look like the expected public ID is
 * left out instead. (A shape check can't tell a restricted API key from an
 * unrestricted one: GOOGLE_PICKER_API_KEY must be a key restricted to
 * app.averages.io and the Picker API in Google Cloud.)
 *
 * 2026-10-08: Google Drive and OneDrive now stay connected the way Canva does
 * (Martin: "why do google drive and onedrive need to be reauthed every time I
 * visit the page"). The Worker does the sign-in and keeps each student's
 * refresh token (src/cloudConnect.ts); the browser asks POST
 * /cloud/:app/token for a short-lived access token and still calls Drive and
 * Graph itself. /config/cloud stays for the Picker's API key and project
 * number, and the client IDs here are the ones cloudConnect.ts signs in with.
 */

export type CloudEnv = {
  /** Optional: a separate OAuth client just for Google Drive in the browser (2026-10-05). */
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_PROJECT_NUMBER?: string;
  MS_CLIENT_ID?: string;
};

export type CloudConfig = {
  google: { clientId: string; apiKey: string | null; appId: string | null } | null;
  microsoft: { clientId: string } | null;
};

/** Google OAuth client IDs: "<project number>-<random>.apps.googleusercontent.com". */
export const GOOGLE_CLIENT_ID_RE = /^\d{6,20}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;
/** Google API keys: "AIza" and 35 more URL-safe characters. */
export const GOOGLE_API_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/;
/** Google Cloud project numbers are all digits. */
export const GOOGLE_PROJECT_NUMBER_RE = /^\d{6,20}$/;
/** Microsoft Entra application (client) IDs are GUIDs. */
export const MS_CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value, trimmed, when it has the expected shape; otherwise null. Also used by cloudConnect.ts (2026-10-08). */
export function pick(value: unknown, shape: RegExp): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return shape.test(v) ? v : null;
}

export function cloudConfig(env: CloudEnv): CloudConfig {
  // Google Drive uses its own client when GOOGLE_DRIVE_CLIENT_ID is set (same
  // Google Cloud project, so the same consent screen and Picker project
  // number); otherwise the sign-in client, GOOGLE_CLIENT_ID.
  const googleClientId = pick(env.GOOGLE_DRIVE_CLIENT_ID, GOOGLE_CLIENT_ID_RE) ?? pick(env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_ID_RE);
  const msClientId = pick(env.MS_CLIENT_ID, MS_CLIENT_ID_RE);
  return {
    google: googleClientId
      ? {
          clientId: googleClientId,
          apiKey: pick(env.GOOGLE_PICKER_API_KEY, GOOGLE_API_KEY_RE),
          // The client ID starts with the project number, so this one is optional.
          appId: pick(env.GOOGLE_PROJECT_NUMBER, GOOGLE_PROJECT_NUMBER_RE) ?? googleClientId.split("-")[0],
        }
      : null,
    microsoft: msClientId ? { clientId: msClientId.toLowerCase() } : null,
  };
}
