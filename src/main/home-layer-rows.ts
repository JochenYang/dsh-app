/**
 * Rows the HOME layer owns that the app itself has to be able to write.
 *
 * Why this module exists — measured against the kernel, not guessed:
 *
 *   - the kernel composes a profile as `bundle layers → the profile's own patch →
 *     the HOME layer ($DSH_HOME/cordis.patch.yml) → command-line overlays`
 *     (`dsh-app-boot/lib/index.js` `readProfilePatches`), and the LAST row wins
 *     for an id;
 *   - so when a setting also exists in the home layer, the value the app writes
 *     into the profile patch is not the value that takes effect — and the
 *     configuration editor REFUSES the write instead of accepting a silent no-op:
 *
 *       dsh-config-editor/lib/index.js:122
 *       if (!isDeepStrictEqual(composeEntries([patches]).find(r => r.id === id)?.config ?? {}, next))
 *         throw new Error(`Configuration for "${id}" is overridden by a home patch or command-line overlay`)
 *
 *     The check runs BEFORE the write (line 123), so nothing is corrupted — the
 *     save simply can never succeed, for ever, for that id: a user who set a
 *     machine-wide default model (or search provider) in the home layer cannot
 *     change it from the app at all.
 *
 * The composition order is the LAUNCHER's (`dsh-desktop-host`), which this
 * project does not fork, so there is no shell-side ordering trick. The only
 * honest remedy is to move that row out of the home layer — which loses nothing
 * for the profile in question, because the row is APPENDED, byte for byte, to
 * this profile's own patch before it is dropped from the home one.
 *
 * Two deliberate limits:
 *
 *   - only rows carrying a `config` are reported. A row without one overrides no
 *     value, so it cannot shadow a setting (it is an identity row, and the kernel
 *     accepts writes against it);
 *   - the home layer is only ever READ here. The caller decides whether to act,
 *     and the drop is offered to the user as a choice, because the home layer
 *     belongs to every profile on the machine, not just this one.
 *
 * @module dsh-app/main/home-layer-rows
 */

import { readFileSync } from 'node:fs'

/** One home-layer row that would shadow a setting the app can edit. */
export interface HomeLayerConflict {
  /** The entry id the row overrides. */
  readonly id: string
  /** The package the row names, when it names one. */
  readonly name: string | undefined
  /** The row's own lines, verbatim — appended as-is, never re-serialized. */
  readonly lines: readonly string[]
  /** 1-based line of the row's first line, for logs and for the user to look at. */
  readonly line: number
}

/** A patch document's rows, split the way every reader in this repository splits them. */
interface Row {
  readonly lines: readonly string[]
  readonly start: number
}

/**
 * Split a patch into its root-level rows, each with the lines it owns.
 *
 * A row starts at a column-0 `- ` line and owns every following line that is
 * indented or blank. A column-0 comment is NOT swallowed: comments in these files
 * explain the row BELOW them as often as the one above (the shipped overlay does
 * exactly that), and taking one with a removal would delete an explanation the
 * user wrote.
 *
 * @param text - the patch document.
 * @returns each row, in file order.
 */
function splitRows(text: string): Row[] {
  const lines = text.split('\n')
  const rows: Row[] = []
  let current: string[] | undefined
  let start = 0
  /** Finish the open row, keeping any blank lines it ended with out of it. */
  const close = (): void => {
    if (current === undefined) return
    const kept = [...current]
    while (kept.length > 1 && (kept[kept.length - 1] ?? '').trim() === '') kept.pop()
    rows.push({ lines: kept, start })
    current = undefined
  }
  for (const [index, line] of lines.entries()) {
    if (/^- /u.test(line)) {
      close()
      current = [line]
      start = index
      continue
    }
    if (current === undefined) continue
    if (line.trim() === '' || /^\s/u.test(line)) current.push(line)
    else {
      // A column-0 line that is not a row start ends the row's span (a comment or
      // a document-level key: both belong to the file, not to the row).
      close()
    }
  }
  close()
  return rows
}

/** The content column of a row's own keys (a `- ` marker counts as two columns). */
const KEY_INDENT = /^(-\s+)/u
function keyIndentOf(firstLine: string): number {
  const leading = (firstLine.match(/^[ \t]*/u)?.[0] ?? '').length
  return leading + (KEY_INDENT.test(firstLine.trimStart()) ? 2 : 0)
}

/** The entry id a row declares, from its own first line. */
const ROW_ID = /^-\s+id:\s*(?:(["'])(.*?)\1|(\S+))\s*(?:#.*)?$/u
function rowId(row: Row): string | undefined {
  const match = ROW_ID.exec(row.lines[0] ?? '')
  const value = match?.[2] ?? match?.[3] ?? ''
  return value === '' ? undefined : value
}

/** The package a row names, when the `name:` sits at the row's own content column. */
function rowName(row: Row): string | undefined {
  const indent = keyIndentOf(row.lines[0] ?? '')
  for (const line of row.lines.slice(1)) {
    const match = /^(\s*)name:\s*(?:(["'])(.*?)\2|(\S+))\s*(?:#.*)?$/u.exec(line)
    if (match === null || (match[1] ?? '').length !== indent) continue
    return match[3] ?? match[4]
  }
  return undefined
}

/** Whether a row sets a `config:` (the only rows that can shadow a value). */
function rowHasConfig(row: Row): boolean {
  const indent = keyIndentOf(row.lines[0] ?? '')
  return row.lines.slice(1).some((line) => {
    const match = /^(\s*)config:\s*(.*)$/u.exec(line)
    return match !== null && (match[1] ?? '').length === indent
  })
}

/**
 * The home layer's rows that would shadow an app-writable setting of one profile.
 *
 * @param options.homeLayerText - the home layer's contents ('' when the file does not exist).
 * @param options.profileEntryIds - the ids the profile's own composition carries.
 * @returns the conflicting rows, in file order.
 */
export function readHomeLayerConflicts(options: {
  homeLayerText: string
  profileEntryIds: ReadonlySet<string>
}): HomeLayerConflict[] {
  const conflicts: HomeLayerConflict[] = []
  for (const row of splitRows(options.homeLayerText)) {
    const id = rowId(row)
    if (id === undefined) continue
    if (!rowHasConfig(row)) continue
    if (!options.profileEntryIds.has(id)) continue
    conflicts.push({ id, name: rowName(row), lines: row.lines, line: row.start + 1 })
  }
  return conflicts
}

/**
 * Remove one row (by id) from a patch document, leaving every other byte alone.
 *
 * Line-oriented on purpose: the home layer is a file the user may have written by
 * hand, and re-serializing YAML would rewrite their comments, quoting and `!!js`
 * expressions. Only the row's own lines leave.
 *
 * @param text - the document.
 * @param id - the entry id to drop.
 * @returns the new text and the lines that were removed (undefined when nothing matched).
 */
export function dropRowById(text: string, id: string): { text: string, removed: readonly string[] | undefined } {
  const rows = splitRows(text)
  const victim = rows.find((row) => rowId(row) === id)
  if (victim === undefined) return { text, removed: undefined }
  const doomed = new Set(victim.lines.map((_, offset) => victim.start + offset))
  const kept = text.split('\n').filter((_line, index) => !doomed.has(index))
  return { text: kept.join('\n'), removed: victim.lines }
}

/**
 * Append a row's lines to the end of a patch document.
 *
 * Appended, never merged: the document is the kernel's, and a row that is already
 * there is left exactly as it is (the caller checks that first — appending a
 * second row for the same id would make the file messy for no gain, because the
 * loader's last-wins rule would pick the appended one).
 *
 * @param text - the document.
 * @param lines - the row's lines, verbatim.
 * @returns the new text.
 */
export function appendRowLines(text: string, lines: readonly string[]): string {
  const body = text.replace(/\n+$/u, '')
  if (body.trim() === '' || body.trim() === '[]') return `[]\n${lines.join('\n')}\n`
  return `${body}\n${lines.join('\n')}\n`
}

/**
 * Every entry id a set of patch documents declares, root-level or nested.
 *
 * Used to decide whether a home-layer row actually lands in a profile's
 * composition: an id no layer declares would be a row this profile cannot resolve,
 * and moving such a row into the profile patch would only earn the kernel's
 * `patch: entry "…" not found` warning on every start. Over-inclusive is fine here
 * (a nested id inside an `insert:` block IS a row in the composition), so the scan
 * is deliberately loose.
 *
 * @param texts - the patch documents to scan.
 * @returns the declared ids.
 */
export function collectEntryIds(texts: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(/^\s*-?\s*id:\s*(?:(["'])(.*?)\1|(\S+))\s*(?:#.*)?$/gmu)) {
      const value = match[2] ?? match[3] ?? ''
      if (value !== '') ids.add(value)
    }
  }
  return ids
}

/**
 * Read one of the two files this module works with, tolerating its absence.
 * @param file - the path.
 * @returns the file's contents, or '' when it is not there.
 */
export function readPatchText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Plan moving shadowing rows out of the home layer and into a profile.
 *
 * The value is kept for THIS profile, byte for byte, by appending each row's own
 * lines to its patch — parsing and re-serializing would drop `!!js` expressions,
 * which is the same reason the overlay is carried as text everywhere else in this
 * shell.
 *
 * Appended even when the profile's patch already declares the id, and that is
 * deliberate: the two rows can disagree (the home layer is the one that has been
 * in effect), and a duplicate id is harmless for a non-insert row — the loader
 * takes the LAST one, and the kernel's editor rewrites exactly that last one
 * (`document.contents.items.findLastIndex(...)`). Dropping the home row without
 * appending would silently change the value the user sees to whatever the older
 * profile row happened to say.
 *
 * Pure: it decides, it does not write. The caller takes the backups and performs
 * the writes, so the decision can be reviewed (and tested) without touching files.
 *
 * @param options.homeLayerText - the home layer's contents.
 * @param options.profilePatchText - the profile's own patch contents.
 * @param options.ids - the entry ids to move, in the order they were reported.
 * @returns the two new documents and the ids that were actually moved.
 */
export function planHomeLayerMoves(options: {
  homeLayerText: string
  profilePatchText: string
  ids: readonly string[]
}): { home: string, profile: string, moved: string[] } {
  let home = options.homeLayerText
  let profile = options.profilePatchText
  const moved: string[] = []
  for (const id of options.ids) {
    const dropped = dropRowById(home, id)
    if (dropped.removed === undefined) continue
    home = dropped.text
    profile = appendRowLines(profile, dropped.removed)
    moved.push(id)
  }
  return { home, profile, moved }
}

/**
 * Carry out a planned move: both files are backed up first, then written atomically.
 *
 * A host restart is NOT required, and that is a measured fact rather than a hope:
 * the kernel's configuration editor re-reads the profile patch before every edit
 * (`dsh-config-editor/lib/index.js`: `before = await readFile(path)` →
 * `parseDocument(before)`), so an appended row is picked up by the very next save
 * instead of being overwritten by a stale in-memory document.
 *
 * @param options.plan - the result of {@link planHomeLayerMoves}.
 * @param options.homeLayerPath - the home layer's path (backed up beside itself).
 * @param options.profilePatchPath - the profile patch's path (backed up too).
 * @param options.stamp - the backup suffix, `YYYYMMDD` (the caller's clock).
 * @param options.write - the atomic writer (injectable for tests).
 * @returns the two backup paths.
 */
export async function applyHomeLayerMoves(options: {
  plan: { home: string, profile: string, moved: string[] }
  homeLayerPath: string
  profilePatchPath: string
  stamp: string
  write: (target: string, content: string) => Promise<void>
}): Promise<{ homeBackup: string, profileBackup: string | undefined }> {
  const homeBefore = readPatchText(options.homeLayerPath)
  const homeBackup = `${options.homeLayerPath}.bak-before-home-move-${options.stamp}`
  await options.write(homeBackup, homeBefore)
  let profileBackup: string | undefined
  if (options.plan.moved.length > 0) {
    const profileBefore = readPatchText(options.profilePatchPath)
    profileBackup = `${options.profilePatchPath}.bak-before-home-move-${options.stamp}`
    await options.write(profileBackup, profileBefore)
  }
  await options.write(options.homeLayerPath, options.plan.home)
  if (options.plan.moved.length > 0) await options.write(options.profilePatchPath, options.plan.profile)
  return { homeBackup, profileBackup }
}
