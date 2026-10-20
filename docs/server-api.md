# OpenCourse server API — v1

The contract between an OpenCourse server and its two clients: the OpenCourse
app and the server's own web app. The types are
`app/src/core/catalog/api.ts`, shared by both sides, and the app checks every
response with `app/src/core/catalog/parse.ts`. Change all three together.

Everything is under `/api/v1`. Most responses are JSON; packages use
`application/zip`, PDF readers use authenticated byte ranges, and chat events
use `text/event-stream`. Learning types are shared in
`app/src/core/learning/types.ts`.

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
| `POST /auth/register/start` | `{ email }` | `202`. Mails a 6-digit code, or, for an address that already has an account, the same verification code flow. The answer is the same either way. |
| `POST /auth/register/verify` | `{ email, code }` | `{ ticket }` for a new address, valid 15 minutes; `{ existingAccount: true }` for an existing address (no session or ticket). A wrong code gives `400 invalid_code` with `attemptsLeft`. |
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
- Its `course.json` is valid against the course schema at `schema_version` `"1.8"`.
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

## Identity and capability negotiation

`GET /server` additionally returns immutable `id` and `capabilities`, including
`learning-sync-v1`, `documents-v1` and `server-chat-v1`. Missing capabilities
retain the previous catalog/download behavior; clients must not assume the
new routes exist. `PUT /me/username { username }` changes the display/login name
without changing the account ID, enrollment or progress.

After verifying an existing email, clients show its prefilled email and require
the password through ordinary login. Verification never authenticates an
existing account. Closed registration still allows ordinary existing-account
sign-in and password recovery.

Modern clients identify content by `(serverId, kind, publishedId, version)` and
scope private state to the immutable account ID. They keep mappings to local
course and element IDs; migration preserves old local IDs where possible.
Identical published UUIDs on two servers, and identical PDFs on two sources,
are independent library entries. Email and username changes do not remap them.
Replacing a server account cannot transfer pending operations or private chats.
A locally imported ZIP gets fresh IDs; exporting never includes remote IDs.

## Documents

| Method and path | Behavior |
| --- | --- |
| `GET /documents?q=&tag=&sort=&page=` | `{ documents: PublishedDocument[], total, page, pageSize }`, 30 per page. `tag` may repeat (all must match, ignoring case); `sort` is `downloads`, `recent` or `title`, newest first without one |
| `GET /documents/tags` | `{ tags: [{ tag, count }] }` over listed documents, most used first |
| `GET /documents/:id` | Metadata, outline, indexing state, versions and release notes |
| `GET /documents/:id/cover` | Validated PNG/JPEG/WebP cover |
| `GET /me/documents` | Publisher's managed documents, separate from My learning |
| `POST /documents/:id/versions` | Desktop-only ZIP upload; returns published document |
| `PUT /documents/:id/current { version }` | Explicit publisher rollback/forward |
| `DELETE /documents/:id` | Unpublish; retained enrolled access remains |
| `POST /documents/:id/relist` | Relist unless moderated |
| `DELETE /documents/:id/versions/:version` | Revoke access and delete retained files; keep version reserved |
| `POST /documents/:id/versions/:version/reindex` | Retry bounded background indexing |
| `POST /admin/documents/:id/moderate { reason }` | Revoke server reading/AI; retained history remains |
| `POST /admin/documents/:id/restore` | Restore catalog access |

A package contains `document.json`, `document.pdf` and optional `cover.png`,
`cover.jpg`, `cover.jpeg` or `cover.webp`. Metadata contains `title`, `description`,
`tags`, semantic `version`, optional `cover` filename and `releaseNote`.
Versions are immutable, increasing, checksummed and owned by the publisher.
Protected PDFs are rejected. A `PublishedDocument` also carries `downloads`
(accounts that ever added it), `updatedAt` (when its current version was
published), `maxVersion`, and - for its owner only - `moderated: true` once a
moderator removed it. Index status is `indexing`, `ready` or `error`;
PDF reading is available during indexing, while search may be incomplete.
No progress, credentials or local conversations belong in a publication.

## Enrollment and learner access

| Method and path | Behavior |
| --- | --- |
| `GET /me/learning` | `{ items: LearningState[] }`, active enrollments; each item's `hasCover` says whether its version has a cover |
| `PUT /me/learning/:kind/:id { version? }` | Enroll, or explicitly accept the specified version |
| `DELETE /me/learning/:kind/:id` | Synchronize unenrollment; retain progress/chats |
| `GET /learn/:kind/:id/:version` | Learner-safe course or document metadata and learning state |
| `GET /learn/:kind/:id/:version/cover` | The held version's cover image, sandboxed; 404 when it has none |
| `GET /learn/:kind/:id/:version/download` | Version-specific authenticated package/PDF with hash headers; course ZIPs require desktop authentication |
| `GET /learn/document/:id/:version/pdf` | Authenticated PDF, supports `Range: bytes=start-end` |
| `GET /learn/document/:id/:version/search?q=` | Bounded matching excerpts and indexing status |
| `GET /learn/course/:id/:version/assets/*` | Restricted version-scoped assets; isolated HTML sandbox |
| `POST /learn/course/:id/:version/quiz/:quiz { submitted, requestId }` | Grade, record a deduplicated attempt, reveal explanation |
| `POST /learn/course/:id/:version/cards/:card/reveal` | Reveal after the lesson is marked read |
| `POST /learn/course/:id/:version/cards/:card/rate { rating, requestId }` | Record review and replay shared FSRS scheduling |

`kind` is `course` or `document`. Acquisition counts are analytics, not
enrollment. Ordinary unpublishing removes discovery/new enrollment while
existing learners retain versions. Moderation/deletion revokes server reading
and AI; history stays readable. Existing desktop copies are not remotely erased.
Removing a download is a device-only action. Web cannot complete exercises or
projects, execute Python/notebooks, upload content or use Coach.

Course progress follows stable surviving element IDs; removed IDs remain
historical. PDF progress is scoped by PDF hash: metadata-only versions share
it, changed bytes start a separate record. Versioned chats keep their original
context. Accepting an update changes the shared enrollment selection; an older
device cannot silently change it back.

## Synchronization

`GET /sync?cursor=N` returns `{ changes, cursor, more, serverTime }`. Pages are
account-scoped and bounded; each change carries `cursor`, `type` (`state` or
`chat`), `key` and `value`. A state change is the item's whole state, so the
feed keeps only the latest one per item. Inactive enrollments are tombstones in state changes. Deleted conversations use a chat change with `value: { deleted: true }`; clients remove that account’s cached conversation.
Cursors are opaque positions; persist only after applying the page transaction.

`POST /sync { operations: LearningOperation[] }` accepts at most 100 operations
and returns `{ accepted, rejected: [{ id, code }], serverTime }`. Operations
carry `idempotencyKey`, `kind`, `id`, `version`, enrollment `generation`, reset
`epoch`, `at` (milliseconds), `field` and `value`. Stable IDs deduplicate lost
acknowledgments. Unknown/invalid fields are rejected. Fields include lesson
read flags, quiz/review events, exercise/project completion summaries, last
item, PDF position/read page and preferences (including per-item reading size and PDF zoom).
`code:<exercise>` is the learner's own code for one exercise, a string of at
most 64,000 characters, so the web editor and the desktop workspace open on the
same text; only its latest value is kept (the event log records the operation
without it). Project files, outputs, notebook
state, authoring chats and Coach data are never accepted as sync payloads.

Fields resolve by latest action timestamp, then stable operation ID. Server
receipt clamps future timestamps; desktop estimates and persists server clock
offset. Ordering under large offline clock changes is approximate. Quiz/review
events remain deduplicated history; review scheduling replays deterministically.
Explicit resets advance the epoch, unenrollment/re-enrollment changes the
generation, and delayed operations cannot resurrect old state. Browser sync
cannot directly submit exercise/project results, quiz grades or review states.

Desktop sync pulls first, overlays pending local actions, pushes, pulls again,
and installs selected downloads with checksums. Local edits persist immediately
with journal/outbox recovery. Uploads debounce 2 seconds with a 10-second maximum;
active pull is every 30 seconds. Failures back off with jitter to 5 minutes;
connectivity/resume/manual retry restart synchronization. One unavailable server
does not block local learning or other servers.

## Reading AI

| Method and path | Behavior |
| --- | --- |
| `GET /me/ai` | Configured status, masked hint, study-chat `model` and `reasoning`, web-search preference, `title` defaults, `enabledModels`, enabled status |
| `PUT /me/ai { key?, model?, reasoning?, webSearch?, title?, enabledModels? }` | Update account-specific encrypted connection/settings |
| `GET /me/ai/models` | `{ models, source, error? }`: the key's chat models, or a curated list (`source: "fallback"`) without a key or an answer |
| `DELETE /me/ai` | Revoke the stored key and stop active generations |
| `GET /learning/chats?kind=&id=` | Account/content reading conversations |
| `POST /learning/chats { kind, id, version }` | Create a version-bound conversation |
| `GET /learning/chats/:id` | Durable ordered messages and generation status |
| `DELETE /learning/chats/:id` | Delete an owned conversation, cancel its generation, and synchronize a chat tombstone |
| `POST /learning/chats/:id/messages { text, requestId, quote?, model?, reasoning? }` | Deduplicated server-owned generation |
| `GET /learning/chats/:id/events?after=N` | Resumable SSE (`Last-Event-ID` also accepted) |
| `POST /learning/chats/:id/cancel` | Cancel the active provider request |
| `POST /learning/chats/import` | Desktop-only deterministic one-time legacy reading-history import |

The authenticated account, enrollment and version determine permitted tools.
Only bounded read-only course/document retrieval and optional provider web
search are available. Model arguments cannot select another account, arbitrary
content, filesystem path, shell or writing tool. Retrieval strips quiz keys,
solutions and unrevealed flashcard answers. Credentials never return in these
responses. One active generation per conversation; account limits also apply.
A restart marks running answers interrupted and never automatically bills again.
Offline desktop readers can view cached history and keep drafts; sending
requires this server and its configured API key. Local credentials are never a
fallback. Subscription connections are outside this release.

A server runs two AI activities, each with its own model and reasoning level:
study chat (courses and documents alike) and naming its conversations. Course
authoring and Coach run in the desktop app on the app's own settings.
`reasoning` is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or
`null` (send none: the model's default). A level the model does not take, as
judged from its id, is stored as `null` in the same write that chose the model.
`title` is `{ model, reasoning }`, or `null` to name a chat with its own model
at `low` when the model takes it. Web search is sent only to a model that can
search at its level.

Reading-chat summaries include `messages`, `lastMessageAt`, and `running`. History is ordered by latest message. A chat is titled from its first question until, after its first complete answer, a separate best-effort request names it; a failed naming leaves the question as the title and is tried again after the next answer. Opening or closing a UI draft tab does not create a server conversation; clients create it only on first send. Closing a saved tab retains its history.

`enabledModels` is `null` to offer all models (including future models), an array
of model IDs to offer only those, or `[]` to disable chat. A nonempty list must
include the default model. Composer `model` and `reasoning` overrides apply to
that question without changing account defaults; disabled models are rejected.
Messages retain the actual model and reasoning for restoring conversation choices.

An optional `quote` (up to 8,000 characters) is stored separately from the
question and included in the model's context. Assistant messages retain web
citation positions (`start`, `end`) and local reading destinations. While running,
`activity` carries a tool label and its running state; SSE `activity` events tell
clients to refresh it, alongside `delta` and `done` events.
