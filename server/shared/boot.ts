/**
 * What the server puts into the page before any script runs, so the first paint
 * already knows the server, the signed-in account and - for the catalog and a
 * course - the data the page shows. It travels as JSON in a
 * `<script type="application/json" id="oc-boot">` block: data, never code.
 */
import type { AccountDetails, CatalogPage, CatalogTag, CourseOverview, ServerInfo } from '@core/catalog/api'

export interface BootServer extends ServerInfo {
  /** Where people reach this server: what they type into the app. */
  publicUrl: string
  /** Where "Get the app" points. */
  appUrl: string
  sourceUrl: string
  /** The operator's privacy policy and legal notice; null when not configured. */
  privacyUrl: string | null
  legalUrl: string | null
}

export type BootData =
  | { kind: 'catalog'; page: CatalogPage; tags: CatalogTag[] }
  | { kind: 'course'; course: CourseOverview }

export interface Boot {
  server: BootServer
  account: AccountDetails | null
  /** The data for exactly this path and query string, if the server had it. */
  page: { path: string; search: string; data: BootData } | null
}

export const BOOT_ELEMENT_ID = 'oc-boot'
