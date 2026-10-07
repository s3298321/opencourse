// opencourse.dev: a static site. Everything is decided at build time - the
// docs come from the repo's docs/, the release and the stars from GitHub's API
// (scripts/build-resources.mjs) - so the result is files for S3 and CloudFront,
// and a visitor's browser talks to nobody but this site.
import { resolve } from 'node:path'
import { defineConfig, sharpImageService } from 'astro/config'
import sitemap from '@astrojs/sitemap'

const here = (path) => resolve(import.meta.dirname, path)

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? 'https://opencourse.dev',
  output: 'static',
  trailingSlash: 'never',
  build: {
    // /docs/course-format/index.html, served by the CloudFront function as /docs/course-format.
    format: 'directory',
    // The CSP allows no inline style: every stylesheet is a file.
    inlineStylesheets: 'never'
  },
  // The docs are rendered by src/lib/docs.ts, not by Astro's Markdown pipeline.
  markdown: { syntaxHighlight: false },
  // The site's pictures are mostly screenshots, which are mostly small text.
  // sharp's defaults (AVIF 50, WebP 80 with 4:2:0 chroma) smear it.
  image: { service: sharpImageService({ avif: { quality: 70 }, webp: { quality: 88, smartSubsample: true } }) },
  integrations: [sitemap({ filter: (page) => !/\/404\/?$/.test(page) })],
  devToolbar: { enabled: false },
  vite: {
    resolve: { alias: { '@design': here('../design') } },
    server: { fs: { allow: [here('.'), here('../design'), here('../docs')] } },
    build: { assetsInlineLimit: 0 }
  }
})
