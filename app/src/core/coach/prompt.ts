/**
 * What the coach is told at the start of a session.
 *
 * The project's own brief is the user's; everything this file adds is the part
 * the model cannot work out for itself - which files already exist, what the
 * filesystem will accept, and that the conversation ends with it writing its
 * notes down.
 *
 * Pure, and deterministic for a given project and workspace: the same inputs
 * must produce the same prompt, or two sessions of the same project are not
 * comparable.
 */
import type { CoachFileNode, CoachProject } from '../types'
import { WRITABLE_EXTENSIONS, describeTree } from './files'

/** A prompt longer than this is costing money to repeat and not earning it. */
export const MAX_PROMPT_LENGTH = 12_000

/** Enough to orient the model without pasting the whole workspace in. */
const MAX_LISTED_FILES = 60

/**
 * The house rules, appended to whatever the project's brief says.
 *
 * The filename paragraph is load-bearing: `assertSafeSegment` refuses accents
 * and spaces, and a French coach will try `révisions.md` within about a minute
 * of being asked about French. Teaching the model is cheaper and safer than a
 * second path policy.
 */
function houseRules(allowDelete: boolean): string {
  return [
    'How your workspace works:',
    '',
    `- File names are ASCII only: letters, digits, dot, dash and underscore. No spaces and no accents - write`,
    `  "mots-a-reviser.md", not "mots à réviser.md". What is *inside* a file is normal UTF-8, so write accented`,
    '  text freely.',
    `- You can create ${WRITABLE_EXTENSIONS.join(', ')} files. Use append_file to add to a list, write_file to`,
    '  replace one.',
    '- Folders are made for you when you write into them.',
    allowDelete
      ? '- delete_file moves a file to the trash; the learner can still get it back.'
      : '- You cannot delete files. If something is wrong, rewrite it or say so.',
    '- If a tool returns an error, read it and try again - it tells you what was wrong.',
    '',
    'Use web_search when you need a fact you are not certain of, or something recent. Keep talking while it',
    'runs; do not announce that you are searching.',
    '',
    'Do not read your notes out loud or narrate writing them. The learner can see the files. Keep the',
    'conversation about the thing you are teaching.'
  ].join('\n')
}

function workspaceSection(workspace: readonly CoachFileNode[]): string {
  const files = describeTree(workspace)
  if (!files.length) {
    return [
      'Your workspace is empty: this is the first session, or nothing has been kept yet.',
      'Start by asking what the learner wants out of this, then write context.md before you get far in.'
    ].join('\n')
  }
  const listed = files.slice(0, MAX_LISTED_FILES)
  const more = files.length - listed.length
  return [
    'Your workspace already has these files. Read the ones that matter before you start:',
    '',
    ...listed.map((file) => `- ${file}`),
    ...(more > 0 ? [`- …and ${more} more; call list_files to see them all.`] : [])
  ].join('\n')
}

export function buildInstructions(
  project: Pick<CoachProject, 'name' | 'instructions' | 'allowDelete'>,
  workspace: readonly CoachFileNode[]
): string {
  const prompt = [
    `This coaching project is called "${project.name}".`,
    '',
    project.instructions.trim(),
    '',
    workspaceSection(workspace),
    '',
    houseRules(project.allowDelete)
  ].join('\n')

  if (prompt.length <= MAX_PROMPT_LENGTH) return prompt
  // Trim the user's brief rather than the rules: the rules are what keeps the
  // tools working at all.
  const overBy = prompt.length - MAX_PROMPT_LENGTH
  const trimmed = project.instructions.trim().slice(0, Math.max(0, project.instructions.trim().length - overBy - 20))
  return [
    `This coaching project is called "${project.name}".`,
    '',
    `${trimmed}\n…`,
    '',
    workspaceSection(workspace),
    '',
    houseRules(project.allowDelete)
  ].join('\n')
}

/**
 * The wrap-up turn, sent as text when the learner stops the session.
 *
 * The model has been told all along to write as it goes; this is the backstop
 * for the session that ran long and never got round to it.
 */
export const WRAPUP_TEXT = [
  'The session is ending now. Do not reply out loud.',
  'Update your workspace files so the next session can pick up from here:',
  'what was covered, what the learner got right, and what to come back to.',
  'Use your file tools now.'
].join(' ')

/**
 * The second and last attempt, when the first wrap-up produced no tool calls at
 * all. Sent with tool_choice forced, so the model cannot answer in words again.
 */
export const WRAPUP_FORCED_TEXT = [
  'You did not save anything. Write your notes to the workspace now,',
  'using write_file or append_file. Do not reply with words.'
].join(' ')
