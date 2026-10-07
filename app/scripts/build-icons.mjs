// Reproducible macOS exports from the generated master, no image API required.
// `node scripts/build-icons.mjs web` rebuilds only the web sizes in design/.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const resources = resolve(dirname(fileURLToPath(import.meta.url)), '../resources')
const master = join(resources, 'branding/master.png')
const webOnly = process.argv[2] === 'web'
const sips = (size, out) => execFileSync('/usr/bin/sips', ['-z', String(size), String(size), master, '--out', out], { stdio: 'ignore' })

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
    console.log('Built OpenCourse PNG and ICNS assets from resources/branding/master.png')
  } finally { rmSync(work, { recursive: true, force: true }) }
}

// The server's web app and the site share these; they are committed so a
// Linux build never needs sips.
const web = resolve(resources, '../../design/assets/brand')
mkdirSync(web, { recursive: true })
for (const size of [64, 128, 256, 512]) sips(size, join(web, `mark-${size}.png`))
sips(32, join(web, 'favicon-32.png'))
sips(180, join(web, 'apple-touch-icon.png'))
console.log('Built the web brand sizes in design/assets/brand')
