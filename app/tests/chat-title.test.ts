// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeChatTitle } from '../src/core/sidechat/title'

describe('generated conversation titles', () => {
  it.each([
    ['  Understanding the Event Loop  ', 'Understanding the Event Loop'],
    ['“Project Design Review”', 'Project Design Review'],
    ['**Callback Scheduling Basics**', 'Callback Scheduling Basics'],
    ['事件循环原理', '事件循环原理']
  ])('normalizes %s', (input, expected) => expect(normalizeChatTitle(input)).toBe(expected))
  it.each(['', 'Title', 'One two three four five six', '!!!', 'word\u0000 another', `${'a'.repeat(100)} word`])('rejects an invalid title: %s', input => {
    expect(normalizeChatTitle(input)).toBeNull()
  })
})
