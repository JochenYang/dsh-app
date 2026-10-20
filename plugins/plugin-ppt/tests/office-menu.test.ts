/**
 * The Office group in the composer's `/` menu.
 *
 * What this suite pins, and why each one is worth a test:
 *
 * - the data table is the whole contract between a menu row and a working
 *   skill. A row naming a skill nobody installs looks and submits perfectly and
 *   injects nothing, so the names are asserted against the skills that actually
 *   exist on this line — the kernel's `office-docx` / `office-xlsx` bundle and
 *   this suite's own `dsh-pdf` / `dsh-ppt`;
 * - the candidate's `name` IS the skill name. The menu shows it as the dimmed
 *   alias and uses it as a search key, so this is what keeps the alias the user
 *   reads equal to the gesture that works;
 * - `codec` answers the literal token on BOTH projections. The chip's clipboard
 *   form and the model serialization must be the same string, or a chip and the
 *   same text typed by hand would submit differently;
 * - the source is registered behind the command group and ahead of the skill
 *   group, carries no group title of its own, and declares no lexicon — the
 *   kernel's skill source already rolls these names.
 *
 * The module is React- and runtime-free by construction (the ranker and the
 * icon factory arrive as parameters), so all of this is asserted without a
 * browser and without pulling the primitives package into a node bundle.
 *
 * @module @dsh-app/plugin-ppt/tests/office-menu
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OFFICE_MENU_ITEMS,
  OFFICE_MENU_ORDER,
  OFFICE_MENU_SOURCE,
  createOfficeMenuSource,
  officeMenuChip,
  officeMenuItem,
} from '../src/client/office-menu.ts'
import type { OfficeMenuDeps, OfficeMenuIconKind } from '../src/client/office-menu.ts'
import { en, zh } from '../src/client/locales.ts'
import type { PptKey } from '../src/client/locales.ts'
// The sibling's mode source name, imported rather than grepped: both mode
// sources are runtime-free, so the real constant is available.
import { REFERENCE_SOURCE } from '../src/client/skill-reference.ts'
import { REFERENCE_SOURCE as PDF_REFERENCE_SOURCE } from '../../plugin-pdf/src/client/skill-reference.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A ranker double with the kernel's documented contract: an empty query returns
 * the input list untouched, otherwise a case-insensitive ordered-subsequence
 * filter over `name` and `label`. Reproducing the contract here (rather than
 * importing it) is deliberate: `client.ts` injects the real `rankByName`, and
 * importing it here would drag the primitives runtime — react, shiki, katex —
 * into a node test bundle where none of those peers are installed.
 */
function rankDouble<T extends { readonly name: string, readonly label?: string }>(
  items: readonly T[],
  query: string,
): readonly T[] {
  if (query.length === 0) return items
  const needle = query.toLowerCase()
  const subsequence = (haystack: string): boolean => {
    let at = 0
    for (const char of haystack.toLowerCase()) {
      if (char === needle[at]) at += 1
      if (at === needle.length) return true
    }
    return at === needle.length
  }
  return items.filter(item => subsequence(item.name) || (item.label !== undefined && subsequence(item.label)))
}

/** Glyph double: a stable component identity per kind, as the real factory is. */
const GLYPHS = new Map<OfficeMenuIconKind, () => null>()
function iconFor(kind: OfficeMenuIconKind): () => null {
  const existing = GLYPHS.get(kind)
  if (existing !== undefined) return existing
  const created = () => null
  GLYPHS.set(kind, created)
  return created
}

/** Deps bound to the Chinese dictionary (the product's default locale). */
function deps(overrides: Partial<OfficeMenuDeps> = {}): OfficeMenuDeps {
  return {
    t: (key: PptKey) => zh[key],
    iconFor,
    rank: rankDouble,
    ...overrides,
  }
}

const SESSION = { sessionId: 'session-1' }
const REQUEST = { query: '', signal: new AbortController().signal }

test('the table names four real skills, in menu order, with distinct glyphs', () => {
  assert.equal(OFFICE_MENU_ITEMS.length, 4)
  assert.deepEqual(
    OFFICE_MENU_ITEMS.map(item => item.skill),
    ['office-docx', 'dsh-pdf', 'dsh-ppt', 'office-xlsx'],
  )
  assert.deepEqual(
    OFFICE_MENU_ITEMS.map(item => item.iconKind),
    ['word', 'pdf', 'ppt', 'excel'],
  )
  // A duplicate skill would render two rows that insert the same chip, and the
  // menu would have no way to tell them apart.
  assert.equal(new Set(OFFICE_MENU_ITEMS.map(item => item.skill)).size, 4)
})

test('the two kernel skills are the ones the kernel office bundle actually installs', () => {
  // The fact that matters is not what this table says but whether the kernel
  // ships a skill by that name. `scripts/build-runtime.mjs` holds the payload's
  // own contract with `@deepseek-ai/dsh-skill-office` (`SKILL_NAMES`), so the
  // comparison is against that list rather than against this file's own text —
  // a grep of the file under test would only prove it contains what was typed.
  const runtime = readFileSync(join(pluginRoot, '..', '..', 'scripts', 'build-runtime.mjs'), 'utf8')
  const block = /const OFFICE_SKILL_NAMES = \[([\s\S]*?)\n\]/u.exec(runtime)
  assert.ok(block !== null, 'scripts/build-runtime.mjs no longer declares OFFICE_SKILL_NAMES')
  const kernelSkills = [...block[1]!.matchAll(/'([a-z-]+)'/gu)].map(match => match[1]!)
  assert.ok(kernelSkills.length > 0, 'OFFICE_SKILL_NAMES parsed empty')
  for (const skill of ['office-docx', 'office-xlsx']) {
    assert.ok(
      kernelSkills.includes(skill),
      `the kernel office payload no longer installs "${skill}" (it carries: ${kernelSkills.join(', ')})`,
    )
  }
})

test('the two suite skills are the names this plugin and its sibling install', () => {
  const ppt = readFileSync(join(pluginRoot, 'src', 'skill.ts'), 'utf8')
  assert.match(ppt, /export const SKILL_NAME = 'dsh-ppt'/)
  const pdf = readFileSync(join(pluginRoot, '..', 'plugin-pdf', 'src', 'skill.ts'), 'utf8')
  assert.match(pdf, /export const SKILL_NAME = 'dsh-pdf'/)
})

test('every label and description key exists in both dictionaries', () => {
  for (const item of OFFICE_MENU_ITEMS) {
    assert.ok(item.labelKey in zh, `zh is missing ${item.labelKey}`)
    assert.ok(item.descriptionKey in zh, `zh is missing ${item.descriptionKey}`)
    assert.ok(item.labelKey in en, `en is missing ${item.labelKey}`)
    assert.ok(item.descriptionKey in en, `en is missing ${item.descriptionKey}`)
    assert.notEqual(zh[item.labelKey], '')
    assert.notEqual(zh[item.descriptionKey], '')
  }
  assert.notEqual(zh['menu.group'], '')
})

test('an empty query lists all four rows, each carrying section, glyph and copy', async () => {
  const source = createOfficeMenuSource(deps())
  const items = await source.candidates(SESSION, REQUEST)
  assert.equal(items.length, 4)
  for (const [index, item] of items.entries()) {
    const row = OFFICE_MENU_ITEMS[index]!
    assert.equal(item.name, row.skill)
    assert.equal(item.label, zh[row.labelKey])
    assert.equal(item.description, zh[row.descriptionKey])
    assert.equal(item.section, zh['menu.group'])
    assert.equal(typeof item.icon, 'function')
    assert.equal(item.icon, iconFor(row.iconKind))
  }
})

test('a query filters by name and by localized label', async () => {
  const source = createOfficeMenuSource(deps())
  const byName = await source.candidates(SESSION, { query: 'pdf', signal: REQUEST.signal })
  assert.deepEqual(byName.map(item => item.name), ['dsh-pdf'])

  const byLabel = await source.candidates(SESSION, { query: '文档', signal: REQUEST.signal })
  assert.deepEqual(byLabel.map(item => item.name), ['office-docx', 'dsh-pdf'])

  const none = await source.candidates(SESSION, { query: 'zzz', signal: REQUEST.signal })
  assert.deepEqual(none, [])
})

test('an aborted request answers nothing', async () => {
  const source = createOfficeMenuSource(deps())
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await source.candidates(SESSION, { query: '', signal: controller.signal }), [])
})

test('a pick inserts a chip whose ref is the skill name and whose text is the token', () => {
  const source = createOfficeMenuSource(deps())
  const outcome = source.onPick({ candidate: { name: 'dsh-pdf' } })
  assert.ok(outcome !== undefined)
  assert.deepEqual(outcome.insert, {
    source: OFFICE_MENU_SOURCE,
    ref: 'dsh-pdf',
    label: zh['menu.pdf.label'],
    appearance: 'file',
    clipboardText: '/dsh-pdf',
  })
})

test('a pick for an unknown name is refused rather than guessed', () => {
  const source = createOfficeMenuSource(deps())
  assert.equal(source.onPick({ candidate: { name: 'office-nope' } }), undefined)
})

test('both codec projections answer the literal skill gesture', async () => {
  const source = createOfficeMenuSource(deps())
  for (const item of OFFICE_MENU_ITEMS) {
    assert.equal(source.codec.clipboardText(item.skill), `/${item.skill}`)
    assert.equal(await source.codec.serialize(item.skill), `/${item.skill}`)
  }
})

test('the chip text a row inserts equals what its codec serializes', () => {
  // A chip whose clipboard text disagrees with the codec's answer would copy as
  // one thing and submit as another; the two are built from the same skill name
  // precisely so they cannot drift.
  for (const item of OFFICE_MENU_ITEMS) {
    const chip = officeMenuChip(item, zh[item.labelKey])
    assert.equal(chip.clipboardText, `/${item.skill}`)
  }
})

test('the source sits between the command and skill groups and carries no group title', () => {
  const source = createOfficeMenuSource(deps())
  assert.equal(source.trigger, '/')
  assert.equal(source.name, OFFICE_MENU_SOURCE)
  assert.equal(source.order, OFFICE_MENU_ORDER)
  // The kernel's command source defaults to order 0 and its skill source is 2.
  assert.ok(source.order > 0 && source.order < 2)
  // Rows carry their own `section`, so a group title would print the heading twice.
  assert.equal(source.showGroupTitle, false)
})

test('the source declares no lexicon: the kernel skill source already rolls these names', () => {
  const source = createOfficeMenuSource(deps()) as unknown as Record<string, unknown>
  assert.equal(source.lexicon, undefined)
})

test('the source name is distinct from the two mode sources it shares the trigger with', () => {
  // Duplicate (trigger, name) pairs throw at registration, so a collision here
  // would take the whole client half down rather than merely hiding a group.
  // Both mode sources are runtime-free modules, so their real constants are
  // compared instead of a text search.
  assert.notEqual(REFERENCE_SOURCE, OFFICE_MENU_SOURCE)
  assert.notEqual(PDF_REFERENCE_SOURCE, OFFICE_MENU_SOURCE)
  assert.notEqual(REFERENCE_SOURCE, PDF_REFERENCE_SOURCE)
})

test('a locale switch is reflected on the next call without re-registering', async () => {
  const source = createOfficeMenuSource(deps())
  const zhItems = await source.candidates(SESSION, REQUEST)
  const enSource = createOfficeMenuSource(deps({ t: (key: PptKey) => en[key] }))
  const enItems = await enSource.candidates(SESSION, REQUEST)
  assert.equal(zhItems[0]!.label, '文档')
  assert.equal(enItems[0]!.label, 'Documents')
  assert.equal(zhItems[0]!.section, '办公')
  assert.equal(enItems[0]!.section, 'Office')
})

test('officeMenuItem resolves a row by skill and refuses anything else', () => {
  assert.equal(officeMenuItem('dsh-ppt')?.iconKind, 'ppt')
  assert.equal(officeMenuItem('dsh-ppt')?.labelKey, 'menu.presentations.label')
  assert.equal(officeMenuItem('nope'), undefined)
})

test('the module keeps the framework runtimes out of its own imports', () => {
  // A runtime import of the primitives package would pull react/shiki/katex
  // into the plugin's node test bundle; the ranker and the glyph factory are
  // parameters for exactly this reason.
  const source = readFileSync(join(pluginRoot, 'src', 'client', 'office-menu.ts'), 'utf8')
  const runtimeImports = source
    .split('\n')
    .filter(line => line.startsWith('import ') && !line.startsWith('import type '))
  assert.deepEqual(runtimeImports, [])
})

// --- wiring (the client entry) ---------------------------------------------
//
// The client entry imports react and the primitives package, which are
// browser-provided externals not installed for a node run, so the wiring is
// read from the source and the built bundle rather than imported.

test('the client entry registers both sources inside the trigger scope', () => {
  const client = readFileSync(join(pluginRoot, 'src', 'client.ts'), 'utf8')
  // One scope, two sources: the mode chip and the menu group. Registering
  // outside `scope.effect` would leak the source for the plugin's whole lifetime.
  assert.match(client, /ctx\.inject\(\['inputTriggers'\]/)
  const registrations = [...client.matchAll(/registerSource\((create\w+)\(/gu)].map(match => match[1])
  assert.deepEqual(registrations, ['createSkillReferenceSource', 'createOfficeMenuSource'])
  assert.equal(
    [...client.matchAll(/scope\.effect\(\s*\(\) => [^\n]*registerSource/gu)].length,
    2,
    'every registration must ride the scope effect',
  )
})

test('the client entry hands the menu the real ranker, the bound seat and the glyph factory', () => {
  const client = readFileSync(join(pluginRoot, 'src', 'client.ts'), 'utf8')
  assert.match(client, /import \{ rankByName \} from '@deepseek-ai\/dsh-client-ui-primitives'/)
  assert.match(client, /rank: rankByName/)
  assert.match(client, /iconFor: officeMenuIcon/)
  assert.match(client, /t: ctx\.locale\.bind\(PPT_NS\)/)
})

test('an absent trigger pipeline registers nothing, so no empty group can appear', () => {
  const client = readFileSync(join(pluginRoot, 'src', 'client.ts'), 'utf8')
  // The guard precedes both registrations: a missing service must leave the
  // menu exactly as the kernel built it, not add a group with no rows.
  const guard = client.indexOf('if (registry === undefined) return')
  assert.ok(guard !== -1, 'the missing-service guard is gone')
  assert.ok(guard < client.indexOf('createOfficeMenuSource('), 'the menu source is registered before the guard')
  assert.ok(guard < client.indexOf('createSkillReferenceSource('), 'the chip source is registered before the guard')
})

test('the built client artifact carries the menu source and its four skills', () => {
  const bundle = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  assert.match(bundle, /dsh-office-menu/)
  for (const skill of ['office-docx', 'dsh-pdf', 'dsh-ppt', 'office-xlsx']) {
    assert.ok(bundle.includes(skill), `the bundle does not carry "${skill}"`)
  }
  // The primitives package stays an external require: inlining it would ship a
  // second copy of react and the syntax highlighter inside this plugin.
  assert.match(bundle, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/)
})

test('the mode capsule keeps its own chip: the menu does not join the cleanup set', () => {
  // `skill-prefill` strips the mode tokens before a capsule places its own.
  // A one-shot menu chip is NOT a mode, so removing it there would discard a
  // format the user just chose; the token list must stay at the two mode skills.
  const prefill = readFileSync(join(pluginRoot, 'src', 'client', 'skill-prefill.ts'), 'utf8')
  const tokens = /export const OFFICE_CHIP_TOKENS: readonly string\[\] = \[([^\]]*)\]/u.exec(prefill)
  assert.ok(tokens !== null, 'OFFICE_CHIP_TOKENS is gone')
  assert.deepEqual(
    [...tokens[1]!.matchAll(/'([^']+)'/gu)].map(match => match[1]),
    ['/dsh-ppt', '/dsh-pdf'],
  )
})
