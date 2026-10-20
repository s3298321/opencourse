import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The server's web app. It shares the app's pure core (`@core`: the API types
// and the account rules) and the web design layer (`@design`) with the site,
// and is served by Fastify from dist/web. In development, Vite serves it and
// hands /api to the server on :8787.
const here = (path: string): string => resolve(__dirname, path)
const api = process.env['OPENCOURSE_SERVER_URL'] ?? 'http://127.0.0.1:8787'

export default defineConfig({
  root: here('.'),
  // The brand pictures are served at the root: /favicon-32.png, /mark-512.png.
  publicDir: here('../../design/assets/brand'),
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@core\/(.*)$/, replacement: here('../../app/src/core/$1') },
      { find: /^@design\/(.*)$/, replacement: here('../../design/$1') },
      { find: /^@shared\/(.*)$/, replacement: here('../shared/$1') }
    ],
    // The exercise editor reuses the app's indentation rule and LLVM mode, which
    // import CodeMirror too: one copy, or its instanceof checks fail. The PDF
    // reader's pages are the app's too, and must render with the copy of
    // pdfjs that opened the document.
    dedupe: ['shiki', 'react', 'react-dom', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@lezer/highlight', 'pdfjs-dist']
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [here('..'), here('../../design'), here('../../app/src/core'), here('../../app/src/learning-ui'), here('../../app/src/renderer/workbench')] },
    proxy: Object.fromEntries(['/api', '/dev', '/sitemap.xml', '/robots.txt', '/healthz'].map((path) => [path, { target: api, changeOrigin: false }]))
  },
  build: {
    outDir: here('../dist/web'),
    emptyOutDir: true,
    // PDF binary resources are fetched under the same-origin CSP, never data URLs.
    assetsInlineLimit: 0,
    // The CSP allows no inline script: no polyfill snippet in the page.
    modulePreload: { polyfill: false },
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    // Libraries change far less often than the app: separate files stay cached across releases.
    rollupOptions: {
      output: {
        manualChunks: { pdf: ['pdfjs-dist'], react: ['react', 'react-dom', 'react-router'], markdown: ['markdown-it', 'dompurify'], editor: ['@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language', '@codemirror/lang-python', '@codemirror/lang-cpp'] }
      }
    }
  }
})
