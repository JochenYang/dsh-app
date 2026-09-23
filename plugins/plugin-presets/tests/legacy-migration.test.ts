/**
 * Legacy preset migration: the pre-0.1.7 `.agent-presets/<id>/` layout becomes
 * one `@deepseek-ai/dsh-agent-preset` row.
 *
 * What these tests are for. The migration moves a user's OWN composition, and
 * the two ways it can go wrong are both silent:
 *
 *   1. **Losing a `!!js` expression.** The rows carry loader-evaluated
 *      expressions (`disabled: !!js process.platform === 'win32'`). Parsing and
 *      re-serializing drops the tag, leaving a truthy STRING — measured with
 *      yaml 2.9.1. The composition would then be disabled on every platform
 *      instead of only Windows, and nothing would report it. The tests below
 *      therefore assert that the EMBEDDED rows are deep-equal to the originals,
 *      `!!js` values included, which is the property the textual embed exists to
 *      guarantee.
 *   2. **Leaving a path pointing at the wrong directory.** The one expression
 *      that resolves a path used `baseUrl` = the preset's own directory; after
 *      migration the declaration lives in the profile patch, where `baseUrl` is
 *      the profile. The rebase test pins the absolute replacement.
 *
 * @module plugin-presets/tests/legacy-migration
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { findLegacyPresets, migrateLegacyPresets, rebasePresetPaths, renderPresetRow } from '../src/legacy-migration.ts'

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** The loader's own tag handling; without it `!!js` would not parse at all. */
const TAGS = [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string): string => value }]

/** A composition shaped like the real one: `!!js` rows and a `baseUrl` path. */
const COMPOSITION = `# a leading comment
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
`

/** Build a legacy preset directory under a fresh scratch root. */
function makePreset(id: string, composition: string, presetYml?: string): { root: string, dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-legacy-'))
  roots.push(root)
  const dir = join(root, id)
  mkdirSync(join(dir, 'skills'), { recursive: true })
  mkdirSync(join(dir, 'evolution'), { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), composition)
  if (presetYml !== undefined) writeFileSync(join(dir, 'preset.yml'), presetYml)
  return { root, dir }
}

describe('legacy preset discovery', () => {
  it('finds a directory holding a composition, and reads its display fields', () => {
    const { root } = makePreset('rsi-dev', COMPOSITION, 'name: 自进化模式\ndescription: 一个可以改进自己的 Agent\n')
    const found = findLegacyPresets(root)
    assert.equal(found.length, 1)
    assert.equal(found[0]!.id, 'rsi-dev')
    assert.equal(found[0]!.name, '自进化模式')
    assert.equal(found[0]!.description, '一个可以改进自己的 Agent')
    assert.equal(found[0]!.rows, 3)
    assert.equal(found[0]!.problem, undefined)
  })

  it('skips a directory with no composition, and dot-directories', () => {
    const { root } = makePreset('real', COMPOSITION)
    mkdirSync(join(root, 'not-a-preset'))
    writeFileSync(join(root, 'not-a-preset', 'README.md'), 'x')
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, '.hidden', 'agent.cordis.yml'), COMPOSITION)
    const found = findLegacyPresets(root)
    assert.deepEqual(found.map(entry => entry.id), ['real'])
  })

  it('falls back to the directory name when preset.yml is missing or unusable', () => {
    const { root } = makePreset('no-yml', COMPOSITION)
    const { root: root2 } = makePreset('bad-yml', COMPOSITION, 'name: [not a string\n')
    assert.equal(findLegacyPresets(root)[0]!.name, 'no-yml')
    assert.equal(findLegacyPresets(root2)[0]!.name, 'bad-yml')
  })

  it('reports a composition it cannot migrate instead of guessing', () => {
    const { root } = makePreset('broken', 'this: is not a list\n')
    const found = findLegacyPresets(root)
    assert.equal(found.length, 1)
    assert.match(found[0]!.problem ?? '', /not a top-level list/u)
    const { root: root2 } = makePreset('empty', '[]\n')
    assert.match(findLegacyPresets(root2)[0]!.problem ?? '', /declares no rows/u)
  })

  it('an id-only row is accepted (it modifies an inherited row)', () => {
    const { root } = makePreset('modifies', "- id: tool-bash\n  disabled: true\n")
    assert.equal(findLegacyPresets(root)[0]!.problem, undefined)
  })
})

describe('rendering one preset as a patch row', () => {
  it('embeds the composition so the !!js expressions survive verbatim', () => {
    // The property that matters: what comes back out of the patch text is
    // deep-equal to what went in, `!!js` included. A parse+serialize round trip
    // fails this. The ONE intended difference is the rebased path expression
    // (that row is asserted separately), so the comparison is made against the
    // composition after the same rebase the renderer applies.
    const { dir } = makePreset('rsi-dev', COMPOSITION)
    const preset = findLegacyPresets(join(dir, '..')).find(entry => entry.id === 'rsi-dev')!
    const rendered = renderPresetRow(preset, 0)
    const doc = parse(rendered.text, { customTags: TAGS })
    assert.equal(doc.length, 1)
    const row = doc[0]
    assert.equal(row.insert[0].id, 'preset-rsi-dev')
    assert.equal(row.insert[0].name, '@deepseek-ai/dsh-agent-preset')
    assert.equal(row.insert[0].config.id, 'rsi-dev')

    const expected = parse(rebasePresetPaths(COMPOSITION, preset.dir).text, { customTags: TAGS })
    assert.deepEqual(row.insert[0].config.plugins, expected)

    // Spot-check the two expressions, since deepEqual alone would not explain
    // WHAT broke if this regressed.
    const bash = row.insert[0].config.plugins.find((r: { id: string }) => r.id === 'tool-bash')
    assert.equal(bash.disabled, "process.platform === 'win32'", 'the expression is the raw JS, not a boolean or a re-quoted string')
    const skills = row.insert[0].config.plugins.find((r: { id: string }) => r.id === 'skill-filesystem')
    assert.equal(skills.config.customSkillDirs.length, 1)
    assert.match(skills.config.customSkillDirs[0], /^process\.getBuiltinModule/u)
    // The row that did NOT use baseUrl is untouched, byte for byte.
    const persona = row.insert[0].config.plugins.find((r: { id: string }) => r.id === 'persona')
    assert.deepEqual(persona, { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { suffix: 'Your working directory is {{cwd}}.' } })
  })

  it('keeps the composition intact at the indent depth the patch needs', () => {
    const { dir } = makePreset('deep', COMPOSITION)
    const preset = findLegacyPresets(join(dir, '..'))[0]!
    const expected = parse(rebasePresetPaths(COMPOSITION, preset.dir).text, { customTags: TAGS })
    for (const indent of [0, 4, 8]) {
      const rendered = renderPresetRow(preset, indent)
      const doc = parse(rendered.text, { customTags: TAGS })
      assert.deepEqual(doc[0].insert[0].config.plugins, expected, `indent ${String(indent)}`)
    }
  })

  it('carries the display name through as `config.name`, and the summary as the description', () => {
    // The registration row's field table is id / plugins (required) plus name /
    // description / order (display). Reading `preset.yml`'s name and then never
    // rendering it is what made a migrated preset show its ROW id in the chooser
    // instead of 自进化模式 — so both display fields are asserted here.
    const { dir } = makePreset('named', COMPOSITION, 'name: 自进化模式\ndescription: 说明文字\n')
    const preset = findLegacyPresets(join(dir, '..'))[0]!
    const doc = parse(renderPresetRow(preset, 0).text, { customTags: TAGS })
    assert.equal(doc[0].insert[0].config.name, '自进化模式')
    assert.equal(doc[0].insert[0].config.description, '说明文字')
  })

  it('does not write a name that would only repeat the id', () => {
    // Unset is the documented default, and the id is already a usable title, so a
    // preset with no `name:` of its own must not grow a redundant field.
    const { dir } = makePreset('plain', COMPOSITION)
    const preset = findLegacyPresets(join(dir, '..'))[0]!
    const doc = parse(renderPresetRow(preset, 0).text, { customTags: TAGS })
    assert.equal(doc[0].insert[0].config.name, undefined)
  })
})

describe('rebasing the path expression', () => {
  // A real directory, not a made-up one: `pathToFileURL` is drive-aware on
  // Windows (`/preset` resolves against the current drive), so a fixture that
  // invents a POSIX path asserts nothing about the platform this ships on. The
  // tests below build the preset under a real temp dir and check the URL the
  // expression actually produces.
  const makeDir = (): { root: string, dir: string } => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-rebase-'))
    roots.push(root)
    const dir = join(root, 'rsi-dev')
    mkdirSync(join(dir, 'skills'), { recursive: true })
    return { root, dir }
  }

  /**
   * Evaluate one `!!js` expression the way the loader does, and return the path
   * it yields. The whole expression is evaluated (not a regex-extracted piece):
   * the rows wrap `new URL(...)` in `fileURLToPath(...)`, and a greedy match that
   * takes the last `)` swallows the wrapper's closing paren too — measured.
   * `baseUrl` is passed as a parameter so a row that still uses it evaluates to
   * something rather than throwing a ReferenceError.
   */
  const evaluatePath = (expression: string): string => {
    // eslint-disable-next-line no-new-func -- the loader evaluates these too.
    const value = new Function('baseUrl', `return (${expression})`)(undefined) as URL | string
    return typeof value === 'string' ? value : fileURLToPath(value)
  }

  it('turns the baseUrl-relative skill root into the real absolute directory', () => {
    // After migration the row lives in the PROFILE patch, so `baseUrl` is the
    // profile directory; the preset's own skills/ would never be found. The
    // assertion is end-to-end: evaluate the rewritten expression and compare the
    // path it yields with the directory the preset actually has.
    const { dir } = makeDir()
    const source = "- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - !!js \"process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))\"\n"
    const { text, rewritten } = rebasePresetPaths(source, dir)
    assert.deepEqual(rewritten, ['skills/'])
    // The wrapper call is untouched: only the `new URL(...)` argument changed.
    assert.match(text, /fileURLToPath\(new URL\(/u)
    // And the result still parses as the loader would read it.
    const doc = parse(text, { customTags: TAGS })
    const path = evaluatePath(doc[0].config.customSkillDirs[0])
    assert.equal(path, join(dir, 'skills') + sep)
  })

  it('survives both YAML quote styles the user may have written', () => {
    // The regression this locks: the replacement was built with JSON.stringify,
    // which produces a DOUBLE-quoted literal. Inside a `!!js "…"` scalar that
    // second `"` ends the scalar and the document stops parsing ("Unexpected
    // scalar at node end") — measured while building this. The literal is
    // single-quoted for that reason, and it has to work in both styles.
    const { dir } = makeDir()
    for (const source of [
      "- id: a\n  config:\n    x: !!js new URL('skills/', baseUrl)\n",
      "- id: a\n  config:\n    x: !!js \"new URL('skills/', baseUrl)\"\n",
      "- id: a\n  config:\n    x: !!js new URL(\"skills/\", baseUrl)\n",
    ]) {
      const { text } = rebasePresetPaths(source, dir)
      // Whatever the style, the result parses and yields the real directory.
      const doc = parse(text, { customTags: TAGS })
      assert.equal(evaluatePath(doc[0].config.x), join(dir, 'skills') + sep, source)
    }
  })

  it('escapes a path segment that carries a quote', () => {
    // The literal is JavaScript: an unescaped quote in a segment would end it.
    const { dir } = makeDir()
    const quoteDir = join(dir, "ski'lls")
    const { text } = rebasePresetPaths("- id: a\n  config:\n    x: !!js new URL('skills/', baseUrl)\n", quoteDir)
    const doc = parse(text, { customTags: TAGS })
    assert.equal(evaluatePath(doc[0].config.x), join(quoteDir, 'skills') + sep)
  })

  it('leaves an expression that does not use baseUrl exactly as it was', () => {
    const source = "- id: tool-bash\n  disabled: !!js process.platform === 'win32'\n"
    const { text, rewritten } = rebasePresetPaths(source, '/anywhere')
    assert.equal(text, source)
    assert.deepEqual(rewritten, [])
  })

  it('does not touch an absolute or scheme-qualified URL', () => {
    const { dir } = makeDir()
    const source = "- id: a\n  config:\n    x: !!js new URL('file:///tmp/skills/', baseUrl)\n- id: b\n  config:\n    y: !!js new URL('https://example.test/s', baseUrl)\n"
    const { text, rewritten } = rebasePresetPaths(source, dir)
    assert.deepEqual(rewritten, [])
    assert.equal(text, source)
  })
})

describe('migrating into the home patch layer', () => {
  /** A scratch preset root plus a home patch path under the same temp tree. */
  const scratch = (patchText?: string): { presetRoot: string, patchPath: string } => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-migrate-'))
    roots.push(root)
    const presetRoot = join(root, '.agent-presets')
    const dir = join(presetRoot, 'rsi-dev')
    mkdirSync(join(dir, 'skills'), { recursive: true })
    writeFileSync(join(dir, 'agent.cordis.yml'), COMPOSITION)
    writeFileSync(join(dir, 'preset.yml'), 'name: 自进化模式\n')
    const patchPath = join(root, 'cordis.patch.yml')
    if (patchText !== undefined) writeFileSync(patchPath, patchText)
    return { presetRoot, patchPath }
  }

  it("appends the preset to the user's own layer, and keeps what was there", () => {
    const existing = '# my own patch\n\n- id: mcp-context7\n  name: "@deepseek-ai/dsh-mcp-client"\n'
    const { presetRoot, patchPath } = scratch(existing)
    const outcome = migrateLegacyPresets({ presetRoot, patchPath })
    assert.deepEqual(outcome.added, ['preset-rsi-dev'])
    const after = readFileSync(patchPath, 'utf8')
    // The user's own rows and comments survive, byte for byte.
    assert.equal(after.startsWith(existing.replace(/\n$/u, '')), true, after)
    const doc = parse(after, { customTags: TAGS })
    // The user's row is still a top-level row, and the new one is the insert
    // wrapper upstream uses for a preset (its id is nested, not top-level).
    assert.equal(doc[0].id, 'mcp-context7')
    assert.equal(doc.length, 2)
    assert.equal(doc[1].insert[0].id, 'preset-rsi-dev')
    const inserted = doc[1].insert[0]
    assert.equal(inserted.config.plugins.length, parse(COMPOSITION, { customTags: TAGS }).length)
    // A pre-write copy was taken, because the file already existed.
    assert.notEqual(outcome.backup, undefined)
    assert.equal(readFileSync(outcome.backup!, 'utf8'), existing)
  })

  it('is idempotent: a second pass appends nothing', () => {
    const { presetRoot, patchPath } = scratch('- id: existing\n  name: "x"\n')
    assert.deepEqual(migrateLegacyPresets({ presetRoot, patchPath }).added, ['preset-rsi-dev'])
    const afterFirst = readFileSync(patchPath, 'utf8')
    const second = migrateLegacyPresets({ presetRoot, patchPath })
    assert.deepEqual(second.added, [])
    assert.deepEqual(second.skipped, [{ id: 'rsi-dev', reason: 'already declared' }])
    assert.equal(readFileSync(patchPath, 'utf8'), afterFirst, 'the file is not rewritten at all')
  })

  it('rewrites the empty template instead of appending to a flow node', () => {
    // `[]` is a complete document: block rows cannot follow it, so a naive
    // append would produce a file the loader refuses.
    const { presetRoot, patchPath } = scratch('[]\n')
    assert.deepEqual(migrateLegacyPresets({ presetRoot, patchPath }).added, ['preset-rsi-dev'])
    const doc = parse(readFileSync(patchPath, 'utf8'), { customTags: TAGS })
    assert.equal(Array.isArray(doc), true)
    assert.equal(doc[0].insert[0].id, 'preset-rsi-dev')
  })

  it('refuses to rewrite a patch it cannot parse', () => {
    // A document this module cannot read is one it must not touch: the user's
    // presets stay where they are and the boot continues.
    const broken = 'this: [is not a sequence\n'
    const { presetRoot, patchPath } = scratch(broken)
    const outcome = migrateLegacyPresets({ presetRoot, patchPath })
    assert.deepEqual(outcome.added, [])
    assert.match(outcome.skipped[0]!.reason, /does not parse/u)
    assert.equal(readFileSync(patchPath, 'utf8'), broken, 'the file is untouched')
  })

  it('creates the layer when the home has none, and takes no copy of nothing', () => {
    const { presetRoot, patchPath } = scratch()
    const outcome = migrateLegacyPresets({ presetRoot, patchPath })
    assert.deepEqual(outcome.added, ['preset-rsi-dev'])
    assert.equal(outcome.backup, undefined, 'there was nothing to copy')
    // The layer did not exist, so this pass is what created it.
    const doc = parse(readFileSync(patchPath, 'utf8'), { customTags: TAGS })
    assert.equal(doc.length, 1)
    assert.equal(doc[0].insert[0].id, 'preset-rsi-dev')
  })

  it('reports a preset it cannot migrate instead of declaring half of it', () => {
    const { presetRoot, patchPath } = scratch('- id: existing\n  name: "x"\n')
    mkdirSync(join(presetRoot, 'broken'), { recursive: true })
    writeFileSync(join(presetRoot, 'broken', 'agent.cordis.yml'), 'not: a list\n')
    const outcome = migrateLegacyPresets({ presetRoot, patchPath })
    assert.deepEqual(outcome.added, ['preset-rsi-dev'])
    assert.deepEqual(outcome.skipped, [{ id: 'broken', reason: 'agent.cordis.yml is not a top-level list of plugin rows' }])
    // The un-migratable preset is NOT in the file.
    assert.equal(readFileSync(patchPath, 'utf8').includes('preset-broken'), false)
  })
})
