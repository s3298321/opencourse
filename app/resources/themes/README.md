# Built-in themes

Shipped theme manifests and their assets live here:

- `white/theme.json`: the Panda palette. Imported by
  `src/core/theme/builtin.ts` and compiled into the main bundle; no separate
  pictures or fonts are required.

Electron Builder copies this directory into `Resources/themes/`. The Panda
palette is compiled into the app in both development and packaged builds.

Bond uses the base `src/renderer/styles.css` palette, applied
without a theme override and available as a fallback. Its portable authoring
copy is `docs/default-theme/` at the repository root. The default-theme tests
check that copy against the CSS, including accessibility variants.

The repository's top-level `themes/` is for ignored local experiments.
`npm run zip:theme -- white` from `app/` exports Panda into
`themes-zip/` at the repository root.
