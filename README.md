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
| Per-page extras (`/data/people`, `/data/updates`, `/data/events`, `/data/folders`, `/data/gradebook`) and Schoology messages (read, send, reply) | Built (2026-10-06) |
| Browser notifications (`/push/*`) | Built (2026-10-05), wired in 2026-10-06; switched on once `PUSH_SECRET` and the VAPID keys are set |
| Rate limiting | Built (2026-10-06): per student and per IP, counted in memory and (2026-10-07) by Cloudflare's Rate Limiting bindings in `wrangler.jsonc` |

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
`classroom.courseworkmaterials.readonly`, `classroom.announcements.readonly`,
`classroom.rosters.readonly` (teachers' names, 2026-10-06) and
`classroom.topics.readonly` (topics as folders in Materials, 2026-10-06), plus
`openid email profile`. Only courses and coursework are required. The permissions a
student granted are sealed into their session at sign-in, so a student who signed in
before rosters and topics were added gets them by signing in again; until then those
extras answer empty with `needsPermission: true`.

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
  colors, course nicknames). Turning sync off deletes the record. (Until 2026-10-06
  it could also hold two Projected GPA numbers for the Weekly Grade Summary email,
  which browser notifications replaced; an old record drops them on its next save.) Each student's record lives in their own Durable Object,
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
- **Browser notifications** (only if the student turns them on): up to 5 browsers'
  push subscriptions, which kinds of notification are on, their sign-in sealed with
  `PUSH_SECRET` (expiring with the session), and a snapshot of short keyed hashes to
  tell what changed. One Durable Object per student, in the `us` jurisdiction.
  Turning notifications off, or signing out, deletes all of it.
- **Google Classroom: nothing.** Classes, coursework, grades and announcements are
  read with the student's own token on each request and passed to the browser.
  Class files stay in Google Drive: the app gets their Drive links, and nothing is
  downloaded through the Worker.
- **Google Drive and OneDrive: nothing.** Both connect straight from the
  student's browser to Google or Microsoft. Their tokens stay in that browser tab
  and never reach this Worker; the Worker only serves the public app IDs
  (`/config/cloud`) and the assignment files being copied (`/data/attachment`).
- **School applications** (from school staff, not students): the school's name, its
  Canvas address, the contact email and anything they typed, at most 500, in one US
  Durable Object; plus when each address that wrote to schools@averages.io last got the
  automatic reply (30 days).
- **Nothing else.** No analytics, no tracking, no ads.

## Endpoints

| Method | Path | Sign-in | What it does |
|---|---|---|---|
| `GET` | `/` | | Health and setup check. Says whether `SESSION_SECRET` reaches the running Worker, never any part of it |
| `POST` | `/auth/session` | | Sign in with `{key, secret}`; sets the session cookie |
| `DELETE` | `/auth/session` | | Sign out; clears the cookie and deletes the student's notification subscriptions and stored sign-in |
| `GET` | `/auth/google/start?under13=` | | Sign in with Google (browser navigation): sets the 10-minute state cookie and sends the browser to Google. `under13` is the login page's 13+ box; anything but `0` seals Incognito in |
| `GET` | `/auth/google/callback` | | Where Google sends the student back; sets the session cookie and returns to the login page with `?google=<outcome>` |
| `GET` | `/auth/me` | yes | The signed-in student (`provider`: `schoology` or `google`) |
| `GET` | `/data/bundle?tz=` | yes | Everything the app's pages show, in one call: classes (with `code`, `period`, `section`, `teacher`), grades, assignments, Home's messages, `RECENT_GRADES` and each class's `GRADEBOOK`. For Google Classroom, `tz` (the device's time zone) puts UTC due dates on the right day, and the bundle also carries `platform: "classroom"`, `SUBMITTED` and `COURSE_UPDATES` (announcements) |
| `GET` | `/data/people` | yes | The student's teachers: `TEACHERS`, `CONTACTS`, `courseTeachers`. Schoology: each class's admins (never students). Classroom: needs the rosters permission (`needsPermission` otherwise) |
| `GET` | `/data/updates` | yes | Teachers' posts in each class, newest first (Schoology; Classroom's are in the bundle) |
| `GET` | `/data/events?start=&end=&course=` | yes | Calendar events in a range of at most 400 days (`YYYY-MM-DD`), optionally one class's |
| `GET` | `/data/folders?course=` | yes | A class's folders and which items sit in them (Schoology folders; Classroom topics, with the topics permission) |
| `GET` | `/data/gradebook?course=` | yes | One class's grading categories with exact weights (Schoology; Classroom's bundle is exact already) |
| `GET` | `/messages` | yes | Schoology inbox and sent threads, merged, newest first, with names |
| `GET` | `/messages/thread?id=` | yes | One thread, oldest message first (marks it read on Schoology) |
| `GET` | `/messages/recipients` | yes | The people the student can message |
| `POST` | `/messages` | yes | `{recipientIds, subject, message}`: a new message, only to people `/messages/recipients` lists |
| `POST` | `/messages/reply` | yes | `{id, message}`: a reply to the thread's own participants |
| `GET` | `/push/config` | | The notification public key (`null` until set up) |
| `POST`, `PUT`, `DELETE` | `/push/...` | yes | Turn browser notifications on or off, choose kinds, send a test (see `src/push.ts`) |
| `GET` | `/sync/settings` | yes | Read the synced settings |
| `PUT` | `/sync/settings` | yes | Save the synced settings (2 MB max) |
| `DELETE` | `/sync/settings` | yes | Delete everything sync stored |
| `GET` | `/data/assignment?section=&id=` | yes | One assignment's description and attachments (file ids and names only, never download links). Classroom: materials as links (Drive, YouTube, Forms, web), the student's submission state and grade, and the Classroom link to turn it in |
| `GET` | `/data/assignment/locate?id=` | yes | Which class an assignment is in: `{section, title}` or 404. The app's links are `assignment?id=<id>` (2026-10-07); the assignment page asks this for work that isn't in the bundle. Every class is asked at once |
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
| `POST` | `/submit/upload` | yes | Turning in (Schoology): `{section, assignment, filename, filesize, md5}` starts an upload; answers with a sealed upload token (Schoology's upload address never reaches the browser) |
| `PUT` | `/submit/upload/:token` | yes | The file's bytes (95 MB max), streamed straight through to Schoology |
| `POST` | `/submit/file` | yes | `{section, assignment, fileIds}`: turns the uploaded files in |
| `POST` | `/submit/text` | yes | `{section, assignment, body}`: turns in a typed answer (HTML, cleaned to a short allow-list) |
| `GET` | `/submit/history?section=&assignment=` | yes | The student's own turn-ins for that assignment, newest first |
| `POST` | `/canva/designs/:id/export` | yes | Starts a PDF export of the student's design (to turn in). 409 `canva_reconnect_needed` until `CANVA_EXPORT_ENABLED` is `"1"` and the connection has the export permission |
| `GET` | `/canva/exports/:job` and `/canva/exports/:job/file?design=` | yes | The export's status, then the PDF itself (streamed) |
| `GET` | `/canva/folders/:id/items` | yes | A Canva folder's folders and designs for the Files page (`root` is the top of Projects), 100 a page. 409 `canva_reconnect_needed` until `CANVA_FOLDERS_ENABLED` is `"1"` and the connection has the folder permissions |
| `POST` | `/canva/folders`, `/canva/folders/:id/rename`, `/canva/folders/move` | yes | New folder `{name, parentId}`, rename `{name}`, move a design or folder `{itemId, toFolderId}`. No delete (Canva would put the contents in the Trash) |
| `GET` | `/config/apply` | no | What the school application page needs: `{turnstileSiteKey, emailEndings, verifyEmail}` (site key or `null`; allowed email endings, `[]` = any; whether the email must be verified with a code) |
| `GET` | `/config/schools?lms=schoology\|canvas` | | The schools the sign-in page lists (`src/schools.ts`) |
| `POST` | `/schools/apply/code` | | "Verify your email": `{email, turnstileToken?}` emails a 6-digit code from `no-reply@averages.io` (only when `SCHOOLS_VERIFY_EMAIL` is `"1"`). 3 per address per 10 minutes, 45 s apart; 5 per 10 minutes per network |
| `POST` | `/schools/apply/verify` | | `{email, code}` → `{ok, emailProof}` (2 hours). 5 tries per code, codes last 10 minutes; 20 per 10 minutes per network |
| `POST` | `/schools/apply` | | A school's application from `app.averages.io/schools/apply`: `{school, canvas, email, name?, note?, emailProof?}`. The email must end in one of `SCHOOLS_EMAIL_ENDINGS`, and carry an `emailProof` when verification is on. Saved, then emailed to Martin. 5 per 10 minutes per network |
| `GET` | `/schools/applications` | key | Every application, newest first. Needs `Authorization: Bearer <SCHOOLS_ADMIN_KEY>`; doesn't exist until that secret is set |

Demo sessions get `403 not_available_in_demo` on the sync, assignment, extras, messages,
notification and Canva routes. Messages are Schoology only: a Google session gets
`404 not_available`.

**Rate limits** (per minute): sign-in 30 per IP; `/data/*`, `/auth/me`, `/sync` and reading
messages 90 per student; sending messages 10; `/submit/*` 90; `/push/*` 20; `/canva/*` 30
(export polling 120, browsing folders 90); school applications 5 per 10 minutes per IP.
Counted twice: in memory per Worker copy, and by Cloudflare's Rate Limiting bindings
(`RATE_LIMIT_*` in `wrangler.jsonc`, shared per location; since 2026-10-07). Over the
limit: `429 {"error":"rate_limited"}` with `Retry-After`. Preflights, `GET /` and the
public config reads are never limited.
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
| `PUSH_SECRET` | Browser notifications: seals each student's stored sign-in. A new random value, never the same as `SESSION_SECRET` (notifications stay off if it is) |
| `VAPID_PRIVATE_JWK` | Browser notifications: the private half of the VAPID key pair, as JWK JSON text |
| `SCHOOLS_NOTIFY_TO` | Schools: the inbox that gets every email to schools@averages.io and every school application. Must be a verified destination in Email Routing. A secret so the address isn't in this public repo |
| `TURNSTILE_SECRET` | Schools: the secret key of the Cloudflare Turnstile widget on app.averages.io/schools/apply. With `TURNSTILE_SITE_KEY` set too, applications need a passed check |
| `SCHOOLS_ADMIN_KEY` | Schools: unlocks `GET /schools/applications`. A long random value (24+ characters) |

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
| `VAPID_PUBLIC_KEY` | Browser notifications: the public half of the VAPID key pair (base64url). In `wrangler.jsonc` under `vars` (since 2026-10-07); must pair with `VAPID_PRIVATE_JWK` |
| `VAPID_SUBJECT` | Optional. Contact for push services, default `mailto:help@averages.io` |
| `CANVA_EXPORT_ENABLED` | `"1"` once the `design:content:read` scope is enabled for the Canva integration (turning in Canva designs as PDFs). Leave `"0"` until then: asking Canva for a scope it hasn't approved breaks Connect |
| `TURNSTILE_SITE_KEY` | The Turnstile widget's site key (public; the apply page gets it from `GET /config/apply`). In `wrangler.jsonc` under `vars`, with `TURNSTILE_SECRET` as a secret; without both, there's no check |
| `SCHOOLS_EMAIL_ENDINGS` | In `wrangler.jsonc`: the email endings the school application accepts, comma-separated (`"edu,org,us,net"`; `us` covers `k12.ca.us` and the like). Empty = any |
| `SCHOOLS_VERIFY_EMAIL` | In `wrangler.jsonc`: `"1"` makes applicants verify their email with a 6-digit code. Turn on only after averages.io is onboarded for sending in Cloudflare Email Service (Compute > Email Service > Email Sending > Onboard Domain), which needs Workers Paid: before that, codes only reach verified addresses. Uses `SCHOOLS_MAIL` and `SESSION_SECRET` |
| `SCHOOLS_EMAIL_ALLOW` | Dashboard **secret** (not in this public repo): exact email addresses that may apply whatever their ending, comma-separated. Never shown by `GET /config/apply` |
| `REVIEW_KEY`, `REVIEW_SECRET` | Dashboard **secrets**, 16+ characters each (e.g. `openssl rand -hex 16`). Typed into the hidden API-key sign-in (`app.averages.io/?keys`), they open the reviewer account: six sample classes served by `src/reviewSandbox.ts` (a pretend Schoology inside the Worker, nothing sent to Schoology) in the app's normal live mode, so Canva, Google Drive, OneDrive, notifications and Sync all work. For app reviewers and testing. Unset = off |
| `CANVA_FOLDERS_ENABLED` | `"1"` once `folder:read` and `folder:write` are enabled (and approved) for the Canva integration: Connect asks for them and the Files page shows Canva folders. Leave `"0"` until then, for the same reason. Students connected before then see Reconnect |

### Schools email (schools@averages.io)

A student's Email Template (sign-in page, Canvas) asks their school's IT team to write to
schools@averages.io. The Worker's `email` handler sends `SCHOOLS_NOTIFY_TO` a copy of every message (from
schools@averages.io, with the sender's text inside, the original attached as
`original-email.eml` and Reply-To set to the sender; a plain forward when `SCHOOLS_MAIL`
isn't bound or the copy fails) and answers a school's first email (once per sender per 30 days, never
to auto-replies, bounces or mailing lists) with a formatted reply linking to
`app.averages.io/schools/apply`. To switch it on:

1. Cloudflare dashboard, averages.io, **Email > Email Routing**: enable it (it adds MX and
   SPF records; if averages.io already receives mail somewhere else, move those addresses
   into Email Routing first).
2. **Destination addresses**: add your inbox and click the link Cloudflare emails you.
3. **Routing rules > Custom address**: `schools@averages.io` → **Send to a Worker** →
   `averages-api`.
4. Set the secrets `SCHOOLS_NOTIFY_TO` (that inbox) and `SCHOOLS_ADMIN_KEY`.
5. Make sure the `send_email` block in `wrangler.jsonc` is on (it is since 2026-10-06) and
   deploy. The application emails and Martin's copies of school emails need it; the
   auto-reply doesn't.

Read the saved applications with
`curl -H "Authorization: Bearer $SCHOOLS_ADMIN_KEY" https://api.averages.io/schools/applications`.

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
npm test          # OAuth signing, sessions, adapters, sync, Canva, cloud config, files, Classroom, notifications, extras, messages, rate limits, routes
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
- **Sync:** records stay separate per student, and an old record's GPA snapshot
  (from the removed weekly email) is ignored on load and dropped on the next save.
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
- **Notifications** (`webpush.test.ts`, `push.test.ts`): Web Push encryption and VAPID
  signing, what counts as a change, the per-student store and its routes.
- **Extras and messages** (`extras.test.ts`, `messages.test.ts`): period parsing,
  recent grades and gradebooks, teachers from admin enrollments only, course updates,
  calendar events in both platforms, folders and topics, message threads, text both
  ways, and checking what the browser sends.
- **Rate limits** (`ratelimit.test.ts`) and **routes** (`routes.test.ts`, the real
  Worker with Schoology and Google faked): demo and Classroom answers, input checks,
  the recipient allow-list, replies going only to the thread's participants, no
  student names from rosters, at most 3 Schoology calls in flight, 429s, and sign-out
  deleting notification data.
- **Turning in** (`submit.test.ts`): Schoology's upload, attach and answer calls exactly
  as documented, the sealed upload token (tampered, expired, someone else's, wrong
  size), the PUT streamed through byte for byte, the OAuth header only ever sent to
  api.schoology.com, the answer cleaner (script, event handlers and `javascript:` links
  out; real editor output with `<div>` lines kept readable; a fuzz run), and Canva PDF
  exports (permission, ownership, download hosts, size cap). `canvastatus.test.ts`
  covers when Settings offers Reconnect.
- **Canva folders** (`canvaFolders.test.ts`): the switch and scopes, listing (images
  skipped, odd ids and paging tokens refused), new folder, rename and move with their
  Canva errors (in several folders, not allowed, busy), other-site and form posts
  refused, and `/canva/status`'s `folders`.
- **Schools** (`schools.test.ts`, `schoolsApply.test.ts`): the sign-in page's lists, the
  application's checks and spam trap, saving and duplicates, Martin's list behind its
  key, the email builder (no header injection, encoded subjects, both parts decode),
  and the schools@ handler: forwarded, answered once per sender, never to robots or
  mailing lists, and never throwing.

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
