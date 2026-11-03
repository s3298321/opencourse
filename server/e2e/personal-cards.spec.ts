import type { LearningState } from '@core/learning/types'
import { test, expect, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { makeZip } from '../../app/tests/helpers/zip'
import { tmpdir } from 'node:os'
import { proposeCards } from '../../app/src/main/personal-card-store'
import { createSession } from '../src/auth/sessions'

// These journeys exercise cards, not sign-in. Seed real sessions so the shared
// server's production login rate limit does not depend on the suite's size.
async function signInFixture(page: Page, username: string): Promise<string> {
  const d = new DatabaseSync(join(process.env.OPENCOURSE_E2E_DATA!, 'server.db'))
  try {
    const account = String(d.prepare('SELECT id FROM accounts WHERE username=?').get(username)!.id)
    const webToken = createSession(d, account, { kind: 'web' })
    await page.context().addCookies([{ name: 'ocs_session', value: webToken, url: process.env.OPENCOURSE_E2E_URL!, httpOnly: true, sameSite: 'Lax' }])
    return createSession(d, account, { kind: 'app' })
  } finally { d.close() }
}

test('approve personal cards in chat, review immediately, and delete through the question-only popup',async({page})=>{
  const errors:string[]=[]
  page.on('pageerror',e=>errors.push(e.message))
  await signInFixture(page, 'kit')
  await page.goto('/')
  await expect(page.getByRole('button',{name:/kit/})).toBeVisible()
  const setup=await page.evaluate(async()=>{
    const request=async<T>(path:string,method='GET',body?:unknown):Promise<T>=>{
      const r=await fetch(`/api/v1${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
      if(!r.ok) throw new Error(await r.text())
      return r.json() as Promise<T>
    }
    const catalog=await request<{courses:{id:string}[]}>('/courses'),id=catalog.courses[0].id
    const state=await request<LearningState>(`/me/learning/course/${id}`,'PUT',{})
    // Keep authored cards locked so this journey proves immediate personal eligibility.
    await request('/sync','POST',{operations:[{kind:'course',id,version:state.enrollment.version,generation:state.enrollment.generation,epoch:state.epoch,field:'reset',value:null,at:Date.now(),idempotencyKey:crypto.randomUUID()}]})
    const {chat}=await request<{chat:{id:string}}>('/learning/chats','POST',{kind:'course',id,version:state.enrollment.version})
    return {id,chatId:chat.id}
  })
  // Seed the model's tool result in the disposable E2E database. The API suite
  // separately drives the actual provider/tool loop; browser approval stays real.
  const d=new DatabaseSync(join(process.env.OPENCOURSE_E2E_DATA!,'server.db'))
  try {
    const account=String(d.prepare('SELECT id FROM accounts WHERE username=?').get('kit')!.id),message=randomUUID(),at=new Date().toISOString()
    d.prepare("INSERT INTO learning_messages(id,chat_id,role,text,status,at) VALUES(?,?,'user','Remember closures','complete',?)").run(randomUUID(),setup.chatId,at)
    d.prepare("INSERT INTO learning_messages(id,chat_id,role,text,status,at) VALUES(?,?,'assistant','Review the flashcard preview below.','complete',?)").run(message,setup.chatId,at)
    proposeCards(d,account,'server',setup.chatId,message,'browser-fixture',{kind:'course',id:setup.id},'The OpenCourse example course',[{question:'What is a lexical closure?',answer:'A function together with its lexical environment.'}])
  } finally { d.close() }
  await page.goto(`/learn/course/${setup.id}`)
  await page.getByRole('button',{name:'Open reading chat'}).click()
  const panel=page.getByRole('complementary',{name:'Reading chat'})
  await panel.getByRole('button',{name:'History',exact:true}).click()
  await panel.getByRole('button',{name:/Remember closures Conversation/}).click()
  const preview=panel.getByRole('region',{name:'Flashcard preview'})
  await expect(preview).toContainText('A function together with its lexical environment.')
  await preview.getByRole('button',{name:'Save all',exact:true}).click()
  await expect(preview).toContainText('1 card saved')
  await page.screenshot({path:join(tmpdir(),'opencourse-personal-preview.png')})
  await page.goto(`/learning/courses/${setup.id}`)
  await expect(page.getByRole('button',{name:'1 personal',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Review',exact:true}).click()
  await expect(page.getByRole('region',{name:'Flashcard review'})).toBeVisible()
  await expect(page.locator('.review-question')).toContainText('What is a lexical closure?')
  await expect(page.locator('.review-answer')).toHaveCount(0)
  await page.getByRole('button',{name:/Reveal answer/}).click()
  await expect(page.locator('.review-answer')).toContainText('lexical environment')
  await page.getByRole('button',{name:/^Good/}).click()
  await expect(page.getByRole('heading',{name:'Review complete'})).toBeVisible()
  await page.getByRole('button',{name:'Back to course',exact:true}).last().click()
  await page.getByRole('button',{name:'1 personal',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Personal flashcards'})
  await expect(dialog.locator('li')).toHaveText('What is a lexical closure?')
  await expect(dialog).not.toContainText('lexical environment')
  await page.screenshot({path:join(tmpdir(),'opencourse-personal-manager.png')})
  await dialog.getByRole('button',{name:'Delete card: What is a lexical closure?'}).click()
  await expect(dialog).toContainText('No personal flashcards yet')
  await dialog.getByRole('button',{name:'Close personal flashcards'}).click()
  await expect(page.getByRole('button',{name:'0 personal',exact:true})).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button',{name:'0 personal',exact:true})).toBeVisible()
  expect(errors).toEqual([])
})


test('document cards enable review, return to the originating screen, and disappear after keyboard-accessible deletion', async ({ page, request }) => {
  const id = randomUUID(), work = mkdtempSync(join(tmpdir(), 'personal-document-e2e-'))
  const stream = 'BT /F1 12 Tf 20 100 Td (A document about closures) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  try {
    const token = await signInFixture(page, 'lin')
    const file = makeZip(join(work, 'document.zip'), [{ name: 'document.json', content: JSON.stringify({ title: 'Personal card PDF', description: 'Closure notes', version: '1.0.0', tags: [] }) }, { name: 'document.pdf', content: pdf }])
    const published = await request.post(`/api/v1/documents/${id}/versions`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' }, data: readFileSync(file) })
    expect(published.status(), await published.text()).toBe(201)
    await page.goto('/')
    await expect(page.getByRole('button', { name: /lin/ })).toBeVisible()
    await page.goto(`/documents/${id}`)
    await expect(page.getByRole('link', { name: 'Review', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Add to My learning' }).click()
    await expect(page.getByLabel('PDF page 1')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Review', exact: true })).toHaveCount(0)
    const headers = { authorization: `Bearer ${token}` }
    const created = await request.post('/api/v1/learning/chats', { headers, data: { kind: 'document', id, version: '1.0.0' } })
    const { chat } = await created.json()
    const d = new DatabaseSync(join(process.env.OPENCOURSE_E2E_DATA!, 'server.db'))
    try {
      const account = String(d.prepare('SELECT id FROM accounts WHERE username=?').get('lin')!.id), message = randomUUID(), at = new Date().toISOString()
      d.prepare("INSERT INTO learning_messages(id,chat_id,role,text,status,at) VALUES(?,?,'user','Remember this PDF','complete',?)").run(randomUUID(), chat.id, at)
      d.prepare("INSERT INTO learning_messages(id,chat_id,role,text,status,at) VALUES(?,?,'assistant','Approve the preview below.','complete',?)").run(message, chat.id, at)
      proposeCards(d, account, 'server', chat.id, message, 'document-fixture', { kind: 'document', id }, 'Personal card PDF', [{ question: 'What does a closure retain?', answer: 'Its lexical environment.' }])
    } finally { d.close() }
    await page.reload()
    await page.getByRole('button', { name: 'Open reading chat' }).click()
    const panel = page.getByRole('complementary', { name: 'Reading chat' })
    await panel.getByRole('button', { name: 'History', exact: true }).click()
    await panel.getByRole('button', { name: /Remember this PDF Conversation/ }).click()
    await panel.getByRole('button', { name: 'Save all', exact: true }).click()
    await expect(panel.getByRole('region', { name: 'Flashcard preview' })).toContainText('1 card saved')
    await page.getByRole('link', { name: 'Review', exact: true }).click()
    await page.getByRole('button', { name: /Reveal answer/ }).click()
    await expect(page.locator('.review-answer')).toContainText('Its lexical environment.')
    await page.getByRole('button', { name: 'Good', exact: true }).click()
    await page.getByRole('button', { name: 'Back to document', exact: true }).last().click()
    await expect(page).toHaveURL(new RegExp(`/learn/document/${id}$`))
    await page.goto(`/documents/${id}`)
    await page.getByRole('link', { name: 'Review', exact: true }).click()
    await page.getByRole('button', { name: 'End review', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/documents/${id}$`))
    const count = page.getByRole('button', { name: '1 personal', exact: true })
    await count.focus(); await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Personal flashcards' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(count).toBeFocused()
    await page.keyboard.press('Enter')
    await dialog.getByRole('button', { name: 'Delete card: What does a closure retain?' }).click()
    await expect(page.getByRole('link', { name: 'Review', exact: true })).toHaveCount(0)
    await page.goto(`/learn/document/${id}`)
    await expect(page.getByLabel('PDF page 1')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Review', exact: true })).toHaveCount(0)
  } finally { rmSync(work, { recursive: true, force: true }) }
})
