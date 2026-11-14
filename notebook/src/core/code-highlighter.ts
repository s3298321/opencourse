import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import python from 'shiki/langs/python.mjs'
import bash from 'shiki/langs/bash.mjs'
import json from 'shiki/langs/json.mjs'
import c from 'shiki/langs/c.mjs'
import cpp from 'shiki/langs/cpp.mjs'
import javascript from 'shiki/langs/javascript.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import sql from 'shiki/langs/sql.mjs'
import yaml from 'shiki/langs/yaml.mjs'
import diff from 'shiki/langs/diff.mjs'
import llvm from 'shiki/langs/llvm.mjs'
import githubLight from 'shiki/themes/github-light.mjs'
import githubDark from 'shiki/themes/github-dark.mjs'

/**
 * Grammars a course may use in a prose code fence. Loading one costs bundle
 * size, so this is an explicit list rather than all of Shiki - an unlisted
 * language renders as plain text, which is a fine outcome.
 */
const LANG_ALIASES: Record<string, string> = {
  python: 'python', py: 'python', python3: 'python',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  json: 'json',
  c: 'c', h: 'c',
  cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp',
  javascript: 'javascript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  diff: 'diff', patch: 'diff',
  llvm: 'llvm', ll: 'llvm', 'llvm-ir': 'llvm'
}

let highlighterPromise: Promise<HighlighterCore> | null = null

export function loadCodeHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [githubLight, githubDark],
    langs: [python, bash, json, c, cpp, javascript, typescript, sql, yaml, diff, llvm],
    engine: createJavaScriptRegexEngine()
  })
  return highlighterPromise
}

export function resolveCodeLanguage(language: string): string | undefined {
  return LANG_ALIASES[language.toLowerCase()]
}
