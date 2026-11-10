# Developing averages.api

The setup reference: what to set, where, and how to run it. For what the API does and
what it keeps, see [README.md](README.md).

> **Naming:** the Worker is `averages-api`. The app's storage keys are still
> `schoolagy_*` from before the rename. Don't rename them, or existing users lose their
> settings. The old `schoolagy_session` cookie is still read and moved to
> `averages_session`.

## Commands

```bash
npm install
npm test          # every test file, run directly with node --experimental-strip-types
npm run build     # TypeScript check (tsc --noEmit)
npm run dev       # local Worker on http://localhost:8787
```

The tests need no framework and no build step. Route tests run the real Worker in Node,
with `test/cf-loader.mjs` standing in for `cloudflare:workers` and Schoology, Canva,
Google, Microsoft and Stripe faked. The keys in the tests are public example values or
made-up strings.

**Local development:** put secrets in `.dev.vars` (already in `.gitignore`) and point
redirect addresses at `http://localhost:8787/...`. Local Durable Objects can't be pinned
to the US, so on `localhost` (only) stores open without the `us` jurisdiction.

## Where things live

| File | What's in it |
|---|---|
| `src/index.ts` | The routes, the Worker's `fetch`, `queue` and `scheduled` handlers |
| `src/schoology.ts`, `src/oauth.ts`, `src/schoologySignin.ts` | Signed Schoology calls and Sign in with Schoology |
| `src/adapt.ts` | Schoology's answers shaped for the app, and grade predictions |
| `src/*Store.ts` | Durable Objects (one per student, US): sync, Canva, cloud, push, billing, calendar, health |
| `src/flags.ts` | Feature switches |
| `src/health.ts` | The 15-minute check behind the outage banner and `/status` |
| `src/reviewSandbox.ts` | The reviewer account: a pretend Schoology inside the Worker |

## Secrets

Worker → Settings → Variables and Secrets (type *Secret*), or `npx wrangler secret put NAME`.

| Name | Used for |
|---|---|
| `SESSION_SECRET` | Seals session cookies. Required: without it sign-in answers 500 on purpose. Make one with `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"` |
| `SCHOOLOGY_CONSUMER_KEY`, `SCHOOLOGY_CONSUMER_SECRET` | Sign in with Schoology (the app's consumer key from PowerSchool). Unset: the button says it's coming soon |
| `CANVA_CLIENT_SECRET` | Canva Connect. Unset: Canva says "not set up" |
| `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_CLIENT_SECRET` | Google Drive. The Drive-only client is used when both its ID and secret are set |
| `MS_CLIENT_SECRET` | OneDrive (the Entra app's **Web** platform secret). These expire, so set a reminder |
| `PUSH_SECRET` | Seals the stored sign-in for notifications and calendar sync. Must differ from `SESSION_SECRET` |
| `VAPID_PRIVATE_JWK` | Browser notifications: the private VAPID key as JWK JSON |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Averages Plus. Unset: checkout and the webhook answer 503 |
| `REVIEW_KEY`, `REVIEW_SECRET` | The reviewer account (16+ characters each), typed into `app.averages.io/?keys`. Unset: off |
| `SCHOOLS_ADMIN_KEY` | Optional developer key for the Canva permission probe |

## Variables (`wrangler.jsonc`)

`keep_vars` is on: a variable set only in the dashboard survives deploys; one in the
file takes the file's value. **Build** variables never reach the running Worker. If
sign-in answers 500, open `/` on the Worker: it says whether `SESSION_SECRET` is set.

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_ID`, `MS_CLIENT_ID`, `CANVA_CLIENT_ID` | Public client IDs. `/config/cloud` only serves values shaped like an ID, so a pasted secret is never published |
| `CANVA_REDIRECT_URI` | `https://api.averages.io/canva/callback` |
| `CANVA_EXPORT_ENABLED`, `CANVA_FOLDERS_ENABLED` | `"1"` only once Canva has approved those scopes. Asking for an unapproved scope breaks Connect |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | Notifications: the public VAPID key, and a contact (default `mailto:help@averages.io`) |
| `STRIPE_PRICE_LOOKUP_KEY` | The Plus price's lookup key (default `plus_monthly`) |
| `FULLSCREEN_PUBLIC`, `FULLSCREEN_SCHOOLS` | `"1"`: everyone sees Fullscreen. `"0"`: only testers and the listed school addresses |
| `FEATURES_ON`, `FEATURES_OFF`, `FEATURES_EARLY` | Switch keys to turn on, off, or on for Plus members only, without Flagship |
| `MAINTENANCE_MESSAGE` | The banner text while `maintenance-banner` is on (300 characters max) |
| `CANVA_PERMISSION_PROBE` | `"1"` only while running the developer Canva probe (`POST /canva/probe`). Otherwise `"0"` |

## Feature switches

Flagship (the `FLAGS` binding) is read on every request. If it's slow (400 ms) or
errors, the defaults and `FEATURES_*` decide. Keys must match exactly, all lowercase:

`canva-integration`, `onedrive-integration`, `drive-integration`, `schoology-signin`,
`test-signin`, `maintenance-banner`, `turnin-feature`, `messaging-features`,
`notifications-features`, `billing`, `calendar-sync`, `live-grades`, `fullscreen`,
`schoology-oauth`.

All of them are on by default except `maintenance-banner` and `billing`. When a switch
is off, its routes answer 503 `feature_off` and `/config/features` tells the app to
hide it. Flagship's `early-access` string flag lists keys that are on for Plus members
only.

**Outage banner:** with `maintenance-banner` on, the banner shows that message. With it
off, the 15-minute check (`*/15 * * * *` cron, `HealthStore`) shows a banner by itself
when Schoology, sign-in, a connection or one of our own stores is down. `/status` reads
`unknown` until the first check after a deploy.

## One-time setup

**Google Drive and OneDrive.**

- Register `https://api.averages.io/cloud/gdrive/callback` (Google: Authorized
  redirect URIs) and `https://api.averages.io/cloud/onedrive/callback` (Entra:
  **Add a platform > Web**).
- Google's consent screen must be **In production**. In Testing, refresh tokens expire
  after 7 days.
- For `wrangler dev`, also register the `http://localhost:8787/...` versions.

**Averages Plus (Stripe).** Sandbox first, then live with live keys.

1. Set up the product **Averages Plus** (tax code `txcd_10103000`) with a monthly price:
   lookup key `plus_monthly`, tax behavior **Exclusive** (tax is added on top). Turn on
   Managed Payments.
2. Add a webhook `https://api.averages.io/stripe/webhook` for
   `checkout.session.completed` and `customer.subscription.created`, `.updated` and
   `.deleted`. Its signing secret is `STRIPE_WEBHOOK_SECRET`.
3. In the customer portal, allow cancelling and changing the card. The return link is
   `https://app.averages.io/settings`.
4. Turn on `billing`. Test through the app with card `4242 4242 4242 4242`.
   Subscriptions made by hand in the dashboard don't use Managed Payments.

To change the price, make a new Price in Stripe and move the `plus_monthly` lookup key
to it. Nothing in this repo changes.
