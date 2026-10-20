/**
 * The public addresses the app links to. A `npm run dev` app links to the
 * local site and catalog instead (main/dev-env.ts), so main hands the
 * renderer whichever set applies and nothing else hard-codes them.
 */
export interface AppLinks {
  website: string
  legal: string
  catalog: string
  download: string
}

export const PUBLIC_LINKS: AppLinks = {
  website: 'https://opencourse.dev',
  legal: 'https://opencourse.dev/legal',
  catalog: 'https://catalog.opencourse.dev',
  download: 'https://opencourse.dev/download'
}

export function linksFor(site: string, catalog: string): AppLinks {
  return { website: site, legal: `${site}/legal`, catalog, download: `${site}/download` }
}
