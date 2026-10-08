// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeChatTitle } from '../src/core/sidechat/title'

describe('generated conversation titles', () => {
  it.each([
    ['  Understanding the Event Loop  ', 'Understanding the Event Loop'],
    ['“Project Design Review”', 'Project Design Review'],
    ['**Callback Scheduling Basics**', 'Callback Scheduling Basics'],
    ['事件循环原理', '事件循环原理'],
    // Asked for five words, a model often gives six; that is still a title.
    ['Causation vs. Prediction in Customer Churn', 'Causation vs. Prediction in Customer Churn'],
    ['Title: Prediction Versus Causation', 'Prediction Versus Causation'],
    ['Prediction versus causation.', 'Prediction versus causation'],
    ['Prediction versus causation\n\nThis title summarizes the question.', 'Prediction versus causation']
  ])('normalizes %s', (input, expected) => expect(normalizeChatTitle(input)).toBe(expected))
  it.each(['', 'Title', 'One two three four five six seven eight nine', '!!!', 'word\u0000 another', `${'a'.repeat(100)} word`])('rejects an invalid title: %s', input => {
    expect(normalizeChatTitle(input)).toBeNull()
  })
})
