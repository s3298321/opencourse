# Hosting an OpenCourse catalog

An OpenCourse server hosts course and PDF catalogs, accounts, enrolled learning,
progress and reading chats. Learners can use the desktop app or its web player.
Web learning includes the course overview, quizzes and flashcard review
sessions; exercises, projects, notebooks, Python execution, authoring and Coach
remain desktop features.

The server is one Fastify service with SQLite and managed content files. It
needs persistent storage, HTTPS and email. Server AI uses each account's own
API key. Reading works when AI is disabled. The public catalog is
[catalog.opencourse.dev](https://catalog.opencourse.dev).

## With Docker (recommended)

You need a Linux machine with Docker, a domain pointing at it, and ports 80 and
443 open. Caddy, in front of the server, gets the HTTPS certificate by itself.

1. Copy `server/deploy/` from the repository to the machine.
2. Copy `.env.example` to `.env` and fill it in (see [Configuration](#configuration)).
3. Start it:

   ```bash
   docker compose up -d
   ```

4. Open `https://<your domain>`, create your account, then make it an
   administrator:

   ```bash
   docker compose exec server node dist/admin.js grant-admin <your-username>
   ```

Sign in again and **Admin** appears in the header.

To update, pull the new image and restart: `docker compose pull && docker compose up -d`.
The database upgrades itself on start. Pin a version with `OPENCOURSE_VERSION`
in `.env` if you would rather choose when.

The image is `ghcr.io/s3298321/opencourse-server`. To build it from a checkout
instead, run `docker build -f server/Dockerfile -t opencourse-server .` from
the repository root.

## Without Docker

With Node 22.12 or later:

```bash
cd server
npm ci
npm run build
```

Copy `dist/`, `package.json`, `package-lock.json` and `.npmrc` to the machine,
run `npm ci --omit=dev` there, and start `node dist/index.js` under a supervisor
(systemd, launchd). Put a TLS proxy such as Caddy or nginx in front of it,
set `OPENCOURSE_SERVER_PUBLIC_URL` to the HTTPS address and
`OPENCOURSE_TRUST_PROXY=1`. The app refuses plain HTTP to anything but the
machine it runs on.

## Configuration

Everything is set with environment variables (in `.env` with Docker).

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENCOURSE_SERVER_PUBLIC_URL` | `http://<host>:<port>` | The address people use. It appears in emails, on the website and in link previews. |
| `OPENCOURSE_SERVER_NAME` | `OpenCourse server` | What the catalog calls itself. |
| `OPENCOURSE_SERVER_DESCRIPTION` | | One sentence under the name. |
| `OPENCOURSE_SMTP_URL` | | Where mail goes, such as `smtps://user:password@smtp.example.org:465`. Required, unless in development. |
| `OPENCOURSE_MAIL_FROM` | `OpenCourse <no-reply@localhost>` | The sender of sign-up codes and notices. |
| `OPENCOURSE_REGISTRATION` | `open` | `closed` stops new sign-ups. Existing accounts keep working. |
| `OPENCOURSE_SERVER_DATA` | `./data` (`/data` in Docker) | The database, published courses/documents, extraction caches and authentication secret. |
| `OPENCOURSE_SERVER_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | The address to listen on. |
| `OPENCOURSE_SERVER_PORT` | `8787` | The port to listen on. |
| `OPENCOURSE_TRUST_PROXY` | | `1` when behind a proxy, so rate limits see each visitor's real address. |
| `OPENCOURSE_SERVER_APP_URL` | `https://opencourse.dev/download` | Where **Get the app** points. |
| `OPENCOURSE_SERVER_SITE_URL` | `https://opencourse.dev` | Where the OpenCourse wordmark points. |
| `OPENCOURSE_SERVER_PRIVACY_URL` | | Your privacy policy. Every page's footer links to it; without it there is no link. |
| `OPENCOURSE_SERVER_LEGAL_URL` | | Your legal notice, linked the same way. |
| `OPENCOURSE_SERVER_DEV` | | `1` on a developer's machine only: sign-up codes are printed and served at `/dev/outbox` instead of mailed. Never on a public server. |
| `OPENCOURSE_AI_ENCRYPTION_KEYS` | unset | JSON object mapping key versions to 32-byte hex encryption keys, supplied as a deployment secret outside the data directory. |
| `OPENCOURSE_AI_ACTIVE_KEY` | unset | Version to use for new and rotated encrypted API keys. Both AI settings must be present to enable server chat. |
| `OPENCOURSE_DOCUMENT_MAX_BYTES` | `104857600` | Maximum PDF package upload bytes (100 MiB); the archive safety policy also caps packed size at 100 MiB. |
| `OPENCOURSE_DOCUMENT_STORAGE_BYTES` | `10737418240` | Total published PDF and cover storage (10 GiB). |

`GET /healthz` answers `{"ok": true}` while the database does, for load
balancers and monitoring.

## Mail

Sign-up, password resets and email changes all work by a six-digit code sent
by email, so the server will not start without SMTP. Any provider works:
Amazon SES, Postmark, Mailgun, your own mail server. Set up SPF and DKIM for the
sender's domain, or the codes end up as spam.

## Administration

Administrators see **Admin** in the website's header:

- **Overview**: accounts, courses, versions, recent adds, storage, and recent activity.
- **Accounts**: search, disable or enable an account (disabling signs it out
  everywhere), and grant or remove the admin role.
- **Courses**: remove a course from the catalog with a reason its publisher is
  mailed, or restore it. A removed course stays removed when its publisher
  publishes a new version; only an administrator can restore it.
- **Audit log**: every administrative action and account security event.

The same actions work from the machine, which is also the way back in if every
administrator is locked out:

```bash
node dist/admin.js grant-admin|revoke-admin|disable-account|enable-account <username>
node dist/admin.js unlist <course-id> [reason]
node dist/admin.js relist <course-id>
```

(From a checkout, `npm run admin -- …` runs the same commands.)

## AI credentials and rotation

Supply a secret such as `OPENCOURSE_AI_ENCRYPTION_KEYS='{"v1":"<64 hex characters>"}'`
and `OPENCOURSE_AI_ACTIVE_KEY=v1` through your deployment secret manager. Generate
32 random bytes for every key (for example `openssl rand -hex 32`). Restrict
access to this secret; never commit it or put it inside the database or data
volume. The Docker environment file supports these variables, but a managed
secret injector is preferable for production.

API keys use AES-256-GCM, authenticated with the immutable account ID and
versioned encryption envelopes. Settings return only status and a masked hint.
The server supports API keys in this release. Do not copy desktop subscription
refresh tokens to it. Subscription support requires a separate supported
server authorization flow and is deferred.

To rotate: add a new key to the map while retaining the old key, choose the new
active version, restart, then run `node dist/admin.js rotate-ai-keys`. This
rewrites the stored envelopes without printing secrets. Verify it succeeded
before removing the old key from the running configuration. Retain old keys
in your separate recovery store for any backups still encrypted with them.
Without the matching key, restored credentials cannot be recovered; users
must configure new API keys. Do not regenerate keys on each server start.

## Limits and operations

PDF publications reject encrypted/password-protected PDFs. Upload validation
and searchable-text extraction run in bounded workers (two total, 256 MiB
heap, 60 seconds per job, 10,000 pages, 32 MiB extracted text). Indexing resumes
after restart; publishers can retry failures from document version management.
Covers are PNG/JPEG/WebP, at most 5 MiB. Uploads are limited to ten per account
per minute. Server storage checks include PDF and cover bytes.

AI allows 30 sends per account per minute, two active generations per account,
one per conversation, 120 seconds per generation and bounded read-only
retrieval. History and answer sizes are bounded. A server restart marks
unfinished answers interrupted; it never automatically sends another billable
request. API credential/quota errors appear to the learner. Reading remains
available. Exercise/project files and Coach data are never synced.

Monitor `document.index.failed`, request error/status rates and desktop
`learning-sync` failures, retained-action counts and last successful sync in server
settings. Logs contain operational metadata, not API keys, prompts or answer
text. Do not enable body logging at your reverse proxy. There is no separate
metrics collector bundled; connect your log/uptime system to these signals.

## Backups and recovery

Back up the database **and published files from the same stopped snapshot**.
A live SQLite backup followed by an unrelated file copy can miss concurrently
published or deleted versions. Stop the service (leave the reverse proxy up),
snapshot or archive the entire persistent data volume, then start the service.
For Docker use `docker compose stop server`, your volume/snapshot backup tool,
then `docker compose start server`. Include `server.db` and any SQLite WAL/SHM
files present, archives, covers, documents, and `secret`. A filesystem snapshot
of the stopped service also makes retaining extraction caches harmless.

Keep the encryption key map, active key version and deployment configuration
in a **separate, access-controlled recovery backup**. Do not put keys in archive
filenames, backup metadata or logs. Test restoring both components.

Restore into an empty data directory while the server is stopped. Restore the
matching encryption keys, run the matching server release, verify account
login, enrollments, PDF/course access and API-key configured status, then open
traffic. The database's stable server ID must survive restoration. Do not
serve a copied production identity as a second independent public server.

## Migration and release checks

Before upgrading, stop and back up the server and desktop user data. Rehearse
the upgrade on copies in an isolated environment with outbound mail/AI disabled.
This release migrates server schema 2 to 5 and desktop schema 22 to 24. Desktop
migration preserves existing local IDs, snapshots legacy learning progress and
imports eligible reading history once. Existing server values win when old
local data has no comparable timestamp. Local-only content is not enrolled.

Check multiple accounts and servers, offline pending changes, web enrollment
downloads, accepted updates, PDF replacement and unpublishing on the rehearsal.
Rollback means restoring the pre-upgrade data snapshot with the previous
binary, not running the old binary against a newer database.

From a checkout with Node 22, run app/server typechecks and tests, build the
server, run its Playwright journeys, and run the desktop integration tests with
`OPENCOURSE_TEST_SERVER=1`. Tests use fake AI providers. Before release, run the
controlled `npm --prefix server run smoke:ai` with a dedicated low-budget
`OPENCOURSE_AI_SMOKE_KEY`; it makes a real billable request in a disposable
server and deletes its data afterward. Deploy first to a staging instance and
verify backup restoration, TLS/cookie behavior and mail delivery. Desktop
subscription authorization does not gate this API-key release.

## Connecting the app

People connect in the app's **Settings ▸ Servers ▸ Connect to a server…** with
your domain, and can sign up right there. The website's footer and every course
page tell them the same thing.
