/**
 * Who is signed in, readable from React and from the router's loaders alike.
 * It starts from the boot data - the server already knew, from the cookie - and
 * changes only when this page signs in or out, or an API call says the
 * session is gone.
 */
import { useSyncExternalStore } from 'react'
import type { AccountDetails } from '@core/catalog/api'
import { boot } from './boot'

let current: AccountDetails | null = boot.account
const listeners = new Set<() => void>()

/** For the development boot, which learns the account after this module loaded. */
export function resetSessionFromBoot(): void { current = boot.account }

export const session = {
  get account(): AccountDetails | null { return current },
  set(account: AccountDetails | null): void {
    current = account
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}

export function useAccount(): AccountDetails | null {
  return useSyncExternalStore(session.subscribe, () => current, () => current)
}

/** Where a sign-in should return to: only a path on this site, never an address elsewhere. */
export function safeNext(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback
  return value
}
