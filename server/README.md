# OpenCourse server

A course repository for the OpenCourse app. It hosts and versions courses,
gives each person an account, and serves the catalog's web app: browsing,
sign-up, "My courses" for publishers, account settings and an admin console.
The app connects to it from **Settings → Servers**, and from then on:

- the Library's **Course catalog** tab shows the server's courses, searchable
  by keyword and tag;
- adding a course installs its current version, keeping the server's IDs;
- updating keeps progress on everything that still exists;
- publishing sends a course you made, and **Manage publication** rolls back,
  deletes versions or unpublishes.

The API it speaks is in [`../docs/server-api.md`](../docs/server-api.md). To run
one for real, read [`../docs/self-hosting.md`](../docs/self-hosting.md): Docker,
configuration, mail, administration and backups.

## Running it

Node 22 (`../app/.nvmrc`), like the app.

```bash
npm install
npm run dev          # the API on :8787 (OPENCOURSE_SERVER_DEV=1, data in ./data)
                     # and the web app on http://localhost:5173, which hands /api to it
npm run seed         # in another terminal: accounts and courses to look at
npm run admin -- grant-admin ada
```

A development server has no email. Sign-up codes are printed to the terminal
and served at <http://localhost:8787/dev/outbox>. In the app, connect to
`http://localhost:8787`; plain HTTP is accepted only for this computer. The
seeded accounts' password is `correct horse battery`.

```bash
npm test             # vitest, against an in-process server
npm run typecheck    # the server and the web app
npm run build        # dist/index.js and the web app in dist/web
npm start            # node dist/index.js: the API and the built web app on :8787
npm run e2e          # after build: the web app's journeys in Chrome, on a throwaway server
```

The web app (`web/`) is React and Vite, built on the app's core (`@core`) and
the design layer the website shares (`../design`). `shared/pages.ts` is its page
table, read by both the router and the server, which answers every page with
one HTML shell carrying the title, link previews and the first screen's data.

The app's own test of the whole journey uses this server:
`OPENCOURSE_TEST_SERVER=1 npx vitest run tests/server-live.test.ts` in `../app`.
The smoke run that drives the real window against the built server is
`OPENCOURSE_SMOKE_SERVER=1 npm run smoke`, also in `../app`.

## Configuration

Everything comes from the environment.

| Variable | Default | |
| --- | --- | --- |
| `OPENCOURSE_SERVER_PORT` | `8787` | |
| `OPENCOURSE_SERVER_HOST` | `127.0.0.1` | `0.0.0.0` behind a proxy on another host |
| `OPENCOURSE_SERVER_DATA` | `./data` | The database, the archives, the covers and the HMAC secret |
| `OPENCOURSE_SERVER_NAME` | `OpenCourse server` | Shown in the app and on the web pages |
| `OPENCOURSE_SERVER_DESCRIPTION` | | One line about the server |
| `OPENCOURSE_SERVER_PUBLIC_URL` | `http://<host>:<port>` | The address people use; it appears in emails and on the web pages |
| `OPENCOURSE_SMTP_URL` | | For example `smtps://user:password@smtp.example.org:465` |
| `OPENCOURSE_MAIL_FROM` | `OpenCourse <no-reply@localhost>` | |
| `OPENCOURSE_REGISTRATION` | `open` | `closed`: only existing accounts can sign in |
| `OPENCOURSE_TRUST_PROXY` | | `1` to use `X-Forwarded-For` for rate limits |
| `OPENCOURSE_SERVER_APP_URL` | `https://opencourse.dev/download` | Where the web app's **Get the app** points |
| `OPENCOURSE_SERVER_PRIVACY_URL` | | Your privacy policy, linked from every web page's footer; no link when unset |
| `OPENCOURSE_SERVER_LEGAL_URL` | | Your legal notice, linked the same way |
| `OPENCOURSE_SERVER_WEB_DIR` | `dist/web` | The built web app, if it lives elsewhere |
| `OPENCOURSE_SERVER_DEV` | | `1`: no SMTP, codes go to stdout and `/dev/outbox`. Never on a reachable server |

A server with neither SMTP nor development mode refuses to start, because
nobody could sign up.

## Deploying

`server/Dockerfile` builds one image with the API and the web app, and
`server/deploy/` runs it behind Caddy with automatic HTTPS. Without Docker:
`npm ci && npm run build`, copy `dist/`, `package.json`, `package-lock.json`
and `.npmrc` to the host, `npm ci --omit=dev`, and run `node dist/index.js`
behind a TLS proxy. [`../docs/self-hosting.md`](../docs/self-hosting.md) has
the details and the backup procedure.

## Administration

An account with the admin role sees **Admin** in the web app: accounts,
courses, moderation and the audit log. The first administrator is made on the
server's machine, which is also the way back in:

```bash
npm run admin -- grant-admin <username>       # or revoke-admin
npm run admin -- disable-account <username>   # signs it out everywhere and refuses its logins
npm run admin -- enable-account <username>
npm run admin -- unlist <courseId> [reason]   # moderation: its owner cannot list it again
npm run admin -- relist <courseId>
```

## How it works

- **Accounts.** An address is confirmed with a 6-digit code before an account
  exists.
  - Codes expire after 10 minutes, allow 5 guesses, and are stored only as an
    HMAC.
  - Passwords are hashed with scrypt.
  - A token is `ocs_…`; only its SHA-256 is stored. The app sends it as a
    Bearer token; the web app holds the same kind of token in an HttpOnly
    cookie, and a cookie may only change something on a same-origin request.
    A token expires 90 days after it was last used (30 for the web), and a
    password reset revokes every token.
  - Neither sign-up nor "forgot password" ever says whether an address already
    has an account.
- **Courses.** A course is its uid, and every element in it has a uid too. A
  uid belongs to one course forever and never changes kind, so an update can
  tell an edited lesson from a new one.
- **Versions.** A publish must be higher than every version ever published,
  deleted ones included.
- **Rollback, delete, unpublish.**
  - Rolling back moves the course's current version and deletes nothing.
  - Deleting a version removes its archive but keeps its number taken.
  - Unpublishing hides the course and keeps it.
  - A moderator's removal is separate from the owner's unpublishing: a new
    version does not undo it, and only a moderator can.
- **Validation is the app's own.** `src/publish/validate.ts` uses the app's
  `extractArchive`, its course schema and its identity rules
  (`../app/src/core`, `../app/src/main/unzip.ts`), so the server cannot accept
  a course the app would refuse.
- **The overview never carries answers.** It is built at publish
  (`src/catalog/overview.ts`) from titles and counts only. It never includes
  quiz answers, solutions, tests, hints or flashcard answers.
- **The web app runs only its own script.** The CSP allows script and style
  from this origin and nothing inline; the boot data is JSON escaped so a
  course title cannot end its script element; descriptions go through
  markdown-it with raw HTML off and then DOMPurify. Covers are served with a
  sandboxing CSP, because an SVG is an author's file.
