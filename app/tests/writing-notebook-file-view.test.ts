// @vitest-environment jsdom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileView, { type OpenFileView } from '../src/renderer/writing-notebooks/FileView'
let root: Root, container: HTMLDivElement
const id = crypto.randomUUID()
const render = async (view: OpenFileView['view'], path = 'Research/notes.txt', name = 'notes.txt') => act(async () => {
  root.render(h(FileView, { notebookId: id, file: { path, name, view }, textScale: 1, onChange: vi.fn(), onSave: vi.fn() }))
})
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
describe('notebook file view', () => {
  it('shows images from the asset-protocol URL', async () => {
    await render({ kind: 'image' }, 'Research/my photo.png', 'my photo.png')
    const img = container.querySelector<HTMLImageElement>('.writing-file-view img')!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe(`opencourse://writing-notebooks/${id}/pages/Research/my%20photo.png`)
    expect(img.alt).toBe('my photo.png')
    expect(container.querySelector('.writing-file-editor')).toBeNull()
  })
  it('plays videos in an integrated player', async () => {
    await render({ kind: 'video' }, 'clip.mp4', 'clip.mp4')
    const video = container.querySelector<HTMLVideoElement>('.writing-file-view video')!
    expect(video).toBeTruthy()
    expect(video.controls).toBe(true)
    expect(video.getAttribute('src')).toBe(`opencourse://writing-notebooks/${id}/pages/clip.mp4`)
  })
  it('opens text files in the shared code editor', async () => {
    await render({ kind: 'text', text: 'int main() { return 0; }\n', bytes: 24 }, 'main.c', 'main.c')
    expect(container.querySelector('.writing-file-editor .cm-editor')).toBeTruthy()
    expect(container.querySelector('.writing-file-editor .cm-content')?.textContent).toContain('int main()')
    expect(container.querySelector('.writing-file-view')).toBeNull()
  })
  it('shows a warning card for binary files and for files too large to edit', async () => {
    await render({ kind: 'binary', bytes: 4096 }, 'blob.bin', 'blob.bin')
    const card = container.querySelector('.writing-file-card')!
    expect(card).toBeTruthy()
    expect(card.textContent).toContain('blob.bin')
    expect(card.textContent).toContain('binary')
    expect(card.textContent).toContain('4 KiB')
    await render({ kind: 'large', bytes: 6 * 1024 * 1024 }, 'big.txt', 'big.txt')
    expect(container.querySelector('.writing-file-card')!.textContent).toContain('too large')
    expect(container.querySelector('.writing-file-card')!.textContent).toContain('6.0 MiB')
  })
  it('falls back to the warning card when media cannot be decoded', async () => {
    await render({ kind: 'image' }, 'broken.heic', 'broken.heic')
    const img = container.querySelector<HTMLImageElement>('.writing-file-view img')!
    await act(async () => { img.dispatchEvent(new Event('error')) })
    expect(container.querySelector('.writing-file-card')!.textContent).toContain('could not be displayed')
    expect(container.querySelector('.writing-file-view img')).toBeNull()
  })
})
