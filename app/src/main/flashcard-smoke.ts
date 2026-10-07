/** Isolated, offline verification of the real flashcard editor and review UI. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { importCourseZip } from './import'
import { specResourcesDir } from './paths'
import { closeDb, db } from './db'
import { runAuthoringMotionSmoke } from './authoring-motion-smoke'

export async function runFlashcardSmoke(win: BrowserWindow): Promise<void> {
  const output = process.env['OPENCOURSE_FLASHCARD_SMOKE']!
  mkdirSync(output, { recursive: true })
  const results: { name: string; detail: unknown }[] = []
  const run = async (name: string, source: string): Promise<unknown> => {
    const detail = await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const wait = async test => { for(let i=0;i<200;i++) { const value=test(); if(value) return value; await sleep(30); } throw new Error('Timed out: '+test.toString()); };
      const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
      const field = async (label,value) => { const input=await wait(()=>document.querySelector('[aria-label="'+label+'"]')); Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); await sleep(50); };
      ${source}
    })()`)
    results.push({ name, detail })
    console.log(`[flashcards] ${name}: ${JSON.stringify(detail)}`)
    return detail
  }
  const shot = async (name: string): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 300))
    writeFileSync(join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  try {
    await run('create isolated learner', `
      const input=await wait(()=>document.querySelector('.user-card.new input'));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Flashcard learner'); input.dispatchEvent(new Event('input',{bubbles:true}));
      await sleep(50); button('Create').click(); await wait(()=>document.querySelector('.library')); return 'Ready';
    `)
    const imported = await importCourseZip(join(specResourcesDir(), 'opencourse-example-course.zip'))
    if (imported.status !== 'ok') throw new Error(`Import failed: ${JSON.stringify(imported)}`)
    win.webContents.send('courses:changed')
    await win.webContents.executeJavaScript(`window.__FLASHCARD_COURSE = ${JSON.stringify(imported.courseId)}`)
    await run('answer redaction and completed-lesson unlock', `
      (await wait(()=>document.querySelector('.course-card'))).click(); await wait(()=>document.querySelector('.detail'));
      const course=await window.opencourse.getCourse(window.__FLASHCARD_COURSE), lesson=course.modules[0].lessons[0];
      if(lesson.flashcards.length!==2 || lesson.flashcards.some(card=>'answer' in card)) throw new Error('Learner answers leaked');
      if((await window.opencourse.getReviewSummary(course.courseId)).eligible!==0) throw new Error('Cards unlocked before completion');
      await window.opencourse.toggleLesson(course.courseId,course.modules[0].slug,lesson.slug);
      await wait(()=>!button('Review').disabled); window.__FLASHCARD_PROGRESS=await window.opencourse.getProgress(course.courseId); return '2 cards unlocked; answers hidden';
    `)
    await run('create and edit a card in the edit session', `
      button('Edit course').click(); await wait(()=>document.querySelector('.course-editor'));
      [...document.querySelectorAll('.outline-row')].find(b=>b.textContent.trim()==='hello-python').click();
      button('+ Add card').click(); await field('Card archive ID','compile-link'); await field('Question','What joins object files into a program?'); await field('Answer','The **linker** joins object files and resolves symbols.');
      await wait(()=>document.querySelector('.author-save-state').textContent==='Unsaved changes'); await sleep(250);
      const draft=await window.opencourse.getAuthoringCourse(window.__FLASHCARD_COURSE);
      if(draft.draft.manifest.modules[0].lessons[0].flashcards.length!==3) throw new Error('Draft missing card');
      button('Reveal answer').click(); await wait(()=>document.querySelector('.flashcard-preview .review-answer'));
      if(document.querySelector('[aria-label="Move card to lesson"]')) throw new Error('Flashcard lesson switch is still present');
      return 'Card added and previewed without learner rating';
    `)
    await shot('editor')
    await run('AI mode uses assistant creation', `
      button('AI').click(); await wait(()=>document.querySelector('.course-editor.ai-mode'));
      const labels=['+Add block','+ Add card','+ Add lesson','Add module','Add project'];
      if(labels.some(label=>button(label))) throw new Error('Manual creation controls visible in AI mode');
      return 'Creation buttons hidden; outline and flashcard preview retained';
    `)
    await shot('editor-ai')
    const motion = await runAuthoringMotionSmoke(win, imported.courseId, output)
    results.push({ name: 'AI edit animations', detail: motion })
    console.log(`[authoring motion] ${JSON.stringify(motion)}`)
    await run('return to manual creation', `
      button('Manual').click(); await wait(()=>button('+ Add card'));
      return 'Manual creation controls restored';
    `)
    await run('publish and start selected review size', `
      const originalConfirm=window.confirm; window.confirm=()=>true;
      button('Save').click(); await wait(()=>document.querySelector('.author-header p[role="status"]').textContent.startsWith('Saved')); window.confirm=originalConfirm;
      document.querySelector('.crumbs a').click(); await wait(()=>document.querySelector('.library'));
      [...document.querySelectorAll('.course-card')].find(card=>card.textContent.includes('The OpenCourse example course')).click(); await wait(()=>document.querySelector('.detail'));
      const select=document.querySelector('[aria-label="Number of flashcards"]'); if(select.value!=='10') throw new Error('Wrong default'); select.value='20'; select.dispatchEvent(new Event('change',{bubbles:true}));
      await sleep(50); return 'Default 10; selected 20; eligible deck 3';
    `)
    await shot('overview')
    await run('review question and reveal', `
      button('Review').click(); await wait(()=>document.querySelector('.review-question'));
      if(!document.querySelector('.review-card-meta').textContent.includes('of 3')) throw new Error('Small deck not capped');
      if(document.querySelector('.review-answer')) throw new Error('Answer revealed too early'); return 'Question only';
    `)
    await shot('question')
    await run('self-rating and image card', `
      document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true})); await wait(()=>document.querySelector('.review-answer'));
      if(document.querySelectorAll('.review-ratings button').length!==4) throw new Error('Missing ratings');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'1',bubbles:true})); await wait(()=>document.querySelector('.review-image'));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true})); await wait(()=>document.querySelector('.review-answer'));
      return 'Again saved; illustrated card revealed';
    `)
    await shot('answer-image')
    win.setSize(720, 620)
    await shot('answer-narrow')
    await run('narrow-window scroll and rating controls', `
      const content=document.querySelector('.review-content'); content.scrollTop=content.scrollHeight;
      await sleep(100);
      const controls=[...document.querySelectorAll('.review-ratings button')];
      if(content.scrollWidth>content.clientWidth+1 || controls.some(control=>{const rect=control.getBoundingClientRect(); return rect.left<0 || rect.right>innerWidth || rect.bottom>innerHeight;})) throw new Error('Rating controls are unreachable in a narrow window');
      return 'All four ratings visible after scrolling; no horizontal overflow';
    `)
    await shot('answer-narrow-ratings')
    win.setSize(1240, 860)
    await run('finish and preserve lesson progress', `
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'3',bubbles:true})); await wait(()=>document.querySelector('.review-question').textContent.includes('joins object files'));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true})); await wait(()=>document.querySelector('.review-answer'));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'4',bubbles:true})); await wait(()=>document.querySelector('.review-complete'));
      const progress=await window.opencourse.getProgress(window.__FLASHCARD_COURSE);
      if(JSON.stringify(progress)!==JSON.stringify(window.__FLASHCARD_PROGRESS)) throw new Error('Review changed lesson progress');
      const summary=await window.opencourse.getReviewSummary(window.__FLASHCARD_COURSE);
      if(summary.practiced!==3 || summary.new!==0 || !summary.nextDue) throw new Error('Missing schedules'); return summary;
    `)
    await shot('complete')
    const rows = db().prepare('SELECT COUNT(*) AS n FROM flashcard_reviews').get() as { n: number }
    if (rows.n !== 3) throw new Error(`Expected 3 saved ratings, got ${rows.n}`)
    await run('explicit card reset in editor', `
      button('Back to course').click(); await wait(()=>document.querySelector('.detail')); button('Edit course').click(); await wait(()=>document.querySelector('.course-editor'));
      (await wait(()=>document.querySelector('[aria-label="Flashcard: compile-link"]'))).click();
      const originalConfirm=window.confirm; window.confirm=()=>true; (await wait(()=>button('Reset review progress'))).click(); await wait(()=>document.querySelector('.author-header [role="status"]').textContent.includes('Review progress reset')); window.confirm=originalConfirm;
      if((await window.opencourse.getReviewSummary(window.__FLASHCARD_COURSE)).new!==1) throw new Error('Reset failed'); return 'Card reset independently of drafts';
    `)
    writeFileSync(join(output, 'results.json'), JSON.stringify({ ok: true, results }, null, 2))
    closeDb()
    if (process.env['OPENCOURSE_RUN_PROFILE']) rmSync(process.env['OPENCOURSE_RUN_PROFILE'], { recursive: true, force: true })
    app.exit(0)
  } catch (err) {
    console.error('Flashcard smoke failed:', err)
    await shot('failure')
    writeFileSync(join(output, 'results.json'), JSON.stringify({ ok: false, error: String(err), results }, null, 2))
    closeDb()
    if (process.env['OPENCOURSE_RUN_PROFILE']) rmSync(process.env['OPENCOURSE_RUN_PROFILE'], { recursive: true, force: true })
    app.exit(1)
  }
}
