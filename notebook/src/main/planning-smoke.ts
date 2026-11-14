/** Drive the real composer, bridge, database and provider-specific wire formats
 * in the disposable smoke profile. Only model/catalog responses are simulated. */
import { net, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { simulateSubscriptionForSmoke } from './subscription'
import { setAIProfile, setAIProvider, smokeCatalogs } from './ai'
export async function planningSmoke(win: BrowserWindow, connect: () => Promise<void>) {
  await connect()
  simulateSubscriptionForSmoke()
  smokeCatalogs()
  const result = [], original = net.fetch
  const plan = '# Your course\n\nLearn to sketch from observation.\n\nPractice: still life.'
  const renderer = (body: string) => win.webContents.executeJavaScript(`(async () => {
    const wait = async f => { for(let n=0;n<250;n++) {const v=f(); if(v) return v; await new Promise(r=>setTimeout(r,30))} throw Error('Timed out: '+f+' ('+(document.querySelector('.sidechat-error')?.textContent||'')+')') }
    const button = text => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text && b.checkVisibility() && !b.disabled)
    const field = (el,text) => {Object.getOwnPropertyDescriptor(el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,'value').set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}))}
    const send = async text => {field(await wait(()=>document.querySelector('.authoring-chat textarea.sidechat-input')),text);(await wait(()=>document.querySelector('.authoring-chat .sidechat-send:not(:disabled):not(.stop)'))).click()}
    ${body}
  })()`)
  await renderer(`(await wait(()=>document.querySelector('.titlebar [data-section="courses"]'))).click(); (await wait(()=>button('Create course'))).click(); (await wait(()=>button('AI'))).click()`)
  try {
    for (const provider of ['apiKey','chatgpt'] as const) {
      const model = provider === 'apiKey' ? 'gpt-5.1' : 'gpt-6.1-sol'
      await setAIProfile('authoring', provider, { enabledModels: [model], defaultModel: model, defaultReasoning: null })
      setAIProvider('authoring', provider)
      let requests = 0, interrupted = false
      const tool = (name: string, args: unknown) => ({ type:'function_call', name, arguments:JSON.stringify(args),call_id:randomUUID() })
      const calls = [
        [tool('ask_questions', { questions: [
          { id: 'goal', kind: 'text', prompt: 'What would you like to draw?' },
          { id: 'experience', kind: 'single', prompt: 'How often do you draw?', options: [{ id: 'daily', label: 'Daily' }, { id: 'rarely', label: 'Rarely' }] },
          { id: 'practice', kind: provider === 'apiKey' ? 'multiple' : 'single', prompt: 'Which exercises sound useful?', options: [{ id: 'landscape', label: 'Landscapes' }, { id: 'people', label: 'People' }] }
        ] })],
        [tool('create_plan',{text:plan}),tool('present_plan',{revision:1})],
        [tool('patch_plan',{revision:1,edits:[{oldText:'still life',newText:'landscape'}]}),tool('present_plan',{revision:2})],
        [tool('update_element',{fields:{title:'Sketching with '+provider}})], []
      ]
      net.fetch = (async (url, init) => {
        if (!String(url).endsWith('/responses')) return original(url,init)
        const body = JSON.parse(String(init?.body))
        const token = new Headers(init?.headers).get('Authorization')
        if (!['Bearer sk-opencourse-smoke-only-not-a-real-key','Bearer opencourse-smoke-subscription'].includes(token ?? '')) throw Error('Unexpected smoke credentials.')
        const naming = !body.tools?.length
        if (!naming && (body.model !== model || (provider === 'chatgpt') !== body.tools.some((t: {type:string})=>t.type==='namespace'))) throw Error('Wrong provider or model for the planning turn.')
        if (!naming && requests === 1) {
          const last = body.input.at(-1)?.content ?? ''
          if (!last.includes('On weekends') || !(provider === 'apiKey' ? last.includes('Landscapes; Buildings') : last.includes('People'))) throw Error('Incorrect choice answers sent to the planner.')
        }
        if (!naming && requests === 4 && !interrupted) {
          // The preceding round has already edited the course. Lose this stream
          // after some text, then allow the same round to finish on reconnect.
          interrupted = true
          let started = false
          return new Response(new ReadableStream({ pull(controller) {
            if (started) { controller.error(new Error('net::ERR_NETWORK_CHANGED')); return }
            started = true
            controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.output_text.delta',delta:'Interrupted fragment'})+'\n\n'))
          } }), {headers:{'content-type':'text/event-stream'}})
        }
        const output = naming ? [] : calls[requests++]
        if (!output) throw Error('Unexpected planning round.')
        const line = (event: unknown) => 'data: '+JSON.stringify(event)+'\n\n'
        return new Response((output.length ? '' : line({type:'response.output_text.delta',delta:naming ? 'Sketching Course Plan' : 'Course draft updated.'})) + line({type:'response.completed',response:{output}}),{headers:{'content-type':'text/event-stream'}})
      }) as typeof net.fetch
      if (provider === 'chatgpt') { win.setSize(880,720); await renderer(`(await wait(()=>document.querySelector('.authoring-chat .sidechat-new'))).click()`) }
      await renderer(`
        await wait(()=>document.querySelector('.authoring-chat .sidechat-model')?.textContent.includes(${JSON.stringify(model)}))
        await wait(()=>document.querySelector('.authoring-chat .chat-active-tools[aria-label*=Plan]'))
        const menu = await wait(()=>document.querySelector('.authoring-chat .chat-tools-trigger:not(:disabled)'))
        menu.click()
        const web = await wait(()=>[...document.querySelectorAll('[role="menuitemcheckbox"]')].find(e=>e.textContent.includes('Web search')))
        if (!web.querySelector('svg')) throw Error('Missing web search icon')
        web.click()
        await wait(()=>web.isConnected && web.getAttribute('aria-checked')==='false' && !web.disabled)
        web.click()
        await wait(()=>web.isConnected && web.getAttribute('aria-checked')==='true' && !web.disabled)
        menu.click()
        const summary = await wait(()=>document.querySelector('.authoring-chat .chat-active-tools[aria-label="Active tools: Web search, Plan"]'))
        const row = summary.querySelector('.chat-tools-row')
        const toolbar = summary.closest('.sidechat-actions')
        const room = width => { toolbar.style.width = toolbar.getBoundingClientRect().width + width - summary.getBoundingClientRect().width + 'px' }
        try {
          room(210); await wait(()=>row.textContent==='Web searchPlan')
          room(78); await wait(()=>row.textContent.includes('+1') && row.querySelector('.chat-tool-name > span').scrollWidth > row.querySelector('.chat-tool-name > span').clientWidth)
          room(46); await wait(()=>row.textContent==='…+2' && row.querySelector('svg'))
          room(210); await wait(()=>row.textContent==='Web searchPlan')
        } finally { toolbar.style.removeProperty('width') }
        await send('Plan a drawing course')
        const card = await wait(()=>document.querySelector('section.plan-questions'))
        const step = n => wait(()=>card.querySelector('.plan-question-position')?.textContent === 'Question '+n+' of 3')
        await step(1)
        if (card.querySelectorAll('fieldset').length !== 1 || getComputedStyle(card).backgroundColor === 'rgba(0, 0, 0, 0)') throw Error('Expected one question in a filled card')
        if (${provider === 'apiKey'}) {
          if (document.querySelector('.author-save-state').textContent !== 'Not saved yet') throw Error('Expected an unedited course.')
          const unload = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(unload)
          if (!unload.defaultPrevented) throw Error('Window close would lose this conversation without asking.')
          ;(await wait(()=>[...document.querySelectorAll('.titlebar .crumbs a')].find(a=>a.checkVisibility() && a.textContent.includes('All courses')))).click()
          const warning = await wait(()=>document.querySelector('.dialog'))
          if (!warning.textContent.includes('delete its chat history') || !button('Discard chat')) throw Error('Missing chat discard warning.')
          button('Keep editing').click()
          await wait(()=>!document.querySelector('.dialog') && card.isConnected)
        }
        const answerField = card.querySelector('textarea'), initialHeight = answerField.clientHeight
        field(answerField, ('Drawing practice. ' + String.fromCharCode(10)).repeat(40))
        await wait(()=>answerField.scrollHeight > answerField.clientHeight)
        answerField.scrollTop = answerField.scrollHeight
        if (answerField.scrollTop <= 0 || answerField.clientHeight !== initialHeight || getComputedStyle(answerField).resize !== 'none') throw Error('Long answers should scroll inside a fixed field')
        field(answerField, 'Draw from observation')
        ;(await wait(()=>button('Next'))).click()
        await step(2)
        ;(await wait(()=>card.querySelector('button[aria-label="Previous question"]:not(:disabled)'))).click()
        await step(1)
        if (card.querySelector('textarea').value !== 'Draw from observation') throw Error('Lost the previous answer')
        ;(await wait(()=>button('Next'))).click()
        await step(2)
        const custom = () => card.querySelector('.plan-custom-input')
        const next = () => card.querySelector('.plan-question-actions .primary')
        const presets = () => [...card.querySelectorAll('.plan-question-option:not(.plan-custom-option)')]
        if (!next().disabled || card.querySelector('.plan-custom-option .plan-option-number')?.textContent!=='3.') throw Error('Single choice needs numbered options and a disabled Next')
        presets()[0].click()
        await step(3)
        ;(await wait(()=>card.querySelector('button[aria-label="Previous question"]:not(:disabled)'))).click()
        await step(2)
        if (!next().disabled) throw Error('A preset should advance on click, not enable Next')
        field(custom(),'Sometimes at weekends'); await wait(()=>!next().disabled)
        field(custom(),'  '); await wait(()=>next().disabled)
        field(custom(),'On weekends'); (await wait(()=>button('Next'))).click()
        await step(3)
        if (!next().disabled) throw Error('An empty choice must not enable submission')
        if (${provider === 'apiKey'}) {
          const option = presets()[0], mark = option.querySelector('.plan-option-mark')
          if (getComputedStyle(mark).boxShadow==='none') throw Error('Missing hollow circle')
          field(custom(),'   '); await wait(()=>next().disabled)
          field(custom(),'Buildings'); await wait(()=>!next().disabled && custom().closest('label').dataset.selected==='true')
          field(custom(),''); await wait(()=>next().disabled && custom().closest('label').dataset.selected==='false')
          option.click(); await wait(()=>option.dataset.selected==='true')
          const filled = getComputedStyle(mark,'::after')
          if (filled.maskImage==='none' || !filled.transitionProperty.includes('transform')) throw Error('Missing animated selection mark')
          field(custom(),'Buildings'); (await wait(()=>button('Send answers'))).click()
        } else {
          presets()[1].click()
        }
        await wait(()=>button('Accept plan')); await send('Use landscapes instead')
        await wait(()=>document.querySelector('.sidechat-transcript')?.textContent.includes('Practice: landscape.'))
        const accept = await wait(()=>button('Accept plan'))
        if ([...document.querySelectorAll('.plan-actions button')].filter(b=>b.textContent==='Accept plan').length!==1 || !button('Reject plan')) throw Error('Wrong decision controls')
        accept.click(); await wait(()=>document.querySelector('.author-title h1')?.textContent===${JSON.stringify('Sketching with '+provider)})
        await wait(()=>document.querySelector('.chat-network-warning')?.textContent.includes('retry 1 of 5'))
        await wait(()=>!document.querySelector('.chat-network-warning') && !document.querySelector('.authoring-chat .sidechat-send.stop') && document.querySelector('.sidechat-transcript')?.textContent.includes('Course draft updated.'))
        if (document.querySelector('.sidechat-transcript').textContent.includes('Interrupted fragment')) throw Error('Interrupted text was duplicated after reconnect.')
        const scroller = document.querySelector('.authoring-chat .sidechat-scroll')
        const historyToggle = document.querySelector('.authoring-chat .sidechat-history-toggle')
        await wait(()=>scroller.scrollHeight - scroller.clientHeight > 30)
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 24
        await wait(()=>document.querySelector('.authoring-chat .sidechat-latest'))
        const readingPosition = () => [scroller.scrollTop, scroller.clientHeight, scroller.firstElementChild.getBoundingClientRect().top].join(',')
        const before = readingPosition()
        historyToggle.click()
        const history = await wait(()=>document.querySelector('.authoring-chat .sidechat-history'))
        if (history.getBoundingClientRect().top !== scroller.getBoundingClientRect().top || readingPosition() !== before) throw Error('Opening history moved the transcript.')
        historyToggle.click()
        await wait(()=>!history.isConnected)
        if (readingPosition() !== before) throw Error('Closing history moved the transcript.')

        await wait(()=>!document.querySelector('.authoring-chat .chat-active-tools[aria-label*=Plan]') && !button('Accept plan'))
      `)
      if (requests !== 5) throw Error('Implementation started an unexpected number of model requests.')
      result.push({name:'course planner: '+provider,ok:true,detail:'Questions, plan, targeted revision, and accepted draft edit verified through the desktop UI.'})
      net.fetch = original
    }
    await renderer(`
      (await wait(()=>[...document.querySelectorAll('.titlebar .crumbs a')].find(a => a.checkVisibility() && a.textContent.includes('All courses')))).click()
      ;(await wait(()=>button('Discard changes'))).click()
      const library = await wait(()=>document.querySelector('.courses-library'))
      if (library.textContent.includes('Continue course planning') || library.textContent.includes('Sketching with chatgpt')) throw Error('Discarded course still appears in the library.')
    `)
    result.push({name:'course planner: exit before saving',ok:true,detail:'Discarding the draft returns to the library without a course or a resumable plan.'})
    return result
  } finally { net.fetch = original }
}
