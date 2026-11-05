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
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();vi.useRealTimers();vi.unstubAllGlobals()})
const proposal:FlashcardProposal={id:'p',target:{kind:'document',id:'d'},title:'My PDF',cards:[{id:'c',question:'Question?',answer:'Private answer'}],status:'pending'}
const button=(text:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent?.replace(/[←→]/g,'').trim()===text)!
it('reviews the stack one card at a time, slides in each direction and prevents duplicate decisions',async()=>{
  vi.useFakeTimers()
  const stack:FlashcardProposal={...proposal,cards:[...proposal.cards,{id:'c2',question:'Next question?',answer:'Next answer'}]}
  let resolve!:(p:FlashcardProposal)=>void
  const decide=vi.fn(()=>new Promise<FlashcardProposal>(r=>{resolve=r}))
  await act(async()=>root.render(createElement(FlashcardPreview,{proposal:stack,decide})))
  expect(container.textContent).toContain('Question?');expect(container.textContent).toContain('Private answer')
  expect(container.textContent).not.toContain('Next question?')
  expect(container.textContent).toContain('Card 1 of 2')
  expect(decide).not.toHaveBeenCalled()
  await act(async()=>{button('Add').click();button('Add').click()})
  expect(decide).toHaveBeenCalledExactlyOnceWith('p','save','c')
  expect([...container.querySelectorAll('button')].every(b=>b.disabled)).toBe(true)
  const partial:FlashcardProposal={...stack,cards:[{...stack.cards[0],decision:'saved'},stack.cards[1]]}
  // Live updates must not replace the card before its departure animation.
  await act(async()=>root.render(createElement(FlashcardPreview,{proposal:partial,decide})))
  expect(container.textContent).toContain('Question?')
  await act(async()=>resolve(partial))
  expect(container.querySelector('.personal-card-leave-save')).not.toBeNull()
  await act(async()=>vi.advanceTimersByTime(280))
  expect(container.textContent).toContain('Next question?')
  expect(container.textContent).toContain('Card 2 of 2 · 1 saved')
  await act(async()=>button('Reject').click())
  expect(decide).toHaveBeenLastCalledWith('p','dismiss','c2')
  await act(async()=>resolve({...partial,status:'saved',cards:[partial.cards[0],{...partial.cards[1],decision:'dismissed'}]}))
  expect(container.querySelector('.personal-card-leave-dismiss')).not.toBeNull()
  await act(async()=>vi.advanceTimersByTime(280))
  expect(container.textContent).toContain('1 card saved · 1 rejected')
  expect(container.querySelector('button')).toBeNull()
})
it('resumes a partially reviewed stack and retains the active card when saving fails',async()=>{
  const partial:FlashcardProposal={...proposal,cards:[{...proposal.cards[0],decision:'dismissed'},{id:'c2',question:'Remaining?',answer:'Answer'}]}
  const decide=vi.fn().mockRejectedValue(new Error('Offline error'))
  await act(async()=>root.render(createElement(FlashcardPreview,{proposal:partial,decide})))
  expect(container.textContent).toContain('Card 2 of 2')
  expect(container.textContent).not.toContain('Private answer')
  await act(async()=>button('Add').click())
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Offline error')
  expect(container.textContent).toContain('Remaining?')
  expect(button('Add').disabled).toBe(false)
  expect(container.querySelector('.personal-card-leave-save')).toBeNull()
})
it('respects reduced motion and summarizes a rejected stack',async()=>{
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true})))
  const decide=vi.fn(async()=>({...proposal,status:'dismissed' as const,cards:[{...proposal.cards[0],decision:'dismissed' as const}]}))
  await act(async()=>root.render(createElement(FlashcardPreview,{proposal,decide})))
  await act(async()=>button('Reject').click())
  await act(async()=>vi.advanceTimersByTime(0))
  expect(container.textContent).toContain('0 cards saved · 1 rejected')
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
it('closes on a backdrop click but keeps padding clicks and drags from inside open',async()=>{
  await act(async()=>root.render(createElement(PersonalCardManager,{count:1,load:async()=>[{id:'c',question:'Question?'}],remove:async()=>{}})))
  await act(async()=>button('1 personal').click())
  const dialog=container.querySelector('dialog')!
  dialog.getBoundingClientRect=()=>({left:100,right:500,top:100,bottom:500,width:400,height:400,x:100,y:100,toJSON:()=>({})})
  const pointer=(type:string,x:number,y:number)=>dialog.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0}))
  await act(async()=>{pointer('pointerdown',110,110);pointer('click',110,110)})
  expect(dialog.open).toBe(true)
  await act(async()=>{pointer('pointerdown',110,110);pointer('click',50,50)})
  expect(dialog.open).toBe(true)
  await act(async()=>{pointer('pointerdown',50,50);pointer('click',110,110)})
  expect(dialog.open).toBe(true)
  await act(async()=>{pointer('pointerdown',50,50);pointer('pointercancel',50,50);pointer('click',50,50)})
  expect(dialog.open).toBe(true)
  await act(async()=>{pointer('pointerdown',50,50);pointer('click',50,50)})
  expect(container.querySelector('dialog')).toBeNull()
  expect(document.activeElement).toBe(button('1 personal'))
})
