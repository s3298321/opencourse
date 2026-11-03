import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FlashcardPreview, PersonalCardManager } from '../src/learning-ui/PersonalCards'
import type { FlashcardProposal } from '../src/core/personal-cards'
let root:Root,container:HTMLDivElement
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
  HTMLDialogElement.prototype.showModal=function(){this.open=true}
  HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'))}
})
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();vi.unstubAllGlobals()})
const proposal:FlashcardProposal={id:'p',target:{kind:'document',id:'d'},title:'My PDF',cards:[{id:'c',question:'Question?',answer:'Private answer'}],status:'pending'}
const button=(text:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent===text)!
it('previews both sides, waits for approval, prevents duplicate clicks and supports dismissal',async()=>{
  let resolve!:(p:FlashcardProposal)=>void
  const decide=vi.fn(()=>new Promise<FlashcardProposal>(r=>{resolve=r}))
  await act(async()=>root.render(createElement(FlashcardPreview,{proposal,decide})))
  expect(container.textContent).toContain('Question?');expect(container.textContent).toContain('Private answer')
  expect(decide).not.toHaveBeenCalled()
  await act(async()=>{button('Save all').click()})
  expect(decide).toHaveBeenCalledExactlyOnceWith('p','save')
  expect([...container.querySelectorAll('button')].every(b=>b.disabled)).toBe(true)
  await act(async()=>resolve({...proposal,status:'saved'}))
  expect(container.textContent).toContain('1 card saved')
  await act(async()=>root.render(createElement(FlashcardPreview,{key:'another',proposal,decide})))
  await act(async()=>button('Dismiss').click())
  expect(decide).toHaveBeenLastCalledWith('p','dismiss')
  await act(async()=>resolve({...proposal,status:'dismissed'}))
  expect(container.textContent).toContain('Preview dismissed')
})
it('lists questions only and retains a card after a failed deletion',async()=>{
  const load=vi.fn(async()=>[{id:'c',question:'Question?'}]),remove=vi.fn().mockRejectedValueOnce(new Error('Offline error')).mockResolvedValue(undefined)
  await act(async()=>root.render(createElement(PersonalCardManager,{count:1,load,remove})))
  await act(async()=>button('1 personal').click())
  expect(container.querySelector('dialog')?.open).toBe(true)
  expect(container.querySelector('li')?.textContent).toBe('Question?')
  const trash=()=>container.querySelector<HTMLButtonElement>('[aria-label="Delete card: Question?"]')!
  expect(trash().querySelector('svg')).not.toBeNull()
  await act(async()=>trash().click())
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Offline error')
  expect(trash()).not.toBeNull()
  await act(async()=>trash().click())
  expect(container.querySelectorAll('li')).toHaveLength(0)
  expect(container.textContent).toContain('No personal flashcards yet')
})
