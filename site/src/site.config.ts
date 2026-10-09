/**
 * Every address the site links to, in one place. The catalog and the site's
 * own URL can be moved with environment variables at build time (for a
 * preview deployment, or to point the catalog teaser at a local server).
 */
export const SITE = {
  name: 'OpenCourse',
  url: import.meta.env.PUBLIC_SITE_URL ?? 'https://opencourse.dev',
  catalogUrl: (import.meta.env.PUBLIC_CATALOG_URL ?? 'https://catalog.opencourse.dev').replace(/\/+$/, ''),
  repo: 's3298321/opencourse',
  repoUrl: 'https://github.com/s3298321/opencourse',
  /**
   * The Mac download. GitHub answers this with a redirect to the newest
   * release's file, so the button never goes stale and never shows a GitHub
   * page - as long as the release workflow keeps the asset's name.
   */
  downloadUrl: 'https://github.com/s3298321/opencourse/releases/latest/download/OpenCourse-mac-arm64.dmg',
  releasesUrl: 'https://github.com/s3298321/opencourse/releases',
  issuesUrl: 'https://github.com/s3298321/opencourse/issues',
  /** Who runs opencourse.dev and the public catalog, for the privacy page and the legal notice. */
  operator: 'Sergei Kravtsov',
  /** Forwarded by SES to the operator's own mailbox (opencourse-infra, modules/contact-mail). */
  contactEmail: 'contact@opencourse.dev',
  minimumMacOS: 'macOS 13 Ventura',
  docsBranch: 'master',
  description: 'OpenCourse is a free, open-source Mac app for studying and creating courses on any subject, with lessons, quizzes, flashcards, coding exercises and optional AI help.'
} as const

export const catalogHost = SITE.catalogUrl.replace(/^https?:\/\//, '')
