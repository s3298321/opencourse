"""Generates the pictures and the dot-matrix font for docs/example-theme.

Everything is drawn from code, so the example theme carries nothing anyone
else owns. Dev-only, and not part of any build (it needs Pillow, NumPy and
fontTools); the outputs are checked in.

    python3 app/scripts/example-theme-assets.py docs/example-theme

images/preview.png is not made here: it is a crop of the themed lesson from
`npm run shots` (37-theme-lesson.png, 1680x1050 from the top left, scaled to
480x300), so the card in Settings shows the theme as it really renders.
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

OUT = Path(sys.argv[1])
(OUT / 'images').mkdir(parents=True, exist_ok=True)
(OUT / 'fonts').mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(7)


def wrap_blur(a, radius):
    """Box blur that wraps around the edges, so the result tiles."""
    out = a.astype(np.float64)
    for _ in range(3):
        acc = np.zeros_like(out)
        for d in range(-radius, radius + 1):
            acc += np.roll(out, d, axis=0)
        out = acc / (2 * radius + 1)
        acc = np.zeros_like(out)
        for d in range(-radius, radius + 1):
            acc += np.roll(out, d, axis=1)
        out = acc / (2 * radius + 1)
    return out


# --- desk.jpg: a warm, soft-focus desk to sit behind the glass -------------
W, H = 1600, 1000
y, x = np.mgrid[0:H, 0:W].astype(np.float64)
t = (x / W * 0.55 + y / H * 0.45)
top = np.array([240, 232, 214], dtype=np.float64)
bottom = np.array([205, 186, 156], dtype=np.float64)
img = top[None, None, :] * (1 - t[..., None]) + bottom[None, None, :] * t[..., None]
for cx, cy, r, tone in [(0.22, 0.30, 0.38, (252, 246, 232)), (0.78, 0.72, 0.42, (188, 160, 122)), (0.62, 0.18, 0.25, (236, 222, 196))]:
    d = np.sqrt((x / W - cx) ** 2 + (y / H - cy) ** 2) / r
    w = np.clip(1 - d, 0, 1) ** 2 * 0.55
    img = img * (1 - w[..., None]) + np.array(tone)[None, None, :] * w[..., None]
img += rng.normal(0, 2.2, img.shape)
Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)).save(OUT / 'images' / 'desk.jpg', quality=82, optimize=True)

# --- linen.png: a tileable woven texture for the sidebar --------------------
S = 128
y, x = np.mgrid[0:S, 0:S].astype(np.float64)
warp = np.sin(2 * np.pi * x / S * 32) * 0.5 + 0.5
weft = np.sin(2 * np.pi * y / S * 32) * 0.5 + 0.5
fibres = wrap_blur(rng.normal(0, 1, (S, S)), 1)
lines_h = wrap_blur(np.repeat(rng.normal(0, 1, (S, 1)), S, axis=1), 0)
lines_v = wrap_blur(np.repeat(rng.normal(0, 1, (1, S)), S, axis=0), 0)
v = 236 + (warp * weft - 0.25) * 10 + fibres * 3 + lines_h * 2.5 + lines_v * 2.5
rgb = np.stack([v, v - 7, v - 18], axis=-1)
Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).save(OUT / 'images' / 'linen.png', optimize=True)

# --- paper-grain.png: tileable paper tooth and a few fibres, alpha only ---
# About as strong as the app's own grain (its noise peaks near alpha 30): this
# is drawn as authored at grain 0.12 and faded or strengthened from there.
S = 160
tooth = np.abs(rng.normal(0, 1, (S, S))) * 8
fibres = np.zeros((S, S))
for _ in range(36):
    x0, y0 = rng.uniform(0, S, 2)
    angle = rng.uniform(0, np.pi)
    length = rng.uniform(5, 14)
    for t in np.linspace(0, length, int(length * 3)):
        fibres[int(y0 + t * np.sin(angle)) % S, int(x0 + t * np.cos(angle)) % S] = rng.uniform(10, 18)
alpha = np.clip(tooth + fibres, 0, 30)
grain = np.zeros((S, S, 4), dtype=np.uint8)
grain[..., 0], grain[..., 1], grain[..., 2] = 70, 52, 32
grain[..., 3] = alpha.astype(np.uint8)
Image.fromarray(grain, 'RGBA').save(OUT / 'images' / 'paper-grain.png', optimize=True)

# --- mark.svg: an open notebook with an ink nib ----------------------------
(OUT / 'images' / 'mark.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect x="4" y="4" width="56" height="56" rx="14" fill="#2b2620"/>
  <path d="M14 20c6-3 12-3 18 1 6-4 12-4 18-1v24c-6-3-12-3-18 1-6-4-12-4-18-1z" fill="#f6f1e7"/>
  <path d="M32 21v24" stroke="#2b2620" stroke-width="1.6"/>
  <path d="M39 15l5 5-9 12-3 1 1-3z" fill="#9c4a1a"/>
</svg>
''')

# --- Ledger Dots: a 5x7 dot-matrix display font -------------------------
GLYPHS = {
    'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
    'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
    'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'I': ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    'J': ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
    'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
    'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
    'N': ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
    'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
    'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
    'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
    'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
    'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    'a': ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
    'b': ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '####.'],
    'c': ['.....', '.....', '.###.', '#....', '#....', '#...#', '.###.'],
    'd': ['....#', '....#', '.##.#', '#..##', '#...#', '#...#', '.####'],
    'e': ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
    'f': ['..##.', '.#..#', '.#...', '###..', '.#...', '.#...', '.#...'],
    'g': ['.....', '.####', '#...#', '#...#', '.####', '....#', '.###.'],
    'h': ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
    'i': ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
    'j': ['...#.', '.....', '..##.', '...#.', '...#.', '#..#.', '.##..'],
    'k': ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.'],
    'l': ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    'm': ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#...#', '#...#'],
    'n': ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
    'o': ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
    'p': ['.....', '.....', '####.', '#...#', '####.', '#....', '#....'],
    'q': ['.....', '.....', '.##.#', '#..##', '.####', '....#', '....#'],
    'r': ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
    's': ['.....', '.....', '.###.', '#....', '.###.', '....#', '####.'],
    't': ['.#...', '.#...', '###..', '.#...', '.#...', '.#..#', '..##.'],
    'u': ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#'],
    'v': ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    'w': ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
    'x': ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
    'y': ['.....', '.....', '#...#', '#...#', '.####', '....#', '.###.'],
    'z': ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####'],
    '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
    '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
    '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
    '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
    ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
    '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
    "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
    '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
    '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
    ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
    '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
    '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
}
CELL, R, ADV = 100, 40, 600
NAMES = {'.': 'period', ',': 'comma', '-': 'hyphen', "'": 'quotesingle', '!': 'exclam', '?': 'question',
         ':': 'colon', '/': 'slash', '&': 'ampersand', ' ': 'space'}
for d in '0123456789':
    NAMES[d] = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][int(d)]


def dot(pen, cx, cy):
    # A 12-gon reads as a round printer dot at display sizes. Clockwise, as
    # TrueType wants an outer contour.
    points = [(cx + R * math.cos(-2 * math.pi * k / 12), cy + R * math.sin(-2 * math.pi * k / 12)) for k in range(12)]
    pen.moveTo(points[0])
    for p in points[1:]:
        pen.lineTo(p)
    pen.closePath()


order = ['.notdef', 'space'] + [NAMES.get(c, c) for c in GLYPHS]
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(order)
fb.setupCharacterMap({ord(' '): 'space', **{ord(c): NAMES.get(c, c) for c in GLYPHS}})
glyphs, metrics = {}, {}
pen = TTGlyphPen(None)
for col in (0, 4):
    for row in range(7):
        dot(pen, col * CELL + 50, (6 - row) * CELL + 50)
glyphs['.notdef'] = pen.glyph()
metrics['.notdef'] = (ADV, 10)
glyphs['space'] = TTGlyphPen(None).glyph()
metrics['space'] = (ADV, 0)
for char, rows in GLYPHS.items():
    pen = TTGlyphPen(None)
    xs = []
    for row, line in enumerate(rows):
        for col, mark in enumerate(line):
            if mark == '#':
                dot(pen, col * CELL + 50, (6 - row) * CELL + 50)
                xs.append(col * CELL + 50 - R)
    name = NAMES.get(char, char)
    glyphs[name] = pen.glyph()
    metrics[name] = (ADV, int(min(xs)) if xs else 0)
fb.setupGlyf(glyphs)
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({
    'familyName': 'Ledger Dots', 'styleName': 'Regular',
    'copyright': 'Drawn for the OpenCourse example theme. Free to use, change and share.',
    'uniqueFontIdentifier': 'OpenCourse:LedgerDots:1.0', 'fullName': 'Ledger Dots Regular',
    'psName': 'LedgerDots-Regular', 'version': 'Version 1.000'
})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, sTypoLineGap=0, usWinAscent=800, usWinDescent=200,
            sxHeight=500, sCapHeight=700, achVendID='OPCS', fsType=0)
fb.setupPost()
fb.setupHead(unitsPerEm=1000)
fb.save(OUT / 'fonts' / 'ledger-dots.ttf')
print('wrote', sorted(str(p.relative_to(OUT)) for p in OUT.rglob('*') if p.is_file()))
