# OpenCourse

Courses on any subject as a macOS desktop app. One window, no account needed:
lessons, interactive visualizations, quizzes, and — for the courses that want
them — runnable, auto-graded coding exercises. When you want to share courses,
connect to an **OpenCourse server** (`server/`): browse its catalog, add courses
and keep them updated, and publish your own.

Download it from **[opencourse.dev](https://opencourse.dev)**, which also hosts
these docs; the public catalog is **[catalog.opencourse.dev](https://catalog.opencourse.dev)**.
Free and open source under the [MIT License](LICENSE).

And two ways to ask. **Side chat** opens beside the lesson you are reading:
highlight a paragraph, ask what it means, ask for it a different way. **Coach**
is the other one — learn something by talking about it, a spoken conversation
with an OpenAI voice model that keeps its own notes between sessions, so the
next one picks up where the last stopped. Those two use an OpenAI API key or a
connected ChatGPT subscription; the servers you connect to are the only other
place the app goes online.

A course does not have to be about programming. Markdown, images,
visualizations and quizzes are the whole format; the `exercise` block is an
extra any course may reach for, in Python using the bundled interpreter, whatever its subject. Projects may
use any language with user-managed tools.

The app ships **no courses**. You pick or create a local user, then import
course archives into that user's library, or add courses from a server's
catalog; everything they own — courses, server connections,
progress, exercise files, environments, coaches and their transcripts — lives in
one app-managed directory.

```
content/                    courses you are authoring (gitignored; the content gates check them)
content-zip/                importable .zip of each course (generated, ignored)
app/tests/fixtures/courses/ the committed courses every test, smoke run and screenshot uses
app/                        the Electron app (TypeScript, React)
app/src/core/toolchains/    Python exercise layout, provisioning and check plans
app/src/core/coach/         the pure half of Coach: prompt, tools, event reducer
app/src/core/sidechat/      the pure half of side chat: lesson context, thread rules
app/src/core/catalog/       server courses: identity, versions, the API contract
server/                     the OpenCourse server: accounts, catalog, publishing, and its web app
server/web/                 the server's web app (React): catalog, accounts, my courses, admin
site/                       opencourse.dev (Astro, static): the app, the download, these docs
design/                     the web's design layer: the app's tokens, shared by site and web app
docs/getting-started.md     the user's guide, from download to publishing
docs/self-hosting.md        running a catalog server: Docker, mail, admin, backups
docs/course-format.md       the course format, v1.6
docs/server-api.md          the server API, v1
.github/workflows/          CI, app releases, the website, the server image
docs/example-course/        a minimal course exercising every block type
app/src/core/theme/         themes: the format, its compiler and its contrast audit
docs/theme-format.md        the theme format, v1
docs/default-theme/         the app's own look, written out as a theme
docs/example-theme/         a theme using every part of the format
```

## Running it

Node 22 or newer (`.nvmrc` pins 22.22.0 — `nvm use` picks it up):

```bash
cd app
nvm use
npm install
npm run dev
```

Other things you can run from `app/`:

| Command | What it does |
| --- | --- |
| `npm test` | Unit + integration tests over the course logic, toolchains, users, course import, Coach and side chat. Never touches the network |
| `npm run validate:content` | Validates every course in `content/` — schema, assets, ids |
| `npm run zip:course [slug]` | Packs `content/<slug>/` into `content-zip/<slug>.zip` for importing; no slug packs them all |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | Boots the app on a throwaway profile and drives the real renderer through 146 checks, including simulated subscription streaming and project tools; writes a report to `/tmp/opencourse-smoke.json` |
| `npm run shots` | Screenshots the app's own screens into `/tmp/opencourse-shots` (uses `capturePage`, so no screen-recording permission) |
| `npm run dmg` | Unsigned `OpenCourse-mac-arm64.dmg` into `app/dist/`. Releases are built by CI, signed when it has the credentials (see [Releasing](#releasing)) |

```bash
npm run check:exercises   # every solution must pass, every starter must fail
```

## Side chat

Reading a lesson and want to ask something about it? The **Ask** button in the
top-right corner opens a chat beside it. The whole lesson goes to the assistant 
with your first question, so you can ask what a paragraph means, ask for the same 
idea a different way, or push past where the lesson stopped.

Highlight a passage first and an **Ask about this** button appears; what you
highlighted is attached to the question, so "what does this mean?" is about
that, not about the lesson at large. Text inside a visualization works the same
way, fullscreen included, and so does text in the chat's own answers: highlight
the one sentence of a reply you did not follow and ask about just that.

Under the box you write in are the model that answers and, for models that
reason, how hard it thinks first — **Default** leaves that to the model. Both
belong to the chat, so each tab keeps its own. **Settings → Chat** selects the
connection and the models you want to choose between. The API-key and
subscription profiles each keep their own allowed models, default model, and
default reasoning. **Model default** leaves reasoning to the model.

**Settings → Web search** lets the chat look things up when a question needs it -
a release date, a current version, documentation the lesson does not quote. It
is off until you turn it on. Searches use the selected connection when the model
supports them, and the
model still decides question by question whether to search. An answer that used
the web ends with its sources: numbered to match the markers in the text, each
with the site's icon and a shortened page title, and a click opens the page in
your browser.

You can keep several chats going as tabs and close them without losing them —
closing a tab puts the chat back in **History**, which lists every chat you have
had about this course. Chats are stored per person and per course: you never see
another user's, or another course's.

A chat is not tied to the lesson it was started in. Carry one to the next lesson
and that lesson is sent too, while everything said so far is kept — so "so how
does this relate to what we just discussed?" works.

Connect an **OpenAI API key** or use **Continue with ChatGPT** in
**Settings → Connections**. API requests use API billing; eligible subscription
requests use your ChatGPT plan. Available subscription models depend on the
account and workspace you choose during sign-in. **Manage usage** opens ChatGPT
usage settings. If authorization expires or a plan limit is reached, OpenCourse
asks you to reconnect or manage usage; it never switches to API billing automatically.

Changing a feature’s connection takes effect on its next message, keeps history,
and resets the conversation’s model and reasoning to the destination profile’s
defaults. Responses already running finish with their original connection.
Changing defaults alone keeps existing individual selections. Removing a model
from an allowlist resets affected conversations to that profile’s valid default.

Connections are separate for each local user. API keys and subscription tokens
stay in Electron main, encrypted with the macOS keychain. If encryption is
unavailable, credentials last only until the app quits. You can save several
subscription account/workspace registrations, select one, and disconnect it in
Settings. Quiz answers and exercise solutions are
kept out of what the assistant is told, deliberately: it is there to explain
until you can answer, not to answer for you.

The subscription connection uses the official [Sign in with ChatGPT integration](https://developers.openai.com/siwc/token-sharing-open-source)
and calls the Responses API directly; it does not require a Codex installation.
Project reviews and course-authoring runs enable OpenAI's automatic
[context compaction](https://developers.openai.com/api/docs/guides/compaction)
with either connection. The threshold follows
[Codex's rule](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs):
90% of the selected model's configured context window, or a lower explicit
threshold from its catalog. Live catalog metadata takes precedence over bundled
defaults; unknown models without metadata use OpenAI's automatic threshold.
For the current Sol, Astra and Terra defaults, this is 244,800 tokens out of a
272,000-token window. Long tool runs continue using the
encrypted compacted state, while explicit instructions and subsequent tool
results stay in context. Compaction does not change saved chat history or draft
edits; tool-call, round and time limits still apply.
For a manual live check, `OPENCOURSE_LIVE_CHECK=1 npm run preview` starts an isolated
local profile. Browser sign-in requires the account owner; disconnect the test
registration when finished.

## Coach

A coach is a voice conversation with a purpose. You tell it what you want to get
better at — French vocabulary, a viva, chess openings — and talk to it. It
answers out loud, and between sessions it keeps notes so the next one starts
where the last one stopped rather than from nothing.

Each coach gets a workspace directory of its own. The coach writes into it while
you talk, using its own file tools: typically a `context.md` of what the project
is for and how it is going, a `learned.md`, and a `review.md` of what to come
back to. It can also search the web mid-conversation when it needs a fact it is
not sure of.

Those files are **yours to read, not to edit in the app**. Text files open in a
read-only viewer; anything else is listed with its size and can be moved between
folders or deleted, but not opened. Deleting moves a file to the coach's `trash/`
so a mis-click is recoverable. There is deliberately no way to edit a coach's
notes from inside OpenCourse — the way to change what it thinks is to tell it.

Every session is transcribed and kept, and clicking one shows what was said,
alongside the brief the coach was running with at the time.

### What it costs, and what it keeps

You need an **OpenAI API key**, which OpenCourse asks for the first time you start a
session. It is encrypted with your macOS keychain and stored per user, on this
Mac; OpenCourse sends it to OpenAI and nowhere else, and never shows it again once
saved. If your Mac has no keychain available, OpenCourse will not write the key down
at all — it keeps it for that launch only and says so. Each person using OpenCourse
on this Mac needs their own key, because a key is what OpenAI bills.

Voice models bill by the minute. The live panel shows how long a session has run
and stops one at 45 minutes; beyond that the bill is between you and OpenAI.

Transcripts are stored **in plain text** in a local SQLite database under the
app's data directory, the same way your course progress is plain JSON. Deleting
a coach deletes its sessions, its transcripts and its files; deleting a user
deletes everything of theirs, coaches included.

The microphone is only ever opened while a session is running — the app refuses
the permission outright at any other time.

## How it fits together

- **A course is a directory** with a `course.json` manifest and an `assets/`
  tree, distributed as a `.zip` of it. `docs/course-format.md` is the contract;
  `app/src/core/course-schema.json` enforces it. Nothing ships with the app —
  **Library ▸ Import course…** unpacks an archive to a staging directory,
  validates it there, and only then moves it into your library.
  **Get the course format…** saves the spec, the schema and an example course
  that imports as-is.
- **Users are local and passwordless.** A user is a name and a folder. Each has
  their own library and their own progress, and deleting one deletes
  everything it owns:

  ```
  ~/Library/Application Support/opencourse/
  ├── users.json
  ├── logs.db                   the app's log - each line names its user, or none
  ├── updates.json              whether to check for app updates on its own (off unless turned on)
  ├── updates/                  a download in progress, the swap helper and its result
  └── users/<user-id>/
      ├── courses/<course-uuid>/    document.json, package/ (a server course's uuid is the server's)
      ├── progress/<course-uuid>.json  one file per course
      ├── workspace/<course-uuid>/  exercises/<block-uuid>/ and environments
      ├── themes/<theme-uuid>/   files/ (the archive) and meta.json
      ├── servers/              servers.json and one keychain-sealed token per server
      └── coach/coach.db        coach transcripts and side chats, in one database
  ```
- **The app keeps a log, and you can read it.** User menu ▸ **Logs** lists what
  the app did - requests OpenAI refused and why, imports, crashes, renderer
  errors - newest first, with search, filters by level, source and time, and
  sortable columns. You see your own lines and the general ones (startup,
  anything before a user was picked), never another user's. Lines are kept 30
  days; keys and the text of your conversations are never logged. Under
  `npm run dev` every line is also printed to the terminal.
- **Themes change how the app looks, never what it does.** A theme is a zip of
  `theme.json` plus pictures and fonts, imported per user in **Settings ▸
  Appearance** and chosen there or from **View ▸ Theme**. It sets colours,
  opacity, grain, pictures, fonts and the titlebar mark - values for the
  stylesheet's own tokens, compiled by `app/src/core/theme/`, never CSS. The
  app ships Dark (the default) and White, with the same logo, typography and
  layout. Choose either in Settings or View; built-in themes cannot be removed.
  app's own look is not a theme but the absence of one; it is exported as
  `docs/default-theme` to start from, and a test keeps the two identical.
  `docs/theme-format.md` is the contract; **Help ▸ Get the theme format…**
  saves it with the schema and both example themes.
- **Nothing is compiled or ingested.** The app validates a manifest on load and
  renders its blocks: markdown (markdown-it + Shiki, sanitized through an
  explicit allowlist), images, video, sandboxed visualization bundles, quizzes,
  and exercises.
- **Assets are served over `opencourse://<course-uuid>/<path>`**, resolved strictly
  inside that course's directory. Visualizations additionally run in an
  `<iframe sandbox="allow-scripts">` with no same-origin access and a
  restrictive CSP, so a bundle can only reach its own files.
- **Progress** is one JSON file per course per user, keyed by app-local UUIDs.
  Editing, renaming and moving elements preserve learner state. Duplicates receive
  fresh identities. Saving deletions cascades to attached progress, messages and files.
- **Course editor** supports the complete format, Markdown previews, code fields
  and uploaded media/HTML attachments. Blocks have editable, lesson-scoped slugs
  displayed beside their type icons in the outline. Every block must declare a slug;
  imports and saves reject missing names. Drafts autosave; explicit Save validates and
  publishes. ZIP export contains the saved portable course and assets only.
- **Exercises run in the app.** "Open editor" puts the exercise's task beside
  your file: the chapter list stays on the left, the task (prompt, how to
  verify, hints) next to it, and on the right your file in a real editor with
  the checks below it and an interactive terminal in the exercise directory.
  That editor is the only way into an exercise. "Run checks" saves, runs the
  exercise's plan, streams the output, and marks the exercise complete when it
  goes green — completion is earned, not self-reported.
- **An exercise is correct when it exits 0.** That is the entire grading
  contract. Python exercises use pytest checks or compare the program’s stdout
  against an expected-output contract.
- **The files are the source of truth.** The workbench edits
  `…/workspace/<course>/<module>/<lesson>/<exercise>/exercise.py` on disk;
  if the file changes underneath the editor (from its own Terminal tab, say)
  you are asked which version wins. Your file is written once and never
  overwritten.
- **Python is bundled with the app.** Exercises are Python-only. OpenCourse
  builds a local `.venv` per course using its bundled interpreter, then installs
  pytest and course packages there. System Python is never selected. Version
  settings are minimum requirements; update OpenCourse for a newer runtime.
  Projects may use any language and have user-managed tools and setup.

## Authoring

Edit `course.json` by hand, then:

```bash
cd app
npm run validate:content    # schema + assets + unique ids + every exercise plans
npm run check:exercises     # exercises actually work, using bundled Python
```

Both run in CI-friendly, non-interactive mode and are the two gates a course
has to pass. They check every course in `content/`, plus the committed example
and test fixtures; `npm test` checks only the committed ones, so it passes or
fails the same on every machine.

To see your changes in the app, pack the course and import it:

```bash
cd app && npm run zip:course <slug>   # → content-zip/<slug>.zip
```

Then **Library ▸ Import course…**. Every import creates a new library course,
even when the slug matches an existing course. Use **Edit course** to change an
existing course while preserving progress, or **Create course** to author one
directly in the app. **Export ZIP…** on a course's page downloads the last saved
version in format 1.6. **Get the course format…** saves the spec, schema and an
example course.

Nothing you change in the editor — by hand or through the assistant — is
written to the course until **Save** (⌘S). The title shows whether there are
unsaved changes; leaving with some asks first, and *Discard changes* leaves the
course as it was saved. A new course appears in the library at its first save.
Every course has a **Version** (Course details), `0.1.0` to start; raise it when
you publish a new version to a server.

The course editor has **Manual** and **AI** modes beneath its title. AI mode
keeps the course outline on the left, shows the selected content in the preview,
and opens a course assistant on the right. Ask it to create a whole course or
revise any module, lesson, block or project. Each message includes your current
selection automatically, while every chat tab can edit the entire course.
Tabs and their history belong to this course and survive saving and reopening.
Choose the connection, default model and reasoning in **Settings → Course creation**;
each tab can override its model and reasoning.
Select text in the preview and choose **Ask about this** to attach the passage
to your message. It stays highlighted while you write your question.

Block previews use the lesson components, including interactive quizzes and
media. Selecting a lesson shows its header, objectives and all its blocks.
Quiz checks in the preview do not change learner progress. Exercise previews
show the task and preset files; **Edit file** switches to Manual and saves
starter code, support files, tests or solutions to the course draft.

AI edits appear immediately in the editor, unsaved like your own. Switch
back to Manual to edit them yourself. During an AI response, editing and saving
are paused; stopping the response in the chat keeps all completed changes and
unlocks the editor.
The assistant can create SVG images and offline HTML/CSS/JavaScript bundles,
include exercise/project supporting files, and reuse uploaded media. **Save**
validates the course and assigns permanent identities to new elements. Chat
history and temporary authoring references are excluded from exported ZIPs.

## Servers

An OpenCourse server (`server/`, see its README) hosts courses, versions them
and gives each person an account. In the app:

- **Settings → Servers → Connect to a server…** — type its address. Create an
  account without leaving the app (email, a 6-digit code from that email, a
  username, a password) or sign in. Every server has its own account; the app
  keeps a token per server in the macOS keychain, never the password. Pick
  which connected server the catalog shows.
- **Library → Course catalog** — the server's courses, searchable by keyword
  and tag, with versions and download counts. Open one to read its overview,
  then **Add to my courses**. A course can be in your library only once.
- **My courses** marks every course **Local** or with the server it came from,
  and its version. When the server has a newer version, the course offers
  **Update…**: it says what the new version removes before installing, and
  keeps your progress on everything that still exists, even where it changed.
- A course you added is the server's: **Edit course** works, but saving your
  edits creates a local copy and leaves the downloaded course as it was.
- **Publish…** on a course's page sends it to a server you are signed in to.
  Versions only go up: raise the version in the editor before publishing
  again. **Manage publication** lists every version with its downloads, makes
  an older one current again (a rollback), deletes versions, or unpublishes
  the course.

Run one locally with `cd server && npm install && npm run dev`, then connect to
`http://localhost:8787`. Sign-up codes appear in that terminal. The same command
serves the server's web app at <http://localhost:5173>: the catalog, accounts,
**My courses** (rollback, unlist and delete versions from a browser) and, for an
administrator, moderation. `npm run seed` fills it with courses to look at, and
[`docs/self-hosting.md`](docs/self-hosting.md) covers running one for real.

## The website

`site/` is opencourse.dev: an Astro site, built to static files. Its docs are
this repository's `docs/`, its download button is GitHub's permalink to the
newest release's DMG, and its star count and version come from GitHub's API at
build time - a visitor's browser loads nothing from anywhere else.

```bash
cd site
npm install
npm run dev          # http://localhost:4321
npm run build        # dist/, plus the Pagefind index for the docs search
npm run check        # astro check, then every link, anchor and download in dist/
```

## Releasing

1. Raise `version` in `app/package.json` and commit.
2. Tag it: `git tag v0.3.0 && git push origin v0.3.0`.
3. `.github/workflows/release.yml` builds `OpenCourse-mac-arm64.dmg` on macOS
   and uploads it to a **draft** release - signed and notarized when the
   repository has the Apple secrets the workflow lists. Otherwise it is ad-hoc
   signed, which is what lets macOS offer **Open Anyway** rather than call the
   app damaged, and marked as unsigned on the release, which makes the website
   show how to open it.
4. Write the notes and publish the draft. opencourse.dev rebuilds itself with
   the new version.

The catalog server is released the same way with a `server-v<version>` tag,
which publishes `ghcr.io/s3298321/opencourse-server`.

## macOS, `~/Documents`, and Electron

This checkout lives under `~/Documents`, which macOS protects with TCC. An
ad-hoc-signed app bundle inside a protected folder **will not start** when it is
launched from a terminal: the process wedges in `dyld` at 0% CPU, forever, with
no error, no prompt and no crash report. Electron installs its binary into
`node_modules`, so `electron-vite dev` inherits that.

`npm run dev`, `preview`, `smoke` and `shots` therefore go through
`scripts/electron-dist.mjs`, which mirrors the Electron binary into
`~/Library/Caches/opencourse-electron` (once per Electron version) and replaces
`node_modules/electron/dist/Electron.app` with a symlink to it — so whatever
launcher runs, the binary that actually executes lives outside the protected
folder. (`ELECTRON_OVERRIDE_DIST_PATH` alone is not enough: electron-vite
spawns the bundle in `node_modules` directly.) If the repo ever moves somewhere
unprotected the script copies nothing and uses `node_modules` as-is.

Two permanent alternatives, if you prefer: move the checkout out of
`~/Documents`, or grant your terminal Full Disk Access in
System Settings → Privacy & Security.

Packaging is unaffected — `electron-builder` uses its own cache. Drag the built
`OpenCourse.app` to `/Applications` and it launches normally.

## Keyboard

| | |
| --- | --- |
| `⌘L` | Library |
| `⌘S` | Save the course in the editor |
| `⌘⇧C` | Coaches |
| `⌘F` | Find in course |
| `⌘[` / `⌘]` | Previous / next lesson |

The app uses soft charcoal surfaces, off-white text, and brighter off-white buttons. Selected navigation items and chat tabs keep light text over a subtle dark-grey gradient. The title bar has a smooth black tint at 52% opacity without grain; the user picker, course and Coach lists, course sidebar, and lesson/project chat panes use a black tint at 25% opacity over macOS glass. A fine, static monochrome grain gives those surfaces and popovers a frosted texture without affecting text. Course overviews, lesson content, and editors stay opaque for reading. Screen content fades into place once its data has loaded, while the title bar stays steady; Ask slides in, and newly sent chat bubbles ease upward. Reduced motion disables these effects without remounting editors or clearing drafts. Reduced transparency and increased contrast make glass surfaces opaque and remove the grain.

### Course projects

Courses using schema version 1.3 can include project modules alongside lesson modules.
A project opens a persistent per-user folder, with its requirements and deliverables
on the left and a project assistant on the right. Open the folder in Zed, VS Code,
Cursor or Sublime Text, or reveal it in Finder. **Settings → Project assistant**
selects its connection independently of lesson chat, with separate API-key and
subscription model/reasoning profiles. The same profile handles project questions
and **Review**, giving feedback based on current project text
files. File access is read-only and confined to that project; code is not executed
by the assistant. Learners explicitly mark projects complete. Project conversations
are separate from lesson chat and Coach. See [the course format](docs/course-format.md).

## OpenCourse naming and fresh profiles

The product display name is **OpenCourse**; technical identifiers use
`opencourse`, and development environment variables use `OPENCOURSE_*`.
The GitHub repository and local checkout retain their existing names.

OpenCourse starts with a fresh profile at
`~/Library/Application Support/opencourse`. It does not inspect, migrate, or
modify existing localcrs or pycrs profiles. Create your local users, import your
courses, and configure your AI connections again in Settings.

Course manifests using relative asset paths remain importable. The app supports
only `opencourse://` asset URLs and the OpenCourse visualization bridge; old
branded URLs, bridge identifiers, and environment variables have no aliases.
The current course-format version is 1.6; compatible Python imports from 1.0–1.5 remain supported.

## Branding assets

The generated constellation master and its prompt are in
`app/resources/branding/`. `npm run build:icons` (from `app/`, on macOS)
recreates `resources/icon.png`, `resources/icon.icns`, the renderer mark,
and the default theme's matching mark
using `sips` and `iconutil`, and the web's sizes in `design/assets/brand/`
(`node scripts/build-icons.mjs web` redoes only those). The app bundle and DMG
use the ICNS; the renderer, About panel, and development Dock use PNG exports,
and the website and the server's web app use the `design/` copies. Generated
assets are checked in, so ordinary builds do not require image generation.

To smoke-test a packaged app with a disposable profile, set `OPENCOURSE_SMOKE=1`
and `OPENCOURSE_FIXTURE_COURSES` to the checkout's absolute
`app/tests/fixtures/courses` path before launching its executable. `OPENCOURSE_SMOKE_PYTHON=1` includes real Python runs;
`OPENCOURSE_SMOKE_OUT` selects the JSON report path. This uses an isolated profile and never reads or writes your learning data.


### Flashcard reviews

Schema 1.4 adds lesson-owned `flashcards` with Markdown questions and answers and
an optional question image. Create and edit them in each lesson's Flashcards
group in the course editor. Cards unlock when their lesson is marked complete.

Use Review on the course overview to start a 10-card session, or select 15/20.
Due cards come first, followed by new cards and early reviews; cards appear only
once per session. Reveal the answer, then choose Again, Hard, Good, or Easy.
FSRS schedules the next review at a 90% retention target and the overview shows
when to return, plus estimated recall. Ratings persist immediately in the
current user's local database and never change lesson completion. Course ZIPs
include card content and images, but exclude learner schedules and history.

## License

[MIT](LICENSE). The example theme's pictures and font are free to use, change
and share, as `docs/example-theme/README.md` says.
