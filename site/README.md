# opencourse.dev

The OpenCourse website: what the app is, the download, and the documentation.
Astro, built to static files for S3 and CloudFront. The hosting itself is the
separate opencourse-infra repository.

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # dist/ and the docs' search index (Pagefind)
npm run check        # astro check, then scripts/verify-dist.mjs over dist/
```

## Where things come from

- **The docs** are `../docs/*.md`, rendered by `src/lib/docs.ts` with
  markdown-it, GitHub's heading anchors and Prism. A new file there becomes
  `/docs/<name>` on the next build. `DOC_GROUPS` and `DOC_TITLES` place and
  name it, and `DOC_RESOURCES` attaches downloads to it.
- **`scripts/build-resources.mjs`** runs before every `dev` and `build`. It:
  - copies the brand pictures from `../design/assets/brand`;
  - zips the example course and themes, and copies both schemas, into `public/downloads/`;
  - asks GitHub for the stars and the newest release, cached an hour in
    `.cache/` outside CI. Set `GITHUB_TOKEN` to avoid the rate limit;
  - copies the most-added courses from the catalog into `public/featured/`.
    `PUBLIC_CATALOG_URL` points it at another server, such as a local one.

  A network failure makes the page show less, never break.
- **The download button** is GitHub's
  `releases/latest/download/OpenCourse-mac-arm64.dmg` once a release exists, and
  `/download` before. The release workflow must keep that asset name.
- **The look** is `../design/` (the app's own tokens and primitives) plus
  `src/styles/site.css`. `public/og.png` is drawn by `scripts/make-og.mjs`; run
  it by hand and commit the result.

## Rules

- **No inline script or style, and no `style=` attribute.** The CSP CloudFront
  sends refuses them, and `verify-dist.mjs` fails the build first. Positions
  that vary go in CSS by `:nth-child`. The only inline `<script>` is the
  JSON-LD data block.
- **No third-party requests from a visitor's browser.** Fonts are
  self-hosted, pictures are copied in at build time, and search is Pagefind,
  served from `/pagefind/`.
- **Every claim about the app must be true of the app.** When a feature
  changes, the home page's copy and the FAQ change with it.
