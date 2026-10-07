/** Exercise AI draft notifications in a real window, without network/model calls. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { newDraftRef } from '../core/course-document'
import { getAuthoringCourse, saveDraft } from './course-authoring'
import { authoringEvents, beginAuthoringTurn } from './authoring-state'

export async function runAuthoringMotionSmoke(win: BrowserWindow, courseId: string, output: string): Promise<unknown> {
  const lease = beginAuthoringTurn(courseId, 'motion-smoke', () => {})
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const update = (change: (manifest: ReturnType<typeof getAuthoringCourse>['draft']['manifest']) => void): void => {
    const state = getAuthoringCourse(courseId), manifest = structuredClone(state.draft.manifest)
    change(manifest)
    const saved = saveDraft(courseId, manifest, state.document.revision, state.draft.draftVersion, lease.token)
    if ('status' in saved) throw new Error('Motion fixture draft conflict')
    authoringEvents.emit('draft', courseId, getAuthoringCourse(courseId))
  }
  const screenshot = async (name: string): Promise<void> => writeFileSync(join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  try {
    update(manifest => {
      const block = manifest.modules[0].lessons![0].blocks[0]
      if (block.type !== 'markdown') throw new Error('Motion fixture requires markdown')
      block.content = '## A small edit\n\nThe old compiler produces code.\n\nThis paragraph stays exactly the same.\n\nA linker combines object files.'
    })
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Text: hello-python"]').click(); document.querySelector('.author-preview').scrollTop=0;`)
    await pause(1700)
    update(manifest => {
      const lesson = manifest.modules[0].lessons![0], block = lesson.blocks[0]
      if (block.type !== 'markdown') throw new Error('Motion fixture requires markdown')
      block.content = block.content.replace('old compiler produces code', 'new compiler produces object files')
      lesson.blocks.splice(1, 0, { nodeId: newDraftRef(), slug: 'added-note', type: 'markdown', content: 'A new supporting example.' })
      lesson.blocks = lesson.blocks.filter(entry => entry.slug !== 'key-takeaways')
    })
    const report = await win.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<100;i++) { if(document.querySelector('.authoring-motion-word.arriving')) break; await new Promise(r=>setTimeout(r,10)); }
      const arriving=[...document.querySelectorAll('.authoring-motion-word.arriving')].map(el=>el.textContent);
      const departing=[...document.querySelectorAll('.authoring-motion-word.departing')].map(el=>el.textContent);
      const badges=[...document.querySelectorAll('.authoring-motion-badge')].map(el=>el.textContent);
      if(!arriving.length || !departing.length || arriving.some(word=>['paragraph','stays','exactly','same.','linker'].includes(word))) throw new Error('Motion failed to isolate changed words');
      if(!['Updated','Removed'].every(label=>badges.includes(label)) || badges.includes('Added')) throw new Error('Wrong outline change indications: '+badges);
      const addedRow=document.querySelector('[aria-label^="Text: added-note"]')?.closest('[data-authoring-outline-id]');
      if(!addedRow?.getAnimations().some(animation=>animation.effect.getKeyframes()[0].opacity==='0')) throw new Error('Added outline row does not fade in');
      const highlight=CSS.highlights.get('authoring-arriving');
      if(!highlight?.size) throw new Error('Missing incoming-word highlight');
      return {arriving,departing,badges,hiddenRanges:highlight.size};
    })()`)
    await screenshot('motion-edit-start')
    await pause(160); await screenshot('motion-edit-middle')
    await pause(1400)
    await win.webContents.executeJavaScript(`if(document.querySelector('[data-authoring-motion-overlay]') || CSS.highlights.has('authoring-arriving')) throw new Error('Motion cleanup failed');`)
    await screenshot('motion-edit-complete')
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Hello, Python"]').click(); document.querySelector('.author-preview').scrollTop=0;`)
    update(manifest => {
      const lesson = manifest.modules[0].lessons![0]
      lesson.blocks = lesson.blocks.filter(block => block.slug !== 'added-note')
      lesson.blocks.splice(1, 0, { nodeId: newDraftRef(), slug: 'another-note', type: 'markdown', content: '**New idea:** Compilation and linking are separate steps.' })
    })
    await pause(70); await screenshot('motion-lesson-added-removed')
    await pause(1700)
    await win.webContents.executeJavaScript(`if(!document.querySelector('.author-preview').textContent.includes('Compilation and linking')) throw new Error('Missing final lesson content');`)
    win.webContents.debugger.attach('1.3')
    try {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await pause(50)
      update(manifest => { manifest.modules[0].lessons![0].title = 'Hello, Python (updated)' })
      await pause(100)
      await win.webContents.executeJavaScript(`if(document.querySelector('[data-authoring-motion-overlay]') || CSS.highlights.has('authoring-arriving')) throw new Error('Reduced motion was ignored');`)
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    } finally { win.webContents.debugger.detach() }
    return { ...report, cleanup: true, reducedMotion: true, lessonChanges: true }
  } finally { lease.release() }
}
