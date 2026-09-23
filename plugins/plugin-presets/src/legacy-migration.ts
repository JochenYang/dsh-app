/**
 * Migrate a directory-shaped agent preset (the pre-0.1.7 `.agent-presets/<id>/`
 * layout) into the declaration the 0.1.7 registry reads: one
 * `@deepseek-ai/dsh-agent-preset` row whose `config.plugins` is the preset's own
 * composition.
 *
 * ## Why the composition is INDENTED, not parsed and re-serialized
 *
 * The rows carry `!!js` expressions (`disabled: !!js process.platform === 'win32'`,
 * and the skill root's `fileURLToPath(new URL('skills/', baseUrl))`). Those are
 * EVALUATED BY THE LOADER, not by us, so they have to survive verbatim. Two ways
 * to move them, and only one is safe:
 *
 *   - `parse()` then `stringify()` LOSES the tag. Measured with yaml 2.9.1: the
 *     document parses (with the loader's own `customTags` entry) into
 *     `disabled: "process.platform === 'win32'"`, and serializing writes that
 *     back as a plain STRING — which is truthy, so `tool-bash` would be disabled
 *     on every platform instead of only Windows. A silent behaviour change in
 *     the user's own composition.
 *   - Indenting the original TEXT and embedding it under `plugins:` keeps every
 *     byte. Verified: the re-parsed rows are deep-equal to the originals, `!!js`
 *     included, at any indent width.
 *
 * So this module never re-serializes the user's composition. It reads the text,
 * indents it, and splices it in.
 *
 * ## What it does NOT do
 *
 * Nothing is deleted or moved. `D6`'s decision was to leave the user's files
 * exactly where they are (`skills/`, `evolution/` and their internal references),
 * which is why the one expression that resolves a path is REWRITTEN to an
 * absolute one rather than left to `baseUrl`: after migration the row is declared
 * in the PROFILE patch, so `baseUrl` is the profile directory, not the preset's.
 *
 * @module @dsh-app/plugin-presets/legacy-migration
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

/** The loader's own tag handling, copied from the kernel so expressions survive. */
const CUSTOM_TAGS = [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string): string => value }]

/** A row id the migration may not collide with. */
const PRESET_ROW_PREFIX = 'preset-'

/** One legacy preset found on disk. */
export interface LegacyPreset {
  /** Directory name under the preset root. */
  readonly id: string
  /** Absolute path of the preset directory. */
  readonly dir: string
  /** Display name from `preset.yml`, or the id. */
  readonly name: string
  /** Description from `preset.yml`, when it has one. */
  readonly description?: string
  /** The composition text, verbatim. */
  readonly composition: string
  /** Number of top-level rows in the composition (0 when it does not parse). */
  readonly rows: number
  /** Why this preset cannot be migrated; absent when it can. */
  readonly problem?: string
}

/**
 * Read the display fields of a legacy `preset.yml`.
 *
 * Best-effort by design: a missing or malformed file degrades to the directory
 * name rather than failing the migration, because the composition is what
 * actually matters and the id is already a usable title.
 *
 * @param dir - absolute preset directory.
 * @param fallbackId - the directory name, used when the file names nothing.
 * @returns the display fields.
 */
function readPresetYml(dir: string, fallbackId: string): { name: string, description?: string } {
  let raw: string
  try {
    raw = readFileSync(join(dir, 'preset.yml'), 'utf8')
  } catch {
    return { name: fallbackId }
  }
  let parsed: unknown
  try {
    parsed = parse(raw, { customTags: CUSTOM_TAGS })
  } catch {
    return { name: fallbackId }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { name: fallbackId }
  const { name, description } = parsed as { name?: unknown, description?: unknown }
  return {
    name: typeof name === 'string' && name.trim() !== '' ? name : fallbackId,
    ...typeof description === 'string' && description.trim() !== '' ? { description } : {},
  }
}

/**
 * Rewrite the one path expression a directory-shaped preset relies on.
 *
 * The legacy layout resolves `skills/` relative to the preset's own directory
 * because the 0.1.6 mount rewrote the row context's `baseUrl` to the
 * composition's directory. After migration the declaration lives in the PROFILE
 * patch, so `baseUrl` is the profile directory and the same expression would
 * point at `<profile>/skills/` — a directory that does not exist.
 *
 * The replacement is deliberately literal and narrow: it matches the exact
 * `new URL('<relative>', baseUrl)` call and substitutes an absolute path, so a
 * composition that uses `baseUrl` for anything else keeps working as it did.
 * A row that does not mention `baseUrl` is returned unchanged.
 *
 * @param composition - the composition text.
 * @param presetDir - absolute preset directory the relative paths belong to.
 * @returns the rewritten text and the substitutions that were made.
 */
export function rebasePresetPaths(composition: string, presetDir: string): { text: string, rewritten: readonly string[] } {
  const rewritten: string[] = []
  // `new URL('skills/', baseUrl)` → an absolute file URL.
  //
  // The replacement is spliced into a JavaScript EXPRESSION, and that expression
  // is carried by a YAML `!!js` scalar which the user may have written with
  // either quote style. So the literal must survive BOTH readers:
  //   - JavaScript: a single-quoted string, with backslashes doubled (a Windows
  //     path would otherwise start an escape) and single quotes escaped.
  //   - YAML: no double quote, because inside a `!!js "…"` scalar an embedded `"`
  //     ends the scalar and the document stops parsing — measured, and the reason
  //     JSON.stringify is wrong here.
  //
  // The URL comes from `pathToFileURL`, not string concatenation: joining
  // 'file:///' with an already-rooted path yields FOUR slashes on POSIX
  // (`file:////preset/skills/`), which is a different authority and an invalid
  // one — measured while building this.
  const text = composition.replace(
    /new URL\(\s*(['"])([^'"]*)\1\s*,\s*baseUrl\s*\)/gu,
    (match: string, _quote: string, relative: string) => {
      // Only a plain relative path is rebased; an absolute one, or anything
      // carrying a scheme, is left alone (it never depended on baseUrl).
      if (isAbsolute(relative) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(relative)) return match
      rewritten.push(relative)
      // A trailing separator keeps the URL shaped like the relative path it
      // replaces (`'skills/'`), which is what a directory-joining consumer reads.
      const url = pathToFileURL(join(presetDir, relative) + sep).href
      const literal = `'${url.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`
      return `new URL(${literal})`
    },
  )
  return { text, rewritten }
}

/**
 * Validate one composition before it is embedded.
 *
 * The embed is textual, so the only thing that can go wrong here is the
 * composition itself: it must be a non-empty top-level LIST of plugin rows.
 * That is checked with the loader's tag handling so `!!js` rows are judged as
 * the loader would judge them, not as plain strings.
 *
 * @param composition - the composition text.
 * @returns the row count, or the problem that stops the migration.
 */
function compositionProblem(composition: string): { rows: number } | { problem: string } {
  let parsed: unknown
  try {
    parsed = parse(composition, { customTags: CUSTOM_TAGS })
  } catch (error) {
    return { problem: `agent.cordis.yml does not parse: ${(error as Error).message}` }
  }
  if (!Array.isArray(parsed)) return { problem: 'agent.cordis.yml is not a top-level list of plugin rows' }
  if (parsed.length === 0) return { problem: 'agent.cordis.yml declares no rows' }
  for (const [index, row] of parsed.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return { problem: `row ${String(index + 1)} is not a plugin row` }
    }
    if (typeof (row as { name?: unknown }).name !== 'string') {
      // A row may legitimately carry only an `id` when it MODIFIES an inherited
      // row, so an id-only row is fine; what is not fine is a row with neither.
      if (typeof (row as { id?: unknown }).id !== 'string') {
        return { problem: `row ${String(index + 1)} names neither a plugin nor a row id` }
      }
    }
  }
  return { rows: parsed.length }
}

/**
 * Find the legacy presets under a preset root.
 *
 * A directory is a legacy preset when it holds an `agent.cordis.yml`; that file
 * is what the 0.1.6 loader mounted, and it is the one thing a migration cannot
 * synthesize. Directories without it are skipped silently — the root also holds
 * whatever else the user put there.
 *
 * @param root - absolute preset root (`<dshHome>/.agent-presets`).
 * @returns one entry per directory, in name order.
 */
export function findLegacyPresets(root: string): readonly LegacyPreset[] {
  let names: string[]
  try {
    names = readdirSync(root).sort()
  } catch {
    return []
  }
  const found: LegacyPreset[] = []
  for (const id of names) {
    if (id.startsWith('.')) continue
    const dir = join(root, id)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    let composition: string
    try {
      composition = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    } catch {
      continue // not a legacy preset directory
    }
    const display = readPresetYml(dir, id)
    const verdict = compositionProblem(composition)
    const base = { id, dir, name: display.name, ...display.description === undefined ? {} : { description: display.description } }
    if ('problem' in verdict) {
      found.push({ ...base, composition, rows: 0, problem: verdict.problem })
      continue
    }
    found.push({ ...base, composition, rows: verdict.rows })
  }
  return found
}

/** The result of rendering one preset into patch rows. */
export interface RenderedPreset {
  /** The row id used in the patch (`preset-<id>`). */
  readonly rowId: string
  /** The YAML text to splice, already indented for its slot. */
  readonly text: string
  /** Relative paths rebased to absolute ones. */
  readonly rebased: readonly string[]
}

/**
 * Render one legacy preset as an `insert` row.
 *
 * The composition is embedded by INDENTING ITS TEXT (see the module header):
 * re-serializing would drop the `!!js` tags and silently change behaviour.
 *
 * @param preset - a preset from {@link findLegacyPresets} with no `problem`.
 * @param indent - spaces to prefix every non-blank line with, so the block lands
 *   at the right depth in the destination file.
 * @returns the row id and the YAML text.
 */
export function renderPresetRow(preset: LegacyPreset, indent: number): RenderedPreset {
  const rowId = `${PRESET_ROW_PREFIX}${preset.id}`
  const { text: composition, rewritten } = rebasePresetPaths(preset.composition, preset.dir)
  const pad = ' '.repeat(indent)
  const header = [
    `${pad}- insert:`,
    `${pad}    - id: ${rowId}`,
    `${pad}      name: '@deepseek-ai/dsh-agent-preset'`,
    `${pad}      config:`,
    `${pad}        id: ${preset.id}`,
    // The registration row's `config.name` is the preset's DISPLAY name (the
    // package's field table: id / plugins / name / description / order). Without
    // it the chooser falls back to the row id, which is how a migrated preset
    // lost the name its own `preset.yml` carried. Omitted when it would only
    // repeat the id, since unset is the documented default.
    ...preset.name === preset.id ? [] : [`${pad}        name: ${JSON.stringify(preset.name)}`],
    ...preset.description === undefined ? [] : [`${pad}        description: ${JSON.stringify(preset.description)}`],
    `${pad}        plugins:`,
  ]
  // Every composition line shifts by the depth of the `plugins:` value, and
  // blank lines stay blank (indenting them would leave trailing whitespace).
  const body = composition.replace(/\n$/u, '').split('\n').map((line) => {
    return line.trim() === '' ? '' : `${pad}          ${line}`
  })
  return { rowId, text: `${[...header, ...body].join('\n')}\n`, rebased: rewritten }
}

/**
 * Every row id a patch document declares, including inside `insert:` blocks and
 * `group: true` bodies.
 *
 * Parsed rather than searched for with a substring: a comment or a config value
 * that happens to read `id: preset-rsi-dev` would make a text search believe the
 * migration had already run, and the preset would silently never be declared.
 *
 * @param patchText - the patch file's contents.
 * @returns the declared ids, or undefined when the document does not parse.
 */
export function declaredRowIds(patchText: string): ReadonlySet<string> | undefined {
  let parsed: unknown
  try {
    parsed = parse(patchText, { customTags: CUSTOM_TAGS })
  } catch {
    return undefined
  }
  // An empty or comment-only file parses to null. That is an EMPTY patch, not a
  // broken one — treating it as broken would refuse to create the layer at all.
  if (parsed === null || parsed === undefined) return new Set()
  if (!Array.isArray(parsed)) return undefined
  const ids = new Set<string>()
  const walk = (rows: readonly unknown[]): void => {
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
      const { id, insert, config, group } = row as { id?: unknown, insert?: unknown, config?: unknown, group?: unknown }
      if (typeof id === 'string' && id !== '') ids.add(id)
      if (Array.isArray(insert)) walk(insert)
      if (group === true && Array.isArray(config)) walk(config)
    }
  }
  walk(parsed)
  return ids
}

/** A file-name-safe local timestamp, for the pre-write copy's name. */
function stamp(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${String(at.getFullYear())}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

/** What one migration pass did. */
export interface MigrationOutcome {
  /** Row ids that were appended. */
  readonly added: readonly string[]
  /** Presets left alone, with the reason. */
  readonly skipped: readonly { readonly id: string, readonly reason: string }[]
  /** Absolute path of the pre-write copy, when the patch already existed. */
  readonly backup?: string
}

/**
 * Declare every legacy preset that is not declared yet, by APPENDING to the home
 * patch layer.
 *
 * Why the home layer and not the profile patch: a preset is the user's own
 * content, and the profile patch's own header says so — section 1 (the suite
 * rows) and section 3 (the home copy) are rewritten on every start, and "rows
 * written by you belong" in `$DSH_HOME/cordis.patch.yml`. Appending there also
 * means the preset applies to every profile of the install, and that this
 * module never races the shell, which owns the profile patch.
 *
 * Idempotent by row id: a second pass over an already-migrated install appends
 * nothing. When the existing patch does not PARSE, nothing is written at all —
 * a document this module cannot read is one it must not rewrite.
 *
 * @param options - the legacy root, the home patch path, and the clock.
 * @returns what was added, what was skipped, and where the copy went.
 */
export function migrateLegacyPresets(options: {
  readonly presetRoot: string
  readonly patchPath: string
  readonly now?: Date
}): MigrationOutcome {
  const presets = findLegacyPresets(options.presetRoot)
  if (presets.length === 0) return { added: [], skipped: [] }

  let before = ''
  let existed = false
  try {
    before = readFileSync(options.patchPath, 'utf8')
    existed = true
  } catch {
    // No home layer yet: this pass creates one.
  }

  const declared = declaredRowIds(before)
  if (declared === undefined) {
    const reason = 'the home patch does not parse, so it was left untouched'
    return { added: [], skipped: presets.map(preset => ({ id: preset.id, reason })) }
  }

  const skipped: { id: string, reason: string }[] = []
  const rendered: RenderedPreset[] = []
  for (const preset of presets) {
    if (preset.problem !== undefined) {
      skipped.push({ id: preset.id, reason: preset.problem })
      continue
    }
    const rowId = `${PRESET_ROW_PREFIX}${preset.id}`
    if (declared.has(rowId)) {
      skipped.push({ id: preset.id, reason: 'already declared' })
      continue
    }
    rendered.push(renderPresetRow(preset, 0))
  }
  if (rendered.length === 0) return { added: [], skipped }

  // A root-level flow collection is a complete document on its own, so block
  // rows cannot follow it: the kernel's own empty patch template (`[]`) is
  // replaced, while the comments around it are kept.
  const kept = before.split('\n').filter(line => !/^[[{]\s*[\]}]\s*$/u.test(line)).join('\n')
  const base = kept.replace(/\n+$/u, '')
  const next = `${base === '' ? '' : `${base}\n\n`}${rendered.map(entry => entry.text).join('')}`

  let backup: string | undefined
  if (existed) {
    backup = `${options.patchPath}.bak-migration-${stamp(options.now ?? new Date())}`
    copyFileSync(options.patchPath, backup)
  }
  mkdirSync(dirname(options.patchPath), { recursive: true })
  const tmp = `${options.patchPath}.${String(process.pid)}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, options.patchPath)
  return { added: rendered.map(entry => entry.rowId), skipped, ...backup === undefined ? {} : { backup } }
}
