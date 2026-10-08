# Hosting an OpenCourse catalog

A catalog server lets people sign up, publish courses from the OpenCourse app,
and add them to theirs, with updates that keep their progress. It also serves
the catalog's website: browsing, accounts, "My courses" for publishers, and an
admin console. The public one is [catalog.opencourse.dev](https://catalog.opencourse.dev);
this page is for running your own, for a class, a team or a community.

The server is one Node.js process with a SQLite database and a folder of course
archives. It needs a machine that keeps a disk between restarts, a domain name,
and a way to send email.

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
| `OPENCOURSE_SERVER_DATA` | `./data` (`/data` in Docker) | The database, the archives and the server's secret. |
| `OPENCOURSE_SERVER_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | The address to listen on. |
| `OPENCOURSE_SERVER_PORT` | `8787` | The port to listen on. |
| `OPENCOURSE_TRUST_PROXY` | | `1` when behind a proxy, so rate limits see each visitor's real address. |
| `OPENCOURSE_SERVER_APP_URL` | `https://opencourse.dev/download` | Where **Get the app** points. |
| `OPENCOURSE_SERVER_PRIVACY_URL` | | Your privacy policy. Every page's footer links to it; without it there is no link. |
| `OPENCOURSE_SERVER_LEGAL_URL` | | Your legal notice, linked the same way. |
| `OPENCOURSE_SERVER_DEV` | | `1` on a developer's machine only: sign-up codes are printed and served at `/dev/outbox` instead of mailed. Never on a public server. |

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

## Backups

Everything is in the data folder: `server.db`, `archives/`, `covers/` and
`secret`. The database runs in WAL mode, so copy it with SQLite rather than
`cp`:

```bash
sqlite3 /data/server.db ".backup /backups/server-$(date +%F).db"
```

then copy `archives/`, `covers/` and `secret` beside it. Without `secret`,
codes already mailed stop working, nothing more. Restoring is putting the
folder back and starting the server.

## Connecting the app

People connect in the app's **Settings ▸ Servers ▸ Connect to a server…** with
your domain, and can sign up right there. The website's footer and every course
page tell them the same thing.
