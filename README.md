# averages.api

The API behind [Averages.io](https://averages.io), a student-built companion app for your
school's learning platform. It is a Cloudflare Worker written in TypeScript with
[Hono](https://hono.dev).

The app never talks to Schoology or Google Classroom directly. Every Schoology request
has to be signed with OAuth, and the secrets behind both sign-ins can never be handed to
browser code. So the browser talks to this Worker, and only this Worker talks to
Schoology and Classroom.

> **Naming:** the product is Averages.io. The Worker is `averages-api` and answers on
> `api.averages.io`, for the app at `app.averages.io` (moved from `schoolagy.io` on
> 2026-10-05). Everything else was renamed to Averages on 2026-10-05, except the
> session cookie (`schoolagy_session`) and the app's storage keys (`schoolagy_*`). Don't
> rename those, or existing users lose their sessions and settings.

---

## What it does today

| Part | Status |
|---|---|
| Sign in with a personal Schoology API key | Live |
| Demo account (`demo` / `demo`) | Live |
| `/data/bundle`: courses, grades, assignments and messages, already shaped for the app | Live |
| Sync Across Devices | Live, stored only in the US (one Durable Object per student) |
| Sign in through Schoology's App Center ("appAuth") | Planned, needed before public launch |
| Sign in with Google, for Google Classroom: classes, grades, coursework, announcements, class files (Drive links) | Built (2026-10-05). Read-only; nothing stored. Turning in happens on Classroom itself |
| Canva: connect, Edit in Canva, Drafts, designs list | Built (2026-10-05), stored only in the US. Canva approved the integration (2026-10-05), so any student can connect |
| Assignment details and attachment downloads | Built (2026-10-05) |
| Course files (`/data/files`): every class's Materials documents and assignment attachments | Built (2026-10-05) |
| Google Drive and OneDrive | Built (2026-10-05), entirely in the student's browser; the Worker only serves public app IDs |
| Rate limiting | Planned |

## How sign-in works

**Today: personal API keys.** A student creates their own key and secret on their
school's Schoology `/api` page and signs in with them. The Worker checks them by
calling Schoology as that student, so a typo fails at the login screen instead of
producing an empty app. Requests use two-legged OAuth 1.0a: the key and the account
are the same person, so no admin or App Center approval is involved. Schoology
expires these keys after 90 days.

**Google Classroom (2026-10-05).** "Continue with Google" sends the browser to
`/auth/google/start`, which sends it on to Google's consent screen with a random
`state` and a PKCE challenge (both kept in a sealed 10-minute cookie only
`/auth/google` sees). Google sends it back to `/auth/google/callback`; the state must
match that cookie, the code is traded for tokens with the client secret, and the
permissions the student actually ticked are checked (classes and coursework are
required; announcements and class materials are optional). The tokens are sealed into
the same session cookie as a Schoology sign-in, and the browser goes back to the login
page with `?google=ok` (or `cancelled`, `permissions`, `expired`, `failed`,
`unavailable`). All Classroom permissions are read-only:
`classroom.courses.readonly`, `classroom.coursework.me.readonly`,
`classroom.courseworkmaterials.readonly`, `classroom.announcements.readonly`, plus
`openid email profile`.

Classroom's API only lets an app turn in work that the same app created, so students
turn work in on Classroom; the app shows the status and links there.

**Next: appAuth.** Students sign in on Schoology's own page and approve Averages.io,
instead of pasting a key. `oauth.ts` already accepts a token and token secret so the
signing code carries over unchanged.

## Sessions

After sign-in the Worker seals `{key, secret, uid}` (or, for Google, the account id
plus the Google access and refresh tokens, name, email and picture; the Schoology key
and secret are then always blank) with AES-GCM using `SESSION_SECRET` and sends it back
as a cookie:

- **httpOnly:** no JavaScript, including the app's own, can read it.
- **Secure, SameSite=Lax**, on `.averages.io`, valid for 30 days.
- **Sealed:** the token is unreadable and can't be edited even if it leaks.

The Worker keeps no copy. The tradeoff is that a session can't be cancelled early
from the server; it lasts until it expires or the student signs out.

A Google access token lasts an hour. After that the Worker gets a new one with the
refresh token and keeps it in a second sealed cookie, `averages_google_access`
(httpOnly, host-only on `api.averages.io`, an hour), tied to that one session. The
session cookie itself is never rewritten, so a session still ends 30 days after sign-in,
and a request that was refreshing while the student signed out can't sign them back in.
If the student removes Averages.io's access in their Google account, the next request
signs them out.

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
- **Canva** (only if the student connects it): their Canva access and refresh
  tokens, encrypted with a key derived from `SESSION_SECRET` and tied to their
  user ID; their Canva display name; their Drafts list (which assignment file
  became which Canva design); and, for a day at most, where to send them back
  when they click Return in Canva. One Durable Object per student, in the `us`
  jurisdiction, separate from Sync (turning Sync off doesn't disconnect Canva).
  Disconnect deletes all of it. Their designs live in their own Canva account;
  attachment files pass through the Worker on their way to Canva and aren't kept.
- **Google Classroom: nothing.** Classes, coursework, grades and announcements are
  read with the student's own token on each request and passed to the browser.
  Class files stay in Google Drive: the app gets their Drive links, and nothing is
  downloaded through the Worker.
- **Google Drive and OneDrive: nothing.** Both connect straight from the
  student's browser to Google or Microsoft. Their tokens stay in that browser tab
  and never reach this Worker; the Worker only serves the public app IDs
  (`/config/cloud`) and the assignment files being copied (`/data/attachment`).
- **Nothing else.** No analytics, no tracking, no ads.

## Endpoints

| Method | Path | Sign-in | What it does |
|---|---|---|---|
| `GET` | `/` | | Health and setup check. Says whether `SESSION_SECRET` reaches the running Worker, never any part of it |
| `POST` | `/auth/session` | | Sign in with `{key, secret}`; sets the session cookie |
| `DELETE` | `/auth/session` | | Sign out; clears the cookie |
| `GET` | `/auth/google/start?under13=` | | Sign in with Google (browser navigation): sets the 10-minute state cookie and sends the browser to Google. `under13` is the login page's 13+ box; anything but `0` seals Incognito in |
| `GET` | `/auth/google/callback` | | Where Google sends the student back; sets the session cookie and returns to the login page with `?google=<outcome>` |
| `GET` | `/auth/me` | yes | The signed-in student (`provider`: `schoology` or `google`) |
| `GET` | `/data/bundle?tz=` | yes | Everything the app's pages show, in one call. For Google Classroom, `tz` (the device's time zone) puts UTC due dates on the right day, and the bundle also carries `platform: "classroom"`, `SUBMITTED`, `RECENT_GRADES`, `COURSE_UPDATES` (announcements) and `GRADEBOOK` |
| `GET` | `/sync/settings` | yes | Read the synced settings |
| `PUT` | `/sync/settings` | yes | Save the synced settings (2 MB max) |
| `DELETE` | `/sync/settings` | yes | Delete everything sync stored |
| `GET` | `/data/assignment?section=&id=` | yes | One assignment's description and attachments (file ids and names only, never download links). Classroom: materials as links (Drive, YouTube, Forms, web), the student's submission state and grade, and the Classroom link to turn it in |
| `GET` | `/data/attachment?section=&assignment=&file=` | yes | Download one attachment, streamed from Schoology. `document=` instead of `assignment=` for a file a teacher posted in Materials |
| `GET` | `/data/files` | yes | Every file in the student's classes (Materials documents and assignment attachments): ids, names, class, newest first, `partial: true` if a class didn't answer. No download paths. Classroom: the Google Drive files posted in class materials and assignments, with their Drive links |
| `GET` | `/canva/status` | yes | Whether Canva is set up and connected, and the account name |
| `GET` | `/canva/connect?return_to=` | yes | Starts connecting Canva (browser navigation) |
| `GET` | `/canva/callback` | yes | Where Canva sends the student back after they allow access |
| `DELETE` | `/canva/connection` | yes | Disconnect: forgets the tokens and drafts |
| `POST` | `/canva/edit` | yes | `{section, assignment, fileId, returnTo}`: imports that attachment into the student's Canva, adds a draft, answers with the editor link |
| `GET` | `/canva/return` | yes | Where Canva's Return button lands; sends the student back to the page they came from |
| `GET` | `/canva/drafts?section=&assignment=` | yes | That assignment's drafts |
| `DELETE` | `/canva/drafts/:id` | yes | Removes a draft from Averages.io (the design stays in Canva) |
| `POST` | `/canva/designs/:id/open` | yes | A fresh editor link with a Return key |
| `GET` | `/canva/designs` | yes | The student's Canva designs, newest first, 50 a page |
| `GET` | `/config/cloud` | | Public IDs the app needs to connect Google Drive and OneDrive in the browser (`null` for anything not set up) |

Demo sessions get `403 not_available_in_demo` on the sync, assignment and Canva routes.
Google sessions get `404 classroom_files_open_in_drive` from `/data/attachment` and
`403 classroom_not_supported` from `/canva/edit` (their files are in Google Drive).

`/data/bundle` is one call on purpose: Schoology is slow and rate-limited, and
sections, grades and assignments depend on each other. Every Schoology call gives up
after 20 seconds.

For Classroom it reads up to 12 classes: each class's coursework, the student's own
submissions and recent announcements, with `fields=` so only what's needed comes back.
Cloudflare's Free plan allows 50 outside calls per request, so Classroom calls are
capped at 42: every class's first page comes first, then more pages while calls are
left (`partial: true` when something was cut). Work whose submission didn't arrive is
never called missing. A teacher who hides the overall grade in Classroom hides it here
too; weighted categories are averaged the way Classroom does it.

**There is no general Schoology passthrough.** An earlier `GET /schoology/*` route
could relay any read from a student's account and was removed on 2026-09-15. Each new
feature gets its own route with its own fixed Schoology calls.

## Security notes

- **CORS** only allows `https://app.averages.io` and `https://averages.io`.
  `http://localhost:3000` is allowed only when the Worker itself is running locally.
- **No secrets in the repo.** Everything secret is a Cloudflare secret (below).
- **Attachments:** the browser only ever sends ids. The Worker looks the file up on
  that student's own assignment (or Materials document), signs the request only for `api.schoology.com`,
  follows Schoology's redirect to its file storage itself (https only, without the
  signature), and refuses files over 25 MB for Canva.
- **Canva:** PKCE with the state kept in the student's own Durable Object and used
  once; tokens encrypted at rest; refreshes can't race (one object per student);
  the Return JWT's Ed25519 signature, audience, type and expiry are checked; every
  redirect goes to a fixed app origin plus a checked path. POSTs must be JSON from an
  allowed Origin, so another page can't trigger them.
- **Google sign-in:** the state is 256 bits, sealed in its own cookie under a
  different key from sessions, compared in constant time and used once; PKCE (S256)
  on top; the callback URL is pinned; every redirect goes to the fixed app origin
  with a fixed outcome word, with `Referrer-Policy: no-referrer`. The ID token comes
  straight from Google's token endpoint over HTTPS, so (as OpenID Connect allows) its
  signature isn't re-checked, but issuer, audience and expiry are. Classroom ids are
  digits only before they reach a URL, and only http(s) links (Classroom links only
  for "Turn in") reach the app.
- **`/config/cloud`** only serves values that look like the public ID they're
  meant to be (a Google client ID, an `AIza…` API key, a project number, a
  Microsoft GUID). If a secret were ever pasted into one of those boxes, it's left
  out instead of published.
- **Found a security problem?** Please email help@averages.io instead of opening a
  public issue.

## Configuration

**Secrets** (Worker → Settings → Variables and Secrets, type *Secret*, or
`npx wrangler secret put NAME`):

| Name | Used for |
|---|---|
| `SESSION_SECRET` | Seals session cookies. Required: without it sign-in returns 500 on purpose |
| `GOOGLE_CLIENT_SECRET` | Sign in with Google (Google Classroom). Without it the Google button says sign-in isn't switched on yet |
| `CANVA_CLIENT_SECRET` | Canva Connect app secret (Developer Portal). Without it Canva reports "not set up" |
| `GOOGLE_PICKER_API_KEY` | Google Cloud API key for "Add from Google Drive". **Must** be restricted to `https://app.averages.io/*` and the Google Picker API: it's served publicly, and `/config/cloud` can't tell a restricted key from an unrestricted one |
| `GOOGLE_PROJECT_NUMBER` | Optional. The Google Cloud project number the Picker needs; without it, the number at the start of `GOOGLE_CLIENT_ID` is used |

Make a `SESSION_SECRET` with:
`node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`

**Variables** (in `wrangler.jsonc`, not secret):

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | The Google OAuth client: Sign in with Google (Classroom) and Google Drive in the browser |
| `CANVA_CLIENT_ID` | The Canva Connect integration's client ID |
| `GOOGLE_REDIRECT_URI` | `https://api.averages.io/auth/google/callback` |
| `CANVA_REDIRECT_URI` | `https://api.averages.io/canva/callback` |
| `MS_CLIENT_ID` | The Microsoft Entra app's Application (client) ID, for OneDrive. A public ID, no client secret (it's a single-page app registration) |
| `GOOGLE_DRIVE_CLIENT_ID` | Optional. A separate Google OAuth client (same Google Cloud project) used only for Google Drive in the browser; its only setting is the JavaScript origin `https://app.averages.io`. Without it, Google Drive uses `GOOGLE_CLIENT_ID` |

`keep_vars` is on, so a variable added only in the dashboard survives deploys; one that's
also in `wrangler.jsonc` takes the file's value.

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
npm test          # OAuth signing, sessions, data adapters, sync, Canva, cloud config, course files, Google Classroom
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
- **Canva:** PKCE against the RFC 7636 test vector, forged and reused states
  (including names like `constructor`), sealed tokens that only open for their own
  student, one refresh for many simultaneous requests, Disconnect beating a refresh
  in flight, Return JWTs (bad signature, audience, type, expiry, unknown key), import
  polling and Canva's error codes, and attachment downloads (no signature sent off
  Schoology, size cap, no http redirects).
- **Course files:** both of Schoology's attachment shapes, extensions kept on names,
  non-numeric ids skipped, no download paths in the answer, the 1,000-file cap, and
  `partial` when a class didn't answer.
- **Cloud config:** `/config/cloud` serves IDs in the right shapes and leaves out
  anything that looks like a secret pasted into the wrong box.
- **Google Classroom** (`classroom.test.ts`): due dates in the student's time zone
  (including half-hour zones), total-points and weighted grades (empty categories
  left out, uncategorized work not counted, hidden overall grades), Missing only when
  the submission is known, announcements, recent grades, the gradebook, materials as
  safe links, Drive files, and the sign-in helpers (granted scopes, ID token checks).
- **Google sign-in routes** (`google.test.ts`) run the real Worker in Node with
  Google faked (`test/cf-loader.mjs` stands in for `cloudflare:workers`): state and
  PKCE, cancelled/expired/forged sign-ins, missing permissions, under-13 Incognito,
  the session's contents, token refresh into its own cookie, revoked access, Classroom
  errors, Schoology-only routes refusing a Google session, forged sessions, and the
  42-call budget.

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
