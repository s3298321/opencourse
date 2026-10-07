# OpenCourse server

A course repository for the OpenCourse app. It hosts and versions courses,
gives each person an account, and serves a read-only web catalog. The app
connects to it from **Settings → Servers**, and from then on:

- the Library's **Course catalog** tab shows the server's courses, searchable
  by keyword and tag;
- adding a course installs its current version, keeping the server's IDs;
- updating keeps progress on everything that still exists;
- publishing sends a course you made, and **Manage publication** rolls back,
  deletes versions or unpublishes.

The API it speaks is in [`../docs/server-api.md`](../docs/server-api.md).

## Running it

Node 22 (`../.nvmrc`), like the app.

```bash
npm install
npm run dev          # OPENCOURSE_SERVER_DEV=1, port 8787, data in ./data
```

A development server has no email. Sign-up codes are printed to the terminal
and served at <http://localhost:8787/dev/outbox>. In the app, connect to
`http://localhost:8787`; plain HTTP is accepted only for this computer.

Open <http://localhost:8787> in a browser for the web catalog.

```bash
npm test             # vitest, against an in-process server
npm run typecheck
npm run build        # dist/index.js, one file with the app's core compiled in
npm start            # node dist/index.js
```

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
| `OPENCOURSE_SERVER_DEV` | | `1`: no SMTP, codes go to stdout and `/dev/outbox`. Never on a reachable server |

A server with neither SMTP nor development mode refuses to start, because
nobody could sign up.

## Deploying

1. Run `npm ci && npm run build`. Then copy `dist/`, `package.json` and
   `package-lock.json` to the host and run `npm ci --omit=dev` there.
2. Run `node dist/index.js` under a supervisor (systemd, launchd, a container),
   with `OPENCOURSE_SERVER_DATA` on persistent storage.
3. Put it behind a TLS proxy (Caddy, nginx). The app sends passwords and tokens
   to the server, so it refuses plain HTTP to anything but loopback. Set
   `OPENCOURSE_SERVER_PUBLIC_URL` to the HTTPS address and
   `OPENCOURSE_TRUST_PROXY=1`.
4. Back up `OPENCOURSE_SERVER_DATA`. `server.db` is SQLite in WAL mode; copy it
   with `sqlite3 server.db ".backup backup.db"`, not `cp`. Losing the `secret`
   file only invalidates codes that are mid-flight.

## Moderation

There is no admin web UI. On the server's machine:

```bash
npm run admin -- disable-account <username>   # signs it out everywhere and refuses its logins
npm run admin -- enable-account <username>
npm run admin -- unlist <courseId>            # hides a course, as its owner's Unpublish does
npm run admin -- relist <courseId>
```

## How it works

- **Accounts.** An address is confirmed with a 6-digit code before an account
  exists.
  - Codes expire after 10 minutes, allow 5 guesses, and are stored only as an
    HMAC.
  - Passwords are hashed with scrypt.
  - A token is `ocs_…`; only its SHA-256 is stored. A token expires 90 days
    after it was last used, and a password reset revokes every token.
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
- **Validation is the app's own.** `src/publish/validate.ts` uses the app's
  `extractArchive`, its course schema and its identity rules
  (`../app/src/core`, `../app/src/main/unzip.ts`), so the server cannot accept
  a course the app would refuse.
- **The overview never carries answers.** It is built at publish
  (`src/catalog/overview.ts`) from titles and counts only. It never includes
  quiz answers, solutions, tests, hints or flashcard answers.
- **The web pages run no script.** Every value is escaped, descriptions go
  through markdown-it with raw HTML off, and the CSP has no `script-src`.
  Covers are served with a sandboxing CSP, because an SVG is an author's file.
