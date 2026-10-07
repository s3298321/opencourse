/**
 * The web app's pages, in one table both halves read. Fastify registers each
 * path, so a page answers 200 and anything else 404, and puts the title and the
 * robots rule into the HTML before any script runs. The React router is built
 * from the same table, so the two can never disagree about which pages exist.
 *
 * Paths use the syntax both routers share: `/literal/:param`.
 */
export type PageKey =
  | 'catalog' | 'course'
  | 'signin' | 'signup' | 'forgot'
  | 'myCourses' | 'myCourse' | 'settings'
  | 'admin' | 'adminAccounts' | 'adminCourses' | 'adminAudit'

export interface Page {
  key: PageKey
  path: string
  /** The page's own title; the server's name follows it. Empty for the catalog, which is the server's name. */
  title: string
  /** Whether search engines may index it. Accounts and administration never. */
  index: boolean
  /** Who may see it. The page itself sends anyone else to sign in. */
  access: 'anyone' | 'account' | 'admin'
}

export const PAGES: readonly Page[] = [
  { key: 'catalog', path: '/', title: '', index: true, access: 'anyone' },
  { key: 'course', path: '/courses/:id', title: 'Course', index: true, access: 'anyone' },
  { key: 'signin', path: '/signin', title: 'Sign in', index: false, access: 'anyone' },
  { key: 'signup', path: '/signup', title: 'Create an account', index: false, access: 'anyone' },
  { key: 'forgot', path: '/forgot', title: 'Reset your password', index: false, access: 'anyone' },
  { key: 'myCourses', path: '/me/courses', title: 'My courses', index: false, access: 'account' },
  { key: 'myCourse', path: '/me/courses/:id', title: 'Manage a course', index: false, access: 'account' },
  { key: 'settings', path: '/settings', title: 'Settings', index: false, access: 'account' },
  { key: 'admin', path: '/admin', title: 'Administration', index: false, access: 'admin' },
  { key: 'adminAccounts', path: '/admin/accounts', title: 'Accounts · Administration', index: false, access: 'admin' },
  { key: 'adminCourses', path: '/admin/courses', title: 'Courses · Administration', index: false, access: 'admin' },
  { key: 'adminAudit', path: '/admin/audit', title: 'Audit log · Administration', index: false, access: 'admin' }
]

export const pageByKey = (key: PageKey): Page => PAGES.find((page) => page.key === key)!

/** The page a path is, with its parameters; null when it is no page at all. */
export function matchPage(pathname: string): { page: Page; params: Record<string, string> } | null {
  const parts = pathname.replace(/\/+$/, '').split('/').slice(1)
  for (const page of PAGES) {
    const pattern = page.path === '/' ? [] : page.path.split('/').slice(1)
    if (pattern.length !== (pathname === '/' ? 0 : parts.length)) continue
    const params: Record<string, string> = {}
    if (pattern.every((segment, i) => {
      if (segment.startsWith(':')) {
        try { params[segment.slice(1)] = decodeURIComponent(parts[i]!) } catch { return false }
        return parts[i] !== ''
      }
      return segment === parts[i]
    })) return { page, params }
  }
  return null
}

/** Where people find the app; any server can say otherwise with OPENCOURSE_SERVER_APP_URL. */
export const DEFAULT_APP_URL = 'https://opencourse.dev/download'
export const SOURCE_URL = 'https://github.com/s3298321/opencourse'
