# OpenCourse server API — v1

The contract between an OpenCourse server and its two clients: the OpenCourse
app and the server's own web app. The types are
`app/src/core/catalog/api.ts`, shared by both sides, and the app checks every
response with `app/src/core/catalog/parse.ts`. Change all three together.

Everything is JSON under `/api/v1`, except two routes: an archive upload is
`application/zip`, and a download returns `application/zip`.

**Errors.** A refusal is an HTTP status plus a body like this:

```json
{ "error": { "code": "version_not_higher", "message": "Publish a version higher than 0.2.0.", "maxVersion": "0.2.0" } }
```

The `code` is for programs and the `message` for people. Some refusals add
fields: `attemptsLeft` for a wrong code, `errors` (a list) for a refused
archive, `maxVersion` for a version that is too low.

**Authentication.** The app sends `Authorization: Bearer ocs_…`, where the
token comes from sign-up, login or a password reset. Catalog reads work without
one; with one, the server can say which courses are yours.

The web app signs in the same way but adds `"session": "cookie"` to the body of
`register/complete`, `login` and `password/reset`. It then gets `{ account }`
with no token: the token is set as an `HttpOnly`, `SameSite=Lax` cookie
(`__Host-ocs_session` over HTTPS, `ocs_session` on a plain-HTTP development
server) that page script can never read.

- **Which credential wins:** a request with a Bearer token is authenticated by
  that token and nothing else.
- **Same-origin rule:** a request authenticated by the cookie that changes
  anything (any method but `GET`, `HEAD` and `OPTIONS`) must come from the
  server's own pages. That means `Sec-Fetch-Site: same-origin` or, without
  that header, an `Origin` equal to the server's public URL. Anything else is
  `403 cross_site`.

## Server

`GET /server` returns
`{ "opencourse": 1, "api": 1, "name", "description", "registration": "open" | "closed", "version" }`.
A client refuses an `api` it does not know. `version` is the server's own
release, and older servers leave it out.

`GET /healthz` (outside `/api/v1`) answers `{ "ok": true }` when the database
does. It is meant for load balancers and container health checks.

## Accounts

| | | |
| --- | --- | --- |
| `POST /auth/register/start` | `{ email }` | `202`. Mails a 6-digit code, or, for an address that already has an account, a note saying so. The answer is the same either way. |
| `POST /auth/register/verify` | `{ email, code }` | `{ ticket }`, valid 15 minutes. A wrong code gives `400 invalid_code` with `attemptsLeft`. |
| `GET /auth/username?name=` | | `{ available, reason? }` |
| `POST /auth/register/complete` | `{ ticket, username, password, session? }` | `201 { token, account }` |
| `POST /auth/login` | `{ login, password, session? }` | `{ token, account }`. `login` is an email or a username. Every failure is the same `401`. |
| `POST /auth/logout` | | `204`; revokes this token or cookie |
| `GET /auth/me` | | `{ account }` |
| `POST /auth/password/forgot` | `{ email }` | `202`, whether or not the address has an account |
| `POST /auth/password/reset` | `{ email, code, password, session? }` | `{ token, account }`; every other token is revoked |

**Rules** (`usernameProblem`, `emailProblem` and `passwordProblem` in `api.ts`):

- **Username:** 3–32 characters, lowercase letters, digits, `-` and `_`,
  starting and ending with a letter or digit, and not a reserved name.
- **Password:** 8–256 characters.
- **Code:** 6 digits. It expires after 10 minutes and allows 5 attempts.

## Your account

These routes need a signed-in account. Any change to a credential asks for the
current password again.

| | | |
| --- | --- | --- |
| `GET /me` | | `{ account: AccountDetails }`: the account plus `role` (`member` or `admin`) and `createdAt` |
| `POST /me/password` | `{ current, password }` | `{ ok }`. Every session but this one is signed out, and the account is mailed a notice. |
| `POST /me/email/start` | `{ email, password }` | `202`. Mails a code to the new address, or a note if it already has an account. The answer is the same either way. |
| `POST /me/email/verify` | `{ email, code }` | `{ account }`. Only the account that asked can use the code, and the old address is told. |
| `GET /me/sessions` | | `{ sessions: SessionInfo[] }`: `id`, `kind` (`app` or `web`), `userAgent`, `createdAt`, `lastUsedAt` and `current` |
| `DELETE /me/sessions/:id` | | `204`; signs that session out |
| `POST /me/sessions/revoke-others` | | `{ ok }`; signs out everywhere but here |
| `DELETE /me` | `{ password }` | `204`. Deletes the account and every course it published, including their archives. Learners keep their own copies. The only administrator cannot. |

## Catalog

| | | |
| --- | --- | --- |
| `GET /courses?q=&tag=&tag=&sort=&page=` | | `{ courses: CatalogCourse[], total, page, pageSize }` |
| `GET /tags` | | `{ tags: [{ tag, count }] }` |
| `GET /courses/:id` | | `CourseOverview` |
| `GET /courses/:id/cover` | | The current version's cover image |
| `POST /courses/status` | `{ ids }` | `{ courses: [{ id, currentVersion, listed }] }` |
| `POST /courses/:id/download` | `{ intent: "add" \| "update" }` | The current version's archive (auth required) |

`GET /courses` only lists courses that are listed and have a current version.

- `q` matches whole words and word prefixes in titles, descriptions, subjects,
  authors, publishers, tags and lesson titles. Every word must match.
- `tag` may repeat; a course must have every tag given. Tags match regardless
  of case.
- `sort` is `downloads`, `recent` or `title`. Without it, a search is ordered
  by relevance and the full list by downloads.

`GET /courses/:id` returns the overview. It has titles and counts and never a
question, an answer, a solution, a test, a hint or a flashcard answer. Its
`versions` lists `current` and `available` versions. The course's owner also
sees `withdrawn` and `deleted` versions, and downloads per version. An
unpublished course is `404` for everyone but its owner.

`POST /courses/status` takes up to 500 ids and omits any id the server does
not know. `currentVersion` is `null` when the course is no longer published.

`POST /courses/:id/download` records an acquisition and sends the archive with
`X-OpenCourse-Version` and `X-OpenCourse-Sha256` headers. A course's
`downloads` is the number of distinct accounts that added it; updates are
recorded but never counted.

## Publishing

| | | |
| --- | --- | --- |
| `POST /courses/:id/versions` | the archive, `application/zip` | `201` for a new course, `200` for a new version. Returns `{ courseId, version, created }`. |
| `GET /me/courses` | | `{ courses: ManagedCourse[] }` |
| `GET /courses/:id/versions` | | `ManagedCourse` (owner only) |
| `PUT /courses/:id/current` | `{ version }` | Rollback, or forward again. Returns `ManagedCourse`. |
| `DELETE /courses/:id/versions/:version` | | Refused for the current version. Returns `ManagedCourse`. |
| `DELETE /courses/:id` | | Unpublish: hidden, nothing deleted. Returns `ManagedCourse`. |
| `POST /courses/:id/relist` | | Listed again. Returns `ManagedCourse`. Refused with `403 moderated` for a course a moderator removed. |

A release note travels in the `X-OpenCourse-Release-Note` header,
percent-encoded, up to 2000 characters.

An archive is accepted when all of these hold:

- It passes the app's archive policy: no paths escaping the archive, no
  symlinks, only allowed file types, at most 200 MB packed and 1 GB unpacked.
- Its `course.json` is valid against the course schema at `schema_version` `"1.6"`.
- Every element, and the course itself, carries a lowercase UUID v4 `uid`. No
  uid appears twice, and the course's `uid` equals `:id`.
- `version` is higher than every version ever published for this course.
- Every element uid is either new to the server, or already belongs to this
  course with the same kind. A flashcard keeps the lesson it belongs to.
- Every referenced asset is in the archive.

An unknown `:id` creates a course owned by the caller. A known one must belong
to the caller. Publishing a new version lists an unpublished course again, but
never a course a moderator removed. `ManagedCourse.moderation` is
`{ at, reason }` for such a course.

## Administration

An account with the `admin` role runs the server's admin console. The first
one is made on the server's machine with `npm run admin -- grant-admin <name>`.
Every route below answers `403 not_admin` to anyone else, and every change is
written to the audit log.

| | | |
| --- | --- | --- |
| `GET /admin/stats` | | `AdminStats`: accounts, courses, versions, downloads in the last 30 days, storage |
| `GET /admin/accounts?q=&page=` | | `Paged<AdminAccount>` |
| `POST /admin/accounts/:id/disable` | | `AdminAccount`. Signs the account out everywhere and refuses its logins. |
| `POST /admin/accounts/:id/enable` | | `AdminAccount` |
| `PUT /admin/accounts/:id/role` | `{ role }` | `AdminAccount` |
| `GET /admin/courses?q=&state=&page=` | | `Paged<AdminCourse>`; `state` is `listed`, `unlisted` or `moderated` |
| `POST /admin/courses/:id/moderate` | `{ reason }` | `AdminCourse`. Removes the course from the catalog and mails its owner the reason. |
| `POST /admin/courses/:id/restore` | | `AdminCourse`; lists it again |
| `GET /admin/audit?q=&page=` | | `Paged<AuditEntry>`, newest first |

An administrator cannot disable or demote themselves, and the last
administrator cannot be disabled or demoted. A moderated course is hidden
exactly like an unpublished one: `404` to everyone but its owner, and out of
every listing and search.

## Identity

A server course's `uid`s are what an app uses as its own IDs for that course
(`app/src/core/catalog/identity.ts`). When an author publishes, the app sends
their course's existing IDs as `uid`s. When a learner adds or updates, the
app installs the `uid`s as the course's IDs. That is how an update keeps
progress on edited lessons, and why a course can be in a library only once.
A `.zip` imported locally always gets fresh IDs, and **Export ZIP…** never
writes `uid`s.
