/**
 * Every request the web app makes, all to this server's own /api/v1 - the
 * same API the desktop app uses. The session is the HttpOnly cookie the
 * server set at sign-in, which this code never sees; the browser attaches it
 * and marks each request same-origin, which is what the server checks before
 * it lets a cookie change anything (server/src/auth/cookie.ts).
 *
 * A refusal is thrown as an ApiError carrying the server's own message: the
 * API's messages are written for people, so the pages show them as they are.
 */
import type {
  AccountDetails, AccountRole, AdminAccount, AdminCourse, AdminStats, AuditEntry, CatalogPage, CatalogTag,
  CourseOverview, ManagedCourse, Paged, SessionInfo, WebAuthResult
} from '@core/catalog/api'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

async function call<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    throw new ApiError(0, 'unreachable', 'Could not reach the server. Check your connection and try again.')
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { /* not JSON: a proxy's error page */ }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } & Record<string, unknown> } | null)?.error
    const { code, message, ...extra } = error ?? {}
    throw new ApiError(response.status, code ?? 'http_error', message ?? `The server answered ${response.status}.`, extra)
  }
  return data as T
}

const enc = encodeURIComponent
const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value))
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const api = {
  /* catalog */
  catalog: (search: string, signal?: AbortSignal) => call<CatalogPage>('GET', `/courses${search}`, undefined, signal),
  tags: (signal?: AbortSignal) => call<{ tags: CatalogTag[] }>('GET', '/tags', undefined, signal),
  course: (id: string, signal?: AbortSignal) => call<CourseOverview>('GET', `/courses/${enc(id)}`, undefined, signal),

  /* signing in */
  usernameAvailable: (name: string, signal?: AbortSignal) => call<{ available: boolean; reason?: string }>('GET', `/auth/username${query({ name })}`, undefined, signal),
  registerStart: (email: string) => call<{ ok: true }>('POST', '/auth/register/start', { email }),
  registerVerify: (email: string, code: string) => call<{ ticket: string }>('POST', '/auth/register/verify', { email, code }),
  registerComplete: (ticket: string, username: string, password: string) => call<WebAuthResult>('POST', '/auth/register/complete', { ticket, username, password, session: 'cookie' }),
  login: (login: string, password: string) => call<WebAuthResult>('POST', '/auth/login', { login, password, session: 'cookie' }),
  logout: () => call<void>('POST', '/auth/logout'),
  forgot: (email: string) => call<{ ok: true }>('POST', '/auth/password/forgot', { email }),
  reset: (email: string, code: string, password: string) => call<WebAuthResult>('POST', '/auth/password/reset', { email, code, password, session: 'cookie' }),

  /* your account */
  me: () => call<{ account: AccountDetails }>('GET', '/me'),
  changePassword: (current: string, password: string) => call<{ ok: true }>('POST', '/me/password', { current, password }),
  emailStart: (email: string, password: string) => call<{ ok: true }>('POST', '/me/email/start', { email, password }),
  emailVerify: (email: string, code: string) => call<{ account: AccountDetails }>('POST', '/me/email/verify', { email, code }),
  sessions: () => call<{ sessions: SessionInfo[] }>('GET', '/me/sessions'),
  endSession: (id: string) => call<void>('DELETE', `/me/sessions/${enc(id)}`),
  endOtherSessions: () => call<{ ok: true }>('POST', '/me/sessions/revoke-others'),
  deleteAccount: (password: string) => call<void>('DELETE', '/me', { password }),

  /* your courses */
  myCourses: () => call<{ courses: ManagedCourse[] }>('GET', '/me/courses'),
  managed: (id: string) => call<ManagedCourse>('GET', `/courses/${enc(id)}/versions`),
  makeCurrent: (id: string, version: string) => call<ManagedCourse>('PUT', `/courses/${enc(id)}/current`, { version }),
  deleteVersion: (id: string, version: string) => call<ManagedCourse>('DELETE', `/courses/${enc(id)}/versions/${enc(version)}`),
  unpublish: (id: string) => call<ManagedCourse>('DELETE', `/courses/${enc(id)}`),
  relist: (id: string) => call<ManagedCourse>('POST', `/courses/${enc(id)}/relist`),

  /* administration */
  admin: {
    stats: () => call<AdminStats>('GET', '/admin/stats'),
    accounts: (q: string, page: number) => call<Paged<AdminAccount>>('GET', `/admin/accounts${query({ q, page })}`),
    disable: (id: string) => call<AdminAccount>('POST', `/admin/accounts/${enc(id)}/disable`),
    enable: (id: string) => call<AdminAccount>('POST', `/admin/accounts/${enc(id)}/enable`),
    setRole: (id: string, role: AccountRole) => call<AdminAccount>('PUT', `/admin/accounts/${enc(id)}/role`, { role }),
    courses: (q: string, state: string, page: number) => call<Paged<AdminCourse>>('GET', `/admin/courses${query({ q, state, page })}`),
    moderate: (id: string, reason: string) => call<AdminCourse>('POST', `/admin/courses/${enc(id)}/moderate`, { reason }),
    restore: (id: string) => call<AdminCourse>('POST', `/admin/courses/${enc(id)}/restore`),
    audit: (q: string, page: number) => call<Paged<AuditEntry>>('GET', `/admin/audit${query({ q, page })}`)
  }
}

export const coverUrl = (id: string): string => `/api/v1/courses/${enc(id)}/cover`
