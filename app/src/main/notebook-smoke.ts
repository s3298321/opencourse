/** Real renderer + bundled Python, using an isolated smoke profile. */
import type { BrowserWindow } from 'electron'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureExampleCourse, OPEN_EXAMPLE_LESSON } from './reading-smoke'
import { notebookDirectory, stopAllNotebooks } from './notebooks'
import { requireUser } from './users'
import { WHITE_THEME_ID } from '../core/theme/builtin-ids'
interface Result { name: string; ok: boolean; detail: string }
const HELPERS = `
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = element => element?.checkVisibility({ visibilityProperty: true });
const wait = async (selector, timeout = 15000) => { const started = Date.now(); while (Date.now()-started < timeout) { const found = [...document.querySelectorAll(selector)].find(visible); if (found) return found; await sleep(25); } throw new Error('Missing '+selector); };
const until = async (test, timeout = 15000) => { const started=Date.now(); while (!(await test())) { if (Date.now()-started > timeout) throw new Error('Condition did not become true'); await sleep(25); } };
const assert = (value, message) => { if (!value) throw new Error(message); };
const button = text => [...document.querySelectorAll('button')].find(element => visible(element) && element.textContent.trim() === text);
`
export async function notebookChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const fixture = await ensureExampleCourse(win)
  if (!fixture) throw new Error('Example fixture missing')
  const courseId = fixture.courseId
  await win.webContents.executeJavaScript(`window.__NOTEBOOK_COURSE = ${JSON.stringify(courseId)}`)
  const run = async (name: string, code: string): Promise<void> => {
    try { const detail = await win.webContents.executeJavaScript(`(async () => { ${HELPERS} const courseId = window.__NOTEBOOK_COURSE; ${code} })()`); results.push({ name, ok: true, detail: String(detail ?? '') }) }
    catch (error) { results.push({ name, ok: false, detail: String(error) }) }
  }
  results.push({ name: 'importing does not create a notebook environment', ok: !existsSync(notebookDirectory(requireUser(), courseId)), detail: 'Checked before entering a lesson' })
  await run('lesson entry creates the notebook and renders a runnable Python cell', `${OPEN_EXAMPLE_LESSON}
    await until(async () => (await window.opencourse.getNotebookStatus(courseId)).stage === 'ready', 180000);
    const buttons = document.querySelectorAll('.sidebar-notebook > button:first-child'); assert(buttons.length === 1, 'Notebook button is not unique'); assert(buttons[0].textContent === 'Notebook', 'Ready label incorrect');
    const lesson = await wait('.lesson-inner .python-cell'); lesson.querySelector('.python-cell-run').click(); await until(() => lesson.querySelector('.python-cell-output')?.textContent.includes('42'));
    return 'Automatic setup and inline result 42';`)
  await run('lesson cell Reset restores the code and clears its output', `const lesson = await wait('.lesson-inner .python-cell'); const reset = lesson.querySelector('.python-cell-reset'); assert(reset && !reset.disabled, 'Reset missing or disabled after a run');
    assert(reset.nextElementSibling?.classList.contains('python-cell-run'), 'Reset is not beside Run'); const tall = [reset, lesson.querySelector('.python-cell-run')].find(b => b.getBoundingClientRect().height > 30); assert(!tall, 'Cell button taller than the app action size');
    reset.click(); await until(() => !lesson.querySelector('.python-cell-output') && reset.disabled); return 'Output cleared, Reset disabled again';`)
  await run('notebook opens with editable starter cells', `button('Notebook').click(); await wait('.notebook-inner .cm-editor'); assert(document.querySelectorAll('.notebook-inner .python-cell').length === 1, 'Starter cells missing'); return 'One seeded cell';`)
  await run('notebook controls use compact icon buttons and the chapter-list glass', `const controls=[...document.querySelectorAll('.notebook-heading button, .notebook-cell-actions button, .notebook-inner .python-cell-toolbar button')];
    assert(controls.length >= 7, 'Controls missing'); const odd=controls.find(b => !b.classList.contains('action-button') || !b.querySelector('svg') || b.getBoundingClientRect().height > 30); assert(!odd, 'Not a compact icon button: '+odd?.textContent);
    const link=document.querySelector('.sidebar-notebook-link.current'); assert(link?.querySelector('svg'), 'Notebook link has no icon'); const style=getComputedStyle(link); assert(style.backdropFilter.includes('blur') && style.backgroundImage.includes('gradient'), 'Notebook link is not glass');
    await sleep(300); return controls.length+' controls';`)
  writeFileSync(join(tmpdir(), 'opencourse-notebook-dark.png'), (await win.webContents.capturePage()).toPNG())
  await run('notebook cells share a process and display output', `let saved = await window.opencourse.getNotebook(courseId); const first = saved.cells[0].id, second = crypto.randomUUID();
    await window.opencourse.saveNotebook(courseId, saved.revision, [{id:first,content:'value = 40'}, {id:second,content:'value + 2'}]);
    await until(() => document.querySelectorAll('.notebook-inner .python-cell').length === 2);
    document.querySelectorAll('.notebook-inner .python-cell-toolbar button')[0].click(); await until(async () => (await window.opencourse.getNotebook(courseId)).cells[0].execution?.status === 'complete');
    document.querySelectorAll('.notebook-inner .python-cell-toolbar button')[1].click(); await until(() => document.querySelectorAll('.notebook-inner .python-cell-output')[1]?.textContent.includes('42'));
    return 'Second cell sees value from the first';`)
  await run('notebook globals survive course and workspace navigation', `const generation=(await window.opencourse.getNotebookStatus(courseId)).generation;
    document.querySelector('.sidebar ol a').click(); await wait('.lesson-head');
    document.querySelector('.titlebar [data-section="documents"]').click(); await wait('.screen-host:not([hidden]) .documents-library');
    document.querySelector('.titlebar [data-section="courses"]').click(); await wait('.lesson-head'); button('Notebook').click(); await wait('.notebook-inner');
    assert((await window.opencourse.getNotebookStatus(courseId)).generation===generation,'Kernel was replaced on navigation');
    const count=(await window.opencourse.getNotebook(courseId)).cells[1].execution.count;
    document.querySelectorAll('.notebook-inner .python-cell-toolbar button')[1].click(); await until(async () => {const run=(await window.opencourse.getNotebook(courseId)).cells[1].execution; return run?.status==='complete' && run.count>count;}); await wait('.notebook-inner .python-cell-output pre');
    return 'Same kernel across lessons and Documents';`)
  await run('selected output opens course chat on the right', `const output = await wait('.notebook-inner .python-cell-output pre'); const range=document.createRange(); range.selectNodeContents(output); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range); output.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    (await wait('.ask-about')).click(); const chat=await wait('.lesson-chat-host .sidechat'); await wait('.sidechat-quote');
    assert(document.querySelector('.sidechat-quote blockquote').textContent.includes('42'), 'Quote missing'); assert(chat.getBoundingClientRect().left > document.querySelector('.notebook-inner').getBoundingClientRect().left, 'Chat is not on the right');
    return 'Output attached as a notebook quote';`)
  await run('Restart clears variables and retains saved code and output', `const generation=(await window.opencourse.getNotebookStatus(courseId)).generation; button('Restart kernel').click(); await until(async () => { const status=await window.opencourse.getNotebookStatus(courseId); return status.generation!==generation && status.kernel==='idle'; });
    const saved=await window.opencourse.getNotebook(courseId); assert(saved.cells[1].execution.outputs.some(output=>output.text.includes('42')), 'Restart discarded output');
    document.querySelectorAll('.notebook-inner .python-cell-toolbar button')[1].click(); await until(() => document.querySelectorAll('.notebook-inner .python-cell-output')[1]?.textContent.includes('NameError'));
    return 'Variables reset; cells and historical outputs retained';`)
  await run('lesson processes cannot see notebook variables', `await window.opencourse.stopNotebook(courseId); const course=await window.opencourse.getCourse(courseId); const cell=course.modules.flatMap(module=>module.lessons??[]).flatMap(lesson=>lesson.blocks).find(block=>block.type==='python-cell');
    const result=await window.opencourse.runPythonCell({courseId,cellId:cell.nodeId,kind:'lesson',requestId:crypto.randomUUID()},'value'); assert(result.outputs.some(output=>output.text.includes('NameError')), 'Lesson inherited notebook variable'); return 'Fresh lesson process';`)
  await run('empty notebook survives navigation without reseeding', `const saved=await window.opencourse.getNotebook(courseId); await window.opencourse.saveNotebook(courseId,saved.revision,[]); await until(()=>document.querySelectorAll('.notebook-inner .python-cell').length===0);
    document.querySelector('.sidebar ol a').click(); await wait('.lesson-head'); button('Notebook').click(); await wait('.notebook-inner'); assert(document.querySelectorAll('.notebook-inner .python-cell').length===0,'Reseeded deleted cells'); return 'Deleted defaults stay deleted';`)
  await run('cell edits autosave from the actual code editor', `button('Add cell').click(); await wait('.notebook-inner .cm-content'); document.querySelector('.notebook-inner .cm-content').focus(); return 'Editor focused';`)
  try {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] })
    await win.webContents.insertText('print("saved from the editor")')
    await run('edited cell is saved without an explicit Save action', `await until(async () => (await window.opencourse.getNotebook(courseId)).cells[0]?.content.includes('saved from the editor')); return 'CodeMirror input persisted';`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] })
    await run('keyboard code selections are highlighted while composing', `(await wait('.ask-about')).click(); await wait('.python-quote-mark'); assert(document.querySelector('.sidechat-quote blockquote').textContent.includes('saved from the editor'),'Code quote missing'); return 'CodeMirror selection quoted and decorated';`)
    await run('focus the notebook cell for keyboard execution', `document.querySelector('.notebook-inner .cm-content').focus(); return 'Cell focused';`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] })
    await run('Shift+Enter runs and advances into a new cell', `await until(async () => { const notebook=await window.opencourse.getNotebook(courseId); return notebook.cells.length===2 && notebook.cells[0].execution?.status==='complete'; }); assert(document.querySelector('.python-cell-output').textContent.includes('saved from the editor'),'Run output missing'); return 'Execution and next blank cell saved';`)
  } catch (error) { results.push({ name: 'native editor input', ok: false, detail: String(error) }) }
  await run('notebook follows the light editor theme', `await window.opencourse.applyTheme(${JSON.stringify(WHITE_THEME_ID)}); await until(()=>document.documentElement.dataset.appearance==='light'); assert(getComputedStyle(document.querySelector('.cm-editor')).backgroundColor!=='rgb(17, 17, 17)','Editor retained dark background'); return 'Light editor palette';`)
  win.setSize(720, 700)
  await run('notebook and right-side chat fit the narrow window', `await sleep(300); const body=document.querySelector('.notebook-body'); assert(body.scrollWidth<=body.clientWidth+1,'Notebook overflows horizontally'); assert(document.querySelector('.sidechat-close').getBoundingClientRect().right<=window.innerWidth,'Chat close is outside window'); return '720px layout';`)
  win.setSize(1240, 860)
  writeFileSync(join(tmpdir(), 'opencourse-notebook.png'), (await win.webContents.capturePage()).toPNG())
  await stopAllNotebooks()
  return results
}
