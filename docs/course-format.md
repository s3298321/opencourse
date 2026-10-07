# OpenCourse course archive format — v1.5

This document is the source of truth for course authors. A OpenCourse course is a
self-contained directory holding a `course.json` manifest plus its assets,
distributed as a `.zip` of that directory. The desktop app ships no courses at
all: you import an archive, or add a course from an OpenCourse server you have
connected to, and the app validates it against the v1.5 JSON Schema and renders
it directly.

**A course can be about anything.** Nothing in the format is specific to
programming: a course on economics or music theory is markdown, images,
visualizations and quizzes, and needs no runtime at all. What the format *also*
gives you is the `exercise` block — a runnable, auto-graded coding exercise —
which any course may use, whatever its subject. An economics course with one
Python exercise for computing a Gini coefficient is a first-class course.

You can get this document, the JSON Schema and a working example course out of
the app itself — **Library ▸ Get the course format…**. The example imports
as-is, so it doubles as a starting template.

**What changed in v1.5:** A course has a `version` of its own, `MAJOR.MINOR.PATCH`
(required from schema 1.5; older archives import as `0.1.0`). Every element may
carry a `uid`, the server identity an OpenCourse server's archives use so that
progress follows an element from one version of a course to the next. Authors
never write `uid`s by hand: see [Versions and server identity](#versions-and-server-identity).

**What changed in v1.4:** Lessons can include optional `flashcards` collections of question–answer pairs with optional question images. Use schema version `1.4` or later for flashcards. Versions 1.0–1.3 remain importable.

**What changed in v1.3:** A module can be a project (`type: "project"`), with
a definition, requirements, concrete deliverables, acceptance criteria and optional
starter files. Existing untyped lesson modules remain valid. A project can be the
first, last or only module in a course. Use schema version `1.3` or later for project modules.

**What changed in v1.2** (these runtime additions remain optional; every block
must now include a `slug` regardless of the declared version):

| Where | Field | Why |
| --- | --- | --- |
| course | `runtime` | How the course's exercises are built and run: `{ language, version, packages, flags }`. Replaces `python_version`, which still works. |
| course | `subject` | Free text shown on the library card and course page: `"Programming"`, `"Economics"`. |
| exercise | `runtime` | Overrides the course runtime for one exercise, so a single course can mix languages. |
| exercise | `extra_files` | Read-only support files written next to the learner's work: a header, a fixture, a `Makefile`. |
| exercise | `expected_output` | Verify by stdout instead of by a test file — the only workable shape when the learner's whole program is the answer. |
| exercise | `stdin` | Fed to the program under the `expected_output` shape. |
| exercise | `match` | How stdout is compared: `exact` \| `trimmed` (default) \| `lines`. |

**What changed in v1.1:**

| Where | Field | Why |
| --- | --- | --- |
| course | `python_version` | Superseded by `runtime.version`. Still honoured. |
| course | `prerequisites` | Strings shown on the course page before a learner starts. |
| lesson | `objectives` | "By the end you can…" bullets, rendered at the top of the lesson. |
| lesson | `estimated_minutes` | Per-lesson time estimate. |
| exercise | `solution` | Reference implementation, revealed on request. |
| exercise | `tests` | The course's checks, run against the learner's file. |
| exercise | `test_command` | Python only; defaults to `pytest -q`. |
| exercise | `packages` | Superseded by `runtime.packages`. Still honoured. |

## Archive layout

```
<any-name>.zip
├── course.json                  # manifest (required, at archive root)
└── assets/                      # all referenced files (required if any references exist)
    ├── cover.png
    ├── img/diagram-1.png
    ├── video/intro.mp4
    └── viz/linked-list/         # a visualization bundle (an entry HTML + its relative deps)
        ├── index.html
        ├── style.css
        └── app.js
```

Rules:
- `course.json` **must** be at the archive root. One wrapping folder is
  tolerated, because macOS Finder's *Compress* puts the folder you compressed
  at the top — `my-course/course.json` imports fine, `a/course.json` alongside
  `b/course.json` does not.
- All referenced asset paths are **relative to the archive root**, e.g. `assets/img/diagram-1.png`.
- Paths must not contain `..` or absolute components. Symlinks are rejected.
- Limits, enforced on import: **200 MB** per archive, **100 MB** per file,
  **5 000** members. They live in `app/src/core/import.ts`.
- `__MACOSX/`, `.DS_Store` and `._*` are dropped rather than treated as errors.

## Allowed file types

| Category        | Extensions                                             |
| --------------- | ------------------------------------------------------ |
| Images          | `.png .jpg .jpeg .gif .webp .svg`                      |
| Video           | `.mp4 .webm`                                           |
| Audio           | `.mp3 .ogg`                                            |
| Viz bundles     | `.html .htm .css .js .mjs .json .map .woff .woff2 .ttf .otf .txt` |

Plus `.json` for the manifest and `.md`. Anything else is refused on import,
and the import is refused as a whole — a course is never half-installed.

## `course.json` reference

### Top-level object

| Field             | Type                | Required | Description |
| ----------------- | ------------------- | -------- | ----------- |
| `schema_version`  | string              | yes      | `"1.0"` to `"1.5"`. The app writes `"1.5"`. |
| `slug`            | string (kebab-case) | yes      | Portable kebab-case name. Every import creates a separate library course, even when slugs match. |
| `title`           | string              | yes      | Course title shown in the catalog. |
| `version`         | string              | from 1.5 | The course's own version: three numbers, `MAJOR.MINOR.PATCH`, such as `1.2.0`. No pre-release tags. A new course starts at `0.1.0`. |
| `uid`             | string (UUID v4)    | no       | Server identity of the course. Written by the app when it publishes; ignored on import. |
| `description`     | string              | no       | Markdown (rendered on the detail page). |
| `author`          | string              | no       | Free-form. |
| `difficulty`      | enum                | no       | `beginner` \| `intermediate` \| `advanced` (default: `beginner`). |
| `estimated_hours` | integer             | no       | Hint to learners. Keep it consistent with the sum of `estimated_minutes`. |
| `subject`         | string              | no       | Free text: `"Programming"`, `"Economics"`. Shown on the library card and the course page. |
| `runtime`         | Runtime             | no       | Default runtime for every exercise in the course. Omit it entirely for a course with no exercises. |
| `python_version`  | string              | no       | The v1.1 spelling of `runtime.version`. Still honoured; prefer `runtime`. |
| `prerequisites`   | string[]            | no       | What a learner should already know or have installed. |
| `tags`            | string[]            | no       | Used for search/filter. |
| `cover_image`     | string              | no       | Asset path, e.g. `assets/cover.png`. |
| `modules`         | Module[]            | yes      | At least one module. |

### `Module`

A module is either a group of lessons or one project. Module slugs must be unique
within the course. They remain portable author names; local UUIDs identify learner work and progress.

For a lesson module, `type` is optional; when supplied it must be `"lessons"`.

| Field | Type | Required |
| --- | --- | --- |
| `slug` | kebab-case string | yes |
| `title` | string | yes |
| `type` | `"lessons"` | no |
| `lessons` | Lesson[] (at least one) | yes |

For a project module, set `type: "project"` and replace `lessons` with `project`.
A module cannot contain both fields. The project is a complete activity in the
course sequence, with its own workspace and conversations.

| Field | Type | Required |
| --- | --- | --- |
| `slug` | kebab-case string | yes |
| `title` | string, 1–500 characters | yes |
| `type` | `"project"` | yes |
| `project` | ProjectDefinition | yes |

### `ProjectDefinition`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `definition` | markdown string | yes | Brief and goal, 1–20,000 characters. |
| `requirements` | Requirement[] | yes | 1–50 `{ id, description }` objects; IDs unique within this array, descriptions at most 2,000 characters. |
| `deliverables` | Deliverable[] | yes | 1–30 concrete outputs, each assessed against its criteria. |
| `objectives` | string[] | no | 1–30 learning goals, each at most 1,000 characters. |
| `estimated_minutes` | integer | no | 1–10,000. |
| `starter_files` | `{ path, content }`[] | no | Up to 100 UTF-8 files seeded on the first open only. |

A Deliverable has a unique stable kebab-case `id`, a `title` (up to 500 characters),
a markdown `description` (up to 2,000 characters), and 1–30 `acceptance_criteria`
strings (each up to 1,000 characters). Optional `paths` lists 1–30 suggested relative
filenames. Paths guide review; alternate implementations in the project folder
can still be discussed. Requirement IDs are also stable kebab-case strings.

Starter paths follow the exercise `extra_files` path contract: ordinary ASCII path
segments beginning with a letter or digit, no absolute paths, `..`, dotfiles or
`.command` files. Duplicate starter paths and file/directory collisions are invalid.
A starter file is at most 256 KiB; all starter contents together are at most 1 MiB.
The serialized project context (course/module titles, brief, goals, requirements and
deliverables) is at most 48,000 characters; an oversized project is refused on import.

```json
{
  "type": "project",
  "slug": "course-outline-project",
  "title": "Build a course outline",
  "project": {
    "definition": "Design a three-lesson course on a subject you know.",
    "requirements": [
      { "id": "audience", "description": "Define the audience and prerequisites." }
    ],
    "deliverables": [
      {
        "id": "outline",
        "title": "Course outline",
        "description": "Provide an outline with learning goals and lesson order.",
        "paths": ["OUTLINE.md"],
        "acceptance_criteria": ["Each learning goal has a corresponding lesson."]
      }
    ],
    "starter_files": [{ "path": "OUTLINE.md", "content": "# Course outline\n" }]
  }
}
```

Projects have no exercise `solution`, `tests`, `test_command`, `expected_output` or
runtime provisioning. Learners work in their local folder using an installed editor.
The project assistant receives the definition, requirements and deliverables
implicitly and can list, search and read current UTF-8 files only within that
project folder. Read files are sent to OpenAI using the key from Settings. Symlinks,
secrets, dependency/build folders and nonregular files are excluded; binary artifacts
can be listed but their contents cannot currently be reviewed. Reads/searches are
bounded and explicitly report truncation. The assistant gives conversational
feedback, identifies unverified criteria and does not execute code or automatically
grade work. The learner chooses when to mark completion.

Project workspaces survive reopening, in-app editing, module renames/moves and chat deletion.
Removing a course permanently deletes its progress, lesson and project conversations,
exercise workspace, project directories and initialization metadata; importing it
again starts fresh, even with the same course/module slugs. Starter files
are never regenerated after initialization, including files the learner deleted.
Changed requirements trigger a fresh context snapshot and a notice when the last
requested review used an earlier definition. A missing workspace requires an explicit
Recreate action. One user's work, progress and project conversations remain separate
from every other user's.

### `Lesson`

| Field               | Type       | Required |
| ------------------- | ---------- | -------- |
| `slug`              | kebab-case | yes |
| `title`             | string     | yes |
| `objectives`        | string[]   | no — rendered as "By the end of this lesson you can…" |
| `estimated_minutes` | integer    | no — shown in the sidebar and summed for the course |
| `blocks`            | Block[]    | yes |

Convention: end the theory with a `markdown` block that starts with
`## Key takeaways`, placed **before** the first quiz. The app renders it as a
recap card, and it reads naturally as theory → recap → check yourself → build.

### Block types

Each lesson is a list of typed content blocks rendered in order.

Every block in the app has an editable `slug`: a kebab-case name unique within
its lesson. The editor outline shows this name beside the block-type icon.
New blocks start as Markdown with a name such as `markdown` or `markdown-2`;
change **Block slug** to give the block a meaningful name. Renaming a slug does
not change its UUID, progress, chat attachments or learner workspace.

The schema requires `slug` on all six block types, including imported courses.
Missing, invalid or duplicate names fail validation. The app does not add slugs to
existing courses; add them to `course.json` before importing. Exported format 1.5
ZIPs preserve the authored block slugs.

#### `markdown`
```json
{ "type": "markdown", "slug": "compiler-overview", "content": "A compiler translates your source *before* it runs…" }
```
Rendered through a strict HTML allowlist (links, images, code, tables,
headings). Inline HTML in the markdown source is stripped.

Code fences are syntax-highlighted when the language is one the app bundles a
grammar for: `python`, `c`, `cpp`, `javascript`, `typescript`, `bash`, `json`,
`sql`, `yaml`, `diff`, `llvm`, and the usual aliases (`py`, `js`, `ts`, `sh`,
`yml`, `ll`, …).
Anything else renders as plain monospace, which is a perfectly good outcome —
don't reach for a fence language just to get colour.

#### `image`
```json
{ "type": "image", "slug": "compiler-diagram", "src": "assets/img/diagram.png", "alt": "Ref diagram", "caption": "Figure 1" }
```

#### `video`
```json
{ "type": "video", "slug": "intro-video", "src": "assets/video/intro.mp4", "poster": "assets/img/intro-poster.png", "caption": "Intro" }
```

#### `visualization`
An interactive HTML/CSS/JS bundle rendered in a **sandboxed iframe**.
The `src` points at the entry HTML; every sibling file in that bundle
directory is uploaded and served.
```json
{
  "type": "visualization", "slug": "linked-list",
  "src": "assets/viz/linked-list/index.html",
  "title": "Linked list walkthrough",
  "height": 480
}
```
The iframe is served with `sandbox="allow-scripts"` (no `allow-same-origin`),
a restrictive Content-Security-Policy, and no access to parent cookies or DOM.
Don't rely on network access, `localStorage`, or parent-page APIs inside a viz.
Ship JavaScript as files next to the entry HTML: inline `<script>` is refused.

Learners can highlight text inside a visualization and ask the side chat about
it, as they can in a lesson. A viz needs no code for this: the app appends a
small script to every visualization page it serves, which reports selections to
the app with `postMessage`. Two things are reserved for it: messages whose
`source` is `opencourse-viz` or `opencourse-app`, and the path `/__opencourse/` on the
course's host.

#### `quiz`
The `id` is an **author-assigned portable string**. In-app editing preserves quiz history through a separate local UUID. Importing a ZIP always creates fresh learner state.

Single-choice:
```json
{
  "type": "quiz", "id": "q1", "slug": "q1", "kind": "single",
  "question": "What does a compiler produce?",
  "options": [
    { "id": "a", "text": "A running process", "correct": false },
    { "id": "b", "text": "An object file", "correct": true }
  ],
  "explanation": "Compiling and running are separate steps; the linker sits between them."
}
```

Multiple-choice (answer must exactly match the correct set):
```json
{
  "type": "quiz", "id": "q2", "slug": "q2", "kind": "multiple",
  "question": "Which of these are demand curves?",
  "options": [
    { "id": "a", "text": "Quantity falls as price rises", "correct": true  },
    { "id": "b", "text": "Quantity rises as price rises", "correct": false },
    { "id": "c", "text": "Quantity is unchanged by price", "correct": true  }
  ]
}
```

Short-answer text (case-insensitive exact match against any accepted string):
```json
{
  "type": "quiz", "id": "q3", "slug": "q3", "kind": "text",
  "question": "What function prints to stdout?",
  "answers": ["print", "print()"]
}
```

#### `exercise`
A prompt, a starter file the learner edits, an optional reference solution, and
something the app can check the answer against. Exercises are the one part of
the format that needs a runtime, and any course may use them.

There are two ways to say what "correct" means, and an exercise picks exactly
one:

- **`tests`** — the course ships a checking program that exercises the functions
  the learner wrote. This is the shape for almost everything.
- **`expected_output`** — the course states the stdout the learner's whole
  program must produce. This is the shape for the first lessons of a compiled
  language, where writing a complete program *is* the exercise, and for anything
  else whose contract is really "print this".

`tests` wins if both are present.

##### The `Runtime` object

Valid on the course (the default for every exercise) and on any exercise (an
override, merged over the course's). Each field is interpreted by the language,
which is why one shape covers all of them:

| Field | Type | Notes |
| --- | --- | --- |
| `language` | enum | `"python"` \| `"c"` \| `"llvm-ir"`. Defaults to `"python"`. |
| `version` | string | The floor. Python: a PEP 440 specifier, `">=3.11"` (default). C: a language standard, `">=c17"` (default). LLVM IR: unused. |
| `packages` | string[] | Python: pip requirements. C and LLVM IR: library names, one `-l` each (`["m"]` links libm). |
| `flags` | string[] | Python: unused. C: compiler flags. LLVM IR: compiler flags, passed to clang for both the learner's IR and the C test harness. |

`flags` are validated, not quoted into a shell. Only `-std=`, `-W…`, `-f…`,
`-g`, `-O…`, `-D…` and `-pedantic` are accepted, and never anything containing
a `/`. `-o` is refused: the app owns the output path. A flag the app will not
run makes the exercise report "cannot run this in-app" rather than failing
silently.

##### Python

```json
{
  "type": "exercise", "id": "ex-1", "slug": "ex-1",
  "title": "Hello, world",
  "prompt": "Write `greeting()` so that it returns the string `Hello, world`.",
  "starter_code": "def greeting() -> str:\n    ...\n",
  "solution": "def greeting() -> str:\n    return \"Hello, world\"\n",
  "tests": "import exercise\n\ndef test_greeting():\n    assert exercise.greeting() == \"Hello, world\"\n",
  "verification_instructions": "Run the checks, then `python exercise.py`.",
  "hints": ["`return` the string, don't print it."]
}
```

`starter_code` becomes `exercise.py`, `solution` becomes `solution.py`, `tests`
becomes `test_exercise.py` and imports the learner's work as `import exercise`.
The app builds one virtualenv per course from the interpreter it finds on the
machine, installs `pytest` plus `runtime.packages`, and runs `pytest -q`.

##### C

The learner writes functions in `exercise.c`; the course's `test_exercise.c`
has its own `main()` and asserts. Declare the interface in a header and ship it
through `extra_files`, so both translation units agree:

```json
{
  "type": "exercise", "id": "ex-2", "slug": "ex-2",
  "title": "Add two integers",
  "prompt": "Implement `add` so that it returns the sum of its arguments.",
  "runtime": { "language": "c", "version": ">=c17", "flags": ["-Wall", "-Wextra", "-Werror"] },
  "extra_files": [{ "path": "exercise.h", "content": "int add(int a, int b);\n" }],
  "starter_code": "#include \"exercise.h\"\n\nint add(int a, int b) { return 0; }\n",
  "solution": "#include \"exercise.h\"\n\nint add(int a, int b) { return a + b; }\n",
  "tests": "#include <assert.h>\n#include <stdio.h>\n#include \"exercise.h\"\n\nint main(void) {\n  assert(add(2, 2) == 4);\n  puts(\"1 check passed\");\n  return 0;\n}\n",
  "verification_instructions": "It must compile with no warnings and every assertion must hold."
}
```

The app compiles both files together and runs the binary; a failed `assert`
exits non-zero, which is all the grading contract needs. There is no
environment to build and nothing to download — the compiler comes from the Xcode
Command Line Tools, and `assert.h` comes from libc.

The other shape, for a first lesson:

```json
{
  "type": "exercise", "id": "ex-3", "slug": "ex-3",
  "title": "Your first program",
  "prompt": "Print `Hello, world` on a line of its own.",
  "runtime": { "language": "c" },
  "starter_code": "#include <stdio.h>\n\nint main(void) {\n  /* your code here */\n  return 0;\n}\n",
  "solution": "#include <stdio.h>\n\nint main(void) {\n  puts(\"Hello, world\");\n  return 0;\n}\n",
  "expected_output": "Hello, world\n",
  "verification_instructions": "Running it prints exactly one line: Hello, world."
}
```

##### LLVM IR

The learner writes textual LLVM IR in `exercise.ll`. The shapes mirror C's: with
`tests`, the course's `test_exercise.c` owns `main()` and calls functions the
IR defines; with `expected_output`, the IR defines `@main` itself and its stdout
is compared.

```json
{
  "type": "exercise", "id": "ex-4", "slug": "ex-4",
  "title": "Add two integers in IR",
  "prompt": "Make @add return the sum of its two i32 arguments.",
  "runtime": { "language": "llvm-ir", "flags": ["-Wall", "-Werror"] },
  "extra_files": [{ "path": "exercise.h", "content": "#ifndef EXERCISE_H\n#define EXERCISE_H\n#include <stdint.h>\n/* define i32 @add(i32 %a, i32 %b) */\nint32_t add(int32_t a, int32_t b);\n#endif\n" }],
  "starter_code": "define i32 @add(i32 %a, i32 %b) {\n  ret i32 %a\n}\n",
  "solution": "define i32 @add(i32 %a, i32 %b) {\n  %sum = add i32 %a, %b\n  ret i32 %sum\n}\n",
  "tests": "#include <assert.h>\n#include <stdio.h>\n#include \"exercise.h\"\n\nint main(void) {\n  assert(add(2, 2) == 4);\n  puts(\"1 check passed\");\n  return 0;\n}\n",
  "verification_instructions": "compile, link and run all succeed, and the program prints 1 check passed."
}
```

The app runs three visible steps. **compile** turns `exercise.ll` into an object
file with clang, *with the IR verifier switched on* - a release clang skips it
for IR input, and a phi with a missing predecessor or a use its definition does
not dominate would otherwise compile into a program that does something
arbitrary. **link** links that object with `test_exercise.c` (compiled as C17),
and **run** runs the result. The compiler is the same one C uses: every clang
reads `.ll` files, so nothing is installed. A machine whose Command Line Tools
predate the verifier flag can use Homebrew's LLVM instead (`brew install
llvm`); the app finds its clang without it being on `PATH`.

Keep the boundary with C simple: `i32`, `i64`, `double` and `ptr` map onto
`int32_t`, `int64_t`, `double` and pointers on every platform. Narrower integers
and structs passed by value bring in ABI attributes (`zeroext`, `byval`, struct
coercion) that differ between targets.

##### Field reference

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Portable author ID; the app assigns a separate UUID for learner progress. |
| `title`, `prompt` | yes | Markdown is *not* rendered in `prompt` — keep it plain. |
| `runtime` | no | Overrides the course runtime for this exercise. |
| `starter_code` | yes in practice | Written to the language's learner file, and **never overwritten** once the learner has edited it. Omitted, the learner gets an empty file. |
| `solution` | no | Written to the solution file and shown behind a "Show solution" toggle. |
| `tests` | no | Written to the language's test file. |
| `test_command` | no | **Python only**, defaults to `pytest -q`. Only `pytest …` runs in-app. C derives its own commands and ignores this. |
| `extra_files` | no | `[{ path, content }]`, rewritten on every open. Every path segment must start with a letter or digit — which rules out `..`, absolute paths and dotfiles — and `.command` is refused. |
| `expected_output` | no | The stdout the program must produce. Ignored when `tests` is present. |
| `stdin` | no | Written to the program's stdin and then closed. |
| `match` | no | `exact` (byte for byte) \| `trimmed` (default: ignores trailing whitespace and trailing blank lines) \| `lines` (also ignores leading indentation). |
| `packages` | no | The v1.1 spelling of `runtime.packages`. |
| `verification_instructions` | yes | What the learner should see when it works. |
| `hints` | no | Rendered in a collapsed `<details>`. |

##### Which files land where

| | Python | C | LLVM IR |
| --- | --- | --- | --- |
| the learner edits | `exercise.py` | `exercise.c` | `exercise.ll` |
| `tests` becomes | `test_exercise.py` | `test_exercise.c` | `test_exercise.c` |
| `solution` becomes | `solution.py` | `solution.c` | `solution.ll` |
| dependencies | `requirements.txt` (course-level) | none — `runtime.packages` become `-l` flags | as for C |
| environment | `.venv/` in the course directory | none; the system compiler is the environment | as for C |
| build output | — | `.opencourse-build/`, wiped before every run | as for C |

**How the app runs it.** The exercise is scaffolded to
`<workspace>/<course-uuid>/exercises/<block-uuid>/`. The app resolves
the language's tool against `runtime.version`, prepares an environment if that
language needs one, and then runs the checks from the exercise directory in
the in-app workbench. A compiled language runs as visible steps - `compile`
and `run` for C, `compile`, `link` and `run` for LLVM IR - so diagnostics land
where the learner reads them.

Two consequences for authors:

- **Only `pytest` runs in-app for Python.** A `test_command` that is not a
  `pytest …` invocation, or that contains shell syntax, is refused by the
  workbench with a note to use its Terminal tab; it never auto-completes the
  exercise. Keep it to `pytest` and flags.
- **`packages` are pooled per course, per language.** `requirements.txt` holds
  the union of every Python exercise's packages, so adding one to a late
  exercise reinstalls for the whole course, once. A C exercise's `-lm`
  contributes nothing to it.

**Rules for tests.** Whatever the language, they must

- **fail against the untouched `starter_code`** — a test that passes on the
  starter proves nothing, and the exercise gate rejects it;
- **pass against `solution`** — same gate, same run;
- keep timing assertions loose (assert `< 0.9s` for work that should take
  0.5 s), and avoid the network.

Per language:

- **Python** — import the learner's module as `import exercise` and reference the
  names `starter_code` already declares. Need a local server? Start one in the
  test (`asyncio.start_server`), never reach out to the internet.
- **C** — `test_exercise.c` owns `main()`, so `exercise.c` must not define one.
  Declare the shared interface in a header shipped via `extra_files` and
  `#include` it from both sides. `assert.h` is enough; do not vendor a test
  framework. Print something on success (`puts("3 checks passed")`) so a pass
  does not look like an empty pane.
- **LLVM IR** — the same rules as C, with the header documenting each IR
  signature next to its C prototype. A harness that reports the value a
  function returned is worth more here than in C, because there is no way to
  printf-debug IR; call `setvbuf(stdout, NULL, _IONBF, 0)` first, so that IR
  which crashes does not take the earlier report lines with it in the pipe's
  buffer.

**Grading a memory bug.** `-fsanitize=undefined -fno-sanitize-recover=all`
aborts with a readable runtime error and a non-zero exit, which makes UBSan a
real grader for out-of-bounds reads and signed overflow. **Do not use
`-fsanitize=address`**: an ASan-instrumented binary built by Apple clang 17 on
macOS 26 hangs at startup with no output until the watchdog kills it. For leaks
and use-after-free, have the course provide an allocation-counting header
through `extra_files` and assert the count balances — which teaches ownership
better than a sanitizer report anyway.

Run `npm run check:exercises` in `app/` after editing any exercise. It plans and
runs every exercise with the same code the app uses, against both `solution`
(must pass) and `starter_code` (must fail), in every language the course mixes.

## How the app loads a course

1. Courses are imported or created in the editor. ZIP imports are unpacked and
   validated in staging, then stored under
   `<userData>/users/<user-id>/courses/<course-uuid>/package/`. Each import
   receives fresh course and element UUIDs, including repeated imports of the same
   archive. The separate `document.json` contains authored content and local IDs.
2. `course.json` is validated against the JSON Schema in
   `app/src/core/schema.ts`. A manifest that fails validation is listed with
   its error instead of being rendered.
3. Every referenced asset must exist relative to the course root, with an
   extension on the allowlist above.
4. Markdown is rendered with `markdown-it` (CommonMark, no raw HTML) and
   sanitized through a tag/attribute allowlist before it reaches the DOM.
5. Assets are served over the app's own `opencourse://` scheme, resolved strictly
   inside the course directory; visualizations additionally run in an
   `<iframe sandbox="allow-scripts">` with no same-origin access.

## Stable ids and progress

Progress lives under `<userData>/users/<user-id>/progress/<course-uuid>.json`.
The app assigns UUIDs to modules, lessons, blocks, quiz options, project items
and support-file entries. These IDs are private to the library and are never
included in `course.json` or exported ZIPs. Portable slugs and author `id`s remain
unchanged for archive compatibility.

Renaming, editing, reordering or moving an existing element preserves its UUID,
completion, attempts, chats and learner files. Duplicating an element or changing
its type creates fresh identities. Saving a deletion removes descendants and
attached progress, messages and workspaces after one confirmation. Mixed-lesson
chats retain messages attached to surviving lessons. Historical quiz answers are
not regraded; attempts referencing deleted options are removed.

## Authoring in the app

Choose **Create course** in the library, or **Edit course** on an existing course.
Use the outline to add, duplicate, reorder or delete modules, lessons and
blocks. The editor covers all fields in this format, including quiz answers,
exercise solutions/tests, runtime settings, support files and project definitions.
Markdown fields accept Markdown syntax directly and have a live preview; code
uses the same editor as exercises. **Add block** creates a Markdown block; choose
its type in the editing form. Each block's editable slug identifies it in the outline.

Nothing you change — by hand or through the assistant — is written to the
course until you choose **Save** (⌘S). The editor shows whether there are
unsaved changes. Leaving the editor with unsaved changes asks first; choosing
*Discard changes* leaves the course exactly as it was last saved, and a course
that was never saved disappears. A new course appears in the library at its
first valid save; learning and export become available then. An invalid save
keeps your edits in the editor. Concurrent stale saves are rejected instead of
overwriting another window's edits. Opening **Settings** from the editor keeps
the edits waiting for you when you come back.

Upload covers, images, videos/posters and HTML visualizations as attachments.
Images and HTML source are not edited in the app. A visualization can be one HTML
file, a folder or a ZIP containing its dependencies; choose its HTML entry point.
Relative paths remain intact under `assets/viz/`. Replacement uploads receive new
immutable paths. Shared attachments stay until no saved or draft content uses them;
imported supporting files are retained conservatively.

**Export ZIP…** (on the course page) exports the last saved version in format 1.5, with `course.json` at
the archive root and package assets included. Local IDs/documents, drafts, chats,
progress, workspaces, environments and recovery data are excluded. Reimporting the
export starts a new course with fresh identities and learner state.

Existing user libraries are migrated automatically before loading. UUID mappings,
JSON originals and a SQLite backup are retained under `.course-migration/` for
recovery, including broken courses and ambiguous legacy data. Save operations use
a durable journal and SQLite commit marker so interrupted operations recover
before a course is exposed.

### OpenCourse identifiers

The display name is OpenCourse. The current archive format version is 1.5;
course assets use `opencourse://`, and the visualization bridge uses
`/__opencourse/viz-bridge.js` and `opencourse-viz`/`opencourse-app` messages.
These are the only supported app identifiers; there are no old-brand aliases.
Course manifests with ordinary relative asset paths remain importable.

The published schema identity is `urn:opencourse:course:1.5`; this is an
identifier, not a hosted schema URL. The bundled example uses the course slug
`opencourse-example`. Keep unrelated course, module, lesson, quiz and exercise IDs
stable when editing a course.


## Versions and server identity

`version` is the author's to set. The editor shows it under **Course details**,
and nothing changes it for you: edit freely, and raise it when you want a
learner to see a new version. A server is stricter: it accepts a publish only
when the version is higher than every version of that course it has ever
published, including versions since deleted.

Element identity comes in two kinds, and the difference is the point:

- A **local course** — created in the app, or imported from a `.zip` — has
  app-local IDs, private to one library. Importing the same archive twice gives
  two unrelated courses. Any `uid`s in an imported archive are ignored.
- A **server course** — added from an OpenCourse server's catalog — keeps the
  server's identities: the course and every element carry a `uid` that stays
  the same across versions and is the same for every learner. That is what lets
  an update tell an edited lesson from a new one.

Updating a server course to a newer version keeps all progress attached to an
element that still exists, even if it was edited: a completed lesson stays
completed, attempts and exercise files stay. Elements the new version removed
take their progress with them (the app lists them before updating). New
lessons and projects start incomplete.

When you publish, the app writes your course's existing IDs as `uid`s, so your
own library is not renamed. A learner cannot change a course they added from a
server: saving edits to one creates a local copy with fresh IDs. **Export
ZIP…** never writes `uid`s.

## Flashcards and review (v1.4)

A lesson may have a `flashcards` array alongside `blocks`. Cards are review
content, not inline lesson blocks. Omit the array or use `[]` when there are no
cards. Cards are supported from version 1.4; project modules have no cards.

```json
"flashcards": [
  {
    "id": "compiler-output",
    "question": "What does a compiler produce?",
    "answer": "Object code, which the linker combines into an executable.",
    "image": { "src": "assets/img/compiler.svg", "alt": "Compilation pipeline" }
  }
]
```

`id`, `question` and `answer` are required nonblank strings. The archive ID must
be unique within the lesson. Questions and answers support sanitized Markdown.
`image` is optional; its `src` uses the same course-relative attachment rules
as image blocks, and `alt` is optional. Keep images in this dedicated field so
the app can validate, upload and export their attachments.

Each card should test one idea, using only material covered by its associated
lesson or earlier lessons. Authors are responsible for this semantic rule.
Cards unlock for review only while their associated lesson is marked complete.

In Edit course, use the lesson's Flashcards group to add, edit, duplicate,
reorder or delete cards in Manual mode. In AI mode, ask the assistant to create
content; the outline's manual creation buttons are hidden. Each card is bound to
the lesson where it was created. To associate it with another lesson, create a
new card in that lesson and delete the original. The preview reveals answers
without affecting progress. Drafts autosave normally; Save course publishes them. Edits and reordering
preserve the private card UUID and review history; copies receive fresh IDs and
start unreviewed. Deletion uses the existing save confirmation and removes the
card's review data. Marking its lesson incomplete temporarily locks the card.
Reset review progress on a saved card immediately clears the current user's
schedule and history after confirmation, independently of draft saving.

The overview offers Continue and Review, with a 10/15/20-card selector (default
10). Review picks due cards, then unlocked unseen cards, then early reviews
prioritized by estimated recall. Each card appears once per session; smaller
decks produce smaller sessions. Reveal the answer and rate Again (forgot or
incorrect), Hard (recalled with difficulty), Good (correct), or Easy (effortless).
Space reveals, keys 1–4 rate, and Escape exits. Each accepted rating saves
immediately; exiting or closing the app retains rated cards' progress.

Scheduling uses FSRS with a 90% retention target, short learning steps of 1/10
minutes, relearning at 10 minutes, and no interval fuzz. Recommendations show due
and new cards, or the earliest next scheduled review. Estimated recall averages
FSRS retrievability across reviewed unlocked cards; it is an estimate, not a
course-completion score. Rating logs and card states live in the local user's
SQLite database and are excluded from course archives. Importing an exported
course creates fresh identities and review progress. Review does not change
lesson completion or the Continue destination.
