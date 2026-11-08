/** Isolated Electron smoke: real windows, native typing, and persisted notebook files. */
import { requireUser } from './users'
import { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { getWritingNotebook, getWritingPage, listWritingNotebooks, saveWritingPage, createWritingNotebook, updateWritingNotebook } from './writing-notebooks'
import { openWritingNotebook, closeWritingWindows, notebookWindowIdentity } from './writing-notebook-windows'
import { join } from 'node:path'
import { specResourcesDir } from './paths'
import { readNotebookSketch } from './writing-notebook-sketch'
import { sketchLine, DEFAULT_SKETCH } from '../core/writing-notebooks/sketch'
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
  await run('Panda applies to open notebooks in place and Bond restores the default look', async () => {
    await js(notebookWindow, `
      window.__writingThemeEditor = document.querySelector('.cm-content');
      window.__writingThemeText = window.__writingThemeEditor.textContent;
      const css = selector => getComputedStyle(document.querySelector(selector));
      window.__bondControls = ['.reading-size', '.reading-size-larger', '.writing-new-page'].map(selector => [css(selector).backgroundColor, css(selector).color, css(selector).borderColor]);
      window.__writingDefault = [css('.writing-page').backgroundColor, css('.cm-scroller').fontFamily, css('.cm-scroller').lineHeight];
    `)
    try {
      for (const [themeId, name, background, font] of [
        [WHITE_THEME_ID, 'white', 'rgb(250, 248, 245)', 'system-ui']
      ]) {
        await js(main, `await window.opencourse.applyTheme(${JSON.stringify(themeId)});`)
        await js(notebookWindow, `
          const css = selector => getComputedStyle(document.querySelector(selector));
          for (let n = 0; n < 400 && (css('.writing-page').backgroundColor !== ${JSON.stringify(background)} || document.querySelector('.writing-window').hasAttribute('data-default-theme')); n++) await pause(25);
          assert(css('.writing-page').backgroundColor === ${JSON.stringify(background)}, 'Notebook surface did not follow theme');
          const controls = ['.reading-size', '.reading-size-larger', '.writing-new-page'].map(selector => [css(selector).backgroundColor, css(selector).color, css(selector).borderColor]);
          assert(JSON.stringify(controls) === JSON.stringify(window.__bondControls), 'Panda notebook controls differ from Bond');
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
        await js(main, `
          for (const selector of ['.coach-floating', '.notebook-floating']) {
            const launcher = await wait(selector + ':not(.expanded)');
            assert(getComputedStyle(launcher).backgroundColor === ${JSON.stringify(background)}, selector + ' lost its Panda surface');
          }
          (await wait('.notebook-floating .writing-launcher-toggle')).click(); await pause(400);
          assert(getComputedStyle(document.querySelector('.notebook-floating.expanded')).backgroundColor === ${JSON.stringify(background)}, 'Launcher surface did not follow theme');`)
        writeFileSync(`/tmp/opencourse-writing-launcher-${name}.png`, (await main.webContents.capturePage()).toPNG())
        await js(main, `document.querySelector('.notebook-floating .writing-launcher-close').click(); await pause(350);`)
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
    return 'Warm off-white surfaces, typography, selection, titlebars, launcher and chat; default restored without remounting'
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
  await run('sketches draw, resize, save, reopen and follow notebook shortcuts and themes', async () => {
    const notebook = createWritingNotebook('Drawing')
    updateWritingNotebook(notebook.id, { showLineNumbers: true })
    const open = async () => {
      await openWritingNotebook(notebook.id)
      const win = BrowserWindow.getAllWindows().find(w => notebookWindowIdentity(w.webContents)?.notebookId === notebook.id)!
      win.setSize(720, 720); win.focus()
      await js(win, `(await wait('.cm-content')).focus();`)
      return win
    }
    let win = await open()
    const press = (keyCode: string, modifiers: ('meta' | 'control' | 'shift')[] = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
    const drag = (x: number, y: number, dx: number, dy: number) => {
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseMove', x: x + dx, y: y + dy, modifiers: ['leftbuttondown'] })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: x + dx, y: y + dy, button: 'left', clickCount: 1 })
    }
    try {
      press('e', ['meta'])
      await js(win, `await wait('.sketch-drawing');`)
      press('Escape')
      await js(win, `await wait('.sketch-preview img');`)
      press('Up')
      const beforeDelete = await js(win, `const img=await wait('.writing-sketch-cursor .sketch-preview img');
        assert(getComputedStyle(img.closest('.cm-content')).caretColor==='rgba(0, 0, 0, 0)','Text caret still visible');
        const style=getComputedStyle(img.parentElement);
        assert(style.outlineStyle==='solid' && style.boxShadow!=='none','Missing sketch cursor');
        return img.src;`)
      press('Shift')
      await js(win, `await until(()=>!document.querySelector('.writing-sketch'),'Shift did not remove the sketch');`)
      press('z', ['control'])
      await js(win, `const img=await wait('.writing-sketch-cursor .sketch-preview img');
        assert(img.src===${JSON.stringify(beforeDelete)},'Undo did not restore the same sketch');`)
      press('Enter')
      await js(win, `await until(()=>{const lines=document.querySelectorAll('.cm-content .cm-line'), sel=getSelection();
        return lines.length===3 && lines[0].querySelector('.sketch-preview') &&
          lines[1].contains(sel.anchorNode) && sel.isCollapsed && sel.anchorOffset===0;
      },'Enter did not place the caret at the start of a new line below the sketch');`)
      press('z', ['control'])
      await js(win, `await wait('.writing-sketch-cursor .sketch-preview');`)
      press('Down')
      await js(win, `await until(()=>!document.querySelector('.writing-sketch-cursor'),'Sketch cursor did not move back to text');`)
      // Change the shortcut in Settings while the notebook is open.
      main.focus()
      const settingsBounds = await js(main, `document.querySelector('.titlebar .user-chip').click(); const panel=await wait('.menu-panel');
        [...panel.querySelectorAll('.menu-item')].find(b=>b.textContent.includes('Settings')).click();
        (await wait('[data-settings-category="appearance"]')).click();
        const form=await wait('.sketch-settings'); await wait('.sketch-settings input[type=number]');
        document.querySelectorAll('.writing-launcher.expanded header .writing-launcher-close').forEach(button=>button.click());
        form.scrollIntoView({block:'center'});
        const save=form.querySelector('button[type=submit]'); await until(()=>{
          const r=save.getBoundingClientRect(); return save.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
        },'Sketch settings Save button is obscured');
        const r=form.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};`)
      writeFileSync('/tmp/opencourse-sketch-settings.png', (await main.webContents.capturePage(settingsBounds)).toPNG())
      await js(main, `const form=document.querySelector('.sketch-settings'), input=form.querySelector('input[type=number]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'800'); input.dispatchEvent(new Event('input',{bubbles:true}));
        const record=form.querySelector('[aria-label="Record insert sketch shortcut"]'); record.focus(); record.click(); await pause(75);`)
      const mainShortcut = (keyCode: string) => {
        main.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers:['meta']})
        main.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers:['meta']})
      }
      mainShortcut('l')
      await js(main, `await until(()=>document.querySelector('.sketch-settings [role=status]')?.textContent.includes('available'),'Reserved shortcut not rejected');`)
      mainShortcut('j')
      await js(main, `const form=document.querySelector('.sketch-settings'); await until(()=>form.textContent.includes('⌘J'),'Shortcut not recorded');
        form.requestSubmit(); await until(()=>form.querySelector('[role=status]')?.textContent==='Saved.','Sketch settings not saved');`)
      win.focus()
      await js(win, `document.querySelector('.cm-content').focus();`)
      press('j', ['meta'])
      const [x, y] = await js(win, `const drawing = await wait('.sketch-drawing'); drawing.scrollIntoView({block:'center'}); await pause(80);
        const r=drawing.getBoundingClientRect(); assert(r.width < 800,'Sketch did not fit narrow notebook');
        return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height * .6)];`)
      const strokeCount = 16
      for (let index = 0; index < strokeCount; index++) {
        drag(x, y + index * 2, index % 2 ? -150 : 150, 12)
      }
      await js(win, `await until(()=>document.querySelectorAll('.sketch-drawing [data-mark]').length===${strokeCount},'Rapid strokes disappeared');
        const labels=[...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(el=>el.style.visibility!=='hidden').map(el=>el.textContent);
        assert(labels.join(',')==='1,2','Each sketch should have one line number: '+labels);`)
      await js(win, `const select=document.querySelector('[aria-label="Brush thickness"]'), css=getComputedStyle(select);
        assert(css.backgroundImage==='none' && css.appearance==='none','Thickness chevron still visible');
        select.value='8'; select.dispatchEvent(new Event('change',{bubbles:true}));
        document.querySelector('[aria-label="Eraser"]').click();`)
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y: y - 4 })
      await js(win, `const drawing=document.querySelector('.sketch-drawing'), select=document.querySelector('[aria-label="Brush thickness"]');
        const cursor=()=>getComputedStyle(drawing).cursor;
        async function checkRing(width) {
          await until(()=>cursor().startsWith('url('),'Missing eraser cursor');
          const match=/^url\\("([^"]+)"\\) (\\d+) (\\d+), crosshair$/.exec(cursor());
          assert(match,'Missing cursor hotspot');
          const image=new Image(); image.src=match[1]; await image.decode();
          const svg=new DOMParser().parseFromString(decodeURIComponent(match[1].slice(match[1].indexOf(',')+1)), 'image/svg+xml');
          const ring=svg.documentElement.lastElementChild;
          assert(Number(ring.getAttribute('cx'))===Number(match[2]) && Number(ring.getAttribute('cy'))===Number(match[3]),'Cursor hotspot is off-center');
          const diameter=2*Number(ring.getAttribute('r'))+Number(ring.getAttribute('stroke-width'));
          assert(Math.abs(diameter-width*drawing.getBoundingClientRect().width/drawing.viewBox.baseVal.width)<.01,'Cursor and eraser sizes differ');
        }
        await checkRing(8);
        const updateRing=async(change,width)=>{
          const before=cursor(); change(); await until(()=>cursor()!==before,'Cursor did not update'); await checkRing(width);
        };
        for (const width of [16,8]) await updateRing(()=>{ select.value=String(width); select.dispatchEvent(new Event('change',{bubbles:true})); },width);
        const frame=drawing.parentElement, previous=frame.style.maxWidth;
        await updateRing(()=>{frame.style.maxWidth='50%'},8); await updateRing(()=>{frame.style.maxWidth=previous},8);
        assert(!drawing.querySelector('.sketch-eraser-trace'),'Hover drew an eraser trace');
        assert(!getComputedStyle(select).cursor.startsWith('url('),'Eraser cursor leaked into the toolbar');`)
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y: y - 4, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y: y + 36, modifiers: ['leftbuttondown'] })
      await js(win, `const trace=await wait('.sketch-eraser-trace');
        assert(Number(getComputedStyle(trace).opacity)>0 && Number(getComputedStyle(trace).opacity)<1,'Trace should be translucent');
        assert(getComputedStyle(trace.firstElementChild).strokeWidth==='8px','Trace should match brush size');
        assert(document.querySelectorAll('.sketch-drawing [data-mark]').length===${strokeCount},'Marks erased before release');`)
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y: y + 36, button: 'left', clickCount: 1 })
      await js(win, `await until(()=>!document.querySelector('.sketch-eraser-trace, .sketch-drawing [data-mark]'),'Sweep should erase every crossed stroke and clear its trace');
        document.querySelector('[aria-label="Undo sketch edit"]').click();
        await until(()=>document.querySelectorAll('.sketch-drawing [data-mark]').length===${strokeCount},'Undo should restore the entire sweep');`)
      const [rx, ry] = await js(win, `const r=document.querySelector('.sketch-resize').getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)];`)
      drag(rx, ry, 0, 20)
      await js(win, `await until(()=>Number(document.querySelector('.sketch-drawing').viewBox.baseVal.height)>300,'Resize failed');`)
      writeFileSync('/tmp/opencourse-notebook-sketch.png', (await win.webContents.capturePage()).toPNG())
      await js(win, `document.querySelector('.writing-page-title').focus();await until(()=>!document.querySelector('.sketch-canvas'),'Click away did not dismiss sketch');`)
      await js(win, `document.querySelector('.writing-new-page').click(); await until(()=>document.querySelectorAll('.writing-page-link').length===2,'Page switch failed');
        document.querySelector('.writing-page-link').click(); await until(()=>document.querySelectorAll('.sketch-preview img').length===2,'Page lost sketches');`)
      const page = getWritingPage(notebook.id, notebook.selectedPageId)
      const asset = sketchLine.exec(page.markdown.split('\n')[1])?.[1]
      if (!asset) throw new Error('Sketch did not occupy its own line')
      const model = readNotebookSketch(notebook.id, asset), start = model.marks[0]?.points[0]
      if (!start || Math.abs(start[0] - 400) > 3 || Math.abs(start[1] - 180) > 3 || model.height <= 300) throw new Error('Saved geometry does not match the narrow drawing surface')
      if (model.marks.length !== strokeCount || model.marks.some((mark, index) => {
        const dx = mark.points.at(-1)![0] - mark.points[0][0]
        return mark.kind !== 'brush' || (index % 2 ? dx >= -100 : dx <= 100)
      })) throw new Error('Rapid sketch strokes were lost or reordered on save')
      await closeWritingWindows()
      win = await open()
      const custom = await js(main, `const result=await window.opencourse.importThemePath(${JSON.stringify(join(specResourcesDir(), 'opencourse-example-theme.zip'))}); return result.theme.id;`)
      for (const theme of [WHITE_THEME_ID, custom, null]) {
        const before = await js(win, `await until(()=>document.querySelectorAll('.sketch-preview img').length===2,'Missing sketches'); return document.querySelectorAll('.sketch-preview img')[1].src;`)
        await js(main, `await window.opencourse.applyTheme(${JSON.stringify(theme)});`)
        const [titleX, titleY] = await js(win, `await until(()=>{const img=document.querySelectorAll('.sketch-preview img')[1];return img && img.src!==${JSON.stringify(before)}},'Image did not follow theme');
          const img=document.querySelectorAll('.sketch-preview img')[1], svg=new DOMParser().parseFromString(decodeURIComponent(img.src.split(',').slice(1).join(',')), 'image/svg+xml');
          img.click(); const drawing=await wait('.sketch-drawing'), swatch=document.createElement('span'); document.body.append(swatch);
          assert(drawing.querySelectorAll('[data-mark]').length===${strokeCount},'Reopened sketch lost rapid strokes');
          swatch.style.color=svg.querySelector('g').getAttribute('stroke');
          assert(getComputedStyle(swatch).color===getComputedStyle(drawing.querySelector('g')).stroke,'Preview ink '+getComputedStyle(swatch).color+' differs from editor '+getComputedStyle(drawing.querySelector('g')).stroke+'; theme '+${JSON.stringify(theme)});
          swatch.style.color=svg.querySelector('rect').getAttribute('fill');
          assert(getComputedStyle(swatch).color===getComputedStyle(drawing.parentElement).backgroundColor,'Preview background differs from editor');
          swatch.remove(); const title=document.querySelector('.writing-page-title').getBoundingClientRect();
          return [Math.round(title.x + title.width / 2), Math.round(title.y + title.height / 2)];`)
        win.webContents.sendInputEvent({ type: 'mouseDown', x: titleX, y: titleY, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: titleX, y: titleY, button: 'left', clickCount: 1 })
        await js(win, `await until(()=>document.querySelectorAll('.sketch-preview img').length===2,'Click-away preview missing for '+${JSON.stringify(theme)});`)
      }
      if (getWritingPage(notebook.id, notebook.selectedPageId).revision !== page.revision) throw new Error('Theme switch changed the page revision')
      return 'Native shortcut and mouse, scaled coordinates, resize, page and window reopen, Panda/custom/Bond previews'
    } finally {
      await js(main, `await window.opencourse.applyTheme(null); await window.opencourse.writing.setSketchSettings(${JSON.stringify(DEFAULT_SKETCH)});`)
      await closeWritingWindows()
    }
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
