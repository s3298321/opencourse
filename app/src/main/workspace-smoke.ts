import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { shell, type BrowserWindow } from 'electron'
import { ensureExampleCourse } from './reading-smoke'
import { WHITE_THEME_ID } from '../core/theme/builtin-ids'

interface Result { name: string; ok: boolean; detail: string }
const HELPERS = `
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el && el.checkVisibility({ visibilityProperty: true });
  const find = selector => [...document.querySelectorAll(selector)].find(visible);
  const wait = async selector => { for (let n = 0; n < 200; n++) { const el = find(selector); if (el) return el; await sleep(25); } throw new Error('No visible ' + selector); };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const roundTrip = async () => {
    const bar = document.querySelector('.titlebar'), thumb = bar.querySelector('.section-switch-thumb');
    bar.querySelector('[data-section="documents"]').click(); await sleep(80);
    assert(document.querySelector('.titlebar') === bar && document.querySelector('.section-switch-thumb') === thumb, 'Chrome was remounted');
    bar.querySelector('[data-section="courses"]').click(); await sleep(80);
  };
`

/** Real mounted-state and layout checks; no external AI calls or user data. */
export async function workspaceChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const run = async (name: string, source: string): Promise<void> => {
    try {
      const detail = await win.webContents.executeJavaScript(`(async () => { ${HELPERS} ${source} })()`)
      results.push({ name, ok: true, detail: String(detail) })
    } catch (error) {
      console.error(`Smoke check failed: ${name}`, error)
      results.push({ name, ok: false, detail: String(error) })
      writeFileSync(join(tmpdir(), 'opencourse-workspace-failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  }
  await ensureExampleCourse(win)
  await win.webContents.executeJavaScript(`document.querySelector('[data-section="courses"]').click(); new Promise(resolve => setTimeout(resolve, 100))`)
  win.webContents.send('app:navigate', 'library')
  await run('workspaces: library source, course screen and lesson position survive Documents', `
    await wait('.library');
    const source = await wait('.course-source-tabs [aria-selected="true"]'); await roundTrip();
    assert(find('.course-source-tabs [aria-selected="true"]') === source, 'Library source was reset');
    const gaps = [];
    const checkSurface = () => {
      const host = find('.screen-host'), content = host?.querySelector('.content');
      if (!content || !visible(content)) { gaps.push('No page surface'); return; }
      const loading = host.querySelector('.empty[role="status"]');
      if (loading) {
        const box = content.getBoundingClientRect(), bounds = host.getBoundingClientRect();
        if (box.width < bounds.width - 1 || box.height < bounds.height - 1) gaps.push('Loading surface does not fill the page');
        if (getComputedStyle(content).backgroundColor === 'rgba(0, 0, 0, 0)') gaps.push('Transparent loading surface');
      }
    };
    // Inspect every React commit, including loading states shorter than a frame.
    const observer = new MutationObserver(checkSurface); observer.observe(document.querySelector('.app'), { childList: true, subtree: true });
    let detail;
    try {
      const card = [...document.querySelectorAll('.course-card')].find(c => /OpenCourse example course/.test(c.textContent)); card.click();
      detail = await wait('.detail'); await roundTrip(); assert(find('.detail') === detail, 'Course remounted');
      find('.course-continue').click(); await wait('.lesson-head');
    } finally { observer.disconnect(); }
    assert(gaps.length === 0, 'Navigation exposed the window: ' + gaps.join(', '));
    const column = find('.content.scroll'), heading = find('.lesson-head'); column.scrollTop = 180; await sleep(80);
    const top = column.scrollTop; await roundTrip();
    assert(find('.lesson-head') === heading && column.scrollTop === top, 'Lesson position changed');
    assert(!column.closest('.body').getAnimations().length && !heading.querySelector('h1').getAnimations().length, 'Screen entrance remains');
    return 'Library source, mounted course and lesson scroll retained; Continue keeps the page surface painted with no navigation fade';
  `)
  await run('workspaces: exercise and Ask remain mounted with drafts and selected panes', `
    const open = [...document.querySelectorAll('.exercise button')].find(b => /Open editor/i.test(b.textContent)); assert(open, 'No example exercise'); open.click();
    const editor = await wait('.workbench-editor .cm-editor'), brief = find('.workbench-brief');
    const ask = await wait('.titlebar .chat-chip'); if (ask.getAttribute('aria-pressed') !== 'true') ask.click();
    const field = await wait('.sidechat-input'), panel = find('.sidechat');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(field, 'Unsent exercise question'); field.dispatchEvent(new Event('input', { bubbles: true })); await sleep(80);
    const content = editor.querySelector('.cm-content'); content.focus();
    const range = document.createRange(); range.selectNodeContents(content); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.execCommand('insertText', false, '# workspace edit'); await sleep(80);
    assert(content.textContent.includes('# workspace edit'), 'Editor did not accept the edit');
    const code = content.textContent, cursorNode = selection.anchorNode, cursorOffset = selection.anchorOffset;
    brief.scrollTop = 50; const briefTop = brief.scrollTop;
    await roundTrip();
    assert(find('.cm-editor') === editor && content.textContent === code, 'Exercise editor remounted');
    assert(document.activeElement === content && selection.anchorNode === cursorNode && selection.anchorOffset === cursorOffset, 'Editor cursor or focus changed');
    assert(find('.sidechat') === panel && field.value === 'Unsent exercise question', 'Ask state was replaced');
    assert(brief.scrollTop === briefTop, 'Exercise brief position reset');
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true, bubbles: true, cancelable: true })); await sleep(80);
    assert(!content.textContent.includes('# workspace edit'), 'Undo history was lost');
    return 'Edited buffer, cursor, focus, undo history, brief and Ask draft retained after Documents';
  `)
  if (process.env['OPENCOURSE_SMOKE_PYTHON']) {
    await run('workspaces: an interactive terminal keeps output and receives output while parked', `
      find('.workbench-tabs button:last-child').click();
      for (let n = 0; n < 2400 && !find('.workbench .pane:last-child .xterm'); n++) await sleep(25);
      const terminal = await wait('.workbench .pane:last-child .xterm');
      const course = await window.opencourse.getCourse(${JSON.stringify((await ensureExampleCourse(win))!.courseId)});
      const exercise = course.modules[0].lessons[0].blocks.find(block => block.type === 'exercise');
      for (let n = 0; n < 320 && !terminal.querySelector('.xterm-rows')?.textContent.trim(); n++) await sleep(25);
      await window.opencourse.writePty(exercise.id + '-shell', "echo workspace-terminal-marker\\r");
      for (let n = 0; n < 320 && !terminal.textContent.includes('workspace-terminal-marker'); n++) await sleep(25);
      await roundTrip();
      assert(find('.workbench .pane:last-child .xterm') === terminal, 'Terminal was recreated');
      assert(terminal.textContent.includes('workspace-terminal-marker'), 'Terminal output was lost');
      assert(find('.workbench-tabs button.active').textContent === 'Terminal', 'Selected terminal tab was lost');
      find('.titlebar [data-section="documents"]').click(); await sleep(80);
      await window.opencourse.writePty(exercise.id + '-shell', "echo output-while-parked\\r"); await sleep(200);
      find('.titlebar [data-section="courses"]').click(); await sleep(150);
      assert(find('.workbench .pane:last-child .xterm') === terminal, 'Parked terminal was recreated');
      assert(terminal.textContent.includes('output-while-parked'), 'Background terminal output was lost');
      return 'Same live shell, terminal output and selected pane across Documents';
    `)
  }
  const originalSize = win.getSize()
  try {
    for (const width of [1440, 720]) {
      win.setSize(width, 900)
      await run(`workspaces: exercise chat layout at ${width}px`, `
        await sleep(180);
        const body = find('.lesson-body'), editor = find('.workbench-main'), chat = find('.lesson-chat-host');
        assert(body.scrollWidth <= body.clientWidth + 1, 'Horizontal overflow');
        const layout = getComputedStyle(chat).position;
        assert(layout === ${width > 1200 ? "'static'" : "'absolute'"}, 'Unexpected chat docking: ' + layout);
        assert(editor.getBoundingClientRect().width >= ${width > 1200 ? 360 : 200}, 'Editor too narrow');
        return layout + '; editor ' + Math.round(editor.getBoundingClientRect().width) + 'px';
      `)
      writeFileSync(join(tmpdir(), `opencourse-exercise-chat-${width}.png`), (await win.webContents.capturePage()).toPNG())
    }
  } finally { win.setSize(originalSize[0]!, originalSize[1]!) }
  await run('settings: categories preserve input and About reports installed runtimes', `
    // Restoring the window size emits resize asynchronously, which closes menus.
    await sleep(180);
    if (!find('.user-menu')) find('.titlebar .user-chip').click();
    (await wait('.user-menu')).querySelector('.menu-item').click(); await wait('.settings-nav');
    find('[data-settings-category="profile"]').click(); await wait('.settings-name');
    const name = find('.settings-name'), setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(name, 'Unfinished settings name'); name.dispatchEvent(new Event('input', { bubbles: true })); await sleep(50);
    for (const category of ['appearance','connections','ai','coach','servers','updates','about']) {
      find('[data-settings-category="'+category+'"]').click(); await sleep(100);
      assert(find('#settings-'+category), 'Missing category ' + category);
    }
    const info = await window.opencourse.getAppInfo(); await wait('.about-details');
    const about = find('.settings-about').textContent;
    for (const value of [info.version, info.python?.version, info.electron, info.chromium, info.node]) if (value) assert(about.includes(value), 'Missing runtime ' + value);
    const links = [...document.querySelectorAll('.settings-links a')].map(a => a.getAttribute('href'));
    assert(JSON.stringify(links) === JSON.stringify(['https://opencourse.dev/legal','https://opencourse.dev','https://catalog.opencourse.dev']), 'Wrong website links');
    find('[data-settings-category="profile"]').click(); await sleep(50); assert(find('.settings-name') === name && name.value === 'Unfinished settings name', 'Category lost unfinished input');
    find('[data-settings-category="about"]').click(); await sleep(50);
    return 'Eight categories, retained input, correct links and runtime versions';
  `)
  const opened: string[] = [], originalOpen = shell.openExternal
  try {
    // Exercise the real preload, IPC and link handler without opening browser tabs.
    shell.openExternal = async url => { opened.push(url) }
    await win.webContents.executeJavaScript(`document.querySelector('.settings-links a').click(); document.querySelectorAll('.settings-links a')[1].focus()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-links a')[2].click()`)
    await new Promise(resolve => setTimeout(resolve, 50))
    await run('settings: website links open externally by click and keyboard without losing input', `
      assert(JSON.stringify(${JSON.stringify(opened)}) === JSON.stringify(['https://opencourse.dev/legal','https://opencourse.dev','https://catalog.opencourse.dev']), 'External URLs differ');
      assert(find('[data-settings-category="about"]').getAttribute('aria-current') === 'page', 'Link changed category');
      assert(document.querySelector('.settings-name').value === 'Unfinished settings name', 'Link lost unfinished input');
      return 'Three correct system-browser requests; Enter activation; category and draft preserved';
    `)
  } finally { shell.openExternal = originalOpen }
  await win.webContents.executeJavaScript(`window.opencourse.applyTheme(${JSON.stringify(WHITE_THEME_ID)})`)
  await run('White: dark title bar with light settings content', `
    await sleep(150);
    const bar = getComputedStyle(document.querySelector('.titlebar'));
    assert(bar.backgroundColor === 'rgb(11, 11, 10)', 'Title bar is ' + bar.backgroundColor);
    assert(bar.getPropertyValue('--fg').trim() === '#dedee3', 'Dark foreground missing');
    assert(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#ffffff', 'Content is no longer White');
    return 'Dark chrome, light content';
  `)
  writeFileSync(join(tmpdir(), 'opencourse-settings-about-white.png'), (await win.webContents.capturePage()).toPNG())
  await win.webContents.executeJavaScript('window.opencourse.applyTheme(null)')
  await run('workspaces: switching from Settings restores the exercise without its overlay', `
    await roundTrip(); assert(!find('.settings-nav') && find('.cm-editor'), 'Overlay survived or exercise was lost');
    assert(find('.sidechat-input').value === 'Unsent exercise question', 'Overlay trip lost draft');
    return 'Exercise and chat restored after dismissing Settings';
  `)
  return results
}
