/**
 * The suite's own bundle layer — the profile's channel for the shipped rows.
 *
 * Why this module exists: the desktop host takes no `--patch` argument and
 * composes no home layer, so the suite's rows have to arrive through something
 * the host reads. It reads a profile's declared bundles and each bundle's own
 * `dsh.bundle.patch` layer (`loadProfileDirectory`, `@deepseek-ai/dsh-app-boot`).
 * The rows used to travel in the profile's own `cordis.patch.yml`, which this
 * shell regenerated on every start — until kernel 0.1.7 made that file the place
 * where the KERNEL persists the user's settings (`dsh-config-editor`'s `edit()`:
 * parse with `yaml`, mutate the sequence, serialise the document back).
 *
 * One file with two writers and two models of it does not work. The shell's
 * boundary was a comment, but a serialiser places a new sequence item after the
 * last ITEM, so where the kernel's row lands depends on what the last row is —
 * measured: on a fresh profile it lands inside the section the shell re-derives
 * from the shipped overlay, and the setting is gone on the next start. Every
 * setting stored against a row the overlay itself carries (`web`,
 * `deepseek-account`) went the same way.
 *
 * So the shell stops writing that file. Its own rows move into a bundle layer it
 * owns, the kernel becomes the only writer of the profile patch, and the class of
 * failure disappears rather than being narrowed.
 *
 * What each of the old generated sections becomes:
 *
 *   - the shipped overlay      → this layer's patch file
 *   - rows the profile carried → left where they are (that file is the kernel's)
 *   - the home-layer copy      → unchanged; only the frames line still needs it,
 *                                and that line keeps its old writer (see below)
 *   - everything past the tail → left where it is
 *
 * The FRAMES line (a host older than `0.1.6-alpha.2`) keeps the previous
 * regeneration: its composer reads only the profile patch, so the home-layer copy
 * there is the user's only channel, and freezing it would be a functional
 * regression on a line this shell still supports for rollback. Only the web line
 * — the one 0.1.7 ships on — moves to the layer.
 *
 * @module dsh-app/main/suite-layer
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PROFILE_PATCH_FILENAME, writePatchAtomically } from './brand-suite'

/**
 * Package name the suite's rows travel as. Synthetic, private, and never a npm
 * dependency: it appears in `dsh.profile.bundles` only. `dependencies` is pnpm's
 * to reconcile, and a name that is in neither list is a bundle TEMPLATE entry,
 * which the kernel's own reconciliation preserves
 * (`reconcileProfilePlugins`, `dsh-app-boot`).
 *
 * The scope is spelled out rather than imported from `brand-suite`: this module
 * and that one import each other, and a module-level constant derived across a
 * cycle evaluates to `undefined` when the other side loads first (measured: the
 * name became `undefined/suite-layer`). A literal cannot be evaluated too early;
 * `test/suite-layer.test.mjs` pins it against the exported constant.
 */
export const SUITE_LAYER_PACKAGE = '@dsh-app/suite-layer'

/** Directory name of the layer package inside the profile's `@dsh-app` scope. */
const SUITE_LAYER_DIRNAME = 'suite-layer'

/** npm scope shared by the suite plugins (twin of `PLUGIN_SCOPE` in brand-suite.ts). */
const PLUGIN_SCOPE = '@dsh-app'

/** File name of the layer's patch, and the package-relative spec the manifest names. */
const LAYER_PATCH_FILENAME = 'cordis.patch.yml'

/** File name of the shipped overlay, beside this module in `dist/main`. */
const SHIPPED_OVERLAY_FILENAME = 'dsh-app.patch.yml'

/**
 * The shipped overlay's rows, or '' when it is not beside this module.
 *
 * Read from `dist/main/dsh-app.patch.yml` (`scripts/copy-static.mjs` puts the
 * repository's `plugins/dsh-app.patch.yml` there), which is also what the
 * settings-nav and chrome probes read — so the file keeps its meaning as "the
 * suite's rows", and only its destination changes.
 */
export async function readShippedOverlay(): Promise<string> {
  return (await readText(path.join(__dirname, SHIPPED_OVERLAY_FILENAME))) ?? ''
}

/** Outcome of one install pass, for the caller's log line. */
export interface SuiteLayerOutcome {
  /**
   * `installed` — the layer is in place and the profile patch was migrated (or
   * already was); `already` — nothing needed writing; `failed` — see detail, the
   * suite's rows are NOT guaranteed (the boot degrades to a vanilla UI).
   */
  status: 'installed' | 'already' | 'failed'
  /** Inserts removed from the profile patch by the migration, for the log. */
  removed: readonly string[]
  /** Where the pre-migration copy of the profile patch was kept, when one was made. */
  backup?: string
  /** Absolute path of the layer package, for the log. */
  layerDir?: string
  /** Failure detail, for the log. */
  detail?: string
}

/** Read a file as UTF-8, or undefined when it is not there (or not readable). */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * CRLF and lone-CR endings normalised to LF, then split.
 *
 * The same rule the sibling readers in `brand-suite.ts` apply, and for the same
 * measured reason: `.` never matches a carriage return, so a row reader anchored
 * to the end of a line reads a CRLF row as one with no value at all — silently,
 * which is the shape of failure these readers exist to prevent.
 */
function patchLines(text: string): string[] {
  return text.replace(/\r\n?/gu, '\n').split('\n')
}

/** A root-level row and everything before the first one (comments, blank lines). */
interface PatchRows {
  /** Lines before the first root-level row — kept verbatim. */
  preamble: readonly string[]
  /** One entry per root-level row, its indented continuation lines included. */
  rows: readonly (readonly string[])[]
}

/** Split a patch document into its root-level rows, keeping the preamble. */
function splitRows(text: string): PatchRows {
  const preamble: string[] = []
  const rows: string[][] = []
  let current: string[] | undefined
  for (const line of patchLines(text)) {
    if (/^- /u.test(line)) {
      current = [line]
      rows.push(current)
      continue
    }
    if (current === undefined) preamble.push(line)
    else current.push(line)
  }
  return { preamble, rows }
}

/** An entry id as written inside a row: `- id: value`, quoted or bare. */
const ROW_ID = /^(?:-\s+|-\s*)?id:\s*(?:(["'])(.*?)\1|(\S+))\s*(?:#.*)?$/u

/** The `- id:` value of a line, without its list marker or indentation. */
function idOfLine(line: string): string | undefined {
  const match = ROW_ID.exec(line.replace(/^[ \t]*/u, '').replace(/^-\s+/u, ''))
  if (match === null) return undefined
  const value = match[2] ?? match[3] ?? ''
  return value === '' ? undefined : value
}

/**
 * Whether a row is an `insert:` list — the shape that APPENDS entries.
 *
 * This is the shape that duplicates, and therefore the only one the migration
 * removes. A plain `- id: web` row does not create an entry: it overrides one,
 * and the kernel's configuration editor edits it IN PLACE to store the user's
 * choice. Removing such a row would silently reset that choice to the overlay's
 * default, which is the very loss this module exists to prevent.
 */
function isInsertRow(row: readonly string[]): boolean {
  return /^- insert:\s*(?:#.*)?$/u.test(row[0] ?? '')
}

/**
 * The entry ids a row defines.
 *
 * An `insert:` row carries its entries as indented `- id:` children (the shipped
 * overlay writes all seventeen plugins in ONE such block, so the unit of removal is
 * the block, not the line); any other row carries its own id in its first line.
 */
function rowEntryIds(row: readonly string[]): string[] {
  const ids: string[] = []
  for (const [index, line] of row.entries()) {
    const indentedChild = index > 0 && /^\s+-\s+/u.test(line)
    const rootLine = index === 0 && /^- /u.test(line)
    if (!indentedChild && !rootLine) continue
    const id = idOfLine(line)
    if (id !== undefined) ids.push(id)
  }
  return ids
}

/**
 * The entry ids the shipped overlay declares — the roster the migration attributes by.
 *
 * Derived from the overlay itself rather than kept as a list here: the overlay is
 * the thing that ships, and a copy of its ids in this module could only rot.
 *
 * @param overlayText - the shipped overlay's contents ('' when there is none).
 * @returns every id it declares, root-level rows and `insert:` children alike.
 */
export function overlayOwnedIds(overlayText: string): Set<string> {
  const owned = new Set<string>()
  if (overlayText.trim() === '') return owned
  for (const row of splitRows(overlayText).rows) {
    for (const id of rowEntryIds(row)) owned.add(id)
  }
  return owned
}

/**
 * The ids the shipped overlay declares INSIDE an `insert:` block.
 *
 * A subset of {@link overlayOwnedIds}, and the subset that answers the other
 * removal question. An id in the roster can still be a row the profile patch has
 * to keep — `web` and `deepseek-account` are override rows carrying the user's own
 * choice. An id in THIS set is a row the layer appends by name, on every line,
 * whether or not the kernel ships a row of its own — so a config-less copy of it
 * left in the profile patch is residue from the pre-layer overlay, not the user's
 * (the kernel's editor only ever writes a row with `config`, and deletes a row it
 * has emptied).
 *
 * Why the residue has to go rather than merely be tolerated: a non-insert row with
 * no target logs `patch: entry "<id>" not found` on every start, and the one
 * start where the target is missing by design is SAFE MODE — the layer is written
 * empty there, so the suite's own leftover is the only thing naming that id.
 *
 * @param overlayText - the shipped overlay's contents ('' when there is none).
 * @returns every id declared inside an `insert:` row.
 */
export function overlayInsertOwnedIds(overlayText: string): Set<string> {
  const inserted = new Set<string>()
  if (overlayText.trim() === '') return inserted
  for (const row of splitRows(overlayText).rows) {
    if (!isInsertRow(row)) continue
    for (const id of rowEntryIds(row)) inserted.add(id)
  }
  return inserted
}

/**
 * Whether an `insert:` block belongs to the suite.
 *
 * Two ways to qualify, and the second is not a convenience — it is what keeps the
 * migration working across a ROSTER SHRINK:
 *
 *   1. every id it defines is one the current overlay declares; or
 *   2. every id it defines is a `@dsh-app/` package, whatever the current roster
 *      says.
 *
 * Why (2) is load-bearing, measured on this repository's own history: `plugin-fff`
 * shipped in the suite and was removed (`3b2ce94`), and every profile whose patch
 * an earlier shell generated carries a block of SEVENTEEN ids including `fff`
 * (`git show 3b2ce94~1:plugins/dsh-app.patch.yml:153`, and the residue survives in
 * `scratch/backup-kernel-0.1.7-20260922/profiles-dsh-app/cordis.patch.yml`). With
 * rule (1) alone that block never qualifies again — the roster will never contain
 * `fff` — so it stays forever: seventeen live ids duplicated against the layer, the
 * block composing AFTER the layer and permanently masking it, and a dead `fff` row
 * warning on every start. The residue is exactly the population this migration
 * exists for.
 *
 * The scope is the suite's own (`@dsh-app/`, see `PLUGIN_SCOPE`), so a third-party
 * insert a user wrote names its own scope and is untouched. A hand-written
 * `@dsh-app/...` insert is indistinguishable from ours by construction, and it
 * would be pointing at a package this shell owns anyway.
 *
 * @param row - the block's lines.
 * @param names - the package name each id resolves to, by id.
 * @param ownedIds - the overlay's ids, from {@link overlayOwnedIds}.
 * @returns whether the block is the suite's.
 */
function isSuiteInsertBlock(row: readonly string[], names: ReadonlyMap<string, string>, ownedIds: ReadonlySet<string>): boolean {
  if (!isInsertRow(row)) return false
  const ids = rowEntryIds(row)
  if (ids.length === 0) return false
  if (ids.every((id) => ownedIds.has(id))) return true
  return ids.every((id) => {
    const name = names.get(id)
    return name !== undefined && name.startsWith(`${PLUGIN_SCOPE}/`)
  })
}

/**
 * Whether a non-insert row is residue the layer has since taken over.
 *
 * Three conditions, and each one answers "could this row be the user's own?":
 *
 *   1. it declares exactly ONE id, and that id is one the current overlay INSERTS
 *      (see {@link overlayInsertOwnedIds}) — so its only possible target is a row
 *      the layer appends by name, and removing this copy cannot remove a
 *      capability or reset a value;
 *   2. it carries no `config:` and no key besides `id`/`name`/`disabled` — the
 *      kernel's configuration editor writes a `config` with every setting it
 *      stores, and deletes a row it has emptied, so a row with no `config` holds
 *      no value of the user's;
 *   3. the state it asks for is the state the layer already gives that id
 *      (`disabled` absent or exactly `false`) — a row saying `disabled: true` is
 *      somebody's decision and is kept, even though it then costs one
 *      skipped-patch line in safe mode.
 *
 * The shape this exists for, measured on the real profile: the pre-layer overlay
 * carried `- id: ui-schedule` + `disabled: false` to flip a row the kernel then
 * shipped disabled. 0.2.0's web bundle ships no such row, the overlay now inserts
 * it, and the leftover copy has nothing left to override — every start logged
 * `patch: entry "ui-schedule" not found`, and in SAFE MODE that line is the only
 * thing naming that id, because the layer is written empty there.
 *
 * @param row - the row's lines.
 * @param ids - the ids the row declares, from {@link rowEntryIds}.
 * @param insertOwnedIds - the overlay's inserted ids.
 * @returns whether the row is spent residue.
 */
function isSpentFlipRow(row: readonly string[], ids: readonly string[], insertOwnedIds: ReadonlySet<string>): boolean {
  if (isInsertRow(row)) return false
  const id = ids.length === 1 ? ids[0] : undefined
  if (id === undefined || !insertOwnedIds.has(id)) return false
  const keys = rowOwnKeys(row)
  for (const key of keys.keys()) {
    if (key !== 'id' && key !== 'name' && key !== 'disabled') return false
  }
  const disabled = keys.get('disabled')
  return disabled === undefined || /^(?:false|'false'|"false")$/u.test(disabled)
}

/**
 * The package name each `- id:` in a row declares, by id.
 *
 * An entry's `name:` is a sibling of its `id:` at the same content column, so this
 * pairs them the same way {@link rowEntryIds} reads ids — a nested `config.name`
 * (a plugin's own setting) sits deeper and is not an entry's name.
 *
 * @param row - the row's lines.
 * @returns id → package name, for the entries that declare one.
 */
/**
 * The keys a patch entry's OWN row carries, by name, with their raw values.
 *
 * A key belongs to the row when it sits at the entry's content column — the same
 * column rule {@link rowEntryNames} applies to `name:`: in
 *
 *     - id: ui-schedule
 *       disabled: false
 *
 * `id` and `disabled` share a column, while a nested `config:` subtree sits
 * deeper and is not read as a key of the row.
 *
 * @param row - the row's lines.
 * @returns the row's own keys, in file order.
 */
function rowOwnKeys(row: readonly string[]): Map<string, string> {
  const keys = new Map<string, string>()
  let keyIndent = -1
  for (const line of row) {
    const content = line.replace(/^[ \t]*/u, '').replace(/^-\s+/u, '')
    if (content === '' || content.startsWith('#')) continue
    const marker = /^(-\s+)/u.test(line.replace(/^[ \t]*/u, '')) ? 2 : 0
    const indent = (line.match(/^[ \t]*/u)?.[0].length ?? 0) + marker
    if (keyIndent < 0) keyIndent = indent
    if (indent !== keyIndent) continue
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(content)
    if (match !== null) keys.set(match[1] ?? '', (match[2] ?? '').trim())
  }
  return keys
}

function rowEntryNames(row: readonly string[]): Map<string, string> {
  const names = new Map<string, string>()
  let pendingId: string | undefined
  let pendingIndent = -1
  for (const line of row) {
    // Every line is examined: an entry's `name:` carries NO list marker (`- id: x`
    // then `  name: y`), so a guard that skipped non-list lines would never see one
    // — which is exactly how the roster-shrink fallback first failed to fire.
    const content = line.replace(/^[ \t]*/u, '').replace(/^-\s+/u, '')
    if (content === '' || content.startsWith('#')) continue
    const id = idOfLine(line)
    if (id !== undefined) {
      pendingId = id
      pendingIndent = content.indexOf('id:')
      continue
    }
    if (pendingId === undefined) continue
    const nameMatch = /^name:\s*(?:(["'])(.*?)\1|(\S+))\s*(?:#.*)?$/u.exec(content)
    // A `name:` at the SAME content column as the entry's `id:` is the entry's
    // package; a deeper one is a plugin's own config value.
    if (nameMatch === null || content.indexOf('name:') !== pendingIndent) continue
    const value = nameMatch[2] ?? nameMatch[3] ?? ''
    if (value !== '') names.set(pendingId, value)
    pendingId = undefined
  }
  return names
}

/**
 * The rows a document's section carries that cannot load, as a last pass.
 *
 * Why this runs at all: a build with an older judgement commented out rows it
 * wrongly judged (the pre-0.1.7 reader took config VALUES for package names, so a
 * provider row carrying a model list was commented out and stayed that way through
 * every later start). Nothing else removes those comments any more, so the
 * migration is their last chance to come back.
 *
 * Why it is scoped rather than run over the whole document: a setting the KERNEL
 * wrote is a row naming a package the profile need not install — `ui-theme` and
 * `agent-preset-registry` are composed from the kernel's own closure and are not
 * profile dependencies at all. Judging those rows as if they were plugin rows would
 * comment the user's settings out, which is the loss this whole change exists to
 * prevent. Measured on the real profile: run with the repository's dev closure
 * instead of the shipped runtime's, the whole-document pass named
 * `dsh-agent-preset-registry` and `dsh-client-ui-settings-account` for removal —
 * `agent-preset-registry` being the row that records the selected agent preset.
 *
 * So the pass touches ONLY the block the migration is already removing: the
 * `insert:` rows the shell itself wrote. Everything else is the kernel's or the
 * user's, and is left exactly as it is.
 *
 * @param text - the document, after the overlay's insert blocks were removed.
 * @param ownedIds - the overlay's ids (see {@link overlayOwnedIds}).
 * @returns the ids named by any of the removed blocks' comments, for the log.
 */
export function rowsToRestore(text: string, ownedIds: ReadonlySet<string>): readonly string[] {
  const restored: string[] = []
  const lines = patchLines(text)
  let index = 0
  while (index < lines.length) {
    if (!lines[index].startsWith(NOT_LOADED_MARKER)) {
      index += 1
      continue
    }
    const end = blockEnd(lines, index)
    const candidate = uncommentBlock(lines.slice(index + 1, end))
    const ids = candidate.flatMap((line) => { const id = idOfLine(line); return id === undefined ? [] : [id] })
    // Only a block the SHELL's own older judgement killed — one whose ids the
    // overlay declares — AND one that still reads as rows. A block carrying prose
    // would become invalid YAML if un-commented (see rowShaped).
    if (ids.length > 0 && ids.every((id) => ownedIds.has(id)) && rowShaped(candidate)) restored.push(...ids)
    index = end
  }
  return restored
}

/**
 * Where a commented block ends, starting at its marker.
 *
 * A block is the run of lines that follows its marker, and BLANK LINES ARE PART OF
 * IT: the old writer left a row's interior blank lines blank while commenting the
 * row's other lines (`brand-suite.ts`'s `commentOut`: a blank line goes out blank),
 * so a row with a blank line inside it is split by a naive "stop at the first
 * non-`#`" scan. Measured: the two halves were then restored SEPARATELY — the row's
 * `id:` and `config:` came back while its values stayed commented — and the
 * resulting `config: null` is applied by patch semantics as a whole-object
 * replacement, silently emptying the user's provider pair.
 *
 * It ends at the first line that is neither blank nor a comment, or at the next
 * marker, or at a section marker of the shell's own generated format.
 */
function blockEnd(lines: readonly string[], markerAt: number): number {
  let end = markerAt + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.startsWith(NOT_LOADED_MARKER) || PATCH_SECTION_LINE.test(line)) break
    if (line.trim() !== '' && !line.startsWith('#')) break
    end += 1
  }
  return end
}

/** Strip one comment marker from each line of a commented block. */
function uncommentBlock(block: readonly string[]): string[] {
  return block.map((line) => (line.startsWith('# ') ? line.slice(2) : line.startsWith('#') ? line.slice(1) : line))
}

/** A section marker of the shell's own generated patch format. */
const PATCH_SECTION_LINE = /^# @@dsh-app-rows:/u

/**
 * Whether an un-commented block still reads as loader rows.
 *
 * Marking a dead row prefixes `# ` to each of its lines, and that encoding is
 * lossy one way: a comment the USER had at column zero inside the row
 * (`# keep this first`) was left alone while the row was commented, and looks
 * exactly like commented code afterwards. Stripping the marker from such a block
 * would emit bare prose where the loader expects YAML — a boot failure in place of
 * the silent omission this restore undoes.
 *
 * Measured while adding this guard: a block carrying the three row lines plus
 * `# 这是我自己写的一行说明` un-commented into invalid YAML
 * (`Unexpected scalar at node end`), because the prose line lands at column zero
 * with no list marker. So a candidate is accepted only while every line is still
 * a row (`- ` at column zero), a continuation of one (indented), or blank.
 *
 * @param candidate - the block's lines, with the comment markers already stripped.
 * @returns whether the block can be written back as loader rows.
 */
function rowShaped(candidate: readonly string[]): boolean {
  return candidate.every((line) => line.trim() === '' || /^\s/u.test(line) || /^- /u.test(line))
}

/** The marker a build with an older judgement wrote above a row it commented out. */
const NOT_LOADED_MARKER = '# [dsh-app] NOT LOADED:'

/**
 * Remove the comments the shell's own older judgement left above a set of rows.
 *
 * Pairs each marker line with the block it explains and drops the marker, so the
 * rows become live again. Only blocks named in `ids` are touched — see
 * {@link rowsToRestore} for why the scope is what it is.
 *
 * @param text - the document.
 * @param ids - the entry ids whose blocks to un-comment.
 * @returns the document with those blocks live again; unchanged when there is none.
 */
export function uncommentRows(text: string, ids: readonly string[]): string {
  if (ids.length === 0) return text
  const wanted = new Set(ids)
  const lines = patchLines(text)
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].startsWith(NOT_LOADED_MARKER)) {
      out.push(lines[index])
      index += 1
      continue
    }
    const end = blockEnd(lines, index)
    const block = lines.slice(index + 1, end)
    const candidate = uncommentBlock(block)
    const blockIds = candidate.flatMap((line) => { const id = idOfLine(line); return id === undefined ? [] : [id] })
    // Same two conditions rowsToRestore applies, so the two never disagree about
    // which block is the shell's own: only those ids, and only while the block
    // still reads as rows (a block carrying prose would become invalid YAML).
    if (blockIds.length > 0 && blockIds.every((id) => wanted.has(id)) && rowShaped(candidate)) out.push(...candidate)
    else out.push(lines[index], ...block)
    index = end
  }
  return out.join('\n')
}

/**
 * Anchor a document that has no rows left, keeping its comments.
 *
 * Comments are user content too, and the kernel rejects a patch that does not
 * parse as a top-level sequence — so the remainder is kept and the canonical empty
 * array is appended to it. A remainder that is blank collapses to the bare `[]`.
 * (The same rule `plugins/plugin-market/src/patchfile.ts` applies when its own
 * managed block is the last thing in the file.)
 */
function anchored(text: string): string {
  const trimmed = text.replace(/\n+$/u, '')
  if (trimmed.trim() === '') return '[]\n'
  return `${trimmed}\n[]\n`
}

/**
 * Remove the overlay's own `insert:` blocks from a profile patch — and the spent
 * flip rows whose target the layer now inserts — keeping everything else.
 *
 * A block goes only when it is an `insert:` row AND every id it defines is one the
 * overlay declares. A block this cannot attribute (a hand-written third-party
 * insert, a mixed block) is kept: the price of keeping is a duplicate entry, which
 * the loader collapses to the last one; the price of removing wrongly is a user's
 * plugin disappearing, which nothing recovers.
 *
 * A row that is NOT an insert goes only under {@link isSpentFlipRow}: one id, one
 * the overlay inserts, no `config`, and a `disabled` state the layer already
 * provides. Everything else is kept verbatim, including every override row that
 * carries a value the user may have chosen.
 *
 * A line that is neither a list item nor indented inside such a row is NOT part
 * of it — it is a same-indent sibling key (`- insert:` … `  extra: 1`), which YAML
 * reads as a second field of the same patch entry. The shell never writes one (its
 * own blocks carry only indented children), but a hand-edited file can, and taking
 * it with the block would silently drop a key the user wrote. Such a row is kept
 * whole instead — the safe direction, per the attribution rule above.
 *
 * TRAILING comments are the exception: the shipped overlay explains each of its
 * override rows with a column-0 comment block BETWEEN an insert block and the next
 * row, so those lines land in the insert row's span. They are not removed with it —
 * a comment carries no row, and losing the file's own explanations on every start
 * would make the document unreadable for whoever inspects it next.
 *
 * @param patchText - the profile patch's contents.
 * @param ownedIds - the overlay's ids, from {@link overlayOwnedIds}.
 * @param insertOwnedIds - the overlay's inserted ids, from
 *   {@link overlayInsertOwnedIds}; required rather than defaulted, so a caller that
 *   forgets it cannot silently disable the flip-row rule.
 * @returns the text to write, and the ids that were removed.
 */
export function stripSuiteRows(patchText: string, ownedIds: ReadonlySet<string>, insertOwnedIds: ReadonlySet<string>): { text: string, removed: string[] } {
  const { preamble, rows } = splitRows(patchText)
  const removed: string[] = []
  const kept: string[] = []
  /**
   * A line's content column, counting a `- ` sequence marker as two columns — the
   * same rule `brand-suite.ts`'s `contentIndent` applies, and the reason this is
   * needed at all: in
   *
   *     - insert:
   *         - id: brand
   *       extra: 1
   *
   * `insert:` and `extra` are the SAME patch entry's two fields (both at column 2
   * once the marker is counted), while the list child sits at column 6. Counting
   * only leading spaces would call `extra` a child of the list.
   */
  const contentIndent = (line: string): number => {
    const match = /^([ \t]*)(-\s+)?(.*)$/u.exec(line)
    if (match === null || (match[3] ?? '').trim() === '') return -1
    return (match[1] ?? '').length + (match[2] === undefined ? 0 : 2)
  }
  const isComment = (line: string): boolean => {
    const content = line.trim()
    return content === '' || content.startsWith('#')
  }
  for (const row of rows) {
    const ids = rowEntryIds(row)
    const keyIndent = contentIndent(row[0] ?? '')
    // A non-comment line at the block's own content column is a sibling FIELD of the
    // same patch entry, not part of the list. Stripping the block would then either
    // drop that field or leave it dangling (invalid YAML), so the row is kept whole:
    // the cost is a duplicate entry, which the loader collapses; the cost of the
    // other direction is a key the user wrote.
    const sibling = row.slice(1).some((line) => !isComment(line) && contentIndent(line) <= keyIndent)
    // A plain row's own fields sit AT its key column (only an `insert:` list puts
    // its children deeper), so the disqualifying shape here is a line SHALLOWER than
    // the row's keys — a document-level key a hand-edited file can carry.
    const outdented = row.slice(1).some((line) => !isComment(line) && contentIndent(line) < keyIndent)
    const attributable = !sibling && isSuiteInsertBlock(row, rowEntryNames(row), ownedIds)
    if (attributable) {
      removed.push(...ids)
      // The comments the block's span swallowed stay: the shipped overlay explains
      // each of its override rows with a column-0 comment block placed between an
      // insert block and the next row, so those lines land in this row's span. They
      // carry no row, and dropping them would strip the file's own explanations on
      // every start. Siblings cannot reach here — they disqualify the strip above.
      kept.push(...row.slice(1).filter(isComment))
      continue
    }
    if (!outdented && isSpentFlipRow(row, ids, insertOwnedIds)) {
      removed.push(...ids)
      kept.push(...row.slice(1).filter(isComment))
      continue
    }
    kept.push(...row)
  }
  if (removed.length === 0) return { text: patchText, removed }
  const body = [...preamble, ...kept].join('\n')
  const hasRow = body.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  return { text: hasRow ? `${body.replace(/\n+$/u, '')}\n` : anchored(body), removed }
}

/**
 * Give the profile a manifest that names the suite's layer, keeping every other
 * field byte-identical when nothing changes.
 *
 * The entry is APPENDED: bundle layers compose in list order and the last one
 * wins per row, so the suite's overrides for `web` and `deepseek-account` only
 * take effect if its layer is composed after the base bundles.
 *
 * @param profileDir - the profile directory.
 * @param report - where a diagnostic line goes.
 * @returns whether the manifest was written.
 */
async function ensureLayerBundle(profileDir: string, report: ((line: string) => void) | undefined): Promise<boolean> {
  const file = path.join(profileDir, 'package.json')
  const raw = await readText(file)
  if (raw === undefined) throw new Error(`${file} is missing; the profile has no manifest to name the layer in`)
  const manifest = JSON.parse(raw) as { dsh?: { profile?: { bundles?: unknown } } }
  const previous = manifest.dsh?.profile?.bundles
  const bundles = Array.isArray(previous) ? [...previous] : []
  if (bundles.includes(SUITE_LAYER_PACKAGE)) return false
  bundles.push(SUITE_LAYER_PACKAGE)
  const next = {
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
  }
  const text = `${JSON.stringify(next, undefined, 2)}\n`
  if (text === raw) return false
  await writePatchAtomically(file, text)
  report?.(`[suite-layer] the profile's bundle list now names ${SUITE_LAYER_PACKAGE}`)
  return true
}

/**
 * Write the layer package the profile's manifest points at.
 *
 * Inside the profile's own `node_modules`, because that is where the kernel
 * resolves a bundle from (`resolveBundleDir` tries the installation anchor, then
 * the profile) — and re-written whenever its content differs, because that
 * directory belongs to the package manager and a `pnpm install` may prune an entry
 * it does not know (the same measured behaviour that makes `linkSuitePlugins`
 * re-link on every start).
 *
 * @param layerDir - the layer package directory.
 * @param overlay - the rows to carry ('' writes an empty layer, which is what safe
 *   mode wants: the bundle stays declared so the manifest does not churn, and
 *   contributes no rows).
 * @param report - where a diagnostic line goes.
 * @returns whether anything was written.
 */
async function writeLayerPackage(layerDir: string, overlay: string, report: ((line: string) => void) | undefined): Promise<boolean> {
  const patchFile = path.join(layerDir, LAYER_PATCH_FILENAME)
  const manifestFile = path.join(layerDir, 'package.json')
  // A patch document must parse as a top-level sequence; `[]` is the kernel's own
  // shape for "no patch".
  const body = overlay.trim() === '' ? '[]\n' : `${overlay.replace(/\n+$/u, '')}\n`
  const manifest = `${JSON.stringify({
    name: SUITE_LAYER_PACKAGE,
    version: '1.0.0',
    private: true,
    dsh: { bundle: { patch: `./${LAYER_PATCH_FILENAME}` } },
  }, undefined, 2)}\n`
  const patchChanged = (await readText(patchFile)) !== body
  const manifestChanged = (await readText(manifestFile)) !== manifest
  if (!patchChanged && !manifestChanged) return false
  await fs.mkdir(layerDir, { recursive: true })
  if (manifestChanged) await writePatchAtomically(manifestFile, manifest)
  if (patchChanged) await writePatchAtomically(patchFile, body)
  report?.(`[suite-layer] wrote the suite layer at ${layerDir}`)
  return true
}

/**
 * Move the suite's rows out of the profile patch and into a layer the profile owns.
 *
 * The order of the three steps is load-bearing, and its failure direction is
 * deliberate:
 *
 *   1. the layer package is written FIRST, so a crash before the manifest names it
 *      costs nothing (an unreferenced package in `node_modules` is invisible);
 *   2. the profile patch is then migrated — the overlay's own `insert:` blocks are
 *      removed, and a pre-migration copy is kept beside it;
 *   3. only then is the bundle entry appended to the manifest.
 *
 * A crash between (2) and (3) leaves the suite's rows ABSENT (the layer exists but
 * nothing names it) — a vanilla UI, repaired by the next start. The reverse order
 * would leave both sources in play at once, and where they disagree the profile
 * patch wins (`readProfilePatches` composes it after every bundle layer), so a
 * setting the user just changed would be read from the stale copy with nothing
 * reporting it. Absent and recoverable beats present and silently wrong.
 *
 * Idempotent throughout: each step compares content before writing, and the
 * migration reports nothing to remove once it has run.
 *
 * @param options.profileDir - the profile the host will boot.
 * @param options.overlay - the shipped overlay's rows ('' for safe mode).
 * @param options.report - where diagnostic lines go.
 * @returns what happened, for the caller's log line. Never throws.
 */
export async function installSuiteLayer(options: {
  profileDir: string
  overlay: string
  report?: (line: string) => void
}): Promise<SuiteLayerOutcome> {
  const { profileDir, overlay, report } = options
  const layerDir = path.join(profileDir, 'node_modules', PLUGIN_SCOPE, SUITE_LAYER_DIRNAME)
  const patchFile = path.join(profileDir, PROFILE_PATCH_FILENAME)
  let wrote = false
  try {
    wrote = await writeLayerPackage(layerDir, overlay, report)
  } catch (error) {
    return { status: 'failed', removed: [], layerDir, detail: `the layer package could not be written: ${(error as Error).message}` }
  }
  // --- step 2: the migration -------------------------------------------------
  const removed: string[] = []
  let backup: string | undefined
  try {
    const existing = await readText(patchFile)
    if (existing !== undefined) {
      // The roster comes from the SHIPPED overlay, never from `overlay` — that
      // argument is '' in safe mode and empty layers are exactly what safe mode
      // wants. Deriving the roster from it would skip the strip entirely, leaving
      // the profile's own suite rows active while the manifest also names the
      // (empty) layer: measured, safe mode would then boot WITH the suite, which is
      // the one thing it must not do. The migration is the same work on all three
      // paths (safe mode, a failed plugin link, a normal start), so it reads the
      // roster it needs and only the layer's CONTENT follows `overlay`.
      const shipped = await readShippedOverlay()
      const owned = overlayOwnedIds(shipped)
      const insertOwned = overlayInsertOwnedIds(shipped)
      const stripped = owned.size === 0 ? { text: existing, removed: [] } : stripSuiteRows(existing, owned, insertOwned)
      // One last look for rows an OLDER build commented out: nothing else undoes
      // those comments any more, so this is their only chance to come back.
      //
      // It is deliberately NOT `filterUnresolvableRows` over the document. That
      // function's job was to keep unloadable rows out of a composition the shell
      // was BUILDING; now the kernel composes it, and judging a row the kernel
      // wrote would comment the user's own settings out. Measured on the real
      // profile with the repository's dev closure instead of the shipped runtime's:
      // the whole-document pass named `dsh-agent-preset-registry` — the row holding
      // the selected agent preset — and `dsh-client-ui-settings-account` for
      // removal. Those rows name packages the profile need not install, which is
      // exactly why they resolved only through the right closure and why a wrong
      // one silently ate the settings.
      const restored = rowsToRestore(stripped.text, owned)
      const next = restored.length === 0 ? stripped.text : uncommentRows(stripped.text, restored)
      if (next !== existing) {
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
        backup = `${patchFile}.pre-suite-layer-${stamp}`
        await fs.writeFile(backup, existing, 'utf8')
        await writePatchAtomically(patchFile, next)
        removed.push(...stripped.removed)
        for (const id of restored) {
          report?.(`[suite-layer] a row a build with an older judgement commented out is loadable again and was restored: "${id}"`)
        }
        report?.(`[suite-layer] the profile patch was migrated: ${String(stripped.removed.length)} overlay insert(s) removed, the previous document kept at ${backup}`)
      }
    }
  } catch (error) {
    return { status: 'failed', removed, layerDir, detail: `the profile patch could not be migrated: ${(error as Error).message}` }
  }

  // --- step 3: the manifest --------------------------------------------------
  try {
    if (await ensureLayerBundle(profileDir, report)) wrote = true
  } catch (error) {
    return { status: 'failed', removed, layerDir, detail: `the profile manifest could not name the layer: ${(error as Error).message}` }
  }
  if (removed.length === 0 && backup === undefined) {
    return { status: wrote ? 'installed' : 'already', removed, layerDir }
  }
  return { status: 'installed', removed, layerDir, ...(backup === undefined ? {} : { backup }) }
}
