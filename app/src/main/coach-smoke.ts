import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { listProjects, deleteProject } from './coach'

interface Result { name: string; ok: boolean; detail: string }
const helpers = `
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const find = selector => [...document.querySelectorAll(selector)].find(el => el.checkVisibility({ visibilityProperty: true }));
  const wait = async selector => { for(let i=0;i<200;i++){ const el=find(selector); if(el) return el; await pause(25) } throw new Error('Missing '+selector) };
  const assert = (condition, message) => { if(!condition) throw new Error(message) };
  const button = text => [...document.querySelectorAll('.coach-floating button')].find(el => el.textContent.trim() === text);
`

/** Uses a disposable smoke profile and no API key; live transport is covered by coach-live tests. */
export async function floatingCoachChecks(win: BrowserWindow): Promise<Result[]> {
  const results: Result[] = []
  const run = async (name: string, code: string) => {
    try { results.push({ name, ok: true, detail: String(await win.webContents.executeJavaScript(`(async()=>{${helpers}${code}})()`)) }) }
    catch (error) { results.push({ name, ok: false, detail: String(error) }) }
  }
  await win.webContents.executeJavaScript('window.opencourse.clearOpenAIKey()')
  await run('coach: launcher replaces the tab and sits above notebooks', `
    assert(!document.querySelector('[data-section="coach"]'), 'Coach tab remains');
    const coach = await wait('.coach-floating .writing-launcher-toggle'), notebook = await wait('.notebook-floating .writing-launcher-toggle');
    assert(coach.getBoundingClientRect().bottom < notebook.getBoundingClientRect().top, 'Coach is not above notebooks');
    coach.click(); await pause(400);
    const panel = await wait('.coach-floating.expanded');
    assert(panel.getBoundingClientRect().width > 300, 'Panel did not expand');
    assert(getComputedStyle(panel).transitionDuration.includes('0.32s'), 'Morph timing changed');
    return 'Shared 320ms morph; coach above notebooks; no tab';
  `)
  await run('coach: name popup creates a coach and enters conversation mode', `
    button('＋ New coach').click(); const field = await wait('.writing-title-dialog input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(field, 'Floating smoke coach'); field.dispatchEvent(new Event('input',{bubbles:true})); await pause(50);
    document.querySelector('.writing-title-dialog').requestSubmit();
    await wait('.coach-conversation'); await wait('.coach-conversation [role="alert"]');
    assert(find('.coach-conversation').textContent.includes('OpenAI API key'), 'Missing-key recovery absent');
    assert(!document.querySelector('.writing-title-dialog'), 'Name popup stayed open');
    return 'Name-only creation and inline connection recovery';
  `)
  await run('coach: collapse and navigation preserve the current conversation panel', `
    const conversation = find('.coach-conversation'); find('.coach-floating header button').click(); await pause(400);
    find('[data-section="documents"]').click(); await pause(100);
    find('.notebook-floating .writing-launcher-toggle').click(); await pause(400);
    find('.coach-floating .writing-launcher-toggle').click(); await pause(400);
    assert(!document.querySelector('.notebook-floating.expanded'), 'Both panels remain open');
    assert(find('.coach-conversation') === conversation, 'Conversation remounted');
    const panel = find('.coach-floating').getBoundingClientRect();
    assert(panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight, 'Conversation exceeds window');
    return 'Same conversation through navigation and notebook launcher';
  `)
  writeFileSync('/tmp/opencourse-floating-coach.png', (await win.webContents.capturePage()).toPNG())
  await run('coach: settings link works and history/files are not exposed', `
    button('Open settings').click(); await wait('.settings-key');
    assert(find('.settings-key').type === 'password', 'Key field is not private');
    for(const name of ['listCoachFiles','readCoachFile','trashCoachFile','purgeCoachFile','revealCoachProject','listCoachSessions','getCoachTranscript','deleteCoachSession']) assert(typeof window.opencourse[name] === 'undefined', name+' remains exposed');
    if (!document.querySelector('.coach-floating.expanded')) find('.coach-floating .writing-launcher-toggle').click();
    button('Back to coaches').click(); await pause(100);
    assert(!document.querySelector('.coach-conversation'), 'Ended conversation remains');
    return 'Settings recovery; no file or history browsing bridge';
  `)
  await run('coach: visibility setting hides and restores only the coach button', `
    find('[data-settings-category="appearance"]').click(); const box = await wait('.settings-floating-coaches');
    box.click(); await pause(400);
    assert(!document.querySelector('.coach-floating'), 'Coach button remains'); assert(find('.notebook-floating'), 'Notebook button was hidden');
    box.click(); await wait('.coach-floating');
    find('.coach-floating .writing-launcher-toggle').click(); await pause(400);
    return 'Independent visibility preference';
  `)
  for (const project of listProjects()) deleteProject(project.id)
  win.webContents.send('coach:changed')
  return results
}
