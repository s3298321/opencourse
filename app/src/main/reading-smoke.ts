/**
 * Smoke checks for the reader's text size, against the real window and the
 * example course - which ships in the spec bundle, so this suite needs nothing
 * from content/ and runs on its own (OPENCOURSE_SMOKE_ONLY=reading) as well as
 * inside the full run.
 *
 * What it judges is what rendered: computed font sizes, where the control sits
 * against the column and the window, whether the composer clips. The presses
 * are real ones, routed by the browser (CDP), because the control refuses
 * mousedown on purpose and a synthetic el.click() would skip exactly that.
 * Leaves the size at 100%, so nothing after it notices.
 */
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { specResourcesDir } from './paths'

interface Result { name: string; ok: boolean; detail: string }

const EXAMPLE = 'opencourse-example'

const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (e) => e && e.getBoundingClientRect().width > 0;
  const wait = async (selector, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = [...document.querySelectorAll(selector)].find(visible);
      if (el) return el;
      await sleep(50);
    }
    throw new Error('timed out waiting for ' + selector);
  };
  const until = async (test, what, timeout = 6000) => {
    const t0 = Date.now();
    while (!(await test())) { if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const px = (target) => parseFloat(getComputedStyle(typeof target === 'string' ? document.querySelector(target) : target).fontSize);
  const pill = () => document.querySelector('.content .reading-size');
  const label = () => pill().querySelector('.reading-size-reset').textContent;
  /** What scales, by what it is: the first visible match of each, in the lesson. */
  const SCALED = {
    paragraph: '.lesson-inner .prose p',
    title: '.lesson-head h1',
    meta: '.lesson-inner .meta',
    objective: '.objectives li',
    question: '.quiz .question',
    option: '.quiz label',
    code: '.lesson-inner .prose code',
    exercise: '.exercise h3'
  };
  const sizes = () => Object.fromEntries(Object.entries(SCALED).map(([key, selector]) => {
    const found = [...document.querySelectorAll(selector)].find(visible);
    return [key, found ? px(found) : null];
  }));
`

/** The example course, imported through the real path the first time a suite asks for it. */
export async function ensureExampleCourse(win: BrowserWindow): Promise<ReturnType<typeof import('./fixture-identities')['fixtureCourse']>> {
  const { fixtureCourse } = await import('./fixture-identities')
  const found = fixtureCourse(EXAMPLE)
  if (found) return found
  const { importCourseZip } = await import('./import')
  const imported = await importCourseZip(join(specResourcesDir(), 'opencourse-example-course.zip'))
  if (imported.status !== 'ok') throw new Error('the example course did not import: ' + imported.status)
  win.webContents.send('courses:changed')
  return fixtureCourse(EXAMPLE)
}

/** Renderer code that opens the example course's first lesson from wherever the window is. */
export const OPEN_EXAMPLE_LESSON = `
  if (document.querySelector('.settings') || document.querySelector('.logs')) { document.querySelector('.titlebar .crumbs a').click(); await sleep(250); }
  document.querySelector('.titlebar [data-section="courses"]').click();
  await wait('.library');
  const card = await (async () => {
    for (let n = 0; n < 160; n++) {
      const found = [...document.querySelectorAll('.course-card')].find((c) => /OpenCourse example course/.test(c.textContent));
      if (found) return found;
      await sleep(50);
    }
    throw new Error('no example course card');
  })();
  card.click();
  (await wait('.lesson-row')).click();
  await wait('.lesson-head h1');
`

export async function readingSizeChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const run = async (name: string, body: string): Promise<void> => {
    try {
      const detail = await win.webContents.executeJavaScript(`(async () => { ${HELPERS} ${body} })()`)
      results.push({ name, ok: true, detail: String(detail ?? '') })
    } catch (err) {
      results.push({ name, ok: false, detail: String(err) })
    }
  }
  const inMain = async (name: string, body: () => string | Promise<string>): Promise<void> => {
    try { results.push({ name, ok: true, detail: await body() }) } catch (err) { results.push({ name, ok: false, detail: String(err) }) }
  }
  /** A real press - mousedown, mouseup, click - at the centre of what `selector` finds. */
  const press = async (selector: string): Promise<void> => {
    const box = await win.webContents.executeJavaScript(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`) as { x: number; y: number } | null
    if (!box) throw new Error('nothing to press at ' + selector)
    const cdp = win.webContents.debugger
    const attached = cdp.isAttached()
    if (!attached) cdp.attach('1.3')
    try {
      const at = { x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1 }
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...at })
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at })
    } finally {
      if (!attached) cdp.detach()
    }
  }
  /** For a person to look at: os.tmpdir()/opencourse-reading-<name>.png. */
  const shot = async (name: string): Promise<void> => {
    // A window in the background is not repainted on its own: ask for a frame
    // and wait for it, or the picture is of a moment ago.
    try {
      win.webContents.invalidate()
      await new Promise((resolve) => setTimeout(resolve, 300))
      writeFileSync(join(tmpdir(), `opencourse-reading-${name}.png`), (await win.webContents.capturePage()).toPNG())
    } catch { /* best effort */ }
  }
  const pressing = async (name: string, selector: string, times = 1): Promise<void> => {
    try { for (let n = 0; n < times; n++) await press(selector) } catch (err) { results.push({ name, ok: false, detail: String(err) }) }
  }

  const { getReadingScale, readPreferences, setReadingScale } = await import('./preferences')

  await inMain('the example course is in the library, with an answered side chat', async () => {
    const course = await ensureExampleCourse(win)
    const module = course?.modules[0]
    const first = module?.lessons?.[0]
    if (!course || !module || !first) throw new Error('the example course has no first lesson')
    const { insertChat, appendMessage } = await import('./chatdb')
    const { newChatId } = await import('../core/sidechat/ids')
    const { DEFAULT_CHAT_MODEL } = await import('../core/sidechat/models')
    const lesson = { moduleId: module.slug, lessonId: first.slug }
    const id = newChatId()
    const at = new Date().toISOString()
    insertChat({ id, courseId: course.courseId, model: DEFAULT_CHAT_MODEL, startedIn: lesson, at })
    for (const [role, text] of [['context', 'the lesson'], ['user', 'what does print do?'], ['assistant', 'It writes its arguments to standard output, separated by spaces.']] as const) {
      appendMessage(id, { role, text, lesson, at })
    }
    setReadingScale(1)
    return course.title
  })

  await run('a lesson opens at the app\'s own size, with the control at the column\'s foot', `
    ${OPEN_EXAMPLE_LESSON}
    await wait('.content .reading-size');
    if (label() !== '100%') throw new Error('the control reads ' + label());
    const box = pill().getBoundingClientRect();
    const column = document.querySelector('.content').getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const fromLeft = box.left - column.left;
    const fromBottom = window.innerHeight - box.bottom;
    if (fromLeft < 4 || fromLeft > 24) throw new Error('it sits ' + fromLeft + 'px into the column');
    if (fromBottom < 4 || fromBottom > 24) throw new Error('it sits ' + fromBottom + 'px above the window\\'s foot');
    if (box.left < sidebar.right) throw new Error('it overlaps the sidebar');
    // At this window's width the lesson has a margin, and the control fits in it.
    const inner = document.querySelector('.lesson-inner');
    const textLeft = inner.getBoundingClientRect().left + parseFloat(getComputedStyle(inner).paddingLeft);
    if (box.right > textLeft) throw new Error('it covers the start of the lines: ' + Math.round(box.right) + ' > ' + Math.round(textLeft));
    window.__readingBase = sizes();
    window.__readingSidebar = px([...document.querySelectorAll('.sidebar a')].find(visible));
    const missing = ['paragraph', 'title', 'meta', 'objective', 'option'].filter((key) => window.__readingBase[key] === null);
    if (missing.length) throw new Error('nothing to measure for ' + missing.join(', '));
    return Math.round(fromLeft) + 'px in, ' + Math.round(fromBottom) + 'px up';
  `)

  // Pin a passage near the top of the column before the change, to see the
  // reading position kept.
  await run('(setup) scroll a quiz near the top', `
    const column = document.querySelector('.content');
    const quiz = document.querySelector('.lesson-inner .quiz');
    // The quiz's top just inside the column's, so it is the passage the
    // position is pinned to: the text above it is out of view.
    column.scrollTop += quiz.getBoundingClientRect().top - column.getBoundingClientRect().top - 2;
    await sleep(100);
    window.__readingAnchor = quiz.getBoundingClientRect().top;
    return Math.round(window.__readingAnchor) + 'px';
  `)
  await pressing('A+ pressed with a real mouse', '.reading-size-larger', 2)

  await run('A+ twice makes every text in the lesson 125%, and nothing outside it', `
    await until(() => label() === '125%', 'the control to read 125%');
    const now = sizes();
    const wrong = Object.entries(window.__readingBase)
      .filter(([key, base]) => base !== null && Math.abs(now[key] - base * 1.25) > 1)
      .map(([key, base]) => key + ' ' + base + '→' + now[key]);
    if (wrong.length) throw new Error(wrong.join(', '));
    const sidebar = px([...document.querySelectorAll('.sidebar a')].find(visible));
    if (sidebar !== window.__readingSidebar) throw new Error('the sidebar moved: ' + window.__readingSidebar + '→' + sidebar);
    const body = document.querySelector('.body');
    if (body.scrollWidth > body.clientWidth + 1) throw new Error('the screen scrolls sideways');
    return Object.entries(now).filter(([, v]) => v !== null).map(([k, v]) => k + ' ' + v).join(', ');
  `)

  await shot('125')
  await run('the passage you were reading stays where it was', `
    const quiz = document.querySelector('.lesson-inner .quiz');
    const moved = quiz.getBoundingClientRect().top - window.__readingAnchor;
    if (Math.abs(moved) > 4) throw new Error('it moved ' + Math.round(moved) + 'px');
    return Math.round(moved) + 'px';
  `)

  await inMain('the size is saved for this user', () => {
    const saved = getReadingScale()
    if (saved !== 1.25) throw new Error('preferences hold ' + saved)
    return String(saved)
  })

  await pressing('the chat chip pressed', '.titlebar .chat-chip')
  await run('the side chat follows the size, and its composer does not clip', `
    const field = await wait('.sidechat-input');
    const expected = 0.88 * 16 * 1.25;
    if (Math.abs(px(field) - expected) > 0.5) throw new Error('composer ' + px(field) + 'px, expected ' + expected);
    const turn = await wait('.chat-turn.assistant .prose');
    if (Math.abs(px(turn) - 0.9 * 16 * 1.25) > 0.5) throw new Error('answer ' + px(turn) + 'px');
    if (px('.sidechat-head strong') > 0.85 * 16 + 0.5) throw new Error('the chat\\'s own chrome grew too');
    field.focus();
    document.execCommand('insertText', false, 'one line, then another, and a third that wraps in a narrow column of text');
    await sleep(300);
    if (field.scrollHeight > field.clientHeight + 1) throw new Error('the composer clips: ' + field.scrollHeight + ' > ' + field.clientHeight);
    window.__readingField = field.clientHeight;
    return Math.round(px(field)) + 'px, ' + field.clientHeight + 'px high';
  `)
  await shot('125-chat')
  await pressing('A+ pressed with the chat open', '.reading-size-larger')
  await run('the composer refits when the size changes under it', `
    await until(() => label() === '140%', 'the control to read 140%');
    await sleep(300);
    const field = document.querySelector('.sidechat-input');
    if (field.scrollHeight > field.clientHeight + 1) throw new Error('the composer clips at 140%: ' + field.scrollHeight + ' > ' + field.clientHeight);
    if (field.clientHeight <= window.__readingField) throw new Error('the composer did not grow: ' + field.clientHeight);
    field.select(); document.execCommand('delete');
    return field.clientHeight + 'px';
  `)
  await pressing('A− pressed', '.reading-size-smaller')
  await pressing('the chat chip pressed again', '.titlebar .chat-chip')

  await run('the next lesson keeps the size', `
    await until(() => label() === '125%' && !document.querySelector('.sidechat'), 'back to 125% with the chat closed');
    const title = document.querySelector('.lesson-head h1').textContent;
    const next = [...document.querySelectorAll('.lesson-nav button')].find((b) => /→$/.test(b.textContent.trim()));
    next.click();
    await until(() => document.querySelector('.lesson-head h1')?.textContent !== title, 'the next lesson');
    await sleep(200);
    if (label() !== '125%') throw new Error('it reads ' + label());
    const paragraph = px([...document.querySelectorAll('.lesson-inner .prose p')].find(visible));
    if (Math.abs(paragraph - window.__readingBase.paragraph * 1.25) > 1) throw new Error('paragraph ' + paragraph);
    return document.querySelector('.lesson-head h1').textContent;
  `)

  await run('a trip to Settings comes back to the same place at the same size', `
    const column = document.querySelector('.content');
    column.scrollTop = Math.min(300, column.scrollHeight - column.clientHeight);
    await sleep(100);
    const before = column.scrollTop;
    document.querySelector('.titlebar .user-chip').click();
    const menu = await wait('.menu-panel');
    [...menu.querySelectorAll('.menu-item')].find((b) => /Settings/.test(b.textContent)).click();
    await wait('.settings');
    document.querySelector('.titlebar .crumbs a').click();
    await wait('.content .reading-size');
    await sleep(300);
    const after = document.querySelector('.content').scrollTop;
    if (Math.abs(after - before) > 2) throw new Error('scrolled ' + before + ' → ' + after);
    if (label() !== '125%') throw new Error('it reads ' + label());
    return before + 'px, ' + label();
  `)

  await run('the exercise brief follows the size, and the control goes with the column', `
    const back = [...document.querySelectorAll('.lesson-nav button')].find((b) => /^←/.test(b.textContent.trim()));
    back.click();
    await wait('.exercise');
    const open = [...document.querySelectorAll('.exercise button')].find((b) => /Open editor/.test(b.textContent));
    if (!open) throw new Error('no Open editor button');
    open.click();
    const brief = await wait('.workbench-brief');
    const size = px(brief);
    if (Math.abs(size - 14 * 1.25) > 0.5) throw new Error('brief ' + size + 'px');
    if (visible(pill())) throw new Error('the control is still showing over the editor');
    document.querySelector('.workbench-back').click();
    await wait('.content .reading-size');
    return size + 'px';
  `)

  await shot('125-next')
  await pressing('the size pressed to reset', '.reading-size-reset')
  await run('pressing the size goes back to the app\'s own', `
    await until(() => label() === '100%', 'the control to read 100%');
    const now = sizes();
    const wrong = Object.entries(window.__readingBase).filter(([key, base]) => base !== null && now[key] !== null && Math.abs(now[key] - base) > 0.5);
    if (wrong.length) throw new Error(wrong.map(([k]) => k).join(', ') + ' did not come back');
    return '100%';
  `)
  await shot('100')
  await inMain('nothing is kept for the default size', () => {
    if ('readingScale' in readPreferences()) throw new Error('preferences.json still holds a size')
    return 'absent'
  })
  setReadingScale(1)
  return results
}
