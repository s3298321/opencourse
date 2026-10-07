// Draws public/og.png, the 1200x630 picture link previews show. Run it by hand
// (node scripts/make-og.mjs) when the brand or the headline changes, and
// commit the result: it uses the Mac's own fonts, which a Linux build lacks.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const site = resolve(import.meta.dirname, '..')
const mark = readFileSync(join(site, '..', 'design', 'assets', 'brand', 'mark-512.png')).toString('base64')
const grain = readFileSync(join(site, '..', 'design', 'assets', 'grain.svg'), 'utf8')
const star = (x, y, r, o) => `<path transform="translate(${x} ${y}) scale(${r / 12})" opacity="${o}" fill="url(#silver)" d="M0 -12C0.7 -5.9 5.9 -0.7 12 0C5.9 0.7 0.7 5.9 0 12C-0.7 5.9 -5.9 0.7 -12 0C-5.9 -0.7 -0.7 -5.9 0 -12Z"/>`
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="#e6e6ea"/><stop offset="1" stop-color="#9d9da6"/></linearGradient>
    <radialGradient id="a" cx="0.2" cy="0.2" r="0.6"><stop offset="0" stop-color="#b0b8d6" stop-opacity="0.22"/><stop offset="1" stop-color="#b0b8d6" stop-opacity="0"/></radialGradient>
    <radialGradient id="b" cx="0.85" cy="0.1" r="0.5"><stop offset="0" stop-color="#d6d6e0" stop-opacity="0.14"/><stop offset="1" stop-color="#d6d6e0" stop-opacity="0"/></radialGradient>
    <radialGradient id="c" cx="0.6" cy="1" r="0.6"><stop offset="0" stop-color="#7884aa" stop-opacity="0.18"/><stop offset="1" stop-color="#7884aa" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#18181b"/>
  <rect width="1200" height="630" fill="url(#a)"/><rect width="1200" height="630" fill="url(#b)"/><rect width="1200" height="630" fill="url(#c)"/>
  ${star(140, 120, 14, 0.8)}${star(1070, 150, 18, 0.9)}${star(1010, 520, 10, 0.6)}${star(210, 520, 9, 0.5)}${star(620, 70, 7, 0.5)}${star(1120, 340, 7, 0.5)}
  <image x="96" y="182" width="132" height="132" xlink:href="data:image/png;base64,${mark}"/>
  <text x="252" y="268" font-family="SF Pro Display, Helvetica Neue, Helvetica, Arial, sans-serif" font-size="54" font-weight="600" letter-spacing="-1.4" fill="#dedee3">OpenCourse</text>
  <text x="96" y="430" font-family="SF Pro Display, Helvetica Neue, Helvetica, Arial, sans-serif" font-size="88" font-weight="700" letter-spacing="-4" fill="url(#silver)">Courses that teach back.</text>
  <text x="98" y="496" font-family="SF Pro Text, Helvetica Neue, Helvetica, Arial, sans-serif" font-size="28" fill="#a5a5af">Free and open source for Mac · lessons, quizzes, exercises and a tutor</text>
</svg>`
const grainTile = await sharp(Buffer.from(grain)).png().toBuffer()
await sharp(Buffer.from(svg))
  .composite([{ input: grainTile, tile: true, blend: 'over' }])
  .png({ compressionLevel: 9 })
  .toFile(join(site, 'public', 'og.png'))
console.log('Wrote public/og.png')
