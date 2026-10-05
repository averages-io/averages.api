# averages.api

The API behind [Averages.io](https://averages.io), a student-built companion app for your
school's learning platform. It is a Cloudflare Worker written in TypeScript with
[Hono](https://hono.dev).

The app never talks to Schoology directly. Every Schoology request has to be signed
with OAuth, and the secret that signs it can never be handed to browser code. So the
browser talks to this Worker, and only this Worker talks to Schoology.

> **Naming:** the product is Averages.io. The Worker is `averages-api` and answers on
> `api.averages.io`, for the app at `app.averages.io` (moved from `schoolagy.io` on
> 2026-10-05). Code that talks to Schoology may still say Schoolagy internally: the
> session cookie is still named `schoolagy_session` and the app's storage keys are still
> `schoolagy_*`. Don't rename those, or existing users lose their sessions and settings.

---

## What it does today

| Part | Status |
|---|---|
| Sign in with a personal Schoology API key | Live |
| Demo account (`demo` / `demo`) | Live |
| `/data/bundle`: courses, grades, assignments and messages, already shaped for the app | Live |
| Sync Across Devices | Live, stored only in the US (one Durable Object per student) |
| Sign in through Schoology's App Center ("appAuth") | Planned, needed before public launch |
| Google Classroom | Planned. OAuth client is set up; no code yet |
| Canva | Built and tested, not yet merged into this repo |
| Rate limiting | Planned |

## How sign-in works

**Today: personal API keys.** A student creates their own key and secret on their
school's Schoology `/api` page and signs in with them. The Worker checks them by
calling Schoology as that student, so a typo fails at the login screen instead of
producing an empty app. Requests use two-legged OAuth 1.0a: the key and the account
are the same person, so no admin or App Center approval is involved. Schoology
expires these keys after 90 days.

**Next: appAuth.** Students sign in on Schoology's own page and approve Averages.io,
instead of pasting a key. `oauth.ts` already accepts a token and token secret so the
signing code carries over unchanged.

## Sessions

After sign-in the Worker seals `{key, secret, uid}` with AES-GCM using
`SESSION_SECRET` and sends it back as a cookie:

- **httpOnly:** no JavaScript, including the app's own, can read it.
- **Secure, SameSite=Lax**, on `.averages.io`, valid for 30 days.
- **Sealed:** the token is unreadable and can't be edited even if it leaks.

The Worker keeps no copy. The tradeoff is that a session can't be cancelled early
from the server; it lasts until it expires or the student signs out.

## What gets stored

- **Grades and schoolwork are never stored.** They pass through the Worker to the
  browser on each request.
- **Sync Across Devices** (off by default) stores one record per student, keyed by
  their Schoology user ID: their Averages.io settings (name, photo, background,
  colors, course nicknames) and, only if the Weekly Grade Summary email is also on,
  at most two Projected GPA numbers (this week's and last week's). Turning sync off
  deletes the record. Each student's record lives in their own Durable Object,
  created in Cloudflare's `us` jurisdiction, so it is stored and handled only in
  the United States. (It used Workers KV until 2026-10-04; KV copies data
  worldwide, so it was replaced.)
- **Nothing else.** No analytics, no tracking, no ads.

## Endpoints

| Method | Path | Sign-in | What it does |
|---|---|---|---|
| `GET` | `/` | | Health and setup check. Says whether `SESSION_SECRET` reaches the running Worker, never any part of it |
| `POST` | `/auth/session` | | Sign in with `{key, secret}`; sets the session cookie |
| `DELETE` | `/auth/session` | | Sign out; clears the cookie |
| `GET` | `/auth/me` | yes | The signed-in student |
| `GET` | `/data/bundle` | yes | Everything the app's pages show, in one call |
| `GET` | `/sync/settings` | yes | Read the synced settings |
| `PUT` | `/sync/settings` | yes | Save the synced settings (2 MB max) |
| `DELETE` | `/sync/settings` | yes | Delete everything sync stored |

Demo sessions get `403 not_available_in_demo` on the sync routes.

`/data/bundle` is one call on purpose: Schoology is slow and rate-limited, and
sections, grades and assignments depend on each other. Every Schoology call gives up
after 20 seconds.

**There is no general Schoology passthrough.** An earlier `GET /schoology/*` route
could relay any read from a student's account and was removed on 2026-09-15. Each new
feature gets its own route with its own fixed Schoology calls.

## Security notes

- **CORS** only allows `https://app.averages.io` and `https://averages.io`.
  `http://localhost:3000` is allowed only when the Worker itself is running locally.
- **No secrets in the repo.** Everything secret is a Cloudflare secret (below).
- **Found a security problem?** Please email help@averages.io instead of opening a
  public issue.

## Configuration

**Secrets** (Worker → Settings → Variables and Secrets, type *Secret*, or
`npx wrangler secret put NAME`):

| Name | Used for |
|---|---|
| `SESSION_SECRET` | Seals session cookies. Required: without it sign-in returns 500 on purpose |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Classroom sign-in (planned) |
| `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET` | Canva (planned) |

Make a `SESSION_SECRET` with:
`node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`

**Variables** (in `wrangler.jsonc`, not secret):

| Name | Value |
|---|---|
| `GOOGLE_REDIRECT_URI` | `https://api.averages.io/auth/google/callback` |
| `CANVA_REDIRECT_URI` | `https://api.averages.io/canva/callback` |

Values entered under **Build** variables don't reach the running Worker. Use the
runtime ones. If sign-in returns 500, open `/` on the Worker: it says whether
`SESSION_SECRET` is set.

**Local development:** put the same names in a `.dev.vars` file (already in
`.gitignore`) and point the redirect addresses at `http://localhost:8787/...`.
Cloudflare's local runtime can't pin Durable Objects to the US, so on
`localhost` (and only there) sync storage is opened without the `us` setting.

## Development

```bash
npm install
npm test          # OAuth signing, sessions, data adapters, sync
npm run dev       # local Worker on http://localhost:8787
```

Cloudflare Workers Builds deploys `main` automatically: `npm run build`
(a TypeScript check) and then `npx wrangler deploy`.

## Tests

No test framework and no build step: the modules run directly under Node's
TypeScript support.

- **OAuth signing** is checked against the published OAuth 1.0 test vector
  (RFC 5849, Appendix A.5.1), base string and signature. A wrong signature shows up
  from Schoology as a bare `401` with no explanation, so it's pinned to a known-good
  answer.
- **Sessions:** the Schoology secret can't be read out of a token, edited or
  wrong-key tokens are rejected, and expired ones fail.
- **Adapters** run against realistic Schoology responses, including its quirks:
  single results sent as a bare object instead of a list, two timestamp formats, and
  excused work that must not pull a grade trend down.
- **Sync:** records stay separate per student, the GPA snapshot never holds more
  than two numbers, and the weekly email switch is read correctly.

The keys and secrets in the test files are the public example values from the
OAuth spec and made-up strings, not real credentials.

---

## License

**GNU General Public License v3.0.** See [LICENSE](LICENSE).

You're free to use, study, change and share this code. If you give out a changed
version, you have to share its source under the same license.

## Trademarks and affiliation

Averages.io is an independent app made by a student. It is **not affiliated with,
endorsed by, or sponsored by PowerSchool, Schoology, Google or Canva.** Schoology is
a trademark of PowerSchool Group LLC; Google Classroom is a trademark of Google LLC;
Canva is a trademark of Canva Pty Ltd. They are named here only to describe the
services this code connects to.

The license covers the code, not the Averages.io name, logo or look. Forks are
welcome under their own name.
