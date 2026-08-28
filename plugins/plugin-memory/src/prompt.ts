/**
 * System-prompt contributions: static saving guidelines + a dynamic section
 * injecting TWO scopes — the global file (every session) and the current
 * project's file (only sessions of that workspace). Other projects' files
 * are physically absent from the assembly; isolation is structural, not
 * prompt-level discipline.
 *
 * The section text is a provider evaluated per assembly with the AssembleContext
 * the agent package extends (context.agent?.session.header.cwd), so a
 * memory_save mid-session is visible to the NEXT turn, and the master
 * toggle is honored live.
 *
 * Injection budgets (line-boundary truncation keeping the NEWEST entries
 * with a recall hint — the file is append-only, so freshness sits at the
 * bottom and matters most to the current session):
 *   global  ≤ {@link MAX_GLOBAL_CHARS}   — preferences stay small by discipline
 *   project ≤ {@link MAX_PROJECT_CHARS}  — the growth valve
 *
 * @module @dsh-app/plugin-memory/prompt
 */

import type { MemoryRoot } from './memory-store.ts'

/** Hard ceiling on the injected GLOBAL memory text (characters). */
export const MAX_GLOBAL_CHARS = 1_200

/** Hard ceiling on the injected PROJECT memory text (characters). */
export const MAX_PROJECT_CHARS = 2_800

/** Guidelines shown to the model whenever memory is enabled. English, to
 * match the harness's own prompt sections; the model writes ENTRIES in
 * the user's language as instructed below. The save triggers are worded
 * MODEL-driven ("whenever you observe") — a user-driven wording ("when
 * the user asks") silently drops implicit preferences the user never
 * states and facts the model digs out on its own. */
const GUIDELINES_TEXT = [
  '## Cross-session memory',
  '',
  'Persistent memory survives across sessions in two scopes:',
  '- GLOBAL: user preferences and habits, valid in every project.',
  '- PROJECT: decisions, conventions, and lessons of the current workspace only.',
  'Both current files are injected below; call memory_recall to read them in full.',
  '',
  'SAVE proactively via memory_save — do not wait to be asked — whenever you observe:',
  '- an explicit request to remember something,',
  '- a durable user preference, stated OR inferred from repeated behavior '
  + '(the user always wants typecheck run, always answers in Chinese) → scope "global",',
  '- a settled project decision or convention (architecture choice, closed debate) '
  + '→ scope "project",',
  '- a hard-won lesson you or the user surfaced: a root cause you diagnosed, a '
  + 'non-obvious constraint, a pitfall dug out of logs or docs → scope "project".',
  '',
  'CORRECT, never contradict: when the user corrects, retracts, or reverses a '
  + 'fact that is already saved, call memory_forget to remove the stale entry '
  + '(match its distinctive text), then memory_save the corrected fact if it '
  + 'still matters. NEVER answer a correction by appending a contradicting '
  + 'entry — both lines would be injected into every future session.',
  '',
  'NEVER save: API keys, tokens, passwords, or any credential — not even when asked;',
  'ephemeral state derivable within the current session; routine facts the user',
  'will obviously restate. When genuinely unsure whether something is durable, ask.',
  '',
  'Entry discipline: one line per entry; write in the user\'s language; keep it',
  'lean — these files are re-read by every future session of their scope.',
].join('\n')

/** Truncate to a budget on a line boundary, keeping the NEWEST tail:
 * memory files are append-only so fresh entries live at the bottom and are
 * the most likely to matter right now; the dropped head stays reachable via
 * memory_recall. Returns the kept tail and whether anything was dropped. */
function truncateTail(text: string, budget: number): { tail: string, truncated: boolean } {
  if (text.length <= budget) return { tail: text, truncated: false }
  const slice = text.slice(text.length - budget)
  const firstBreak = slice.indexOf('\n')
  const tail = (firstBreak > 0 ? slice.slice(firstBreak + 1) : slice).trimStart()
  return { tail, truncated: true }
}

/**
 * Render the whole injected memory block for one assembly.
 * @param root - the two-level memory root.
 * @param cwd - the assembling session's workspace path; undefined (agentless
 *   diagnostics) injects the global scope only.
 * @returns the section text; '' when the master toggle is off.
 */
export function renderMemoryText(root: MemoryRoot, cwd: string | undefined): string {
  if (!root.global.isEnabled()) return ''
  const globalText = root.global.read().trim()
  const projectText = cwd === undefined ? '' : root.projectFor(cwd).read().trim()
  const projectName = cwd === undefined ? '' : cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? ''

  const parts: string[] = [GUIDELINES_TEXT]
  const g = truncateTail(globalText, MAX_GLOBAL_CHARS)
  const p = truncateTail(projectText, MAX_PROJECT_CHARS)

  if (globalText === '' && projectText === '') {
    parts.push('', '## Memory (persisted)', '', '(empty — nothing saved yet)')
    return parts.join('\n')
  }

  if (globalText !== '') {
    parts.push('', '### Memory — global', '', g.tail)
    if (g.truncated) parts.push('', '— older entries not injected; memory_recall reads the full file.')
  }
  if (projectText !== '') {
    parts.push('', `### Memory — current project (${projectName})`, '', p.tail)
    if (p.truncated) parts.push('', '— older entries not injected; memory_recall reads the full file.')
  }
  return parts.join('\n')
}
