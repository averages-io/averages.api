# averages.api

The API behind [Averages.io](https://averages.io), a student-built companion app for
your school's learning platform. It's a Cloudflare Worker written in TypeScript with
[Hono](https://hono.dev), and it answers on `api.averages.io` for the app at
`app.averages.io`.

The app never talks to Schoology directly. Every Schoology request has to be signed,
and the secrets that sign them can never be handed to browser code. So the browser
talks to this Worker, and only this Worker talks to Schoology.

## What it does

- **Sign-in:** Sign in with Schoology (the school's own sign-in page), plus a
  personal-API-key sign-in and a demo account.
- **Your school data:** classes, grades, assignments, the gradebook, updates,
  calendar events, files, messages and contacts, shaped for the app's pages, with
  grade predictions worked out on the way through.
- **Turning in:** files from your computer, Canva, Google Drive or OneDrive, streamed
  straight to Schoology.
- **Connections:** Canva, Google Drive and OneDrive stay connected, with their tokens
  encrypted and kept in the US.
- **Sync Across Devices, profile pictures and backgrounds.**
- **Averages Plus** (through Stripe): browser notifications and calendar sync.
- **Status:** a check every 15 minutes, a banner in the app when something's down,
  and everything public at [api.averages.io/status](https://api.averages.io/status).

There's no general Schoology passthrough. Each feature has its own route with its own
fixed Schoology calls, so you can see exactly what is asked for.

## What gets stored

- **Grades and schoolwork are never stored.** They pass through the Worker to your
  browser on each request.
- **Only if you turn them on:** your synced settings, profile picture and background;
  your Canva, Google Drive and OneDrive connections; your notification subscriptions;
  your calendar link. Each is deleted when you turn it off or disconnect, and
  **Delete account** removes all of them at once.
- **Averages Plus:** your Stripe customer and subscription IDs and status. Card
  details stay with Stripe.
- **Where:** everything is kept in Cloudflare's US jurisdiction, one store per student.
- **Nothing else.** No analytics, no tracking, no ads.

Everything kept about you can be downloaded from Settings (`GET /account/export`). The
full list is on the [Your data](https://averages.io/your-data) page.

## Security

- **Sessions** are sealed (AES-GCM) in an httpOnly, Secure cookie that lasts 15 days.
  The Worker keeps no copy.
- **CORS** allows only `app.averages.io` and `averages.io`. Requests that change
  something must be JSON from one of them.
- **Downloads** are looked up again on your own assignment or submission. The browser
  only ever sends ids, and signed requests only ever go to `api.schoology.com`.
- **OAuth** for Canva, Google and Microsoft uses PKCE with a one-time state, and tokens
  are encrypted at rest. Errors carry our own short codes, never a token or a
  provider's message.
- **Rate limits** apply per student and per network.
- **No secrets in the repo.** All of them are Cloudflare secrets.

**Found a security problem?** Please email help@averages.io instead of opening a
public issue.

## Development

```bash
npm install
npm test        # the whole suite, under Node's TypeScript support (no framework)
npm run dev     # local Worker on http://localhost:8787
```

`main` is deployed by Cloudflare Workers Builds (`npm run build`, a TypeScript check,
then `npx wrangler deploy`). Secrets, variables, feature switches and the one-time
setup for each connection are in [DEVELOPMENT.md](DEVELOPMENT.md).

## License

**GNU General Public License v3.0.** See [LICENSE](LICENSE). You're free to use, study,
change and share this code. If you give out a changed version, you have to share its
source under the same license.

The license covers the code, not the Averages.io name, logo or look. Forks are welcome
under their own name.

---

Averages.io is an independent app made by a student. It isn't made by, endorsed by or
affiliated with any school platform it connects to. Schoology and PowerSchool are
trademarks of PowerSchool Holdings, Inc. Google Drive and Google Calendar are
trademarks of Google LLC. OneDrive is a trademark of the Microsoft group of companies.
Canva is a trademark of Canva Pty Ltd. Stripe is a trademark of Stripe, Inc.
