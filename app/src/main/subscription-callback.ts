import type { ServerResponse } from 'node:http'
import tokens from '../../../design/tokens.css?raw'
import base from '../../../design/base.css?raw'
import motion from '../../../design/motion.css?raw'
import emptyArt from '../../../design/empty-art.css?raw'
import sparkle from '../../../design/assets/sparkle.svg?raw'
import { BRAND } from '../core/brand'

const ray = 'data:image/svg+xml;base64,' + Buffer.from(sparkle).toString('base64')
const titles = {
  received: 'Sign-in received',
  declined: 'Sign-in declined',
  invalid: 'Couldn’t verify sign-in'
}

export function sendCallbackPage(response: ServerResponse, outcome: keyof typeof titles): void {
  const received = outcome === 'received'
  const title = titles[outcome]
  const appName = BRAND.displayName
  const message = received
    ? `You can close this tab and return to ${appName} to continue.`
    : `Return to ${appName} to try connecting your ChatGPT account again.`
  response.writeHead(received ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'"
  }).end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · ${appName}</title>
  <link rel="icon" href="${ray}">
  <style>
    ${tokens}
    ${base}
    ${motion}
    ${emptyArt}
    :root { --sparkle: url("${ray}"); }
    body {
      margin: 0; min-height: 100vh; min-height: 100svh; padding: 20px;
      display: grid; place-items: center; font: var(--ui-size)/var(--ui-line-height) var(--font-ui);
      color: var(--fg); background: radial-gradient(ellipse at 50% 40%, var(--aurora-a), transparent 65%), var(--bg);
    }
    main {
      width: min(100%, 440px); border: 1px solid var(--border); border-radius: var(--radius-xl);
      background: var(--surface); box-shadow: var(--shadow-lg); overflow: hidden;
    }
    header {
      display: flex; align-items: center; justify-content: space-between; padding: 16px 24px;
      background: var(--card); border-bottom: 1px solid var(--line);
      font-weight: var(--brand-weight); letter-spacing: var(--brand-letter-spacing);
    }
    .empty-art { margin: 0 auto; }
    section { padding: clamp(28px, 6vw, 44px) 24px; text-align: center; }
    .status {
      display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%;
      color: var(--ok); background: var(--ok-bg); border: 1px solid var(--ok-border);
    }
    .error { color: var(--err); background: var(--err-bg); border-color: var(--err-border); }
    h1 { margin: 16px 0 8px; font-size: var(--text-2xl); line-height: 1.15; letter-spacing: -0.035em; }
    p { max-width: 32ch; margin: 0 auto; color: var(--muted); text-wrap: pretty; }
  </style>
</head>
<body>
  <main>
    <header>${appName}
      <span class="status${received ? '' : ' error'}" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="${received ? 'M5 12l4 4L19 6' : 'M7 7l10 10M17 7L7 17'}"/>
        </svg>
      </span>
    </header>
    <section aria-labelledby="status-title">
      <div class="empty-art" aria-hidden="true">
        <div class="sparkles">${'<span class="oc-sparkle oc-twinkle"></span>'.repeat(3)}</div>
      </div>
      <h1 id="status-title">${title}</h1>
      <p>${message}</p>
    </section>
  </main>
</body>
</html>`)
}
