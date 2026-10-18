import { FIXTURE_API, fixtureCourse, fixtureCoursesDir, fixtureProject } from './fixture-identities'
/**
 * Dev-only: capture the app's own screens to PNGs with `OPENCOURSE_SHOTS=<dir>`.
 * Uses webContents.capturePage, so it needs no screen-recording permission.
 *
 * `OPENCOURSE_SHOTS_HOLD=<target>` stops after that step and leaves the window to a
 * real pointer until it is closed - on the same throwaway profile, with the
 * same courses imported. Some bugs only exist for real input: a click the
 * browser process routes by its own hit test, or one macOS hands to a window
 * drag region before Chromium ever sees it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WHITE_THEME_ID } from '../core/theme/builtin-ids'
import { app, nativeTheme, type BrowserWindow } from 'electron'
import type { ChatCitation, ChatQuote } from '../core/types'
import { simulateAppUpdate } from './updates'

const NAV = `(async (target) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = el => el && (el.tagName === 'STYLE' || el.checkVisibility({ visibilityProperty: true }))
  const all = selector => [...document.querySelectorAll(selector)].filter(visible)
  const find = selector => all(selector)[0]
  const waitFor = async (selector, timeout = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const el = find(selector)
      if (el) return el
      await sleep(50)
    }
    throw new Error('timed out waiting for ' + selector)
  }
  const click = (el) => { if (!el) throw new Error('nothing to click'); el.click() }

  if (target === 'users') {
    await waitFor('.users')
    await sleep(300)
  } else if (target === 'create-user') {
    const input = await waitFor('.user-card.new input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Sam')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    click([...all('.user-card.new button')].find((b) => b.textContent.trim() === 'Create'))
    await waitFor('.library')
  } else if (target === 'import') {
    const result = await window.fixtureAPI.importCoursePath(window.__OPENCOURSE_SHOTS_ZIP)
    if (result.status !== 'ok') throw new Error('import said ' + JSON.stringify(result))
    await waitFor('.course-card')
  } else if (target === 'coach-empty') {
    click(find('.titlebar [data-section="coach"]'))
    await waitFor('.coach .empty-library')
    await sleep(250)
  } else if (target === 'coach-new') {
    click([...all('.coach .actions button')].find((b) => /New coach/i.test(b.textContent)))
    const input = await waitFor('.coach-card.new input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'French vocabulary')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(250)
  } else if (target === 'coach-project') {
    click([...all('.coach-card.new button')].find((b) => b.textContent.trim() === 'Create'))
    const fold = await waitFor('.coach-brief')
    fold.open = true
    await waitFor('.coach-brief-text')
    await sleep(300)
  } else if (target === 'coach-files') {
    await waitFor('.file-row')
    await waitFor('.session-row')
    find('.coach-brief').open = false
    find('.content.scroll').scrollTop = 0
    await sleep(300)
  } else if (target === 'coach-brief-edit') {
    click([...all('.coach-brief button')].find(b => b.textContent.trim() === 'Edit'))
    await waitFor('.coach-brief textarea')
    find('.coach-brief').scrollIntoView({ block: 'start' })
    await sleep(250)
  } else if (target === 'coach-brief-cancel') {
    click([...all('.coach-brief button')].find(b => b.textContent.trim() === 'Cancel'))
    await waitFor('.coach-brief-text')
  } else if (target === 'coach-transcript') {
    click(find('.session-row .session-open'))
    await waitFor('.transcript .turn')
    await sleep(300)
  } else if (target === 'back-to-coach') {
    click(find('.titlebar .crumbs a'))
    await waitFor('.coach-live')
    await sleep(200)
  } else if (target === 'coach-file-open') {
    const row = [...all('.file-row')]
      .find((r) => r.querySelector('.file-name').textContent.includes('learned.md'))
    click(row.querySelector('.file-name'))
    await waitFor('.coach-panel .prose h1')
    await sleep(300)
  } else if (target === 'coach-list') {
    const close = find('.coach-panel-head button')
    if (close) { close.click(); await sleep(200) }
    click(find('.titlebar .crumbs a'))
    await waitFor('.coach-card')
    await sleep(250)
  } else if (target === 'documents-reader') {
    click(find('.titlebar [data-section="documents"]'))
    click(await waitFor('.document-card-open'))
    await waitFor('.pdf-page canvas[data-rendered="true"]')
    await waitFor('.document-reader .chat-turn.assistant')
    await document.fonts.ready
    await sleep(300)
  } else if (target === 'author-ai') {
    click(find('.titlebar [data-section="courses"]'))
    await waitFor('.project-body')
    click(find('.titlebar .crumbs a'))
    await waitFor('.library')
    click([...all('.course-card')].find(card => /The OpenCourse example course/.test(card.textContent)))
    await waitFor('.detail')
    click([...all('.detail button')].find(button => button.textContent.trim() === 'Edit course'))
    await waitFor('.author-mode')
    click([...all('.author-mode button')].find(button => button.textContent.trim() === 'AI'))
    await waitFor('.author-chat-column .chat-turn.assistant')
    const course = await window.fixtureAPI.getCourse('opencourse-example')
    click([...all('.outline-row')].find(row => row.getAttribute('aria-label') === course.modules[0].lessons[0].title))
    await waitFor('.author-preview .lesson-head')
    await document.fonts.ready
    await sleep(300)
  } else if (target === 'author-back') {
    click(find('.titlebar .crumbs a'))
    await waitFor('.library')
  } else if (target === 'user-menu') {
    click(find('.titlebar .user-chip'))
    await waitFor('.menu-panel')
    await sleep(250)
  } else if (target === 'settings') {
    const item = [...all('.menu-panel .menu-item')]
      .find((b) => /Settings/.test(b.textContent))
    click(item)
    await waitFor('.settings')
    await sleep(300)
  } else if (target === 'logs' || target === 'theme-logs') {
    // The log, from the user menu, with the newest error opened if there is one.
    click(find('.titlebar .user-chip'))
    await waitFor('.menu-panel .menu-item')
    click([...all('.menu-panel .menu-item')].find((b) => /^Logs$/.test(b.textContent.trim())))
    await waitFor('.logs-row')
    click(find('.logs-row.level-error') ?? find('.logs-row'))
    await waitFor('.logs-detail')
    await sleep(300)
  } else if (target === 'logs-to-settings') {
    click(find('.titlebar .user-chip'))
    await waitFor('.menu-panel .menu-item')
    click([...all('.menu-panel .menu-item')].find((b) => /Settings/.test(b.textContent)))
    await waitFor('.settings')
    await sleep(300)
  } else if (target === 'theme-logs-back') {
    click(find('.titlebar .crumbs a'))
    await waitFor('.lesson-head h1')
    await sleep(300)
  } else if (target === 'settings-models') {
    click(await waitFor('[data-settings-category="ai"]'))
    await waitFor('.settings-models-unselect-all')
    click(find('.settings-models-unselect-all'))
    await sleep(250)
  } else if (target === 'white-apply') {
    click(await waitFor('[data-settings-category="appearance"]'))
    await waitFor('.settings-appearance')
    await window.opencourse.applyTheme(${JSON.stringify(WHITE_THEME_ID)})
    await waitFor('#opencourse-theme')
    find('.settings-appearance').scrollIntoView({ block: 'start' })
    await sleep(500)
  } else if (target === 'theme-apply') {
    click(await waitFor('[data-settings-category="appearance"]'))
    await waitFor('.settings-appearance')
    // The example theme, imported the way Settings does it and applied.
    const result = await window.opencourse.importThemePath(window.__OPENCOURSE_SHOTS_THEME)
    if (result.status !== 'ok') throw new Error('theme import failed: ' + JSON.stringify(result))
    await window.opencourse.applyTheme(result.theme.id)
    await waitFor('#opencourse-theme')
    await document.fonts.ready
    find('.settings-appearance').scrollIntoView({ block: 'start' })
    await sleep(500)
  } else if (target === 'theme-library' || target === 'white-library') {
    click(find('.titlebar .crumbs a'))
    await sleep(200)
    click(find('.titlebar [data-section="courses"]'))
    await sleep(200)
    for (let i = 0; i < 4 && !find('.library'); i++) {
      click(find('.workbench-back') ?? find('.titlebar .crumbs a'))
      await sleep(300)
    }
    await waitFor('.course-card')
    await sleep(500)
  } else if (target === 'theme-lesson' || target === 'white-lesson') {
    click([...all('.course-card')].find((c) => /Python asyncio/.test(c.textContent)))
    await waitFor('.detail')
    click([...all('.lesson-row')].find((r) => /await, create_task/.test(r.textContent)))
    await waitFor('.lesson-head h1')
    await sleep(600)
  } else if (target === 'theme-workbench' || target === 'white-workbench') {
    click([...all('.exercise .actions button')].find((b) => /open editor|editor open/i.test(b.textContent)))
    await waitFor('.workbench .cm-content')
    await sleep(1200)
  } else if (target === 'theme-off' || target === 'white-off') {
    // Back to the app's own look, and to a screen with the user chip, for the picker shot.
    await window.opencourse.applyTheme(null)
    const back = find('.workbench-back')
    if (back) click(back)
    await sleep(300)
  } else if (target === 'users-switch') {
    // Straight to the picker: the menu that would open it is gone from the
    // titlebar once nobody is selected.
    click(find('.titlebar .user-chip'))
    const item = await waitFor('.menu-panel .menu-item')
    click([...all('.menu-panel .menu-item')]
      .find((b) => /Switch user/.test(b.textContent)) ?? item)
    await waitFor('.user-card.add')
    await sleep(300)
  } else if (target === 'library-empty') {
    await waitFor('.empty-library')
    await sleep(200)
  } else if (target === 'library') {
    await waitFor('.course-card')
  } else if (target === 'course') {
    click(find('.course-card'))
    await waitFor('.detail h1')
  } else if (target === 'lesson') {
    click(find('.lesson-row'))
    await waitFor('.lesson-head h1')
  } else if (target === 'reading-larger') {
    // Two presses of A+, so the shot shows the lesson at 125%.
    find('.content').scrollTop = 0
    click(await waitFor('.reading-size-larger'))
    await sleep(100)
    click(find('.reading-size-larger'))
    await sleep(300)
  } else if (target === 'reading-type') {
    // The size being typed: press it, and the field takes the keys.
    click(await waitFor('.reading-size-value'))
    const typing = await waitFor('.reading-size-field')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(typing, '130')
    typing.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
  } else if (target === 'reading-reset') {
    // Typed, the way a reader sets an exact size.
    if (!find('.reading-size-field')) click(await waitFor('.reading-size-value'))
    const field = await waitFor('.reading-size-field')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '100')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(200)
  } else if (target === 'update-available') {
    // Main has set the status; the button shows its menu.
    click(await waitFor('.titlebar .update-chip'))
    await waitFor('.update-menu')
    await sleep(200)
  } else if (target === 'update-settings') {
    click([...all('.update-menu .menu-item')].find((b) => /Update settings/.test(b.textContent)))
    await waitFor('.settings-updates')
    await sleep(300)
  } else if (target === 'update-clear') {
    click(find('.titlebar .crumbs a'))
    await waitFor('.lesson-head h1')
  } else if (target === 'sidechat-connection') {
    // This chat's connection, chosen from the composer. The reasoning list is
    // still open from the step before; its own trigger closes it.
    if (find('.menu-panel')) click(find('.sidechat-reasoning'))
    await sleep(150)
    click(await waitFor('.sidechat-connection'))
    await waitFor('.connection-menu')
    await sleep(250)
  } else if (target === 'sidechat-connection-close') {
    click(find('.sidechat-connection'))
    await sleep(150)
  } else if (target === 'viz') {
    find('.viz-frame').scrollIntoView({ block: 'center' })
    await sleep(1500)
  } else if (target === 'sidechat') {
    // Through the affordance a person would use: highlight, then accept the
    // offer. It exercises the selection path and dresses the shot in one go.
    const prose = find('.content-inner .prose p')
    prose.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.selectNodeContents(prose)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    click(await waitFor('.ask-about'))
    await waitFor('.sidechat-quote blockquote')
    await sleep(300)
    // React owns the value, so poke the native setter it listens behind.
    const field = find('.sidechat-composer textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    // Long enough to wrap, so the shot shows the box grown past one line.
    setter.call(field, 'Why is it a loop rather than threads? And what are the other tasks doing while one of them waits on the network?')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(500)
  } else if (target === 'sidechat-ask-answer') {
    // The other kind of passage: part of an answer. The lesson's quote and the
    // draft go first, so the shot is of this one alone.
    const dismiss = find('.sidechat-quote-head button')
    if (dismiss) click(dismiss)
    const field = find('.sidechat-composer textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(field, '')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    const phrase = 'only the blocking call is handed to a worker'
    const paragraph = [...all('.chat-answer[data-ask="answer"] .prose p')]
      .find((p) => p.textContent.includes(phrase))
    if (!paragraph) throw new Error('no seeded answer says: ' + phrase)
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.textContent.includes(phrase)) node = walker.nextNode()
    if (!node) throw new Error('the seeded answer no longer says: ' + phrase)
    const start = node.textContent.indexOf(phrase)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + phrase.length)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await waitFor('.ask-about')
    await sleep(250)
  } else if (target === 'sidechat-answer-quote') {
    click(find('.ask-about'))
    await waitFor('.sidechat-quote blockquote')
    const field = find('.sidechat-composer textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(field, 'So the loop never waits, but the worker does?')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(400)
  } else if (target === 'sidechat-model') {
    click(find('.sidechat-model'))
    await waitFor('.menu-panel')
    await sleep(250)
  } else if (target === 'sidechat-reasoning') {
    // The model's list is still open, and a scripted click is no mousedown to
    // dismiss it; its own trigger closes it.
    click(find('.sidechat-model'))
    await sleep(150)
    click(find('.sidechat-reasoning'))
    await waitFor('.menu-panel')
    await sleep(250)
  } else if (target === 'sidechat-close') {
    click(find('.sidechat-close'))
    await sleep(300)
  } else if (target === 'quiz') {
    const quiz = find('.quiz')
    quiz.scrollIntoView({ block: 'center' })
    quiz.querySelector('input[type=radio]').click()
    click([...quiz.querySelectorAll('button')].find((b) => /check/i.test(b.textContent)))
    await waitFor('.quiz .feedback')
    await sleep(300)
  } else if (target === 'exercise') {
    // third lesson has the first exercise
    click([...all('.sidebar a')].find((a) => /await, create_task/i.test(a.textContent)))
    await waitFor('.exercise')
    find('.exercise').scrollIntoView({ block: 'start' })
    await sleep(600)
  } else if (target === 'workbench') {
    const open = [...all('.exercise .actions button')].find((b) => /open editor/i.test(b.textContent))
    click(open)
    await waitFor('.workbench .cm-content')
    await sleep(1200)
  } else if (target === 'workbench-terminal') {
    click([...all('.workbench-tabs button')].find((b) => /terminal/i.test(b.textContent)))
    await sleep(2500)
  } else if (target === 'workbench-pass') {
    // Put the reference solution on disk, reopen the editor so it reads it
    // back, then run for real - this is the green path a learner reaches.
    const solution = await window.fixtureAPI.getSolution('python-asyncio', 'ex-tasks-1')
    const t = { courseId: 'python-asyncio', moduleId: 'coroutines-and-tasks', lessonId: 'await-and-tasks', blockId: 'ex-tasks-1' }
    await window.fixtureAPI.writeExerciseFile(t, solution, null)
    click(find('.workbench-back'))
    await sleep(300)
    click([...all('.exercise .actions button')].find((b) => /open editor/i.test(b.textContent)))
    await waitFor('.workbench .cm-content')
    await sleep(500)
    const runBtn = [...all('.workbench-actions button')].find((b) => /run checks/i.test(b.textContent))
    click(runBtn)
    await sleep(300)
    const t0 = Date.now()
    while (Date.now() - t0 < 180000) {
      const btn = [...all('.workbench-actions button')][0]
      if (btn && !/Running/i.test(btn.textContent)) break
      await sleep(300)
    }
    await sleep(600)
  } else if (target === 'workbench-run') {
    click([...all('.workbench-tabs button')].find((b) => /checks/i.test(b.textContent)))
    click([...all('.workbench-actions button')].find((b) => /run checks/i.test(b.textContent)))
    await sleep(300)
    // First run in a throwaway profile builds the venv, so give it room. Wait
    // on the button, not the status text: a reopened workbench already shows
    // the previous verdict.
    const t0 = Date.now()
    while (Date.now() - t0 < 180000) {
      const btn = [...all('.workbench-actions button')][0]
      if (btn && !/Running/i.test(btn.textContent)) break
      await sleep(300)
    }
    await sleep(500)
  } else if (target === 'to-library') {
    const close = find('.workbench-back')
    if (close) { close.click(); await sleep(300) }
    // Walk back up the breadcrumbs until the library is showing.
    for (let i = 0; i < 4 && !find('.library'); i++) {
      const crumb = find('.titlebar a')
      if (!crumb) break
      crumb.click()
      await sleep(400)
    }
    await waitFor('.library')
  } else if (target === 'import-python') {
    const result = await window.fixtureAPI.importCoursePath(window.__OPENCOURSE_SHOTS_ZIP_PYTHON)
    if (result.status !== 'ok') throw new Error('import said ' + JSON.stringify(result))
    await sleep(300)
  } else if (target === 'python-course') {
    const card = [...all('.course-card')].find((c) => /Introduction to Python/i.test(c.textContent))
    click(card)
    await waitFor('.detail h1')
    await sleep(300)
  } else if (target === 'python-viz') {
    const course = await window.opencourse.getAuthoringCourse(await window.fixtureCourseId('intro-to-python'))
    const id = course.document.manifest.modules.find(module => module.slug === 'arrays-strings-pointers').lessons.find(lesson => lesson.slug === 'pointers').nodeId
    const row = find('.lesson-row[data-lesson-id="' + id + '"]')
    click(row)
    await waitFor('.lesson-head h1')
    await waitFor('.viz-frame')
    find('.viz-frame').scrollIntoView({ block: 'center' })
    await sleep(1800)
  } else if (target === 'python-workbench-pass') {
    const t = { courseId: 'intro-to-python', moduleId: 'arrays-strings-pointers', lessonId: 'pointers', blockId: 'ex-swap-1' }
    const solution = await window.fixtureAPI.getSolution('intro-to-python', 'ex-swap-1')
    if (!solution) throw new Error('no reference solution for ex-swap-1')
    await window.fixtureAPI.writeExerciseFile(t, solution, null)
    const exercise = await waitFor('.exercise')
    exercise.scrollIntoView({ block: 'start' })
    await sleep(300)
    click([...all('.exercise .actions button')].find((b) => /open editor/i.test(b.textContent)))
    await waitFor('.workbench .cm-content')
    await sleep(500)
    click([...all('.workbench-actions button')].find((b) => /run checks/i.test(b.textContent)))
    await sleep(300)
    // A fresh Python environment may need to install test requirements.
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      const btn = [...all('.workbench-actions button')][0]
      if (btn && !/Running/i.test(btn.textContent)) break
      await sleep(200)
    }
    await sleep(700)
  } else if (target === 'import-project-course') {
    click(find('.titlebar [data-section="courses"]'));
    await waitFor('.library');
    const result = await window.fixtureAPI.importCoursePath(window.__OPENCOURSE_SHOTS_ZIP_PROJECT);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    await sleep(200);
  } else if (target === 'project') {
    click([...all('.course-card')].find(card => /The OpenCourse example course/.test(card.textContent)));
    await waitFor('.project-row'); click(find('.project-row'));
    await waitFor('.project-directory'); await waitFor('.sidechat .chat-turn.assistant');
    await sleep(400);
  } else if (target === 'project-editor') {
    const picker = find('.project-editor-picker');
    if (picker) { picker.scrollIntoView({ block: 'center' }); await sleep(200); click(picker); await waitFor('.menu-panel'); }
    await sleep(200);
  } else if (target === 'project-narrow') {
    if (find('.menu-panel')) click(find('.project-editor-picker'));
    await sleep(400);
  } else if (target === 'search') {
    await sleep(200)
  }
  return document.title
})(${JSON.stringify('%TARGET%')})`

/** The app ships no courses, so a screenshot run brings its own - two Python courses. */
function buildArchives(): { zips: Record<string, string>; drop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'opencourse-shots-zips-'))
  const zips: Record<string, string> = {}
  for (const slug of ['python-asyncio', 'intro-to-python']) {
    const zip = join(dir, `${slug}.zip`)
    execFileSync('ditto', [
      '-c', '-k', '--norsrc', '--noextattr',
      join(fixtureCoursesDir(), slug),
      zip
    ])
    zips[slug] = zip
  }
  return { zips, drop: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Stands in for a session's tool calls, which need a key and a conversation. */
async function seedCoachWorkspace(win: BrowserWindow): Promise<void> {
  const { listProjects } = await import('./coach')
  const { writeWorkspaceFile } = await import('./coachfiles')
  const project = listProjects()[0]
  if (!project) throw new Error('no coach project to seed')
  writeWorkspaceFile(
    project.id,
    'context.md',
    '# French vocabulary\n\nSam wants conversational French for a trip in March.\nSessions are going well; verbs are the weak spot.\n'
  )
  writeWorkspaceFile(
    project.id,
    'learned.md',
    '# Mots appris\n\n- le chien - dog\n- le chat - cat\n- la maison - house\n- le livre - book\n'
  )
  writeWorkspaceFile(project.id, 'review.md', '# A reviser\n\n- etre (irregular)\n- avoir (irregular)\n')
  writeWorkspaceFile(project.id, 'weeks/week-01.md', '# Week 1\n\nGreetings and numbers.\n')
  // A finished session, so the list and the transcript have something to show.
  const { insertSession, finishSession, saveTurns } = await import('./coachdb')
  const { newSessionId } = await import('../core/coach/ids')
  const sessionId = newSessionId()
  insertSession({
    id: sessionId,
    projectId: project.id,
    startedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
    model: 'gpt-live-1',
    instructions: 'You are a French vocabulary coach. Sam is preparing for a trip in March.'
  })
  saveTurns(
    sessionId,
    [
      ['user', 'bonjour ! je veux apprendre des mots pour voyager'],
      ['assistant', 'tres bien. commencons par les animaux - comment dit-on "dog" ?'],
      ['user', 'euh... le chien ?'],
      ['assistant', 'exactement, le chien. et "cat" ?'],
      ['user', 'le chat'],
      ['assistant', 'parfait. je les note tous les deux.']
    ].map(([role, text], seq) => ({
      seq,
      role: role as 'user' | 'assistant',
      text,
      at: new Date(Date.now() - (14 - seq) * 60_000).toISOString()
    }))
  )
  finishSession(sessionId, 'ended')

  win.webContents.send('coach:filesChanged', project.id)
  win.webContents.send('coach:changed')
}

/**
 * A side chat already under way, so its shot shows both voices and what tells
 * them apart - a run has no key, so nothing could ever be said in it otherwise.
 * Written through the same rows `chat.ts` writes, context row included.
 */
async function seedSideChat(): Promise<void> {
  const { insertChat, appendMessage } = await import('./chatdb')
  const { newChatId } = await import('../core/sidechat/ids')
  const { DEFAULT_CHAT_MODEL } = await import('../core/sidechat/models')
  const { lessonContextText } = await import('../core/sidechat/context')
  const course = fixtureCourse('python-asyncio')
  const module = course?.modules[0]
  const first = module?.lessons?.[0]
  if (!course || !module || !first) throw new Error('no lesson to seed a side chat in')
  const lesson = { moduleId: module.slug, lessonId: first.slug }
  const id = newChatId()
  const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  insertChat({ id, courseId: course.courseId, model: DEFAULT_CHAT_MODEL, startedIn: lesson, at: at(9) })
  const said: [role: 'context' | 'user' | 'assistant', text: string, quote?: ChatQuote][] = [
    ['context', lessonContextText(course.title, module.title, first, course.subject)],
    ['user', "What's the difference between a coroutine and a regular function?"],
    [
      'assistant',
      'Calling a regular function **runs** it. Calling a coroutine function only **creates** a coroutine ' +
        'object - nothing runs until something awaits it or the event loop schedules it as a task.\n\n' +
        '```python\nasync def fetch():\n    return 42\n\ncoro = fetch()    # nothing has run yet\nawait coro        # now it runs\n```\n\n' +
        'That is what lets the loop pause one at an `await` and get on with another.'
    ],
    [
      'user',
      'So that is why one blocking call stalls everything?',
      { text: 'Threads are not free — each one costs a stack (around 8 MB by default on Linux)', from: 'lesson' }
    ],
    [
      'assistant',
      'Exactly. There is one thread, and the loop only gets it back at an `await`. A call like ' +
        '`time.sleep(1)` never yields, so every other task waits the full second with it. ' +
        'Use `await asyncio.sleep(1)` instead, and push genuinely blocking work to `asyncio.to_thread`.'
    ],
    [
      'user',
      'Is that not just threads again?',
      { text: 'push genuinely blocking work to asyncio.to_thread', from: 'answer' }
    ],
    [
      'assistant',
      'For that one call, yes - and that is the point. The loop stays on its one thread; only the ' +
        'blocking call is handed to a worker, and `await` gives you its result back as if it were async.'
    ],
    ['user', 'Which Python version added asyncio.to_thread?']
  ]
  said.forEach(([role, text, quote], i) =>
    appendMessage(id, { role, text, ...(quote ? { quote } : {}), lesson, at: at(8 - i) })
  )
  // And one that used the web, so the shot shows its sources: written the way
  // OpenAI cites, an inline link per claim, with the span of each recorded.
  const { text, citations } = citedAnswer([
    'It arrived in **Python 3.9**',
    ['https://docs.python.org/3/whatsnew/3.9.html?utm_source=openai', 'What’s New In Python 3.9 — Python 3.13.1 documentation'],
    ', as a simpler way to call `loop.run_in_executor` with the default thread pool',
    ['https://docs.python.org/3/library/asyncio-task.html?utm_source=openai', 'Coroutines and Tasks — Python 3.13.1 documentation'],
    '.'
  ])
  appendMessage(id, { role: 'assistant', text, citations, lesson, at: at(0) })
}

/**
 * An answer's text and its citations from prose and [url, title] pairs, each
 * pair written into the text as the inline link the model writes, and its
 * span recorded the way OpenAI reports it.
 */
function citedAnswer(parts: (string | [url: string, title: string])[]): { text: string; citations: ChatCitation[] } {
  let text = ''
  const citations: ChatCitation[] = []
  for (const part of parts) {
    if (typeof part === 'string') {
      text += part
      continue
    }
    const [url, title] = part
    const link = ` ([${new URL(url).hostname}](${url}))`
    citations.push({ url, title, start: text.length + 1, end: text.length + link.length })
    text += link
  }
  return { text, citations }
}

/** Synthetic feedback fixture: screenshot runs never call the API. */
async function seedProjectChat(): Promise<void> {
  const { createProjectChat } = await import('./projectchat')
  const { appendProjectMessage } = await import('./projectchatdb')
  const { requireCourseProject } = await import('./courseprojects')
  const target = fixtureProject('opencourse-example', 'build-a-course-project')
  const chat = createProjectChat(target)
  const { context, fingerprint } = requireCourseProject(target)
  const at = new Date().toISOString()
  appendProjectMessage(chat.id, { role: 'context', text: context, project: { moduleId: target.moduleId, fingerprint }, at })
  appendProjectMessage(chat.id, { role: 'user', text: 'What should I focus on when planning the lesson sequence?', at })
  appendProjectMessage(chat.id, { role: 'assistant', text: 'Start with the **learning objectives**, then put the lessons in an order that lets learners practice each one.\n\nFor your outline:\n\n1. Introduce the core idea and give a small example.\n2. Let learners apply it with guidance.\n3. Finish with an independent activity that combines the skills.\n\nIn `README.md`, explain why the sequence fits your audience and prerequisites. When your files are ready, request a review against the deliverables.', status: 'complete', at })
}

export async function runShots(win: BrowserWindow): Promise<void> {
  const dir = process.env['OPENCOURSE_SHOTS'] as string
  mkdirSync(dir, { recursive: true })

  await win.webContents.executeJavaScript(FIXTURE_API)

  // `photo: false` steps are the ones a person would do but nobody wants a
  // picture of - typing a name, picking a file.
  const steps: { target: string; photo: boolean }[] = [
    { target: 'users', photo: true },
    { target: 'create-user', photo: false },
    { target: 'library-empty', photo: true },
    { target: 'import', photo: false },
    ...['library', 'course', 'lesson'].map((target) => ({ target, photo: true })),
    // The reader's text size, and an update of the app waiting in the titlebar.
    { target: 'reading-larger', photo: true },
    { target: 'reading-type', photo: true },
    { target: 'reading-reset', photo: false },
    { target: 'update-available', photo: true },
    { target: 'update-settings', photo: true },
    { target: 'update-clear', photo: false },
    { target: 'sidechat', photo: true },
    { target: 'sidechat-ask-answer', photo: true },
    { target: 'sidechat-answer-quote', photo: true },
    { target: 'sidechat-model', photo: true },
    { target: 'sidechat-reasoning', photo: true },
    { target: 'sidechat-connection', photo: true },
    { target: 'sidechat-connection-close', photo: false },
    { target: 'sidechat-close', photo: false },
    ...['viz', 'quiz', 'exercise', 'workbench', 'workbench-terminal', 'workbench-run', 'workbench-pass'].map(
      (target) => ({ target, photo: true })
    ),
    // A second Python fixture, through the same screens.
    { target: 'to-library', photo: false },
    { target: 'import-python', photo: false },
    { target: 'python-course', photo: true },
    { target: 'python-viz', photo: true },
    { target: 'python-workbench-pass', photo: true },
    { target: 'to-library', photo: false },
    { target: 'import-project-course', photo: false },
    { target: 'project', photo: true },
    { target: 'project-editor', photo: true },
    { target: 'project-narrow', photo: true },
    { target: 'documents-reader', photo: true },
    { target: 'author-ai', photo: true },
    { target: 'author-back', photo: false },
    // Coach.
    { target: 'coach-empty', photo: true },
    { target: 'coach-new', photo: true },
    { target: 'coach-project', photo: true },
    { target: 'coach-brief-edit', photo: true },
    { target: 'coach-brief-cancel', photo: false },
    { target: 'coach-files', photo: true },
    { target: 'coach-file-open', photo: true },
    { target: 'coach-transcript', photo: true },
    { target: 'back-to-coach', photo: false },
    { target: 'coach-list', photo: true },
    // Settings before the picker: once nobody is selected the titlebar renders
    // bare, and there is no chip left to open the menu from.
    { target: 'user-menu', photo: true },
    { target: 'settings', photo: true },
    { target: 'settings-models', photo: true },
    { target: 'logs', photo: true },
    // Theme Settings is on the settings page, so go back there for it.
    { target: 'logs-to-settings', photo: false },
    // Built-in White over settings, the library, a lesson and the live editor.
    ...['white-apply', 'white-library', 'white-lesson', 'white-workbench'].map((target) => ({ target, photo: true })),
    { target: 'white-off', photo: false },
    { target: 'logs-to-settings', photo: false },
    // The example theme over the same screens, so a theme regression is as
    // visible here as one in the app's own look.
    { target: 'theme-apply', photo: true },
    { target: 'theme-library', photo: true },
    { target: 'theme-lesson', photo: true },
    { target: 'theme-logs', photo: true },
    { target: 'theme-logs-back', photo: false },
    { target: 'theme-workbench', photo: true },
    { target: 'theme-off', photo: false },
    { target: 'users-switch', photo: true }
  ]

  // A focused path for visual QA that does not depend on other course runtimes.
  const whiteSteps = [
    { target: 'users', photo: true }, { target: 'create-user', photo: false },
    { target: 'import', photo: false }, { target: 'library', photo: true },
    { target: 'user-menu', photo: false }, { target: 'settings', photo: true },
    ...['white-apply', 'white-library', 'white-lesson', 'white-workbench'].map((target) => ({ target, photo: true })),
    { target: 'white-off', photo: false }
  ]
  const coachSteps = steps.filter(step => ['users', 'create-user'].includes(step.target) || step.target.startsWith('coach-') || step.target === 'back-to-coach')
  const selectedSteps = process.env['OPENCOURSE_SHOTS_ONLY'] === 'white' ? whiteSteps
    : process.env['OPENCOURSE_SHOTS_ONLY'] === 'coach' ? coachSteps : steps

  const { zips, drop } = buildArchives()
  const tidy = (): void => {
    drop()
    rmSync(process.env['OPENCOURSE_RUN_PROFILE'] ?? '', { recursive: true, force: true })
  }

  try {
    await win.webContents.executeJavaScript(
      `window.__OPENCOURSE_SHOTS_ZIP = ${JSON.stringify(zips['python-asyncio'])};` +
      `window.__OPENCOURSE_SHOTS_ZIP_PYTHON = ${JSON.stringify(zips['intro-to-python'])};` +
      `window.__OPENCOURSE_SHOTS_ZIP_PROJECT = ${JSON.stringify(join(app.getAppPath(), 'resources', 'spec', 'opencourse-example-course.zip'))};` +
      `window.__OPENCOURSE_SHOTS_THEME = ${JSON.stringify(join(app.getAppPath(), 'resources', 'spec', 'opencourse-example-theme.zip'))};`
    )
    const hold = process.env['OPENCOURSE_SHOTS_HOLD']
    let defaultMark: string | null = null
    let n = 0
    for (const { target, photo } of selectedSteps) {
      // What a tool call will write once there is a live session to make one.
      if (target === 'coach-files') await seedCoachWorkspace(win)
      if (target === 'sidechat') await seedSideChat()
      if (target === 'project') await seedProjectChat()
      if (target === 'documents-reader') { win.setSize(1440, 960); await seedDocumentChat() }
      if (target === 'author-ai') { win.setSize(1440, 960); await seedAuthoringChat() }
      if (target === 'project-narrow') win.setSize(720, 860)
      if (target === 'update-available') simulateAppUpdate({ state: 'available', version: '0.2.0', size: 138_000_000, notesUrl: 'https://github.com/s3298321/opencourse/releases/tag/v0.2.0', installable: true })
      if (target === 'coach-empty') win.setSize(1240, 860)
      try { await win.webContents.executeJavaScript(NAV.replace('%TARGET%', target)) }
      catch (error) { throw new Error(`Screenshot step ${target}: ${String(error)}`) }
      if (process.env['OPENCOURSE_SHOTS_ONLY'] === 'white' && target === 'library') {
        defaultMark = await win.webContents.executeJavaScript("document.querySelector('.titlebar .brand img').src")
      }
      if (target === 'update-clear') simulateAppUpdate(null)
      if (target === hold) {
        console.log(`holding at ${target}: the window is yours until you close it`)
        await new Promise<void>((resolve) => win.once('closed', () => resolve()))
        break
      }
      if (!photo) continue
      n += 1
      const published: Record<string, string> = { 'sidechat-ask-answer': '07-sidechat-ask-answer', viz: '11-viz', quiz: '12-quiz', 'workbench-pass': '17-workbench-pass', 'documents-reader': 'documents-reader', 'coach-files': 'coach-workspace', 'author-ai': 'course-editor-ai' }
      await win.webContents.executeJavaScript('document.fonts.ready')
      win.webContents.invalidate()
      await new Promise(resolve => setTimeout(resolve, 150))
      const file = join(dir, `${published[target] ?? `${String(n).padStart(2, '0')}-${target}`}.png`)
      writeFileSync(file, (await win.webContents.capturePage()).toPNG())
      console.log('wrote', file)
      if (process.env['OPENCOURSE_SHOTS_ONLY'] === 'white' && target === 'white-workbench') {
        await win.webContents.executeJavaScript(`(async () => {
          const editor = document.querySelector('.cm-editor');
          const terminal = document.querySelector('.xterm');
          const text = editor.querySelector('.cm-content').textContent;
          const wait = async (color) => {
            for (let n = 0; n < 200; n++) {
              if (getComputedStyle(editor).backgroundColor === color) return;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new Error('Editor did not switch to ' + color);
          };
          await window.opencourse.applyTheme(null);
          await wait('rgb(29, 29, 33)');
          await window.opencourse.applyTheme(${JSON.stringify(WHITE_THEME_ID)});
          await wait('rgb(247, 247, 249)');
          if (!editor.isConnected || !terminal.isConnected || editor.querySelector('.cm-content').textContent !== text)
            throw new Error('Switching White changed editor or terminal state');
        })()`)
        if (nativeTheme.themeSource !== 'light') throw new Error('White did not set native light appearance')
        await new Promise<void>((resolve) => { win.webContents.once('did-finish-load', () => resolve()); win.reload() })
        await win.webContents.executeJavaScript(`(async () => {
          for (let n = 0; n < 200 && !document.querySelector('.library'); n++)
            await new Promise(resolve => setTimeout(resolve, 25));
          if (document.documentElement.dataset.appearance !== 'light' || getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() !== '#ffffff')
            throw new Error('White did not survive reload');
          if (document.querySelector('.titlebar .brand img')?.src !== ${JSON.stringify(defaultMark)})
            throw new Error('White changed the logo');
        })()`)
        console.log('White verified: native appearance, persistent preference, unchanged logo, live editor and terminal')
      }
    }
    tidy()
    app.exit(0)
  } catch (err) {
    console.error('shots failed:', err)
    tidy()
    app.exit(1)
  }
}

/** Fixtures stay within the disposable shots profile and never call AI. */
async function seedDocumentChat(): Promise<void> {
  const { fixturePdf } = await import('../../tests/helpers/pdf')
  const { importDocument, getDocument } = await import('./documents')
  const { createDocumentChat } = await import('./document-chat')
  const { appendDocumentMessage } = await import('./document-chatdb')
  const root = mkdtempSync(join(tmpdir(), 'opencourse-shots-pdf-'))
  try {
    const path = join(root, 'Local reading.pdf')
    writeFileSync(path, fixturePdf({ pages: 4 }))
    const result = await importDocument(path)
    if (result.status !== 'ok') throw new Error('Screenshot PDF did not import')
    for (let n = 0; n < 400 && getDocument(result.document.id).status === 'indexing'; n++) await new Promise(resolve => setTimeout(resolve, 25))
    if (getDocument(result.document.id).status !== 'ready') throw new Error('Screenshot PDF did not finish indexing')
    const chat = createDocumentChat(result.document.id, 1), at = new Date().toISOString()
    appendDocumentMessage(chat.id, { role: 'user', text: 'How does Ask use this document?', at })
    appendDocumentMessage(chat.id, { role: 'assistant', text: 'The PDF stays in your local library. When you ask a question, **Ask retrieves relevant passages** and sends them to your selected AI connection.\n\nYou can highlight text to attach a passage, search the document, or navigate using its headings.', status: 'complete', at })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
async function seedAuthoringChat(): Promise<void> {
  const { createAuthoringChat } = await import('./authoring-chat')
  const { appendAuthoringMessage } = await import('./authoring-chatdb')
  const { getAuthoringCourse } = await import('./course-authoring')
  const course = fixtureCourse('opencourse-example')
  if (!course) throw new Error('No example course for editor screenshot')
  getAuthoringCourse(course.courseId)
  const chat = createAuthoringChat(course.courseId), at = new Date().toISOString()
  appendAuthoringMessage(chat.id, { role: 'user', text: 'Help me plan a course that combines reading and practice.', at })
  appendAuthoringMessage(chat.id, { role: 'assistant', text: 'Build each lesson around one learning objective:\n\n1. Introduce the idea with a short explanation.\n2. Add a visualization or worked example.\n3. Let learners practise with a quiz or exercise.\n\nThe preview shows the course as learners will read it. Select a lesson or block to focus the next change.', status: 'complete', at })
}
