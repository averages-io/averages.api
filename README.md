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
| What the student turned in (`/data/submissions`, `/data/submission-file`): the files in their own Schoology submissions, for the Files page | Built (2026-10-09). Schoology only (Classroom work is turned in on Classroom) |
| Google Drive and OneDrive | Built (2026-10-05) in the student's browser. Since 2026-10-08 they stay connected like Canva: the Worker signs in and keeps the refresh token (US only), the browser gets short-lived access tokens and still talks to Drive and Graph itself. Live once `MS_CLIENT_SECRET` is set and the callback addresses are registered (see "Google Drive and OneDrive" below) |
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
- **Secure, SameSite=Lax**, on `.averages.io`, valid for 15 days from sign-in (30 before 2026-10-30; those older sessions now end 15 days after their sign-in too).
- **Sealed:** the token is unreadable and can't be edited even if it leaks.

The Worker keeps no copy. The tradeoff is that a session can't be cancelled early
from the server; it lasts until it expires or the student signs out.

A Google access token lasts an hour. After that the Worker gets a new one with the
refresh token and keeps it in a second sealed cookie, `averages_google_access`
(httpOnly, host-only on `api.averages.io`, an hour), tied to that one session. The
session cookie itself is never rewritten, so a session still ends 15 days after sign-in,
and a request that was refreshing while the student signed out can't sign them back in.
If the student removes Averages.io's access in their Google account, the next request
signs them out.

## What gets stored

- **Grades and schoolwork are never stored.** They pass through the Worker to the
  browser on each request.
- **Averages Plus** (2026-10-21) stores one small record per subscriber, keyed by
  student ID, in the `BillingStore` Durable Object (US jurisdiction): their Stripe
  customer and subscription IDs, the subscription's status, when it renews, and the
  IDs of the last 30 Stripe events. No card details: Stripe holds those. Signing out,
  turning off Sync or switching to Incognito doesn't delete it, because the
  subscription is still running; cancelling in Manage plan is how it ends.
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
- **Google Drive and OneDrive** (only if the student connects one, since
  2026-10-08): per app, the refresh token, the current access token and when it
  expires, the permissions granted, the account's email and name, and when it was
  connected, all encrypted with a key derived from `SESSION_SECRET` and tied to
  their user ID and the app. One Durable Object per student, in the `us`
  jurisdiction, separate from Sync and Canva. Disconnect deletes it (and revokes
  Google's grant when Drive has its own OAuth client). Files never pass through the
  Worker: the browser calls Drive and Graph itself with the access tokens it's given.
  When Google or Microsoft refuses a connection's grant (the student removed
  Averages.io from their account), the tokens are deleted and only the account's
  email and name and when it happened are kept (encrypted the same way), so Settings
  can say it was disconnected; connecting again or pressing Disconnect deletes that
  too (2026-10-09).
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
| `GET` | `/auth/schoology/status` | | `{on}`: Sign in with Schoology is ready (the consumer secrets are set and `schoology-oauth` is on) |
| `GET` | `/auth/schoology/start` | | `?domain=<school's Schoology>&under13=0|1`. Gets a request token, keeps it in a sealed 15-minute cookie, and redirects to `https://<domain>/oauth/authorize`. Only `*.schoology.com` and the addresses in `src/schools.ts` (no open redirect) |
| `GET` | `/auth/schoology/callback` | | Schoology comes back here. The token must match this browser's cookie; it's swapped for an access token, `/users/me` says who it is, and the session cookie is set. Back to the app at `/?signin=schoology`, or `/?signin_error=<code>#schoology` |
| `GET` | `/data/classmates` | session | Each class's classmates: `{CLASSMATES: {section: [{id, name, photo}]}}`. Names and pictures only |
| `POST` | `/data/join` | session | Join a class with its access code `{code}` (Schoology `POST /sections/accesscode`). `{ok, section}`, or `not_joined` / `bad_code`. Our app only |
| `GET` | `/account/export` | session | Download your data: everything Averages.io keeps about the student, as a JSON file |
| `DELETE` | `/account` | session | Delete your account: synced settings, pictures, notifications, the calendar link and connected apps, then signs out. 409 `plus_active` while Plus is active. Our app only |
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
| `GET` | `/data/submissions` | yes | The files the student turned in on Schoology (2026-10-09): `{platform: "schoology", courses: [{id, name, color}], files: [{id, name, ext, size, course, assignment, assignmentTitle, revision, at, late}], partial}`. Their own revisions only, no drafts, newest first, at most 500. Reads the same 12 classes as `/data/files`, then the history of up to 60 assignments that take files (no quizzes, tests or discussions; not `allow_dropbox: "0"`), most recent first, 6 at a time, never more Schoology calls in all than 45 (the Free plan allows 50). `partial: true` when a class or history failed, or assignments were left unread. No download paths. Classroom: `{platform: "classroom", courses: [], files: [], partial: false}` |
| `GET` | `/data/submission-file?section=&assignment=&revision=&file=` | yes | Download one file the student turned in, streamed from Schoology like `/data/attachment` (same headers). Looked up again in their own history: 404 `not_found` when that revision or file isn't theirs |
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
| `GET` | `/config/cloud` | | Public IDs the app needs for Google Drive and OneDrive in the browser, including the Picker's key (`null` for anything not set up or switched off) |
| `GET` | `/config/features` | | Every feature switch (`features`: key → true/false) and `maintenance` (`{ message }` while the banner is on, else `null`). 30 s cache |
| `GET` | `/cloud/status` | yes | `{gdrive, onedrive}`, each `{configured, connected, lost, email, name, scopes}` (`incognito: true` and nothing connected in Incognito). `lost: true` (2026-10-09, with `connected: false`): the connection was dropped because Google or Microsoft refused it; `email` and `name` are the account that was connected, until the student connects again or presses Disconnect |
| `GET` | `/cloud/:app/connect?return_to=&read=1&login_hint=` | yes | `:app` is `gdrive` or `onedrive`. Starts connecting (browser navigation) and sends the student to Google or Microsoft. `read=1`: OneDrive also asks to read their files (`Files.Read`, kept on reconnects once given) |
| `GET` | `/cloud/:app/callback` | yes | Where Google or Microsoft sends the student back; returns to `return_to` with `?cloud=connected&app=:app` (or `cancelled`, `failed`, `drive_not_allowed`, `not_configured`, `incognito`) |
| `POST` | `/cloud/:app/token` | yes | JSON from our app: `{access_token, expires_in, email, scopes}`, the cached token while it has over 5 minutes left, otherwise refreshed. Body optional (`{}`); `{"refresh": true}` (2026-10-09, sent after Drive or Graph answers 401) refreshes even so, unless that connection was refreshed in the last 30 seconds (then the current token). 409 `cloud_not_connected` / `cloud_reconnect_needed` (the grant was revoked or expired; the connection is forgotten and `/cloud/status` says `lost`), 503 `cloud_not_configured`, 502 `cloud_unavailable`, 403 `incognito_mode`, 400 `invalid_body` |
| `DELETE` | `/cloud/:app/connection` | yes | Disconnect: forgets the tokens, and a lost connection's `lost` (allowed in Incognito) |
| `POST` | `/submit/upload` | yes | Turning in (Schoology): `{section, assignment, filename, filesize, md5}` starts an upload; answers with a sealed upload token (Schoology's upload address never reaches the browser) |
| `PUT` | `/submit/upload/:token` | yes | The file's bytes (95 MB max), streamed straight through to Schoology |
| `POST` | `/submit/file` | yes | `{section, assignment, fileIds}`: turns the uploaded files in |
| `POST` | `/submit/text` | yes | `{section, assignment, body}`: turns in a typed answer (HTML, cleaned to a short allow-list) |
| `GET` | `/submit/history?section=&assignment=` | yes | The student's own turn-ins for that assignment, newest first |
| `POST` | `/canva/designs/:id/export` | yes | Starts a PDF export of the student's design (to turn in). 409 `canva_reconnect_needed` until `CANVA_EXPORT_ENABLED` is `"1"` and the connection has the export permission |
| `GET` | `/canva/exports/:job` and `/canva/exports/:job/file?design=` | yes | The export's status, then the PDF itself (streamed) |
| `GET` | `/canva/folders/:id/items` | yes | A Canva folder's folders and designs for the Files page (`root` is the top of Projects), 100 a page. 409 `canva_reconnect_needed` until `CANVA_FOLDERS_ENABLED` is `"1"` and the connection has the folder permissions |
| `POST` | `/canva/folders`, `/canva/folders/:id/rename`, `/canva/folders/move` | yes | New folder `{name, parentId}`, rename `{name}`, move a design or folder `{itemId, toFolderId}`. No delete (Canva would put the contents in the Trash) |
| `POST` | `/canva/probe` | key | Developer-only Canva permission probe (temporary). `{key, write?}`. 404 unless `CANVA_PERMISSION_PROBE` is `"1"` and `REVIEW_SECRET` (or `SCHOOLS_ADMIN_KEY`) is set; 403 unless `key` matches one of them. See "Canva permission probe" below |
| `GET` | `/config/apply` | no | What the school application page needs: `{turnstileSiteKey, emailEndings, verifyEmail}` (site key or `null`; allowed email endings, `[]` = any; whether the email must be verified with a code) |
| `GET` | `/config/schools?lms=schoology\|canvas` | | The schools the sign-in page lists (`src/schools.ts`) |
| `POST` | `/schools/apply/code` | | "Verify your email": `{email, turnstileToken?}` emails a 6-digit code from `no-reply@averages.io` (only when `SCHOOLS_VERIFY_EMAIL` is `"1"`). 3 per address per 10 minutes, 45 s apart; 5 per 10 minutes per network |
| `POST` | `/schools/apply/verify` | | `{email, code}` → `{ok, emailProof}` (2 hours). 5 tries per code, codes last 10 minutes; 20 per 10 minutes per network |
| `POST` | `/schools/apply` | | A school's application from `app.averages.io/schools/apply`: `{school, canvas, email, name?, note?, emailProof?}`. The email must end in one of `SCHOOLS_EMAIL_ENDINGS`, and carry an `emailProof` when verification is on. Saved, then emailed to Martin. 5 per 10 minutes per network |
| `GET` | `/schools/applications` | key | Every application, newest first. Needs `Authorization: Bearer <SCHOOLS_ADMIN_KEY>`; doesn't exist until that secret is set |

Demo sessions get `403 not_available_in_demo` on the sync, assignment, extras, messages,
notification, Canva and `/cloud/*` routes. Messages are Schoology only: a Google session gets
`404 not_available`.

**Rate limits** (per minute): sign-in 30 per IP; `/data/*`, `/auth/me`, `/sync` and reading
messages 90 per student; sending messages 10; `/submit/*` 90; `/push/*` 20; `/canva/*` 30
(export polling 120, browsing folders 90); `/cloud/*` 60; school applications 5 per 10 minutes per IP.
Counted twice: in memory per Worker copy, and by Cloudflare's Rate Limiting bindings
(`RATE_LIMIT_*` in `wrangler.jsonc`, shared per location; since 2026-10-07). Over the
limit: `429 {"error":"rate_limited"}` with `Retry-After`. Preflights, `GET /` and the
public config reads are never limited.
Google sessions get `404 classroom_files_open_in_drive` from `/data/attachment` and `/data/submission-file`, and
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

### Averages Plus (Stripe, 2026-10-21)

| Route | What it does |
|---|---|
| `GET /billing/status` | `{ enabled, configured, eligible, plus, status, renewsAt, cancelAtPeriodEnd, manageable }` for the signed-in student. `enabled` is the `billing` switch; `eligible` is false for the demo and Incognito |
| `POST /billing/checkout` | `{}` → `{ url }`: a Stripe Checkout Session for the Plus price, with **Managed Payments** on (Stripe is the merchant of record and handles sales tax/VAT). 403 for the demo and Incognito (every under-13 session is Incognito), 409 if they already have Plus |
| `POST /billing/portal` | `{}` → `{ url }`: Stripe's customer portal (cancel, change card, invoices). Allowed in Incognito too, so nobody is stuck paying. 404 `billing_no_account` if they never subscribed |
| `POST /stripe/webhook` | Stripe's events, checked against `STRIPE_WEBHOOK_SECRET` (HMAC-SHA256, 5-minute tolerance) before anything is read. Uses `checkout.session.completed` and `customer.subscription.created/updated/deleted/paused/resumed`; answers 200 for anything else |

How it works (src/billing.ts):

- **Checkout** is `POST /v1/checkout/sessions` with `mode=subscription`, one line item
  (the price whose lookup key is `STRIPE_PRICE_LOOKUP_KEY`, default `plus_monthly`,
  looked up and cached for 10 minutes), `managed_payments[enabled]=true` and the
  header `Stripe-Version: 2026-02-25.preview`, which Managed Payments needs while it's
  in preview. Every other call uses the account's default API version. The student ID
  goes in the session's and the subscription's `metadata[uid]`, which is how the
  webhook knows whose it is. Back to `/settings?section=account&billing=success` (or
  `=cancelled`).
- **Who has Plus:** status `active`, `trialing` or `past_due` (Stripe is still
  retrying the card). Events can arrive out of order or twice: an older event never
  overwrites a newer one, a repeated event ID is ignored, and an old subscription
  ending never takes Plus away from a newer one.
- **Prices** live in Stripe, not here: change the amount or add currencies on the
  price in the dashboard and keep its lookup key.
- Stripe's error messages are never passed to the browser or logged (only its error
  type, code and parameter name).

### Plus perks (2026-10-21, src/plus.ts)

- **Browser notifications** need Plus while billing is on and set up (the `billing`
  switch, a Stripe key and the `BILLING` store). Turning on, testing and changing types
  answer 403 `plus_required` without it. A student without Plus who still has them on
  is turned off (everything deleted) by `POST /push/status` (which then says
  `turnedOff: "plus_required"`), `/push/touch` and the 20-minute check. With billing
  off, notifications are free as before. A BillingStore that can't be reached refuses
  turning on (503 `billing_unavailable`) but never turns anyone off.
- **Calendar sync** (src/calendar.ts) always needs Plus, and the `calendar-sync` switch:

  | Route | What it does |
  |---|---|
  | `GET /calendar/status` | `{ enabled, configured, eligible, plus, on, url, createdAt }` |
  | `POST /calendar` | `{ tz }` → `{ url, createdAt }`: a new private link (the old one stops working). 403 `plus_required` / `incognito_mode` |
  | `POST /calendar/touch` | keeps the stored sign-in in step with this session (the app, once a day) |
  | `DELETE /calendar` | the link and its stored sign-in, gone |
  | `GET /calendar/<token>.ics` | the calendar (no cookie): due dates 14 days back to 90 ahead, one all-day event each |

  The link's token is random (32 bytes); only its SHA-256 names the feed, and the token
  itself is kept sealed with `PUSH_SECRET` so Settings can show it again. The sign-in is
  sealed with `PUSH_SECRET` like notifications'. The calendar is never stored: a link is
  read from the school platform at most once every 10 minutes (429 with `Retry-After`
  otherwise). Plus ended or a sign-in that ran out give a calendar with one event saying
  what to do. Deleted by turning it off, signing out, switching to Incognito (the app
  calls `DELETE /calendar`) or Plus ending.
- **Early access**: switch keys in `FEATURES_EARLY` (a var) or Flagship's string flag
  `early-access` (comma-separated) are on for Plus members while off for everyone.
  `GET /config/features` lists them as `early`; for a Plus member their routes are open.
- **Plus ending** (Stripe's webhook going from Plus to not): notifications (while
  billing is on) and the calendar link are deleted right away.

**There is no general Schoology passthrough.** An earlier `GET /schoology/*` route
could relay any read from a student's account and was removed on 2026-09-15. Each new
feature gets its own route with its own fixed Schoology calls.

## Security notes

- **CORS** only allows `https://app.averages.io` and `https://averages.io`.
  `http://localhost:3000` is allowed only when the Worker itself is running locally.
- **No secrets in the repo.** Everything secret is a Cloudflare secret (below).
- **Attachments:** the browser only ever sends ids. The Worker looks the file up on
  that student's own assignment (or Materials document; for a file they turned in,
  `/data/submission-file`, 2026-10-09: their own submission revisions, by revision
  and file id), signs the request only for `api.schoology.com`,
  follows Schoology's redirect to its file storage itself (https only, without the
  signature), and refuses files over 25 MB for Canva.
- **Canva:** PKCE with the state kept in the student's own Durable Object and used
  once; tokens encrypted at rest; refreshes can't race (one object per student);
  the Return JWT's Ed25519 signature, audience, type and expiry are checked; every
  redirect goes to a fixed app origin plus a checked path. POSTs must be JSON from an
  allowed Origin, so another page can't trigger them.
- **Google Drive and OneDrive** (2026-10-08): the same PKCE-and-state pattern as Canva
  (state in the student's own Durable Object, 10 minutes, used once, tied to the app);
  the code is exchanged with the client secret on the Worker; Google must have granted
  `drive.file` and sent a refresh token, or nothing is kept (it also asks for `drive.install`,
  2026-10-09, which puts "Averages.io" in Drive's Open with menu; see the app's Files page); the id_token only labels the
  connection (decoded, audience checked: it comes straight from the token endpoint over
  TLS). `POST /cloud/:app/token` needs JSON from an allowed Origin. Refreshes are one at a
  time per student, and Microsoft's rotated refresh token is saved before the access token
  is handed out. A refresh the browser asks for (`{"refresh": true}`, 2026-10-09) happens
  at most once per 30 seconds per connection, so a page that keeps getting 401 can't
  make the Worker hammer Google or Microsoft; a refused grant ends the connection
  (409 `cloud_reconnect_needed`) instead of handing out the same dead token again. Every call to Google or Microsoft gives up after 15 seconds, and errors
  carry our own short codes, never a token or a provider's message.
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
| `GOOGLE_PICKER_API_KEY` | **No longer used** (2026-10-09): the Google Picker was removed. Safe to delete from the dashboard. `/config/cloud` still reports it if set. |
| `GOOGLE_PROJECT_NUMBER` | **No longer used** (it was for the Google Picker). |
| `PUSH_SECRET` | Browser notifications: seals each student's stored sign-in. A new random value, never the same as `SESSION_SECRET` (notifications stay off if it is) |
| `VAPID_PRIVATE_JWK` | Browser notifications: the private half of the VAPID key pair, as JWK JSON text |
| `SCHOOLS_NOTIFY_TO` | Schools: the inbox that gets every email to schools@averages.io and every school application. Must be a verified destination in Email Routing. A secret so the address isn't in this public repo |
| `TURNSTILE_SECRET` | Schools: the secret key of the Cloudflare Turnstile widget on app.averages.io/schools/apply. With `TURNSTILE_SITE_KEY` set too, applications need a passed check |
| `SCHOOLS_ADMIN_KEY` | Schools: unlocks `GET /schools/applications`. A long random value (24+ characters) |
| `MS_CLIENT_SECRET` | OneDrive staying connected (2026-10-08): a client secret of the Entra app (`MS_CLIENT_ID`), from its **Web** platform. Without it OneDrive reports `configured: false`. Entra secrets expire (24 months at most): put a reminder in the calendar |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Optional. The secret of `GOOGLE_DRIVE_CLIENT_ID`'s OAuth client. With both set, Google Drive connects with that client (and Disconnect revokes its grant); otherwise with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` |
| `STRIPE_SECRET_KEY` | Averages Plus: a Stripe secret key (`sk_test_…` in the sandbox, `sk_live_…` live) or a restricted key (`rk_…`) with write access to Checkout Sessions and Customer portal and read access to Prices. Without it checkout answers 503 `billing_not_configured` |
| `STRIPE_WEBHOOK_SECRET` | Averages Plus: the signing secret (`whsec_…`) of the webhook endpoint `https://api.averages.io/stripe/webhook` in the Stripe dashboard. Sandbox and live endpoints have different secrets. Without it the webhook answers 503 |

Make a `SESSION_SECRET` with:
`node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`

**Variables** (in `wrangler.jsonc`, not secret):

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | The Google OAuth client: Sign in with Google (Classroom) and Google Drive in the browser |
| `CANVA_CLIENT_ID` | The Canva Connect integration's client ID |
| `GOOGLE_REDIRECT_URI` | `https://api.averages.io/auth/google/callback` |
| `CANVA_REDIRECT_URI` | `https://api.averages.io/canva/callback` |
| `MS_CLIENT_ID` | The Microsoft Entra app's Application (client) ID, for OneDrive. A public ID; its secret is `MS_CLIENT_SECRET` (since 2026-10-08) |
| `GOOGLE_DRIVE_CLIENT_ID` | Optional. A separate Google OAuth client (same Google Cloud project) used only for Google Drive; it needs the JavaScript origin `https://app.averages.io`, and (to connect with it on the Worker, with `GOOGLE_DRIVE_CLIENT_SECRET`) the redirect URI below. Without it, Google Drive uses `GOOGLE_CLIENT_ID` |
| `VAPID_PUBLIC_KEY` | Browser notifications: the public half of the VAPID key pair (base64url). In `wrangler.jsonc` under `vars` (since 2026-10-07); must pair with `VAPID_PRIVATE_JWK` |
| `VAPID_SUBJECT` | Optional. Contact for push services, default `mailto:help@averages.io` |
| `CANVA_EXPORT_ENABLED` | `"1"` once the `design:content:read` scope is enabled for the Canva integration (turning in Canva designs as PDFs). Leave `"0"` until then: asking Canva for a scope it hasn't approved breaks Connect |
| `TURNSTILE_SITE_KEY` | The Turnstile widget's site key (public; the apply page gets it from `GET /config/apply`). In `wrangler.jsonc` under `vars`, with `TURNSTILE_SECRET` as a secret; without both, there's no check |
| `SCHOOLS_EMAIL_ENDINGS` | In `wrangler.jsonc`: the email endings the school application accepts, comma-separated (`"edu,org,us,net"`; `us` covers `k12.ca.us` and the like). Empty = any |
| `SCHOOLS_VERIFY_EMAIL` | In `wrangler.jsonc`: `"1"` makes applicants verify their email with a 6-digit code. Turn on only after averages.io is onboarded for sending in Cloudflare Email Service (Compute > Email Service > Email Sending > Onboard Domain), which needs Workers Paid: before that, codes only reach verified addresses. Uses `SCHOOLS_MAIL` and `SESSION_SECRET` |
| `SCHOOLS_EMAIL_ALLOW` | Dashboard **secret** (not in this public repo): exact email addresses that may apply whatever their ending, comma-separated. Never shown by `GET /config/apply` |
| `REVIEW_KEY`, `REVIEW_SECRET` | Dashboard **secrets**, 16+ characters each (e.g. `openssl rand -hex 16`). Typed into the hidden API-key sign-in (`app.averages.io/?keys`), they open the reviewer account: six sample classes served by `src/reviewSandbox.ts` (a pretend Schoology inside the Worker, nothing sent to Schoology) in the app's normal live mode, so Canva, Google Drive, OneDrive, notifications and Sync all work. For app reviewers and testing. Unset = off |
| `SCHOOLOGY_CONSUMER_KEY`, `SCHOOLOGY_CONSUMER_SECRET` | Dashboard **secrets** (2026-10-29): the consumer key and secret PowerSchool issues for the app (Schoology's three-legged OAuth, `src/schoologySignin.ts`). With both set, the sign-in page's school button goes to the school's own Schoology to approve (`GET /auth/schoology/start` → `https://<school>/oauth/authorize` → `GET /auth/schoology/callback`). Unset = the button keeps saying it's coming soon. To try it without real keys, set them to the review sandbox's key and secret (`src/reviewSandbox.ts`): approving happens on a page of the API and signs in as the reviewer account (only while `test-signin` is on). Switch: `schoology-oauth` |
| `CANVA_FOLDERS_ENABLED` | `"1"` once `folder:read` and `folder:write` are enabled (and approved) for the Canva integration: Connect asks for them and the Files page shows Canva folders. Leave `"0"` until then, for the same reason. Students connected before then see Reconnect |
| `FLAGS` (Flagship binding, optional) | Feature switches read on every request (src/flags.ts): `canva-integration`, `onedrive-integration`, `drive-integration`, `schoology-signin`, `gclassroom-signin`, `canvas-signin`, `test-signin`, `maintenance-banner`, `schoolsform-page`, `coursematerialpreview-feature`, `turnin-feature`, `messaging-features`, `notifications-features`, `billing`, `calendar-sync`, `live-grades`, `fullscreen`, `schoology-oauth`. Off: that feature's routes answer 503 `feature_off` (navigations go back to the app with `?feature_off=`), and `GET /config/features` tells the app to hide it. All default on except `maintenance-banner`, `coursematerialpreview-feature` and `billing` (Averages Plus: Upgrade and Manage plan; status and the webhook always work). Flag names must be exactly these keys, all lowercase (a flag named "Billing" is never read). If Flagship is slow (400 ms) or errors, the fallback decides. See the commented `"flagship"` block in wrangler.jsonc |
| `FEATURES_OFF` / `FEATURES_ON` (optional vars) | Comma-separated switch keys to turn off / on without Flagship (Flagship still wins when it answers) |
| `MAINTENANCE_MESSAGE` (optional var) | The banner text while `maintenance-banner` is on (300 characters at most) |
| `STRIPE_PRICE_LOOKUP_KEY` (optional var) | Averages Plus: the lookup key of the price checkout sells. Default `plus_monthly` |
| `FEATURES_EARLY` (optional var) | Early access: comma-separated switch keys that are on for Averages Plus members while off for everyone (Flagship's `early-access` string flag works too) |
| `CANVA_PERMISSION_PROBE` | In `wrangler.jsonc`: `"1"` only while running the Canva permission probe (below), otherwise `"0"`. Developer only |

### Canva permission probe (temporary)

A developer-only tool (added 2026-10-10) for Martin to test, from the live site with
his own real Canva connection, whether Canva's undocumented `design:permission:read`,
`design:permission:write` and `folder:permission:write` scopes do anything. Canva lists
those scopes but its published OpenAPI spec has no request that uses them, so this tries
the most likely (guessed) addresses and reports what Canva answers. It is off by default
and does nothing to the normal app.

What it does, while switched on:

- `GET /canva/connect?probe=1` also asks Canva for the three permission scopes (on top
  of the normal ones), so the connection has them to test with. Without `?probe=1`, or
  with the switch off, a normal Connect is unchanged.
- `POST /canva/probe` `{key, write?}` makes one throwaway test design and one test folder
  in the developer's Canva (both titled "Averages permission test (safe to delete)") and
  tries the guessed permission addresses **against only those two ids**. Read-only unless
  `write: true`, which also tries the write guesses on the test design (stopping at the
  first Canva accepts) and two on the test folder. It answers
  `{ ok, scopes, designId, folderId, results: [{ method, path, body, status, answer }] }`,
  where `answer` is Canva's response text cut to 600 characters. The access, refresh and
  client tokens never appear in the answer or the logs.

Turning it on and off:

1. Set `CANVA_PERMISSION_PROBE` to `"1"` in `wrangler.jsonc` and deploy (the
   `REVIEW_SECRET` secret, the reviewer sign-in's, must already be set; it is what unlocks the probe. `SCHOOLS_ADMIN_KEY` also works if set).
2. Reconnect Canva in Settings via `/canva/connect?probe=1` so the connection carries the
   permission scopes.
3. Call `POST /canva/probe` from the app (same origin) with `{ "key": "<REVIEW_SECRET>" }`,
   or `{ "key": "...", "write": true }` for the write guesses, and read the `results`.
4. Set `CANVA_PERMISSION_PROBE` back to `"0"` and deploy. Delete the test design and folder
   in Canva.

Gated hard: `/canva/probe` is 404 unless the switch is `"1"` **and** `REVIEW_SECRET` (or `SCHOOLS_ADMIN_KEY`) is
set, 403 unless `key` matches it (constant-time), 401 without a session, refused in
demo/Incognito/Classroom like the other Canva routes. Only the usual `/canva` rate limit applies (the extra probe cap was removed 2026-10-10).

### Google Drive and OneDrive (staying connected, 2026-10-08)

The Worker signs students in to Google Drive and OneDrive and keeps them connected, so
the app no longer asks again on every visit. One-time setup:

- **Google** (Google Cloud console > APIs & Services > Credentials, the OAuth client
  Drive uses: `GOOGLE_DRIVE_CLIENT_ID` if it has `GOOGLE_DRIVE_CLIENT_SECRET`, otherwise
  `GOOGLE_CLIENT_ID`): add `https://api.averages.io/cloud/gdrive/callback` to
  **Authorized redirect URIs**. Also check the **OAuth consent screen**: if its
  publishing status is **Testing**, Google expires refresh tokens after 7 days and
  everyone has to reconnect every week. It must be **In production**.
- **Microsoft** (Entra admin center > App registrations > the Averages.io app >
  Authentication): **Add a platform > Web** with the redirect URI
  `https://api.averages.io/cloud/onedrive/callback` (the existing single-page app
  platform can stay). Then **Certificates & secrets > New client secret**, and set its
  **Value** as the `MS_CLIENT_SECRET` secret. The Web platform matters: Microsoft
  refuses to redeem a code for a single-page-app redirect URI with a client secret.

For `wrangler dev`, also register `http://localhost:8787/cloud/gdrive/callback` and
`http://localhost:8787/cloud/onedrive/callback` (Google allows `http` only for localhost).

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

### Averages Plus (Stripe, 2026-10-21)

Sandbox first, then live with the same steps and live keys.

1. In Stripe: the product **Averages Plus** (tax code `txcd_10103000`, SaaS for
   personal use) with a recurring monthly price whose **lookup key is
   `plus_monthly`**, and Managed Payments turned on for the account.
2. **Webhooks → Add destination**: `https://api.averages.io/stripe/webhook`, events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Copy its signing
   secret.
3. **Settings → Billing → Customer portal**: turn on cancelling and updating the
   payment method, and set the return link to `https://app.averages.io/settings`.
4. Secrets on the Worker: `npx wrangler secret put STRIPE_SECRET_KEY`, then
   `STRIPE_WEBHOOK_SECRET`.
5. Turn it on: `FEATURES_ON=billing` (or the `billing` flag in Flagship). Until then
   nobody sees Upgrade.
6. Test in the sandbox with card `4242 4242 4242 4242`, any future date and CVC. The
   subscription Checkout makes should show Managed Payments as enabled; ones made by
   hand in the dashboard don't (they use Stripe Tax), so always test through the app.

## Development

```bash
npm install
npm test          # OAuth signing, sessions, adapters, sync, Canva, cloud config, files, Classroom, notifications, extras, messages, rate limits, routes, Drive/OneDrive connections
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
- **What was turned in** (`submissions.test.ts`, 2026-10-09): only dropbox assignments
  asked about, most recent first; the student's own revisions only, drafts left out;
  404 histories are "nothing turned in"; the 45-call budget, 6 histories at a time and
  the 500-file cap (`partial`); downloads found again in their own history (someone
  else's revision, a file from another revision, odd ids refused), Schoology's redirect
  followed by hand, no signature off `api.schoology.com`, no http; Classroom and demo.
  The reviewer account (`reviewSandbox.test.ts`) lists and downloads what it turned in.
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
- **Google Drive and OneDrive connections** (`cloudConnect.test.ts`, 2026-10-08): through
  the real routes with Google and Microsoft faked: status, the authorize URLs (PKCE,
  scopes, `read=1` and keeping `Files.Read`, `login_hint`), callbacks (forged, replayed,
  expired, other student's and other app's states, cancel, no refresh token, Drive
  unticked), cached and refreshed tokens (one refresh for many requests, Microsoft's
  rotated refresh token saved), revoked grants, Disconnect (revoke only with a Drive-only
  client, beating a refresh in flight), demo, Incognito, the reviewer account and
  `return_to` never leaving the app. Since 2026-10-09: `{"refresh": true}` (refreshes,
  30-second throttle, shared by many tabs, old `{}` body unchanged, bad bodies refused),
  and lost connections (`lost: true` with the account after a refused grant, sealed, no
  token kept, cleared by connecting again or Disconnect).
- **Schools** (`schools.test.ts`, `schoolsApply.test.ts`): the sign-in page's lists, the
  application's checks and spam trap, saving and duplicates, Martin's list behind its
  key, the email builder (no header injection, encoded subjects, both parts decode),
  and the schools@ handler: forwarded, answered once per sender, never to robots or
  mailing lists, and never throwing.

- **Plus perks** (`plus.test.ts`): notifications refused, turned off and kept as the
  billing switch and Plus say (and never over a BillingStore outage), the 20-minute check
  stopping, the calendar link (made, shown again, replaced, the .ics and its escaping and
  folding, the 10-minute limit, nothing of the calendar stored, Plus ended, a sign-in that
  ran out, turning it off), the reviewer sandbox's due dates, early access through the
  real Worker, and Plus ending through the webhook.
- **Averages Plus** (`billing.test.ts`): the form encoding Stripe expects, webhook
  signatures (good, wrong secret, edited body, too old, several `v1`s), each event
  type, out-of-order and repeated events, and the routes through the real Worker
  against a pretend Stripe: Managed Payments and the preview `Stripe-Version` on
  checkout, the price by lookup key, who can and can't subscribe, the portal, and
  that Stripe's error text never reaches the browser.

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
