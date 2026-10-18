/** Opt-in, billable end-to-end check. Real WebRTC, models, tools, persistence and UI.
 * Uses an explicit speech WAV in place of the microphone; never touches real profiles.
 * Hardware echo cancellation and headphone/speaker checks remain a manual release gate.
 */
import { app, type BrowserWindow } from 'electron'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createUser } from './users'
import { createProject } from './coach'
import { setKey } from './coachkey'
import { validateKey } from './openai'
import { selectSessions, selectFragments, selectToolCalls, selectSessionSummary } from './coachdb'
import { endAllSessions } from './coachsession'
import { closeDb } from './db'

export async function runCoachLiveSmoke(win: BrowserWindow): Promise<void> {
  const reportPath = process.env['OPENCOURSE_COACH_LIVE_REPORT'] ?? '/tmp/opencourse-coach-live.json'
  const checks: string[] = []
  let phase = 'setup'
  const finish = (ok: boolean): void => {
    writeFileSync(reportPath, JSON.stringify({ok, checks, ...(ok ? {} : {failedPhase: phase}), hardwareMicrophoneVerified: false}, null, 2))
    endAllSessions()
    win.destroy()
    closeDb()
    const profile = process.env['OPENCOURSE_RUN_PROFILE']
    if (profile) rmSync(profile, {recursive: true, force: true})
    app.exit(ok ? 0 : 1)
  }
  const watchdog = setTimeout(() => finish(false), 300_000)
  const wait = async (test: () => boolean, ms: number): Promise<void> => {
    const until = Date.now() + ms
    while (!test()) {
      if (Date.now() >= until) throw new Error('Check timed out')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  const click = async (label: string): Promise<void> => {
    await win.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('.coach-live button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) throw new Error('Coach button unavailable'); button.click();
    })()`)
  }
  try {
    const key = process.env['OPENAI_API_KEY']
    const wav = process.env['OPENCOURSE_LIVE_AUDIO']
    if (!key || !wav || readFileSync(wav).subarray(0, 4).toString() !== 'RIFF') throw new Error('Key and speech WAV required')
    createUser('Live API check')
    const saved = await setKey(key, validateKey)
    if (saved.status !== 'ok') throw new Error('Key unavailable')
    const project = createProject({name: 'French live API check', instructions: 'Coach French. Speak French. Before teaching, read existing context.md if present. Keep concise notes in context.md. Ask the learner one short question and listen. Save learning progress as it happens.'})
    await new Promise<void>(resolve => { win.webContents.once('did-finish-load', () => resolve()); win.reload() })
    await win.webContents.executeJavaScript(`(async () => {
      const wait = async (selector) => { for (let i=0; i<100; i++) { const e=document.querySelector(selector); if(e) return e; await new Promise(r=>setTimeout(r,100)); } throw new Error('Missing UI'); };
      (await wait('[data-section="coach"]')).click();
      (await wait('.coach-card')).click();
      await wait('.coach-live');
    })()`)
    let previousId = ''
    let firstNotePath = ''
    for (let round = 1; round <= 2; round++) {
      phase = `session ${round}: connection and captions`
      await click('Start a session')
      await wait(() => selectSessions(project.id).some(s => s.id !== previousId), 15_000)
      const id = selectSessions(project.id).find(s => s.id !== previousId)!.id
      await wait(() => {
        const fragments = selectFragments(id)
        return fragments.some(f => f.role === 'user') && fragments.some(f => f.role === 'assistant')
      }, 60_000)
      checks.push(`session ${round}: real WebRTC and both caption streams`)
      phase = `session ${round}: delegated tools and memory`
      await wait(() => selectToolCalls(id).some(t => t.ok && ['write_file', 'append_file'].includes(t.name)), 60_000)
      if (round === 1) {
        firstNotePath = JSON.parse(selectToolCalls(id).find(t => t.ok && ['write_file', 'append_file'].includes(t.name))!.arguments).path
      } else {
        await wait(() => selectToolCalls(id).some(t => t.ok && t.name === 'read_file' && JSON.parse(t.arguments).path === firstNotePath && Boolean(t.result)), 30_000)
        checks.push('second session reads the first session’s saved note')
      }
      checks.push(`session ${round}: delegated note write persisted`)
      phase = `session ${round}: graceful finish`
      await click('Finish session')
      await wait(() => selectSessionSummary(id)?.status !== 'live', 65_000)
      const summary = selectSessionSummary(id)!
      if (summary.error || summary.metadata?.finalization !== 'confirmed' || !summary.metadata.remoteSessionId || !summary.metadata.backendUsage?.totalTokens) throw new Error('Incomplete finalization')
      checks.push(`session ${round}: silent wrap-up, backend usage and confirmed close`)
      previousId = id
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    clearTimeout(watchdog)
    finish(true)
  } catch {
    // Reports contain lifecycle/check metadata only, never provider text, keys or learner notes.
    clearTimeout(watchdog)
    finish(false)
  }
}
