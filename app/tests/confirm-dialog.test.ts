import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ConfirmDialog from '../src/renderer/components/ConfirmDialog'

it('treats an outside press as cancellation and ignores presses inside',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  const container=document.body.appendChild(document.createElement('div')),root=createRoot(container),onResult=vi.fn()
  try {
    await act(async()=>root.render(createElement(ConfirmDialog,{request:{title:'Discard changes?',detail:'Unsaved edits will be lost.',confirmLabel:'Discard',cancelLabel:'Keep editing'},onResult})))
    await act(async()=>container.querySelector('[role=alertdialog]')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true})))
    expect(onResult).not.toHaveBeenCalled()
    await act(async()=>container.querySelector('.dialog-backdrop')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true})))
    expect(onResult).toHaveBeenCalledExactlyOnceWith(false)
  } finally {
    await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals()
  }
})
