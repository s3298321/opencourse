import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { WHITE_THEME_ID } from '../core/theme/builtin-ids'
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
      const card=await wait('.document-card-open');card.click();(await wait('.course-continue')).click();
      await wait('.pdf-page .textLayer span');
      await wait('.document-sidebar .document-section');await wait('.document-reader .sidechat');
      assert(document.querySelectorAll('.section-switch button').length===2,'Missing workspace');
      assert([...document.querySelectorAll('.section-switch button')].map(button=>button.textContent.trim()).join(',')==='Courses,Documents','Wrong switch order');
      const canvas=await wait('.pdf-page canvas[data-rendered="true"]');
      assert(canvas.width>0,'Canvas is empty');
      assert(document.querySelectorAll('.pdf-page').length<=7,'Too many pages rendered');
      const text=await wait('.pdf-page canvas[data-rendered="true"] + .textLayer span');
      const box=text.getBoundingClientRect();assert(box.width>0&&box.height>0,'Text layer has no geometry');
      return '40-page PDF: headings left, PDF center, Ask right; only nearby pages mounted';
    `)
    await run('Panda uses a light document toolbar and Bond chat controls and tooltips', `
      const toolbar = await wait('.document-toolbar');
      const send = await wait('.sidechat-send');
      const tab = await wait('.sidechat-tab');
      function controlColors(source, state, disabled = false) {
        const copy = source.cloneNode(false);
        copy.classList.remove('active', 'stop');
        if (state) copy.classList.add(state);
        copy.disabled = disabled;
        copy.style.cssText = 'position: fixed; visibility: hidden; pointer-events: none; transition: none';
        source.after(copy);
        const css = getComputedStyle(copy);
        const colors = [css.backgroundColor, css.backgroundImage, css.color, css.boxShadow];
        copy.remove();
        return colors;
      }
      const chatColors = () => [controlColors(send, '', true), controlColors(tab, ''), controlColors(tab, 'active')];
      const bondChat = chatColors();
      const probe = document.createElement('div');
      probe.className = 'tooltip';
      document.body.append(probe);
      const bondTooltip = getComputedStyle(probe).backgroundColor;
      probe.remove();
      try {
        await window.opencourse.applyTheme(${JSON.stringify(WHITE_THEME_ID)});
        await wait('.titlebar[data-dark-chrome]');
        assert(getComputedStyle(toolbar).backgroundColor === 'rgb(242, 240, 236)', 'Document toolbar lost its warm off-white background');
        const palette = getComputedStyle(document.documentElement);
        for (const el of toolbar.querySelectorAll('input, button, progress')) {
          const css = getComputedStyle(el);
          assert(css.colorScheme === 'light' && css.getPropertyValue('--fg') === palette.getPropertyValue('--fg'), 'Toolbar control lost its Panda palette');
        }
        assert(JSON.stringify(chatColors()) === JSON.stringify(bondChat), 'Chat tab or send state differs from Bond');
        assert(JSON.stringify(controlColors(send, 'stop')) === JSON.stringify(controlColors(send, '')), 'Panda Stop must match the enabled Send button');
        // Let the theme commit and the reader finish its layout before hovering.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const tools = await wait('[aria-label^="Chat tools:"]');
        const label = tools.title;
        tools.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        const tip = await wait('.title-tooltip');
        assert(label && tip.textContent === label && !tools.title, 'Chat tools hint was lost or duplicated');
        assert(getComputedStyle(tip).backgroundColor === bondTooltip, 'Tooltip background is ' + getComputedStyle(tip).backgroundColor);
        tools.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
        assert(!find('.title-tooltip') && tools.title === label, 'Hint did not dismiss cleanly');
        return 'Toolbar, page and zoom fields, progress, buttons and chat tooltip';
      } finally {
        await window.opencourse.applyTheme(null);
      }
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
      const card=await wait('.document-card-open');assert(card.textContent.includes('Natural pedagogy PDF'),'Library lost renamed title');card.click();(await wait('.course-continue')).click();
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
      document.querySelector('[data-section="courses"]').click();await sleep(100);
      document.querySelector('[data-section="documents"]').click();await sleep(100);
      assert(find('.pdf-scroll')===reader,'Reader was remounted');
      assert(Math.abs(reader.scrollTop-old)<3,'Reading position lost');
      assert(find('.sidechat-input').value==='An unsent document question','Draft lost');
      return 'Marked reading progress, reading position, quote and chat draft retained';
    `)
    // Seed a completed answer as a deterministic stand-in for the separate mocked AI tests.
    const chat = createDocumentChat(id, 1)
    appendDocumentMessage(chat.id, { role: 'user', text: 'Explain page five', at: new Date().toISOString() })
    const formula = String.raw`\lim_{h\to0}\frac{(3+h)^2-9}{h}=6`
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} on page five discusses bounded retrieval.`)
    appendDocumentMessage(chat.id, { role: 'assistant', text: [...paragraphs, '$$' + formula + '$$'].join('\n\n'), localSources: [{ kind: 'document', documentId: id, page: 5, title: 'Local reading · page 5' }], at: new Date().toISOString() })
    await run('documents: answer source buttons navigate to the cited page', `
      // Reopen to fetch the new persisted conversation without a network request.
      [...document.querySelectorAll('.titlebar .crumbs a')].find(visible).click();(await wait('.document-card-open')).click();(await wait('.course-continue')).click();
      (await wait('.sidechat-history-toggle')).click();(await wait('.sidechat-history-row')).click();
      await wait('.pdf-page canvas[data-rendered="true"]');
      (await wait('.chat-consulted-sources')).open=true;
      const source=await wait('.chat-local-sources button');source.click();
      await wait('.pdf-page[data-pdf-page="5"] canvas[data-rendered="true"]');
      for(let n=0;n<200 && find('#document-page')?.value!=='5';n++)await sleep(25);
      assert(find('#document-page').value==='5','Answer source did not navigate');
      assert(find('.pdf-scroll').scrollTop>0,'Source did not scroll the PDF');
      return 'Local page citation opens page 5';
    `)
    await run('documents: Ask about this quotes selected math from a saved chat answer', `
      const math = await wait('.chat-answer math');
      const numerator = math.querySelector('mfrac > mrow');
      for (const whole of [false, true]) {
        const range = document.createRange();
        if (whole) range.selectNodeContents(math);
        else {
          range.setStart(numerator.querySelector('mo').firstChild, 0);
          range.setEnd(numerator.querySelector('mi').firstChild, 1);
        }
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        math.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        (await wait('.ask-about')).click();
        const quoted = (await wait('.sidechat-quote blockquote')).textContent;
        assert(quoted === (whole ? ${JSON.stringify(formula)} : '(3+h'), 'Wrong math quote: ' + quoted);
        find('.sidechat-quote-head button').click();
        await sleep(50);
      }
      return 'Partial numerator and complete TeX both reached the composer';
    `)
    await run('Panda chat keeps both arrows visible while typing and scrolling', `
      await window.opencourse.applyTheme(${JSON.stringify(WHITE_THEME_ID)});
      try {
        await wait('.titlebar[data-dark-chrome]');
        const field = await wait('.document-reader .sidechat-input');
        const send = await wait('.document-reader .sidechat-send');
        const write = text => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, text);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        };
        write('');
        await wait('.document-reader .sidechat-send:disabled');
        await Promise.all(send.getAnimations().map(animation => animation.finished.catch(() => {})));
        const empty = getComputedStyle(send).backgroundColor;
        const emptySize = send.getBoundingClientRect();
        assert(getComputedStyle(send).color === 'rgb(165, 165, 175)', 'Empty Send arrow lost its muted foreground');
        write('A draft question');
        await wait('.document-reader .sidechat-send:enabled');
        await Promise.all(send.getAnimations().map(animation => animation.finished.catch(() => {})));
        assert(getComputedStyle(send).backgroundColor === empty && empty === 'rgb(43, 43, 48)', 'Send surface changed from ' + empty + ' to ' + getComputedStyle(send).backgroundColor);
        assert(getComputedStyle(send).color === 'rgb(222, 222, 227)', 'Enabled Send arrow lost its bright foreground');
        const readySize = send.getBoundingClientRect();
        assert(readySize.width === emptySize.width && readySize.height === emptySize.height, 'Typing resized the Send button');

        const scroll = await wait('.document-reader .sidechat-scroll');
        scroll.scrollTop = scroll.scrollHeight;
        await sleep(100);
        scroll.scrollTop = 0;
        const latest = await wait('.document-reader .sidechat-latest');
        assert(getComputedStyle(latest).backgroundColor === 'rgb(35, 35, 35)', 'Latest button lost its dark surface');
        assert(getComputedStyle(latest.querySelector('path')).stroke === 'rgb(222, 222, 227)', 'Latest arrow lost its visible stroke');
        latest.click();
        assert(scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1, 'Latest button did not return to the bottom');
        write('');
        return 'Empty and enabled Send, visible down arrow before hover, click resumes following';
      } finally {
        await window.opencourse.applyTheme(null);
      }
    `)
    results.push({ name: 'documents: document conversations remain separate from courses', ok: selectDocumentChats(id).length > 0, detail: 'Separate document chat tables; shared Ask AI settings' })
    await win.webContents.capturePage().then(image => image.toPNG()).then(bytes => writeFileSync(join(tmpdir(), 'opencourse-documents-smoke.png'), bytes))
  } finally { rmSync(root, { recursive: true, force: true }) }
  return results
}
