import { editorSmoke } from './editor-smoke'
import { themeChecks } from './theme-smoke'
import { readingSizeChecks } from './reading-smoke'
import { FIXTURE_API, fixtureCourse } from './fixture-identities'
/**
 * Headless smoke check: boots the real window, drives the real renderer, and
 * writes a pass/fail report. Run with `npm run smoke`. Dev-only - main imports
 * it only when OPENCOURSE_SMOKE is set.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, net, type BrowserWindow } from 'electron'
import { RENDERER_CSP } from './csp'
import type { WebContents, WebFrameMain } from 'electron'
import { specResourcesDir } from './paths'

const OUT = process.env['OPENCOURSE_SMOKE_OUT'] ?? '/tmp/opencourse-smoke.json'

interface Result {
  name: string
  ok: boolean
  detail: string
}

/** Electron's stdout is unreliable when it is not attached to a terminal. */
function report(payload: unknown): void {
  try {
    writeFileSync(OUT, JSON.stringify(payload, null, 2))
  } catch {
    /* best effort */
  }
  console.log(JSON.stringify(payload, null, 2))
}

/**
 * Renderer-side checks. Each step is isolated, so one failure reports itself
 * instead of hiding every check after it.
 */
const SCRIPT = `(async () => {
  const results = []
  window.__OPENCOURSE_SMOKE_PROGRESS = results
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (selector, timeout = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const el = document.querySelector(selector)
      if (el) return el
      await sleep(50)
    }
    throw new Error('timed out waiting for ' + selector)
  }
  const step = async (name, fn) => {
    window.__OPENCOURSE_SMOKE_STEP = name
    try {
      const detail = await fn()
      results.push({ name, ok: true, detail: String(detail ?? '') })
    } catch (err) {
      results.push({ name, ok: false, detail: String(err && err.message ? err.message : err) })
    }
  }
  const assert = (cond, message) => {
    if (!cond) throw new Error(message)
  }
  const until = async (test, what, timeout = 4000) => {
    const t0 = Date.now()
    while (!test()) {
      if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what)
      await sleep(50)
    }
  }

  // --- users and importing ---------------------------------------------
  // The app ships no courses and no users, so a smoke run has to become
  // somebody and bring a course with it before anything else can be checked.
  const zips = window.__OPENCOURSE_SMOKE_ZIPS
  let firstUserId = ''

  await step('the picker creates the first user', async () => {
    await waitFor('.users')
    const input = await waitFor('.user-card.new input')
    // React owns the value, so poke the native setter it listens behind.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Smoke')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const create = [...document.querySelectorAll('.user-card.new button')]
      .find((b) => b.textContent.trim() === 'Create')
    assert(create && !create.disabled, 'no enabled Create button')
    create.click()
    await waitFor('.library')
    const session = await window.fixtureAPI.getSession()
    assert(session.user, 'no user in the session after creating one')
    firstUserId = session.user.id
    return session.user.name + ' / ' + session.user.id
  })

  await step('a new user starts with an empty library', async () => {
    const empty = await waitFor('.empty-library')
    assert(document.querySelectorAll('.course-card').length === 0, 'a fresh library had courses in it')
    assert(empty.textContent.includes('No courses yet'), 'the empty state said: ' + empty.textContent)
    return 'empty'
  })

  await step('importing an archive fills the library', async () => {
    const result = await window.fixtureAPI.importCoursePath(zips.example)
    assert(result.status === 'ok', 'import said ' + JSON.stringify(result))
    // The card has to arrive on its own: main broadcasts, the library relists.
    const card = await waitFor('.course-card')
    assert(!document.querySelector('.empty-library'), 'the empty state is still showing')
    return card.querySelector('h3').textContent
  })

  await step('an archive that is not a course is refused with a reason', async () => {
    const before = document.querySelectorAll('.course-card').length
    const result = await window.fixtureAPI.importCoursePath(zips.notACourse)
    assert(result.status !== 'ok', 'a non-course archive imported anyway')
    assert(result.message && result.message.length > 0, 'refused with no reason given')
    await sleep(100)
    assert(document.querySelectorAll('.course-card').length === before, 'the library changed anyway')
    return result.status + ': ' + result.message.slice(0, 60)
  })

  // --- a second language, on the course that is still imported ------------
  const cTarget = {
    courseId: 'opencourse-example',
    moduleId: 'basics',
    lessonId: 'runnable-exercises',
    blockId: 'ex-c-triple-1'
  }

  await step('a C exercise opens with its own file and no environment', async () => {
    const session = await window.fixtureAPI.openExercise(cTarget)
    assert(session.language === 'c', 'unexpected language ' + session.language)
    assert(session.languageLabel === 'C', 'unexpected label ' + session.languageLabel)
    assert(session.learnerFile === 'exercise.c', 'unexpected learner file ' + session.learnerFile)
    // C has nothing to install: the system compiler is the environment.
    assert(session.envDir === undefined, 'C should need no environment, got ' + session.envDir)
    assert(session.depsPath === undefined, 'C should need no dependency file')
    assert(session.hasTests === true && session.canRun === true, 'C exercise should be runnable')
    assert(session.content.includes('int triple'), 'starter code missing from the buffer')
    return session.learnerFile + ' / ' + session.testCommand
  })

  await step('a C exercise compiles and runs for real', async () => {
    const solution = await window.fixtureAPI.getSolution('opencourse-example', 'ex-c-triple-1')
    assert(solution && solution.includes('n * 3'), 'no reference solution')
    let output = ''
    const off = window.fixtureAPI.onRunData((_id, chunk) => { output += chunk })
    const current = await window.fixtureAPI.readExerciseFile(cTarget)
    const result = await window.fixtureAPI.runTests(cTarget, solution, current.mtimeMs)
    off()
    assert(result.status === 'ok', 'run did not complete: ' + JSON.stringify(result).slice(0, 300))
    assert(result.outcome.exitCode === 0, 'the C solution failed its own checks:\\n' + output)
    // A compiled language runs as two visible steps, so the learner can read
    // the compiler's diagnostics where the failures are.
    assert(output.includes('compile'), 'no compile step in the output:\\n' + output)
    assert(output.includes('4 checks passed'), 'the test binary did not report:\\n' + output)
    assert(result.progress.exercises[await window.fixtureNodeId('opencourse-example', 'ex-c-triple-1')].completedAt, 'a green C run did not complete the exercise')
    return 'exit 0'
  })

  await step('a C exercise that does not compile stops before running', async () => {
    const current = await window.fixtureAPI.readExerciseFile(cTarget)
    let output = ''
    const off = window.fixtureAPI.onRunData((_id, chunk) => { output += chunk })
    const result = await window.fixtureAPI.runTests(cTarget, '#include "exercise.h"\\nint triple(int n) { return n + }\\n', current.mtimeMs)
    off()
    assert(result.status === 'ok', 'run did not complete: ' + JSON.stringify(result).slice(0, 300))
    assert(result.outcome.exitCode !== 0, 'a syntax error passed')
    assert(result.outcome.failedStep === 'compile', 'expected the compile step to fail, got ' + result.outcome.failedStep)
    assert(/error/i.test(output), 'no compiler diagnostics were streamed:\\n' + output)
    return 'compile failed, as it should'
  })

  await step('an expected-output exercise is graded by what it printed', async () => {
    const ioTarget = { ...cTarget, blockId: 'ex-c-hello-1' }
    const session = await window.fixtureAPI.openExercise(ioTarget)
    assert(session.hasTests === false, 'ex-c-hello-1 has no test file')
    assert(session.canRun === true, 'an expected-output exercise is still runnable')

    let output = ''
    const off = window.fixtureAPI.onRunData((_id, chunk) => { output += chunk })
    const wrong = await window.fixtureAPI.runTests(
      ioTarget, '#include <stdio.h>\\nint main(void) { puts("Goodbye"); return 0; }\\n', session.mtimeMs
    )
    assert(wrong.status === 'ok' && wrong.outcome.exitCode !== 0, 'the wrong output passed')
    assert(output.includes('expected:'), 'no output diff was shown:\\n' + output)

    output = ''
    const solution = await window.fixtureAPI.getSolution('opencourse-example', 'ex-c-hello-1')
    const current = await window.fixtureAPI.readExerciseFile(ioTarget)
    const right = await window.fixtureAPI.runTests(ioTarget, solution, current.mtimeMs)
    off()
    assert(right.status === 'ok' && right.outcome.exitCode === 0, 'the right output failed:\\n' + output)
    return 'output compared both ways'
  })

  await step('a second course imports alongside the first', async () => {
    const result = await window.fixtureAPI.importCoursePath(zips.asyncio)
    assert(result.status === 'ok', 'import said ' + JSON.stringify(result))
    await sleep(200)
    assert(document.querySelectorAll('.course-card').length === 2, 'expected two courses')
    // The checks below are written against the asyncio course's exact shape,
    // so the example goes again once it has proved importing works.
    await window.fixtureAPI.removeCourse('opencourse-example')
    await sleep(200)
    const cards = document.querySelectorAll('.course-card')
    assert(cards.length === 1, 'expected one course after removing, got ' + cards.length)
    return cards[0].querySelector('h3').textContent
  })

  // --- library ---------------------------------------------------------
  let coverSize = ''
  let coverPixels = ''
  await step('library lists a course', async () => {
    const card = await waitFor('.course-card')
    const img = card.querySelector('img')
    assert(img, 'no cover image element')
    if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r })
    await img.decode()
    // Loading is not painting: an SVG served over opencourse:// decodes and reports
    // its size but renders blank, so count the pixels that actually land.
    const canvas = document.createElement('canvas')
    canvas.width = 40
    canvas.height = 40
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, 40, 40)
    const data = ctx.getImageData(0, 0, 40, 40).data
    let opaque = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++
    coverPixels = opaque + '/1600 opaque px'
    const title = card.querySelector('h3').textContent
    card.click()
    return title
  })

  await step('the cover art actually paints', () => {
    assert(coverPixels.startsWith('1600/'), 'the cover rendered blank: ' + coverPixels)
    return coverPixels
  })

  // --- course detail -----------------------------------------------------
  await step('course page renders', async () => (await waitFor('.detail h1')).textContent)
  await step('contents lists every lesson and project', async () => {
    const rows = document.querySelectorAll('.lesson-row').length
    const expected = (await window.fixtureAPI.getCourse('python-asyncio')).flatItems.length
    assert(rows === expected, rows + ' rows, expected ' + expected)
    return rows + ' lessons'
  })
  await step('description rendered as markdown', () => {
    assert(document.querySelectorAll('.detail .prose code').length > 0, 'no inline code in the description')
  })
  await step('prerequisites panel shown', () => {
    assert(document.body.textContent.includes('Before you start'), 'no prerequisites panel')
  })
  await step('start course', async () => {
    const start = [...document.querySelectorAll('button')].find((b) => /start course/i.test(b.textContent))
    assert(start, 'no start button (a fresh profile should not show Continue)')
    // Click the first lesson row, so the run does not depend on saved progress.
    document.querySelector('.lesson-row').click()
    const title = (await waitFor('.lesson-head h1')).textContent
    assert(title === "Why async, and what it isn't", 'unexpected first lesson: ' + title)
    return title
  })

  // --- lesson -------------------------------------------------------------
  await step('sidebar lists all lessons and projects', async () => {
    const n = document.querySelectorAll('.sidebar a').length
    const expected = (await window.fixtureAPI.getCourse('python-asyncio')).flatItems.length + 1
    assert(n === expected, n + ' sidebar links, expected ' + expected)
    return n + ' links'
  })
  await step('objectives rendered', () => {
    const n = document.querySelectorAll('.objectives li').length
    assert(n > 2, n + ' objectives')
    return n + ' objectives'
  })
  await step('markdown blocks rendered', () => {
    const n = document.querySelectorAll('.prose').length
    assert(n >= 2, n + ' prose blocks')
    return n + ' prose blocks'
  })
  await step('syntax highlighting applied', () => {
    const n = document.querySelectorAll('pre.shiki').length
    assert(n > 0, 'no highlighted code')
    return n + ' highlighted blocks'
  })
  await step('tables rendered', () => {
    assert(document.querySelectorAll('.prose table').length > 0, 'no tables')
  })
  await step('takeaways card present', () => {
    assert(document.querySelectorAll('.takeaways').length === 1, 'expected exactly one takeaways card')
  })

  // --- visualization --------------------------------------------------------
  await step('visualization iframe present and sandboxed', () => {
    const iframe = document.querySelector('.viz-frame iframe')
    assert(iframe, 'no viz iframe')
    assert(iframe.src.startsWith('opencourse://'), 'viz is not served over opencourse://')
    assert(iframe.getAttribute('sandbox') === 'allow-scripts', 'viz sandbox is ' + iframe.getAttribute('sandbox'))
    assert(iframe.getBoundingClientRect().height > 200, 'viz has no height')
    return iframe.src
  })
  await step('viz runs in an opaque origin', async () => {
    const iframe = document.querySelector('.viz-frame iframe')
    iframe.scrollIntoView()              // it is lazy-loaded
    await sleep(1200)
    // A sandbox without allow-same-origin gives the frame an opaque origin, so
    // neither side can touch the other's document. Chromium reports that as a
    // null contentDocument; a frame still sitting on about:blank would not.
    assert(iframe.contentDocument === null, 'the viz document is same-origin with the app')
    return 'contentDocument is null'
  })

  // --- quiz -----------------------------------------------------------------
  await step('quiz submits and gives feedback', async () => {
    const quiz = document.querySelector('.quiz')
    assert(quiz, 'no quiz on this lesson')
    quiz.querySelector('input[type=radio]').click()
    ;[...quiz.querySelectorAll('button')].find((b) => /check/i.test(b.textContent)).click()
    const feedback = await waitFor('.quiz .feedback')
    assert(/correct|not quite/i.test(feedback.textContent), 'no verdict: ' + feedback.textContent)
    assert(feedback.querySelector('.explanation'), 'no explanation with the verdict')
    return feedback.textContent.slice(0, 40)
  })

  // --- completion -------------------------------------------------------------
  await step('lesson completion toggles and shows in the sidebar', async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => /mark lesson completed/i.test(b.textContent))
    assert(btn, 'no completion button')
    btn.click()
    await sleep(400)
    assert(/completed/i.test(btn.textContent), 'button did not change: ' + btn.textContent)
    // The mark is a masked disc with no text, so what has to be true is that it paints, in the theme's success colour.
    const mark = document.querySelector('.sidebar a.current .check.done')
    assert(mark, 'no completion mark in the sidebar')
    const disc = getComputedStyle(mark, '::before')
    const ok = getComputedStyle(document.documentElement).getPropertyValue('--ok').trim()
    const probe = document.createElement('span'); probe.style.color = ok; document.body.append(probe)
    const okRgb = getComputedStyle(probe).color; probe.remove()
    assert(disc.backgroundColor === okRgb, 'the mark is ' + disc.backgroundColor + ', not --ok ' + okRgb)
    assert(parseFloat(disc.width) >= 10 && disc.maskImage.includes('url('), 'the mark has no size or no mask: ' + disc.width + ' ' + disc.maskImage)
    return btn.textContent
  })

  await step('every lesson title in the chapter list starts at the same column', async () => {
    // The check slot is a flex item, and an empty one shrank whenever its title
    // wrapped - so long titles sat further left than short ones. A wrapping
    // title and a ticked one both have to be on screen for this to mean much.
    const titles = [...document.querySelectorAll('.sidebar a > span:last-child')]
    assert(titles.length > 3, 'only ' + titles.length + ' lesson titles in the sidebar')
    const lines = titles.map((t) => t.getClientRects().length > 1 || t.getBoundingClientRect().height > 30)
    assert(lines.some(Boolean), 'no lesson title wraps, so this proves nothing')
    assert(document.querySelector('.sidebar .check.done'), 'no ticked lesson')
    const lefts = titles.map((t) => Math.round(t.getBoundingClientRect().left * 2) / 2)
    const spread = Math.max(...lefts) - Math.min(...lefts)
    assert(spread < 1, 'titles start between ' + Math.min(...lefts) + 'px and ' + Math.max(...lefts) + 'px')
    // The course title is a link, and links in the sidebar are padded; its
    // container was padded as well, which put it a step right of the chapters.
    const textLeft = (el) => { const range = document.createRange(); range.selectNodeContents(el); return Math.round(range.getClientRects()[0].left) }
    const course = textLeft(document.querySelector('.sidebar .course-title a'))
    const chapter = textLeft(document.querySelector('.sidebar .module-title'))
    assert(Math.abs(course - chapter) <= 1, 'the course title starts at ' + course + 'px and the chapters at ' + chapter + 'px')
    return titles.length + ' titles at ' + lefts[0] + 'px, ' + lines.filter(Boolean).length + ' wrapping; course title and chapters at ' + chapter + 'px'
  })

  // --- exercise scaffolding ------------------------------------------------------
  await step('exercise scaffolds a workspace, and nothing opens Terminal.app', async () => {
    const session = await window.fixtureAPI.openExercise({
      courseId: 'python-asyncio',
      moduleId: 'coroutines-and-tasks',
      lessonId: 'await-and-tasks',
      blockId: 'ex-tasks-1'
    })
    assert(session.exerciseDir.endsWith('/exercises/' + await window.fixtureNodeId('python-asyncio', 'ex-tasks-1')), 'unexpected dir ' + session.exerciseDir)
    assert(session.testCommand === 'pytest -q', 'unexpected command ' + session.testCommand)
    // The built-in editor is the only way into an exercise. Its Terminal tab is
    // a different thing and stays; the door to Terminal.app does not.
    assert(!('scaffoldExercise' in window.fixtureAPI), 'the bridge still offers to open Terminal.app')
    assert(!('revealPath' in window.fixtureAPI), 'the bridge still reveals arbitrary paths')
    return session.exerciseDir
  })

  // --- the workbench: edit and save ----------------------------------------------
  const target = {
    courseId: 'python-asyncio',
    moduleId: 'coroutines-and-tasks',
    lessonId: 'await-and-tasks',
    blockId: 'ex-tasks-1'
  }

  await step('exercise opens for editing with the starter in it', async () => {
    const session = await window.fixtureAPI.openExercise(target)
    assert(session.exerciseDir.endsWith('/exercises/' + await window.fixtureNodeId('python-asyncio', 'ex-tasks-1')), 'unexpected dir ' + session.exerciseDir)
    assert(session.content.includes('async def fetch'), 'starter code missing from the buffer')
    assert(session.hasTests === true, 'ex-tasks-1 should report tests')
    assert(session.canRun === true, 'ex-tasks-1 should be runnable')
    assert(session.language === 'python', 'unexpected language ' + session.language)
    assert(session.learnerFile === 'exercise.py', 'unexpected learner file ' + session.learnerFile)
    assert(session.testCommand === 'pytest -q', 'unexpected command ' + session.testCommand)
    assert(typeof session.mtimeMs === 'number' && session.mtimeMs > 0, 'no mtime')
    return session.envDir
  })

  await step('edits round-trip to disk', async () => {
    const before = await window.fixtureAPI.openExercise(target)
    const edited = before.content + '\\n# edited by smoke\\n'
    const write = await window.fixtureAPI.writeExerciseFile(target, edited, before.mtimeMs)
    assert(write.ok, 'write refused: ' + JSON.stringify(write))
    const after = await window.fixtureAPI.readExerciseFile(target)
    assert(after.content === edited, 'file did not round-trip')
    // Re-opening must not clobber the learner's work.
    const reopened = await window.fixtureAPI.openExercise(target)
    assert(reopened.content === edited, 'reopening the exercise overwrote the edit')
    return String(edited.length) + ' bytes'
  })

  await step('a file changed underneath is reported, not clobbered', async () => {
    const current = await window.fixtureAPI.readExerciseFile(target)
    const stale = current.mtimeMs - 5000
    const write = await window.fixtureAPI.writeExerciseFile(target, '# from the app\\n', stale)
    assert(!write.ok && write.reason === 'conflict', 'expected a conflict, got ' + JSON.stringify(write))
    assert(write.content === current.content, 'conflict did not return the on-disk content')
    // Overwrite (expected mtime null) is how the banner's Overwrite button wins.
    const forced = await window.fixtureAPI.writeExerciseFile(target, current.content, null)
    assert(forced.ok, 'forced overwrite failed')
    return 'conflict detected'
  })

  await step('an oversized buffer is refused', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 10)
    const write = await window.fixtureAPI.writeExerciseFile(target, huge, null)
    assert(!write.ok && write.reason === 'too-large', 'expected too-large, got ' + JSON.stringify(write))
    return 'refused'
  })

  if (window.__OPENCOURSE_SMOKE_PYTHON) {
    await step('the checks actually run, and a green run completes the exercise', async () => {
      const course = await window.fixtureAPI.getCourse('python-asyncio')
      const solution = await window.fixtureAPI.getSolution('python-asyncio', 'ex-tasks-1')
      assert(solution && solution.includes('async def main'), 'no reference solution')
      void course

      let output = ''
      const off = window.fixtureAPI.onRunData((_id, chunk) => { output += chunk })
      const current = await window.fixtureAPI.readExerciseFile(target)
      const result = await window.fixtureAPI.runTests(target, solution, current.mtimeMs)
      off()

      assert(result.status === 'ok', 'run did not complete: ' + JSON.stringify(result).slice(0, 300))
      assert(result.outcome.exitCode === 0, 'solution failed its own tests:\\n' + output)
      assert(output.includes('passed'), 'no pytest output was streamed:\\n' + output)
      assert(result.progress.exercises[await window.fixtureNodeId('python-asyncio', 'ex-tasks-1')].completedAt, 'a green run did not mark the exercise complete')
      return output.trim().split('\\n').pop()
    })

    await step('a failing run does not mark the exercise complete', async () => {
      const current = await window.fixtureAPI.readExerciseFile(target)
      const result = await window.fixtureAPI.runTests(target, 'def main():\\n    return None\\n', current.mtimeMs)
      assert(result.status === 'ok', 'run did not complete: ' + JSON.stringify(result).slice(0, 300))
      assert(result.outcome.exitCode !== 0, 'a broken exercise passed')
      const entry = result.progress.exercises[await window.fixtureNodeId('python-asyncio', 'ex-tasks-1')]
      assert(entry.lastRun && entry.lastRun.passed === false, 'the failed run was not recorded')
      // Sticky: an earlier green run must not be undone by a later red one.
      assert(entry.completedAt, 'a failing run un-completed the exercise')
      return 'exit ' + result.outcome.exitCode
    })
  }

  // --- the interactive terminal ---------------------------------------------------
  await step('a real pty runs a command and streams its output', async () => {
    const session = await window.fixtureAPI.openExercise(target)
    let output = ''
    const off = window.fixtureAPI.onPtyData((_id, chunk) => { output += chunk })
    const created = await window.fixtureAPI.createPty('smoke-1', {
      cwd: session.exerciseDir, envDir: session.envDir, language: session.language, cols: 80, rows: 24
    })
    assert(created.ok, 'pty did not start: ' + created.error)
    await window.fixtureAPI.writePty('smoke-1', 'echo opencourse-pty-ok\\r')
    const t0 = Date.now()
    while (!output.includes('opencourse-pty-ok') && Date.now() - t0 < 8000) await sleep(50)
    off()
    assert(output.includes('opencourse-pty-ok'), 'no echo came back: ' + JSON.stringify(output.slice(0, 200)))
    return 'streamed ' + output.length + ' chars'
  })

  await step('the venv leads PATH inside the terminal', async () => {
    const session = await window.fixtureAPI.openExercise(target)
    let output = ''
    const off = window.fixtureAPI.onPtyData((_id, chunk) => { output += chunk })
    await window.fixtureAPI.createPty('smoke-2', {
      cwd: session.exerciseDir, envDir: session.envDir, language: session.language, cols: 80, rows: 24
    })
    await window.fixtureAPI.writePty('smoke-2', 'echo "VENV:$VIRTUAL_ENV"\\r')
    const t0 = Date.now()
    while (!output.includes('VENV:/') && Date.now() - t0 < 8000) await sleep(50)
    off()
    await window.fixtureAPI.killPty('smoke-2')
    assert(output.includes(session.envDir), 'VIRTUAL_ENV was not the course venv: ' + JSON.stringify(output.slice(0, 300)))
    return 'venv active'
  })

  await step('killing a terminal disposes it', async () => {
    await window.fixtureAPI.killPty('smoke-1')
    await sleep(200)
    const count = await window.fixtureAPI.ptyCount()
    assert(count === 0, count + ' shells still alive after kill')
    return 'no orphans'
  })

  // --- search ---------------------------------------------------------------------
  await step('search finds a lesson', async () => {
    const course = await window.fixtureAPI.getCourse('python-asyncio')
    assert(course.modules.length > 0, 'the course has no modules')
    assert(course.modules[0].lessons[0].blocks.some((b) => b.type === 'quiz'), 'no quiz blocks reached the renderer')
    const quiz = course.modules[0].lessons[0].blocks.find((b) => b.type === 'quiz')
    assert(!quiz.explanation, 'the renderer was handed a quiz explanation')
    assert(quiz.options.every((o) => o.correct === false), 'the renderer was handed the quiz answers')
    return 'answers withheld from the renderer'
  })

  // --- navigation -------------------------------------------------------------------
  await step('next lesson navigates', async () => {
    const before = document.querySelector('.lesson-head h1').textContent
    const next = [...document.querySelectorAll('.lesson-nav button')].find((b) => b.textContent.includes('→'))
    assert(next, 'no next button')
    next.click()
    await sleep(600)
    const after = document.querySelector('.lesson-head h1').textContent
    assert(after !== before, 'title did not change')
    return after
  })

  // --- the side chat -----------------------------------------------------
  // A smoke run has no OpenAI key, which is the interesting half: everything up
  // to the moment money would be spent has to work, and the moment itself has
  // to say so rather than fail.
  await step('highlighting a passage offers to ask about it, and opens the chat', async () => {
    assert(!document.querySelector('.sidechat'), 'the side chat was already open')
    const prose = await waitFor('.content-inner .prose p')
    const range = document.createRange()
    range.selectNodeContents(prose)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    const offer = await waitFor('.ask-about')
    const where = offer.getBoundingClientRect()
    assert(where.width > 0 && where.height > 0, 'the offer rendered with no size')
    // The highlight is the point: an offer to ask about a passage you can no
    // longer see the edges of is an offer about nothing. It died a frame after
    // the offer appeared, so let a frame pass before believing it survived -
    // React 19 rewrites innerHTML on every render of a block, see Html.tsx.
    await new Promise((r) => requestAnimationFrame(r))
    await sleep(60)
    assert(document.contains(prose), 'the paragraph was replaced under the selection')
    assert(window.getSelection().toString().trim().length > 10,
      'the selection went as soon as the offer appeared: "' + window.getSelection().toString() + '"')

    // A real press, not offer.click(). The document mouseup listener that
    // creates this button also fires on the button's own mouseup, and a synthetic
    // click skips that entirely - which is how this check passed while the
    // feature did not work at all.
    const at = { bubbles: true, clientX: where.left + where.width / 2, clientY: where.top + where.height / 2 }
    offer.dispatchEvent(new MouseEvent('mousedown', at))
    offer.dispatchEvent(new MouseEvent('mouseup', at))
    await sleep(50)
    assert(document.querySelector('.ask-about'), 'the offer vanished between press and release')
    offer.dispatchEvent(new MouseEvent('click', at))

    const chip = await waitFor('.sidechat-quote blockquote')
    // The ordinary selection cannot survive here - the composer takes focus and
    // a document has only one selection - so the passage is marked with a
    // custom highlight instead, and that is what has to still be there.
    assert(CSS.highlights.has('ask-quote'), 'the attached passage is not marked in the lesson')
    const label = document.querySelector('.sidechat-quote-label').textContent
    assert(label === 'From the lesson', 'a lesson passage is labelled "' + label + '"')
    const quoted = chip.textContent.trim()
    assert(quoted.length > 10, 'the attached quote was: ' + quoted)
    assert(prose.textContent.indexOf(quoted.slice(0, 30)) !== -1, 'the quote is not from the lesson')
    return quoted.slice(0, 40) + '…'
  })

  await step('the panel has a size, and leaves the lesson readable beside it', async () => {
    const panel = await waitFor('.sidechat')
    await waitFor('.sidechat-tab')
    const box = panel.getBoundingClientRect()
    assert(box.width > 200, 'the panel rendered ' + box.width + 'px wide')
    assert(box.height > 200, 'the panel rendered ' + box.height + 'px tall')
    const lesson = document.querySelector('.content').getBoundingClientRect()
    assert(lesson.width > 300, 'the lesson column was squeezed to ' + lesson.width + 'px')
    for (const selector of ['.sidebar a.current', '.sidechat-tab.active']) {
      const selected = getComputedStyle(document.querySelector(selector))
      assert(selected.color === 'rgb(222, 222, 227)' && selected.backgroundImage.startsWith('linear-gradient'), selector + ' lost its light text or dark gradient')
    }
    return Math.round(box.width) + 'px panel, ' + Math.round(lesson.width) + 'px lesson'
  })

  await step('the composer grows with what you write, stops at a ceiling, and shrinks back', async () => {
    const field = await waitFor('.sidechat-input')
    const send = () => document.querySelector('.sidechat-send')
    // React owns the value, so poke the native setter it listens behind.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    const write = async (text) => {
      setter.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(350) // past the height transition
      // Under load React can commit late; wait for the actual transition too.
      await Promise.race([
        Promise.all(field.getAnimations().map((animation) => animation.finished.catch(() => {}))),
        sleep(2000)
      ])
      return field.getBoundingClientRect().height
    }
    const empty = await write('')
    assert(send().disabled, 'Send is live with nothing to send')
    const three = await write('one\\ntwo\\nthree')
    assert(!send().disabled, 'Send stayed off with a question written')
    assert(three > empty + 20, 'three lines left the box at ' + three + 'px, from ' + empty + 'px')
    const ceiling = parseFloat(getComputedStyle(field).maxHeight)
    const full = await write(Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\\n'))
    assert(Math.abs(full - ceiling) < 2, 'forty lines made the box ' + full + 'px, ceiling ' + ceiling + 'px')
    assert(getComputedStyle(field).overflowY === 'auto', 'a full box cannot be scrolled')
    const back = await write('')
    assert(Math.abs(back - empty) < 2, 'clearing it left the box at ' + back + 'px, from ' + empty + 'px')
    assert(getComputedStyle(field).overflowY === 'hidden', 'an empty box still scrolls')
    return Math.round(empty) + ' → ' + Math.round(three) + ' → ' + Math.round(full) + ' (ceiling) → ' + Math.round(back) + 'px'
  })

  await step('the panes scroll on the thin app scrollbar, not the platform one', async () => {
    // Measured, not read from a stylesheet: Chromium silently drops every
    // ::-webkit-scrollbar rule for an element with scrollbar-width or
    // scrollbar-color set, and the platform bar comes back about 15px wide.
    const gutter = (el) => {
      const style = getComputedStyle(el)
      return el.offsetWidth - el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
    }
    const panes = ['.content.scroll', '.sidebar.scroll', '.sidechat-scroll']
      .map((selector) => [selector, document.querySelector(selector)])
      .filter(([, el]) => el && el.scrollHeight > el.clientHeight)
    assert(panes.some(([selector]) => selector === '.content.scroll'), 'the lesson column does not scroll at all')
    const wrong = panes.filter(([, el]) => gutter(el) !== 10)
    assert(wrong.length === 0, wrong.map(([selector, el]) => selector + ' has a ' + gutter(el) + 'px scrollbar').join(', '))
    return panes.map(([selector]) => selector).join(', ') + ': 10px each'
  })

  await step('it says it needs a key, and a refused first question leaves no chat behind', async () => {
    const note = await waitFor('.sidechat-note')
    assert(/key/i.test(note.textContent), 'the note said: ' + note.textContent)
    // The tab the panel opened with is a draft: it is in no list until it is asked something.
    assert((await window.fixtureAPI.listChats('python-asyncio')).length === 0, 'opening the panel registered a chat')
    const field = document.querySelector('.sidechat-input')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'will this cost me anything?')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(50)
    document.querySelector('.sidechat-send').click()
    await until(() => /key/i.test(document.querySelector('.sidechat-error')?.textContent ?? ''), 'the refusal to be shown')
    // Asking creates the chat; main refusing the question takes it away again.
    assert((await window.fixtureAPI.listChats('python-asyncio')).length === 0, 'a refused question left a chat behind')
    assert(field.value === 'will this cost me anything?', 'the refused question was not kept to try again')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return 'refused with no-key, nothing stored'
  })

  await step('a second tab opens and closes, and neither tab registers a chat', async () => {
    document.querySelector('.sidechat-new').click()
    await sleep(500)
    let tabs = document.querySelectorAll('.sidechat-tab')
    assert(tabs.length === 2, tabs.length + ' tabs, expected 2')
    const kept = (await window.fixtureAPI.listChats('python-asyncio')).length
    assert(kept === 0, kept + ' chats for two untouched tabs')
    tabs[1].querySelector('.sidechat-tab-close').click()
    await sleep(300)
    tabs = document.querySelectorAll('.sidechat-tab')
    assert(tabs.length === 1, tabs.length + ' tabs after closing one')
    const after = (await window.fixtureAPI.listChats('python-asyncio')).length
    assert(after === kept, 'closing a tab deleted a chat: ' + kept + ' -> ' + after)
    return kept + ' chats kept, 1 tab open'
  })

  await step('history lists this course chats, not the open draft and not other courses', async () => {
    document.querySelector('.sidechat-history-toggle').click()
    const history = await waitFor('.sidechat-history')
    const rows = history.querySelectorAll('.sidechat-history-row')
    const mine = await window.fixtureAPI.listChats('python-asyncio')
    assert(rows.length === mine.length, rows.length + ' rows for ' + mine.length + ' chats')
    assert(rows.length === 0 && /No conversations yet/.test(history.textContent), 'the untouched tab is listed: ' + history.textContent)
    assert((await window.fixtureAPI.listChats('opencourse-example')).length === 0, 'another course had chats')
    document.querySelector('.sidechat-history-toggle').click()
    return rows.length + ' chats, all this course'
  })

  await step('the side chat surface is exactly what the bridge means to expose', async () => {
    const methods = Object.keys(window.opencourse).filter((k) => /Chat/.test(k) && !/ProjectChat/.test(k)).sort()
    assert(
      methods.join(',') ===
        'cancelChat,createChat,deleteChat,getChat,getChatModelSettings,getChatSourceIcons,getChatWebSearch,' +
          'listChatModels,listChats,onChatActivity,onChatDelta,onChatDone,onChatError,onChatTitle,sendChatMessage,' +
          'setChatDefaults,setChatModel,setChatReasoning,setChatWebSearch,setEnabledChatModels',
      'the side chat surface changed: ' + methods.join(', ')
    )
    return methods.length + ' methods'
  })

  await step('the editor opens beside the exercise brief, and the chat is not offered there', async () => {
    // Three columns: the chapter list, the exercise's task, and the code. What
    // must not be there is the chat, which has no lesson on screen to be about.
    const lessonWithExercise = [...document.querySelectorAll('.sidebar a')]
      .find((a) => /await, create_task/i.test(a.textContent))
    assert(lessonWithExercise, 'no lesson with an exercise in the sidebar')
    lessonWithExercise.click()
    assert(document.querySelector('.sidechat'), 'the chat did not survive the lesson change')
    const content = await waitFor('.content')
    content.scrollTop = 240
    const wasAt = content.scrollTop
    assert(wasAt > 0, 'the lesson would not scroll, so there is nothing to restore')

    const card = await waitFor('.exercise')
    assert(!/terminal/i.test(card.querySelector('.actions').textContent),
      'the exercise card still offers a terminal: ' + card.querySelector('.actions').textContent)
    const prompt = card.querySelector('.prompt').textContent.trim().slice(0, 40)
    const open = [...card.querySelectorAll('.actions button')].find((b) => /open editor/i.test(b.textContent))
    assert(open, 'no Open editor button')
    open.click()
    const workbench = await waitFor('.workbench')
    await waitFor('.workbench .cm-content')
    await sleep(400)

    assert(!document.querySelector('.sidechat'), 'the chat is still open over the editor')
    assert(!document.querySelector('.titlebar .chat-chip'), 'the editor still offers the chat')
    assert(document.querySelector('.content').hidden, 'the lesson column is still on screen')
    const chapters = document.querySelector('.sidebar').getBoundingClientRect()
    assert(chapters.width > 100, 'the chapter list went away with the lesson')

    const brief = workbench.querySelector('.workbench-brief')
    assert(brief, 'no exercise brief beside the editor')
    assert(brief.textContent.includes(prompt), 'the brief does not show the exercise prompt')
    assert(!brief.querySelector('.actions button') ||
      ![...brief.querySelectorAll('.actions button')].some((b) => /open editor/i.test(b.textContent)),
      'the brief offers to open the editor it sits beside')
    const left = brief.getBoundingClientRect()
    const editor = workbench.querySelector('.workbench-main').getBoundingClientRect()
    assert(left.left >= chapters.right - 1, 'the brief is not right of the chapter list')
    assert(editor.left >= left.right - 4, 'the editor is not right of the brief')
    assert(left.width > 200, 'the brief is ' + Math.round(left.width) + 'px wide')
    assert(editor.width > 320, 'the editor is ' + Math.round(editor.width) + 'px wide')
    assert(Math.abs(editor.right - window.innerWidth) < 2, 'the editor does not reach the window edge')
    const body = document.querySelector('.body')
    assert(body.scrollWidth <= body.clientWidth + 1, 'the window scrolls sideways with the editor open')

    // The grip is the learner's: a drag to the right widens the brief.
    const grip = workbench.querySelector('.workbench-grip')
    const g = grip.getBoundingClientRect()
    const at = (x) => ({ bubbles: true, clientX: x, clientY: g.top + 100, pointerId: 1 })
    grip.dispatchEvent(new PointerEvent('pointerdown', at(g.left + 3)))
    window.dispatchEvent(new PointerEvent('pointermove', at(g.left + 63)))
    window.dispatchEvent(new PointerEvent('pointerup', at(g.left + 63)))
    await sleep(100)
    const widened = brief.getBoundingClientRect().width
    assert(widened > left.width + 40, 'dragging the grip left the brief at ' + Math.round(widened) + 'px')
    assert(body.scrollWidth <= body.clientWidth + 1,
      'widening the brief made the window scroll sideways: ' + body.scrollWidth + ' > ' + body.clientWidth)

    const back = [...brief.querySelectorAll('.workbench-back')]
      .find((b) => /back/i.test(b.textContent))
    assert(back, 'no way back to the lesson')
    back.click()
    await sleep(400)
    assert(!document.querySelector('.workbench'), 'the editor is still open')
    assert(document.querySelector('.lesson-head h1'), 'the lesson did not come back')
    assert(document.querySelector('.sidechat'), 'the chat did not come back with the lesson')
    const after = document.querySelector('.content').scrollTop
    assert(after === wasAt, 'the lesson came back at ' + after + ', not ' + wasAt)
    return Math.round(left.width) + 'px brief → ' + Math.round(widened) + 'px, ' +
      Math.round(editor.width) + 'px editor, lesson restored at ' + Math.round(after)
  })

  await step('the titlebar chip is what opens and closes the chat', async () => {
    // The only control there is: the menu item and its accelerator are gone, so
    // a chip that stops toggling leaves the feature unreachable but for a
    // highlight.
    const chip = await waitFor('.titlebar .chat-chip')
    assert(document.querySelector('.sidechat'), 'expected the chat open at this point')
    assert(chip.getAttribute('aria-pressed') === 'true', 'the chip does not show it is on')
    chip.click()
    await sleep(300)
    assert(!document.querySelector('.sidechat'), 'the chip did not close the panel')
    assert(
      document.querySelector('.titlebar .chat-chip').getAttribute('aria-pressed') === 'false',
      'the chip still shows it is on'
    )
    document.querySelector('.titlebar .chat-chip').click()
    await waitFor('.sidechat-tab')
    assert(document.querySelector('.sidechat'), 'the chip did not open the panel again')
    return 'closed and opened from the titlebar'
  })

  await step('the model picker sits under the composer and opens upwards, on screen', async () => {
    const trigger = document.querySelector('.sidechat-model')
    assert(trigger, 'no model picker')
    assert(trigger.closest('.sidechat-composer'), 'the model picker is not in the composer')
    trigger.click()
    const panel = await waitFor('.menu-panel')
    const from = trigger.getBoundingClientRect()
    const box = panel.getBoundingClientRect()
    // At the foot of the window "below" is off screen, which is where the list
    // used to open from the header and where it would open from here unflipped.
    assert(box.bottom <= from.top + 1, 'the list opens over or under its trigger: ' + Math.round(box.top) + '..' +
      Math.round(box.bottom) + ', trigger at ' + Math.round(from.top))
    assert(box.top >= 0 && box.right <= window.innerWidth, 'the list is off screen: ' + JSON.stringify(box))
    trigger.click()
    await sleep(100)
    return 'list at ' + Math.round(box.top) + '..' + Math.round(box.bottom) + ', trigger at ' + Math.round(from.top)
  })

  await step('the model picker survives scrolling its own list', async () => {
    document.querySelector('.sidechat-model').click()
    const panel = await waitFor('.menu-panel')
    const models = [...panel.querySelectorAll('.menu-item')]
    assert(models.length > 0, 'the picker lists no models')
    assert(models.filter((m) => m.getAttribute('aria-checked') === 'true').length === 1,
      'the picker marks ' + models.filter((m) => m.getAttribute('aria-checked') === 'true').length + ' models')

    // Scroll does not bubble, so the dismiss listener runs in the capture phase
    // and used to see the panel's own scrolling as the viewport moving - the
    // list shut the instant you reached for the model below the fold. The
    // fallback list is too short to really overflow, so dispatch the event.
    panel.dispatchEvent(new Event('scroll', { bubbles: false }))
    await sleep(150)
    assert(document.querySelector('.menu-panel'), 'scrolling the list closed it')

    // Scrolling the page under it still should close it: the panel is fixed to
    // the viewport and would otherwise float away from its trigger.
    document.querySelector('.content.scroll').dispatchEvent(new Event('scroll', { bubbles: false }))
    await sleep(150)
    assert(!document.querySelector('.menu-panel'), 'scrolling the lesson left the menu behind')
    return models.length + ' models, one checked'
  })

  await step('the reasoning picker offers what the model takes, and drops what the next one cannot', async () => {
    const reasoning = () => document.querySelector('.sidechat-reasoning')
    const pick = async (trigger, label) => {
      trigger.click()
      const panel = await waitFor('.menu-panel')
      const item = [...panel.querySelectorAll('.menu-item')]
        .find((b) => b.querySelector('.menu-item-label').textContent.trim() === label)
      assert(item, 'nothing called ' + label + ' in ' + panel.textContent)
      item.click()
    }
    const model = document.querySelector('.sidechat-model').textContent.trim()
    assert(reasoning(), 'no reasoning picker for ' + model)
    assert(reasoning().textContent.trim() === 'Default', 'a new chat starts on ' + reasoning().textContent)
    reasoning().click()
    const levels = [...(await waitFor('.menu-panel')).querySelectorAll('.menu-item-label')].map((l) => l.textContent.trim())
    reasoning().click()
    await sleep(100)
    assert(levels[0] === 'Default' && levels.includes('Extra high'), model + ' offers ' + levels.join(', '))

    await pick(reasoning(), 'Extra high')
    await until(() => reasoning().textContent.trim() === 'Extra high', 'the picker to say Extra high')
    // The draft keeps the level itself; its chat is created with it when it is first asked something.
    assert((await window.fixtureAPI.listChats('python-asyncio')).length === 0, 'choosing a level registered a chat')

    // gpt-5-mini is a generation that never had xhigh: carried over, the next
    // question would be a 400.
    await pick(document.querySelector('.sidechat-model'), 'gpt-5-mini')
    await until(() => reasoning()?.textContent.trim() === 'Default', 'the level to go back to Default')
    // gpt-4.1 takes no level at all, and then there is nothing to pick.
    await pick(document.querySelector('.sidechat-model'), 'gpt-4.1')
    await until(() => !reasoning(), 'the reasoning picker to go')
    await pick(document.querySelector('.sidechat-model'), model)
    await until(() => reasoning(), 'the reasoning picker to come back')
    return model + ': ' + levels.join(', ')
  })

  await step('the side chat closes again, leaving the lesson where it was', async () => {
    const close = document.querySelector('.sidechat-close')
    assert(close, 'no close button on the panel')
    close.click()
    await sleep(300)
    assert(!document.querySelector('.sidechat'), 'the panel is still open')
    assert(document.querySelector('.lesson-head h1'), 'the lesson went away with the panel')
    return 'closed'
  })

  await step('re-opening carries on with the last chat instead of starting another', async () => {
    // Opening the panel used to create a chat every time, which left a trail of
    // empty ones in the history for anyone who opened it and changed their mind.
    const before = (await window.fixtureAPI.listChats('python-asyncio')).length
    const prose = await waitFor('.content-inner .prose p')
    const range = document.createRange()
    range.selectNodeContents(prose)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    ;(await waitFor('.ask-about')).click()
    await waitFor('.sidechat-tab')
    await sleep(500)
    const after = (await window.fixtureAPI.listChats('python-asyncio')).length
    assert(after === before, 're-opening created a chat: ' + before + ' -> ' + after)
    document.querySelector('.sidechat-close').click()
    await sleep(300)
    return before + ' chats before and after'
  })

  // --- one Mac, several people -----------------------------------------
  // --- the coach ---------------------------------------------------------
  // The other half of the app. It ships nothing either, so like the library it
  // has to be brought into existence before it can be checked.

  await step('the titlebar switch reaches the coaches list, and says which half you are in', async () => {
    const coach = await waitFor('.titlebar [data-section="coach"]')
    const courses = document.querySelector('.titlebar [data-section="courses"]')
    assert(courses, 'the switch offers no courses half')
    // The old control was one button labelled with the *destination*, so it
    // read "Coach" while you were in courses. Both halves are labelled now and
    // exactly one of them is checked - that is the thing worth asserting.
    assert(courses.getAttribute('aria-checked') === 'true', 'courses is not marked while in a lesson')
    assert(coach.getAttribute('aria-checked') === 'false', 'coach is marked while in a lesson')
    coach.click()
    const head = await waitFor('.coach h1')
    assert(
      document.querySelector('.titlebar [data-section="coach"]').getAttribute('aria-checked') === 'true',
      'the switch did not follow the move into coach'
    )
    return head.textContent
  })

  await step('an empty coach list explains itself instead of showing nothing', async () => {
    const empty = await waitFor('.coach .empty-library h3')
    assert(/no coaches yet/i.test(empty.textContent), 'it said ' + empty.textContent)
    return empty.textContent
  })

  await step('creating a coach opens it, with a brief that sets up its memory', async () => {
    const button = [...document.querySelectorAll('.coach .actions button')]
      .find((b) => /New coach/i.test(b.textContent))
    assert(button, 'no New coach button')
    button.click()

    const input = await waitFor('.coach-card.new input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'French vocabulary')
    input.dispatchEvent(new Event('input', { bubbles: true }))

    const create = [...document.querySelectorAll('.coach-card.new button')]
      .find((b) => b.textContent.trim() === 'Create')
    assert(create && !create.disabled, 'no enabled Create button')
    create.click()

    await waitFor('.coach-project')
    // The brief folds away by default: the workspace is what you came to see.
    const fold = await waitFor('.coach-brief')
    assert(!fold.open, 'the brief is open by default')
    fold.open = true
    // Assert the brief actually rendered its text, not that the box exists.
    const brief = await waitFor('.coach-brief-text')
    assert(/coach/i.test(brief.textContent), 'the brief never mentions coaching')
    assert(/context\.md/.test(brief.textContent), 'the brief does not set up the memory files')
    assert(/review\.md/.test(brief.textContent), 'the brief does not set up a review list')

    const projects = await window.fixtureAPI.listCoachProjects()
    assert(projects.length === 1, 'expected one project, found ' + projects.length)
    window.__OPENCOURSE_SMOKE_PROJECT = projects[0].id
    return projects[0].name + ' / ' + projects[0].model
  })

  await step('the brief can be rewritten and the change survives a reload of the screen', async () => {
    document.querySelector('.coach-brief').open = true
    const edit = [...document.querySelectorAll('.coach-brief button')].find((b) => b.textContent.trim() === 'Edit')
    assert(edit, 'no Edit button on the brief')
    edit.click()

    const box = await waitFor('.coach-brief textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, 'You are a French vocabulary coach. Drill me on irregular verbs.')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    ;[...document.querySelectorAll('.coach-brief button')].find((b) => b.textContent.trim() === 'Save').click()

    await waitFor('.coach-brief-text')
    const stored = await window.fixtureAPI.getCoachProject(window.__OPENCOURSE_SMOKE_PROJECT)
    assert(/irregular verbs/.test(stored.instructions), 'the brief did not persist: ' + stored.instructions)
    return stored.instructions.slice(0, 40) + '…'
  })

  await step('the coach exposes no way to write a workspace file from the renderer', async () => {
    // Read-only in the app is structural: there is no channel that writes one.
    // This pins the exact set, so adding a writer has to be a deliberate edit
    // here rather than something that slips in.
    const fileMethods = Object.keys(window.opencourse).filter((k) => /CoachFile|CoachFolder/.test(k)).sort()
    assert(
      fileMethods.join(',') ===
        'createCoachFolder,listCoachFiles,moveCoachFile,onCoachFilesChanged,purgeCoachFile,readCoachFile,trashCoachFile',
      'the workspace surface changed: ' + fileMethods.join(', ')
    )
    // The one writer that does exist is for transcripts, and it needs a live
    // session id - it cannot name a file at all.
    assert(typeof window.fixtureAPI.writeCoachFile === 'undefined', 'a workspace writer appeared')
    return fileMethods.length + ' workspace methods, none of them writers'
  })

  await step('a second user gets their own, empty library', async () => {
    const other = await window.fixtureAPI.createUser('Second')
    const courses = await window.fixtureAPI.listCourses()
    assert(courses.length === 0, 'the second user could see ' + courses.length + ' course(s)')
    return other.name + ' sees nothing'
  })

  await step('switching back restores the first library and its progress', async () => {
    await window.fixtureAPI.switchUser(firstUserId)
    const courses = await window.fixtureAPI.listCourses()
    assert(courses.length === 1, 'expected one course back, got ' + courses.length)
    const progress = await window.fixtureAPI.getProgress('python-asyncio')
    assert(progress.completedLessons.length > 0, 'the lesson completed earlier did not survive')
    return courses[0].slug + ' at ' + courses[0].progressPercent + '%'
  })

  await step('the picker is reachable from a lesson, and its avatars are round', async () => {
    const chip = document.querySelector('.titlebar .user-chip')
    assert(chip, 'no user chip in the titlebar to get back from')
    assert(chip.getAttribute('aria-expanded') === 'false', 'the menu claims to be open before it is')
    chip.click()
    // The chip opens a menu now instead of jumping straight to the picker -
    // switching user is one of the two things your own name is good for.
    const panel = await waitFor('.menu-panel')
    assert(chip.getAttribute('aria-expanded') === 'true', 'the chip did not report the menu open')
    const items = [...panel.querySelectorAll('.menu-item')].map((b) => b.textContent.trim())
    assert(items.join(' | ') === 'Settings… | Logs | Switch user', 'the menu offers ' + items.join(' | '))
    ;[...panel.querySelectorAll('.menu-item')].find((b) => /Switch user/.test(b.textContent)).click()
    await waitFor('.user-card.add')
    // A shared class name once gave the New user avatar 96px of padding, so
    // measure the circle rather than trusting border-radius to look round.
    const avatars = [...document.querySelectorAll('.avatar')]
    assert(avatars.length > 0, 'no avatars on the picker')
    for (const el of avatars) {
      const r = el.getBoundingClientRect()
      assert(Math.abs(r.width - r.height) <= 1, 'avatar is ' + r.width + 'x' + r.height + ', not round')
    }
    // Walk back in the way a person would, so the checks that run after this
    // still have a lesson on screen.
    const mine = [...document.querySelectorAll('.user-pick')]
      .find((b) => /Smoke/.test(b.textContent))
    assert(mine, 'the first user is not in the picker any more')
    mine.click()
    await waitFor('.course-card')
    document.querySelector('.course-card').click()
    await waitFor('.lesson-row')
    document.querySelector('.lesson-row').click()
    await waitFor('.sidebar a')
    // The iframe is loading="lazy", so bring it into view or the protocol
    // checks that follow find no opencourse:// frame to inspect.
    const viz = await waitFor('.viz-frame')
    viz.scrollIntoView({ block: 'center' })
    await sleep(1200)
    return avatars.length + ' round, and back in the course'
  })

  await step('the user bridge is exactly what it means to expose', async () => {
    const methods = Object.keys(window.opencourse).filter((k) => /User/.test(k)).sort()
    // renameUser takes a name and no id: main resolves who it applies to from
    // the session, because it rewrites a path main builds. This pins that.
    assert(
      methods.join(',') === 'createUser,deleteUser,listUsers,renameUser,switchUser',
      'the bridge offers ' + methods.join(',')
    )
    return methods.join(', ')
  })

  await step('settings opens over a lesson and gives it back, scroll and chat intact', async () => {
    const before = document.querySelector('.lesson-head h1').textContent
    document.querySelector('.titlebar .chat-chip').click()
    await waitFor('.sidechat')
    const scroller = document.querySelector('.content.scroll')
    scroller.scrollTop = 220
    await sleep(150)
    assert(scroller.scrollTop > 100, 'the lesson would not scroll: ' + scroller.scrollTop + ' of ' + scroller.scrollHeight)

    document.querySelector('.titlebar .user-chip').click()
    const panel = await waitFor('.menu-panel')
    ;[...panel.querySelectorAll('.menu-item')].find((b) => /Settings/.test(b.textContent)).click()
    await waitFor('.settings')
    // The switch borrows the half it was opened from, so the titlebar does not
    // lurch sideways on the way into settings.
    assert(
      document.querySelector('.titlebar [data-section="courses"]').getAttribute('aria-checked') === 'true',
      'settings lost the half it was opened from'
    )

    document.querySelector('.titlebar .crumbs a').click()
    const head = await waitFor('.lesson-head h1')
    assert(head.textContent === before, 'came back to ' + head.textContent + ', not ' + before)
    // Both of these are the reason settings remembers where it came from: a
    // modal kept them for free and a route has to be made to.
    assert(document.querySelector('.sidechat'), 'the side chat did not survive the trip')
    const after = document.querySelector('.content.scroll').scrollTop
    assert(after > 100, 'the lesson was scrolled back to ' + after)
    document.querySelector('.sidechat-close').click()
    await sleep(200)
    return 'back at "' + before + '", scrolled ' + Math.round(after) + 'px'
  })

  // --- the log -------------------------------------------------------------
  // Read-only from the renderer: two methods, neither of which takes a user.
  await step('the log bridge is exactly what it means to expose', async () => {
    // "Log" followed by anything but a lowercase letter: cancelSubscriptionLogin is not the log.
    const methods = Object.keys(window.opencourse).filter((k) => /Log(?![a-z])|Logs/.test(k)).sort()
    assert(methods.join(',') === 'listLogScopes,listLogs', 'the log bridge offers ' + methods.join(','))
    return methods.join(', ')
  })

  await step('logs open over a lesson, newest first, and sort, filter and page', async () => {
    const before = document.querySelector('.lesson-head h1').textContent
    // Thirty renderer warnings: proof that the renderer's console reaches the
    // log in every build, and enough lines for a second page at 25.
    for (let i = 0; i < 30; i++) console.warn('smoke log line ' + i)
    await sleep(300)

    document.querySelector('.titlebar .user-chip').click()
    const panel = await waitFor('.menu-panel')
    ;[...panel.querySelectorAll('.menu-item')].find((b) => /^Logs$/.test(b.textContent.trim())).click()
    await waitFor('.logs-row')
    assert(
      document.querySelector('.titlebar [data-section="courses"]').getAttribute('aria-checked') === 'true',
      'logs lost the half it was opened from'
    )
    const rows = () => [...document.querySelectorAll('.logs-row')]
    const count = () => document.querySelector('.logs-count').textContent
    const settle = async () => { await sleep(350); await until(() => document.querySelector('.logs-table').getAttribute('aria-busy') === 'false', 'the log to load') }

    // Rendered, not merely fetched: a row with text in its cells.
    const first = rows()[0]
    assert(first.querySelector('.logs-col-message').textContent.trim().length > 0, 'the first row has no message')
    assert(first.getBoundingClientRect().height > 10, 'the first row has no height')
    const ats = rows().map((r) => Number(r.dataset.at))
    assert(ats.every((at, i) => i === 0 || ats[i - 1] >= at), 'not newest first: ' + ats.slice(0, 5).join(', '))
    const time = document.querySelector('th.logs-col-time')
    assert(time.getAttribute('aria-sort') === 'descending', 'time is not marked as the sort: ' + time.getAttribute('aria-sort'))
    assert(rows().every((r) => /^(You|General)$/.test(r.querySelector('.logs-col-user').textContent)), 'a row belongs to someone else')
    const total = Number(count().split(' of ')[1].replace(/,/g, ''))
    assert(total >= 30, 'only ' + total + ' lines; the renderer warnings did not arrive')

    // A row opens to its details, and closes again.
    first.click()
    const detail = await waitFor('.logs-detail pre')
    assert(detail.textContent.includes(first.querySelector('.logs-col-message').textContent), 'the details do not show the message')
    first.click()
    await until(() => !document.querySelector('.logs-detail'), 'the details to close')

    // Search narrows, and is debounced into one request.
    const search = document.querySelector('.logs-search')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(search, 'smoke log line 7')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    assert(rows().length === 1 && /smoke log line 7$/.test(rows()[0].querySelector('.logs-col-message').textContent), 'search found ' + rows().length + ' rows')
    assert(rows()[0].dataset.level === 'warn' && rows()[0].querySelector('.logs-col-scope').textContent === 'renderer', 'the renderer line is not a renderer warning')
    setter.call(search, '')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    // A level alone: only that level comes back.
    document.querySelector('.logs-level-toggle[data-level="warn"]').click()
    await settle()
    assert(rows().length > 0 && rows().every((r) => r.dataset.level === 'warn'), 'the warn filter let through ' + rows().map((r) => r.dataset.level).join(','))
    document.querySelector('.logs-level-toggle[data-level="warn"]').click()
    await settle()

    // A header sorts, and says so.
    document.querySelector('.logs-sort[data-column="level"]').click()
    await settle()
    assert(document.querySelector('th.logs-col-level').getAttribute('aria-sort') === 'descending', 'level did not become the sort')
    assert(time.getAttribute('aria-sort') === 'none', 'time still claims to be the sort')
    const ranks = { debug: 0, info: 1, warn: 2, error: 3 }
    const levels = rows().map((r) => ranks[r.dataset.level])
    assert(levels.every((l, i) => i === 0 || levels[i - 1] >= l), 'not worst first: ' + levels.join(','))
    document.querySelector('.logs-sort[data-column="at"]').click()
    await settle()

    // Pages of 25: the second one starts at 26, and Previous comes back.
    const size = document.querySelector('.logs-page-size select')
    size.value = '25'
    size.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    assert(rows().length === 25 && /^1–25 of/.test(count()), 'page one is ' + rows().length + ' rows, "' + count() + '"')
    const top = rows()[0].dataset.at
    document.querySelector('.logs-next').click()
    await settle()
    assert(/^26–/.test(count()) && Number(rows()[0].dataset.at) <= Number(top), 'page two reads "' + count() + '"')
    document.querySelector('.logs-prev').click()
    await settle()
    assert(/^1–25 of/.test(count()), 'Previous went to "' + count() + '"')

    document.querySelector('.titlebar .crumbs a').click()
    const head = await waitFor('.lesson-head h1')
    assert(head.textContent === before, 'came back to ' + head.textContent + ', not ' + before)
    return total + ' lines, back at "' + before + '"'
  })

  // --- which models the side chat offers ----------------------------------
  // A smoke run has no key, so main hands these runs a fixed list in the API's
  // shape (chat.ts, reachableModels) - otherwise this section only ever shows
  // its no-key note.
  const openSettings = async () => {
    document.querySelector('.titlebar .user-chip').click()
    const menu = await waitFor('.menu-panel')
    ;[...menu.querySelectorAll('.menu-item')].find((b) => /Settings/.test(b.textContent)).click()
    await waitFor('.settings-ai-chat .settings-model')
  }
  const modelRows = () => [...document.querySelectorAll('.settings-ai-chat .settings-model')]
  const modelId = (row) => row.querySelector('.settings-model-id').textContent
  const modelBox = (id) => modelRows().find((row) => modelId(row) === id).querySelector('input')
  let keptModel = ''

  await step('settings clears all models and can enable a new default', async () => {
    await openSettings()
    assert(modelRows().length >= 3, modelRows().length + ' models listed')
    assert(modelRows().every((row) => row.querySelector('input').checked), 'a new user starts with models off')
    const first = modelRows().find((row) => row.querySelector('.settings-model-note'))
    assert(first, 'no model says new chats start on it')
    keptModel = modelId(modelRows().find((row) => row !== first))
    document.querySelector('.settings-ai-chat .settings-models-unselect-all').click()
    await until(() => modelRows().every((row) => !row.querySelector('input').checked), 'every model to be off')
    const cleared = await window.fixtureAPI.getAIModelSettings('chat', 'apiKey')
    assert(cleared.profile.enabledModels.length === 0 && cleared.profile.defaultModel === null && cleared.profile.defaultReasoning === null, 'cleared profile was not saved')
    await until(() => !modelBox(keptModel).disabled, 'model selection to be ready')
    modelBox(keptModel).click()
    await until(() => modelBox(keptModel).checked, keptModel + ' to go on')
    const left = modelRows().find((row) => modelId(row) === keptModel)
    assert(left.querySelector('.settings-model-note'), 'new chats do not start on the one model left on')
    await until(() => !modelBox(keptModel).disabled, 'model selection to be ready')
    const saved = (await window.fixtureAPI.getChatModelSettings()).enabled
    assert(JSON.stringify(saved) === JSON.stringify([keptModel]), 'saved ' + JSON.stringify(saved))
    document.querySelector('.titlebar .crumbs a').click()
    await waitFor('.lesson-head h1')
    return 'only ' + keptModel + ' left on, and it is what new chats start on'
  })

  await step('the picker enforces the allowlist and resets a disallowed conversation model', async () => {
    document.querySelector('.titlebar .chat-chip').click()
    const trigger = await waitFor('.sidechat-model')
    const own = trigger.textContent.trim()
    trigger.click()
    const offered = [...(await waitFor('.menu-panel')).querySelectorAll('.menu-item-label')].map((l) => l.textContent.trim())
    trigger.click()
    const expected = own === keptModel ? [keptModel] : [own, keptModel]
    assert(offered.join(',') === expected.join(','), 'the picker offers ' + offered.join(', '))
    document.querySelector('.sidechat-close').click()
    await sleep(200)
    return offered.join(', ')
  })

  await step('"Select all" puts every model back and allows future models', async () => {
    await openSettings()
    const button = () => document.querySelector('.settings-ai-chat .settings-models-select-all')
    assert(button(), 'no way back to every model')
    button().click()
    await until(() => modelRows().every((row) => row.querySelector('input').checked), 'every model to be on')
    await until(() => button().disabled, 'select all to be disabled after use')
    assert((await window.fixtureAPI.getChatModelSettings()).enabled === null, 'a list is still stored')
    const on = modelRows().length
    document.querySelector('.titlebar .crumbs a').click()
    await waitFor('.lesson-head h1')
    return on + ' on'
  })

  await step('settings saves chat and coach defaults and applies them only to new conversations', async () => {
    await openSettings()
    const before = (await window.fixtureAPI.getChatModelSettings()).defaults
    const coachBefore = await window.fixtureAPI.getDefaultCoachModel()
    const select = async (selector, value) => {
      const field = await waitFor(selector)
      await until(() => !field.disabled, selector + ' to be ready')
      field.value = value
      field.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(100)
      await until(() => document.querySelector(selector)?.value === value && !document.querySelector(selector).disabled, selector + ' to save')
    }
    await select('.settings-default-chat-model', 'gpt-5.1')
    await select('.settings-default-chat-reasoning', 'high')
    const defaults = (await window.fixtureAPI.getChatModelSettings()).defaults
    assert(defaults.model === 'gpt-5.1' && defaults.reasoning === 'high', 'chat defaults were not stored')
    const chat = await window.fixtureAPI.createChat('python-asyncio', { moduleId: 'coroutines-and-tasks', lessonId: 'await-and-tasks' })
    assert(chat.model === 'gpt-5.1' && chat.reasoning === 'high', 'new chat ignored the defaults')
    await window.fixtureAPI.deleteChat(chat.id)
    await select('.settings-default-chat-model', 'gpt-4.1')
    const reasoning = document.querySelector('.settings-default-chat-reasoning')
    assert(reasoning.disabled && reasoning.value === '', 'unsupported reasoning was retained')
    await select('.settings-default-coach-model', 'gpt-realtime')
    assert(await window.fixtureAPI.getDefaultCoachModel() === 'gpt-realtime', 'coach default was not stored')
    const coach = await window.fixtureAPI.createCoachProject({ name: 'Defaults check' })
    assert(coach.model === 'gpt-realtime', 'new coach ignored the default')
    await window.fixtureAPI.deleteCoachProject(coach.id)
    await window.fixtureAPI.setChatDefaults(before)
    await window.fixtureAPI.setDefaultCoachModel(coachBefore)
    document.querySelector('.titlebar .crumbs a').click()
    await waitFor('.lesson-head h1')
    return 'model, supported reasoning and speech model saved and applied'
  })

  await step('web search is off until Settings turns it on, and then the composer says so', async () => {
    document.querySelector('.titlebar .chat-chip').click()
    await waitFor('.sidechat-model')
    assert(!document.querySelector('.sidechat-web'), 'the composer offers the web before anyone turned it on')
    document.querySelector('.sidechat-close').click()
    await sleep(200)

    await openSettings()
    const box = await waitFor('.settings-web-search')
    await until(() => !box.disabled, 'the switch to load')
    assert(!box.checked, 'a new user starts with web search on')
    assert((await window.fixtureAPI.getChatWebSearch()) === false, 'stored as on before anyone chose')
    box.click()
    await until(() => box.checked, 'the switch to turn on')
    await sleep(100)
    assert((await window.fixtureAPI.getChatWebSearch()) === true, 'turning it on was not stored')
    assert((await window.fixtureAPI.listChatModels()).webSearch === true, 'the picker was not told')

    document.querySelector('.titlebar .crumbs a').click()
    await waitFor('.lesson-head h1')
    document.querySelector('.titlebar .chat-chip').click()
    const web = await waitFor('.sidechat-web')
    const box2 = web.getBoundingClientRect()
    assert(box2.width > 0 && box2.height > 0, 'the web sign rendered with no size')
    assert(web.closest('.sidechat-actions'), 'the web sign is not with the pickers')
    const verdict = web.classList.contains('off') ? 'dimmed: ' + web.title : web.title
    document.querySelector('.sidechat-close').click()
    await sleep(200)

    assert((await window.fixtureAPI.setChatWebSearch(false)) === false, 'it would not switch off again')
    return verdict
  })

  await step('a rename reaches the titlebar without moving you', async () => {
    document.querySelector('.titlebar .user-chip').click()
    const menu = await waitFor('.menu-panel')
    ;[...menu.querySelectorAll('.menu-item')].find((b) => /Settings/.test(b.textContent)).click()
    await waitFor('.settings')

    const field = document.querySelector('.settings-name')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(field, 'Smoke Renamed')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(100)
    ;[...document.querySelectorAll('.settings-section button')].find((b) => /Save/.test(b.textContent)).click()
    await sleep(400)

    // Still on settings: you asked to be called something else, not to be taken
    // somewhere else. This is what catches a session update folded into the
    // navigating callback.
    assert(document.querySelector('.settings'), 'saving a name navigated away')
    const chip = document.querySelector('.titlebar .user-chip')
    assert(/Smoke Renamed/.test(chip.textContent), 'the chip still reads ' + chip.textContent.trim())
    const session = await window.fixtureAPI.getSession()
    assert(session.user.name === 'Smoke Renamed', 'the session says ' + session.user.name)

    setter.call(field, 'Smoke')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(100)
    ;[...document.querySelectorAll('.settings-section button')].find((b) => /Save/.test(b.textContent)).click()
    await sleep(400)
    document.querySelector('.titlebar .crumbs a').click()
    await waitFor('.lesson-head h1')
    return 'renamed and put back'
  })

  await step('the menu closes on Escape and says so', async () => {
    const chip = document.querySelector('.titlebar .user-chip')
    chip.click()
    const panel = await waitFor('.menu-panel')
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(150)
    assert(!document.querySelector('.menu-panel'), 'the menu is still open')
    assert(chip.getAttribute('aria-expanded') === 'false', 'the chip still claims it is open')
    return 'closed'
  })

  // --- the security substrate -------------------------------------------
  // CSP and the permission handlers used to be untested: CSP was applied only
  // when packaged, and there were no permission handlers at all. Both are now
  // exercised here, and all three of these checks assert the thing that bites
  // rather than the thing that is configured.

  await step('the renderer CSP is applied and blocks the open internet', async () => {
    const violation = new Promise((resolve) => {
      document.addEventListener('securitypolicyviolation', resolve, { once: true })
    })
    let fetched = false
    try {
      await fetch('https://example.com/')
      fetched = true
    } catch (err) {
      /* expected: refused by connect-src */
    }
    assert(!fetched, 'the renderer reached example.com')
    // Without this the check would pass on a machine that is merely offline.
    const e = await Promise.race([violation, sleep(3000)])
    assert(e && e.violatedDirective, 'no securitypolicyviolation fired - is the header applied at all?')
    assert(e.violatedDirective.split(' ')[0] === 'connect-src', 'violated ' + e.violatedDirective)
    const policy = e.originalPolicy || ''
    for (const clause of window.__OPENCOURSE_SMOKE_CSP.split('; ')) {
      assert(policy.indexOf(clause) !== -1, 'the policy is missing: ' + clause)
    }
    return e.violatedDirective + ', all ' + window.__OPENCOURSE_SMOKE_CSP.split('; ').length + ' clauses present'
  })

  await step('geolocation is denied', async () => {
    const verdict = await new Promise((resolve) => {
      setTimeout(() => resolve('timed out'), 4000)
      navigator.geolocation.getCurrentPosition(
        () => resolve('granted'),
        (err) => resolve('denied, code ' + err.code)
      )
    })
    assert(verdict.indexOf('denied') === 0, 'geolocation said: ' + verdict)
    return verdict
  })

  await step('the microphone is refused outside a coaching session', async () => {
    let opened = false
    let detail = ''
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      opened = true
      stream.getTracks().forEach((t) => t.stop())
    } catch (err) {
      detail = String(err && err.name ? err.name : err)
    }
    assert(!opened, 'getUserMedia opened the microphone with no session running')
    return detail
  })

  return results
})()`

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The frame the lesson's visualization actually navigated to. */
function vizFrame(win: BrowserWindow): WebFrameMain | undefined {
  return win.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith('opencourse://'))
}

/**
 * A click at a point in the window, routed by the browser the way a mouse's is:
 * hit-tested across every frame, including out-of-process ones.
 */
async function routedClick(win: BrowserWindow, atX: number, atY: number): Promise<void> {
  const x = Math.round(atX)
  const y = Math.round(atY)
  const cdp = win.webContents.debugger
  const attached = cdp.isAttached()
  if (!attached) cdp.attach('1.3')
  try {
    const press = { x, y, button: 'left', clickCount: 1 }
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...press })
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press })
  } finally {
    if (!attached) cdp.detach()
  }
}

/**
 * Press the visualization's own Step button the way a mouse would reach it.
 *
 * Not webContents.sendInputEvent: that forwards to the main frame's widget,
 * and the visualization is an out-of-process frame, so the press never arrives
 * - it failed inline, where a real mouse works. CDP's Input domain goes
 * through the browser's input router, which hit-tests and routes into the
 * frame the way a real click does. What neither can reproduce is macOS handing
 * the press to a window drag region before Chromium sees it; fullscreenChecks
 * asserts there is no drag region to hand it to.
 */
async function pressVizStep(win: BrowserWindow): Promise<{ before: string; after: string }> {
  const frame = vizFrame(win)
  if (!frame) throw new Error('no opencourse:// frame to press into')
  const inner = (await frame.executeJavaScript(`(() => {
    const b = document.querySelector('#step').getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, label: document.querySelector('#step-label').textContent }
  })()`)) as { x: number; y: number; label: string }
  // The frame's own origin is inside its border.
  const outer = (await win.webContents.executeJavaScript(`(() => {
    const iframe = document.querySelector('.viz-frame iframe')
    const r = iframe.getBoundingClientRect()
    return { x: r.left + iframe.clientLeft, y: r.top + iframe.clientTop }
  })()`)) as { x: number; y: number }
  await routedClick(win, outer.x + inner.x, outer.y + inner.y)
  await pause(350)
  const after = (await frame.executeJavaScript(`document.querySelector('#step-label').textContent`)) as string
  return { before: inner.label, after }
}

/**
 * Fullscreen belongs in main too: requestFullscreen needs a real user gesture,
 * and executeJavaScript's userGesture flag is the only way to fake one. The
 * renderer's own el.click() is not trusted, so this cannot live in SCRIPT.
 *
 * The bug this guards: in fullscreen the visualization's own buttons did
 * nothing for a real mouse while working inline. A press routed through the
 * browser (pressVizStep) reached them in both modes even then - the frame was
 * never the problem. It sat at y=0, under the titlebar's drag region, and macOS
 * gives a press in a drag region to the window before Chromium sees it. No
 * injected event reproduces that, so the drag region itself is what is checked.
 */
async function fullscreenChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const run = async (code: string): Promise<unknown> => win.webContents.executeJavaScript(code, true)
  const clickButton = `(() => {
    const btn = document.querySelector('.viz-frame .viz-fullscreen')
    if (!btn) throw new Error('no fullscreen button on this lesson')
    const r = btn.getBoundingClientRect()
    // What would actually receive a click at the button's own centre?
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    btn.click()
    return (hit && (hit.className || hit.tagName)) + ''
  })()`
  const state = `new Promise((r) => setTimeout(() => r(document.fullscreenElement ? document.fullscreenElement.className : null), 400))`
  // Where the way out is, relative to the screen and to the frame below it.
  const placement = `(() => {
    const btn = document.querySelector('.viz-frame .viz-fullscreen').getBoundingClientRect()
    const frame = document.querySelector('.viz-frame iframe').getBoundingClientRect()
    return { top: btn.top, right: btn.right, bottom: btn.bottom, width: window.innerWidth, frameTop: frame.top }
  })()`
  // Every element macOS would treat as a handle to drag the window by.
  const dragRegions = `(() => [...document.querySelectorAll('*')]
    .filter((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'drag')
    .map((el) => el.className || el.tagName))()`
  const titlebarRegion = `getComputedStyle(document.querySelector('.titlebar')).getPropertyValue('-webkit-app-region')`

  try {
    // Land on a lesson that has a visualization.
    await run(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const link = [...document.querySelectorAll('.sidebar a')].find((a) => /event loop/i.test(a.textContent))
      if (link) link.click()
      for (let i = 0; i < 60; i += 1) {
        if (document.querySelector('.viz-frame .viz-fullscreen')) return 'ready'
        await sleep(100)
      }
      throw new Error('no visualization on screen')
    })()`)

    // Focusing scrolls whatever last had focus back into view, so it goes
    // before the scroll that brings the frame on screen.
    win.focus()
    win.webContents.focus()
    await pause(150)
    await run(`(() => {
      const column = document.querySelector('.content')
      column.scrollTop += document.querySelector('.viz-frame').getBoundingClientRect().top - 120
    })()`)
    await pause(400)

    // The control: a routed press that missed inline would mean the check is
    // broken, not fullscreen.
    const inline = await pressVizStep(win)
    results.push({
      name: 'a routed click reaches the visualization inline',
      ok: inline.after !== inline.before,
      detail: `${inline.before} -> ${inline.after}`
    })
    // And the drag-region check below is not vacuous: the titlebar is one.
    const before = await run(titlebarRegion)

    const enterHit = await run(clickButton)
    const entered = await run(state)
    results.push({
      name: 'the fullscreen button enters fullscreen',
      ok: entered !== null,
      detail: `hit ${String(enterHit)}, fullscreenElement ${String(entered)}`
    })
    await pause(600)

    const where = (await run(placement)) as { top: number; right: number; bottom: number; width: number; frameTop: number }
    results.push({
      name: 'the way out of fullscreen is at the top right, above the frame',
      ok: where.top < 60 && where.right > where.width - 60 && where.bottom <= where.frameTop,
      detail: `button ${Math.round(where.top)}-${Math.round(where.bottom)}px down, ` +
        `${Math.round(where.width - where.right)}px from the right, frame from ${Math.round(where.frameTop)}px`
    })

    const live = (await run(dragRegions)) as string[]
    results.push({
      name: 'no window drag region is live under a fullscreen visualization',
      ok: before === 'drag' && live.length === 0,
      detail: `titlebar was ${String(before)}; live in fullscreen: ${live.join(', ') || 'none'}`
    })

    const full = await pressVizStep(win)
    results.push({
      name: 'a routed click reaches the visualization in fullscreen',
      ok: full.after !== full.before,
      detail: `${full.before} -> ${full.after}`
    })

    const exitHit = await run(clickButton)
    const exited = await run(state)
    results.push({
      name: 'the same button leaves fullscreen again',
      ok: exited === null,
      detail: `hit ${String(exitHit)}, fullscreenElement ${String(exited)}`
    })

    if (exited !== null) await run('document.exitFullscreen()')
    await pause(200)
    // Without this the window can no longer be moved by its titlebar.
    const after = await run(titlebarRegion)
    results.push({
      name: 'the titlebar drags the window again after fullscreen',
      ok: after === 'drag',
      detail: String(after)
    })
  } catch (err) {
    results.push({ name: 'the fullscreen button toggles', ok: false, detail: String(err) })
  }
  return results
}

/**
 * "Ask about this" on text inside a visualization, in a pass of its own.
 *
 * The lesson cannot see a frame's selection; the bridge the opencourse:// handler
 * appends to the page reports it (core/vizbridge.ts). So the selection is made
 * inside the frame, through the frame's own document, and everything after
 * that is observed from the lesson - the offer, a routed press on it, the
 * quote - and from the frame again for the mark it is asked to keep.
 */
async function vizSelectionChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const run = async (code: string): Promise<unknown> => win.webContents.executeJavaScript(code, true)
  const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      results.push({ name, ok: true, detail: await fn() })
    } catch (err) {
      results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }
  const waitFor = async (code: string, what: string, timeout = 4000): Promise<unknown> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const value = await run(code)
      if (value) return value
      await pause(50)
    }
    throw new Error('timed out waiting for ' + what)
  }
  // Selects one panel title inside the frame and finishes it the way a drag
  // does: with a mouseup on the frame's document.
  const selectInFrame = async (index: number): Promise<string> => {
    const frame = vizFrame(win)
    if (!frame) throw new Error('no opencourse:// frame')
    return (await frame.executeJavaScript(`(() => {
      const el = document.querySelectorAll('.panel-title')[${index}]
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return sel.toString().trim()
    })()`)) as string
  }
  const frameMarked = async (): Promise<boolean> =>
    (await vizFrame(win)?.executeJavaScript(`CSS.highlights.has('ask-quote')`)) as boolean
  const closeChat = `(() => { const b = document.querySelector('.sidechat-close'); if (b) b.click(); return true })()`

  await run(closeChat)
  await pause(200)

  let selected = ''
  await check('selecting text in a visualization offers to ask about it, next to the text', async () => {
    selected = await selectInFrame(0)
    if (selected.length < 4) throw new Error('nothing was selected in the frame: "' + selected + '"')
    const where = (await waitFor(`(() => {
      const offer = document.querySelector('.ask-about')
      if (!offer) return null
      const frame = document.querySelector('.viz-frame iframe').getBoundingClientRect()
      return { x: parseFloat(offer.style.left), y: parseFloat(offer.style.top), frame: [frame.left, frame.top, frame.right, frame.bottom] }
    })()`, '.ask-about')) as { x: number; y: number; frame: number[] }
    const [left, top, right, bottom] = where.frame as [number, number, number, number]
    if (!(where.x > left && where.x < right && where.y >= top && where.y < bottom)) {
      throw new Error(`the offer is anchored at ${where.x},${where.y}, outside the frame ${where.frame.join(',')}`)
    }
    return `"${selected}" offered at ${Math.round(where.x)},${Math.round(where.y)}`
  })

  await check('pressing it attaches the passage and keeps it marked inside the frame', async () => {
    const box = (await run(`(() => {
      const r = document.querySelector('.ask-about').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)) as { x: number; y: number }
    // Routed, because it floats over an out-of-process frame: what has to
    // receive the press is the button, not the frame under it.
    await routedClick(win, box.x, box.y)
    const quoted = (await waitFor(
      `document.querySelector('.sidechat-quote blockquote')?.textContent.trim()`,
      'the quote in the side chat'
    )) as string
    if (quoted !== selected) throw new Error(`the chat quoted "${quoted}", not "${selected}"`)
    if (!(await frameMarked())) throw new Error('the passage is not marked inside the frame')
    return `quoted "${quoted}", marked in the frame`
  })

  await check('dismissing the quote clears the mark inside the frame', async () => {
    await run(`document.querySelector('.sidechat-quote-head button').click()`)
    await waitFor(`!document.querySelector('.sidechat-quote')`, 'the quote to go')
    await pause(150)
    if (await frameMarked()) throw new Error('the frame still marks a passage nobody is asking about')
    return 'unmarked'
  })

  await check('a look-alike message from outside the frame offers nothing', async () => {
    // The lesson's own window posting the bridge's exact shape: only the frame
    // a component owns may make offers in its name.
    await run(`(() => { getSelection().removeAllRanges(); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })()`)
    await pause(100)
    await run(`window.postMessage({ source: 'opencourse-viz', type: 'selection', text: 'forged', rect: { left: 10, top: 10, width: 50, height: 10 } }, '*')`)
    await pause(300)
    const offer = await run(`document.querySelector('.ask-about')?.textContent ?? null`)
    if (offer !== null) throw new Error('a forged message produced an offer')
    return 'ignored'
  })

  await check('in fullscreen the offer is in the bar, and asking leaves fullscreen for the chat', async () => {
    await run(`document.querySelector('.viz-frame .viz-fullscreen').click()`)
    await waitFor(`document.fullscreenElement !== null`, 'fullscreen')
    await pause(500)
    const picked = await selectInFrame(1)
    const bar = (await waitFor(`(() => {
      const ask = document.querySelector('.viz-bar .viz-ask')
      if (!ask) return null
      const r = ask.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`, 'the bar to offer it')) as { x: number; y: number }
    const floating = await run(`Boolean(document.querySelector('.ask-about'))`)
    if (floating) throw new Error('a floating offer was made behind the fullscreen element')
    await routedClick(win, bar.x, bar.y)
    await waitFor(`document.fullscreenElement === null`, 'fullscreen to end')
    const quoted = (await waitFor(
      `document.querySelector('.sidechat-quote blockquote')?.textContent.trim()`,
      'the quote in the side chat'
    )) as string
    if (quoted !== picked) throw new Error(`the chat quoted "${quoted}", not "${picked}"`)
    if (!(await frameMarked())) throw new Error('the passage is not marked inside the frame')
    await run(`document.querySelector('.sidechat-quote-head button').click()`)
    return `quoted "${quoted}" after leaving fullscreen`
  })

  await run(`document.fullscreenElement ? document.exitFullscreen() : null`)
  await run(closeChat)
  await pause(200)
  return results
}

/**
 * A chat with answers in it, for the pass that quotes one. A smoke run has no
 * key, so nothing could ever answer otherwise. Written through the rows chat.ts
 * writes, and newer than every chat the script started, so it is the one the
 * panel resumes when it opens.
 */
async function seedAnsweredChat(): Promise<void> {
  const { insertChat, appendMessage } = await import('./chatdb')
  const { newChatId } = await import('../core/sidechat/ids')
  const { DEFAULT_CHAT_MODEL } = await import('../core/sidechat/models')
  const course = fixtureCourse('python-asyncio')
  const module = course?.modules[0]
  const first = module?.lessons?.[0]
  if (!course || !module || !first) throw new Error('no lesson to seed a side chat in')
  const lesson = { moduleId: module.slug, lessonId: first.slug }
  const id = newChatId()
  const at = new Date().toISOString()
  insertChat({ id, courseId: course.courseId, model: DEFAULT_CHAT_MODEL, startedIn: lesson, at })
  // The first answer used the web: two pages, cited the way OpenAI cites -
  // an inline link per claim, and the span of each recorded against the text.
  const pages = [
    { url: 'https://docs.python.org/3/library/asyncio-eventloop.html?utm_source=openai', title: 'Event Loop — Python 3.13.1 documentation' },
    { url: 'https://peps.python.org/pep-3156/?utm_source=openai', title: 'PEP 3156 – Asynchronous IO Support Rebooted: the “asyncio” Module | peps.python.org' }
  ]
  const links = pages.map((page) => `([${new URL(page.url).hostname}](${page.url}))`)
  const webAnswer = `It decides which task runs next ${links[0]}, and runs it until that task waits ${links[1]}.`
  const citations = pages.map((page, i) => {
    const start = webAnswer.indexOf(links[i]!)
    return { ...page, start, end: start + links[i]!.length }
  })
  const said: ['context' | 'user' | 'assistant', string][] = [
    ['context', 'the lesson'],
    ['user', 'what is the event loop for?'],
    ['assistant', webAnswer],
    ['user', 'and while one of them waits?'],
    [
      'assistant',
      // Long enough to wrap several times in the narrowest panel, so some line
      // ends against its right edge - which is the offer the check is about.
      'Nothing of that task runs while it waits, so the loop takes the next ready task off its queue ' +
        'and runs that instead, and keeps doing so until something it was waiting on completes and the ' +
        'first task becomes ready to carry on from exactly where it stopped, with nothing lost between.'
    ]
  ]
  for (const [role, text] of said) {
    appendMessage(id, { role, text, ...(text === webAnswer ? { citations } : {}), lesson, at })
  }
}

/**
 * "Ask about this" on a passage of the side chat's own answer, in the lesson's
 * window. Runs after main has seeded answers, and before the coach pass,
 * because it leaves the lesson for the next one.
 */
const ANSWER_QUOTE_SCRIPT = `(async () => {
  const results = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (selector, timeout = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const el = document.querySelector(selector)
      if (el) return el
      await sleep(50)
    }
    throw new Error('timed out waiting for ' + selector)
  }
  const step = async (name, fn) => {
    try {
      const detail = await fn()
      results.push({ name, ok: true, detail: String(detail ?? '') })
    } catch (err) {
      results.push({ name, ok: false, detail: String(err && err.message ? err.message : err) })
    }
  }
  const assert = (cond, message) => {
    if (!cond) throw new Error(message)
  }
  // Ends a selection the way a drag does: with a mouseup on the document.
  const select = (range) => {
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }
  // A real press, not el.click() - see the lesson's own check for why.
  const press = async (el) => {
    const r = el.getBoundingClientRect()
    const at = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
    el.dispatchEvent(new MouseEvent('mousedown', at))
    el.dispatchEvent(new MouseEvent('mouseup', at))
    await sleep(50)
    el.dispatchEvent(new MouseEvent('click', at))
  }
  const answers = () => [...document.querySelectorAll('.chat-answer[data-ask="answer"]')]
  const marked = () => {
    const mark = CSS.highlights.get('ask-quote')
    return mark ? [...mark].map((r) => r.toString().trim()) : []
  }

  let word = ''
  await step('the end of a line in an answer offers to ask about it, on screen', async () => {
    document.querySelector('.chat-chip').click()
    await waitFor('.chat-answer[data-ask="answer"] .prose p')
    await sleep(300)
    // The end of the rightmost word in the answer. The panel is flush with the
    // window, so that is where an offer centred on its passage would hang off
    // the edge - and only the last letters of it, because a whole word's centre
    // can sit far enough in to pass without the clamp this is checking.
    const paragraph = answers().at(-1).querySelector('.prose p')
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let best = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const m of node.textContent.matchAll(/[A-Za-z]+/g)) {
        const range = document.createRange()
        range.setStart(node, m.index)
        range.setEnd(node, m.index + m[0].length)
        const right = range.getBoundingClientRect().right
        if (!best || right > best.right) best = { range, right, text: m[0] }
      }
    }
    assert(best && best.text.length > 2, 'the answer has no words in it')
    best.range.setStart(best.range.endContainer, best.range.endOffset - 2)
    word = best.range.toString()
    const passage = best.range.getBoundingClientRect()
    select(best.range)
    const offer = await waitFor('.ask-about')
    const box = offer.getBoundingClientRect()
    assert(box.width > 0, 'the offer rendered with no size')
    const centred = passage.left + passage.width / 2 + box.width / 2
    assert(centred > window.innerWidth,
      'centred on "' + word + '" the offer would end at ' + Math.round(centred) + ', on screen anyway - this checks nothing')
    assert(box.left >= 0 && box.right <= window.innerWidth,
      'the offer hangs off the window: ' + Math.round(box.left) + '..' + Math.round(box.right) + ' of ' + window.innerWidth)
    // A fixed box shrinks to the room it has, so on screen is not enough: it
    // fitted once by wrapping "Ask about this" onto three lines.
    const label = document.createRange()
    label.selectNodeContents(offer)
    assert(label.getClientRects().length === 1, 'the offer wrapped onto ' + label.getClientRects().length + ' lines')
    return '"' + word + '" would put it at ..' + Math.round(centred) + ', it is at ' +
      Math.round(box.left) + '..' + Math.round(box.right) + ' of ' + window.innerWidth
  })

  await step('pressing it attaches the passage as from an answer, marked where it was said', async () => {
    await press(document.querySelector('.ask-about'))
    const chip = await waitFor('.sidechat-quote blockquote')
    assert(chip.textContent.trim() === word, 'the chat quoted "' + chip.textContent.trim() + '", not "' + word + '"')
    const label = document.querySelector('.sidechat-quote-label').textContent
    assert(label === 'From an answer', 'an answer passage is labelled "' + label + '"')
    // The composer took focus, so the selection is gone; the mark is what is left.
    assert(document.activeElement === document.querySelector('.sidechat-input'), 'the composer did not take focus')
    assert(marked().length === 1 && marked()[0] === word, 'marked: ' + JSON.stringify(marked()))
    const range = [...CSS.highlights.get('ask-quote')][0]
    assert(answers().at(-1).contains(range.commonAncestorContainer), 'the mark is not in the answer')
    return 'quoted "' + word + '", marked in the answer'
  })

  await step('your own question, and a drag across turns, offer nothing', async () => {
    const asked = document.querySelector('.chat-turn.user .chat-body')
    const own = document.createRange()
    own.selectNodeContents(asked)
    select(own)
    await sleep(100)
    assert(!document.querySelector('.ask-about'), 'your own question was offered as a passage')
    const across = document.createRange()
    across.setStartBefore(answers()[0])
    across.setEndAfter(answers().at(-1))
    select(across)
    await sleep(100)
    assert(!document.querySelector('.ask-about'), 'a drag across both answers was offered as one passage')
    window.getSelection().removeAllRanges()
    return 'neither offered'
  })

  await step('an answer that used the web lists its pages, numbered to match its markers', async () => {
    const turn = [...document.querySelectorAll('.chat-turn.assistant')].find((t) => t.querySelector('.chat-sources'))
    assert(turn, 'no answer shows its sources')
    const marks = [...turn.querySelectorAll('.prose sup.cite a')]
    assert(marks.map((a) => a.textContent).join(',') === '1,2', 'the markers read ' + marks.map((a) => a.textContent).join(','))
    assert(marks[0].href.startsWith('https://docs.python.org/') && marks[1].href.startsWith('https://peps.python.org/'),
      'the markers link to ' + marks.map((a) => a.href).join(', '))
    const prose = turn.querySelector('.prose').textContent
    assert(!prose.includes('docs.python.org') && !prose.includes('(['), 'the inline links are still in the text: ' + prose)
    for (const mark of marks) {
      const box = mark.getBoundingClientRect()
      assert(box.width > 0 && box.height > 0, 'a marker rendered with no size')
    }

    const rows = [...turn.querySelectorAll('.chat-source')]
    assert(rows.length === 2, rows.length + ' source rows')
    const answerBox = turn.getBoundingClientRect()
    const described = rows.map((row) => {
      const n = row.querySelector('.chat-source-n').textContent.trim()
      const title = row.querySelector('.chat-source-title').textContent.trim()
      const host = row.querySelector('.chat-source-host').textContent.trim()
      const icon = row.querySelector('.source-icon').getBoundingClientRect()
      assert(title.length > 0 && host.length > 0, 'row ' + n + ' has no title or no site')
      // A run has no network, so every icon is a letter tile - and still the size of a favicon.
      assert(icon.width >= 14 && icon.height >= 14, 'row ' + n + "'s icon is " + icon.width + 'x' + icon.height)
      assert(row.getBoundingClientRect().right <= answerBox.right + 1, 'row ' + n + ' runs past its answer')
      return n + ' ' + title + ' · ' + host
    })
    assert(rows[0].querySelector('.chat-source-host').textContent.trim() === 'docs.python.org', 'row 1 is ' + described[0])
    // The site's name is beside the title already, so the title drops it.
    assert(!rows[1].querySelector('.chat-source-title').textContent.includes('peps.python.org'),
      'the title repeats the site: ' + described[1])

    // The list is the app's labels, not anything the model said.
    const inside = document.createRange()
    inside.selectNodeContents(rows[0].querySelector('.chat-source-title'))
    select(inside)
    await sleep(100)
    assert(!document.querySelector('.ask-about'), 'a source title was offered as a passage to ask about')
    window.getSelection().removeAllRanges()
    return described.join(' | ')
  })

  await step('a passage from an answer stays attached, and marked, in the next lesson', async () => {
    const before = document.querySelector('.lesson-head h1').textContent
    const next = [...document.querySelectorAll('.lesson-nav button')].find((b) => b.textContent.includes('→'))
    assert(next, 'no next lesson to move to')
    next.click()
    const t0 = Date.now()
    while (document.querySelector('.lesson-head h1').textContent === before && Date.now() - t0 < 4000) await sleep(50)
    assert(document.querySelector('.lesson-head h1').textContent !== before, 'the lesson did not change')
    await sleep(200)
    const label = document.querySelector('.sidechat-quote-label')?.textContent
    assert(label === 'From an answer', 'the attachment went with the lesson: ' + label)
    assert(marked()[0] === word, 'the mark went with the lesson: ' + JSON.stringify(marked()))
    return document.querySelector('.lesson-head h1').textContent
  })

  await step('dismissing a passage from an answer clears its mark', async () => {
    document.querySelector('.sidechat-quote-head button').click()
    const t0 = Date.now()
    while (document.querySelector('.sidechat-quote') && Date.now() - t0 < 2000) await sleep(50)
    assert(!document.querySelector('.sidechat-quote'), 'the quote is still attached')
    assert(!CSS.highlights.has('ask-quote'), 'the answer still marks a passage nobody is asking about')
    document.querySelector('.sidechat-close').click()
    await sleep(200)
    return 'unmarked'
  })

  return results
})()`

/**
 * The workspace browser, in a second pass.
 *
 * It runs after protocolChecks and fullscreenChecks because it navigates away
 * from the lesson those two inspect, and after main has seeded the project with
 * files - the only writer is a live session's tool call, and there is no
 * session here.
 */
const COACH_FILES_SCRIPT = `(async () => {
  const results = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (selector, timeout = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const el = document.querySelector(selector)
      if (el) return el
      await sleep(50)
    }
    throw new Error('timed out waiting for ' + selector)
  }
  const step = async (name, fn) => {
    try {
      const detail = await fn()
      results.push({ name, ok: true, detail: String(detail ?? '') })
    } catch (err) {
      results.push({ name, ok: false, detail: String(err && err.message ? err.message : err) })
    }
  }
  const assert = (cond, message) => {
    if (!cond) throw new Error(message)
  }
  const rowFor = (name) =>
    [...document.querySelectorAll('.file-row')].find((r) => r.querySelector('.file-name').textContent.includes(name))

  const projectId = window.__OPENCOURSE_SMOKE_PROJECT

  // --- the key ------------------------------------------------------------
  // Every check here stays offline: a malformed key is refused before any
  // request, and the model list falls back without one.

  await step('a missing key is said out loud rather than discovered at the worst moment', async () => {
    document.querySelector('.titlebar [data-section="coach"]').click()
    const banner = await waitFor('.key-banner')
    assert(/no openai key/i.test(banner.textContent), 'it said ' + banner.textContent)
    const stored = await window.fixtureAPI.hasOpenAIKey()
    assert(stored.has === false, 'a key is stored in a fresh profile')
    return banner.textContent.trim().slice(0, 44)
  })

  await step('the renderer is told whether a key exists, and nothing more', async () => {
    const stored = await window.fixtureAPI.hasOpenAIKey()
    assert(Object.keys(stored).sort().join(',') === 'has,hint', 'it returned ' + JSON.stringify(stored))
    assert(typeof window.fixtureAPI.getOpenAIKey === 'undefined', 'the bridge can read the key back')
    const readers = Object.keys(window.opencourse).filter((k) => /key/i.test(k))
    assert(readers.sort().join(',') === 'clearOpenAIKey,hasOpenAIKey,setOpenAIKey', readers.join(','))
    return readers.join(', ')
  })

  await step('a key of the wrong shape is refused without asking OpenAI', async () => {
    for (const bad of ['hunter2', 'sk-short', '']) {
      const result = await window.fixtureAPI.setOpenAIKey(bad)
      assert(result.status === 'invalid', bad + ' gave ' + JSON.stringify(result))
    }
    assert((await window.fixtureAPI.hasOpenAIKey()).has === false, 'something got stored')
    return 'three refused, nothing stored'
  })

  await step('the model picker offers realtime models even with no key', async () => {
    const list = await window.fixtureAPI.listCoachModels()
    assert(list.source === 'fallback', 'source was ' + list.source)
    assert(list.models.length > 0, 'the list is empty')
    assert(list.models.every((m) => /realtime/.test(m.id)), list.models.map((m) => m.id).join(', '))
    return list.models.length + ' models, all realtime'
  })

  await step('the key lives in settings, and settings never shows it back', async () => {
    // The banner used to open a dialog owned by Coach, which made the app's one
    // shared secret look like a Coach feature - the side chat needed the same
    // key and had grown a second door to the same modal.
    document.querySelector('.key-banner button').click()
    const field = await waitFor('.settings-section .settings-key')
    assert(field.type === 'password', 'the field is a ' + field.type)
    assert(field.value === '', 'the field is prefilled')
    // Scoped to the key's own card: the screen has a name field too, and that
    // one is supposed to be readable.
    const card = field.closest('.settings-section')
    assert(!card.querySelector('input[type=text]'), 'there is a plain text field beside the key')
    // Leave the way a person would, or the checks after this run with settings
    // still on screen.
    document.querySelector('.titlebar .crumbs a').click()
    await sleep(200)
    return field.type + ', empty'
  })

  await step('the workspace lists what the coach wrote', async () => {
    await waitFor('.coach-card')
    document.querySelector('.coach-card').click()
    await waitFor('.coach-files')

    const learned = rowFor('learned.md')
    const audio = rowFor('note.mp3')
    const weeks = rowFor('weeks')
    assert(learned, 'learned.md is not in the tree')
    assert(audio, 'note.mp3 is not in the tree')
    assert(weeks, 'the weeks folder is not in the tree')
    assert(learned.className.includes('text'), 'learned.md is ' + learned.className)
    assert(audio.className.includes('binary'), 'note.mp3 is ' + audio.className)
    assert(weeks.className.includes('dir'), 'weeks is ' + weeks.className)
    return [...document.querySelectorAll('.file-row')].length + ' rows'
  })

  await step('a nested note shows under its folder', async () => {
    const nested = rowFor('mots-a-reviser.md')
    assert(nested, 'the nested note is not shown')
    return nested.querySelector('.file-name').textContent.trim()
  })

  await step('opening a markdown note renders it, read-only', async () => {
    rowFor('learned.md').querySelector('.file-name').click()
    await waitFor('.coach-panel')
    // Assert what rendered, not that the panel exists.
    const heading = await waitFor('.coach-panel .prose h1')
    assert(/mots/i.test(heading.textContent), 'the heading says ' + heading.textContent)
    const items = document.querySelectorAll('.coach-panel .prose li')
    assert(items.length === 2, items.length + ' list items rendered')
    assert(/chien/.test(document.querySelector('.coach-panel .prose').textContent), 'the words are missing')
    assert(!document.querySelector('.coach-panel textarea'), 'the viewer offers a textarea')
    assert(/read-only/.test(document.querySelector('.coach-panel-head').textContent), 'it does not say read-only')
    return heading.textContent + ', ' + items.length + ' words'
  })

  await step('Escape closes the viewer', async () => {
    document.querySelector('.coach-panel').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    const t0 = Date.now()
    while (Date.now() - t0 < 3000 && document.querySelector('.coach-panel')) await sleep(50)
    assert(!document.querySelector('.coach-panel'), 'the viewer is still open')
    return 'closed'
  })

  await step('a file the app cannot show does not open', async () => {
    rowFor('note.mp3').querySelector('.file-name').click()
    await sleep(400)
    assert(!document.querySelector('.coach-panel'), 'a binary file opened a viewer')
    return 'stayed shut'
  })

  await step('the tree follows a change it did not make itself', async () => {
    // createCoachFolder broadcasts; nothing here calls refresh by hand.
    const before = [...document.querySelectorAll('.file-row')].length
    const result = await window.fixtureAPI.createCoachFolder(projectId, '', 'archive')
    assert(result.status === 'ok', JSON.stringify(result))
    const t0 = Date.now()
    while (Date.now() - t0 < 4000 && !rowFor('archive')) await sleep(50)
    assert(rowFor('archive'), 'the new folder never appeared')
    return before + ' rows before, ' + [...document.querySelectorAll('.file-row')].length + ' after'
  })

  await step('deleting a note moves it to the trash rather than destroying it', async () => {
    rowFor('learned.md').querySelector('[title=Delete]').click()
    const t0 = Date.now()
    while (Date.now() - t0 < 4000 && !rowFor('trash')) await sleep(50)
    assert(rowFor('trash'), 'no trash folder appeared')

    const files = await window.fixtureAPI.listCoachFiles(projectId)
    const trash = files.find((f) => f.path === 'trash')
    assert(trash, 'the trash is not in the tree')
    assert(trash.children.length === 1, trash.children.length + ' things in the trash')
    assert(/learned\.md$/.test(trash.children[0].name), 'the trash holds ' + trash.children[0].name)
    assert(!files.some((f) => f.path === 'learned.md'), 'learned.md is still at the top level')
    return 'trash/' + trash.children[0].name
  })

  await step('moving a note between folders relocates it on disk', async () => {
    const result = await window.fixtureAPI.moveCoachFile(projectId, 'weeks/mots-a-reviser.md', 'archive/mots-a-reviser.md')
    assert(result.status === 'ok', JSON.stringify(result))
    const files = await window.fixtureAPI.listCoachFiles(projectId)
    const archive = files.find((f) => f.path === 'archive')
    assert(archive && archive.children.length === 1, 'the archive holds nothing')
    const weeks = files.find((f) => f.path === 'weeks')
    assert(!weeks || (weeks.children || []).length === 0, 'the note is still under weeks')
    return 'archive/' + archive.children[0].name
  })

  await step('a move that would overwrite is refused rather than losing a file', async () => {
    await window.fixtureAPI.createCoachFolder(projectId, '', 'spare')
    const result = await window.fixtureAPI.moveCoachFile(projectId, 'archive', 'spare')
    assert(result.status !== 'ok', 'the move was allowed: ' + JSON.stringify(result))
    return result.status
  })

  await step('a past session is listed with what was said and how long it took', async () => {
    const list = await waitFor('.coach-sessions')
    const row = await waitFor('.session-row')
    assert(/bonjour/.test(row.textContent), 'the row does not show the opening line: ' + row.textContent)
    assert(/4 turns/.test(row.textContent), 'the row does not say how many turns: ' + row.textContent)
    assert(!/Loading/.test(list.textContent), 'the list is still loading')
    return row.querySelector('.session-title').textContent
  })

  await step('opening a session shows its transcript, both sides, in order', async () => {
    document.querySelector('.session-row .session-open').click()
    await waitFor('.transcript')
    const turns = [...document.querySelectorAll('.transcript .turn')]
    assert(turns.length === 4, turns.length + ' turns rendered')
    assert(turns[0].className.includes('user'), 'the first turn is ' + turns[0].className)
    assert(turns[1].className.includes('assistant'), 'the second turn is ' + turns[1].className)
    assert(/bonjour/.test(turns[0].textContent), 'first turn: ' + turns[0].textContent)
    assert(/le chien/.test(turns[3].textContent), 'last turn: ' + turns[3].textContent)
    return turns.map((t) => t.textContent.slice(0, 12)).join(' | ')
  })

  await step('a transcript keeps the brief that produced it, not the current one', async () => {
    const folds = [...document.querySelectorAll('.coach-project details')]
    const brief = folds.find((f) => /brief this session ran with/i.test(f.textContent))
    assert(brief, 'the session brief is not shown')
    brief.open = true
    await sleep(100)
    assert(/French vocabulary coach/.test(brief.textContent), 'it shows: ' + brief.textContent.slice(0, 80))
    return 'snapshotted'
  })

  await step('starting a session with no key says so instead of failing silently', async () => {
    document.querySelector('.titlebar .crumbs a').click()
    await waitFor('.coach-live')
    const start = [...document.querySelectorAll('.coach-live button')].find((b) => /Start a session/.test(b.textContent))
    assert(start, 'no Start button')
    start.click()

    const note = await waitFor('.coach-live .import-note.error')
    assert(/OpenAI key/i.test(note.textContent), 'it said: ' + note.textContent)
    // No session may have been recorded, and no microphone opened.
    const sessions = await window.fixtureAPI.listCoachSessions(projectId)
    assert(sessions.length === 1, sessions.length + ' sessions after a refused start')
    return note.textContent.slice(0, 40)
  })

  await step('a coach can be deleted, and takes its list entry with it', async () => {
    document.querySelector('.titlebar .crumbs a').click()
    await waitFor('.coach-card')

    // window.confirm would block a headless run on a real dialog.
    const realConfirm = window.confirm
    window.confirm = () => true
    try {
      document.querySelector('.coach-card .card-remove').click()
      const t0 = Date.now()
      while (Date.now() - t0 < 4000) {
        if ((await window.fixtureAPI.listCoachProjects()).length === 0) break
        await sleep(50)
      }
    } finally {
      window.confirm = realConfirm
    }
    assert((await window.fixtureAPI.listCoachProjects()).length === 0, 'the project survived')
    await waitFor('.coach .empty-library h3')
    return 'gone, and the empty state came back'
  })

  return results
})()`

/**
 * Stands in for what a tool call will write once there is a live session. Main
 * does it, because the renderer has no way to write a workspace file at all -
 * which is the property the checks above are there to protect.
 */
function send(sender: WebContents, channel: string, ...args: unknown[]): void {
  if (!sender.isDestroyed()) sender.send(channel, ...args)
}

async function seedCoachFiles(win: BrowserWindow): Promise<string> {
  const { listProjects } = await import('./coach')
  const { writeWorkspaceFile, workspaceFileHost } = await import('./coachfiles')
  const project = listProjects()[0]
  if (!project) throw new Error('no coach project to seed')

  const wrote = [
    writeWorkspaceFile(project.id, 'learned.md', '# mots appris\n\n- le chien\n- le chat\n'),
    writeWorkspaceFile(project.id, 'weeks/mots-a-reviser.md', '# a reviser\n\n- etre\n')
  ]
  for (const result of wrote) if (!result.ok) throw new Error(result.error)
  // Something the app must list but never open.
  writeFileSync(join(workspaceFileHost(project.id), 'note.mp3'), Buffer.from([0xff, 0xfb, 0x00, 0x11]))

  // A finished session, so the list and the transcript have something to show.
  const { insertSession, finishSession, saveTurns, recordToolCall } = await import('./coachdb')
  const { newSessionId } = await import('../core/coach/ids')
  const sessionId = newSessionId()
  insertSession({
    id: sessionId,
    projectId: project.id,
    startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    model: 'gpt-realtime-2.1',
    instructions: 'You are a French vocabulary coach.'
  })
  saveTurns(sessionId, [
    { seq: 0, role: 'user', text: 'bonjour, je veux apprendre des mots', at: new Date().toISOString() },
    { seq: 1, role: 'assistant', text: 'tres bien, commencons par les animaux', at: new Date().toISOString() },
    { seq: 2, role: 'user', text: 'comment dit-on dog', at: new Date().toISOString() },
    { seq: 3, role: 'assistant', text: 'le chien', at: new Date().toISOString() }
  ])
  recordToolCall(sessionId, {
    seq: 4,
    callId: 'call_seed',
    name: 'write_file',
    arguments: '{"path":"learned.md"}',
    ok: true,
    at: new Date().toISOString()
  })
  finishSession(sessionId, 'ended')

  send(win.webContents, 'coach:filesChanged', project.id)
  return project.id
}

/** What the coach leaves on disk. The renderer cannot look, so main does. */
async function coachChecks(): Promise<Result[]> {
  const results: Result[] = []
  const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      results.push({ name, ok: true, detail: await fn() })
    } catch (err) {
      results.push({ name, ok: false, detail: String(err) })
    }
  }
  const expect = (cond: boolean, message: string): void => {
    if (!cond) throw new Error(message)
  }

  await check('every user gets their own coach database', async () => {
    const { listUsers } = await import('./users')
    const { userDbFile } = await import('./paths')
    const files = listUsers().map((u) => userDbFile(u.id))
    expect(files.length >= 2, `only ${files.length} users`)
    expect(new Set(files).size === files.length, 'two users share a database file')
    // The first user made a project, so their database exists on disk.
    expect(files.some((f) => existsSync(f)), 'no coach database was written at all')
    return `${files.length} users, ${files.filter((f) => existsSync(f)).length} with a database`
  })

  await check('a deleted coach leaves no workspace behind', async () => {
    const { currentUserId } = await import('./users')
    const { coachProjectsRoot } = await import('./paths')
    const root = coachProjectsRoot(currentUserId() as string)
    const left = existsSync(root) ? readdirSync(root) : []
    expect(left.length === 0, `left behind: ${left.join(', ')}`)
    return 'nothing left'
  })

  await check('one user cannot see another user\'s coaches', async () => {
    const { listProjects } = await import('./coach')
    // The current user deleted theirs; nothing may leak in from the other user.
    expect(listProjects().length === 0, 'saw a project belonging to someone else')
    return '0 projects'
  })

  return results
}

/** Protocol checks belong in main: the renderer cannot fetch opencourse:// (no CORS, by design). */
async function protocolChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      results.push({ name, ok: true, detail: await fn() })
    } catch (err) {
      results.push({ name, ok: false, detail: String(err) })
    }
  }
  const expect = (cond: boolean, message: string): void => {
    if (!cond) throw new Error(message)
  }

  const fixtureId = fixtureCourse('python-asyncio')!.courseId
  await check('opencourse:// serves a viz bundle', async () => {
    const res = await net.fetch(`opencourse://${fixtureId}/assets/viz/streams-backpressure/index.html`)
    expect(res.status === 200, `status ${res.status}`)
    expect(res.headers.get('content-type') === 'text/html', `type ${res.headers.get('content-type')}`)
    return `${res.status} ${res.headers.get('content-type')}`
  })
  await check('viz responses carry a CSP', async () => {
    const res = await net.fetch(`opencourse://${fixtureId}/assets/viz/event-loop/app.js`)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp.includes("connect-src 'none'"), `csp was ${csp}`)
    return csp.slice(0, 48) + '…'
  })
  await check('a visualization page is served with the selection bridge', async () => {
    const page = await (await net.fetch(`opencourse://${fixtureId}/assets/viz/event-loop/index.html`)).text()
    expect(page.includes('src="/__opencourse/viz-bridge.js"'), 'no bridge tag in the page')
    const script = await net.fetch(`opencourse://${fixtureId}/__opencourse/viz-bridge.js`)
    const type = script.headers.get('content-type') ?? ''
    expect(script.status === 200 && type.startsWith('text/javascript'), `bridge served ${script.status} ${type}`)
    expect((await script.text()).includes('opencourse-viz'), 'the bridge script is not the bridge')
    // Only pages: the bundle's own scripts and styles go out untouched.
    const js = await (await net.fetch(`opencourse://${fixtureId}/assets/viz/event-loop/app.js`)).text()
    expect(!js.includes('opencourse-bridge'), 'the bridge was injected into a script')
    return 'tag in the page, script served'
  })
  await check('path traversal refused', async () => {
    const res = await net.fetch(`opencourse://${fixtureId}/../../../etc/passwd`)
    expect(res.status === 404, `status ${res.status}`)
    return '404'
  })
  await check('encoded traversal refused', async () => {
    const res = await net.fetch(`opencourse://${fixtureId}/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    expect(res.status === 404, `status ${res.status}`)
    return '404'
  })
  await check('the visualization frame really loaded', async () => {
    // A frame blocked by CSP still exists in the DOM with a null contentDocument,
    // so ask the frame tree what it actually navigated to.
    const urls = win.webContents.mainFrame.framesInSubtree.map((f) => f.url)
    const viz = urls.find((u) => u.startsWith('opencourse://'))
    expect(Boolean(viz), `no opencourse:// frame navigated (frames: ${urls.join(', ')})`)
    return viz as string
  })
  await check('unknown course refused', async () => {
    const res = await net.fetch('opencourse://not-a-course/course.json')
    expect(res.status === 404, `status ${res.status}`)
    return '404'
  })
  return results
}

/**
 * The archives the run imports. The example ships with the app; the asyncio
 * course is zipped from the repo checkout, so the checks below still run
 * against the content they were written for even though the app ships none.
 */
function buildFixtures(): { example: string; asyncio: string; notACourse: string } {
  const dir = mkdtempSync(join(tmpdir(), 'opencourse-smoke-zips-'))
  const example = join(dir, 'example.zip')
  copyFileSync(join(specResourcesDir(), 'opencourse-example-course.zip'), example)

  const asyncio = join(dir, 'python-asyncio.zip')
  execFileSync('ditto', [
    '-c',
    '-k',
    '--norsrc',
    '--noextattr',
    join(process.env['OPENCOURSE_SMOKE_CONTENT'] || join(app.getAppPath(), '..', 'content'), 'python-asyncio'),
    asyncio
  ])

  // An archive of the right shape with no course.json in it.
  const junk = join(dir, 'junk')
  mkdirSync(junk, { recursive: true })
  copyFileSync(join(specResourcesDir(), 'course-schema.json'), join(junk, 'course-schema.json'))
  const notACourse = join(dir, 'not-a-course.zip')
  execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', junk, notACourse])

  return { example, asyncio, notACourse }
}

/** Projects are checked after existing screens so this course cannot change their fixtures. */
async function projectChecks(win: BrowserWindow): Promise<Result[]> {
  const begin = `(async () => {
    const wait = async (selector) => { for (let n = 0; n < 160; n++) { const el = document.querySelector(selector); if (el && el.getBoundingClientRect().width) return el; await new Promise(r => setTimeout(r, 50)); } throw new Error('No ' + selector); };
    document.querySelector('.titlebar [data-section="courses"]').click(); await wait('.library');
    const imported = await window.fixtureAPI.importCoursePath(window.__OPENCOURSE_SMOKE_ZIPS.example);
    if (imported.status !== 'ok') throw new Error(JSON.stringify(imported));
    // This direct IPC fixture import bypasses Library's own import handler.
    // Remount it so the cards are fetched before selecting the new course.
    document.querySelector('.titlebar [data-section="coach"]').click();
    await new Promise(r => setTimeout(r, 250));
    document.querySelector('.titlebar [data-section="courses"]').click();
    for (let n = 0; n < 160; n++) {
      if ([...document.querySelectorAll('.course-card')].some(card => /The OpenCourse example course/.test(card.textContent))) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('Imported example card did not load');
  })()`
  await win.webContents.executeJavaScript(begin)
  const checks: Result[] = []
  const inspect = async (name: string, script: string): Promise<void> => {
    try { const detail = await win.webContents.executeJavaScript(script); checks.push({ name, ok: true, detail: String(detail ?? '') }) }
    catch (err) { checks.push({ name, ok: false, detail: String(err) }) }
  }
  await inspect('project module opens a brief and the shared chat pane', `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.querySelectorAll('.course-card').forEach(card => { if (/The OpenCourse example course/.test(card.textContent)) card.click(); });
    for (let n=0; n<100 && !document.querySelector('.project-row'); n++) await sleep(50);
    document.querySelector('.project-row').click();
    for (let n=0; n<100 && !document.querySelector('.project-directory'); n++) await sleep(50);
    if (!/Build a course outline/.test(document.querySelector('.project-brief h1')?.textContent)) throw new Error('Project brief missing');
    if (!/Design rationale/.test(document.querySelector('.project-deliverables')?.textContent)) throw new Error('Deliverables missing');
    if (!/Project assistant/.test(document.querySelector('.sidechat-head')?.textContent)) throw new Error('Project chat missing');
    return 'Requirements, deliverables and shared chat rendered';
  })()`)
  await inspect('project opens a persistent workspace without an API key', `(async () => {
    const target = { courseId: 'opencourse-example', moduleId: 'build-a-course-project' };
    const first = await window.fixtureAPI.openCourseProject(target); const second = await window.fixtureAPI.openCourseProject(target);
    if (first.missing || second.missing || first.directory !== second.directory) throw new Error('Workspace not stable');
    if (!first.directory.includes('/course-projects/' + await window.fixtureCourseId(target.courseId) + '/' + await window.fixtureNodeId(target.courseId, target.moduleId))) throw new Error('Wrong workspace namespace');
    if (!document.querySelector('.project-editor-actions button')) throw new Error('No workspace actions');
    return first.directory;
  })()`)
  await inspect('project chat stays out of lesson chat history', `(async () => {
    const methods = Object.keys(window.opencourse).filter(k => /ProjectChat/.test(k)).sort();
    const expected = ['cancelProjectChat','createProjectChat','deleteProjectChat','getProjectChat','listProjectChats','onProjectChatActivity','onProjectChatDelta','onProjectChatDone','onProjectChatError','onProjectChatTitle','setProjectChatModel','setProjectChatReasoning'];
    if (methods.join(',') !== expected.sort().join(',') || typeof window.fixtureAPI.sendProjectMessage !== 'function') throw new Error('Unexpected project chat bridge');
    const target = { courseId: 'opencourse-example', moduleId: 'build-a-course-project' };
    if ((await window.fixtureAPI.listProjectChats(target)).length) throw new Error('The untouched project tab registered a chat');
    await window.fixtureAPI.createProjectChat(target);
    const projects = await window.fixtureAPI.listProjectChats(target);
    if (projects.length !== 1) throw new Error(projects.length + ' project conversations');
    const lessons = await window.fixtureAPI.listChats('opencourse-example');
    if (lessons.some(chat => projects.some(project => project.id === chat.id))) throw new Error('Project chat leaked into lesson history');
    if ((await window.fixtureAPI.getChat(projects[0].id)) !== null) throw new Error('Project is a lesson chat');
    return 'Separate chat histories';
  })()`)
  await inspect('project draft, chat and brief scroll survive the Settings round-trip', `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const input = document.querySelector('.sidechat-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Keep this project question');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const brief = document.querySelector('.project-brief'); brief.scrollTop = 200; const top = brief.scrollTop;
    await sleep(100);
    document.querySelector('.sidechat-note button').click();
    for (let n=0; n<100 && !document.querySelector('.settings'); n++) await sleep(50);
    [...document.querySelectorAll('.titlebar')].find(el => el.getBoundingClientRect().width > 0).querySelector('.crumbs a').click();
    for (let n=0; n<100 && document.querySelector('.settings'); n++) await sleep(50);
    if (document.querySelector('.sidechat-input').value !== 'Keep this project question') throw new Error('Draft lost');
    if (Math.abs(document.querySelector('.project-brief').scrollTop - top) > 2) throw new Error('Brief scroll lost');
    if (document.querySelector('.project-screen').hidden) throw new Error('Project stayed hidden');
    return 'Draft and scroll retained';
  })()`)
  await inspect('project review has an actionable missing-key state', `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('.project-request-review').click(); await sleep(150);
    if (!/OpenAI key/.test(document.querySelector('.project-body .sidechat-error')?.textContent)) throw new Error('No review key error');
    if (!document.querySelector('.project-deliverables')) throw new Error('Brief lost on no-key');
    return 'Review needs key; project remains usable';
  })()`)
  await inspect('project completion is explicit and appears in progress', `(async () => {
    const button = [...document.querySelectorAll('.project-review-actions button')].find(b => /Mark project complete/.test(b.textContent));
    button.click(); await new Promise(r => setTimeout(r, 150));
    const progress = await window.fixtureAPI.getProgress('opencourse-example');
    if (!progress.projects[await window.fixtureNodeId('opencourse-example', 'build-a-course-project')]?.completedAt) throw new Error('Project not completed');
    if (progress.lastItem?.kind !== 'project') throw new Error('Continue would not resume project');
    return 'Completed explicitly and resumable';
  })()`)
  const size = win.getSize()
  win.setSize(720, size[1]!)
  await new Promise((resolve) => setTimeout(resolve, 100))
  await inspect('project panes remain readable at the minimum window width', `(() => {
    const row = document.querySelector('.project-body');
    const brief = document.querySelector('.project-brief'); const chat = document.querySelector('.project-body .sidechat');
    if (row.scrollWidth > row.clientWidth + 2) throw new Error('Horizontal overflow');
    if (brief.getBoundingClientRect().width < 260 || chat.getBoundingClientRect().width < 300) throw new Error('A pane was squeezed away');
    return brief.clientWidth + 'px brief, ' + chat.clientWidth + 'px chat';
  })()`)
  win.setSize(size[0]!, size[1]!)
  await inspect('project previous and next navigation reach real lessons', `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.project-brief .lesson-nav button')].find(b => /Reflection/.test(b.textContent)).click();
    for (let n=0; n<100 && !document.querySelector('.lesson-head'); n++) await sleep(50);
    if (!/Reflection/.test(document.querySelector('.lesson-head h1')?.textContent)) throw new Error('Project next skipped destination');
    [...document.querySelectorAll('.lesson-nav button')].find(b => /Build a course outline/.test(b.textContent)).click();
    for (let n=0; n<100 && !document.querySelector('.project-directory'); n++) await sleep(50);
    if (!document.querySelector('.project-directory')) throw new Error('Lesson previous skipped project');
    return 'Project → lesson → project';
  })()`)
  return checks
}

async function subscriptionChecks(win: BrowserWindow): Promise<Result[]> {
  const { simulateSubscriptionForSmoke, disconnectSubscription } = await import('./subscription')
  simulateSubscriptionForSmoke()
  const originalFetch = net.fetch
  const requests: Record<string, unknown>[] = []
  net.fetch = (async (url, init) => {
    if (String(url) !== 'https://api.openai.com/v1/responses' || (init?.headers as Record<string, string>)?.Authorization !== 'Bearer opencourse-smoke-subscription') return originalFetch(url, init)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push(body)
    const input = body.input as Record<string, unknown>[]
    const hasTools = Array.isArray(body.tools) && body.tools.some((tool: { type?: string }) => tool.type === 'namespace')
    const continued = input.some(item => item.type === 'function_call_output')
    const output = hasTools && !continued ? [{ type: 'reasoning', encrypted_content: 'simulated-reasoning', summary: [] },
      { type: 'function_call', namespace: 'project', name: 'read_project_file', call_id: 'smoke-file', arguments: '{"path":"README.md","start_line":1,"max_lines":100}' }] : []
    const events = [...(!output.length ? [{ type: 'response.output_text.delta', delta: hasTools ? 'Simulated review based on the project README.' : 'Simulated subscription lesson answer.' }] : []),
      { type: 'response.completed', response: { output } }]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof net.fetch
  const results: Result[] = []
  const check = async (name: string, script: string): Promise<void> => {
    try { results.push({ name, ok: true, detail: String(await win.webContents.executeJavaScript(script)) }) }
    catch (error) { results.push({ name, ok: false, detail: String(error) }) }
  }
  const wait = `const sleep = ms => new Promise(r => setTimeout(r, ms)); const wait = async selector => { for(let n=0;n<160;n++){ const el=document.querySelector(selector); if(el && el.getBoundingClientRect().width)return el; await sleep(25); } throw new Error('No '+selector); };`
  try {
    await check('subscription Settings keeps four profiles and routing independent', `(async () => {
      ${wait}
      document.querySelector('.titlebar .user-chip').click(); const menu=await wait('.menu-panel'); [...menu.querySelectorAll('.menu-item')].find(b=>/Settings/.test(b.textContent)).click();
      await wait('.settings-ai-chat .settings-model'); await wait('.settings-ai-project .settings-model');
      if(!/Simulated account/.test(document.querySelector('.settings-subscription').textContent))throw new Error('Connection not displayed');
      const projectBefore=await window.fixtureAPI.getAIModelSettings('project','apiKey');
      document.querySelector('.settings-ai-configure-chat').click();
      const types=await wait('.menu-panel'); [...types.querySelectorAll('.menu-item')].find(b=>/ChatGPT subscription/.test(b.textContent)).click();
      for(let n=0;n<100 && !document.querySelector('.settings-ai-chat .settings-default-chat-model option[value="gpt-5.3-codex"]');n++)await sleep(25);
      if(!document.querySelector('.settings-ai-chat .settings-default-chat-model option[value="gpt-5.3-codex"]'))throw new Error('Codex model excluded from subscription catalog');
      const subscription=await window.fixtureAPI.getAIModelSettings('chat','chatgpt');
      if(subscription.selectedProvider!=='apiKey' || subscription.profile.defaultModel!=='gpt-6.1-sol')throw new Error('Editing profile changed routing or initialization');
      await window.fixtureAPI.setAIProfile('chat','chatgpt',{enabledModels:['gpt-5.3-codex'],defaultModel:'gpt-5.3-codex',defaultReasoning:'high'});
      await window.fixtureAPI.setAIProvider('chat','chatgpt');
      const projectAfter=await window.fixtureAPI.getAIModelSettings('project','apiKey');
      if(JSON.stringify(projectAfter.profile)!==JSON.stringify(projectBefore.profile)||projectAfter.selectedProvider!=='apiKey')throw new Error('Chat settings changed project settings');
      if((await window.fixtureAPI.hasOpenAIKey()).has)throw new Error('Subscription created an API key');
      document.querySelector('.titlebar .crumbs a').click(); await wait('.lesson-head h1');
      if(!document.querySelector('.sidechat'))document.querySelector('.titlebar .chat-chip').click();
      for(let n=0;n<100 && !/ChatGPT subscription/.test(document.querySelector('.sidechat-connection')?.getAttribute('aria-label'));n++)await sleep(25);
      const indicator=document.querySelector('.sidechat-connection');
      if(!/ChatGPT subscription/.test(indicator?.getAttribute('aria-label')) || !indicator.querySelector('svg'))throw new Error('Composer connection icon stale');
      indicator.focus(); const tooltip=await wait('[role="tooltip"]');
      if(!/ChatGPT subscription/.test(tooltip.textContent))throw new Error('Composer connection tooltip stale');
      indicator.blur();
      return 'Four profiles; editing preserves routing; mixed providers reflected in composer';
    })()`)
    await check('simulated subscription streams lesson text through the real main transport', `(async () => {
      ${wait}
      const course=await window.fixtureAPI.getCourse('opencourse-example'); const module=course.modules.find(m=>m.type!=='project'&&m.lessons?.length); const lesson={moduleId:module.slug,lessonId:module.lessons[0].slug};
      const chat=await window.fixtureAPI.createChat('opencourse-example',lesson);
      const result=await window.fixtureAPI.sendChatMessage(chat.id,'Explain',undefined,lesson); if(result.status!=='ok')throw new Error(JSON.stringify(result));
      for(let n=0;n<100;n++){ const thread=await window.fixtureAPI.getChat(chat.id); if(thread.messages.some(m=>m.text==='Simulated subscription lesson answer.'&&m.status==='complete'))return 'Subscription text saved complete'; await sleep(25); } throw new Error('No completed text');
    })()`)
    await check('simulated subscription project Review retains file tools and completion evidence', `(async () => {
      ${wait}
      await window.fixtureAPI.setAIProvider('project','chatgpt');
      const projectLink=[...document.querySelectorAll('.sidebar a')].find(a=>a.getBoundingClientRect().width && /Project workspace/.test(a.textContent));
      if(!projectLink)throw new Error('No project navigation'); projectLink.click();
      const button=await wait('.project-request-review'); for(let n=0;n<100 && button.disabled;n++)await sleep(25); button.click();
      for(let n=0;n<160;n++){ const progress=await window.fixtureAPI.getProgress('opencourse-example'); const review=progress.projects?.[await window.fixtureNodeId('opencourse-example', 'build-a-course-project')]?.lastReview;
        if(review){ const thread=await window.fixtureAPI.getProjectChat(review.chatId); if(thread.messages.some(m=>m.text==='Simulated review based on the project README.'&&m.status==='complete'))return 'Review completed through file-tool continuation'; } await sleep(25); } throw new Error('Review did not complete');
    })()`)
    await check('a connected subscription leaves Coach requiring an API key', `(async () => {
      const coach=await window.fixtureAPI.createCoachProject({name:'Subscription coach check'});
      const result=await window.fixtureAPI.startCoachSession(coach.id); await window.fixtureAPI.deleteCoachProject(coach.id);
      if(result.status!=='no-key')throw new Error(JSON.stringify(result));
      return 'Coach cannot use subscription credentials';
    })()`)
    if (!requests.length || requests.some(request => request.store !== false || request.stream !== true || 'max_output_tokens' in request || (request.input as { role?: string }[]).some(item => item.role === 'system'))) results.push({ name: 'subscription smoke requests use supported parameters', ok: false, detail: 'Unsupported request shape' })
    else results.push({ name: 'subscription smoke requests use supported parameters', ok: true, detail: `${requests.length} Responses requests, developer instructions, namespace tools, local continuation` })
  } finally {
    // Restore routing and remove synthetic credentials without remote revocation.
    const { setAIProvider } = await import('./ai'); setAIProvider('chat','apiKey'); setAIProvider('project','apiKey')
    net.fetch = (async (url, init) => String(url).includes('auth.openai.com') ? new Response('', { status: 503 }) : originalFetch(url, init)) as typeof net.fetch
    await disconnectSubscription(); net.fetch = originalFetch
  }
  return results
}

/** A run leaves a whole profile behind, virtualenv included, unless it tidies up. */
function cleanup(): void {
  for (const dir of [process.env['OPENCOURSE_RUN_PROFILE'], process.env['OPENCOURSE_SMOKE_ZIPS_DIR']]) {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

/** Exercise appearance overrides in Chromium without changing the user's macOS settings. */
async function appearanceChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const cdp = win.webContents.debugger
  const attached = cdp.isAttached()
  if (!attached) cdp.attach('1.3')
  const check = async (name: string, code: string): Promise<void> => {
    try {
      const detail = await win.webContents.executeJavaScript(code)
      results.push({ name, ok: true, detail: String(detail) })
    } catch (error) { results.push({ name, ok: false, detail: String(error) }) }
  }
  try {
    await check('user picker shows branding only in the titlebar', `(async () => {
      for (let i = 0; i < 80 && !document.querySelector('.users h1'); i++) await new Promise(r => setTimeout(r, 50));
      if (!document.querySelector('.users h1')) throw new Error('Picker did not load');
      if (document.title !== 'OpenCourse' || !window.opencourse || window.localcrs || window.pycrs) throw new Error('Wrong app identity or bridge');
      const icon = document.querySelector('.titlebar .brand img');
      if (document.querySelector('.users .brand') || !icon || document.querySelector('.titlebar .brand').textContent !== 'OpenCourse') throw new Error('Branding is not confined to the titlebar');
      await icon.decode();
      if (!icon.naturalWidth) throw new Error('Titlebar logo failed to load');
      return 'OpenCourse logo and wordmark in titlebar; no logo in picker content';
    })()`)
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await check('light system preference retains charcoal surfaces and legible silver controls', `(() => {
      const root = getComputedStyle(document.documentElement);
      const content = getComputedStyle(document.querySelector('.content'));
      if (root.colorScheme !== 'dark' || content.backgroundColor !== 'rgba(0, 0, 0, 0.19)') throw new Error('Appearance followed the light preference or picker lost its black tint');
      const button = [...document.querySelectorAll('.user-card.new button')].find(b => b.textContent.trim() === 'Create');
      const style = getComputedStyle(button);
      if (style.color !== 'rgb(32, 32, 36)' || style.backgroundColor !== 'rgb(228, 228, 232)') throw new Error('Off-white control contrast is incorrect');
      if (root.getPropertyValue('--bg').trim() !== '#111110' || root.getPropertyValue('--fg').trim() !== '#dedee3') throw new Error('Softened palette did not load');
      return 'soft charcoal surfaces, off-white text, legible brighter off-white controls';
    })()`)
    await check('surface transparency follows the requested hierarchy', `(async () => {
      const alpha = el => { const color = getComputedStyle(el).backgroundColor; return color.startsWith('rgba') ? Number(color.match(/,\\s*([\\d.]+)\\)$/)[1]) : 1; };
      const title = alpha(document.querySelector('.titlebar'));
      const picker = alpha(document.querySelector('.content'));
      const surfaces = ['content content-glass', 'sidebar', 'sidechat', 'content'];
      const values = surfaces.map(className => {
        const probe = document.createElement('div'); probe.className = className; document.querySelector('.app').append(probe);
        try { return alpha(probe); } finally { probe.remove(); }
      });
      if (title !== 0.4 || picker !== 0.19 || values.slice(0, 3).some(value => value !== picker) || values[3] !== 1) throw new Error(JSON.stringify({title, picker, values}));
      if (getComputedStyle(document.querySelector('.titlebar')).backgroundColor !== 'rgba(0, 0, 0, 0.4)') throw new Error('Titlebar lost its black tint');
      if (getComputedStyle(document.querySelector('.titlebar')).backgroundImage !== 'none') throw new Error('Titlebar should be smooth, without grain');
      if (getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)') throw new Error('Body obscures native vibrancy');
      const textured = getComputedStyle(document.querySelector('.content'));
      if (textured.backgroundImage === 'none') throw new Error('Glass texture did not load');
      // The inline SVG itself contains url(#grain), so strip only the outer wrapper.
      const url = textured.backgroundImage.slice(4, -1).replace(/^["']|["']$/g, '');
      const grain = new Image(); grain.src = url; await grain.decode();
      if (grain.naturalWidth !== 160) throw new Error('Grain asset is missing');
      return 'black tint: 40% titlebar; 19% picker/list/sidebar/chat surfaces; static grain loaded; opaque reading content';
    })()`)
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-reduced-transparency', value: 'reduce' },
      { name: 'prefers-contrast', value: 'more' }
    ] })
    await check('accessibility preferences remove motion and make chrome opaque', `(() => {
      const chrome = getComputedStyle(document.querySelector('.titlebar'));
      const card = getComputedStyle(document.querySelector('.user-card'));
      if (chrome.backgroundColor !== 'rgb(28, 28, 32)') throw new Error('Chrome remains translucent');
      if (getComputedStyle(document.querySelector('.content')).backgroundColor !== 'rgb(17, 17, 16)') throw new Error('Main surface remains translucent');
      if (getComputedStyle(document.querySelector('.content')).backgroundImage !== 'none') throw new Error('Texture remains enabled');
      if (card.transitionDuration.split(',').some(v => parseFloat(v) !== 0)) throw new Error('Motion remains enabled');
      if (getComputedStyle(document.documentElement).getPropertyValue('--border').trim() !== '#74747c') throw new Error('Contrast preference was ignored');
      return 'opaque chrome, static cards, stronger borders';
    })()`)
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    win.setSize(720, 520)
    await pause(150)
    await check('branded picker fits the minimum supported window width', `(() => {
      if (document.documentElement.scrollWidth > window.innerWidth || document.querySelector('.content').scrollWidth > document.querySelector('.content').clientWidth) throw new Error('Picker overflows horizontally');
      return window.innerWidth + 'px';
    })()`)
  } finally {
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    win.setSize(1240, 860)
    if (!attached) cdp.detach()
  }
  return results
}

/** Check navigation motion and hover treatment using real controls and OS media preferences. */
async function motionChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const cdp = win.webContents.debugger
  const attached = cdp.isAttached()
  if (!attached) cdp.attach('1.3')
  const check = async (name: string, code: string): Promise<void> => {
    try {
      const detail = await win.webContents.executeJavaScript(code)
      results.push({ name, ok: true, detail: String(detail) })
    } catch (error) { results.push({ name, ok: false, detail: String(error) }) }
  }
  try {
    await cdp.sendCommand('DOM.enable')
    await cdp.sendCommand('CSS.enable')
    const { root } = await cdp.sendCommand('DOM.getDocument')
    const { nodeId: chipId } = await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.titlebar .user-chip' })
    await cdp.sendCommand('CSS.forcePseudoState', { nodeId: chipId, forcedPseudoClasses: ['hover'] })
    await win.webContents.executeJavaScript(`document.querySelector('.titlebar .user-chip').click()`)
    await pause(180)
    const { nodeId: itemId } = await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.user-menu .menu-item' })
    await cdp.sendCommand('CSS.forcePseudoState', { nodeId: itemId, forcedPseudoClasses: ['hover'] })
    await check('username and user menu hover without outlines', `(async () => {
      await new Promise(r => setTimeout(r, 160));
      for (const selector of ['.titlebar .user-chip', '.user-menu .menu-item']) {
        const style = getComputedStyle(document.querySelector(selector));
        if (style.boxShadow !== 'none' || style.outlineStyle !== 'none') throw new Error(selector + ' has a hover outline');
      }
      return 'Hovered username and dropdown item have no border ring';
    })()`)
    await cdp.sendCommand('CSS.forcePseudoState', { nodeId: chipId, forcedPseudoClasses: ['hover', 'focus-visible'] })
    await check('username keeps its keyboard focus indicator even under the pointer', `(async () => {
      await new Promise(r => setTimeout(r, 160));
      if (getComputedStyle(document.querySelector('.titlebar .user-chip')).boxShadow === 'none') throw new Error('Keyboard focus indicator removed');
      return 'Keyboard focus remains visible';
    })()`)
    await cdp.sendCommand('CSS.forcePseudoState', { nodeId: chipId, forcedPseudoClasses: [] })
    await cdp.sendCommand('CSS.forcePseudoState', { nodeId: itemId, forcedPseudoClasses: [] })
    await check('screen transitions animate content while the titlebar stays steady', `(async () => {
      [...document.querySelectorAll('.user-menu .menu-item')].find(b => /Settings/.test(b.textContent)).click();
      for (let n = 0; n < 50 && !document.querySelector('.settings'); n++) await new Promise(r => setTimeout(r, 8));
      const body = document.querySelector('.app > .body');
      if (!body?.getAnimations().some(a => a.playState === 'running')) throw new Error('No content transition');
      const titlebar = [...document.querySelectorAll('.titlebar')].find(el => el.getBoundingClientRect().width);
      if (titlebar.getAnimations().length || getComputedStyle(titlebar).opacity !== '1') throw new Error('Titlebar animated with content');
      return 'Content fades independently of the titlebar';
    })()`)
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await check('reduced motion cancels navigation and suppresses subsequent entrances', `(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const body = document.querySelector('.app > .body');
      if (body.getAnimations({subtree: true}).some(a => a.playState === 'running')) throw new Error('Navigation still animating');
      document.querySelector('.app > .titlebar .crumbs a').click();
      for (let n = 0; n < 50 && document.querySelector('.settings'); n++) await new Promise(r => setTimeout(r, 8));
      const project = document.querySelector('.project-screen:not([hidden]) > .body');
      if (!project || project.getAnimations({subtree: true}).some(a => a.playState === 'running')) throw new Error('Reduced-motion project animated');
      return 'In-flight motion cancelled; return navigation remains static';
    })()`)
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    await check('Ask entrance keeps its model menu anchored after the slide', `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.project-brief .lesson-nav button')].find(b => /Reflection/.test(b.textContent)).click();
      for (let n = 0; n < 100 && !document.querySelector('.lesson-head'); n++) await sleep(20);
      const chip = document.querySelector('.titlebar .chat-chip');
      if (document.querySelector('.sidechat')) { chip.click(); await sleep(30); }
      chip.click();
      for (let n = 0; n < 100 && !document.querySelector('.sidechat-model'); n++) await sleep(8);
      const chat = document.querySelector('.sidechat');
      if (!chat.getAnimations().some(a => a.animationName === 'chat-panel-enter')) throw new Error('No Ask entrance');
      const trigger = document.querySelector('.sidechat-model'); trigger.click();
      for (let n = 0; n < 50 && !document.querySelector('.menu-panel'); n++) await sleep(8);
      await sleep(450);
      const panel = document.querySelector('.menu-panel');
      const from = trigger.getBoundingClientRect(); const box = panel.getBoundingClientRect();
      if (panel.parentElement !== document.body || Math.abs(box.left - from.left) > 2 || box.bottom > from.top + 1) throw new Error('Model menu drifted during entrance: ' + JSON.stringify({panel: box.toJSON(), trigger: from.toJSON()}));
      trigger.click();
      return 'Ask slides in; model menu stays above and aligned with its trigger';
    })()`)
    // No API key is used in smoke. The open tab is a draft with no chat behind
    // it, so create one for this lesson, let the panel's history pick it up and
    // open it; then append through the normal database layer and emit the
    // completion event that makes the visible thread refresh.
    const chatId = await win.webContents.executeJavaScript(`(async () => {
      const course = await window.fixtureAPI.getCourse('opencourse-example');
      const module = course.modules.find(m => (m.lessons ?? []).some(l => /Reflection/.test(l.title)));
      const lesson = module.lessons.find(l => /Reflection/.test(l.title));
      return (await window.fixtureAPI.createChat('opencourse-example', { moduleId: module.slug, lessonId: lesson.slug })).id;
    })()`)
    win.webContents.send('chat:done', chatId, { stopped: false })
    await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const total = (await window.fixtureAPI.listChats('opencourse-example')).length;
      document.querySelector('.sidechat-history-toggle').click();
      // Newest first, once the list has caught up with the chat just made.
      for (let n = 0; n < 100 && document.querySelectorAll('.sidechat-history-row').length < total; n++) await sleep(8);
      document.querySelector('.sidechat-history-row').click(); document.querySelector('.sidechat-history-toggle').click();
      for (let n = 0; n < 100 && !document.querySelector('.sidechat-empty'); n++) await sleep(8);
    })()`)
    const { appendMessage } = await import('./chatdb')
    appendMessage(chatId, { role: 'user', text: 'Motion fixture question', at: new Date().toISOString() })
    win.webContents.send('chat:done', chatId, { stopped: false })
    await check('new chat messages animate once and history opens without replaying them', `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const find = () => [...document.querySelectorAll('.chat-bubble')].find(b => b.textContent === 'Motion fixture question');
      for (let n = 0; n < 100 && !find(); n++) await sleep(8);
      const bubble = find();
      if (!bubble?.getAnimations().some(a => a.animationName === 'message-send')) throw new Error('New message did not animate');
      document.querySelector('.titlebar .chat-chip').click(); await sleep(30);
      document.querySelector('.titlebar .chat-chip').click();
      for (let n = 0; n < 100 && !find(); n++) await sleep(8);
      if (!find() || find().getAnimations().length) throw new Error('History replayed its send animation');
      return 'Fresh bubble animates; reopening history shows it immediately';
    })()`)
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    appendMessage(chatId, { role: 'user', text: 'Reduced motion fixture question', at: new Date().toISOString() })
    win.webContents.send('chat:done', chatId, { stopped: false })
    await check('reduced motion shows fresh messages without animation', `(async () => {
      const find = () => [...document.querySelectorAll('.chat-bubble')].find(b => b.textContent === 'Reduced motion fixture question');
      for (let n = 0; n < 100 && !find(); n++) await new Promise(r => setTimeout(r, 8));
      if (!find() || find().getAnimations().length || document.querySelector('.sidechat').getAnimations().length) throw new Error('Reduced-motion chat still animates');
      return 'Fresh messages and Ask remain static with reduced motion';
    })()`)
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    await check('chat composer has no shadow or overlay above its input', `(async () => {
      document.querySelector('.sidechat-input').focus();
      await new Promise(r => setTimeout(r, 180));
      const box = getComputedStyle(document.querySelector('.sidechat-box'));
      const above = getComputedStyle(document.querySelector('.sidechat-composer'), '::before');
      if (box.boxShadow !== 'none' || above.content !== 'none') throw new Error('Composer still casts a shadow or renders its fade overlay');
      if (box.borderColor !== getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() && box.borderColor !== 'rgb(228, 228, 232)') throw new Error('Composer lost its focus border');
      return 'Focused composer has a border, no shadow and no gradient overlay';
    })()`)
    await check('asynchronously loaded course and lesson screens visibly transition after loading', `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const wait = async selector => {
        for (let n = 0; n < 150; n++) { const el = document.querySelector(selector); if (el) return el; await sleep(8); }
        throw new Error('No ' + selector);
      };
      const verify = async headingSelector => {
        await wait(headingSelector);
        const body = document.querySelector('.app > .body');
        if (!body.getAnimations().some(a => a.playState === 'running')) throw new Error(headingSelector + ' missed its entrance after loading');
        const start = Number(getComputedStyle(body).opacity);
        await sleep(80);
        const during = Number(getComputedStyle(body).opacity);
        if (start >= 0.8 || during <= start || during >= 1) throw new Error('No visible fade: ' + start + ' → ' + during);
        await sleep(450);
        if (getComputedStyle(body).opacity !== '1' || body.getAnimations().length) throw new Error('Entrance did not settle');
        return headingSelector + ': ' + start.toFixed(2) + ' → ' + during.toFixed(2) + ' → 1.00';
      };
      document.querySelector('.titlebar .crumbs a').click(); await wait('.library');
      for (let n = 0; n < 150 && !document.querySelector('.course-card'); n++) await sleep(8);
      [...document.querySelectorAll('.course-card')].find(card => /The OpenCourse example course/.test(card.textContent)).click();
      const course = await verify('.detail h1');
      document.querySelector('.lesson-row:not(.project-row)').click();
      const lesson = await verify('.lesson-head h1');
      return course + '; ' + lesson;
    })()`)
  } finally {
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    if (!attached) cdp.detach()
  }
  return results
}

export async function runSmoke(win: BrowserWindow): Promise<void> {
  // The server journey runs on its own: it needs server/ built, and two users.
  if (process.env['OPENCOURSE_SMOKE_SERVER']) {
    try {
      const { serverSmoke } = await import('./server-smoke')
      const results = await serverSmoke(win)
      const failed = results.filter(result => !result.ok)
      report({ passed: results.length - failed.length, failed: failed.length, results })
      cleanup(); app.exit(failed.length ? 1 : 0)
    } catch (error) { report({ error: String(error) }); cleanup(); app.exit(1) }
    return
  }
  // Suites that bring their own course run on their own too, which is how they
  // are checked on a checkout whose content/ cannot feed the full run.
  // OPENCOURSE_SMOKE_EDITOR_ONLY=1 is the older spelling of ONLY=editor.
  const only = (process.env['OPENCOURSE_SMOKE_ONLY'] ?? (process.env['OPENCOURSE_SMOKE_EDITOR_ONLY'] ? 'editor' : ''))
    .split(',').map((name) => name.trim()).filter(Boolean)
  if (only.length) {
    try {
      const { createUser } = await import('./users')
      createUser('Course author')
      await new Promise<void>(resolve => { win.webContents.once('did-finish-load', () => resolve()); win.reload() })
      await win.webContents.executeJavaScript(`(async () => {
        for (let n = 0; n < 200; n++) {
          const pick = document.querySelector('.user-pick');
          if (pick) { pick.click(); return; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('Test user picker did not load');
      })()`)
      const suites: Record<string, (win: BrowserWindow) => Promise<Result[]>> = { editor: editorSmoke, reading: readingSizeChecks }
      const unknown = only.filter((name) => !suites[name])
      if (unknown.length) throw new Error('no smoke suite called ' + unknown.join(', ') + '; there are ' + Object.keys(suites).join(', '))
      const results: Result[] = []
      for (const name of only) results.push(...(await suites[name]!(win)))
      const failed = results.filter(result => !result.ok)
      report({ passed: results.length - failed.length, failed: failed.length, results })
      cleanup(); app.exit(failed.length ? 1 : 0)
    } catch (error) { report({ error: String(error) }); cleanup(); app.exit(1) }
    return
  }
  // Building a virtualenv and running pytest does not fit in 90s.
  const budgetMs = process.env['OPENCOURSE_SMOKE_PYTHON'] ? 300_000 : 120_000
  const watchdog = setTimeout(async () => {
    const progress = await win.webContents.executeJavaScript('({ step: window.__OPENCOURSE_SMOKE_STEP, results: window.__OPENCOURSE_SMOKE_PROGRESS })').catch(() => null)
    report({ error: `timed out after ${budgetMs / 1000}s`, progress })
    cleanup()
    app.exit(1)
  }, budgetMs)

  try {
    const appearance = await appearanceChecks(win)
    const zips = buildFixtures()
    process.env['OPENCOURSE_SMOKE_ZIPS_DIR'] = join(zips.example, '..')
    await win.webContents.executeJavaScript(
      `window.__OPENCOURSE_SMOKE_PYTHON = ${process.env['OPENCOURSE_SMOKE_PYTHON'] ? 'true' : 'false'};` +
        `window.__OPENCOURSE_SMOKE_CSP = ${JSON.stringify(RENDERER_CSP)};` +
        `window.__OPENCOURSE_SMOKE_ZIPS = ${JSON.stringify(zips)}`
    )
    await win.webContents.executeJavaScript(FIXTURE_API)
    const rendererResults = (await win.webContents.executeJavaScript(SCRIPT)) as Result[]
    // Order matters: the protocol, fullscreen and viz checks inspect the lesson
    // the script leaves on screen, the answer pass moves to the next one, and
    // the coach file pass leaves lessons altogether.
    const beforeNav = [
      ...(await protocolChecks(win)),
      ...(await fullscreenChecks(win)),
      ...(await vizSelectionChecks(win))
    ]
    await seedAnsweredChat()
    const answerResults = (await win.webContents.executeJavaScript(ANSWER_QUOTE_SCRIPT)) as Result[]
    await seedCoachFiles(win)
    const coachFileResults = (await win.webContents.executeJavaScript(COACH_FILES_SCRIPT)) as Result[]
    const results = [
      ...appearance,
      ...rendererResults,
      ...beforeNav,
      ...answerResults,
      ...coachFileResults,
      ...(await coachChecks()),
      // Brings the example course and leaves a lesson at 100%; the theme suite
      // starts from the library whatever it is shown.
      ...(await readingSizeChecks(win)),
      // Themes go on and come off again inside their own suite, which ends in
      // the library on the app's own look - where projectChecks starts anyway,
      // and the suites after that depend on the screen it leaves.
      ...(await themeChecks(win)),
      ...(await projectChecks(win)),
      ...(await motionChecks(win)),
      ...(await subscriptionChecks(win)),
      ...(await editorSmoke(win))
    ]
    clearTimeout(watchdog)
    const failed = results.filter((r) => !r.ok)
    report({ passed: results.length - failed.length, failed: failed.length, results })
    cleanup()
    app.exit(failed.length === 0 ? 0 : 1)
  } catch (err) {
    clearTimeout(watchdog)
    // What the renderer got through before it stopped, as the watchdog reports
    // - otherwise an early abort hides every result behind one error line.
    const progress = await win.webContents.executeJavaScript('({ step: window.__OPENCOURSE_SMOKE_STEP, results: window.__OPENCOURSE_SMOKE_PROGRESS })').catch(() => null)
    report({ error: String(err), progress })
    cleanup()
    app.exit(1)
  }
}
