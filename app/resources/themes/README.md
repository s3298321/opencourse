# Built-in themes

Shipped theme manifests and their assets live here:

- `white/theme.json`: the White palette. Imported by
  `src/core/theme/builtin.ts` and compiled into the main bundle; no separate
  pictures or fonts are required.
- `neon-afterhours/`: a complete portable theme with its own artwork,
  fonts and Paper Spark mark. Read by `src/main/builtin-themes.ts`.

Electron Builder copies this directory into `Resources/themes/`. Development
reads it here; packaged apps read it from `process.resourcesPath`.

Dark is intentionally the base `src/renderer/styles.css` palette, applied
without a theme override and available as a fallback. Its portable authoring
copy is `docs/default-theme/` at the repository root. The default-theme tests
check that copy against the CSS, including accessibility variants.

The repository's top-level `themes/` is for ignored local experiments.
`npm run zip:theme -- neon-afterhours` and `npm run zip:theme -- white`
from `app/` export these built-ins into `themes-zip/` at the repository root.
