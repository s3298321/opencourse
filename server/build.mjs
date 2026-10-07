// dist/index.js, with the app's shared core compiled in - and the small
// libraries that core uses (ajv, yauzl, markdown-it), because core imports
// `ajv/dist/2020`, a path Node's ESM loader will not resolve without an
// extension. Fastify, its plugins and nodemailer stay external.
//
// Then the web app, by Vite, into dist/web: `npm install --omit=dev` plus
// dist/ is a complete deployment. `node build.mjs server` skips the web app.
import { build } from 'esbuild'
import { build as viteBuild } from 'vite'
import { resolve } from 'node:path'

const here = (path) => resolve(import.meta.dirname, path)
const external = ['fastify', '@fastify/cookie', '@fastify/static', 'nodemailer']

for (const entry of ['index', 'admin']) {
  await build({
    entryPoints: [here(`src/${entry}.ts`)],
    outfile: here(`dist/${entry}.js`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    external,
    // Bare imports in the app's core resolve from this package, never the app's.
    nodePaths: [here('node_modules')],
    alias: { '@app/unzip': here('../app/src/main/unzip.ts'), ajv: here('node_modules/ajv'), yauzl: here('node_modules/yauzl') },
    tsconfig: here('tsconfig.json'),
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'info'
  })
}

if (process.argv[2] !== 'server') {
  await viteBuild({ configFile: here('web/vite.config.ts'), logLevel: 'info' })
}
