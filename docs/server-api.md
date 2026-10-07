# OpenCourse server API — v1

The contract between the OpenCourse app and an OpenCourse server. The types are
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

**Authentication.** `Authorization: Bearer ocs_…`, where the token comes from
sign-up, login or a password reset. Catalog reads work without one; with one,
the server can say which courses are yours.

## Server

`GET /server` returns
`{ "opencourse": 1, "api": 1, "name", "description", "registration": "open" | "closed" }`.
A client refuses an `api` it does not know.

## Accounts

| | | |
| --- | --- | --- |
| `POST /auth/register/start` | `{ email }` | `202`. Mails a 6-digit code, or, for an address that already has an account, a note saying so. The answer is the same either way. |
| `POST /auth/register/verify` | `{ email, code }` | `{ ticket }`, valid 15 minutes. A wrong code gives `400 invalid_code` with `attemptsLeft`. |
| `GET /auth/username?name=` | | `{ available, reason? }` |
| `POST /auth/register/complete` | `{ ticket, username, password }` | `201 { token, account }` |
| `POST /auth/login` | `{ login, password }` | `{ token, account }`. `login` is an email or a username. Every failure is the same `401`. |
| `POST /auth/logout` | | `204`; revokes this token |
| `GET /auth/me` | | `{ account }` |
| `POST /auth/password/forgot` | `{ email }` | `202`, whether or not the address has an account |
| `POST /auth/password/reset` | `{ email, code, password }` | `{ token, account }`; every other token is revoked |

**Rules** (`usernameProblem`, `emailProblem` and `passwordProblem` in `api.ts`):

- **Username:** 3–32 characters, lowercase letters, digits, `-` and `_`,
  starting and ending with a letter or digit, and not a reserved name.
- **Password:** 8–256 characters.
- **Code:** 6 digits. It expires after 10 minutes and allows 5 attempts.

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
| `POST /courses/:id/relist` | | Listed again. Returns `ManagedCourse`. |

A release note travels in the `X-OpenCourse-Release-Note` header,
percent-encoded, up to 2000 characters.

An archive is accepted when all of these hold:

- It passes the app's archive policy: no paths escaping the archive, no
  symlinks, only allowed file types, at most 200 MB packed and 1 GB unpacked.
- Its `course.json` is valid against the course schema at `schema_version` `"1.5"`.
- Every element, and the course itself, carries a lowercase UUID v4 `uid`. No
  uid appears twice, and the course's `uid` equals `:id`.
- `version` is higher than every version ever published for this course.
- Every element uid is either new to the server, or already belongs to this
  course with the same kind. A flashcard keeps the lesson it belongs to.
- Every referenced asset is in the archive.

An unknown `:id` creates a course owned by the caller. A known one must belong
to the caller. Publishing a new version lists an unpublished course again.

## Identity

A server course's `uid`s are what an app uses as its own IDs for that course
(`app/src/core/catalog/identity.ts`). When an author publishes, the app sends
their course's existing IDs as `uid`s. When a learner adds or updates, the
app installs the `uid`s as the course's IDs. That is how an update keeps
progress on edited lessons, and why a course can be in a library only once.
A `.zip` imported locally always gets fresh IDs, and **Export ZIP…** never
writes `uid`s.
