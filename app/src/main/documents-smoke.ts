import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { fixturePdf } from '../../tests/helpers/pdf'
import { getDocument, importDocument, searchDocument } from './documents'
import { appendDocumentMessage, selectDocumentChats } from './document-chatdb'
import { createDocumentChat } from './document-chat'

interface Result { name: string; ok: boolean; detail: string }
const HELPERS = `
 const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
 const visible = element => element && element.checkVisibility({ visibilityProperty: true });
 const find = selector => [...document.querySelectorAll(selector)].find(visible);
 const wait = async selector => { for(let n=0;n<500;n++){const element=find(selector);if(element)return element;await sleep(25);}throw new Error('No visible '+selector); };
 const assert = (value,message) => {if(!value)throw new Error(message)};
`
/** Actual local PDF extraction, canvas/text rendering and UI interactions, in an isolated profile. */
export async function documentsChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const run = async (name: string, code: string): Promise<void> => {
    try { results.push({ name, ok: true, detail: String(await win.webContents.executeJavaScript(`(async()=>{${HELPERS}${code}})()`)) }) }
    catch (error) { results.push({ name, ok: false, detail: String(error) }) }
  }
  const root = mkdtempSync(join(tmpdir(), 'opencourse-pdf-smoke-')), path = join(root, 'Local reading.pdf')
  try {
    writeFileSync(path, fixturePdf({ pages: 40 }))
    const imported = await importDocument(path)
    if (imported.status !== 'ok') throw new Error('PDF import failed')
    const id = imported.document.id
    for (let attempt = 0; attempt < 600 && getDocument(id).status === 'indexing'; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
    const document = getDocument(id)
    results.push({ name: 'documents: local PDF worker indexes pages and bookmarks', ok: document.status === 'ready' && document.pages === 40 && document.sections.length === 40 && searchDocument(id, 'bounded passage').hits.length > 0, detail: JSON.stringify({ status: document.status, pages: document.pages, sections: document.sections.length, error: document.error }) })
    await run('documents: workspace, three panes and selectable PDF text load', `
      document.querySelector('[data-section="documents"]').click();
      const card=await wait('.document-card-open');card.click();
      await wait('.pdf-page .textLayer span');
      await wait('.document-sidebar .document-section');await wait('.document-reader .sidechat');
      assert(document.querySelectorAll('.section-switch button').length===3,'Missing workspace');
      assert([...document.querySelectorAll('.section-switch button')].map(button=>button.textContent.trim()).join(',')==='Courses,Documents,Coach','Wrong switch order');
      const canvas=await wait('.pdf-page canvas[data-rendered="true"]');
      assert(canvas.width>0,'Canvas is empty');
      assert(document.querySelectorAll('.pdf-page').length<=7,'Too many pages rendered');
      const text=await wait('.pdf-page canvas[data-rendered="true"] + .textLayer span');
      const box=text.getBoundingClientRect();assert(box.width>0&&box.height>0,'Text layer has no geometry');
      return '40-page PDF: headings left, PDF center, Ask right; only nearby pages mounted';
    `)
    await run('documents: rename the sidebar title inline and retain it in the library', `
      const change=async title=>{const field=await wait('.document-title-edit input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,title);field.dispatchEvent(new Event('input',{bubbles:true}));await sleep(25);return field;};
      (await wait('.document-title')).click();
      const editing=await wait('.document-title-edit input');
      for(let n=0;n<40 && document.activeElement!==editing;n++)await sleep(25);
      assert(document.activeElement===find('.document-title-edit input'),'Title was not focused');
      await change('Natural pedagogy');find('.document-title-edit').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      assert((await wait('.document-title')).textContent==='Natural pedagogy','Rename did not save');
      find('.document-title').click();const cancelled=await change('Discard this edit');cancelled.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      assert((await wait('.document-title')).textContent==='Natural pedagogy','Escape did not cancel');
      find('.document-title').click();const blurred=await change('Natural pedagogy PDF');blurred.blur();
      assert((await wait('.document-title')).textContent==='Natural pedagogy PDF','Blur did not save');
      [...document.querySelectorAll('.titlebar .crumbs a')].find(visible).click();
      const card=await wait('.document-card-open');assert(card.textContent.includes('Natural pedagogy PDF'),'Library lost renamed title');card.click();
      assert((await wait('.document-title')).textContent==='Natural pedagogy PDF','Reopened reader lost title');
      await wait('.pdf-page canvas[data-rendered="true"] + .textLayer span');
      return 'Click title to edit; Enter saves, Escape cancels, blur saves; library and reader retain it';
    `)
    await run('documents: select text and attach it to Ask', `
      const span=await wait('.textLayer span'),range=document.createRange();range.selectNodeContents(span);
      window.getSelection().removeAllRanges();window.getSelection().addRange(range);
      span.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      (await wait('.ask-about')).click();
      const quote=await wait('.sidechat-quote');assert(quote.textContent.includes('From the document'),'Wrong quote source');
      assert(quote.textContent.includes('Page 1'),'Quote lost its page');
      assert(CSS.highlights.has('document-ask-quote'),'Quote not marked');
      return 'Selected PDF text is attached with its page; highlight persists in Ask';
    `)
    await run('documents: bookmark navigation, page virtualization and Find work', `
      [...document.querySelectorAll('.document-section')].find(button=>button.textContent.includes('Chapter 30')).click();
      await sleep(200);assert(find('#document-page').value==='30','Bookmark did not jump');
      assert(document.querySelectorAll('.pdf-page').length<=8,'Old pages not virtualized');
      assert(find('.sidechat-quote'),'Quote lost after navigation');
      [...document.querySelectorAll('.document-toolbar button')].find(button=>button.textContent==='Find').click();
      const field=await wait('.document-find input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'bounded passage');field.dispatchEvent(new Event('input',{bubbles:true}));
      const hit=await wait('.document-search-hit');hit.click();await sleep(100);
      assert(Number(find('#document-page').value)>=1,'Search did not navigate');
      find('[aria-label="Close document search"]').click();
      return 'Bookmark jumps to page 30; indexed Find results navigate to pages';
    `)
    await run('documents: progress is manual and workspace switches preserve reader and draft', `
      const reader=find('.pdf-scroll'),old=reader.scrollTop;
      const field=find('.sidechat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'An unsent document question');field.dispatchEvent(new Event('input',{bubbles:true}));
      const markedPage=Number(find('#document-page').value);
      find('.document-reading-progress .action-button').click();await sleep(100);
      assert(find('[aria-label="Reading progress"]').value===markedPage,'Progress did not save');
      document.querySelector('[data-section="coach"]').click();await sleep(100);
      document.querySelector('[data-section="documents"]').click();await sleep(100);
      assert(find('.pdf-scroll')===reader,'Reader was remounted');
      assert(Math.abs(reader.scrollTop-old)<3,'Reading position lost');
      assert(find('.sidechat-input').value==='An unsent document question','Draft lost');
      return 'Marked reading progress, reading position, quote and chat draft retained';
    `)
    // Seed a completed answer as a deterministic stand-in for the separate mocked AI tests.
    const chat = createDocumentChat(id, 1)
    appendDocumentMessage(chat.id, { role: 'user', text: 'Explain page five', at: new Date().toISOString() })
    appendDocumentMessage(chat.id, { role: 'assistant', text: 'Page five discusses bounded retrieval.', localSources: [{ kind: 'document', documentId: id, page: 5, title: 'Local reading · page 5' }], at: new Date().toISOString() })
    await run('documents: answer source buttons navigate to the cited page', `
      // Reopen to fetch the new persisted conversation without a network request.
      [...document.querySelectorAll('.titlebar .crumbs a')].find(visible).click();(await wait('.document-card-open')).click();
      const source=await wait('.chat-local-sources button');source.click();
      await wait('.pdf-page[data-pdf-page="5"] canvas[data-rendered="true"]');
      for(let n=0;n<200 && find('#document-page')?.value!=='5';n++)await sleep(25);
      assert(find('#document-page').value==='5','Answer source did not navigate');
      assert(find('.pdf-scroll').scrollTop>0,'Source did not scroll the PDF');
      return 'Local page citation opens page 5';
    `)
    results.push({ name: 'documents: document conversations remain separate from courses', ok: selectDocumentChats(id).length > 0, detail: 'Separate document chat tables; shared Ask AI settings' })
    await win.webContents.capturePage().then(image => image.toPNG()).then(bytes => writeFileSync(join(tmpdir(), 'opencourse-documents-smoke.png'), bytes))
  } finally { rmSync(root, { recursive: true, force: true }) }
  return results
}
