/** Real preview, review and management UI on the flashcard smoke's disposable profile. */
import { createChat } from './chat'
import { appendMessage } from './chatdb'
import { getCourse } from './courses'
import { createFlashcardPreview } from './personal-cards'

type Run = (name: string, source: string) => Promise<unknown>
export async function runPersonalCardSmoke(courseId: string, run: Run, shot: (name: string) => Promise<void>): Promise<void> {
  const course = getCourse(courseId)!, module = course.modules.find(m => m.type !== 'project')!
  const lesson = module.lessons![0], chat = createChat(course.courseId, { moduleId: module.slug, lessonId: lesson.slug })
  const turn = appendMessage(chat.id, { role: 'user', text: 'Personal flashcards please', at: new Date().toISOString() })
  createFlashcardPreview('chat', chat.id, turn, 'smoke-personal', { cards: [{ question: 'What is a lexical closure?', answer: 'A function together with its lexical environment.' }] })
  await run('approve a personal card from the real chat preview', `
    (await wait(()=>[...document.querySelectorAll('.course-card')].find(card=>card.textContent.includes('The OpenCourse example course')))).click(); await wait(()=>document.querySelector('.detail'));
    if((await window.opencourse.getReviewSummary(window.__FLASHCARD_COURSE)).personalCount!==0) throw new Error('Preview saved without approval');
    (button('Continue') || button('Start course')).click(); await wait(()=>document.querySelector('.lesson-body'));
    const toggle=document.querySelector('[aria-label="Ask about this lesson"]'); if(toggle) toggle.click();
    await wait(()=>button('History')); button('History').click();
    (await wait(()=>[...document.querySelectorAll('.sidechat-history-row')].find(row=>row.textContent.includes('Personal flashcards please')))).click();
    await wait(()=>document.querySelector('.personal-card-preview'));
    if(!document.querySelector('.personal-card-preview').textContent.includes('lexical environment')) throw new Error('Preview is missing the answer');
    (await wait(()=>button('Save all'))).click(); await wait(()=>document.querySelector('.personal-card-preview [role="status"]')?.textContent.includes('saved'));
    if((await window.opencourse.getReviewSummary(window.__FLASHCARD_COURSE)).personalCount!==1) throw new Error('Personal count missing');
    return 'Question and answer preview; explicit Save all';
  `)
  await shot('personal-preview')
  await run('review personal cards without completing a lesson', `
    document.querySelector('.crumbs a').click(); await wait(()=>document.querySelector('.detail'));
    const summary=await window.opencourse.getReviewSummary(window.__FLASHCARD_COURSE);
    if(summary.eligible!==1 || summary.personalCount!==1) throw new Error('Personal card should be the only eligible card');
    button('Review').click(); await wait(()=>document.querySelector('.review-question'));
    if(!document.querySelector('.review-question').textContent.includes('lexical closure') || document.querySelector('.review-answer')) throw new Error('Wrong card or leaked answer');
    document.querySelector('.review-reveal button').click(); await wait(()=>document.querySelector('.review-answer')?.textContent.includes('lexical environment'));
    document.querySelector('.review-ratings [aria-label="Good"]').click(); await wait(()=>document.querySelector('.review-complete'));
    if((await window.opencourse.getReviewSummary(window.__FLASHCARD_COURSE)).practiced!==1) throw new Error('Personal review was not scheduled');
    return 'Immediate eligibility, reveal and shared scheduling';
  `)
  await shot('personal-reviewed')
  await run('manage personal cards without altering authored cards', `
    button('Back to course').click(); await wait(()=>document.querySelector('.detail'));
    (await wait(()=>button('1 personal'))).click(); const dialog=await wait(()=>document.querySelector('.personal-card-dialog[open]'));
    if(dialog.textContent.includes('lexical environment')) throw new Error('Management list leaked the answer');
    dialog.querySelector('li button').click(); await wait(()=>button('0 personal'));
    dialog.querySelector('[aria-label="Close personal flashcards"]').click();
    const saved=await window.opencourse.getAuthoringCourse(window.__FLASHCARD_COURSE);
    if(JSON.stringify(saved.document.manifest).includes('lexical closure')) throw new Error('Personal card entered authored content');
    return 'Question-only popup, deletion, authored content unchanged';
  `)
  await shot('personal-deleted')
}
