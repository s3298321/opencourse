import { authoringRunState, beginAuthoringTurn } from './authoring-state'
import { runAuthoringTool } from './authoring-tools'
import { getAuthoringCourse } from './course-authoring'
/** The authoring journey uses real React controls and the production save/export services. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Menu, type BrowserWindow } from 'electron'
import { exportCourseZipPath } from './course-authoring'
import { extractArchive } from './unzip'
interface Result { name: string; ok: boolean; detail: string }
export async function editorSmoke(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const staging = mkdtempSync(join(tmpdir(), 'opencourse-editor-smoke-'))
  const run = async (name: string, source: string): Promise<unknown> => {
    try {
      const detail = await win.webContents.executeJavaScript(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const wait = async test => { for(let n=0;n<200;n++) { const result=test(); if(result) return result; await sleep(25); } throw new Error('Timed out: '+test.toString()); };
        const visible = element => element?.checkVisibility({ visibilityProperty: true });
        const find = selector => [...document.querySelectorAll(selector)].find(visible);
        const button = text => [...document.querySelectorAll('button')].find(b=>visible(b) && b.textContent.trim()===text);
        const field = async (label,value) => { const input=await wait(()=>document.querySelector('[aria-label="'+label+'"]')); Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); await sleep(30); };
        ${source}
      })()`)
      results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
      return detail
    } catch (error) {
      writeFileSync(join(tmpdir(), 'opencourse-editor-failure.png'), (await win.webContents.capturePage()).toPNG())
      results.push({ name, ok: false, detail: String(error) }); throw error
    }
  }
  const pointerDrag = async (dragPoints: { from: { x: number; y: number }; to: { x: number; y: number } }): Promise<void> => {
    // Intercept Chromium's drag so the test doesn't depend on macOS's native drag loop.
    win.webContents.debugger.attach('1.3')
    try {
      await win.webContents.debugger.sendCommand('Input.setInterceptDrags', { enabled: true })
      let dragData: unknown
      const onMessage = (_event: Electron.Event, method: string, params: { data?: unknown }): void => { if (method === 'Input.dragIntercepted') dragData = params.data }
      win.webContents.debugger.on('message', onMessage)
      try {
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...dragPoints.from })
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...dragPoints.from })
        for (let step = 1; step <= 10; step++) {
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: Math.round(dragPoints.from.x + (dragPoints.to.x - dragPoints.from.x) * step / 10), y: Math.round(dragPoints.from.y + (dragPoints.to.y - dragPoints.from.y) * step / 10) })
        }
        for (let n = 0; n < 50 && !dragData; n++) await new Promise(resolve => setTimeout(resolve, 20))
        if (!dragData) throw new Error('Chromium did not start the palette drag')
        for (const type of ['dragEnter', 'dragOver', 'dragOver', 'drop']) {
          await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...dragPoints.to, data: dragData })
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      } finally { win.webContents.debugger.off('message', onMessage) }
    } catch (error) { results.push({ name: 'editor: Chromium pointer drag', ok: false, detail: String(error) }); throw error }
    finally { win.webContents.debugger.detach() }
  }
  try {
    await run('editor: a new course is unsaved until Save, and leaving asks first', `
      (await wait(()=>find('.titlebar [data-section="courses"]'))).click(); await sleep(100);
      for(let n=0;n<4 && !find('.library:not(.documents-library):not(.coach)');n++) {find('.titlebar .crumbs a')?.click(); await sleep(200);}
      await wait(()=>find('.library:not(.documents-library):not(.coach)'));
      button('Create course').click(); await wait(()=>document.querySelector('.course-editor'));
      const state=await wait(()=>document.querySelector('.author-save-state'));
      if(state.textContent!=='Not saved yet') throw new Error('A new course does not say it is unsaved: '+state.textContent);
      for (const label of ['Discard draft','Save & export ZIP…','Save course']) if (button(label)) throw new Error('Old editor action remains: '+label);
      if (!button('Save')) throw new Error('Save is missing');
      await field('Course title','Editor smoke course'); await field('Course slug','editor-smoke');
      button('Add module').click(); await field('Module title','First module');
      [...document.querySelectorAll('.outline-add')].find(b=>b.textContent.includes('Add lesson')).click(); await field('Lesson title','First lesson');
      button('Elements').click();
      const transfer = new DataTransfer();
      document.querySelector('[aria-label="Drag Text"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer})); await sleep(30);
      document.querySelector('.lesson-drop-zone.append').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer})); await sleep(30); await field('Block slug','lesson-text'); await field('Markdown content','## Authored in the app\\n\\nStable identities survive edits.');
      await wait(()=>document.querySelector('.lesson-element [aria-label="Block slug"]')?.value==='lesson-text');
      button('Outline').click();
      await wait(()=>document.querySelector('.author-preview').textContent.includes('Stable identities'));
      await wait(()=>document.querySelector('.author-save-state').textContent==='Unsaved changes');
      await sleep(300);
      if((await window.opencourse.listCourses()).some(c=>c.title==='Editor smoke course')) throw new Error('An unsaved course reached the library');
      const parkedEditor = document.querySelector('.course-editor');
      document.querySelector('.titlebar [data-section="coach"]').click();
      await wait(()=>document.querySelector('.titlebar [data-section="coach"]').getAttribute('aria-checked')==='true');
      if(document.querySelector('.dialog')) throw new Error('Switching halves asked to discard the parked draft');
      document.dispatchEvent(new Event('authoring:save')); await sleep(100);
      if((await window.opencourse.listCourses()).some(c=>c.title==='Editor smoke course')) throw new Error('Hidden editor handled Save');
      const windowUnload = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(windowUnload);
      if(!windowUnload.defaultPrevented) throw new Error('Parked dirty editor did not guard window close');
      document.querySelector('.titlebar .user-chip').click();
      const userMenu=await wait(()=>document.querySelector('.user-menu'));
      [...userMenu.querySelectorAll('.menu-item')].find(b=>/Switch user/.test(b.textContent)).click();
      await wait(()=>document.querySelector('.dialog')); document.querySelector('.dialog-cancel').click(); await sleep(50);
      document.querySelector('.titlebar [data-section="courses"]').click(); await sleep(100);
      if(document.querySelector('.course-editor')!==parkedEditor) throw new Error('Parked editor was remounted');
      document.querySelector('.titlebar .crumbs a').click();
      const dialog=await wait(()=>document.querySelector('.dialog'));
      if(!dialog.textContent.includes('Discard unsaved changes?')) throw new Error('Leaving did not warn');
      document.querySelector('.dialog-cancel').click(); await sleep(80);
      if(document.querySelector('.dialog') || !document.querySelector('.course-editor')) throw new Error('Keep editing left the editor');
      if(!document.querySelector('.author-preview').textContent.includes('Stable identities')) throw new Error('Keep editing lost the edits');
      return 'Unsaved indicator, no library card, Back warns and Keep editing stays';
    `)
    const dragPoints = await run('editor: palette and drop targets are visible', `
      button('Elements').click();
      if(document.querySelector('.elements-palette [aria-label^="Add "]')) throw new Error('Palette still has Add buttons');
      const append=document.querySelector('.lesson-drop-zone.append');
      if(append.getBoundingClientRect().height<100 || getComputedStyle(append).borderTopStyle!=='dashed') throw new Error('Persistent append zone is missing or too small');
      const tab=document.querySelector('.author-sidebar-tabs button');
      if(tab.getBoundingClientRect().height>34 || parseFloat(getComputedStyle(tab).fontSize)>12) throw new Error('Sidebar tabs are not compact');
      window.__EDITOR_DRAG_EVENTS=[];
      for(const type of ['dragstart','dragover','drop','dragend']) document.addEventListener(type,e=>{window.__EDITOR_DRAG_EVENTS.push({type, target:e.target.outerHTML.slice(0,160),dragging:!!document.querySelector('.lesson-workspace.dragging'),effect:e.dataTransfer.effectAllowed,x:e.clientX,y:e.clientY})},true);
      const source=document.querySelector('[aria-label="Drag Text"]'), target=document.querySelector('[data-drop-index="0"]');
      target.scrollIntoView({block:'center'}); await sleep(100);
      const a=source.getBoundingClientRect(), b=target.getBoundingClientRect();
      return {from:{x:Math.round(a.x+a.width/2),y:Math.round(a.y+a.height/2)},to:{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}};
    `) as { from: { x: number; y: number }; to: { x: number; y: number } }
    await pointerDrag(dragPoints)
    await run('editor: palette drag inserts and keyboard reordering preserves existing editors', `
      try { await wait(()=>document.querySelectorAll('.lesson-workspace > .lesson-element').length===2); } catch(e) { throw new Error(e.message+' '+JSON.stringify(window.__EDITOR_DRAG_EVENTS)); }
      const added=document.querySelector('.lesson-workspace > .lesson-element');
      window.__EDITOR_SMOKE_DRAGGED=added.dataset.elementId;
      const input=added.querySelector('[aria-label="Markdown content"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'A second element created by dragging.'); input.dispatchEvent(new Event('input',{bubbles:true})); await sleep(50);
      [...added.querySelectorAll('button')].find(b=>b.textContent==='↓ Move down').click(); await sleep(50);
      if(document.querySelectorAll('.lesson-workspace > .lesson-element')[1]!==added || added.querySelector('[aria-label="Markdown content"]')!==input) throw new Error('Reordering remounted the element editor');
      if(!document.querySelector('.author-preview').textContent.includes('A second element created by dragging.')) throw new Error('Full lesson preview is stale');
      button('Outline').click();
      return 'Native pointer drag inserts text and reordering retains the editor and live preview';
    `)
    const reorderPoints = await run('editor: collapsed elements expose reorder handles', `
      for (const button of document.querySelectorAll('.lesson-element-heading button[aria-expanded="true"]')) button.click();
      await sleep(50);
      const target=document.querySelector('[data-drop-index="0"]'); target.scrollIntoView({block:'center'}); await sleep(100);
      const source=document.querySelectorAll('.lesson-workspace > .lesson-element')[1].querySelector('.element-drag-handle');
      const a=source.getBoundingClientRect(), b=target.getBoundingClientRect();
      return {from:{x:Math.round(a.x+a.width/2),y:Math.round(a.y+a.height/2)},to:{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}};
    `) as { from: { x: number; y: number }; to: { x: number; y: number } }
    await pointerDrag(reorderPoints)
    await run('editor: handle dragging reorders existing elements without changing their identity', `
      await wait(()=>document.querySelector('.lesson-workspace > .lesson-element')?.dataset.elementId===window.__EDITOR_SMOKE_DRAGGED);
      const moved=document.querySelector('.lesson-workspace > .lesson-element');
      [...moved.querySelectorAll('button')].find(b=>b.textContent==='↓ Move down').click(); await sleep(50);
      for (const button of document.querySelectorAll('.lesson-element-heading button[aria-expanded="false"]')) button.click();
      await sleep(50);
      if(document.querySelectorAll('.lesson-workspace > .lesson-element')[1].dataset.elementId!==window.__EDITOR_SMOKE_DRAGGED) throw new Error('Reordering replaced identity');
      return 'Existing elements move using their handles and retain IDs';
    `)
    // ⌘S is a menu accelerator; a synthetic key would only prove the fallback listener.
    const saveItem = Menu.getApplicationMenu()?.getMenuItemById('save-course')
    if (!saveItem?.enabled) throw new Error('Course ▸ Save Course is not enabled while the editor is open')
    saveItem.click()
    const courseId = await run('editor: Course ▸ Save Course (⌘S) saves the course', `
      await wait(()=>document.querySelector('.author-save-state').textContent==='All changes saved');
      const entry=(await window.opencourse.listCourses()).find(c=>c.title==='Editor smoke course');
      if(!entry || entry.draft || !(await window.opencourse.getCourse(entry.courseId))) throw new Error('Saved course is not in the library');
      window.__EDITOR_SMOKE_ID=entry.courseId;
      return entry.courseId;
    `) as string

    let stoppedCleanTurn = false
    const cleanTurn = beginAuthoringTurn(courseId, 'smoke-clean-turn', () => { stoppedCleanTurn = true })
    try {
      await run('editor: a clean running assistant warns before departure and stays running when parked', `
        document.querySelector('.crumbs a').click(); await wait(()=>document.querySelector('.dialog'));
        if(!document.querySelector('.dialog').textContent.includes('The assistant is still working. Leaving stops it.')) throw new Error('Clean running turn had no warning');
        document.querySelector('.dialog-cancel').click(); await sleep(80);
        if(!(await window.opencourse.getAuthoringRunState(window.__EDITOR_SMOKE_ID)).chatId) throw new Error('Cancelling stopped the assistant');
        document.querySelector('[data-section="coach"]').click(); await sleep(80);
        if(document.querySelector('.dialog')) throw new Error('Parking asked to stop the turn');
        document.querySelector('[data-section="courses"]').click(); await sleep(80);
        document.querySelector('.crumbs a').click(); await wait(()=>document.querySelector('.dialog'));
        document.querySelector('.dialog-confirm').click(); await wait(()=>document.querySelector('.library'));
        if((await window.opencourse.getAuthoringRunState(window.__EDITOR_SMOKE_ID)).chatId) throw new Error('Leaving did not stop the turn');
        const card=await wait(()=>[...document.querySelectorAll('.course-card')].find(c=>visible(c) && c.textContent.includes('Editor smoke course')));card.click();
        (await wait(()=>button('Edit course'))).click(); await wait(()=>document.querySelector('.course-editor'));
        return 'Clean running turn confirms; Cancel and parking preserve it; confirmed departure stops it';
      `)
      if (!stoppedCleanTurn || authoringRunState(courseId).chatId !== null) throw new Error('Clean authoring lease survived confirmed departure')
    } finally { cleanTurn.release() }
    await run('editor: Discard leaves the saved course as it was, and a discarded new course leaves nothing', `
      button('Course details').click(); await field('Course title','Unsaved title');
      await wait(()=>document.querySelector('.author-save-state').textContent==='Unsaved changes');
      document.querySelector('.crumbs a').click();
      await wait(()=>document.querySelector('.dialog')); document.querySelector('.dialog-confirm').click();
      await wait(()=>document.querySelector('.library'));
      const saved=await window.opencourse.getAuthoringCourse(window.__EDITOR_SMOKE_ID);
      if(saved.document.manifest.title!=='Editor smoke course' || saved.draft.dirty) throw new Error('Discard changed the saved course');
      await window.opencourse.discardCourseDraft(window.__EDITOR_SMOKE_ID);
      const before=(await window.opencourse.listCourses()).length;
      button('Create course').click(); await wait(()=>document.querySelector('.course-editor'));
      await field('Course title','Thrown away');
      await wait(()=>document.querySelector('.author-save-state').textContent==='Unsaved changes');
      document.querySelector('.crumbs a').click();
      await wait(()=>document.querySelector('.dialog')); document.querySelector('.dialog-confirm').click();
      await wait(()=>document.querySelector('.library'));
      if((await window.opencourse.listCourses()).length!==before) throw new Error('A discarded new course left a library entry');
      [...document.querySelectorAll('.course-card')].find(c=>c.textContent.includes('Editor smoke course')).click(); await wait(()=>button('Edit course')); button('Edit course').click(); await wait(()=>document.querySelector('.course-editor'));
      return 'Saved course untouched; discarded new course gone';
    `)
    await run('editor: stacked lesson editors retain a live preview', `
      document.querySelector('.outline-row[aria-label="First lesson"]').click();
      const input=await wait(()=>document.querySelector('[aria-label="Markdown content"]'));
      if(input.getBoundingClientRect().height<150 || !input.closest('.lesson-element')) throw new Error('Markdown editor is not in the lesson stack');
      const workspace=document.querySelector('.author-form').getBoundingClientRect(), preview=document.querySelector('.author-preview').getBoundingClientRect();
      if(preview.width<250 || preview.left<workspace.right-1) throw new Error('Preview is not beside the workspace');
      if(document.querySelector('.outline-row[aria-label="Text: lesson-text"]')) throw new Error('Blocks remain in outline');
      return 'Stacked editor and full lesson preview side by side';
    `)
    const image = await win.webContents.capturePage()
    writeFileSync(join(tmpdir(), 'opencourse-course-editor.png'), image.toPNG())
    await run('editor: learn, edit, rename and preserve progress', `
      document.querySelector('.crumbs a').click(); await wait(()=>document.querySelector('.library'));
      (await wait(()=>[...document.querySelectorAll('.course-card')].find(c=>c.textContent.includes('Editor smoke course')))).click(); await wait(()=>document.querySelector('.detail'));
      document.querySelector('.lesson-row').click(); await wait(()=>document.querySelector('.lesson-head'));
      if(!document.querySelector('.lesson-head').parentElement.textContent.includes('Stable identities')) throw new Error('Saved content not readable');
      button('Mark lesson completed').click(); await wait(()=>button('Lesson completed'));
      const before=await window.opencourse.getAuthoringCourse(window.__EDITOR_SMOKE_ID); window.__EDITOR_SMOKE_LESSON=before.document.manifest.modules[0].lessons[0].nodeId;
      // A lesson's back link is its course overview, and the overview's is All courses.
      for (let n=0;n<3 && !document.querySelector('.library');n++) { document.querySelector('.titlebar .crumbs a').click(); await sleep(250); }
      await wait(()=>document.querySelector('.library'));
      (await wait(()=>[...document.querySelectorAll('.course-card')].find(c=>c.textContent.includes('Editor smoke course')))).click(); await wait(()=>button('Edit course')); button('Edit course').click(); await wait(()=>document.querySelector('.course-editor'));
      [...document.querySelectorAll('.outline-row')].find(b=>b.textContent.includes('First lesson')).click(); await field('Lesson title','Renamed lesson'); await field('Lesson slug','renamed-lesson');
      button('Save').click(); await wait(()=>document.querySelector('.author-header p[role="status"]').textContent.startsWith('Saved'));
      const after=await window.opencourse.getAuthoringCourse(window.__EDITOR_SMOKE_ID);
      if(after.document.manifest.modules[0].lessons[0].nodeId!==window.__EDITOR_SMOKE_LESSON) throw new Error('Lesson identity changed');
      if(!(await window.opencourse.getProgress(window.__EDITOR_SMOKE_ID)).completedLessons.includes(window.__EDITOR_SMOKE_LESSON)) throw new Error('Completion lost');
      return 'Renamed lesson retains its UUID and completion';
    `)
    await run('editor: AI mode preserves selection and tabs and displays preview beside chat', `
      const selected = document.querySelector('.outline-row.selected').textContent;
      button('AI').click(); await wait(()=>document.querySelector('.authoring-chat .sidechat-input'));
      await wait(()=>document.querySelector('.authoring-chat .sidechat-tab'));
      await sleep(450);
      const form = document.querySelector('.author-form');
      if (getComputedStyle(form).display !== 'none') throw new Error('Manual fields remain visible in AI mode');
      const outline = document.querySelector('.author-outline').getBoundingClientRect();
      const preview = document.querySelector('.author-preview').getBoundingClientRect();
      const chat = document.querySelector('.authoring-chat').getBoundingClientRect();
      if (!(outline.right <= preview.left + 1 && preview.right <= chat.left + 1 && chat.right <= innerWidth + 1)) throw new Error('AI mode columns are incorrectly positioned: '+JSON.stringify({outline:outline.toJSON(),preview:preview.toJSON(),chat:chat.toJSON(),innerWidth}));
      const tab = document.querySelector('.sidechat-tab').textContent;
      button('Manual').click(); button('AI').click();
      if (document.querySelector('.outline-row.selected').textContent !== selected || document.querySelector('.sidechat-tab').textContent !== tab) throw new Error('Selection or chat was reset');
      return 'Outline, preview and chat; selection and tabs survive mode switches';
    `)
    const authored = getAuthoringCourse(courseId)
    const block = authored.draft.manifest.modules[0].lessons![0].blocks[0]
    const lease = beginAuthoringTurn(courseId, 'smoke-agent', () => {})
    try {
      const edited = JSON.parse(await runAuthoringTool(courseId, 'update_element', { ref: block.nodeId, fields: { content: '## AI edited content\n\nGenerated changes are visible immediately.' } }, lease.token, new AbortController().signal))
      if (!edited.ok) throw new Error(edited.error)
      const lessonRef = authored.draft.manifest.modules[0].lessons![0].nodeId
      for (const [name, args] of [
        ['update_element', { ref: lessonRef, fields: { estimated_minutes: 5, objectives: ['Understand the authored lesson'] } }],
        ['add_element', { parent_ref: lessonRef, element: { type: 'quiz', slug: 'preview-quiz', id: 'preview-quiz', kind: 'single', question: 'What is **two plus two**?', options: [{ id: 'three', text: 'Three', correct: false }, { id: 'four', text: 'Four', correct: true }], explanation: 'Two plus two is **four**.' } }],
        ['add_element', { parent_ref: lessonRef, element: { type: 'exercise', slug: 'preview-exercise', id: 'preview-exercise', title: 'Preview exercise', prompt: 'Write a **small program**.', verification_instructions: 'Read its output.', starter_code: 'print(1)', extra_files: [{ path: 'data.txt', content: 'original support' }], solution: 'print(2)' } }]
      ] as const) {
        const result = JSON.parse(await runAuthoringTool(courseId, name, args, lease.token, new AbortController().signal))
        if (!result.ok) throw new Error(result.error)
      }
      await run('editor: AI tools update preview and lock manual fields until the turn finishes', `
        await wait(()=>document.querySelector('.author-preview').textContent.includes('Generated changes are visible immediately'));
        const addModule=button('Add module'); if(!button('Save').disabled || (addModule && !addModule.disabled)) throw new Error('Mutations remain available during AI authoring');
        button('Manual').click();
        if(!document.querySelector('.author-form fieldset').disabled) throw new Error('Manual changes are not locked');
        button('AI').click();
        document.querySelector('.crumbs a').click(); await wait(()=>document.querySelector('.dialog'));
        const warning=document.querySelector('.dialog').textContent;
        if(!warning.includes('Your edits to this course have not been saved.') || !warning.includes('The assistant is still working. Leaving stops it.')) throw new Error('Dirty running turn did not combine both warnings');
        document.querySelector('.dialog-cancel').click();
        if(!(await window.opencourse.getAuthoringRunState(window.__EDITOR_SMOKE_ID)).chatId) throw new Error('Cancelling stopped the running assistant');
        return 'Tool edits update the current draft immediately; departure combines unsaved changes and assistant warnings';
      `)
    } finally { lease.release() }
    await run('editor: complete lesson and quiz previews match learning without writing progress', `
      await wait(()=>document.querySelector('.author-preview .lesson-head') && document.querySelector('.author-preview .exercise .author-preset-files'));
      if(!document.querySelector('.author-preview .objectives').textContent.includes('Understand the authored lesson') || !document.querySelector('.author-preview .quiz input') || !document.querySelector('.author-preview .exercise .author-preset-files')) throw new Error('Full lesson preview is missing lesson content');
      const progress=JSON.stringify(await window.opencourse.getProgress(window.__EDITOR_SMOKE_ID));
      document.querySelector('.outline-row[aria-label="Renamed lesson"]').click();
      await wait(()=>document.querySelector('.outline-row.selected')?.getAttribute('aria-label')==='Renamed lesson');
      if(document.querySelector('.author-preview .feedback') || document.querySelector('.author-preview').textContent.includes('Two plus two is')) throw new Error('Quiz preview reveals answers before checking');
      document.querySelectorAll('.author-preview .quiz input')[1].click(); await sleep(30);
      button('Check answer').click(); await wait(()=>document.querySelector('.author-preview .feedback.ok'));
      if(JSON.stringify(await window.opencourse.getProgress(window.__EDITOR_SMOKE_ID))!==progress) throw new Error('Preview quiz changed learner progress');
      return 'Full lesson header, objectives and block components; interactive quiz with local grading';
    `)
    writeFileSync(join(tmpdir(), 'opencourse-course-editor-quiz.png'), (await win.webContents.capturePage()).toPNG())
    await run('editor: exercise preset files are viewable and editable in the draft', `
      document.querySelector('.outline-row[aria-label="Renamed lesson"]').click();
      await wait(()=>document.querySelector('.author-preview .author-preset-files'));
      if([...document.querySelectorAll('.author-preview button')].some(b=>b.textContent==='Open editor')) throw new Error('Preview offers the learner workbench');
      const progress=JSON.stringify(await window.opencourse.getProgress(window.__EDITOR_SMOKE_ID));
      button('data.txt').click();
      const buffer=await wait(()=>document.querySelector('.author-preview [aria-label="Support file: data.txt"]'));
      if(buffer.getAttribute('contenteditable')!=='false' || !buffer.textContent.includes('original support')) throw new Error('Preset file is not readable in AI preview');
      button('Edit file').click();
      await wait(()=>!document.querySelector('.course-editor').classList.contains('ai-mode'));
      const editor=await wait(()=>document.querySelector('.author-preview [aria-label="Support file: data.txt"][contenteditable="true"]'));
      editor.focus();
      const selection=window.getSelection(); const range=document.createRange(); range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('insertText',false,'edited support in preview');
      await sleep(750);
      const draft=await window.opencourse.getAuthoringCourse(window.__EDITOR_SMOKE_ID);
      const exercise=draft.draft.manifest.modules[0].lessons[0].blocks.find(b=>b.slug==='preview-exercise');
      if(exercise.extra_files[0].content!=='edited support in preview') throw new Error('Preset file edit did not autosave: '+exercise.extra_files[0].content);
      if(JSON.stringify(await window.opencourse.getProgress(window.__EDITOR_SMOKE_ID))!==progress) throw new Error('Preview file editing changed learner progress');
      button('AI').click(); await wait(()=>document.querySelector('.course-editor').classList.contains('ai-mode'));
      await sleep(80);
      return 'Browse preset files; Edit file opens manual mode; changes stay in the edit session until Save';
    `)
    writeFileSync(join(tmpdir(), 'opencourse-course-editor-exercise.png'), (await win.webContents.capturePage()).toPNG())
    await run('editor: selected preview text attaches to the course assistant and stays highlighted', `
      document.querySelector('.outline-row[aria-label="Renamed lesson"]').click();
      await wait(()=>document.querySelector('.outline-row.selected')?.getAttribute('aria-label')==='Renamed lesson');
      await sleep(80);
      const paragraph=await wait(()=>document.querySelector('.author-preview .prose p'));
      const range=document.createRange(); range.selectNodeContents(paragraph);
      const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      paragraph.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      const offer=await wait(()=>button('Ask about this')); offer.click();
      const quote=await wait(()=>document.querySelector('.sidechat-quote'));
      if(!quote.textContent.includes('From the preview') || !quote.textContent.includes('Generated changes')) throw new Error('Preview quote was not attached');
      if(document.activeElement!==document.querySelector('.sidechat-input') || !CSS.highlights.has('ask-quote')) throw new Error('Composer focus lost the preview highlight');
      await sleep(100);
      quote.querySelector('[title="Do not attach this"]').click();
      await wait(()=>!document.querySelector('.sidechat-quote'));
      if(CSS.highlights.has('ask-quote')) throw new Error('Dismissed quote remains highlighted');
      return 'Ask about this attaches the selected preview passage and keeps its highlight until dismissed';
    `)
    await run('editor: modules collapse and lessons remain selected across editing modes', `
      const toggle = label => document.querySelector('.outline-toggle[aria-label="'+label+'"]');
      const previewText = () => [...document.querySelectorAll('.author-preview .prose')].map(element=>element.textContent).join('\\n');
      const preview = previewText();
      if(!document.querySelector('.outline-row[aria-label="First module"] svg.outline-icon')) throw new Error('Module folder icon is missing');
      if(toggle('Collapse Renamed lesson')) throw new Error('Lessons should not have outline children');
      if([...document.querySelectorAll('.outline-row')].some(b=>b.textContent.trim()==='lesson-text')) throw new Error('Collapsed lesson still shows blocks');
      toggle('Collapse First module').click(); await wait(()=>toggle('Expand First module'));
      if(document.querySelector('.outline-row[aria-label="Renamed lesson"]')) throw new Error('Collapsed module still shows lessons');
      button('Manual').click(); await wait(()=>!document.querySelector('.course-editor').classList.contains('ai-mode'));
      if(!toggle('Expand First module')) throw new Error('Mode switch reset collapsed state');
      toggle('Expand First module').click(); await wait(()=>document.querySelector('.outline-row.selected')?.getAttribute('aria-label')==='Renamed lesson');
      if(previewText()!==preview) throw new Error('Collapsing changed the selected preview');
      button('AI').click(); await wait(()=>document.querySelector('.course-editor').classList.contains('ai-mode'));
      return 'Folder icon, module collapse and unchanged lesson selection across modes';
    `)
    writeFileSync(join(tmpdir(), 'opencourse-course-editor-ai.png'), (await win.webContents.capturePage()).toPNG())
    const previousSize = win.getSize()
    try {
      win.setSize(800, 800)
      await run('editor: narrow AI mode keeps preview above chat', `
        await sleep(150);
        const outline = document.querySelector('.author-outline').getBoundingClientRect();
        const preview = document.querySelector('.author-preview').getBoundingClientRect();
        const chat = document.querySelector('.authoring-chat').getBoundingClientRect();
        if(!(outline.right <= preview.left + 1 && chat.top >= preview.bottom - 1 && preview.height > 100 && chat.height > 200 && chat.right <= innerWidth + 1)) throw new Error('Narrow AI layout overflows or hides a pane');
        document.querySelector('.outline-row[aria-label="Renamed lesson"]').click(); await wait(()=>document.querySelector('.author-preview .author-preset-files'));
        button('Edit file').click(); await wait(()=>!document.querySelector('.course-editor').classList.contains('ai-mode'));
        if(getComputedStyle(document.querySelector('.author-preview')).display==='none' || !document.querySelector('.author-preview .cm-content[contenteditable="true"]')) throw new Error('Editing a preset file hides the narrow preview');
        button('AI').click(); await wait(()=>document.querySelector('.course-editor').classList.contains('ai-mode'));
        document.querySelector('.outline-row[aria-label="Renamed lesson"]').click(); await wait(()=>document.querySelector('.outline-row.selected')?.getAttribute('aria-label')==='Renamed lesson'); await sleep(80);
        return 'Preview and chat remain visible; editing preset files keeps the narrow preview open';
      `)
      writeFileSync(join(tmpdir(), 'opencourse-course-editor-ai-narrow.png'), (await win.webContents.capturePage()).toPNG())
    } finally { win.setSize(previousSize[0], previousSize[1]) }
    await run('editor: AI changes become manually editable and save with existing learner identities', `
      button('Manual').click();
      document.querySelector('.outline-row[aria-label="Renamed lesson"]').click();
      const input=await wait(()=>document.querySelector('[aria-label="Markdown content"]'));
      if(!input.value.includes('Generated changes') || input.closest('fieldset').disabled) throw new Error('AI changes are not editable');
      button('Save').click(); await wait(()=>document.querySelector('.author-header p[role="status"]').textContent.startsWith('Saved'));
      if(!(await window.opencourse.getProgress(window.__EDITOR_SMOKE_ID)).completedLessons.includes(window.__EDITOR_SMOKE_LESSON)) throw new Error('AI edit lost learner progress');
      return 'Shared AI/manual draft saves without regenerating existing identities';
    `)
    const archive = join(staging, 'course.zip')
    await exportCourseZipPath(courseId, archive)
    const extracted = join(staging, 'extracted')
    const extraction = await extractArchive(archive, extracted)
    if (extraction.error) throw new Error(extraction.error)
    const portable = readFileSync(join(extracted, 'course.json'), 'utf8')
    if (/"(?:nodeId|courseId|revision)"/.test(portable)) throw new Error('Local metadata leaked into ZIP')
    await run('editor: export and reimport create fresh identities with no learner state', `
      const imported=await window.opencourse.importCoursePath(${JSON.stringify(archive)});
      if(imported.status!=='ok' || imported.courseId===window.__EDITOR_SMOKE_ID) throw new Error('Import failed or reused identity');
      const document=await window.opencourse.getAuthoringCourse(imported.courseId);
      if(document.document.manifest.modules[0].lessons[0].title!=='Renamed lesson') throw new Error('Edited content lost');
      if(document.document.manifest.modules[0].lessons[0].nodeId===window.__EDITOR_SMOKE_LESSON) throw new Error('Reimport reused lesson ID');
      if((await window.opencourse.getProgress(imported.courseId)).completedLessons.length) throw new Error('Reimport inherited completion');
      await window.opencourse.removeCourse(imported.courseId);
      return 'Format 1.5 ZIP has authored content, fresh IDs, and no progress';
    `)
  } catch { /* individual result reports the failure */ }
  finally { rmSync(staging, { recursive: true, force: true }) }
  return results
}
