# Working on OpenCourse

How to build, test and release the app, the server and the website. For what
the project is, start with the [README](README.md); for the formats, see
[`docs/`](docs/).

## The app

Use Node 22 (`.nvmrc` pins 22.22.0). The toolchain refuses Node 18.

```bash
cd app
nvm use
npm install
npm run dev
```

`dev` watches the renderer, preload and main process. A main-process change
restarts the app, so new IPC handlers load with the UI that calls them.

| Command (in `app/`) | What it does |
| --- | --- |
| `npm test` | Unit and integration tests: schema, grading, toolchains, users, import, Coach, side chat. Never touches the network |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | Boots the app on a throwaway profile and drives the real renderer; writes a report to `/tmp/opencourse-smoke.json` |
| `OPENCOURSE_SMOKE_ONLY=editor,reading,updates npm run smoke` | Only those suites (also `notebook`) |
| `OPENCOURSE_SMOKE_PYTHON=1 npm run smoke` | Also builds a virtualenv and runs pytest for real |
| `npm run shots` | Screenshots the app's screens into `/tmp/opencourse-shots` (`OPENCOURSE_SHOTS=<dir>` to choose); `OPENCOURSE_SHOTS_HOLD=<target>` stops there and leaves the window to you |
| `npm run validate:content` | Schema, assets, unique ids, and that every exercise plans, for every course in `content/` |
| `npm run check:exercises` | Every exercise's solution passes its checks and every starter fails them |
| `npm run zip:course [slug]` | Packs `content/<slug>/` into `content-zip/<slug>.zip` for importing |
| `npm run dmg` | Unsigned `OpenCourse-mac-arm64.dmg` in `app/dist/` |

Opt-in suites that need something real:
`OPENCOURSE_TEST_PYTHON=1 npx vitest run tests/python-runtime.test.ts` and
`OPENCOURSE_TEST_SERVER=1 npx vitest run tests/server-live.test.ts`.

Tests and release checks run unattended without API keys or manual review. AI
transport and microphone behavior use deterministic test doubles.

Tests, smoke and shots only use committed courses: `docs/example-course` and
`app/tests/fixtures/courses`. `content/` is gitignored authoring input, and
only the two content gates read it.

To smoke-test a packaged app, set `OPENCOURSE_SMOKE=1` and
`OPENCOURSE_FIXTURE_COURSES` to the checkout's absolute
`app/tests/fixtures/courses` before launching its executable. It uses an
isolated profile and never reads your own data.

## Layout

```
app/                        the Electron app (TypeScript, React)
app/src/core/               pure TypeScript: schema, markdown, grading, progress
app/src/core/toolchains/    exercise languages: layout, provisioning, check plans
app/src/core/coach/         Coach's prompt, tools and realtime event reducer
app/src/core/sidechat/      side chat's lesson context and thread rules
app/src/core/catalog/       server courses: identity, versions, the API contract
app/src/core/theme/         themes: the format, its compiler, its contrast audit
app/src/main/               the only code that touches Electron, files or the network
app/src/renderer/           React; talks to main only through window.opencourse
app/tests/fixtures/courses/ the committed courses every test and smoke run uses
server/                     the catalog server: accounts, catalog, publishing
server/web/                 the server's web app (React): catalog, my courses, admin
site/                       opencourse.dev (Astro, static)
design/                     the web's tokens and primitives, shared by site and web app
docs/                       the course, theme and server formats, and the user guide
.github/workflows/          CI, app releases, the website, the server image
content/                    courses you are authoring (gitignored)
```

## How the app is put together

- **A course is a directory**: `course.json` plus `assets/`, shipped as a `.zip`.
  [`docs/course-format.md`](docs/course-format.md) is the contract and
  `app/src/core/course-schema.json` enforces it; change them together. Import
  unpacks to a staging directory, validates there, and only then moves the
  course into the library.
- **Users are local and passwordless.** Everything the app owns is under
  `app.getPath('userData')`, and `src/main/paths.ts` is the only place that
  builds those paths:

  ```
  ~/Library/Application Support/opencourse/
  ├── users.json
  ├── logs.db                      the app's log; each line names its user, or none
  ├── updates.json, updates/       app updates: the setting, a download, the swap helper
  └── users/<user-id>/
      ├── courses/<course-uuid>/   document.json and package/
      ├── progress/<course-uuid>.json
      ├── workspace/<course-uuid>/ exercise files and environments
      ├── themes/<theme-uuid>/
      ├── servers/                 connections, one keychain-sealed token each
      └── coach/                   coach.db (Coach and chats), openai.key, projects/
  ```
- **Assets are served over `opencourse://<course-uuid>/<path>`**, resolved
  strictly inside that course's directory. Visualizations also run in an
  `<iframe sandbox="allow-scripts">` with no same-origin access.
- **An exercise is correct when its checks exit 0.** Python exercises use
  pytest checks or compare stdout with an expected output. The app builds a
  `.venv` per course from its bundled interpreter and never uses the system
  Python.
- **The exercise file on disk is the source of truth.** If it changes under the
  editor, you are asked which version wins.
- **The course editor saves nothing until Save.** Every edit, manual or from the
  assistant, lands in one in-memory edit session in main.
- **The log is metadata, never content**: ids, models, statuses, durations.
  Keys and conversation text are scrubbed before any sink sees a line.
- **Themes are values for the stylesheet's own tokens**, compiled by
  `app/src/core/theme/`, never CSS. The app's own look is the absence of a
  theme, exported as `docs/default-theme`.

`CLAUDE.md` has the longer working notes: why each of these rules exists, and
what broke before it did.

## The server

```bash
cd server
npm install
npm run dev     # API on :8787 (sign-up codes on stdout), web app on :5173
npm run seed    # accounts and courses through the real API
npm test
```

In the app, connect to `http://localhost:8787` in **Settings ▸ Servers**.
`OPENCOURSE_SMOKE_SERVER=1 npm run smoke` (in `app/`) drives the real window
against the built server. [`docs/self-hosting.md`](docs/self-hosting.md) covers
running one for real.

## The website

```bash
cd site
npm install
npm run dev     # http://localhost:4321
npm run build   # dist/, plus the Pagefind search index
npm run check   # astro check, then every link, anchor and download in dist/
```

Its docs are this repository's `docs/`, read at build time. Its star count and
version come from GitHub's API at build time, so a visitor's browser loads
nothing from anywhere else.

## Releasing

1. Raise `version` in `app/package.json` and commit.
2. Tag it: `git tag v0.4.1 && git push origin v0.4.1`.
3. `.github/workflows/release.yml` builds `OpenCourse-mac-arm64.dmg` and uploads
   it to a draft release. It is signed and notarized when the repository has
   the Apple secrets. Otherwise it is ad-hoc signed and marked unsigned, and
   the website explains how to open it.
4. Write the notes and publish the draft. opencourse.dev rebuilds with the new
   version.

The catalog server is released the same way with a `server-v<version>` tag,
which publishes `ghcr.io/s3298321/opencourse-server`.

## macOS and `~/Documents`

macOS will not start an ad-hoc-signed app bundle that lives under `~/Documents`
when it is launched from a terminal. The process hangs in `dyld` at 0% CPU with
no error. `dev`, `preview`, `smoke` and `shots` therefore go through
`app/scripts/electron-dist.mjs`, which mirrors the Electron binary into
`~/Library/Caches/opencourse-electron` and points `node_modules` at it. If the
checkout is somewhere unprotected, the script does nothing. Packaged builds are
unaffected.

## Branding assets

The generated master artwork and its prompt are in `app/resources/branding/`.
`npm run build:icons` (in `app/`, on macOS) recreates the app icon, the
renderer mark, the default theme's mark and the web sizes in
`design/assets/brand/`. The outputs are checked in, so ordinary builds need no
image tools.
