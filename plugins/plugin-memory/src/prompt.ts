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
 * Injection budgets (per-assembly selection: pinned entries always win, then
 * the NEWEST entries of each category up to a quota — one bucket cannot crowd
 * out the others; whatever is dropped stays reachable via memory_recall):
 *   global  ≤ {@link MAX_GLOBAL_CHARS}   — preferences stay small by discipline
 *   project ≤ {@link MAX_PROJECT_CHARS}  — the growth valve
 *
 * @module @dsh-app/plugin-memory/prompt
 */

import { normalizeForMatch, parseEntries, type MemoryEntry, type MemoryRoot } from './memory-store.ts'
import type { MemoryCategory } from './types.ts'

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

/** Per-category quota inside the injection budget: every category keeps its
 *  NEWEST entries so one class cannot crowd out the others (a project today
 *  rarely needs more than this from each bucket). */
const CATEGORY_QUOTA: Record<MemoryCategory, number> = {
  preference: 3,
  convention: 3,
  decision: 2,
  lesson: 2,
  fact: 2,
}

/** One injection selection: the picked lines plus whether anything was dropped. */
interface MemorySelection {
  selected: string[]
  truncated: boolean
}

/**
 * Pick the injection lines under a character budget:
 *  1. pinned entries always win (the user's hard guarantee — they survive
 *     growth regardless of how the rest is truncated);
 *  2. per category the newest {@link CATEGORY_QUOTA} entries (memory files
 *     are append-only, so the tail holds the fresh facts);
 *  3. non-standard lines (hand edits) are carried verbatim.
 * Budget is accumulated in that priority order (quota overflow only ever
 * drops the oldest picks), while the emitted text keeps file order so the
 * timeline stays readable. What is dropped under the budget stays reachable
 * via memory_recall.
 */
export function selectBalanced(text: string, budget: number, pinned: Set<string>): MemorySelection {
  const entries = parseEntries(text)
  if (entries.length === 0) return { selected: [], truncated: false }

  const byCategory = new Map<string, MemoryEntry[]>()
  const pinnedEntries: MemoryEntry[] = []
  const handNotes: MemoryEntry[] = []
  for (const entry of entries) {
    if (pinned.has(normalizeForMatch(entry.content))) {
      pinnedEntries.push(entry)
    } else if (entry.category === undefined) {
      handNotes.push(entry)
    } else {
      const list = byCategory.get(entry.category) ?? []
      list.push(entry)
      byCategory.set(entry.category, list)
    }
  }
  // Pinned entries rank FIRST — nothing (not even a long hand note) may ever
  // crowd them out of the budget; that is what "pin" promises.
  const priority: MemoryEntry[] = [...pinnedEntries, ...handNotes]
  for (const [category, list] of byCategory) {
    const quota = CATEGORY_QUOTA[category as MemoryCategory] ?? 2
    priority.push(...list.slice(Math.max(0, list.length - quota)))
  }

  const picked: MemoryEntry[] = []
  let used = 0
  for (const entry of priority) {
    const width = entry.raw.length + 1
    if (used + width > budget) break
    picked.push(entry)
    used += width
  }
  if (picked.length === 0) {
    // The pin contract never blanks: even when the very first line exceeds
    // the whole budget, the FIRST pinned entry is still injected whole.
    const fallback = pinnedEntries[0]
    if (fallback !== undefined) return { selected: [fallback.raw], truncated: true }
    return { selected: [], truncated: true }
  }

  const order = new Map(entries.map((entry, index) => [entry, index]))
  picked.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return { selected: picked.map(entry => entry.raw), truncated: picked.length < entries.length }
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
  const globalPinned = root.global.pinnedSet()
  const globalText = root.global.read().trim()
  const projectStore = cwd === undefined ? undefined : root.projectFor(cwd)
  const projectText = projectStore === undefined ? '' : projectStore.read().trim()
  const projectName = cwd === undefined ? '' : cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? ''

  const parts: string[] = [GUIDELINES_TEXT]
  const g = selectBalanced(globalText, MAX_GLOBAL_CHARS, globalPinned)
  // Each scope pins against its OWN store: a global pin never leaks into a
  // project file, and project pins (set from the settings page) actually work.
  const p = selectBalanced(projectText, MAX_PROJECT_CHARS, projectStore === undefined ? new Set<string>() : projectStore.pinnedSet())

  if (globalText === '' && projectText === '') {
    parts.push('', '## Memory (persisted)', '', '(empty — nothing saved yet)')
    return parts.join('\n')
  }

  if (globalText !== '') {
    parts.push('', '### Memory — global', '', g.selected.join('\n'))
    if (g.truncated) parts.push('', '— older entries not injected; memory_recall reads the full file.')
  }
  if (projectText !== '') {
    parts.push('', `### Memory — current project (${projectName})`, '', p.selected.join('\n'))
    if (p.truncated) parts.push('', '— older entries not injected; memory_recall reads the full file.')
  }
  return parts.join('\n')
}
