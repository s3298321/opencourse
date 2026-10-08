/**
 * The boot data the server wrote into the page (shared/boot.ts). Read once.
 * Under `vite dev` there is no server-rendered page: `loadDevBoot` asks the API
 * for the same two facts before the first render, and every loader fetches.
 */
import type { AccountDetails, ServerInfo } from '@core/catalog/api'
import { BOOT_ELEMENT_ID, type Boot, type BootData } from '@shared/boot'
import { DEFAULT_APP_URL, SOURCE_URL } from '@shared/pages'

const element = document.getElementById(BOOT_ELEMENT_ID)

function read(): Boot {
  if (element?.textContent) {
    try { return JSON.parse(element.textContent) as Boot } catch { /* fall through */ }
  }
  return {
    server: {
      opencourse: 1, api: 1, name: 'OpenCourse server', description: '', registration: 'open',
      publicUrl: window.location.origin, appUrl: DEFAULT_APP_URL, sourceUrl: SOURCE_URL,
      privacyUrl: null, legalUrl: null
    },
    account: null,
    page: null
  }
}

export const boot: Boot = read()
export const server = boot.server

/** Development only: the server's name and the signed-in account, from the API. */
export async function loadDevBoot(): Promise<void> {
  if (element) return
  const json = async <T>(path: string): Promise<T | null> => {
    try {
      const response = await fetch(path, { credentials: 'same-origin' })
      return response.ok ? (await response.json()) as T : null
    } catch { return null }
  }
  const [info, me] = await Promise.all([json<ServerInfo>('/api/v1/server'), json<{ account: AccountDetails }>('/api/v1/me')])
  if (info) Object.assign(server, info)
  boot.account = me?.account ?? null
}

let unused = boot.page

/**
 * The server's data for this exact page, the first time it is asked for -
 * after that, and for any other address, loaders fetch.
 */
export function takeBootData<K extends BootData['kind']>(kind: K, url: URL): Extract<BootData, { kind: K }> | null {
  const page = unused
  if (!page || page.data.kind !== kind || page.path !== url.pathname || page.search !== url.search) return null
  unused = null
  return page.data as Extract<BootData, { kind: K }>
}
