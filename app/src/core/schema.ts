/** Manifest validation. Ported from apps/courses/schema.py (Django), extended to v1.1. */
// The manifest schema is draft 2020-12 ($defs, if/then), which needs ajv's
// 2020 build - the default export only knows draft-07.
import Ajv2020 from 'ajv/dist/2020'
import type { ErrorObject } from 'ajv'
import schema from './course-schema.json'
import type { CourseManifest } from './types'
import { projectContextText, validateProjectFiles } from './projects/context'

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true })
const validator = ajv.compile(schema)

/** Schema versions are MAJOR.MINOR; a feature introduced in one is allowed in every later one. */
export function schemaAtLeast(version: string, minimum: string): boolean {
  const [a = 0, b = 0] = version.split('.').map(Number), [c = 0, d = 0] = minimum.split('.').map(Number)
  return a > c || (a === c && b >= d)
}

function describe(err: ErrorObject): string {
  const field = err.keyword === 'required' ? '/' + (err.params as { missingProperty: string }).missingProperty : ''
  const path = (err.instancePath + field) || '(root)'
  // The raw pattern means nothing to an author; say what a version looks like.
  if (err.instancePath === '/version' && err.keyword === 'pattern') return '/version: use three numbers, MAJOR.MINOR.PATCH, such as 1.2.0'
  if (err.keyword === 'enum' && err.instancePath.endsWith('/runtime/language')) return `${path}: Only Python exercises are supported`
  if (err.keyword === 'pattern' && (err.instancePath.endsWith('/runtime/version') || err.instancePath === '/python_version')) return `${path}: Minimum Python version must be MAJOR.MINOR[.PATCH] or >=MAJOR.MINOR[.PATCH]`
  if (err.keyword === 'pattern' && err.instancePath.endsWith('/uid')) return `${err.instancePath}: must be a lowercase UUID v4`
  if (err.keyword === 'additionalProperties') {
    return `${path}: unknown field "${(err.params as { additionalProperty: string }).additionalProperty}"`
  }
  if (err.keyword === 'oneOf') {
    return `${path}: does not match a supported module or block type`
  }
  return `${path}: ${err.message ?? 'invalid'}`
}

/** Returns human-readable errors; an empty array means the manifest is valid. */
export function validateManifest(manifest: unknown): string[] {
  if (validator(manifest)) {
    const course = manifest as unknown as CourseManifest
    const issues: string[] = []
    const slugs = new Set<string>()
    for (const [moduleIndex, mod] of course.modules.entries()) {
      if (slugs.has(mod.slug)) issues.push(`duplicate module slug: ${mod.slug}`)
      slugs.add(mod.slug)
      if (mod.type !== 'project') {
        for (const [lessonIndex, lesson] of mod.lessons.entries()) {
          const cardIds = new Set<string>()
          for (const [cardIndex, card] of (lesson.flashcards ?? []).entries()) {
            const path = `/modules/${moduleIndex}/lessons/${lessonIndex}/flashcards/${cardIndex}`
            if (!schemaAtLeast(course.schema_version, '1.4')) issues.push(`${path}: flashcards require schema_version 1.4 or later`)
            if (cardIds.has(card.id)) issues.push(`${path}/id: duplicate flashcard id "${card.id}" in this lesson`)
            cardIds.add(card.id)
          }
          const blockSlugs = new Set<string>()
          for (const [blockIndex, block] of lesson.blocks.entries()) {
            if (blockSlugs.has(block.slug)) issues.push(`/modules/${moduleIndex}/lessons/${lessonIndex}/blocks/${blockIndex}/slug: duplicate block slug "${block.slug}" in this lesson`)
            blockSlugs.add(block.slug)
          }
        }
        continue
      }
      if (!schemaAtLeast(course.schema_version, '1.3')) issues.push('Project modules require schema_version 1.3 or later')
      for (const [label, entries] of [['requirement', mod.project.requirements], ['deliverable', mod.project.deliverables]] as const) {
        const ids = new Set<string>()
        for (const entry of entries) {
          if (ids.has(entry.id)) issues.push(`${mod.slug}: duplicate ${label} id: ${entry.id}`)
          ids.add(entry.id)
        }
      }
      issues.push(...validateProjectFiles(mod.project.starter_files ?? []))
      if (projectContextText(course.title, mod).length > 48000) issues.push(`${mod.slug}: project definition exceeds the 48000 character context limit`)
    }
    return issues
  }
  const errors = validator.errors ?? []
  // oneOf failures produce a cascade of sub-errors; the top-level one is enough.
  const seen = new Set<string>()
  const out: string[] = []
  for (const err of errors) {
    const msg = describe(err)
    if (!seen.has(msg)) {
      seen.add(msg)
      out.push(msg)
    }
  }
  return out.slice(0, 25)
}

export function isCourseManifest(value: unknown): value is CourseManifest {
  return validateManifest(value).length === 0
}

export { schema as courseSchema }
