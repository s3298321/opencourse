/**
 * The server journey through the real window, against the real server.
 *
 *   npm --prefix ../server run build
 *   OPENCOURSE_SMOKE_SERVER=1 npm run smoke
 *
 * Spawns server/dist with this Electron as its Node (ELECTRON_RUN_AS_NODE),
 * on a free loopback port, with a throwaway data directory and the
 * development outbox for sign-up codes. Two local users then do what people
 * do: the author signs up in Settings and publishes the example course; the
 * learner finds it in the catalog, reads its overview and adds it; the author
 * edits it, raises its version with ⌘S and publishes again; the learner
 * updates; the author rolls back. Every screen is screenshotted, because a
 * check that passes on an empty box is the failure smoke exists to catch.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, Menu, type BrowserWindow } from 'electron'
import { createUser } from './users'
import { specResourcesDir } from './paths'

interface Result { name: string; ok: boolean; detail: string }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

async function startServer(dataDir: string): Promise<{ base: string; child: ChildProcess }> {
  const port = await freePort()
  const entry = join(app.getAppPath(), '..', 'server', 'dist', 'index.js')
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENCOURSE_SERVER_DEV: '1', OPENCOURSE_SERVER_PORT: String(port), OPENCOURSE_SERVER_DATA: dataDir, OPENCOURSE_SERVER_NAME: 'Smoke server' },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  const base = `http://127.0.0.1:${port}`
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`${base}/api/v1/server`)).ok) return { base, child } } catch { /* not yet */ }
    if (child.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 100))
  }
  child.kill()
  throw new Error(`The server did not start (build it with npm --prefix ../server run build): ${stderr.slice(-500)}`)
}

export async function serverSmoke(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const work = mkdtempSync(join(tmpdir(), 'opencourse-server-smoke-'))
  const { base, child } = await startServer(join(work, 'server'))
  const code = async (email: string): Promise<string> => {
    const { messages } = await (await fetch(`${base}/dev/outbox`)).json() as { messages: { to: string; text: string }[] }
    return [...messages].reverse().find((m) => m.to === email)!.text.match(/\b(\d{6})\b/)![1]!
  }
  const shot = async (name: string): Promise<void> => {
    await new Promise((r) => setTimeout(r, 250))
    writeFileSync(join(tmpdir(), `opencourse-server-${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const nav = (action: string): void => win.webContents.send('app:navigate', action)
  const run = async (name: string, source: string): Promise<unknown> => {
    try {
      const detail = await win.webContents.executeJavaScript(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const wait = async (test, what) => { for (let n = 0; n < 240; n++) { const r = test(); if (r) return r; await sleep(25); } throw new Error('Timed out waiting for ' + (what || test.toString())); };
        const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
        const press = async text => (await wait(() => { const b = button(text); return b && !b.disabled && b; }, 'button ' + text)).click();
        const type = async (selector, value) => { const input = await wait(() => document.querySelector(selector), selector); const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(40); };
        const field = label => [...document.querySelectorAll('.server-field')].find(l => l.textContent.trim().startsWith(label))?.querySelector('input, textarea, select');
        const typeField = async (label, value) => { const input = await wait(() => field(label), 'field ' + label); const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(40); };
        const pickUser = async name => { await wait(() => document.querySelector('.user-pick'), 'user picker'); [...document.querySelectorAll('.user-pick')].find(b => b.textContent.includes(name)).click(); await wait(() => document.querySelector('.library'), 'library'); };
        ${source}
      })()`)
      results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
      return detail
    } catch (error) {
      await shot('failure')
      results.push({ name, ok: false, detail: String(error) })
      throw error
    }
  }

  try {
    createUser('Author')
    createUser('Learner')
    await new Promise<void>((resolve) => { win.webContents.once('did-finish-load', () => resolve()); win.reload() })
    await run('author picks their profile', `await pickUser('Author'); return 'library'`)

    nav('settings')
    await run('settings: the address is checked, then an account is offered', `
      await wait(() => document.querySelector('.server-settings'), 'servers section');
      await press('Connect to a server…');
      await typeField('Server address', ${JSON.stringify(base)});
      await press('Continue');
      await wait(() => document.querySelector('.server-connect-head h3')?.textContent === 'Smoke server', 'server name');
      await press('Create an account');
      await typeField('Email address', 'author@example.org');
      await press('Send code');
      await wait(() => field('Code'), 'code field');
      return 'Code sent';
    `)
    await shot('signup-code')
    await run('settings: code, username and password make an account', `
      await typeField('Code', ${JSON.stringify(await code('author@example.org'))});
      await press('Confirm');
      await typeField('Username', 'author');
      await wait(() => document.querySelector('.server-username-state.ok'), 'username available');
      await press('Continue');
      await typeField('Password', 'a long enough password');
      await typeField('Repeat the password', 'a long enough password');
      await press('Create account');
      const card = await wait(() => document.querySelector('.server-card-account.signed-in'), 'signed-in card');
      if (!card.textContent.includes('author') || !document.querySelector('.server-card.active')) throw new Error('Card does not show the account as active');
      if (document.body.innerHTML.includes('ocs_')) throw new Error('A token reached the page');
      return card.textContent;
    `)
    await shot('settings')

    const example = join(specResourcesDir(), 'opencourse-example-course.zip')
    nav('library')
    await run('author publishes the example course from its page', `
      const imported = await window.opencourse.importCoursePath(${JSON.stringify(example)});
      if (imported.status !== 'ok') throw new Error(JSON.stringify(imported));
      await wait(() => document.querySelector('.library'), 'library');
      (await wait(() => [...document.querySelectorAll('.course-card')].find(c => c.textContent.includes('example course')), 'imported card')).click();
      await wait(() => document.querySelector('.course-origin-line'), 'origin line');
      if (!document.querySelector('.course-origin-line').textContent.includes('Local')) throw new Error('A local course does not say Local');
      await press('Publish…');
      await wait(() => button('Publish v0.1.0') && !button('Publish v0.1.0').disabled, 'publish preview');
      await typeField('What changed', 'The first release.');
      return 'Ready to publish';
    `)
    await shot('publish')
    await run('author: published, the course is now theirs on the server', `
      await press('Publish v0.1.0');
      await wait(() => document.querySelector('.course-server-panel [role="status"]')?.textContent.includes('Published v0.1.0'), 'published note');
      await press('Close');
      await wait(() => document.querySelector('.course-origin-line')?.textContent.includes('Smoke server'), 'server origin');
      await wait(() => button('Manage publication'), 'manage button');
      return document.querySelector('.course-origin-line').textContent;
    `)

    nav('users')
    await run('learner: signs up, finds the course in the catalog and reads its overview', `
      await pickUser('Learner');
      const r1 = await window.opencourse.startServerSignUp(${JSON.stringify(base)}, 'learner@example.org');
      if (!r1.ok) throw new Error(r1.message);
      window.__flow = r1.value.flowId;
      return 'sign-up started';
    `)
    await run('learner: completes sign-up', `
      const verified = await window.opencourse.verifyServerCode(window.__flow, ${JSON.stringify(await code('learner@example.org'))});
      if (!verified.ok) throw new Error(verified.message);
      const done = await window.opencourse.completeServerSignUp(window.__flow, 'learner', 'another long password');
      if (!done.ok) throw new Error(done.message);
      await press('Course catalog');
      const card = await wait(() => document.querySelector('.catalog-card'), 'catalog card');
      if (!card.textContent.includes('v0.1.0') || !card.textContent.includes('author')) throw new Error('Card lacks version or publisher: ' + card.textContent);
      return card.textContent;
    `)
    await shot('catalog')
    await run('learner: searches, opens the overview and adds the course', `
      await type('.catalog-search', 'example');
      await wait(() => document.querySelector('.catalog-count')?.textContent.includes('1 course'), 'search result');
      document.querySelector('.catalog-card').click();
      await wait(() => document.querySelector('.catalog-detail .catalog-versions'), 'overview');
      if (!document.querySelector('.catalog-versions').textContent.includes('The first release.')) throw new Error('Release note missing');
      return 'overview';
    `)
    await shot('catalog-course')
    await run('learner: the added course shows its server and version', `
      await press('Add to my courses');
      await press('Open in my courses');
      const line = await wait(() => document.querySelector('.course-origin-line'), 'origin line');
      if (!line.textContent.includes('Smoke server') || !line.textContent.includes('v0.1.0') || !line.textContent.includes('Published by author')) throw new Error(line.textContent);
      if (button('Publish…')) throw new Error('A learner is offered Publish');
      document.querySelector('.lesson-row').click();
      await wait(() => button('Mark lesson completed'), 'lesson'); await press('Mark lesson completed');
      await wait(() => button('✓ Lesson completed'), 'completed');
      return line.textContent;
    `)
    nav('library')
    await run('learner: My courses shows the badges', `
      await wait(() => document.querySelector('.origin-badge.from-server'), 'server badge');
      return [...document.querySelectorAll('.course-card-origin')].map(e => e.textContent).join(' | ');
    `)
    await shot('library')

    nav('users')
    await run('author: raises the version in the editor and saves with the menu', `
      await pickUser('Author');
      (await wait(() => [...document.querySelectorAll('.course-card')].find(c => c.textContent.includes('example course')), 'course card')).click();
      await press('Edit course');
      await wait(() => document.querySelector('.course-editor'), 'editor');
      await wait(() => document.querySelector('[aria-label="Course version"]'), 'version field');
      if (!document.querySelector('.author-form').textContent.includes('Last published as v0.1.0')) throw new Error('No publish hint');
      await type('[aria-label="Course version"]', '0.2.0');
      await type('[aria-label="Course title"]', 'The OpenCourse example course, revised');
      await wait(() => document.querySelector('.author-save-state')?.textContent === 'Unsaved changes', 'unsaved');
      await sleep(250);
      return 'edited';
    `)
    await shot('editor-version')
    Menu.getApplicationMenu()?.getMenuItemById('save-course')?.click()
    await run('author: publishes v0.2.0 from the course page', `
      await wait(() => document.querySelector('.author-save-state')?.textContent === 'All changes saved', 'saved');
      document.querySelector('.crumbs a').click();
      (await wait(() => [...document.querySelectorAll('.course-card')].find(c => c.textContent.includes('revised')), 'revised card')).click();
      await press('Publish a new version…');
      await press('Publish v0.2.0');
      await wait(() => document.querySelector('.course-server-panel [role="status"]')?.textContent.includes('Published v0.2.0'), 'published');
      return 'v0.2.0';
    `)

    nav('users')
    await run('learner: is offered the update, sees what it does, installs it', `
      await pickUser('Learner');
      await wait(() => document.querySelector('.update-badge.update')?.textContent.includes('v0.2.0'), 'update badge');
      (await wait(() => [...document.querySelectorAll('.course-card')].find(c => c.querySelector('.origin-badge.from-server')), 'server card')).click();
      await press('Update to v0.2.0…');
      await wait(() => button('Install v0.2.0') && !button('Install v0.2.0').disabled, 'update preview');
      return document.querySelector('.course-server-panel').textContent;
    `)
    await shot('update')
    await run('learner: updated, and the completed lesson is still completed', `
      await press('Install v0.2.0');
      await wait(() => document.querySelector('.course-origin-line')?.textContent.includes('v0.2.0'), 'new version');
      await wait(() => document.querySelector('.detail h1')?.textContent.includes('revised'), 'new title');
      const course = (await window.opencourse.listCourses()).find(c => c.origin);
      const progress = await window.opencourse.getProgress(course.courseId);
      if (!progress.completedLessons.length) throw new Error('Progress was lost in the update');
      return 'kept ' + progress.completedLessons.length + ' completed lesson(s)';
    `)

    nav('users')
    await run('author: manages the publication and rolls back', `
      await pickUser('Author');
      (await wait(() => [...document.querySelectorAll('.course-card')].find(c => c.textContent.includes('revised')), 'revised card')).click();
      await press('Manage publication');
      await wait(() => document.querySelectorAll('.publication-versions tbody tr').length === 2, 'two versions');
      return document.querySelector('.publication-versions').textContent;
    `)
    await shot('publication')
    await run('author: makes v0.1.0 current again', `
      await press('Make current');
      await wait(() => document.querySelector('.dialog'), 'confirm'); document.querySelector('.dialog-confirm').click();
      await wait(() => document.querySelector('.publication')?.textContent.includes('Listed in the catalog at v0.1.0'), 'rolled back');
      const statuses = [...document.querySelectorAll('.publication-versions tbody tr')].map(r => r.className);
      if (statuses.join() !== 'withdrawn,current') throw new Error(statuses.join());
      return statuses.join();
    `)
    await shot('publication-rolled-back')
  } catch { /* the failing step is in results */ }
  finally {
    child.kill()
    rmSync(work, { recursive: true, force: true })
  }
  return results
}
