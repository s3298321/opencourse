import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogCourse } from '../src/core/catalog/api'
import type { CourseSummary, ServerConnection } from '../src/core/types'
vi.mock('../src/renderer/components/TitleBar', () => ({ default: ({ back }: { back: { label: string; onClick: () => void } }) => h('button', { className: 'catalog-back', onClick: back.onClick }, back.label) }))
import ServerCatalog from '../src/renderer/routes/ServerCatalog'

let container: HTMLDivElement, root: Root
let library: CourseSummary[]
const navigate = vi.fn()
const course: CatalogCourse = { id: 'course', slug: 'course', title: 'Server course', tags: [], publisher: 'teacher', version: '1.0.0', downloads: 2, lessonCount: 3, projectCount: 0, hasCover: false, updatedAt: '2026-10-10' }
const servers: ServerConnection[] = [
  { id: 'one', name: 'Active school', url: 'https://one.test', description: '', active: true, status: 'unknown', account: null },
  { id: 'two', name: 'Selected school', url: 'https://two.test', description: '', active: false, status: 'unknown', account: { username: 'learner', email: 'learner@example.org' } }
]
beforeEach(() => {
  library = []
  navigate.mockReset()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('opencourse', {
    listCourses: vi.fn(async () => library), listServers: vi.fn(async () => servers),
    onCoursesChanged: () => () => {}, onServersChanged: () => () => {},
    searchCatalog: vi.fn(async () => ({ ok: true, value: { courses: [course], total: 1, page: 1, pageSize: 20 } })),
    listCatalogTags: vi.fn(async () => ({ ok: true, value: [] })),
    addCatalogCourse: vi.fn(async () => {
      library = [{ courseId: course.id, slug: course.slug, title: course.title, lessonCount: 3, projectCount: 0 }]
      return { ok: true, value: { title: course.title, version: course.version } }
    })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
const render = async () => act(async () => root.render(h(ServerCatalog, { serverId: 'two', user: null, navigate, route: { name: 'catalog', serverId: 'two' } })))

describe('server catalog page', () => {
  it('browses and adds from the selected server instead of the globally active connection, then returns to that source', async () => {
    await render()
    expect(container.querySelector('h1')?.textContent).toBe('Selected school')
    expect(container.querySelector('.catalog-server-name')).toBeNull()
    expect(container.querySelector('h1')?.title).toBe('https://two.test')
    expect(window.opencourse.searchCatalog).toHaveBeenCalledWith('two', { q: '', tags: [], sort: undefined, page: 1 })
    await act(async () => container.querySelector<HTMLButtonElement>('.catalog-card-action button')!.click())
    expect(window.opencourse.addCatalogCourse).toHaveBeenCalledWith('two', 'course')
    expect(container.querySelector('.catalog-card-action button')).toBeNull()
    expect(container.querySelector('.catalog-library-status')?.textContent).toBe('In your library')
    await act(async () => container.querySelector<HTMLElement>('.catalog-library-status')!.click())
    expect(navigate).toHaveBeenLastCalledWith({ name: 'catalogCourse', serverId: 'two', courseId: 'course' })
    await act(async () => container.querySelector<HTMLElement>('.catalog-card')!.click())
    expect(navigate).toHaveBeenLastCalledWith({ name: 'catalogCourse', serverId: 'two', courseId: 'course' })
    await act(async () => container.querySelector<HTMLButtonElement>('.catalog-back')!.click())
    expect(navigate).toHaveBeenLastCalledWith({ name: 'library', source: 'two' })
  })

  it('searches the selected server after typing and keeps the page usable when it is removed', async () => {
    await render()
    const search = container.querySelector<HTMLInputElement>('.catalog-search')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'python')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(window.opencourse.searchCatalog).toHaveBeenLastCalledWith('two', { q: 'python', tags: [], sort: undefined, page: 1 })
    vi.mocked(window.opencourse.listServers).mockResolvedValueOnce([servers[0]])
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    expect(container.querySelector('.empty-library h3')?.textContent).toBe('No server to browse')
    expect(window.opencourse.searchCatalog).not.toHaveBeenLastCalledWith('one', expect.anything())
  })
})
