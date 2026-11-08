// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { streamChatRound } from '../src/main/resilient-chat'
import { withNetworkRetries } from '../src/main/network-retry'

const fake = vi.hoisted(() => ({ fetch: vi.fn(), wait: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: fake.fetch } }))
vi.mock('node:timers/promises', async load => ({
  ...await load<typeof import('node:timers/promises')>(), setTimeout: fake.wait
}))
afterEach(() => { fake.fetch.mockReset(); fake.wait.mockReset() })

function sender() {
  return { isDestroyed: () => false, send: vi.fn() }
}
function stream(events: object[], fail?: string) {
  const frames = events.map(event => new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'))
  return new Response(new ReadableStream({ pull(controller) {
    const frame = frames.shift()
    if (frame) controller.enqueue(frame)
    else if (fail) controller.error(new TypeError(fail))
    else controller.close()
  } }))
}
const text = (delta: string) => ({ type:'response.output_text.delta', delta })
const completed = {type:'response.completed',response:{output:[]}}

describe('chat connection recovery', () => {
  it('replaces only interrupted round text and discards uncompleted tool calls', async () => {
    fake.fetch.mockResolvedValueOnce(stream([text('Partial'), {type:'response.output_item.done',output_index:0,item:{type:'function_call',name:'set_course',call_id:'discard-me'}}], 'net::ERR_NETWORK_CHANGED'))
      .mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
      .mockResolvedValueOnce(stream([text('Final'),completed]))
    let answer = 'Earlier round. '
    const win = sender()
    const result = await streamChatRound(win as unknown as WebContents,'test', () => answer = 'Earlier round. ', {
      input:[{role:'user',content:'Explain'}], model:'gpt-test', key:'test', tools:[], signal:new AbortController().signal, onDelta:chunk=>{answer+=chunk}
    })
    expect(fake.fetch).toHaveBeenCalledTimes(3)
    expect(new Set(fake.fetch.mock.calls.map(([,init])=>init.body)).size).toBe(1)
    expect(result.output).toEqual([])
    expect(answer).toBe('Earlier round. Final')
    expect(win.send.mock.calls.map(call=>call[2])).toEqual([
      {kind:'retry',attempt:1},{kind:'retry',attempt:2},{kind:'retry',attempt:null},{kind:'replace',text:'Earlier round. '}
    ])
  })

  it('keeps partial text through five unsuccessful retries, then reports exhaustion', async () => {
    fake.fetch.mockResolvedValueOnce(stream([text('Keep this')])) // premature EOF
      .mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'))
    const win = sender(), restore = vi.fn(() => '')
    let answer = ''
    await expect(streamChatRound(win as unknown as WebContents,'test', restore, { input:[],model:'gpt-test',key:'test',signal:new AbortController().signal,onDelta:chunk=>{answer+=chunk} })).rejects.toThrow('after 5 retries')
    expect(fake.fetch).toHaveBeenCalledTimes(6)
    expect(fake.wait.mock.calls.map(([ms])=>ms)).toEqual([1000,2000,4000,8000,16000])
    expect(win.send.mock.calls.map(call=>call[2].attempt)).toEqual([1,2,3,4,5,null])
    expect(answer).toBe('Keep this')
    expect(restore).not.toHaveBeenCalled()
  })

  it('stops during backoff, and never issues a replacement request', async () => {
    const controller = new AbortController(), notify = vi.fn()
    const { setTimeout: realDelay } = await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises')
    fake.wait.mockImplementationOnce((ms, v, opts) => { queueMicrotask(() => controller.abort()); return realDelay(ms, v, opts) })
    const request = vi.fn().mockRejectedValue(new Error('net::ERR_NETWORK_CHANGED'))
    await expect(withNetworkRetries(request, controller.signal, notify)).rejects.toMatchObject({name:'AbortError'})
    expect(request).toHaveBeenCalledOnce()
    expect(notify.mock.calls).toEqual([[1],[null]])
  })

  it('does not treat a terminal provider failure as a network outage', async () => {
    fake.fetch.mockResolvedValueOnce(stream([{type:'response.failed',response:{error:{message:'Invalid request'}}}]))
    const win = sender()
    await expect(streamChatRound(win as unknown as WebContents,'test',()=>'', { input:[],model:'gpt-test',key:'test',signal:new AbortController().signal,onDelta:()=>{} })).rejects.toThrow()
    expect(fake.fetch).toHaveBeenCalledOnce()
    expect(win.send).not.toHaveBeenCalled()
  })
})
