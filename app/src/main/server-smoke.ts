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
 * updates; the author rolls back. Then the same for a PDF: the author
 * publishes one from its page, the learner adds it from the document catalog,
 * reads, and the progress is on the server; a new version keeps it. Every
 * screen is screenshotted, because a check that passes on an empty box is the
 * failure smoke exists to catch.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, Menu, type BrowserWindow } from 'electron'
import { createUser } from './users'
import { specResourcesDir } from './paths'
import { importDocument } from './documents'
import { fixturePdf } from '../../tests/helpers/pdf'

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
        // The library lists one source at a time: Local, then each server.
        const serverTab = async () => { const tab = await wait(() => [...document.querySelectorAll('.course-source-tabs [role="tab"]')].find(t => t.textContent.startsWith('Smoke server')), 'server tab'); if (tab.getAttribute('aria-selected') !== 'true') tab.click(); };
        // Screens of the other workspaces stay mounted, hidden: the document steps look at what shows.
        const shown = e => e && e.checkVisibility({ visibilityProperty: true });
        const vbutton = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && shown(b));
        const vpress = async text => (await wait(() => { const b = vbutton(text); return b && !b.disabled && b; }, 'visible button ' + text)).click();
        const vfield = label => [...document.querySelectorAll('.server-field')].find(l => shown(l) && l.textContent.trim().startsWith(label))?.querySelector('input, textarea, select');
        const vtype = async (label, value) => { const input = await wait(() => vfield(label), 'field ' + label); const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(40); };
        const documents = async source => {
          document.querySelector('[data-section="documents"]').click();
          const tab = await wait(() => [...document.querySelectorAll('[aria-label="Document source"] [role="tab"]')].find(t => shown(t) && t.textContent.startsWith(source)), 'document source ' + source);
          if (tab.getAttribute('aria-selected') !== 'true') tab.click();
          await sleep(300);
        };
        const openDocument = async title => (await wait(() => [...document.querySelectorAll('.document-card-open')].find(c => shown(c) && c.textContent.includes(title)), 'document ' + title)).click();
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
      (await wait(() => document.querySelector('[data-settings-category="servers"]'), 'servers category')).click();
      await wait(() => document.querySelector('.server-settings'), 'servers section');
      await press('Connect to a server');
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
      await press('Publish');
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
      (await wait(() => [...document.querySelectorAll('.course-source-tabs button')].find(b => b.textContent.includes('Smoke server')), 'server source')).click();
      await wait(() => document.querySelector('.add-courses'), 'add courses button');
      await press('Add courses');
      const card = await wait(() => document.querySelector('.catalog-card'), 'catalog card');
      if (!card.textContent.includes('v0.1.0') || !card.textContent.includes('author')) throw new Error('Card lacks version or publisher: ' + card.textContent);
      const tag = await wait(() => card.querySelector('.course-card-tag-list .tag'), 'whole tag beneath the cover');
      const cover = card.querySelector('.course-card-media img');
      if (!cover || tag.getBoundingClientRect().top < cover.getBoundingClientRect().bottom || tag.getBoundingClientRect().bottom > card.getBoundingClientRect().bottom) throw new Error('Catalog tags do not fit below the cover');
      if (document.querySelector('.server-catalog h1').textContent !== 'Smoke server' || document.querySelector('.catalog-server-name')) throw new Error('Server name is not solely in the page heading');
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
      if (button('Publish')) throw new Error('A learner is offered Publish');
      document.querySelector('.lesson-row').click();
      await wait(() => button('Mark lesson completed'), 'lesson'); await press('Mark lesson completed');
      await wait(() => button('Lesson completed'), 'completed');
      return line.textContent;
    `)
    nav('library')
    await run('learner: My courses shows the badges', `
      await serverTab();
      await wait(() => document.querySelector('.origin-badge.from-server'), 'server badge');
      return [...document.querySelectorAll('.course-card-origin')].map(e => e.textContent).join(' | ');
    `)
    await shot('library')

    nav('users')
    await run('author: raises the version in the editor and saves with the menu', `
      await pickUser('Author');
      await serverTab();
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
      await serverTab();
      (await wait(() => [...document.querySelectorAll('.course-card')].find(c => c.textContent.includes('revised')), 'revised card')).click();
      await press('Publish a new version');
      await press('Publish v0.2.0');
      await wait(() => document.querySelector('.course-server-panel [role="status"]')?.textContent.includes('Published v0.2.0'), 'published');
      return 'v0.2.0';
    `)

    nav('users')
    await run('learner: is offered the update, sees what it does, installs it', `
      await pickUser('Learner');
      await serverTab();
      await wait(() => document.querySelector('.update-badge.update')?.textContent.includes('v0.2.0'), 'update badge');
      (await wait(() => [...document.querySelectorAll('.course-card')].find(c => c.querySelector('.origin-badge.from-server')), 'server card')).click();
      await press('Update to v0.2.0');
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
      await serverTab();
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

    // A document's life on the server: the course journey for a PDF.
    const pdf = join(work, 'Field guide.pdf')
    writeFileSync(pdf, fixturePdf({ pages: 3 }))
    const imported = await importDocument(pdf)
    if (imported.status !== 'ok') throw new Error('The PDF was not imported')
    await run('author: describes a PDF and is shown what publishing does', `
      await documents('Local');
      await openDocument('Field guide');
      const line = await wait(() => [...document.querySelectorAll('.course-origin-line')].find(shown), 'origin line');
      if (!line.textContent.includes('Local')) throw new Error(line.textContent);
      await vpress('Edit overview');
      await vtype('Description', 'Birds of the *coast*.');
      await vtype('Tags', 'Nature, Field');
      await vpress('Save overview');
      await wait(() => [...document.querySelectorAll('.import-note')].some(n => shown(n) && n.textContent === 'Overview saved.'), 'saved');
      await vpress('Publish');
      await wait(() => vbutton('Publish v1.0.0') && !vbutton('Publish v1.0.0').disabled, 'publish preview');
      await vtype('What changed', 'First edition.');
      return 'ready';
    `)
    await shot('document-publish')
    await run('author: published, the document is theirs on the server', `
      await vpress('Publish v1.0.0');
      await wait(() => [...document.querySelectorAll('.course-server-panel [role="status"]')].some(n => shown(n) && n.textContent.includes('Published v1.0.0')), 'published note');
      await vpress('Close');
      await wait(() => vbutton('Manage publication'), 'manage button');
      return [...document.querySelectorAll('.course-origin-line')].find(shown).textContent;
    `)

    nav('users')
    await run('learner: finds the PDF in the server\'s document catalog', `
      await pickUser('Learner');
      await documents('Smoke server');
      await vpress('Add documents');
      const card = await wait(() => [...document.querySelectorAll('.document-catalog-card')].find(shown), 'document card');
      if (!card.textContent.includes('v1.0.0') || !card.textContent.includes('by author') || !card.textContent.includes('3 pages')) throw new Error(card.textContent);
      await wait(() => [...document.querySelectorAll('.catalog-tag')].some(t => shown(t) && t.textContent.includes('Nature')), 'tags');
      return card.textContent;
    `)
    await shot('document-catalog')
    await run('learner: reads its overview and adds it', `
      [...document.querySelectorAll('.document-catalog-card')].find(shown).click();
      const versions = await wait(() => [...document.querySelectorAll('.catalog-detail .catalog-versions')].find(shown), 'overview');
      if (!versions.textContent.includes('First edition.')) throw new Error('Release note missing');
      if (![...document.querySelectorAll('.catalog-detail')].find(shown).textContent.includes('Chapter 1')) throw new Error('Outline missing');
      return 'overview';
    `)
    await shot('catalog-document')
    const learnerDocument = await run('learner: the added PDF shows its server and version, and is read', `
      await vpress('Add to my documents');
      await vpress('Open in my documents');
      const line = await wait(() => [...document.querySelectorAll('.course-origin-line')].find(l => shown(l) && l.textContent.includes('Smoke server')), 'origin line');
      if (!line.textContent.includes('v1.0.0')) throw new Error(line.textContent);
      if (vbutton('Publish')) throw new Error('A reader is offered Publish');
      const copy = (await window.opencourse.listDocuments()).find(d => d.origin);
      await window.opencourse.setDocumentProgress(copy.id, 2);
      await window.opencourse.syncLearning();
      return copy.id;
    `) as string
    await shot('document-overview')
    try {
      const login = await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'learner', password: 'another long password' }) })).json() as { token: string }
      const items = (await (await fetch(`${base}/api/v1/me/learning`, { headers: { authorization: `Bearer ${login.token}` } })).json() as { items: { enrollment: { kind: string }; fields: Record<string, { value: unknown }> }[] }).items
      const held = items.find((i) => i.enrollment.kind === 'document')
      results.push({ name: 'learner: the page read in the app is the account\'s, on the server', ok: held?.fields['readPage']?.value === 2, detail: JSON.stringify(held?.fields ?? null) })
    } catch (error) { results.push({ name: 'learner: the page read in the app is the account\'s, on the server', ok: false, detail: String(error) }) }

    nav('users')
    await run('author: raises the version and publishes again', `
      await pickUser('Author');
      await documents('Local');
      await openDocument('Field guide');
      await vpress('Edit overview');
      await vtype('Version', '1.1.0');
      await vpress('Save overview');
      await wait(() => [...document.querySelectorAll('.version-badge')].some(b => shown(b) && b.textContent === 'v1.1.0'), 'new version');
      await vpress('Publish a new version');
      await vpress('Publish v1.1.0');
      await wait(() => [...document.querySelectorAll('.course-server-panel [role="status"]')].some(n => shown(n) && n.textContent.includes('Published v1.1.0')), 'published');
      return 'v1.1.0';
    `)
    nav('users')
    await run('learner: is offered the document update and installs it, keeping the page', `
      await pickUser('Learner');
      await documents('Smoke server');
      await wait(() => [...document.querySelectorAll('.update-badge.update')].some(b => shown(b) && b.textContent.includes('v1.1.0')), 'update badge');
      await openDocument('Field guide');
      await vpress('Update to v1.1.0');
      await wait(() => vbutton('Install v1.1.0'), 'update panel');
      return [...document.querySelectorAll('.course-server-panel')].find(shown).textContent;
    `)
    await shot('document-update')
    await run('learner: updated, and still read to page 2', `
      await vpress('Install v1.1.0');
      await wait(() => [...document.querySelectorAll('.course-origin-line')].some(l => shown(l) && l.textContent.includes('v1.1.0')), 'new version');
      const view = await window.opencourse.getDocument(${JSON.stringify(learnerDocument ?? '')});
      if (view.readPage !== 2) throw new Error('Progress was lost in the update: ' + view.readPage);
      return 'read to page ' + view.readPage;
    `)
    nav('users')
    await run('author: manages the document publication', `
      await pickUser('Author');
      await documents('Local');
      await openDocument('Field guide');
      await vpress('Manage publication');
      await wait(() => [...document.querySelectorAll('.publication-versions tbody tr')].filter(shown).length === 2, 'two versions');
      const text = [...document.querySelectorAll('.publication')].find(shown).textContent;
      if (!text.includes('1 reader') || !text.includes('Listed in the catalog at v1.1.0')) throw new Error(text);
      return text;
    `)
    await shot('document-publication')
  } catch { /* the failing step is in results */ }
  finally {
    child.kill()
    rmSync(work, { recursive: true, force: true })
  }
  return results
}
