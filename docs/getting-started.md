# Getting started with OpenCourse

OpenCourse is a Mac app for courses, PDFs and personal notebooks on any
subject. Study offline, practise with a voice coach, create courses, or connect
a learning server to continue enrolled reading in a browser.

## Install

1. Download OpenCourse from [opencourse.dev](https://opencourse.dev/download).
   It runs on Macs with Apple silicon, on macOS 13 Ventura or later.
2. Open the disk image and drag **OpenCourse** to **Applications**.
3. Open it from Applications or Spotlight.

OpenCourse is not signed with an Apple Developer ID yet, so the first time you
open it macOS says it cannot verify the app. Close that message, open **System
Settings ▸ Privacy & Security**, scroll to the note about OpenCourse and choose
**Open Anyway**. You do this once for each version you download yourself;
a version the app installs for you (below) opens without it.

The first time you open OpenCourse it asks for a name, so that several people
can share one Mac with separate libraries and progress. Creating a local user
does not create a server account or upload your library.

## Keep it up to date

OpenCourse can update itself. In **Settings ▸ Updates**, press **Check for
updates**, or turn on **Check for updates automatically** - it is off until you
do, and while it is off the app never contacts GitHub on its own. When a new
version is available, an **Update** button appears at the top right of the
window. **Install and restart** downloads it, checks that it is the release
that was published, and restarts into it.

If you have unsaved edits to a course or a Coach session is live, the update
waits until you have saved them or ended it.

## Get a course

The app ships no courses. You choose where yours come from.

**From a catalog.** A connected server lists published courses, such as those at
[catalog.opencourse.dev](https://catalog.opencourse.dev).

1. Open **Settings** (⌘,) and go to **Servers ▸ Connect to a server…**.
2. Enter the address and sign in, or create an account right there.
3. In your library, open the **Course catalog** tab and add a course.

You need an account on that server to add a course; each operator decides
whether registration is open. When the author publishes an update, you choose
when to accept it. Progress is kept for lessons that still exist.

**From a file.** A course is a `.zip` archive. Choose **Course ▸ Import
Course…** (⌘I) and pick it. To see every kind of block a course can contain,
import the example course: **Help ▸ Get the course format…** saves it, with the
format's documentation.

## Learn

A course is modules of lessons. Use the outline on the left, or **Course ▸
Next Lesson** (⌘]). Your place and progress are saved as you go.

- **Quizzes** check your understanding and explain every answer, right or wrong.
- **Flashcards** come back for review just before you would forget them. Review
  what is due from the course's page. You can also ask a course, exercise, project,
  notebook, or document chat to prepare **personal flashcards** about concepts you
  discussed. Review the question-and-answer cards one at a time, choosing **Add** or
  **Reject**. Added cards slide right, rejected cards left, revealing the next card. Saved cards enter review immediately, using the same schedule as
  course cards. Course pages show separate default and personal counts; click the
  personal count to list questions and delete cards. Documents show Review only
  after you save personal cards, on their overview and in the reader.

  Coding notebooks and projects save cards to their course. Writing notebooks
  save to their linked course or document; unlinked and Coach-only notebooks
  cannot create cards. Personal cards never appear in the course editor or in
  exported or published courses. Local content keeps them in your local profile;
  server-linked content syncs cards, deletions, and review progress privately to
  your account on supporting servers. Document cards survive PDF updates.
- **Visualizations** are small interactive pages inside a lesson. Some open full screen.
- **Find in Course…** (⌘F) searches every lesson.

## Exercises

Programming courses may include exercises that run your code and check it.
**Open editor** on an exercise opens the workbench: the brief, an editor, a
terminal, and **Run checks**. The exercise is complete when its checks pass.

Python exercises run on your Mac using Python bundled with OpenCourse. You do
not need to install Python or the Xcode Command Line Tools. Each course gets its
own local virtual environment; installing pytest and course packages may require
internet access the first time. Update OpenCourse when a course needs a newer
Python version.

Projects may use any language. Follow the project's instructions to install and
configure the required tools yourself.

## Read PDFs

Open **Documents** in the titlebar to import a local PDF or browse a connected
server's document catalog. The reader remembers your page and outline state.
Use the outline or text search to navigate, and highlight a passage to choose
**Ask about this**. Reading chat can retrieve pages and cite references you can
open in the reader. Scanned pages without extractable text may need OCR before
text search and AI reading can use them.

## Personal notebooks

The floating **Notebooks** button at the bottom-left opens your recent
notebooks and searches notebook titles, page titles and page contents. Create a
standalone notebook or one linked to the course or PDF you are viewing.

Each notebook opens in its own window with a page list and a live Markdown
editor. Pages save automatically. Paste or drop PNG, JPEG, WebP or GIF images;
rename and reorder pages from the sidebar. Highlight text and choose **Ask
about this** to chat about it. The conversation continues across pages, can
read other pages and linked material, and never edits your notebook.

Personal notebooks belong to the selected local user and do not sync to a
server. They are separate from **Python notebooks**, which run code in a
course's Python environment. Hide the floating notebook button in **Settings
▸ Appearance** if you do not use it.

## AI features

Connect local AI in **Settings ▸ Connections**: add an **OpenAI API key** or
choose **Continue with ChatGPT**. Provider charges and plan limits apply. The
local credential is protected by your Mac's keychain.

- **Reading chat.** Open **Ask** while reading a lesson or PDF, or highlight
  text and choose **Ask about this**. It retrieves relevant material while
  keeping course quiz answers and exercise solutions out of reading context.
- **Notebook chat.** Ask about personal notebook pages and their linked course
  or PDF using your local AI connection. It has read-only access to your notes.
- **Course authoring.** Ask the editor's assistant to draft or revise a course.
  Review the changes before saving.
- **Coach.** Use the floating **Coaches** button above Notebooks, create or
  choose a coach, and start a spoken conversation. Coach asks for microphone
  access the first time. It can inspect your current lesson, PDF page,
  selection and open notebooks, including unsaved notebook edits, and search
  and read accessible material in your library and connected servers. Each
  coach maintains its own memory between conversations. You can rename or
  delete coaches in the launcher and hide it in **Settings ▸ Appearance**.
  **Settings ▸ Coach** sets the shared voice and background model choices
  used when any coach starts a conversation.
  The former Coach workspace, file browser and session-history screens have
  been removed; memory files are managed by the coach.

Reading chat for **server content** uses a separate OpenAI API key configured
on that server. It never falls back to your local credentials. ChatGPT
connections remain local. Coach and personal notebook chat use your local
connection, including when they read accessible linked or server material.
AI sends the material needed for a response to OpenAI and requires internet
access.

## Learn on the web

Sign in to a connected server's website and open **My learning** to continue
an enrolled course or PDF. The browser supports reading, quizzes, flashcards
and reading chat. Enrolled progress and reading conversations synchronize
between desktop and web; downloaded content remains available on your Mac.

Exercises, projects, Python notebooks, personal notebooks, course authoring
and Coach use the desktop app. Local imports, Coach memory, personal notebooks
and authoring conversations are not uploaded as part of learning sync.

## Write a course

**Course ▸ Create Course…** (⌘N) opens the editor: modules, lessons, quizzes,
exercises and flashcards, with a live preview. Nothing is written to disk until
you choose **Course ▸ Save Course** (⌘S), including changes made by the AI
authoring assistant. **Export ZIP…** gives you an archive you can share.

Courses can also be written by hand, or generated by your own tools. The
[course format](./course-format.md) describes every field.

## Share a course

Connect to a catalog server and sign in, then publish from the course's editor
with **Publish to a server**. Each later version you publish reaches learners
as an update that keeps their progress. You can roll back, unlist or remove a
course from the server's publication management pages. PDFs can also be
published from Documents. Unpublishing hides content from the catalog while
existing enrolled learners keep access; deletion and moderation are separate
actions.

To run a catalog for your class, team or community, see
[hosting a catalog](./self-hosting.md).

## Make it yours

**View ▸ Theme** changes how the app looks: colours, fonts and pictures. Install
themes from **Settings**, or make your own with the
[theme format](./theme-format.md).

## Where your data lives

Everything OpenCourse keeps is in `~/Library/Application Support/opencourse/`,
with separate data per local user: courses, PDFs, progress, personal notebooks,
Coach memory, chats and settings. Back up this folder to protect local data;
local AI credentials also rely on the macOS keychain. Enrolled learning data
is synchronized with its server, whose operator manages its own backups.
