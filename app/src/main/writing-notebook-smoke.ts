/** Isolated Electron smoke: real windows, native typing, and persisted notebook files. */
import { requireUser } from './users'
import { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { getWritingNotebook, getWritingPage, listWritingNotebooks, saveWritingPage, createWritingNotebook } from './writing-notebooks'
import { openWritingNotebook, closeWritingWindows, notebookWindowIdentity } from './writing-notebook-windows'
import { WHITE_THEME_ID } from '../core/theme/builtin-ids'
interface Result { name: string; ok: boolean; detail: string }
const helpers = `const pause=ms=>new Promise(r=>setTimeout(r,ms)); const until=async (condition,message)=>{ for(let i=0;i<400;i++){ if(condition()) return; await pause(25); } throw new Error(message) }; const wait=async selector=>{ for(let i=0;i<400;i++){ const el=document.querySelector(selector); if(el) return el; await pause(25); } throw new Error('Missing '+selector) }; const assert=(v,m)=>{if(!v) throw new Error(m)};`
export async function writingNotebookChecks(main: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const run = async (name: string, fn: () => Promise<string>) => { try { results.push({ name, ok: true, detail: await fn() }) } catch (e) { results.push({ name, ok: false, detail: String(e) }) } }
  const js = (window: BrowserWindow, code: string) => window.webContents.executeJavaScript(`(async()=>{${helpers}${code}})()`)
  let window: BrowserWindow | undefined, id = ''
  await run('launcher creates a notebook in a minimal separate window', async () => {
    await js(main, `(await wait('.notebook-floating .writing-launcher-toggle')).click(); (await wait('.notebook-floating .writing-create')).click(); (await wait('.dialog input')).focus();`)
    await main.webContents.insertText('Smoke notebook')
    await js(main, `document.querySelector('.dialog').requestSubmit();`)
    for (let n = 0; n < 400; n++) {
      window = BrowserWindow.getAllWindows().find(w => w !== main && w.webContents.getURL().includes('writingNotebook='))
      if (window) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (!window) throw new Error('Notebook window not created')
    await js(window, `await wait('.writing-editor .cm-content'); assert(!document.querySelector('.workspace-switch'), 'Main shell leaked into notebook');`)
    id = listWritingNotebooks()[0]!.id
    return 'Title dialog, default page, and dedicated window'
  })
  if (!window) return results
  const notebookWindow = window
  await run('Pomodoro shares one deadline across main and notebook windows, including reloads', async () => {
    await js(main, `const icon=await wait('.pomodoro-icon'); await until(()=>!icon.disabled,'Timer did not load'); icon.click(); (await wait('.pomodoro-yes')).click(); await until(()=>document.querySelector('.pomodoro').dataset.phase==='study','Study did not start');`)
    const started = await js(main, `return window.opencourse.getPomodoroState();`)
    await js(notebookWindow, `await until(()=>document.querySelector('.pomodoro')?.dataset.phase==='study','Notebook timer did not synchronize');`)
    notebookWindow.reload()
    await js(notebookWindow, `await wait('.writing-editor .cm-content'); await until(()=>document.querySelector('.pomodoro')?.dataset.phase==='study','Reload lost the timer'); const state=await window.opencourse.getPomodoroState(); assert(state.cycle.endsAt===${started.cycle.endsAt},'Reload changed the deadline'); document.querySelector('.pomodoro-icon').click();`)
    const [width, height] = notebookWindow.getSize()
    try {
      notebookWindow.setSize(720, height)
      await js(notebookWindow, `await pause(450); const timer=document.querySelector('.pomodoro').getBoundingClientRect(), title=document.querySelector('.titlebar-title').getBoundingClientRect(), actions=document.querySelector('.titlebar-right').getBoundingClientRect(); assert(timer.left>=76,'Timer covers window controls'); assert(timer.right<=title.left && title.right<=actions.left,'Notebook titlebar controls overlap');`)
      writeFileSync('/tmp/opencourse-writing-pomodoro.png', (await notebookWindow.webContents.capturePage()).toPNG())
      await js(notebookWindow, `document.querySelector('.pomodoro-yes').click();`)
      await js(main, `await until(()=>document.querySelector('.pomodoro').dataset.phase==='idle','Notebook stop did not reach main');`)
    } finally {
      notebookWindow.setSize(width, height)
      await js(main, `const state=await window.opencourse.getPomodoroState(); await window.opencourse.commandPomodoro({action:'stop',revision:state.revision});`)
    }
    return 'Start, shared deadline, reload, stop from notebook, and titlebar layout at minimum width'
  })
  await run('live Markdown saves and switches pages without losing content', async () => {
    await js(notebookWindow, `(await wait('.cm-content')).focus();`)
    await notebookWindow.webContents.insertText('# Heading\n\nA **bold** thought and *emphasis*.\n\n- [x] Done\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nTail')
    await js(notebookWindow, `await pause(800); assert(document.querySelector('.writing-bold'), 'Bold formatting missing'); assert(document.querySelector('.writing-preview table'), 'Live table missing'); document.querySelector('.writing-new-page').click(); await pause(500); assert(document.querySelectorAll('.writing-page-link').length===2,'Second page missing'); document.querySelector('.writing-page-link').click(); await pause(300); assert(document.querySelector('.cm-content').textContent.includes('Heading'),'Page text lost');`)
    const notebook = getWritingNotebook(id), page = getWritingPage(id, notebook.pages[0]!.id)
    if (!page.markdown.includes('**bold**')) throw new Error('Markdown source was not retained')
    writeFileSync('/tmp/opencourse-writing-editor.png', (await notebookWindow.webContents.capturePage()).toPNG())
    return 'Formatted editor retains original Markdown and restores pages'
  })
  await run('chat toggle reuses the slide animation and quote survives composer focus', async () => {
    await js(notebookWindow, `const content=await wait('.cm-content'); content.focus();`)
    notebookWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home', modifiers: ['control'] })
    notebookWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home', modifiers: ['control'] })
    await js(notebookWindow, `const line=document.querySelector('.cm-line'); const node=[...line.childNodes].find(n=>n.nodeType===3)||line.firstChild; const range=document.createRange(); range.selectNodeContents(line); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); line.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); await pause(100);`)
    // Use native selection so CodeMirror owns its selection state.
    await js(notebookWindow, `document.querySelector('.cm-content').focus();`)
    notebookWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['meta'] })
    notebookWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['meta'] })
    await js(notebookWindow, `const offer=await wait('.ask-about'); offer.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); offer.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); offer.click(); await pause(450); await wait('.sidechat-quote'); assert(!document.querySelector('.writing-attached-quote'),'Quote should not highlight the source'); const host=document.querySelector('.lesson-chat-host'); assert(host.getBoundingClientRect().width>200,'Chat did not expand'); document.querySelector('.chat-chip').click(); await until(()=>host.getBoundingClientRect().width<2,'Chat did not collapse');`)
    return 'Selection attached without source highlight, reversible chat transition'
  })
  await run('White applies to open notebooks in place and Dark restores the default look', async () => {
    await js(notebookWindow, `
      window.__writingThemeEditor = document.querySelector('.cm-content');
      window.__writingThemeText = window.__writingThemeEditor.textContent;
      const css = selector => getComputedStyle(document.querySelector(selector));
      window.__writingDefault = [css('.writing-page').backgroundColor, css('.cm-scroller').fontFamily, css('.cm-scroller').lineHeight];
    `)
    try {
      for (const [themeId, name, background, font] of [
        [WHITE_THEME_ID, 'white', 'rgb(255, 255, 255)', 'system-ui']
      ]) {
        await js(main, `await window.opencourse.applyTheme(${JSON.stringify(themeId)});`)
        await js(notebookWindow, `
          const css = selector => getComputedStyle(document.querySelector(selector));
          for (let n = 0; n < 400 && (css('.writing-page').backgroundColor !== ${JSON.stringify(background)} || document.querySelector('.writing-window').hasAttribute('data-default-theme')); n++) await pause(25);
          assert(css('.writing-page').backgroundColor === ${JSON.stringify(background)}, 'Notebook surface did not follow theme');
          assert(css('.cm-scroller').fontFamily.includes(${JSON.stringify(font)}), 'Reading font did not follow theme');
          assert(document.querySelector('.cm-content') === window.__writingThemeEditor, 'Theme recreated editor');
          assert(window.__writingThemeEditor.textContent === window.__writingThemeText, 'Theme lost notebook text');
          const selection = getComputedStyle(document.querySelector('.writing-bold'), '::selection');
          assert(selection.backgroundColor !== 'rgba(0, 0, 0, 0)', 'Nested Markdown selection is invisible');
          assert(!!document.querySelector('[data-dark-chrome]') === ${themeId === WHITE_THEME_ID}, 'Titlebar chrome did not follow theme');
          document.querySelector('.chat-chip').click();
          await until(()=>document.querySelector('.lesson-chat-host').getBoundingClientRect().width > 200, 'Themed chat did not open');
          await pause(450);
        `)
        writeFileSync(`/tmp/opencourse-writing-${name}.png`, (await notebookWindow.webContents.capturePage()).toPNG())
        await js(notebookWindow, `document.querySelector('.chat-chip').click(); await until(()=>document.querySelector('.lesson-chat-host').getBoundingClientRect().width < 2, 'Themed chat did not collapse');`)
        await js(main, `(await wait('.notebook-floating .writing-launcher-toggle')).click(); await pause(400); assert(getComputedStyle(document.querySelector('.writing-launcher')).backgroundColor === ${JSON.stringify(background)}, 'Launcher surface did not follow theme');`)
        writeFileSync(`/tmp/opencourse-writing-launcher-${name}.png`, (await main.webContents.capturePage()).toPNG())
        await js(main, `document.querySelector('.writing-launcher-close').click(); await pause(350);`)
      }
    } finally {
      await js(main, `await window.opencourse.applyTheme(null);`)
    }
    await js(notebookWindow, `
      await wait('.writing-window[data-default-theme]');
      const css = selector => getComputedStyle(document.querySelector(selector));
      const restored = [css('.writing-page').backgroundColor, css('.cm-scroller').fontFamily, css('.cm-scroller').lineHeight];
      assert(JSON.stringify(restored) === JSON.stringify(window.__writingDefault), 'Default notebook look changed');
      assert(document.querySelector('.cm-content') === window.__writingThemeEditor, 'Default recreated editor');
    `)
    return 'White surfaces, typography, selection, titlebars, launcher and chat; default restored without remounting'
  })
  await run('reopening focuses the existing notebook and multiple notebooks can coexist', async () => {
    const before = BrowserWindow.getAllWindows().length
    await openWritingNotebook(id)
    if (BrowserWindow.getAllWindows().length !== before) throw new Error('Duplicate notebook window')
    const other = createWritingNotebook('Second notebook'); await openWritingNotebook(other.id)
    if (BrowserWindow.getAllWindows().length !== before + 1) throw new Error('Second notebook window missing')
    const second = BrowserWindow.getAllWindows().find(w => notebookWindowIdentity(w.webContents)?.notebookId === other.id)!
    await js(second, `await wait('.cm-content')`)
    return 'One window per notebook, multiple notebooks supported'
  })
  await run('conflicting saves block close until explicitly resolved', async () => {
    const notebook = getWritingNotebook(id), page = getWritingPage(id, notebook.selectedPageId)
    saveWritingPage(id, page.id, page.revision, 'External revision')
    await js(notebookWindow, `document.querySelector('.cm-content').focus()`)
    await notebookWindow.webContents.insertText(' My conflicting edit')
    await js(notebookWindow, `await pause(800); assert(document.querySelector('.writing-error').textContent.includes('changed elsewhere'),'Conflict missing');`)
    let blocked = false
    try { await closeWritingWindows() } catch { blocked = true }
    if (!blocked || notebookWindow.isDestroyed()) throw new Error('Unresolved conflict did not block closing')
    await js(notebookWindow, `const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Keep my edits'); button.click(); await pause(600); assert(!document.querySelector('.writing-error'),'Conflict not resolved');`)
    return 'Conflict preserved and explicit keep-my-edits resolves against new revision'
  })
  await run('pasted images are copied into notebook assets and render after editing', async () => {
    await js(notebookWindow, `document.querySelector('.cm-content').focus(); const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII='), c=>c.charCodeAt(0)); const data=new DataTransfer(); data.items.add(new File([bytes],'image.png',{type:'image/png'})); document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); await pause(1000);`)
    await notebookWindow.webContents.insertText('\n\nAfter image')
    await js(notebookWindow, `await pause(700); const image=await wait('.writing-image img'); assert(image.complete && image.naturalWidth===1,'Notebook image failed to load');`)
    const notebook = getWritingNotebook(id), page = getWritingPage(id, notebook.selectedPageId)
    if (!page.markdown.includes('assets/')) throw new Error('Image was not saved as an owned asset')
    return 'Clipboard image validated, copied, inserted, and served by the asset protocol'
  })
  await run('notebook windows flush and close cleanly', async () => {
    writeFileSync('/tmp/opencourse-writing-notebook.png', (await notebookWindow.webContents.capturePage()).toPNG())
    await closeWritingWindows()
    if (BrowserWindow.getAllWindows().some(w => w !== main && w.webContents.getURL().includes('writingNotebook='))) throw new Error('Notebook window remained open')
    return 'All notebook windows saved and closed; screenshot in /tmp/opencourse-writing-notebook.png'
  })
  await run('changing users flushes notebooks and closes their windows before changing ownership', async () => {
    const owner = requireUser()
    await openWritingNotebook(id)
    const reopened = BrowserWindow.getAllWindows().find(w => notebookWindowIdentity(w.webContents)?.notebookId === id)!
    await js(reopened, `(await wait('.cm-content')).focus()`)
    await reopened.webContents.insertText('Saved before user switch')
    await js(main, `await window.opencourse.createUser('Notebook isolation user'); assert((await window.opencourse.writing.list()).length===0,'Notebooks leaked to another user'); await window.opencourse.switchUser(${JSON.stringify(owner)});`)
    if (!reopened.isDestroyed()) throw new Error('Old notebook window survived user change')
    const notebook = getWritingNotebook(id)
    if (!getWritingPage(id, notebook.selectedPageId).markdown.includes('Saved before user switch')) throw new Error('Pending edit was lost during user change')
    return 'Pending source saved; notebook windows closed; new user has an empty library'
  })
  return results
}
