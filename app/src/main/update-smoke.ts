/**
 * Smoke checks for the app's own updates, against the real window. An isolated
 * run never checks GitHub or downloads anything (main/run-mode.ts), so the
 * states are set from main with simulateAppUpdate and what is judged is what
 * rendered: where the titlebar button sits against everything else there,
 * that a real press opens its menu, what Settings says. The install itself is
 * tests/update-install.test.ts and a real update; neither fits in a smoke run.
 *
 * Runs inside the full run or alone (OPENCOURSE_SMOKE_ONLY=updates), and
 * leaves nothing to report, so the screens after it are as they were.
 */
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureExampleCourse, OPEN_EXAMPLE_LESSON } from './reading-smoke'
import { simulateAppUpdate } from './updates'

interface Result { name: string; ok: boolean; detail: string }

const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (e) => e && e.getBoundingClientRect().width > 0;
  const wait = async (selector, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = [...document.querySelectorAll(selector)].find(visible);
      if (el) return el;
      await sleep(50);
    }
    throw new Error('timed out waiting for ' + selector);
  };
  const until = async (test, what, timeout = 6000) => {
    const t0 = Date.now();
    while (!(await test())) { if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const chip = () => document.querySelector('.titlebar .update-chip');
`

const AVAILABLE = {
  state: 'available' as const,
  version: '9.9.9',
  size: 152_000_000,
  notesUrl: 'https://github.com/s3298321/opencourse/releases/tag/v9.9.9',
  installable: true
}

export async function appUpdateChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  /** For a person to look at: os.tmpdir()/opencourse-update-<name>.png, the titlebar and a little below. */
  const shot = async (name: string): Promise<void> => {
    try {
      win.webContents.invalidate()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const [width] = win.getContentSize()
      writeFileSync(join(tmpdir(), `opencourse-update-${name}.png`), (await win.webContents.capturePage({ x: 0, y: 0, width: width!, height: 240 })).toPNG())
    } catch { /* best effort */ }
  }
  const run = async (name: string, body: string): Promise<void> => {
    try {
      const detail = await win.webContents.executeJavaScript(`(async () => { ${HELPERS} ${body} })()`)
      results.push({ name, ok: true, detail: String(detail ?? '') })
    } catch (err) {
      results.push({ name, ok: false, detail: String(err) })
    }
  }
  /** A real press, routed by the browser, at the centre of what `selector` finds. */
  const press = async (name: string, selector: string): Promise<void> => {
    try {
      const box = await win.webContents.executeJavaScript(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getBoundingClientRect().width > 0);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`) as { x: number; y: number } | null
      if (!box) throw new Error('nothing to press at ' + selector)
      const cdp = win.webContents.debugger
      const attached = cdp.isAttached()
      if (!attached) cdp.attach('1.3')
      try {
        const at = { x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1 }
        await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
        await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...at })
        await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at })
      } finally {
        if (!attached) cdp.detach()
      }
    } catch (err) {
      results.push({ name, ok: false, detail: String(err) })
    }
  }

  try {
    await run('the bridge offers exactly the update methods', `
      const names = Object.keys(window.opencourse).filter((name) => /AppUpdate/.test(name)).sort();
      const expected = ['checkForAppUpdate', 'getAppUpdate', 'installAppUpdate', 'onAppUpdateChanged', 'setAppUpdateAutomatic'];
      if (names.join() !== expected.join()) throw new Error(names.join(', '));
      return names.length + ' methods';
    `)

    await run('nothing to update shows nothing, and checking is off until it is turned on', `
      if (chip()) throw new Error('an update button with nothing to update');
      const info = await window.opencourse.getAppUpdate();
      if (info.automatic !== false) throw new Error('automatic checks are on in a new profile');
      if (info.status.state !== 'idle') throw new Error('the status is ' + info.status.state + ' before any check');
      return info.currentVersion;
    `)

    await ensureExampleCourse(win)
    await run('(setup) a lesson, with its Ask chip', `
      ${OPEN_EXAMPLE_LESSON}
      await wait('.titlebar .chat-chip');
      return document.querySelector('.lesson-head h1').textContent;
    `)

    simulateAppUpdate(AVAILABLE)
    await run('an available update is the first control in the titlebar, left of all the others', `
      const button = await wait('.titlebar .update-chip');
      const right = document.querySelector('.titlebar-right');
      if (right.firstElementChild !== button) throw new Error('first in the cluster is ' + right.firstElementChild.className);
      const edge = button.getBoundingClientRect().right;
      for (const other of ['.chat-chip', '.section-switch', '.user-chip']) {
        const box = document.querySelector('.titlebar ' + other).getBoundingClientRect();
        if (edge > box.left + 0.5) throw new Error('it is not left of ' + other);
      }
      if (button.tagName !== 'BUTTON') throw new Error('it is a ' + button.tagName);
      const region = getComputedStyle(button).getPropertyValue('-webkit-app-region');
      if (region === 'drag') throw new Error('it is part of the window drag region');
      if (button.querySelector('.update-chip-text').textContent !== 'Update') throw new Error('it reads ' + button.textContent);
      if (button.getAttribute('aria-label') !== 'Update') throw new Error('its name is ' + button.getAttribute('aria-label'));
      // Room to spare at this width, so the way back is still in the middle.
      const crumbs = document.querySelector('.titlebar .crumbs a').getBoundingClientRect();
      const off = crumbs.left + crumbs.width / 2 - window.innerWidth / 2;
      if (Math.abs(off) > 2) throw new Error('the way back is ' + Math.round(off) + 'px off centre');
      return button.textContent.trim() + ', ' + Math.round(button.getBoundingClientRect().width) + 'px';
    `)
    await shot('titlebar')
  } catch (err) {
    results.push({ name: 'update checks stopped', ok: false, detail: String(err) })
  }

  await press('the update button pressed', '.titlebar .update-chip')
  await shot('menu')
  await run('its menu installs in one press, and points at what is new and at Settings', `
    const panel = await wait('.menu-panel.update-menu');
    const items = [...panel.querySelectorAll('.menu-item')].map((b) => b.querySelector('.menu-item-label').textContent);
    const expected = ['Install OpenCourse 9.9.9 and restart', 'What’s new', 'Update settings…'];
    if (items.join('|') !== expected.join('|')) throw new Error(items.join('|'));
    const hint = panel.querySelector('.menu-item-hint').textContent;
    if (hint !== '152 MB') throw new Error('size hint ' + hint);
    return items.join(' / ');
  `)
  await run('Update settings… opens Settings at the update', `
    [...document.querySelectorAll('.update-menu .menu-item')].find((b) => /Update settings/.test(b.textContent)).click();
    const section = await wait('.settings-updates');
    await sleep(150);
    const box = section.getBoundingClientRect();
    if (box.top < 0 || box.top > window.innerHeight / 2) throw new Error('the section is at ' + Math.round(box.top) + 'px');
    if (!/OpenCourse 9\\.9\\.9 is available/.test(section.textContent)) throw new Error(section.textContent.slice(0, 200));
    if (!section.querySelector('.settings-update-install')) throw new Error('no Install and restart');
    if (section.querySelector('.settings-update-automatic').checked) throw new Error('automatic checks show as on');
    if (!chip()) throw new Error('the titlebar lost its button on Settings');
    document.querySelector('.titlebar .crumbs a').click();
    await wait('.lesson-head h1');
    return 'section at ' + Math.round(box.top) + 'px';
  `)

  simulateAppUpdate({ state: 'downloading', version: '9.9.9', received: 63_840_000, total: 152_000_000 })
  await run('a download in progress says how far it is', `
    await until(() => chip() && chip().querySelector('.update-chip-text').textContent === 'Updating 42%', 'the button to read 42%');
    return chip().querySelector('.update-chip-text').textContent;
  `)

  simulateAppUpdate(AVAILABLE)
  const size = win.getSize()
  win.setSize(720, size[1]!)
  await run('at the narrowest window the titlebar still fits all of it', `
    await sleep(400);
    const bar = document.querySelector('.titlebar');
    const right = document.querySelector('.titlebar-right').getBoundingClientRect();
    const middle = document.querySelector('.titlebar .crumbs').getBoundingClientRect();
    const widths = [...document.querySelector('.titlebar-right').children].map((c) => c.className.split(' ').pop() + ' ' + Math.round(c.getBoundingClientRect().width)).join(', ');
    if (right.right > window.innerWidth + 0.5) throw new Error('the controls run off the window: ' + Math.round(right.right) + ' > ' + window.innerWidth + ' (' + widths + '; cluster from ' + Math.round(right.left) + ')');
    if (middle.right > right.left + 0.5) throw new Error('the way back runs under the controls');
    if (bar.scrollWidth > bar.clientWidth + 1) throw new Error('the titlebar scrolls sideways');
    if (visible(chip().querySelector('.update-chip-text'))) throw new Error('the button kept its words at this width');
    if (!visible(chip().querySelector('.update-chip-glyph'))) throw new Error('the button lost its arrow');
    return window.innerWidth + 'px wide, ' + Math.round(chip().getBoundingClientRect().width) + 'px button';
  `)
  await shot('narrow')
  win.setSize(size[0]!, size[1]!)

  simulateAppUpdate(null)
  await run('the button goes when there is nothing to update', `
    await until(() => !chip(), 'the update button to go');
    return 'gone';
  `)
  return results
}
