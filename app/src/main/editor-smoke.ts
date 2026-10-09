import { beginAuthoringTurn } from './authoring-state'
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
        const button = text => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
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
  try {
    await run('editor: a new course is unsaved until Save, and leaving asks first', `
      (await wait(()=>document.querySelector('.titlebar [data-section="courses"]'))).click(); await wait(()=>document.querySelector('.library'));
      button('Create course').click(); await wait(()=>document.querySelector('.course-editor'));
      const state=await wait(()=>document.querySelector('.author-save-state'));
      if(state.textContent!=='Not saved yet') throw new Error('A new course does not say it is unsaved: '+state.textContent);
      for (const label of ['Discard draft','Save & export ZIP…','Save course']) if (button(label)) throw new Error('Old editor action remains: '+label);
      if (!button('Save')) throw new Error('Save is missing');
      await field('Course title','Editor smoke course'); await field('Course slug','editor-smoke');
      button('Add module').click(); await field('Module title','First module');
      [...document.querySelectorAll('.outline-add')].find(b=>b.textContent.includes('Add lesson')).click(); await field('Lesson title','First lesson');
      [...document.querySelectorAll('.outline-add')].find(b=>b.textContent.includes('Add block')).click(); await field('Block slug','lesson-text'); await field('Markdown content','## Authored in the app\\n\\nStable identities survive edits.');
      await wait(()=>[...document.querySelectorAll('.outline-row')].some(b=>b.textContent.trim()==='lesson-text'));
      await wait(()=>document.querySelector('.author-preview').textContent.includes('Stable identities'));
      await wait(()=>document.querySelector('.author-save-state').textContent==='Unsaved changes');
      await sleep(300);
      if((await window.opencourse.listCourses()).some(c=>c.title==='Editor smoke course')) throw new Error('An unsaved course reached the library');
      document.querySelector('.course-editor').parentElement.querySelector('.crumbs a').click();
      const dialog=await wait(()=>document.querySelector('.dialog'));
      if(!dialog.textContent.includes('Discard unsaved changes?')) throw new Error('Leaving did not warn');
      document.querySelector('.dialog-cancel').click(); await sleep(80);
      if(document.querySelector('.dialog') || !document.querySelector('.course-editor')) throw new Error('Keep editing left the editor');
      if(!document.querySelector('.author-preview').textContent.includes('Stable identities')) throw new Error('Keep editing lost the edits');
      return 'Unsaved indicator, no library card, Back warns and Keep editing stays';
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
    await run('editor: Markdown input fills the available pane', `
      [...document.querySelectorAll('.outline-row')].find(b=>b.textContent.trim()==='lesson-text').click();
      const input=await wait(()=>document.querySelector('[aria-label="Markdown content"]'));
      await sleep(50);
      const pane=document.querySelector('.author-form');
      const rect=input.getBoundingClientRect(), bounds=pane.getBoundingClientRect(), style=getComputedStyle(pane);
      const bottom=bounds.bottom-parseFloat(style.paddingBottom), right=bounds.right-parseFloat(style.paddingRight);
      if(Math.abs(rect.bottom-bottom)>2 || Math.abs(rect.right-right)>2 || rect.height<300) throw new Error('Markdown input does not fill the available pane: '+JSON.stringify({rect:rect.toJSON(),bottom,right}));
      if(getComputedStyle(input).resize!=='none' || document.querySelector('.markdown-toolbar')) throw new Error('Markdown formatting or resizing controls remain');
      return 'Full width and remaining height, no resize handle or formatting toolbar';
    `)
    const image = await win.webContents.capturePage()
    writeFileSync(join(tmpdir(), 'opencourse-course-editor.png'), image.toPNG())
    await run('editor: learn, edit, rename and preserve progress', `
      document.querySelector('.crumbs a').click(); await wait(()=>document.querySelector('.library'));
      (await wait(()=>[...document.querySelectorAll('.course-card')].find(c=>c.textContent.includes('Editor smoke course')))).click(); await wait(()=>document.querySelector('.detail'));
      document.querySelector('.lesson-row').click(); await wait(()=>document.querySelector('.lesson-head'));
      if(!document.querySelector('.lesson-head').parentElement.textContent.includes('Stable identities')) throw new Error('Saved content not readable');
      button('Mark lesson completed').click(); await wait(()=>button('✓ Lesson completed'));
      const before=await window.opencourse.getAuthoringCourse(window.__EDITOR_SMOKE_ID); window.__EDITOR_SMOKE_LESSON=before.document.manifest.modules[0].lessons[0].nodeId;
      document.querySelector('.titlebar [data-section="courses"]').click(); await wait(()=>document.querySelector('.library'));
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
        return 'Tool edits update the current draft immediately and serialize other mutations';
      `)
    } finally { lease.release() }
    await run('editor: complete lesson and quiz previews match learning without writing progress', `
      await wait(()=>document.querySelector('.author-preview .lesson-head') && document.querySelector('.author-preview .exercise .author-preset-files'));
      if(!document.querySelector('.author-preview .objectives').textContent.includes('Understand the authored lesson') || !document.querySelector('.author-preview .quiz input') || !document.querySelector('.author-preview .exercise .author-preset-files')) throw new Error('Full lesson preview is missing lesson content');
      const progress=JSON.stringify(await window.opencourse.getProgress(window.__EDITOR_SMOKE_ID));
      document.querySelector('.outline-row[aria-label="Quiz: preview-quiz"]').click();
      await wait(()=>document.querySelector('.outline-row.selected')?.getAttribute('aria-label')==='Quiz: preview-quiz');
      if(document.querySelector('.author-preview .feedback') || document.querySelector('.author-preview').textContent.includes('Two plus two is')) throw new Error('Quiz preview reveals answers before checking');
      document.querySelectorAll('.author-preview .quiz input')[1].click(); await sleep(30);
      button('Check answer').click(); await wait(()=>document.querySelector('.author-preview .feedback.ok'));
      if(JSON.stringify(await window.opencourse.getProgress(window.__EDITOR_SMOKE_ID))!==progress) throw new Error('Preview quiz changed learner progress');
      return 'Full lesson header, objectives and block components; interactive quiz with local grading';
    `)
    writeFileSync(join(tmpdir(), 'opencourse-course-editor-quiz.png'), (await win.webContents.capturePage()).toPNG())
    await run('editor: exercise preset files are viewable and editable in the draft', `
      document.querySelector('.outline-row[aria-label="Exercise: preview-exercise"]').click();
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
      [...document.querySelectorAll('.outline-row')].find(b=>b.textContent.trim()==='lesson-text').click();
      await wait(()=>document.querySelector('.outline-row.selected').textContent.trim()==='lesson-text');
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
    await run('editor: modules and lessons collapse independently across editing modes', `
      const toggle = label => document.querySelector('.outline-toggle[aria-label="'+label+'"]');
      const preview = document.querySelector('.author-preview').textContent;
      if(!document.querySelector('.outline-row[aria-label="First module"] svg.outline-icon')) throw new Error('Module folder icon is missing');
      toggle('Collapse Renamed lesson').click();
      await wait(()=>toggle('Expand Renamed lesson'));
      if([...document.querySelectorAll('.outline-row')].some(b=>b.textContent.trim()==='lesson-text')) throw new Error('Collapsed lesson still shows blocks');
      toggle('Collapse First module').click(); await wait(()=>toggle('Expand First module'));
      if(document.querySelector('.outline-row[aria-label="Renamed lesson"]')) throw new Error('Collapsed module still shows lessons');
      button('Manual').click(); await wait(()=>!document.querySelector('.course-editor').classList.contains('ai-mode'));
      if(!toggle('Expand First module')) throw new Error('Mode switch reset collapsed state');
      toggle('Expand First module').click(); await wait(()=>toggle('Expand Renamed lesson'));
      toggle('Expand Renamed lesson').click(); await wait(()=>document.querySelector('.outline-row.selected')?.textContent.trim()==='lesson-text');
      if(document.querySelector('.author-preview').textContent!==preview) throw new Error('Collapsing changed the selected preview');
      button('AI').click(); await wait(()=>document.querySelector('.course-editor').classList.contains('ai-mode'));
      return 'Folder icon, independent collapse controls and unchanged selection across modes';
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
        document.querySelector('.outline-row[aria-label="Exercise: preview-exercise"]').click(); await wait(()=>document.querySelector('.author-preview .author-preset-files'));
        button('Edit file').click(); await wait(()=>!document.querySelector('.course-editor').classList.contains('ai-mode'));
        if(getComputedStyle(document.querySelector('.author-preview')).display==='none' || !document.querySelector('.author-preview .cm-content[contenteditable="true"]')) throw new Error('Editing a preset file hides the narrow preview');
        button('AI').click(); await wait(()=>document.querySelector('.course-editor').classList.contains('ai-mode'));
        document.querySelector('.outline-row[aria-label="Text: lesson-text"]').click(); await wait(()=>document.querySelector('.outline-row.selected')?.getAttribute('aria-label')==='Text: lesson-text'); await sleep(80);
        return 'Preview and chat remain visible; editing preset files keeps the narrow preview open';
      `)
      writeFileSync(join(tmpdir(), 'opencourse-course-editor-ai-narrow.png'), (await win.webContents.capturePage()).toPNG())
    } finally { win.setSize(previousSize[0], previousSize[1]) }
    await run('editor: AI changes become manually editable and save with existing learner identities', `
      button('Manual').click();
      [...document.querySelectorAll('.outline-row')].find(b=>b.textContent.trim()==='lesson-text').click();
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
