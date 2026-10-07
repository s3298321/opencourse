/**
 * The renderer policy. It was packaged-only until the coach needed a mic, which
 * meant nothing ever checked it - so pin the clauses and pin the one difference
 * dev is allowed to make.
 */
import { describe, expect, it } from 'vitest'
import { RENDERER_CSP, cspFor } from '../src/main/csp'

const clauses = (policy: string): string[] => policy.split('; ')
const clause = (policy: string, name: string): string =>
  clauses(policy).find((c) => c.split(' ')[0] === name) ?? ''

describe('the renderer CSP', () => {
  it('keeps the renderer off the network', () => {
    expect(clause(RENDERER_CSP, 'connect-src')).toBe("connect-src 'self'")
  })

  it('allows no inline script, no plugins and no form posts', () => {
    expect(clause(RENDERER_CSP, 'script-src')).toBe("script-src 'self'")
    expect(clause(RENDERER_CSP, 'object-src')).toBe("object-src 'none'")
    expect(clause(RENDERER_CSP, 'base-uri')).toBe("base-uri 'none'")
    expect(clause(RENDERER_CSP, 'form-action')).toBe("form-action 'none'")
  })

  it('frames and paints only what the opencourse:// handler serves', () => {
    expect(clause(RENDERER_CSP, 'frame-src')).toBe('frame-src opencourse:')
    expect(clause(RENDERER_CSP, 'img-src')).toBe("img-src 'self' data: opencourse:")
    expect(clause(RENDERER_CSP, 'media-src')).toBe("media-src 'self' opencourse:")
  })

  it('is applied verbatim when there is no dev server, which is what a smoke run sees', () => {
    expect(cspFor(undefined)).toBe(RENDERER_CSP)
    expect(cspFor('')).toBe(RENDERER_CSP)
  })

  it('relaxes exactly three clauses for Vite, and never the rest', () => {
    const dev = cspFor('http://localhost:5173/')
    expect(clause(dev, 'connect-src')).toBe("connect-src 'self' http://localhost:5173 ws://localhost:5173")
    expect(clause(dev, 'script-src')).toBe("script-src 'self' 'unsafe-inline' http://localhost:5173")
    expect(clause(dev, 'default-src')).toBe("default-src 'self' http://localhost:5173")

    // Everything else is byte-identical to the packaged policy.
    const untouched = ['style-src', 'img-src', 'media-src', 'frame-src', 'object-src', 'base-uri', 'form-action']
    for (const name of untouched) expect(clause(dev, name)).toBe(clause(RENDERER_CSP, name))
    expect(clauses(dev)).toHaveLength(clauses(RENDERER_CSP).length)
  })

  it('falls back to the strict policy rather than trusting a malformed dev url', () => {
    expect(cspFor('not a url')).toBe(RENDERER_CSP)
  })
})
