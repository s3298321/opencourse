/**
 * What scripts/build-resources.mjs fetched, typed, with the empty answer the
 * pages fall back to when a build ran offline.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Release {
  version: string
  tag: string
  url: string
  publishedAt: string
  notes: string
  unsigned: boolean
  asset: { size: number; downloads: number } | null
}
export interface FeaturedCourse {
  id: string
  title: string
  description: string
  subject: string
  difficulty: string
  lessonCount: number
  publisher: string
  downloads: number
  tags: string[]
  cover: string | null
}
export interface Generated {
  repo: { stars: number; forks: number; description: string | null; license: string | null } | null
  release: Release | null
  featured: FeaturedCourse[]
  builtAt: string
}

const file = join(process.cwd(), 'src', 'data', 'generated.json')
export const generated: Generated = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8')) as Generated
  : { repo: null, release: null, featured: [], builtAt: new Date().toISOString() }

export const release = generated.release?.asset ? generated.release : null

export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

export function compactNumber(n: number): string {
  return n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`
}

export const formatDate = (iso: string): string => new Intl.DateTimeFormat('en', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso))
