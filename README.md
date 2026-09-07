# schoolagy-api

Schoolagy's Schoology proxy — `api.schoolagy.io`. A Cloudflare Worker (Hono).

It exists for one non-negotiable reason: **OAuth-signed Schoology calls have to
happen server-side.** The consumer secret can never be exposed to browser JS, so
the browser talks to this Worker, and only this Worker talks to Schoology.

---

## Authentication model

Schoolagy uses **two-legged OAuth 1.0a** with **personal API keys**. The student
generates their own key + secret at their school's Schoology `/api` page, and
the app signs requests with it directly — the consumer and the user are the same
account.

This matters because it means **no admin involvement and no App Center
approval** are needed. Those are only required for three-legged OAuth, i.e. an
app reading *other people's* accounts. (The "appAuth" button on the login screen
is that future flow; `oauth.ts` already accepts a token + token secret so it can
be reused unchanged when it arrives.)

Schoology expires OAuth1 tokens after 90 days, so expect users to re-key
periodically.

## Sessions

On sign-in, the Worker verifies the key/secret by actually calling Schoology as
that user, then seals `{key, secret, uid}` with AES-GCM into an opaque token
delivered as an **httpOnly, Secure, SameSite=Lax cookie** on `.schoolagy.io`.

- httpOnly means no JS — including ours — can read the credentials back out.
- Encryption means the token is unreadable even if it leaks.
- No database: nothing to breach, nothing to provision, no KV namespace needed.

The tradeoff is that a session can't be individually revoked before it expires
(30 days). For a personal-key beta that's a reasonable trade; if true revocation
is ever needed, swap the sealed blob for a KV lookup key and delete on logout.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | — | Health check |
| `POST` | `/auth/session` | — | Sign in with `{key, secret}`; sets the session cookie |
| `DELETE` | `/auth/session` | — | Sign out; clears the cookie |
| `GET` | `/auth/me` | session | Current user |
| `GET` | `/data/bundle` | session | Everything the app's pages render, already mapped into their shapes |
| `GET` | `/schoology/*` | session | Signed read-only passthrough to any Schoology endpoint |

`/data/bundle` is deliberately one call rather than one per page: Schoology is
slow and rate-limited, and sections/grades/assignments are interdependent. The
app caches it for five minutes.

`/schoology/*` is **GET-only on purpose.** This beta has no reason to write to a
student's Schoology account, and refusing writes entirely is a stronger
guarantee than validating them.

## Setup

```bash
npm install

# Required. Seals session tokens — without it, sign-in returns 500 by design
# rather than issuing sessions sealed with "undefined".
npx wrangler secret put SESSION_SECRET     # paste a long random string

npm test        # OAuth signing, session crypto, and data adapters
npm run dev     # local, on :8787
npm run deploy
```

Then attach `api.schoolagy.io` as a Custom Domain on the Worker.

`ALLOWED_ORIGINS` and `COOKIE_DOMAIN` are plain vars in `wrangler.jsonc`; adjust
them if the app is ever served from somewhere else.

> Generate a secret with:
> `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`

## Tests

```bash
npm test
```

No build step and no test framework — the modules import cleanly under Node's
type stripping, so the suite runs directly.

What's covered, and why each part is worth pinning:

- **OAuth signing** is checked against the canonical published OAuth 1.0
  Appendix A.5.1 test vector — base string and signature both. A wrong signature
  surfaces as a bare `401` from Schoology with no explanation, which is close to
  undebuggable from the outside, so it gets verified against a known-good vector
  rather than "it seemed to work".
- **Sessions** are checked for confidentiality (the Schoology secret must not be
  readable in the token), integrity (tampering and wrong keys are rejected), and
  expiry.
- **Adapters** are checked against realistic Schoology payloads, including the
  quirks: single results returned as bare objects instead of arrays, two
  different timestamp formats, and excused work that must not drag a grade
  trend down.

---

## License

**GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

In short: you're free to use, study, modify and share this code. The one
condition that matters most is AGPL's network clause — **if you run a modified
version as a public service, you have to make your modified source available to
its users.**

That's a deliberate choice, not a default. Schoolagy tells students it never
stores or sells their academic data, and the AGPL is what keeps that promise
honest downstream: a fork can't quietly become a closed, tracking-laden version
of the same app. Running your own instance, changing it, and sharing it are all
explicitly fine — publishing your changes is the only ask.

## Trademark and affiliation

Schoolagy is an independent project. It is **not affiliated with, endorsed by, or
sponsored by PowerSchool or Schoology**. Schoology is a trademark of PowerSchool
Group LLC, used here only to describe the API this service talks to.

"Schoolagy", the Schoolagy name, logo and visual identity are **not** covered by
this repository's license. The license grants rights to the code; it does not
grant permission to use the project's name or branding. A fork is welcome — just
give it your own name.
