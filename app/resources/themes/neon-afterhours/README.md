# Neon Afterhours

A built-in cyberpunk theme for OpenCourse. Choose **Settings → Appearance →
Neon Afterhours** or **View → Theme → Neon Afterhours**.

This directory is also a complete portable theme. Copy it, change its id and
name, and run `npm run zip:theme -- neon-afterhours` from `app/`
to package it into `themes-zip/neon-afterhours.zip`.

The theme demonstrates a window image, tinted glass, a tiled circuit pattern,
per-surface grain, gradient selection, custom status colors, two bundled
variable fonts, independent reading typography, and a replacement mark.
Reading and code stay opaque. Reduced transparency removes the art and texture;
increased contrast strengthens text and borders. No network access is needed.

## Assets

- `images/city.jpg`: original artwork generated with the built-in imagegen
  tool, then JPEG-encoded for distribution. Prompt below.
- `images/circuit.svg`: original OpenCourse vector artwork, distributed under
  the repository's MIT license.
- `images/paper-spark.png`: the selected Paper Spark concept, extracted with
  the built-in imagegen tool onto transparency and exported at 256 px for the
  titlebar. It replaces the initial split-book mark.
- `fonts/oxanium.ttf`: [Oxanium from Google Fonts](https://github.com/google/fonts/tree/main/ofl/oxanium),
  SIL Open Font License; full license in `fonts/oxanium-OFL.txt`.
- `fonts/space-grotesk.ttf`: [Space Grotesk from Google Fonts](https://github.com/google/fonts/tree/main/ofl/spacegrotesk),
  SIL Open Font License; full license in `fonts/space-grotesk-OFL.txt`.

## Background generation prompt

Use case: stylized-concept. Asset type: landscape background artwork for a stylish cyberpunk desktop learning app theme, 1536x1024 or similar landscape. Primary request: funky, whacky but still stylish cyberpunk midnight city. Sophisticated editorial 3D illustration of impossible stacked brutalist towers and floating neon geometric rings, a gigantic luminous pink orb, electric lime architectural light strips and cyan reflections, violet mist, wet dark reflective surfaces. Wide composition with richly detailed architecture on the far left and right edges, mostly dark spacious central area so interface panels can sit over it. Palette predominantly near-black plum and midnight violet, controlled electric pink and acid lime with small cyan details. Beautiful cinematic materials, restrained bloom, playful surreal geometry, polished art direction. No text, no logos, no interface, no watermark. This is background art, not a mockup.

## Paper Spark extraction prompt

Use case: background-extraction. Edit the supplied Paper Spark logo concept board into a production logo asset. Extract ONLY the large central lime-and-pink folded lightning/page symbol. Preserve its exact silhouette, proportions, arrangement, angular diagonal negative-space gap, lime front faces, and pink triangular folded face. Remove all text, the small duplicate logo at the bottom, and the dark background. Output a single centered mark on a genuinely transparent background, square canvas, symbol filling 90 percent of canvas height with modest equal padding. Crisp clean edges and flat solid colors #d5ff70 and #fc83db, no shadow, no glow, no wordmark, no dark fill in the negative spaces. Do not redesign the symbol.

## Visual verification

From `app/`, run
`OPENCOURSE_SHOTS_ONLY=neon OPENCOURSE_SHOTS=/tmp/opencourse-neon npm run shots`
to capture Appearance, Library, a lesson, and the editor using a disposable
profile.
