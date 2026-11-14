/**
 * Smoke checks for a server that is not answering, against the real window:
 * a connection to a loopback port nothing listens on, the catalog it leads
 * to, Retry, and - once something answers on that port - the catalog coming
 * back by itself. The answering side is a few lines of node:http here, not
 * the real server; the real one going down and up is server-smoke's to show.
 *
 * Runs inside the full run or alone (OPENCOURSE_SMOKE_ONLY=servers), and
 * removes its connection afterwards, so the screens after it are as they were.
 */
import type { BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPreferences, writePreferences } from './preferences'
import { addUnsignedConnection, removeConnection } from './servers'

interface Result { name: string; ok: boolean; detail: string }

const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (e) => e && e.checkVisibility({ visibilityProperty: true });
  const find = (selector) => [...document.querySelectorAll(selector)].find(visible);
  const wait = async (selector, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const el = find(selector); if (el) return el; await sleep(50); }
    throw new Error('timed out waiting for ' + selector);
  };
  const until = async (test, what, timeout = 8000) => {
    const t0 = Date.now();
    while (!(await test())) { if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
`

const NAME = 'Down server'

/** Answers like an OpenCourse server with an empty catalog. */
function fakeServer(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    const body = path === '/api/v1/server' ? { opencourse: 1, api: 1, name: NAME, description: '', registration: 'open', version: '0.0.0' }
      : path === '/api/v1/courses' ? { courses: [], total: 0, page: 1, pageSize: 24 }
      : path === '/api/v1/tags' ? { tags: [] }
      : null
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body ?? { code: 'not_found', message: 'Not here.' }))
  })
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)) })
}

/** A loopback port that was free a moment ago: nothing answers on it. */
async function closedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

export async function serverHealthChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const run = async (name: string, body: string): Promise<void> => {
    try {
      const detail = await win.webContents.executeJavaScript(`(async () => { ${HELPERS} ${body} })()`)
      results.push({ name, ok: true, detail: String(detail ?? '') })
    } catch (err) {
      results.push({ name, ok: false, detail: String(err) })
    }
  }
  const shot = async (name: string): Promise<void> => {
    try {
      win.webContents.invalidate()
      await new Promise((resolve) => setTimeout(resolve, 300))
      writeFileSync(join(tmpdir(), `opencourse-server-health-${name}.png`), (await win.webContents.capturePage()).toPNG())
    } catch { /* best effort */ }
  }

  const port = await closedPort()
  const url = `http://127.0.0.1:${port}`
  const active = readPreferences().activeServer
  const connection = addUnsignedConnection(url, NAME)
  win.webContents.send('servers:changed')
  let fake: Server | null = null
  try {
    await run('a connection to a server that is not running shows it is down, not an error', `
      for (let n = 0; n < 3 && !find('.library'); n++) { find('.titlebar .crumbs a')?.click(); await sleep(250); }
      await wait('.library');
      const tab = await (async () => {
        for (let n = 0; n < 100; n++) {
          const t = [...document.querySelectorAll('.course-source-tabs [role="tab"]')].find((e) => e.textContent.startsWith(${JSON.stringify(NAME)}));
          if (t) return t;
          await sleep(50);
        }
        throw new Error('no source tab for the down server');
      })();
      tab.click();
      (await wait('.add-courses')).click();
      const notice = await wait('.server-unreachable');
      if (!notice.textContent.includes('Can’t reach ${NAME}')) throw new Error('the notice says ' + notice.textContent);
      if (find('.catalog .import-note.error')) throw new Error('a raw error is shown beside the notice');
      if (find('.catalog .meta') && /Loading/.test(find('.catalog .meta').textContent)) throw new Error('still loading');
      const status = (await window.opencourse.listServers()).find((s) => s.url === ${JSON.stringify(url)})?.status;
      if (status !== 'unreachable') throw new Error('status is ' + status);
      return notice.textContent.slice(0, 60);
    `)
    await shot('down')

    await run('Retry looks again and stays down while nothing answers', `
      const button = await wait('.server-unreachable .action-button');
      button.click();
      await until(() => button.disabled || /Checking/.test(button.textContent), 'Retry to start checking', 2000).catch(() => {});
      await until(() => !button.disabled && /Retry/.test(button.textContent), 'Retry to finish');
      await wait('.server-unreachable');
      return 'still down';
    `)

    fake = await fakeServer(port)
    await run('when the server answers again the catalog comes back by itself', `
      (await wait('.server-unreachable .action-button')).click();
      await until(() => !find('.server-unreachable'), 'the notice to go');
      const count = await wait('.catalog-count');
      if (!count.textContent.includes('0 courses')) throw new Error('the catalog says ' + count.textContent);
      const status = (await window.opencourse.listServers()).find((s) => s.url === ${JSON.stringify(url)})?.status;
      if (status !== 'online') throw new Error('status is ' + status);
      return count.textContent;
    `)
    await shot('back')
  } finally {
    await new Promise<void>((resolve) => fake ? fake.close(() => resolve()) : resolve())
    await removeConnection(connection.id).catch(() => undefined)
    const preferences = { ...readPreferences() }
    if (active) preferences.activeServer = active
    else delete preferences.activeServer
    writePreferences(preferences)
    win.webContents.send('servers:changed')
    await win.webContents.executeJavaScript(`(async () => { ${HELPERS}
      for (let n = 0; n < 3 && !find('.library'); n++) { find('.titlebar .crumbs a')?.click(); await sleep(250); }
    })()`).catch(() => undefined)
  }
  return results
}
