/**
 * Line-scoped reading and writing of the profile patch layer
 * (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) and of installed
 * packages' bundle patches — without a YAML parser dependency.
 *
 * Scope discipline: this plugin never rewrites YAML it does not own. Disable
 * state lives in a dedicated trailing block between two marker comments, so
 * user-authored rows (including hand-written disables) survive every write
 * byte-for-byte; reads answer only what this module can unambiguously
 * recognize and degrade to "enabled" / "no id" otherwise. The kernel's boot
 * requires a patch file to parse as a top-level YAML ARRAY (a comments-only
 * or blank file would fail the boot), so a file left with no rows at all is
 * normalized to `[]`.
 *
 * Kernel facts this relies on: a disable patch row is `{ id, disabled: true }`
 * targeting the composed entry id, and the web profile's patchReload=live
 * applies patch-file edits without a restart. The shell's own overlay applies
 * AFTER the profile layer, so disables only hold for non-suite packages.
 *
 * @module @dsh-app/plugin-market/patchfile
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MarketValidationError } from './errors.ts'

/** First line of the managed block. */
export const MANAGED_BLOCK_HEADER = '# ── plugin-market managed disables ──'
/** Last line of the managed block. */
export const MANAGED_BLOCK_FOOTER = '# ── end managed ──'

/**
 * Whitelist for entry ids this plugin writes into YAML: plain-safe scalars
 * only. Excludes whitespace (row splitting), `:` (mapping indicator), `#`
 * (comment indicator), quotes, and the YAML special markers (`~` parses as
 * null, `*`/`&`/`!`/`@`-alone are aliases/tags/reserved indicators), so an id
 * can never break out of the `- id: <id>` row it is written into.
 */
export const ENTRY_ID_PATTERN = /^(?:[A-Za-z0-9]|@[A-Za-z0-9])[A-Za-z0-9@/._-]{0,119}$/

/** A list-item line carrying an id (`- id: <value>`), indent captured. */
const ID_LINE = /^(\s*)-\s+id:(.*)$/
/** A mapping line carrying a name (`name: <value>`), indent captured. */
const NAME_LINE = /^(\s*)name:(.*)$/
/** The disable flag line, indented deeper than its row's dash. */
const DISABLED_LINE = /^\s*disabled:\s*true\s*(?:#.*)?$/

/** Split preserving every line terminator, so joins reproduce input bytes. */
function splitKeepEnds(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/)
}

/** The element content without its line terminator. */
function lineContent(element: string): string {
  return element.replace(/\r?\n$/, '')
}

/** Trim, drop a trailing (space-prefixed) comment, unwrap one quote pair. */
function scalarOf(raw: string): string {
  let value = raw.trim().replace(/\s+#.*$/, '')
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

/**
 * Ids the patch layer disables: a `- id: <x>` list row whose mapping block
 * (lines indented deeper than the row's dash) carries `disabled: true`. This
 * is a read heuristic over kernel-controlled shapes; rows the scanner cannot
 * recognize simply do not count, which degrades to "enabled" — the safe
 * direction (a false "enabled" only mislabels display state, never writes).
 */
export function disabledIdsOf(patchText: string): ReadonlySet<string> {
  const disabled = new Set<string>()
  let pendingId: string | null = null
  let pendingIndent = -1
  for (const line of patchText.split(/\r?\n/)) {
    const idMatch = ID_LINE.exec(line)
    if (idMatch !== null) {
      pendingIndent = idMatch[1]!.length
      const id = scalarOf(idMatch[2]!)
      pendingId = id === '' ? null : id
      continue
    }
    if (pendingId === null) continue
    const indent = line.length - line.trimStart().length
    if (/^\s*-\s/.test(line) && indent <= pendingIndent) {
      pendingId = null // a sibling/parent list row ends the current mapping block
      continue
    }
    if (DISABLED_LINE.test(line) && indent > pendingIndent) {
      disabled.add(pendingId)
      pendingId = null
    }
  }
  return disabled
}

/**
 * The entry id a package's bundle patch inserts for `packageName` (the first
 * `- insert:` row whose `name:` matches). Bundle patches are the kernel's
 * authoritative id source (e.g. a package `dsh-usage-heatmap` may insert the
 * entry `usage-heatmap`); packages without a recognizable row answer
 * undefined and the caller falls back to the package name.
 */
export function insertedEntryIdOf(patchText: string, packageName: string): string | undefined {
  let pendingId: string | null = null
  let pendingIndent = -1
  for (const line of patchText.split(/\r?\n/)) {
    const idMatch = ID_LINE.exec(line)
    if (idMatch !== null) {
      pendingIndent = idMatch[1]!.length
      pendingId = scalarOf(idMatch[2]!)
      continue
    }
    const nameMatch = NAME_LINE.exec(line)
    if (nameMatch !== null && pendingId !== null && nameMatch[1]!.length > pendingIndent) {
      if (scalarOf(nameMatch[2]!) === packageName) return pendingId
      pendingId = null
    }
  }
  return undefined
}

/** One block row: the element span [start, end) and its id when readable. */
interface BlockRow {
  readonly start: number
  end: number
  readonly id: string | undefined
}

/** Locate the managed block; a header without a footer spans to EOF (self-heal for hand truncation). */
function blockRange(elements: readonly string[]): { start: number, end: number, closed: boolean } | undefined {
  for (let i = 0; i < elements.length; i += 1) {
    if (lineContent(elements[i]!) !== MANAGED_BLOCK_HEADER) continue
    for (let j = i + 1; j < elements.length; j += 1) {
      if (lineContent(elements[j]!) === MANAGED_BLOCK_FOOTER) return { start: i, end: j, closed: true }
    }
    return { start: i, end: elements.length, closed: false }
  }
  return undefined
}

/** Group the block interior into rows (a `- ` line starts one, deeper lines continue it). */
function blockRows(elements: readonly string[], start: number, end: number): BlockRow[] {
  const rows: BlockRow[] = []
  for (let i = start + 1; i < end; i += 1) {
    const content = lineContent(elements[i]!)
    const idMatch = ID_LINE.exec(content)
    if (idMatch !== null) rows.push({ start: i, end: i + 1, id: scalarOf(idMatch[2]!) })
    else if (rows.length > 0) rows[rows.length - 1]!.end = i + 1
  }
  return rows
}

/**
 * Pure transform behind the toggle: add or remove one disable row for
 * `entryId`, touching nothing else. Idempotent both ways (adding an existing
 * row or removing an absent one returns the input unchanged). Enabling the
 * last row removes the whole block; a file left with no rows at all
 * normalizes to `[]` (the kernel rejects non-array patch docs).
 *
 * @param patchText - the current file content ('' = file absent).
 * @param entryId - a validated (ENTRY_ID_PATTERN) entry id.
 * @param enable - true = remove the disable row, false = add it.
 * @returns the new content (same reference/value when nothing changed).
 */
export function applyDisableToggle(patchText: string, entryId: string, enable: boolean): string {
  if (!ENTRY_ID_PATTERN.test(entryId)) {
    throw new MarketValidationError({
      code: 'entryId.invalid',
      params: { id: entryId },
      text: `invalid plugin entry id: "${entryId}"`,
    })
  }
  // Appends adopt the file's line endings; existing bytes are never re-encoded.
  const eol = patchText.includes('\r\n') ? '\r\n' : '\n'
  const elements = splitKeepEnds(patchText)
  const block = blockRange(elements)
  const rows = block === undefined ? [] : blockRows(elements, block.start, block.end)
  const target = rows.find(row => row.id === entryId)

  if (enable) {
    if (block === undefined || target === undefined) return patchText
    const kept = rows.filter(row => row.id !== entryId)
    const head = elements.slice(0, block.start)
    const tail = block.closed ? elements.slice(block.end + 1) : []
    if (kept.length === 0) {
      const rest = [...head, ...tail].join('')
      // Comments are user content too: keep them and anchor the document with
      // the canonical empty array (the kernel rejects a comment-only file).
      // Only a blank remainder collapses to the bare '[]'.
      if (rest.trim() === '') return '[]\n'
      if (hasYamlRow(rest)) return rest
      return /\n$/.test(rest) ? `${rest}[]\n` : `${rest}\n[]\n`
    }
    const middle = [
      elements[block.start]!,
      ...kept.flatMap(row => elements.slice(row.start, row.end)),
      ...(block.closed ? [elements[block.end]!] : []),
    ]
    return [...head, ...middle, ...tail].join('')
  }

  // Already disabled — whether by a previous managed write or a hand-written
  // row outside the block — means adding another row would be pure duplication.
  if (target !== undefined || disabledIdsOf(patchText).has(entryId)) return patchText
  const row = [`- id: ${entryId}${eol}`, `  disabled: true${eol}`]
  if (block === undefined) {
    if (elements.length === 0) return [MANAGED_BLOCK_HEADER + eol, ...row, MANAGED_BLOCK_FOOTER + eol].join('')
    const last = elements[elements.length - 1]!
    if (!/\n$/.test(last)) elements[elements.length - 1] = last + eol
    // No separator line: enabling then restores the original bytes exactly.
    return [...elements, MANAGED_BLOCK_HEADER + eol, ...row, MANAGED_BLOCK_FOOTER + eol].join('')
  }
  if (!block.closed) {
    // A hand-truncated block may end mid-file without a trailing newline;
    // appending rows there would fuse them onto the last line and corrupt
    // the YAML. Same newline guard as the block-less branch above.
    const last = elements[elements.length - 1]!
    if (!/\n$/.test(last)) elements[elements.length - 1] = last + eol
  }
  elements.splice(block.closed ? block.end : elements.length, 0, ...row)
  if (!block.closed) elements.push(MANAGED_BLOCK_FOOTER + eol) // re-close a hand-truncated block
  return elements.join('')
}

/** Whether the text still carries at least one non-comment, non-blank line. */
function hasYamlRow(text: string): boolean {
  return text.split(/\r?\n/).some(line => line.trim() !== '' && !line.trim().startsWith('#'))
}

/**
 * Apply the toggle to the patch file on disk (creates the file and its parent
 * directory on disable; a missing file means "everything enabled", so enabling
 * without a file is a no-op). The write is atomic (tmp + rename).
 * @param path - absolute path of the profile patch file.
 * @param entryId - a validated entry id.
 * @param enable - true = remove the disable row, false = add it.
 * @returns whether the file content changed.
 */
/**
 * Result of a toggle attempt. `foreign` marks the "read but not writable"
 * asymmetry: the id shows as disabled (a hand-written row outside the managed
 * block) while the enable path cannot touch it — the route must surface this
 * instead of reporting a silent fake success.
 */
export interface ToggleOutcome {
  changed: boolean
  foreign: boolean
}

export function toggleManagedDisable(path: string, entryId: string, enable: boolean): ToggleOutcome {
  let current = ''
  try {
    current = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const next = applyDisableToggle(current, entryId, enable)
  if (next === current) {
    // Unchanged either because there was nothing to do or because the disable
    // lives outside the managed block. Distinguish them for the caller.
    const foreign = enable && disabledIdsOf(current).has(entryId)
    return { changed: false, foreign }
  }
  mkdirSync(dirname(path), { recursive: true })
  // 随机后缀：两个并发写入各自落在独立临时文件，后 rename 者胜，互不踩踏
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, path)
  return { changed: true, foreign: false }
}
