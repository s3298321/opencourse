/**
 * Smoke checks for themes, against the real window: the example theme and the
 * app's own look exported as a theme are imported through the real import
 * path, applied through Settings and View → Theme, and judged by what rendered
 * - computed colours, pictures that decoded, fonts that loaded, the editor
 * that survived. Leaves the app on its own look, so nothing after it notices.
 */
import { Menu, nativeTheme, type BrowserWindow, type MenuItem } from 'electron'
import { join } from 'node:path'
import { specResourcesDir } from './paths'

interface Result { name: string; ok: boolean; detail: string }

const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (selector, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = [...document.querySelectorAll(selector)].find((e) => e.getBoundingClientRect().width > 0);
      if (el) return el;
      await sleep(50);
    }
    throw new Error('timed out waiting for ' + selector);
  };
  const until = async (test, what, timeout = 6000) => {
    const t0 = Date.now();
    while (!(await test())) { if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const el = (target) => {
    if (typeof target !== 'string') return target;
    const found = [...document.querySelectorAll(target)].find((e) => e.getBoundingClientRect().width > 0) ?? document.querySelector(target);
    if (!found) throw new Error('nothing matches ' + target);
    return found;
  };
  const css = (target, prop, pseudo) => getComputedStyle(el(target), pseudo).getPropertyValue(prop).trim();
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const themed = () => Boolean(document.getElementById('opencourse-theme'));
  const openSettings = async () => {
    if (document.querySelector('.settings-appearance')) return;
    document.querySelector('.titlebar .user-chip').click();
    const menu = await wait('.menu-panel');
    [...menu.querySelectorAll('.menu-item')].find((b) => /Settings/.test(b.textContent)).click();
    await wait('.settings-appearance .theme-card');
  };
  const card = (name) => [...document.querySelectorAll('.settings-appearance .theme-card')].find((c) => c.querySelector('.theme-name').textContent === name);
  // The wordmark is only on screens without a back link, so look at it in the library.
  const library = async () => {
    if (document.querySelector('.settings')) { document.querySelector('.titlebar .crumbs a').click(); await sleep(250); }
    document.querySelector('.titlebar [data-section="courses"]').click();
    await wait('.library');
    await wait('.titlebar .brand img');
  };
  const family = (target) => css(target, 'font-family').replace(/"/g, '');
  /** What a background's first url() draws, as pixels - two spellings of one picture compare equal. */
  const pixels = async (background) => {
    const url = /url\\("([^"]*)"\\)/.exec(background)?.[1];
    if (!url) throw new Error('no picture in ' + background.slice(0, 60));
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, canvas.width, canvas.height).data;
  };
`

export async function themeChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const run = async (name: string, body: string): Promise<void> => {
    try {
      const detail = await win.webContents.executeJavaScript(`(async () => { ${HELPERS} ${body} })()`)
      results.push({ name, ok: true, detail: String(detail ?? '') })
    } catch (err) {
      results.push({ name, ok: false, detail: String(err) })
    }
  }
  const inMain = async (name: string, body: () => string | Promise<string>): Promise<void> => {
    try { results.push({ name, ok: true, detail: await body() }) } catch (err) { results.push({ name, ok: false, detail: String(err) }) }
  }
  const zips = {
    example: join(specResourcesDir(), 'opencourse-example-theme.zip'),
    exported: join(specResourcesDir(), 'opencourse-default-theme.zip')
  }
  const cdp = win.webContents.debugger
  const attached = cdp.isAttached()
  if (!attached) cdp.attach('1.3')

  try {
    await run('the app\'s own look has no theme stylesheet at all', `
      await library();
      if (themed()) throw new Error('a theme stylesheet is on the page before any theme was applied');
      if (document.documentElement.dataset.appearance) throw new Error('an appearance is set with no theme');
      window.__themeBaseline = {
        titlebar: css('.titlebar', 'background-color'),
        list: css('.content', 'background-color'),
        brand: css('.titlebar .brand', 'font-family'),
        weight: css('.titlebar .brand', 'font-weight'),
        prose: token('--reading-size'),
        mark: el('.titlebar .brand img').src,
        grain: css('.content', 'background-image')
      };
      await openSettings();
      const own = card('OpenCourse');
      if (!own || own.querySelector('.theme-choose').getAttribute('aria-pressed') !== 'true') throw new Error('the app\\'s own look is not shown as chosen');
      if (own.querySelector('.theme-remove')) throw new Error('the app\\'s own look offers to be removed');
      return 'no stylesheet, no appearance, own look chosen';
    `)

    await run('the theme bridge is exactly what it means to expose', `
      const methods = Object.keys(window.opencourse).filter((k) => /theme/i.test(k)).sort().join(',');
      const expected = ['applyTheme','getActiveTheme','importTheme','importThemePath','listThemes','onThemeChanged','onThemesChanged','removeTheme','saveThemeSpec','themeFontData'].join(',');
      if (methods !== expected) throw new Error('the theme surface changed: ' + methods);
      return methods;
    `)

    await run('a theme archive imports through the real path and is listed after the app\'s own look', `
      const result = await window.opencourse.importThemePath(${JSON.stringify(zips.example)});
      if (result.status !== 'ok') throw new Error(JSON.stringify(result));
      if (result.theme.active) throw new Error('importing applied the theme');
      await until(() => card('Paper & Ink'), 'the imported theme card');
      const names = [...document.querySelectorAll('.settings-appearance .theme-name')].map((n) => n.textContent);
      if (names[0] !== 'OpenCourse' || names[1] !== 'Paper & Ink') throw new Error(names.join(', '));
      const preview = card('Paper & Ink').querySelector('img.theme-preview');
      await preview.decode();
      if (preview.naturalWidth !== 480) throw new Error('the preview did not load: ' + preview.naturalWidth);
      if (themed()) throw new Error('the look changed on import');
      window.__themeId = result.theme.id;
      return names.join(', ');
    `)

    await run('choosing a theme applies its values - and nothing but values', `
      card('Paper & Ink').querySelector('.theme-choose').click();
      await until(() => themed() && document.documentElement.dataset.appearance === 'light', 'the theme to apply');
      const sheet = document.getElementById('opencourse-theme').sheet;
      const rules = [...sheet.cssRules].flatMap((rule) => rule.cssRules ? [...rule.cssRules] : [rule]);
      for (const rule of rules) {
        if (rule.selectorText !== ':root') throw new Error('a theme wrote a rule for ' + rule.selectorText);
        for (const property of rule.style) if (!property.startsWith('--')) throw new Error('a theme set ' + property);
      }
      if (document.head.lastElementChild.id !== 'opencourse-theme') throw new Error('the theme is not the last stylesheet');
      if (card('Paper & Ink').querySelector('.theme-choose').getAttribute('aria-pressed') !== 'true') throw new Error('the card does not say it is chosen');
      if (css(document.documentElement, 'color-scheme') !== 'light') throw new Error('color-scheme stayed ' + css(document.documentElement, 'color-scheme'));
      const titlebar = document.querySelector('.titlebar');
      if (css(titlebar, 'background-color') !== 'rgba(246, 241, 231, 0.72)') throw new Error('titlebar ' + css(titlebar, 'background-color'));
      if (!css(titlebar, 'background-image').includes('paper-grain.png')) throw new Error('the titlebar has no grain texture');
      if (css(document.querySelector('.content'), 'background-color') !== 'rgb(248, 244, 236)') throw new Error('reading surface ' + css(document.querySelector('.content'), 'background-color'));
      // The reading surface asks for the texture at half strength, which the
      // renderer draws on a canvas; the titlebar takes it as authored.
      await until(() => css('.content', 'background-image').startsWith('url("data:image/png'), 'the faded reading texture');
      if (css(document.body, 'background-color') !== 'rgba(0, 0, 0, 0)') throw new Error('body is painted');
      const backdrop = css(document.body, 'background-image', '::before');
      if (!backdrop.includes('desk.jpg') || css(document.body, 'filter', '::before') !== 'blur(6px)') throw new Error('window picture: ' + backdrop.slice(0, 80));
      return rules.length + ' :root blocks, light, picture behind the window';
    `)

    await run('its fonts arrive as bytes and the wordmark and text use them', `
      await library();
      await document.fonts.ready;
      const face = [...document.fonts].find((f) => f.family.replace(/"/g, '') === 'Ledger Dots');
      if (!face || face.status !== 'loaded') throw new Error('Ledger Dots is ' + (face ? face.status : 'missing'));
      if (!document.fonts.check('16px "Ledger Dots"')) throw new Error('the font does not match');
      const brand = family(document.querySelector('.brand'));
      if (!brand.startsWith('Ledger Dots')) throw new Error('wordmark font ' + brand);
      if (!family(document.body).startsWith('Avenir Next')) throw new Error('UI font ' + family(document.body));
      if (document.querySelector('.brand span').textContent !== 'OpenCourse') throw new Error('the wordmark text changed');
      return 'Ledger Dots loaded; ' + brand.split(',')[0];
    `)

    await run('its pictures load through the asset protocol, and its mark replaces the app\'s', `
      const mark = document.querySelector('.titlebar .brand img');
      if (!mark.src.startsWith('opencourse://themes/' + window.__themeId + '/')) throw new Error('mark ' + mark.src);
      await mark.decode();
      if (!mark.naturalWidth) throw new Error('the mark did not load');
      const linen = new Image();
      linen.src = 'opencourse://themes/' + window.__themeId + '/images/linen.png';
      await linen.decode();
      if (linen.naturalWidth !== 128) throw new Error('linen is ' + linen.naturalWidth);
      const json = new Image();
      json.src = 'opencourse://themes/' + window.__themeId + '/theme.json';
      const refused = await json.decode().then(() => false, () => true);
      if (!refused) throw new Error('theme.json was served');
      return 'mark ' + mark.naturalWidth + 'px; theme.json refused';
    `)

    await inMain('the window follows the theme: light appearance, no vibrancy, the theme\'s window colour', () => {
      if (nativeTheme.themeSource !== 'light') throw new Error(`themeSource ${nativeTheme.themeSource}`)
      const background = win.getBackgroundColor().toLowerCase()
      if (background !== '#e9e1d2') throw new Error(`background ${background}`)
      return `${nativeTheme.themeSource}, ${background}`
    })

    await inMain('View → Theme lists the app\'s own look and every theme, ticking the applied one', () => {
      const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View')
      const theme = view?.submenu?.items.find((item: MenuItem) => item.label === 'Theme')
      const items = (theme?.submenu?.items ?? []).filter((item: MenuItem) => item.type === 'radio')
      const labels = items.map((item: MenuItem) => `${item.checked ? '✓' : ' '}${item.label}`)
      if (labels.join('|') !== ' OpenCourse (no theme)|✓Paper & Ink') throw new Error(labels.join('|'))
      return labels.join(', ')
    })

    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-contrast', value: 'more' }
    ] })
    await run('under reduced transparency and more contrast, a theme\'s surfaces turn opaque and its pictures go', `
      const titlebar = document.querySelector('.titlebar');
      if (css(titlebar, 'background-color') !== 'rgb(238, 231, 218)') throw new Error('titlebar ' + css(titlebar, 'background-color'));
      if (css(titlebar, 'background-image') !== 'none') throw new Error('titlebar keeps its grain');
      if (css(document.body, 'background-image', '::before') !== 'none') throw new Error('the window picture stayed');
      const list = document.querySelector('.content');
      if (css(list, 'background-color') !== 'rgb(240, 234, 222)') throw new Error('the library list stayed translucent: ' + css(list, 'background-color'));
      if (css(list, 'background-image') !== 'none') throw new Error('the library list keeps its grain');
      if (token('--border') !== '#99948d') throw new Error('contrast border ' + token('--border'));
      return 'opaque chrome, no pictures, stronger borders';
    `)
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] })

    await run('the editor and terminal take a new theme in place, keeping their state', `
      await library();
      [...document.querySelectorAll('.course-card')].find((c) => /Python asyncio/.test(c.textContent)).click();
      await wait('.detail');
      [...document.querySelectorAll('.lesson-row')].find((r) => /await, create_task/.test(r.textContent)).click();
      const exercise = await wait('.exercise');
      [...exercise.querySelectorAll('.actions button')].find((b) => /open editor|editor open/i.test(b.textContent)).click();
      const editor = await wait('.workbench .cm-editor');
      const terminal = await wait('.workbench .xterm');
      await sleep(300);
      const view = editor.querySelector('.cm-content');
      const marker = 'theme-smoke-' + Date.now();
      view.dataset.smoke = marker;
      if (css(editor, 'background-color') !== 'rgb(239, 232, 218)') throw new Error('editor under the theme ' + css(editor, 'background-color'));
      if (!family(editor.querySelector('.cm-scroller')).startsWith('Menlo')) throw new Error('editor font ' + family(editor.querySelector('.cm-scroller')));
      await window.opencourse.applyTheme(null);
      await until(() => !themed(), 'the theme to come off');
      await until(() => css(editor, 'background-color') === 'rgb(29, 29, 33)', 'the editor to take the app\\'s own colours');
      if (!editor.isConnected || editor.querySelector('.cm-content').dataset.smoke !== marker) throw new Error('the editor was recreated');
      if (!terminal.isConnected) throw new Error('the terminal was recreated');
      return 'same editor and terminal, recoloured in place';
    `)

    await run('the app\'s own look, exported as a theme, renders exactly as no theme does', `
      const result = await window.opencourse.importThemePath(${JSON.stringify(zips.exported)});
      if (result.status !== 'ok') throw new Error(JSON.stringify(result));
      try {
        await library();
        const before = window.__themeBaseline;
        await window.opencourse.applyTheme(result.theme.id);
        await until(() => themed() && document.querySelector('.titlebar .brand img').src.startsWith('opencourse://themes/'), 'the exported theme to apply');
        const mark = document.querySelector('.titlebar .brand img');
        await mark.decode();
        const now = {
          titlebar: css('.titlebar', 'background-color'),
          list: css('.content', 'background-color'),
          brand: css('.titlebar .brand', 'font-family'),
          weight: css('.titlebar .brand', 'font-weight'),
          prose: token('--reading-size')
        };
        for (const key of Object.keys(now)) if (now[key] !== before[key]) throw new Error(key + ': ' + before[key] + ' became ' + now[key]);
        // The grain is the same picture spelled differently (Vite inlines the
        // file its own way; the theme generates it), so compare what it draws.
        const [own, exported] = [await pixels(before.grain), await pixels(css('.content', 'background-image'))];
        if (own.length !== exported.length) throw new Error('grain tiles differ in size');
        let worst = 0;
        for (let i = 0; i < own.length; i++) worst = Math.max(worst, Math.abs(own[i] - exported[i]));
        if (worst > 2) throw new Error('the grain draws differently, by up to ' + worst);
        if (document.documentElement.dataset.appearance !== 'dark') throw new Error('appearance ' + document.documentElement.dataset.appearance);
        if (!mark.naturalWidth) throw new Error('the exported mark did not load');
        return 'titlebar, list, wordmark and type unchanged; grain identical to the pixel';
      } finally {
        await window.opencourse.removeTheme(result.theme.id);
        await until(() => !themed(), 'the exported theme to come off');
      }
    `)

    await run('removing the applied theme returns to the app\'s own look', `
      await library();
      await window.opencourse.applyTheme(window.__themeId);
      await until(() => themed(), 'the example theme to apply again');
      await window.opencourse.removeTheme(window.__themeId);
      await until(() => !themed() && !document.documentElement.dataset.appearance, 'the theme to come off');
      await until(() => document.querySelector('.titlebar .brand img').src === window.__themeBaseline.mark, 'the app\\'s own mark');
      if (token('--bg') !== '#111110') throw new Error('--bg ' + token('--bg'));
      if ([...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Ledger Dots')) throw new Error('the theme font stayed');
      if ((await window.opencourse.listThemes()).length) throw new Error('a theme is still installed');
      return 'own look, own mark, no theme fonts';
    `)

    await inMain('the window is back to the app\'s own: dark, with vibrancy where macOS allows it', () => {
      if (nativeTheme.themeSource !== 'dark') throw new Error(`themeSource ${nativeTheme.themeSource}`)
      return nativeTheme.themeSource
    })
  } finally {
    // Hand the next suite the app's own look on an ordinary screen.
    await win.webContents.executeJavaScript(`(async () => { ${HELPERS}
      await window.opencourse.applyTheme(null).catch(() => undefined);
      await library().catch(() => undefined);
    })()`).catch(() => undefined)
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => undefined)
    if (!attached) cdp.detach()
  }
  return results
}
