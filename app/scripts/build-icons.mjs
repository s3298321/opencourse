// Reproducible macOS exports from the generated master, no image API required.
// `node scripts/build-icons.mjs web` rebuilds only the web sizes in design/.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const resources = resolve(dirname(fileURLToPath(import.meta.url)), '../resources')
const master = join(resources, 'branding/master.png')
const webOnly = process.argv[2] === 'web'
const sips = (size, out, source = master) => execFileSync('/usr/bin/sips', ['-z', String(size), String(size), source, '--out', out], { stdio: 'ignore' })

if (!webOnly) {
  const work = mkdtempSync(join(tmpdir(), 'opencourse-icon-'))
  try {
    const iconset = join(work, 'opencourse.iconset')
    mkdirSync(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) sips(size * scale, join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'icon.icns')])
    for (const [size, out] of [[1024, 'icon.png'], [128, 'branding/mark.png']]) sips(size, join(resources, out))
    copyFileSync(join(resources, 'branding/mark.png'), resolve(resources, '../../docs/default-theme/images/mark.png'))
    console.log('Built OpenCourse PNG and ICNS assets from resources/branding/master.png')
  } finally { rmSync(work, { recursive: true, force: true }) }
}

// The server's web app and the site share these; they are committed so a
// Linux build never needs sips.
const web = resolve(resources, '../../design/assets/brand')
mkdirSync(web, { recursive: true })
for (const size of [64, 128, 256, 512]) sips(size, join(web, `mark-${size}.png`))
// The master includes macOS icon padding. Browser tiles need a tighter crop,
// and a high-resolution source rather than an enlarged 32px tab favicon.
// Keep the original master and the app/header mark exports unchanged.
const work = mkdtempSync(join(tmpdir(), 'opencourse-favicon-'))
try {
  const dimensions = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', master], { encoding: 'utf8' })
  const width = Number(dimensions.match(/pixelWidth: (\d+)/)?.[1])
  const height = Number(dimensions.match(/pixelHeight: (\d+)/)?.[1])
  if (!width || !height) throw new Error('Cannot read the logo master dimensions')
  // The tile occupies about 81% of this master; leave a small margin for its bevel.
  const cropSize = Math.round(Math.min(width, height) * 0.83)
  const cropped = join(work, 'browser.png')
  execFileSync('/usr/bin/sips', ['-c', String(cropSize), String(cropSize), master, '--out', cropped], { stdio: 'ignore' })
  for (const size of [32, 192, 512]) sips(size, join(web, `favicon-${size}.png`), cropped)
  sips(180, join(web, 'apple-touch-icon-180.png'), cropped)
  // Preserve the conventional URL for browsers that discover it automatically.
  copyFileSync(join(web, 'apple-touch-icon-180.png'), join(web, 'apple-touch-icon.png'))
} finally { rmSync(work, { recursive: true, force: true }) }
console.log('Built the web brand sizes in design/assets/brand')
