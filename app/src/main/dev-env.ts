/**
 * Where a `npm run dev` app finds the rest of the local world: the server's
 * API, its web app and the website, as `npm run dev` starts them in server/
 * and site/. Null outside a dev run, so a release can only ever name the
 * public addresses.
 */
import { devRun } from './run-mode'

export interface DevEnvironment {
  /** The API the dev profile is connected to. */
  server: string
  /** The server's web app (Vite, proxying the API). */
  catalogWeb: string
  /** opencourse.dev's local twin. */
  site: string
}

const trim = (url: string): string => url.replace(/\/+$/, '')

export function devEnvironment(): DevEnvironment | null {
  if (!devRun()) return null
  return {
    server: trim(process.env['OPENCOURSE_DEV_SERVER'] || 'http://127.0.0.1:8787'),
    catalogWeb: trim(process.env['OPENCOURSE_DEV_CATALOG_WEB'] || 'http://localhost:5173'),
    site: trim(process.env['OPENCOURSE_DEV_SITE'] || 'http://localhost:4321')
  }
}
