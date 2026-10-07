import { redirect } from 'react-router'
import type { AccountDetails } from '@core/catalog/api'
import { ApiError } from './api'
import { session } from './session'

/** For a loader: the signed-in account, or off to sign in and back here afterwards. */
export function requireAccount(request: Request): AccountDetails {
  const account = session.account
  if (!account) {
    const url = new URL(request.url)
    throw redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`)
  }
  return account
}

export function requireAdmin(request: Request): AccountDetails {
  const account = requireAccount(request)
  if (account.role !== 'admin') throw new Response('Only an administrator can open this page.', { status: 403 })
  return account
}

/**
 * Runs a loader's request; a 401 means the session ended (signed out
 * elsewhere, expired, revoked from another device), so the page forgets the
 * account and asks for a sign-in instead of showing an error.
 */
export async function signedIn<T>(request: Request, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      session.set(null)
      const url = new URL(request.url)
      throw redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`)
    }
    if (error instanceof ApiError && error.status === 404) throw new Response(error.message, { status: 404 })
    throw error
  }
}
