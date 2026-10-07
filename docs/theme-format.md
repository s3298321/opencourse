# OpenCourse theme format 1

A theme changes how OpenCourse looks - the colour and opacity of every
surface, the grain on them, pictures behind them, the fonts, the mark in the
titlebar - and never what it does. It is a zip archive with a `theme.json` and
the pictures and fonts that file names. Import one from **Settings →
Appearance**; choose it there, or from **View → Theme** in the menu bar.

The app's own look is not a theme. It is what you see when no theme is
applied, and choosing **OpenCourse (no theme)** goes back to it. The same look
is written out as a theme in `opencourse-default-theme.zip` - start from that
copy when you make your own.

Themes belong to the user who imported them. Another user on the same Mac
sees none of them.

## What a theme can't do

A theme is values, never rules. It sets colours, sizes, pictures and font
names for a fixed list of the app's style tokens; it cannot name a selector, add
CSS, hide or move a control, run a script or reach the network. The app reads
every value itself - a colour is parsed and written out again, a picture is a
path the app checks is in the archive - so nothing in `theme.json` reaches the
stylesheet as written.

Some things hold whatever a theme says:

- **Reading and editing surfaces stay opaque.** The lesson, settings, the
  exercise brief, code blocks, the editor and the terminal take a colour and
  grain, never a picture, and a translucent colour is drawn as it would look
  over the window.
- **macOS accessibility settings win.** With *Reduce transparency* or
  *Increase contrast* on, every translucent surface becomes opaque and grain
  and pictures go. *Increase contrast* also strengthens borders and quiet text.
  *Reduce motion* is untouched by themes.
- **The name stays.** A theme can replace the mark beside the wordmark, and the
  wordmark's font, but the wordmark always reads OpenCourse.
- **Course content is the author's.** Visualizations and course pictures are
  not themed.

## The archive

```
my-theme.zip
├── theme.json
├── images/        .png .jpg .jpeg .webp .gif .svg
├── fonts/         .woff2 .woff .ttf .otf
└── README.md      optional; .md and .txt files are allowed and ignored
```

Folder names are up to you; paths in `theme.json` are relative to it. A zip
made by Finder's *Compress* (which wraps the folder) imports as it is.

Nothing else is accepted - no HTML, CSS or script, and no symlinks. Each file
must be what its name says: a `.png` that is really something else is refused.
Limits: 50 MB per archive, 25 MB per file, 200 files, and pictures at most 8192
pixels on a side.

Importing a theme whose `id` is already installed asks whether to replace it
or keep both. Replacing keeps it applied if it was the one in use - that is how
you update a theme.

## theme.json

The app reads `theme.json` leniently: a field it can't use is dropped and
listed under **notes** on the theme's card in Settings, and the rest still
applies. Only a file that is not a theme - no `format`, no `id`, no `name`,
or a newer `format` - is refused. `theme-schema.json` is strict, for your
editor: point `$schema` at it to be told about a mistake as you make it.

```jsonc
{
  "$schema": "urn:opencourse:theme:1.0",
  "format": 1,                       // required
  "id": "paper-and-ink",             // required: lowercase letters, digits, hyphens
  "name": "Paper & Ink",             // required
  "version": "1.0.0",
  "author": "You",
  "description": "Shown in Settings.",
  "appearance": "light",             // "dark" or "light"
  "preview": "images/preview.png",   // the picture on its card in Settings
  "palette": { "background": "#f6f1e7", "text": "#2b2620", "accent": "#9c4a1a" },
  "tokens": {}, "reducedTransparency": {}, "increasedContrast": {},
  "window": {}, "grain": {}, "surfaces": {}, "fonts": {}, "logo": {}
}
```

### Colours

Anywhere a colour goes: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`,
`rgba()`, `hsl()`, `hsla()` (comma or space syntax), `transparent`, `black`,
`white`.

### appearance

`"dark"` or `"light"`. It decides which way the window's glass and the native
controls lean, which palette code in lessons and the editor is highlighted
with, and the colours derived from the palette below.

### palette

Three colours give a whole theme: `background`, `text` and `accent` are
required, and every colour token is derived from them with the same hierarchy
as the app's own look - cards a little toward the text colour, borders further,
quiet text further still. `muted`, `success` and `danger` are optional seeds for
quiet text, success states and errors.

### tokens

Exact values for any of the app's colour tokens, overriding what the palette
derives:

| Token | Where it shows |
|---|---|
| `fg`, `muted` | text, and quieter text |
| `bg` | the reading surface (also `surfaces.reading.color`) |
| `card` | cards, panels, quiz and exercise blocks |
| `accent`, `accent-fg` | buttons, links, focus, and the label on a button |
| `border` | every hairline |
| `selected`, `selected-edge` | the current lesson, tab or menu item; `selected` may be `{ "from": …, "to": … }`, a gradient |
| `check-accent` | ticked checkboxes |
| `ok`, `ok-bg`, `ok-border` | success messages and states |
| `err`, `err-fg`, `err-bg`, `err-border` | errors and destructive buttons |
| `chip-bg`, `chip-fg` | tags, chips, hover states |
| `accent-ring` | focus rings and the highlighted passage |
| `code-bg` | code (also `surfaces.code.color`) |
| `bubble`, `bubble-border`, `composer-bg` | the side chat |
| `scrollbar`, `scrollbar-hover` | every scrollbar |
| `chrome`, `glass`, `popover` | the titlebar, the glass panes, menus |
| `overlay` | the dimming behind dialogs |
| `shadow` | the colour of every shadow (its alpha is ignored) |
| `hover-ring` | the edge on a hovered button |
| `editor-active-line`, `terminal-selection` | the editor's current line, the terminal's selection |

### reducedTransparency and increasedContrast

Colours to use when macOS asks for reduced transparency (or more contrast),
and for more contrast. Leave them out and the app works them out: translucent
surfaces are composited over the window colour, and `border`, `muted` and
`selected-edge` move toward the text colour. Values here are still made
opaque where a surface must be.

### window

```json
"window": {
  "material": "image",
  "color": "#e9e1d2",
  "image": { "src": "images/desk.jpg", "fit": "cover", "position": "center", "blur": 6, "dim": 0.15 }
}
```

- `material`: `"vibrancy"` (the default) lets macOS's frosted glass show
  through; `"solid"` paints the window `color`; `"image"` puts a picture behind
  everything.
- `color`: the window colour - behind a solid window, under a picture, and what
  translucent surfaces are composited over when they must be opaque. Defaults to
  the reading surface's colour.
- `image.blur`: 0-40 px. `image.dim`: 0-1, how far the picture fades toward
  the window colour.

### grain

The fine static noise on glass surfaces.

```json
"grain": { "amount": 0.12, "scale": 1, "texture": "images/paper-grain.png" }
```

- `amount`: 0-0.4, the noise's strength. 0.12 is the app's own; 0 turns it off
  everywhere.
- `scale`: 0.5-3; larger is coarser.
- `texture`: a tileable picture to use instead of the generated noise -
  paper, linen, film. Draw it with transparency: at `amount` 0.12 it is drawn
  exactly as you made it, and any other amount, here or on a surface, fades or
  strengthens it in proportion (0.06 is half as strong). `scale` sizes it. An SVG
  texture without its own width and height is always drawn as it is.

### surfaces

Each surface takes a colour, an opacity, grain and, where it makes sense, a
picture.

| Surface | What it is | Takes |
|---|---|---|
| `titlebar` | the bar at the top of the window | colour, opacity, grain, picture |
| `sidebar` | a course's chapter list | colour, opacity, grain, picture |
| `list` | the Library, Coach and user lists | colour, opacity, grain, picture |
| `sidechat` | the side chat | colour, opacity, grain, picture |
| `popover` | menus and the search panel | colour, opacity, grain, `blur` (0-40 px) |
| `reading` | lessons, settings, the exercise brief | colour and grain; always opaque |
| `code` | code blocks, the editor, the terminal | colour; always opaque |
| `card`, `chip`, `bubble`, `composer` | cards, chips, your chat messages, the chat box | colour, opacity |

```json
"surfaces": {
  "titlebar": { "color": "#f6f1e7", "opacity": 0.72, "grain": 0.12 },
  "sidebar": {
    "color": "rgba(240, 233, 220, 0.82)",
    "image": { "src": "images/linen.png", "fit": "tile", "scale": 0.75, "tint": "rgba(246, 241, 231, 0.55)" }
  },
  "reading": { "color": "#f8f4ec", "grain": 0.06 }
}
```

- `opacity` (0-1) replaces the colour's alpha - including a colour the theme
  left to the palette, so `{ "opacity": 0.4 }` alone makes a surface more
  see-through.
- `grain` (0-0.4) is this surface's own strength; 0 turns it off here. The
  titlebar and reading surface have none unless they ask; the glass panes have
  the theme's.
- `image`: `src`, then `fit` - `cover` (default), `contain`, `tile` or
  `stretch` - `position` (`center`, `top`, `bottom`, `left`, `right`,
  `top left`, `top right`, `bottom left`, `bottom right`), `scale` (0.25-4, for
  `tile`) and `tint`, a colour painted over the picture. The app can't measure
  contrast over a picture, so give one a tint.

### fonts

```json
"fonts": {
  "faces": [{ "family": "Ledger Dots", "src": "fonts/ledger-dots.ttf", "weight": 400, "style": "normal" }],
  "ui": { "family": ["Avenir Next", "Helvetica Neue"], "size": 14.5 },
  "reading": { "family": ["Charter", "Georgia", "serif"], "size": 17, "lineHeight": 1.65 },
  "heading": { "family": ["Charter", "Georgia", "serif"], "weight": 700, "letterSpacing": -0.01 },
  "code": { "family": ["Menlo"], "size": 12.5 },
  "brand": { "family": ["Ledger Dots"], "weight": 400, "letterSpacing": 0.02 }
}
```

`faces` bundles font files: `family` is the name you then use, `weight` is a
number or a variable font's range (`"100 900"`), `style` is `normal` or
`italic`. List a family once per weight and style it has. A family can also be
any font installed on the Mac, by name - but only bundled fonts go wherever
the theme goes.

| Slot | Where | Takes |
|---|---|---|
| `ui` | everything not listed below | `family`, `size` (12-18 px), `lineHeight` |
| `reading` | lesson text and chat answers | `family`, `size` (13-22 px), `lineHeight` |
| `heading` | every heading | `family`, `weight`, `letterSpacing` (em) |
| `code` | code everywhere, the editor and terminal | `family`, `size` (10-18 px; the editor's size, the rest scale with it) |
| `brand` | the OpenCourse wordmark | `family`, `weight`, `letterSpacing` (em) |

A `family` may be one name or a list, tried in order; the app's own fonts are
always the last resort. Names are letters, digits, spaces, `.`, `_` and `-`.
Leave a slot out and it keeps the app's font; leave `heading.family` out and
headings use whatever font surrounds them.

### logo

```json
"logo": { "mark": "images/mark.svg" }
```

Replaces the mark beside the wordmark in the titlebar. Make it square - an SVG,
or at least 64 pixels.

## Making one

1. Get the format (**Help → Get the theme format…**, or the link in Settings)
   and unzip `opencourse-default-theme.zip` - the app's own look, every token
   written out - or `opencourse-example-theme.zip`, which uses every feature.
2. Change `id` and `name` first, so your theme does not replace the one you
   copied.
3. Zip the folder and import it. Re-import the same `id` to update it in place.
4. Read the notes on its card: a dropped field, or a pairing that is hard to
   read, is listed there.
