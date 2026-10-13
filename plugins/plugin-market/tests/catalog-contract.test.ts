/**
 * The catalog source contract: `docs/catalog-source.schema.json` and
 * `docs/catalog-source.md` against the parser they describe.
 *
 * The contract's whole value is that it stays true for an OUTSIDE author — a
 * plugin author who has neither the repository nor the habit of reading
 * `catalog.ts`. Four independent checks hold it in place:
 *
 * 1. AST FIELD SCAN. Every key the plugin reads off a catalog document or one
 *    of its rows is extracted from the parsed `src/` tree
 *    (`tests/catalog-drift-scan.ts`, `ts.createSourceFile`) and must equal, as
 *    a set, the fields the schema declares for that shape. Property access,
 *    index access, `'x' in record`, destructuring, `Object.keys` and reads
 *    moved into a helper function are all the same read to an AST, which is
 *    what the text scan this replaced could not see; the scan covers the
 *    WHOLE `src/` tree, so the second file that reads the same document
 *    (`src/snapshot.ts`) is inside the net rather than outside it.
 * 2. SCHEMA VOCABULARY. The validator (`tests/schema-validator.ts`) audits the
 *    schema before judging any instance, so a keyword planted in a position no
 *    instance reaches still fails here instead of passing silently.
 * 3. FIXTURE ENGINE. Every declared field is exercised through the real
 *    `parseCatalogDocument` with two different values; an entry that does not
 *    change is a field nobody reads (or a fixture that stopped reaching the
 *    parser), and a field missing from the fixture table fails the same way.
 * 4. BINDING ASSERTIONS for the rules that are grammars: the npm package
 *    grammar and the http(s) URL prefix are compared against the parser's own
 *    regexes, the install-command pattern is compared against the pattern
 *    DERIVED from those same regexes, and the git-target grammar against
 *    `GIT_TARGET_PATTERN` plus the install chain's repository-identity
 *    requirement.
 *
 * The documents under `tests/fixtures/` are unedited excerpts of the two live
 * sources, so the suite also asserts the contract against bytes the project did
 * not author — that is what "the schema matches the real source" has to mean.
 *
 * @module plugin-market/tests/catalog-contract
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { GIT_TARGET_PATTERN, parseCatalogDocument, type CatalogEntry } from '../src/catalog.ts'
import { repoKeyOf } from '../src/identity.ts'
import { PACKAGE_NAME_PATTERN } from '../src/npm.ts'
import { readSourceTree, scanCatalogFieldReads, type FieldKind } from './catalog-drift-scan.ts'
import { UnsupportedSchemaError, validateSchema, type JsonSchema } from './schema-validator.ts'

const SCHEMA = JSON.parse(readFileSync(new URL('../docs/catalog-source.schema.json', import.meta.url), 'utf8')) as JsonSchema
const DOC = readFileSync(new URL('../docs/catalog-source.md', import.meta.url), 'utf8')
const IMPL = readFileSync(new URL('../src/catalog.ts', import.meta.url), 'utf8')
const SNAPSHOT = JSON.parse(readFileSync(new URL('../src/catalog-snapshot.json', import.meta.url), 'utf8')) as unknown
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[], version: string }
const REAL_AGGREGATED = JSON.parse(readFileSync(new URL('../tests/fixtures/real-aggregated-rows.json', import.meta.url), 'utf8')) as FixtureDocument
const REAL_STORE = JSON.parse(readFileSync(new URL('../tests/fixtures/real-store-rows.json', import.meta.url), 'utf8')) as FixtureDocument
const REAL_REFUSED = JSON.parse(readFileSync(new URL('../tests/fixtures/real-refused-rows.json', import.meta.url), 'utf8')) as FixtureDocument

/** A 40-hex commit pin (the only mutable-selector proof the git grammar takes). */
const SHA = 'c3319d9d3e78a18191e1381461b69e84bc547575'

/** One committed excerpt of a live catalog source. */
interface FixtureDocument {
  readonly categories: unknown
  readonly plugins: Record<string, unknown>[]
}

/** The schema's definitions. */
function def(name: string): JsonSchema {
  const definitions = SCHEMA.$defs as Record<string, JsonSchema>
  const found = definitions[name]
  assert.ok(found !== undefined, `the schema has no $defs/${name}`)
  return found
}

/** The `properties` keys of one definition, sorted. */
function declaredFields(name: string): string[] {
  const properties = def(name).properties as Record<string, unknown>
  return Object.keys(properties).sort()
}

/** Every `$defs` name the contract is made of; a new one is a contract change. */
const KNOWN_DEFS = [
  'aggregatedDocument',
  'aggregatedRow',
  'categoryLabel',
  'customDocument',
  'customRow',
  'httpUrl',
  'installCommand',
  'localizedText',
  'npmPackageName',
  'storeCategory',
  'storeDocument',
  'storeRow',
]

/** The row-shaped definitions and the parse function each one describes. */
const ROW_DEFS: ReadonlyArray<{ readonly def: string, readonly parseFunction: string, readonly kind: FieldKind }> = [
  { def: 'customRow', parseFunction: 'customEntriesOf', kind: 'row' },
  { def: 'aggregatedRow', parseFunction: 'aggregatedEntriesOf', kind: 'row' },
  { def: 'storeRow', parseFunction: 'storeEntriesOf', kind: 'row' },
  { def: 'categoryLabel', parseFunction: 'categoryMapOf', kind: 'label' },
  { def: 'storeCategory', parseFunction: 'storeCategoryMapOf', kind: 'label' },
]

/** The doc heading whose field table must list one definition's fields. */
const DOC_SECTIONS: ReadonlyArray<{ readonly def: string, readonly heading: string }> = [
  { def: 'customRow', heading: 'Row fields: custom schema' },
  { def: 'aggregatedRow', heading: 'Row fields: aggregated directory' },
  { def: 'storeRow', heading: 'Row fields: store directory' },
  { def: 'categoryLabel', heading: 'Category label fields: aggregated document' },
  { def: 'storeCategory', heading: 'Category label fields: store document' },
]

/**
 * Top-level document keys the sources publish beyond the schema's own fields,
 * documented in docs/catalog-source.md §7 (`name`, `generatedAt`, `sourceUrl`
 * on the bundled snapshot) and never a row field. `generatedAt` is the one the
 * plugin reads, in `src/snapshot.ts`.
 */
const DOCUMENT_EXTRAS: readonly string[] = ['name', 'generatedAt', 'sourceUrl']

/** The parsed entries of one document. */
function entriesOf(document: unknown): CatalogEntry[] {
  return parseCatalogDocument(document)
}

/** The required-name set of an `anyOf` block, deduplicated. */
function requiredUnion(branches: readonly JsonSchema[]): string[] {
  const names = new Set<string>()
  for (const branch of branches) for (const name of (branch.required ?? []) as string[]) names.add(name)
  return [...names].sort()
}

// --- the AST field scan ------------------------------------------------------

const SOURCES = readSourceTree(fileURLToPath(new URL('../src', import.meta.url)))
const READS = scanCatalogFieldReads(SOURCES)

/** The distinct keys one function reads off one shape, sorted. */
function readsIn(parseFunction: string, kind: FieldKind): string[] {
  return [...new Set(READS
    .filter(read => read.inFunction === parseFunction && read.kind === kind && !read.dynamic)
    .map(read => read.key))].sort()
}

/** Every key any source file reads off an audited shape, sorted. */
function readKeys(): string[] {
  return [...new Set(READS.filter(read => !read.dynamic).map(read => read.key))].sort()
}

/** The keys read off a document itself (not off a row), sorted. */
function documentReadKeys(): string[] {
  return [...new Set(READS.filter(read => read.kind === 'document' && !read.dynamic).map(read => read.key))].sort()
}

/** Every field any row or label definition declares, sorted. */
function allDeclaredFields(): string[] {
  const names = new Set<string>()
  for (const { def: name } of ROW_DEFS) for (const field of declaredFields(name)) names.add(field)
  for (const name of ['customDocument', 'aggregatedDocument', 'storeDocument']) {
    for (const field of declaredFields(name)) names.add(field)
  }
  return [...names].sort()
}

// --- the doc tables ----------------------------------------------------------

/** One doc field table: the header cells and the body rows, all normalised. */
function docTable(heading: string): { readonly header: string[], readonly rows: string[][] } {
  const lines = DOC.split(/\r?\n/u)
  const start = lines.findIndex(line => line.replace(/^#+\s*/u, '').trim().toLowerCase() === heading.toLowerCase())
  assert.notEqual(start, -1, `docs/catalog-source.md has no heading "${heading}"`)
  const raw: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('#')) break
    if (line.trimStart().startsWith('|')) { raw.push(line); continue }
    if (raw.length > 0) break
  }
  assert.equal(raw.length >= 3, true, `docs/catalog-source.md has no field table under "${heading}"`)
  const cells = (line: string): string[] => line
    .replace(/^\s*\|/u, '').replace(/\|\s*$/u, '')
    .split('|').map(cell => cell.replace(/`/gu, '').replace(/\s+/gu, ' ').trim())
  const header = cells(raw[0]!)
  assert.deepEqual(header, ['Field', 'Type', 'Required', 'Meaning'],
    `the table under "${heading}" must carry the Field/Type/Required/Meaning columns`)
  return { header, rows: raw.slice(2).map(cells) }
}

/** The fields one doc section's field table lists, in column 1. */
function docTableFields(heading: string): string[] {
  const fields = docTable(heading).rows.map(row => row[0]!).filter(name => name !== '')
  assert.equal(new Set(fields).size, fields.length, `the table under "${heading}" lists a field twice`)
  return [...fields].sort()
}

/** The Type cell a schema node must be documented as. */
function typeCellOf(node: JsonSchema): string {
  if (typeof node.$ref === 'string') return refTypeCell(String(node.$ref))
  if (Array.isArray(node.anyOf)) {
    return (node.anyOf as JsonSchema[]).map(branch => typeCellOf(branch)).join(' or ')
  }
  if (Array.isArray(node.type)) {
    return node.type.map(member => typeCellOf({ ...node, type: member })).join(' or ')
  }
  if (node.type === 'null') return 'null'
  if (node.type === 'string') {
    assert.equal(typeof node.maxLength, 'number', 'a string column needs a maxLength in the schema to state')
    return `string (≤${String(node.maxLength)})`
  }
  if (node.type === 'integer') {
    assert.equal(typeof node.minimum, 'number', 'an integer column needs a minimum in the schema to state')
    return `integer ≥ ${String(node.minimum)}`
  }
  throw new Error(`the doc-table renderer has no Type for ${JSON.stringify(node.type ?? node)}`)
}

/** The Type cell a `$ref` names, with the cap read off the definition itself. */
function refTypeCell(ref: string): string {
  const name = ref.replace('#/$defs/', '')
  if (name === 'npmPackageName') return `npm name (≤${String(def(name).maxLength)})`
  if (name === 'httpUrl') return 'http(s) URL'
  if (name === 'localizedText') return 'string or {en, zh}'
  if (name === 'installCommand') return 'install command'
  throw new Error(`the doc-table renderer has no Type for ${ref}`)
}

// --- grammars ----------------------------------------------------------------

/** The install-command pattern, derived from the parser's own two target grammars. */
function installCommandPattern(): string {
  const unanchored = (pattern: RegExp): string => pattern.source.replace(/^\^/u, '').replace(/\$$/u, '')
  const target = `(?:${unanchored(PACKAGE_NAME_PATTERN)}(?:@\\S+)?|${unanchored(GIT_TARGET_PATTERN)})`
  return `^dsh plugin (?:\\S+ )*add (?:\\S+ )*${target}$`
}

/** Whether the parser would call a store row carrying this command installable. */
function parserInstalls(command: string): boolean {
  const row = { categories: [{ id: 'tools' }], plugins: [{ name: 'A', install: command }] }
  return parseCatalogDocument(row)[0]?.installable === true
}

/** One row of a fixture document, by index. */
function fixtureRow(document: FixtureDocument, index: number): Record<string, unknown> {
  const row = document.plugins[index]
  assert.ok(row !== undefined, `the fixture has no row ${String(index)}`)
  return row
}

describe('contract drift guard: the parser, the schema and the doc', () => {
  it('the schema is made of exactly the definitions this contract guards', () => {
    assert.match(String(SCHEMA.$schema), /2020-12/u, 'the schema must declare JSON Schema 2020-12')
    assert.deepEqual(Object.keys(SCHEMA.$defs as Record<string, unknown>).sort(), KNOWN_DEFS,
      'a $defs entry was added or removed: it is part of the published contract, so add it here and to the guard below')
    const root = (SCHEMA.anyOf as JsonSchema[]).map(branch => String(branch.$ref))
    assert.deepEqual(root, ['#/$defs/customDocument', '#/$defs/aggregatedDocument', '#/$defs/storeDocument'],
      'the root must offer exactly the three document shapes')
  })

  it('every field the parser reads is declared by the schema', () => {
    for (const { def: name, parseFunction, kind } of ROW_DEFS) {
      assert.deepEqual(readsIn(parseFunction, kind), declaredFields(name),
        `${parseFunction}() and $defs/${name} disagree: a field the parser reads must be declared, and a declared field must be read`)
    }
    // The localized description object is read by localizedText(), a helper the
    // row functions share; its `{en, zh}` keys live in an anyOf branch.
    const branches = def('localizedText').anyOf as JsonSchema[]
    assert.deepEqual(readsIn('localizedText', 'localized'),
      Object.keys(branches[1]!.properties as Record<string, unknown>).sort())
    assert.deepEqual(documentReadKeys().filter(name => !DOCUMENT_EXTRAS.includes(name)), ['categories', 'plugins'])
    const documentDefs = ['customDocument', 'aggregatedDocument', 'storeDocument']
    const union = new Set(documentDefs.flatMap(name => declaredFields(name)))
    assert.deepEqual([...union].sort(), ['categories', 'plugins'],
      'the document-level fields the parser reads must be declared by the document shapes')
  })

  it('the scan covers the whole src/ tree, and nothing outside the declared fields is read', () => {
    // A scan that quietly stopped covering a file would report agreement it
    // never established, so the files that read the document are named here.
    const covered = SOURCES.map(source => source.path)
    for (const required of ['catalog.ts', 'snapshot.ts', 'snapshot-builder.ts']) {
      assert.equal(covered.includes(required), true, `the scan must cover src/${required}`)
    }
    assert.equal(READS.some(read => read.file === 'snapshot.ts'), true,
      'src/snapshot.ts reads the same document; a scan that does not report it is not covering the tree')
    const dynamic = READS.filter(read => read.dynamic)
    assert.deepEqual(dynamic.map(read => `${read.file}:${String(read.line)} ${read.kind}`
      + ` (${read.inFunction ?? 'top level'}) — audit it by hand or make the key a literal`), [],
    'a computed key cannot be compared with the schema')
    const declared = new Set([...allDeclaredFields(), ...DOCUMENT_EXTRAS])
    assert.deepEqual(readKeys().filter(key => !declared.has(key)), [],
      'a key read off a catalog document or row is not declared by the schema (or listed in DOCUMENT_EXTRAS)')
    assert.deepEqual(allDeclaredFields().filter(field => !readKeys().includes(field)), [],
      'a declared field that no source reads: the schema promises a field the parser ignores')
  })

  it('the drift scan catches each read spelling a text scan cannot', () => {
    /**
     * The five spellings the reviewer proved invisible, plus the second file
     * that reads the same document. Each body sits inside a function named
     * `parseCatalogDocument`, so the scan proves the receiver by provenance and
     * not by name — and the last case proves the same rules do NOT fire on
     * unrelated reads.
     */
    const PREAMBLE = 'function parseCatalogDocument(json: unknown): unknown[] {\n'
      + '  const rows = (json as { plugins?: unknown[] }).plugins as Record<string, unknown>[]\n'
      + '  const record = rows[0] as Record<string, unknown>\n'
    const cases: ReadonlyArray<{ readonly label: string, readonly source: string, readonly key: string }> = [
      { label: 'destructuring', source: `${PREAMBLE}  const { license } = record\n  return [license]\n}\n`, key: 'license' },
      { label: 'optional chain', source: `${PREAMBLE}  return [record?.deprecated]\n}\n`, key: 'deprecated' },
      { label: 'index access', source: `${PREAMBLE}  return [record['quarantined']]\n}\n`, key: 'quarantined' },
      {
        label: 'dynamic key set',
        source: `${PREAMBLE}  return Object.keys(record).filter(name => name === 'archived')\n}\n`,
        key: '',
      },
      {
        label: 'read moved into a helper',
        source: `${PREAMBLE}  const revokedOf = (row: Record<string, unknown>): boolean => row.revoked === true\n  return [revokedOf(record)]\n}\n`,
        key: 'revoked',
      },
      {
        label: 'a second file reading the same document',
        source: 'declare function parseCatalogDocument(json: unknown): unknown[]\n'
          + 'const document: Record<string, unknown> = {}\n'
          + 'parseCatalogDocument(document)\n'
          + 'export const rows = document.plugins\n'
          + 'export const at = document.generatedAt\n'
          + 'export const extra = document.manifestVersion\n',
        key: 'manifestVersion',
      },
    ]
    for (const { label, source, key } of cases) {
      const reads = scanCatalogFieldReads([{ path: `${label}.ts`, text: source }])
      if (key === '') {
        assert.deepEqual(reads.filter(read => read.dynamic).map(read => read.kind), ['row'],
          `${label}: a computed key set must be reported as an unauditable read`)
        continue
      }
      assert.equal(reads.some(read => read.key === key && !read.dynamic), true,
        `${label}: the scan must report the "${key}" read, not just the reads it happens to recognise`)
      assert.equal(reads.some(read => read.key === key && read.dynamic), false, `${label}: "${key}" is a literal key`)
    }
    // Provenance, not names: the reads the guard must NOT claim.
    const unrelated = scanCatalogFieldReads([{
      path: 'unrelated.ts',
      text: 'export function describe(error: Error, options: { profile: string }): string {\n'
        + '  return `${options.profile}: ${error.message}`\n}\n',
    }])
    assert.deepEqual(unrelated, [], 'a read off something that never entered through parseCatalogDocument is not drift')
  })

  it('the doc field tables list the declared fields with their Type and Required', () => {
    for (const { def: name, heading } of DOC_SECTIONS) {
      const table = docTable(heading)
      assert.deepEqual(docTableFields(heading), declaredFields(name),
        `docs/catalog-source.md section "${heading}" and $defs/${name} disagree`)
      const properties = def(name).properties as Record<string, JsonSchema>
      const required = new Set((def(name).required ?? []) as string[])
      const conditional = new Set(requiredUnion((def(name).anyOf ?? []) as JsonSchema[]))
      for (const row of table.rows) {
        const field = row[0]!
        const held = properties[field]
        assert.ok(held !== undefined, `"${heading}" documents a field $defs/${name} does not declare`)
        const requirement = required.has(field) ? 'yes' : conditional.has(field) ? 'conditional' : 'no'
        assert.equal(row[1], typeCellOf(held),
          `"${heading}"/${field}: the Type column must state the schema's own type`)
        assert.equal(row[2], requirement,
          `"${heading}"/${field}: the Required column must match $defs/${name} (required + anyOf)`)
      }
    }
  })

  it('the sniff rules are the schema routing rules, and the install pattern is the parser\'s own grammar', () => {
    // `isAggregatedDocument` decides on the presence of npm/category, which is
    // what makes a row an aggregated row and never a custom one.
    const sniffed = readsIn('isAggregatedDocument', 'row')
    const customNot = (def('customRow').not as JsonSchema)
    assert.deepEqual(sniffed, requiredUnion(customNot.anyOf as JsonSchema[]))
    assert.deepEqual(sniffed, requiredUnion(def('aggregatedRow').anyOf as JsonSchema[]))
    // `isStoreDocument` needs an install command, and its sniff literal is the
    // install command pattern's own prefix.
    assert.deepEqual(readsIn('isStoreDocument', 'row'), ['install'])
    assert.equal(IMPL.includes("record.install.trim().startsWith('dsh plugin ')"), true,
      'src/catalog.ts: the store sniff no longer keys on a `dsh plugin ` command')
    assert.equal(String(def('installCommand').pattern).startsWith('^dsh plugin '), true,
      'the install command pattern must start where the store sniffer looks')
    assert.equal((def('storeRow').required as string[]).includes('install'), true)
    assert.equal((def('storeDocument').required as string[]).includes('categories'), true)
    // The two category structures are the decisive difference between the
    // store shape and the aggregated one.
    assert.equal((def('aggregatedDocument').properties as Record<string, JsonSchema>).categories?.type, 'object')
    assert.equal((def('storeDocument').properties as Record<string, JsonSchema>).categories?.type, 'array')
    // The published install grammar IS the parser's two target grammars spliced
    // together: a hand-written prefix (`^dsh plugin .+ add \S+$`) accepted
    // `add !!!` and `add ./a-dir` while refusing a line the live source serves.
    assert.equal(String(def('installCommand').pattern), installCommandPattern(),
      'the install pattern must be derived from PACKAGE_NAME_PATTERN and GIT_TARGET_PATTERN, not restated by hand')
    assert.equal(PACKAGE_NAME_PATTERN.source.includes('\\/'), true, 'the npm grammar must be the parser\'s own')
  })
})

describe('contract conformance: the shapes the parser accepts', () => {
  it('accepts the bundled offline snapshot', () => {
    const errors = validateSchema(SCHEMA, SNAPSHOT)
    assert.deepEqual(errors, [], `src/catalog-snapshot.json no longer validates:\n${errors.slice(0, 5).join('\n')}`)
    // Sanity: the schema is not passing because the document carries nothing,
    // and the parser reads it through the aggregated branch (the snapshot's own
    // `page` becoming the entry id is that branch's id derivation).
    const plugins = (SNAPSHOT as { plugins?: { page?: unknown }[] }).plugins
    assert.equal(Array.isArray(plugins) && plugins.length > 100, true)
    const entries = entriesOf(SNAPSHOT)
    assert.equal(entries.length >= 100, true, 'the snapshot must still parse into a usable catalog')
    assert.equal(entries[0]?.id, plugins?.[0]?.page)
  })

  it('accepts a minimal document of every shape, on its own branch only', () => {
    const documents: ReadonlyArray<{ readonly label: string, readonly document: unknown, readonly branch: string }> = [
      {
        label: 'custom',
        document: { plugins: [{ package: 'pkg-a', name: 'A', description: 'd' }] },
        branch: 'customDocument',
      },
      {
        label: 'aggregated (npm: null, git target)',
        document: { plugins: [{ name: 'A', description: 'd', category: 'tools', npm: null, install: `dsh plugin --profile web add github:owner/repo#${SHA}` }] },
        branch: 'aggregatedDocument',
      },
      {
        label: 'store',
        document: { categories: [{ id: 'tools', zh: '工具' }], plugins: [{ name: 'A', install: 'dsh plugin --profile web add pkg-a' }] },
        branch: 'storeDocument',
      },
    ]
    for (const { label, document, branch } of documents) {
      assert.deepEqual(validateSchema(SCHEMA, document), [], `the minimal ${label} document must validate`)
      for (const candidate of ['customDocument', 'aggregatedDocument', 'storeDocument']) {
        const errors = validateSchema(def(candidate), document, SCHEMA)
        assert.equal(errors.length === 0, candidate === branch,
          `the minimal ${label} document must be read as ${branch}, not as ${candidate}`)
      }
      assert.equal(entriesOf(document).length, 1, `the minimal ${label} document must parse into one row`)
    }
  })

  it('refuses the documented counter-examples, and degrades them the way the doc says', () => {
    const cases: ReadonlyArray<{ readonly label: string, readonly document: unknown, readonly parser: (entries: CatalogEntry[]) => void }> = [
      {
        label: 'a custom row without a package',
        document: { plugins: [{ name: 'A', description: 'd' }] },
        parser: entries => assert.equal(entries.length, 0, 'a row without a package is dropped'),
      },
      {
        label: 'a custom row whose description is an {en, zh} object',
        document: { plugins: [{ package: 'pkg-a', name: 'A', description: { zh: 'd' } }] },
        parser: entries => assert.equal(entries.length, 0, 'the custom shape does not localize descriptions'),
      },
      {
        label: 'a custom row whose homepage is not http(s)',
        document: { plugins: [{ package: 'pkg-a', name: 'A', description: 'd', homepage: 'javascript:alert(1)' }] },
        parser: entries => assert.equal(entries.length, 0, 'an unusable homepage drops the custom row'),
      },
      {
        label: 'an aggregated row without a description',
        document: { plugins: [{ name: 'A', category: 'tools' }] },
        parser: entries => assert.equal(entries.length, 0),
      },
      {
        label: 'an aggregated row with neither npm nor category',
        document: { plugins: [{ name: 'A', description: 'd' }] },
        parser: entries => assert.equal(entries.length, 0, 'the document routes to the custom shape, where the row has no package'),
      },
      {
        label: 'a store row without an install command',
        document: { categories: [{ id: 'tools' }], plugins: [{ name: 'A' }] },
        parser: entries => assert.equal(entries.length, 0, 'without the sniffed command the document is not a store document'),
      },
      {
        label: 'a later store row without an install command',
        document: { categories: [{ id: 'tools' }], plugins: [{ name: 'A', install: 'dsh plugin --profile web add pkg-a' }, { name: 'B' }] },
        parser: entries => {
          assert.equal(entries.length, 2, 'only the first row decides the shape')
          assert.equal(entries[1]?.installable, false)
          assert.equal(entries[1]?.package, 'B')
        },
      },
      {
        label: 'a store document whose categories is an object map',
        document: { categories: { tools: { zh: '工具' } }, plugins: [{ name: 'A', install: 'dsh plugin --profile web add pkg-a' }] },
        parser: entries => assert.equal(entries.length, 0, 'the array is what identifies the store shape'),
      },
      {
        label: 'a store row whose install command names no target',
        document: { categories: [{ id: 'tools' }], plugins: [{ name: 'A', install: 'npm install pkg-a' }] },
        parser: entries => assert.equal(entries.length, 0),
      },
      {
        label: 'an aggregated row with a negative star count',
        document: { plugins: [{ name: 'A', description: 'd', category: 'tools', stars: -1 }] },
        parser: entries => {
          assert.equal(entries.length, 1, 'a display counter is ignored, not fatal')
          assert.equal(entries[0]?.stars, undefined)
        },
      },
      {
        label: 'a custom row with an over-long name',
        document: { plugins: [{ package: 'pkg-a', name: 'A'.repeat(401), description: 'd' }] },
        parser: entries => assert.equal(entries.length, 0, 'an over-cap required value drops the row'),
      },
      {
        label: 'an aggregated row with a string star count',
        document: { plugins: [{ name: 'A', description: 'd', category: 'tools', stars: '12' }] },
        parser: entries => {
          assert.equal(entries.length, 1, 'a display counter is ignored, not fatal')
          assert.equal(entries[0]?.stars, undefined)
        },
      },
      {
        label: 'an aggregated row whose npm name is unusable',
        document: { plugins: [{ name: 'A', description: 'd', category: 'tools', npm: 'not a package name' }] },
        parser: entries => {
          assert.equal(entries.length, 1, 'the row stays browsable as source-only')
          assert.equal(entries[0]?.installable, false)
        },
      },
      {
        label: 'a store row with an empty description',
        document: { categories: [{ id: 'tools' }], plugins: [{ name: 'A', install: 'dsh plugin --profile web add pkg-a', description: '' }] },
        parser: entries => {
          assert.equal(entries.length, 1)
          assert.equal(entries[0]?.description, '')
        },
      },
      {
        label: 'a document without a plugins array',
        document: { name: 'x' },
        parser: entries => assert.equal(entries.length, 0),
      },
      {
        label: 'a bare array',
        document: [{ package: 'pkg-a', name: 'A', description: 'd' }],
        parser: entries => assert.equal(entries.length, 0),
      },
    ]
    for (const { label, document, parser } of cases) {
      assert.equal(validateSchema(SCHEMA, document).length > 0, true, `${label}: the schema must refuse it`)
      parser(entriesOf(document))
    }
  })

  it('the documented routing hazard really loses the install target', () => {
    // docs/catalog-source.md §2: one `category` key on the first row moves the
    // whole document to the aggregated shape, where `package` is not read. The
    // schema accepts the document (it IS a conforming aggregated document) — it
    // only refuses to call the row a custom row, which is the point.
    const document = { plugins: [{ package: 'pkg-a', name: 'A', description: 'd', category: 'tools' }] }
    assert.deepEqual(validateSchema(SCHEMA, document), [])
    const errors = validateSchema(def('customRow'), (document.plugins as unknown[])[0], SCHEMA)
    assert.equal(errors.length > 0, true, 'a custom row must not carry a routing field')
    const entries = entriesOf(document)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.package, 'A', 'the declared package is not the install target any more')
    assert.equal(entries[0]?.installable, false)
  })
})

describe('contract conformance: the documents the live sources serve', () => {
  it('validates an unedited excerpt of the primary directory, nulls and all', () => {
    const errors = validateSchema(SCHEMA, REAL_AGGREGATED)
    assert.deepEqual(errors, [], `tests/fixtures/real-aggregated-rows.json no longer validates:\n${errors.slice(0, 5).join('\n')}`)
    // The null form: the primary directory writes `"version": null` and
    // `"downloads": null` (2177 and 2179 of its 4527 rows), and the row that
    // carries them must be the one the parser keeps.
    const sourceOnly = fixtureRow(REAL_AGGREGATED, 2)
    assert.equal(sourceOnly.npm, null)
    assert.equal(sourceOnly.version, null)
    assert.equal(sourceOnly.downloads, null)
    assert.deepEqual(entriesOf(REAL_AGGREGATED).map(entry => ({
      name: entry.name,
      package: entry.package,
      version: entry.version,
      downloads: entry.downloads,
      installable: entry.installable,
      category: entry.category,
      categoryId: entry.categoryId,
      gitTarget: entry.gitTarget,
    })), [
      {
        name: 'dsh-gungnir', package: 'dsh-gungnir', version: '0.2.1', downloads: 1310,
        installable: true, category: 'AGI 架构探索', categoryId: 'agi', gitTarget: undefined,
      },
      {
        name: 'dsh-j-space', package: '@anonyjcy/dsh-j-space', version: '1.2.3', downloads: 1982,
        installable: true, category: 'AGI 架构探索', categoryId: 'agi', gitTarget: undefined,
      },
      {
        name: 'dsh-quality-review', package: 'https://awesome-dsh-plugin.com/p/CAI-MH/dsh-quality-review/',
        version: undefined, downloads: undefined, installable: true, category: 'AGI 架构探索',
        categoryId: 'agi', gitTarget: 'github:CAI-MH/dsh-quality-review',
      },
    ])
  })

  it('validates the real store line whose flags sit between `add` and its target', () => {
    const errors = validateSchema(SCHEMA, REAL_STORE)
    assert.deepEqual(errors, [], `tests/fixtures/real-store-rows.json no longer validates:\n${errors.slice(0, 5).join('\n')}`)
    const line = String(fixtureRow(REAL_STORE, 0).install)
    assert.equal(line, 'dsh plugin --profile web add --allow-build=@dsh-external/dsh-super-injector github:yjh051108/dsh-routing-suite')
    const pattern = new RegExp(String(def('installCommand').pattern))
    assert.equal(pattern.test(line), true, 'the published pattern must accept the command the store really publishes')
    const entries = entriesOf(REAL_STORE)
    assert.equal(entries.length, 2, 'the parser keeps both real store rows')
    // The judged pair, exactly as docs/catalog-source.md §7 records it: the
    // schema accepts the command (its trailing token IS a git target), and the
    // parser cannot extract that target (its `add` token is not the
    // second-to-last one), so the row stays browsable and not installable.
    assert.equal(parserInstalls(line), false)
    assert.equal(entries[0]?.installable, false)
    assert.equal(entries[0]?.gitTarget, undefined)
    assert.equal(entries[0]?.package, 'yjh051108/dsh-routing-suite')
    assert.equal(entries[1]?.package, '@tt-a1i/archify-dsh')
    assert.equal(entries[1]?.installable, true)
  })

  it('the rows the schema refuses are the rows the parser cannot install from either', () => {
    const errors = validateSchema(SCHEMA, REAL_REFUSED)
    assert.equal(errors.length > 0, true, 'a row naming no usable target is not a conforming source')
    for (const row of REAL_REFUSED.plugins) {
      const install = String(row.install)
      const pattern = new RegExp(String(def('installCommand').pattern))
      assert.equal(pattern.test(install), false, `the pattern must refuse ${install}`)
      assert.equal(parserInstalls(install), false, `the parser must find no target in ${install}`)
    }
    // Both rows are repo-path titles with no npm identity, which is the other
    // documented drop: the `#` rule in the aggregated path.
    assert.deepEqual(entriesOf(REAL_REFUSED), [])
  })
})

describe('contract semantics: what each declared field does', () => {
  /** Two conforming values per declared field, so a value change must show up. */
  interface ShapeFixture {
    readonly def: string
    readonly document: (row: Record<string, unknown>) => unknown
    readonly values: Record<string, readonly [unknown, unknown]>
  }

  const CUSTOM: ShapeFixture = {
    def: 'customRow',
    document: row => ({ plugins: [row] }),
    values: {
      id: ['id-a', 'id-b'],
      name: ['Name A', 'Name B'],
      description: ['Desc A', 'Desc B'],
      package: ['pkg-a', 'pkg-b'],
      version: ['1.0.0', '2.0.0'],
      homepage: ['https://a.example.com', 'https://b.example.com'],
    },
  }

  const AGGREGATED: ShapeFixture = {
    def: 'aggregatedRow',
    document: row => ({ name: 'dir', categories: { 'cat-a': { zh: 'Label A' }, 'cat-b': { zh: 'Label B' } }, plugins: [row] }),
    values: {
      name: ['Name A', 'Name B'],
      description: ['Desc A', 'Desc B'],
      page: ['https://dir.example.com/a', 'https://dir.example.com/b'],
      url: ['https://github.com/owner/a', 'https://github.com/owner/b'],
      npm: ['pkg-a', 'pkg-b'],
      install: ['dsh plugin --profile web add github:owner/a', 'dsh plugin --profile web add github:owner/b'],
      version: ['1.0.0', '2.0.0'],
      owner: ['owner-a', 'owner-b'],
      stars: [1, 2],
      downloads: [3, 4],
      category: ['cat-a', 'cat-b'],
      categoryId: ['cid-a', 'cid-b'],
    },
  }

  const STORE: ShapeFixture = {
    def: 'storeRow',
    document: row => ({ categories: [{ id: 'cat-a', zh: 'Label A' }, { id: 'cat-b', zh: 'Label B' }], plugins: [row] }),
    values: {
      id: ['id-a', 'id-b'],
      name: ['Name A', 'Name B'],
      description: ['Desc A', 'Desc B'],
      url: ['https://github.com/owner/a', 'https://github.com/owner/b'],
      category: ['cat-a', 'cat-b'],
      categoryId: ['cid-a', 'cid-b'],
      install: ['dsh plugin --profile web add pkg-a', 'dsh plugin --profile web add pkg-b'],
      installs30d: [1, 2],
      owner: ['owner-a', 'owner-b'],
      stars: [3, 4],
    },
  }

  const SHAPES: readonly ShapeFixture[] = [CUSTOM, AGGREGATED, STORE]

  /** One row built entirely from the 'A' column of a fixture's values. */
  const rowOf = (shape: ShapeFixture): Record<string, unknown> =>
    Object.fromEntries(Object.entries(shape.values).map(([field, [first]]) => [field, first]))

  it('the fixture table covers exactly the declared fields', () => {
    for (const shape of SHAPES) {
      assert.deepEqual(Object.keys(shape.values).sort(), declaredFields(shape.def),
        `the ${shape.def} fixture table is out of step with $defs/${shape.def}: every declared field needs a pair of values to exercise it with`)
    }
  })

  it('every declared field is really read: changing its value changes the parsed row', () => {
    for (const shape of SHAPES) {
      const base = rowOf(shape)
      assert.deepEqual(validateSchema(def(shape.def), base, SCHEMA), [], `the ${shape.def} fixture row must be a conforming row`)
      for (const [field, [first, second]] of Object.entries(shape.values)) {
        assert.deepEqual(validateSchema(def(shape.def), { ...base, [field]: second }, SCHEMA), [],
          `${shape.def}/${field}: both fixture values must be conforming`)
        const left = entriesOf(shape.document({ ...base, [field]: first }))[0]
        const right = entriesOf(shape.document({ ...base, [field]: second }))[0]
        assert.notEqual(left, undefined, `${shape.def}/${field}: the row must survive parsing`)
        assert.notEqual(right, undefined, `${shape.def}/${field}: the row must survive parsing`)
        assert.notDeepEqual(left, right,
          `${shape.def}/${field}: two different values parsed to the same entry, so nothing reads the field`)
      }
    }
  })

  it('the doc\'s documented drop rules are the parser\'s: `#` names, zh-first labels, category maps', () => {
    // docs/catalog-source.md §4: a name carrying '#' is a repository path, not
    // a title. 192 of the primary source's 4527 rows are switches for this
    // rule, so it is a rule with real reach — and it had no test at all.
    const pathRow = { name: 'owner/repo#packages/thing', description: 'd', category: 'tools', npm: null }
    assert.deepEqual(validateSchema(def('aggregatedRow'), pathRow, SCHEMA), [], 'the row itself conforms; the rule is the parser\'s')
    assert.deepEqual(entriesOf({ categories: { tools: { zh: 'Tools' } }, plugins: [pathRow] }), [],
      'a path-shaped name with no usable npm name is dropped')
    const titled = { name: 'owner/repo#packages/thing', description: 'd', category: 'tools', npm: 'pkg-a' }
    const entries = entriesOf({ categories: { tools: { zh: 'Tools' } }, plugins: [titled] })
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.name, 'pkg-a', 'a real npm name becomes the display title')
    assert.equal(entries[0]?.package, 'pkg-a')
    // §4: `zh` wins over `en`; `en` alone is the fallback; neither drops the row.
    const localized = (description: unknown): string | undefined =>
      entriesOf({ categories: { tools: { zh: 'Tools' } }, plugins: [{ name: 'A', description, category: 'tools' }] })[0]?.description
    assert.equal(localized({ en: 'EN', zh: 'ZH' }), 'ZH')
    assert.equal(localized({ en: 'EN' }), 'EN')
    assert.equal(localized('plain'), 'plain')
    assert.equal(localized({}), undefined, 'a row without usable copy is dropped')
    // §4/§5: a category label resolves through the document's own map, zh
    // first, and falls back to the raw id when the map is silent.
    const labelled = (document: unknown, row: unknown): CatalogEntry | undefined => entriesOf({ ...(document as object), plugins: [row] })[0]
    assert.equal(labelled({ categories: { tools: { en: 'Tools', zh: '工具' } } }, { name: 'A', description: 'd', category: 'tools' })?.category, '工具')
    assert.equal(labelled({ categories: { tools: { en: 'Tools' } } }, { name: 'A', description: 'd', category: 'tools' })?.category, 'Tools')
    assert.equal(labelled({ categories: {} }, { name: 'A', description: 'd', category: 'tools' })?.category, 'tools', 'an unmapped id is its own label')
    assert.equal(labelled({ categories: {} }, { name: 'A', description: 'd', category: 'tools' })?.categoryId, 'tools')
    // §5: the store path reads an ARRAY of {id, en, zh}, same preference.
    const storeLabel = (categories: readonly unknown[], category: string): CatalogEntry | undefined =>
      entriesOf({ categories, plugins: [{ name: 'A', install: 'dsh plugin --profile web add pkg-a', category }] })[0]
    assert.equal(storeLabel([{ id: 'tools', en: 'Tools', zh: '工具' }], 'tools')?.category, '工具')
    assert.equal(storeLabel([{ id: 'tools', en: 'Tools' }], 'tools')?.category, 'Tools')
    assert.equal(storeLabel([], 'tools')?.category, 'tools')
    assert.equal(storeLabel([{ id: 'tools', zh: '工具' }], 'tools')?.categoryId, 'tools')
    // §5: an explicit categoryId is the filter key, and wins over `category`.
    const explicit = labelled({ categories: { 'cid-a': { zh: 'Canonical' }, drifted: { zh: 'Drifted' } } },
      { name: 'A', description: 'd', category: 'drifted', categoryId: 'cid-a' })
    assert.equal(explicit?.categoryId, 'cid-a')
    assert.equal(explicit?.category, 'Canonical')
  })

  it('binds the npm grammar, the http(s) prefix and the install command to the parser', () => {
    assert.equal(def('npmPackageName').pattern, PACKAGE_NAME_PATTERN.source,
      'the published npm grammar must be the parser\'s own PACKAGE_NAME_PATTERN')
    // The URL rule is stated in catalog.ts as a literal regex; derive it from
    // the source text so a change there fails here rather than passing.
    const urlLiteral = '^https?:\\/\\/'
    assert.equal(IMPL.includes(urlLiteral), true, 'src/catalog.ts no longer states the http(s) URL rule as before')
    const implUrl = new RegExp(urlLiteral)
    for (const sample of ['https://a.example.com/x', 'http://a.example.com', 'https://', 'javascript:alert(1)', 'ftp://a.example.com', 'HTTPS://a.example.com']) {
      assert.equal(new RegExp(String(def('httpUrl').pattern)).test(sample), implUrl.test(sample),
        `the published URL pattern must judge ${JSON.stringify(sample)} exactly as the parser does`)
    }
    // The command pattern is the parser's target grammar, so every command it
    // accepts names a target the install chain can act on, and every command
    // the parser can act on is one it accepts (asserted pair by pair below).
    const command = new RegExp(String(def('installCommand').pattern))
    for (const [accepted, parserVerdict] of [
      ['dsh plugin --profile web add pkg-a', true],
      ['dsh plugin --profile web add @scope/pkg@1.2.3', true],
      [`dsh plugin --profile dsh-app add github:owner/repo#${SHA}`, true],
      ['dsh plugin --profile web add github:owner/repo', true],
      ['dsh plugin add pkg-a', true],
      ['dsh plugin nonsense add !!!', false],
      ['dsh plugin --profile web add ./a-local-dir', false],
      ['dsh plugin --profile web add https://example.com/x.tgz', false],
      ['dsh plugin --profile web add "https://example.com/x.tgz"', false],
      ['dsh plugin --profile web remove pkg-a', false],
      ['dsh plugin --profile web add', false],
      ['dsh plugin --profile web add github:owner/repo#main', false],
      [`dsh plugin --profile web add github:owner/repo#${SHA}`, true],
      ['dsh plugin --profile web add github:owner/repo#path:packages/x', false],
    ] as ReadonlyArray<readonly [string, boolean]>) {
      assert.equal(command.test(accepted), parserVerdict, `the install command pattern must judge ${accepted}`)
      assert.equal(parserInstalls(accepted), parserVerdict, `the parser must judge ${accepted} the same way`)
    }
    // The two documented differences (§7): the pattern has no `i` flag.
    for (const strict of [
      'dsh plugin --profile web add GitHub:owner/repo',
      `dsh plugin --profile web add github:owner/repo#${SHA.toUpperCase()}`,
    ]) {
      assert.equal(command.test(strict), false, `the published pattern is case-sensitive, as the doc records: ${strict}`)
      assert.equal(parserInstalls(strict), true, `the parser accepts it case-insensitively: ${strict}`)
    }
  })

  it('the git grammar and the repository-identity requirement are the implementation\'s', () => {
    assert.equal(GIT_TARGET_PATTERN.test('github:owner/repo'), true)
    assert.equal(GIT_TARGET_PATTERN.test(`github:owner/repo#${SHA}`), true)
    for (const refused of ['github:owner/repo#main', 'github:owner/repo#v1.0.0', `github:owner/repo#${SHA}#path:packages/x`, 'git+https://github.com/owner/repo', 'https://github.com/owner/repo', 'gitlab:owner/repo']) {
      assert.equal(GIT_TARGET_PATTERN.test(refused), false, `the contract must keep refusing ${refused}`)
    }
    const gitRow = {
      name: 'A',
      description: 'd',
      page: 'https://dir.example.com/p/owner/repo/',
      npm: null,
      category: 'tools',
      install: `dsh plugin --profile web add github:owner/repo#${SHA}`,
    }
    const withoutHomepage = entriesOf({ categories: { tools: { zh: '工具' } }, plugins: [gitRow] })[0]
    assert.equal(withoutHomepage?.gitTarget, `github:owner/repo#${SHA}`, 'a commit pin is preserved verbatim')
    // The install intent refuses a git row whose repository it cannot identify
    // (src/install-intent.ts: `repoKeyOf(entry.homepage)` must not be null).
    assert.equal(repoKeyOf(withoutHomepage?.homepage), null, 'a git row without a repository page proves no identity')
    const withHomepage = entriesOf({ categories: { tools: { zh: '工具' } }, plugins: [{ ...gitRow, url: 'https://github.com/owner/repo' }] })[0]
    assert.equal(repoKeyOf(withHomepage?.homepage), 'github.com/owner/repo')
    assert.equal(withHomepage?.installable, true)
  })
})

describe('contract vocabulary: the validator refuses what it does not implement', () => {
  it('throws on a schema carrying a keyword no instance would reach', () => {
    const cases: ReadonlyArray<{ readonly label: string, readonly schema: JsonSchema }> = [
      { label: 'oneOf in a property the instance does not carry', schema: { type: 'object', properties: { x: { oneOf: [{ type: 'string' }] } } } },
      { label: 'patternProperties in the items of an empty array', schema: { type: 'object', properties: { p: { type: 'array', items: { patternProperties: { '^a': {} } } } } } },
      { label: 'unevaluatedProperties in an anyOf branch that never matched', schema: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', unevaluatedProperties: false }] } },
      { label: 'enum in an unreferenced $defs entry', schema: { type: 'object', $defs: { unused: { enum: [1] } } } },
      { label: 'allOf at the root', schema: { allOf: [{ type: 'object' }] } },
      { label: 'if/then at the root', schema: { if: { type: 'object' }, then: { required: ['a'] } } },
      { label: 'an unknown type name in an absent property', schema: { type: 'object', properties: { x: { type: 'weird' } } } },
      { label: 'a pattern that does not compile', schema: { type: 'object', properties: { x: { type: 'string', pattern: '(' } } } },
      {
        label: 'the whole reviewer experiment in one schema',
        schema: {
          oneOf: [{ type: 'object' }],
          allOf: [{ type: 'object' }],
          properties: { plugins: { type: 'array', items: { patternProperties: { '^a': {} }, unevaluatedProperties: false } } },
          if: { type: 'object' },
          then: { required: ['a'] },
        },
      },
    ]
    for (const { label, schema } of cases) {
      assert.throws(() => validateSchema(schema, {}), UnsupportedSchemaError,
        `${label}: a schema defect outside the walked instance must still be an error`)
    }
    assert.deepEqual(validateSchema({ type: 'object', properties: { x: { type: 'string' } } }, {}), [],
      'the audit must not fire on a schema the validator does implement')
  })

  it('audits the whole document, $defs included, before judging any instance', () => {
    // The reviewer's suite-level reproduction: a keyword planted in a node no
    // store document ever carries used to leave this file 12/12 green.
    for (const [label, mutate] of [
      ['const on $defs/storeCategory.properties.en', (schema: JsonSchema) => { ((schema.$defs as Record<string, JsonSchema>).storeCategory!.properties as Record<string, JsonSchema>).en!.const = 'IMPOSSIBLE-LABEL' }],
      ['oneOf on $defs/aggregatedRow.properties.downloads', (schema: JsonSchema) => { (((schema.$defs as Record<string, JsonSchema>).aggregatedRow!.properties as Record<string, JsonSchema>).downloads as JsonSchema).oneOf = [{ type: 'integer' }] }],
      ['enum on a $defs entry nothing references', (schema: JsonSchema) => { (schema.$defs as Record<string, JsonSchema>).unused = { enum: [1] } }],
    ] as ReadonlyArray<readonly [string, (schema: JsonSchema) => void]>) {
      const patched = structuredClone(SCHEMA) as JsonSchema
      mutate(patched)
      const storeDocument = { categories: [{ id: 'tools', zh: '工具' }], plugins: [{ name: 'A', install: 'dsh plugin --profile web add pkg-a' }] }
      assert.throws(() => validateSchema(patched, storeDocument), UnsupportedSchemaError,
        `${label}: a published schema carrying an unimplemented keyword must fail the suite, not pass it`)
      assert.throws(() => validateSchema(def('customRow'), { package: 'pkg-a', name: 'A', description: 'd' }, patched),
        UnsupportedSchemaError, `${label}: the audit must cover the root a $ref resolves against, not just the node passed in`)
    }
  })
})

describe('contract publication: the artefacts an outside author can reach', () => {
  it('the schema $id is a resolvable URI, not a reserved example domain', () => {
    const id = String(SCHEMA.$id)
    const parsed = new URL(id)
    assert.equal(parsed.protocol, 'https:', 'an outside author needs an id a resolver can fetch')
    assert.equal(/\.example$/u.test(parsed.hostname), false, 'RFC 2606 reserves .example: it can never resolve')
    assert.equal(/^urn:/u.test(id) || parsed.hostname !== '', true)
    // A fragment parser must resolve a local $ref against it, and an $id must
    // not carry a fragment of its own (RFC 3986; JSON Schema 2020-12 §9.1).
    assert.equal(parsed.hash, '', 'a schema $id must not carry a fragment')
    const resolved = new URL('#/$defs/aggregatedRow', id)
    assert.equal(`${resolved.origin}${resolved.pathname}`, `${parsed.origin}${parsed.pathname}`)
    assert.equal(resolved.hash, '#/$defs/aggregatedRow')
    assert.equal(id.endsWith('docs/catalog-source.schema.json'), true,
      'the id must point at the file the plugin actually ships')
  })

  it('ships the contract documents with the plugin', () => {
    assert.equal(MANIFEST.files.includes('docs'), true,
      'package.json `files` must ship docs/, or an installer cannot read the contract it is asked to follow')
    for (const name of ['catalog-source.md', 'catalog-source.schema.json']) {
      assert.equal(existsSync(fileURLToPath(new URL(`../docs/${name}`, import.meta.url))), true, `docs/${name} is missing`)
    }
    assert.equal(MANIFEST.version, '0.6.6',
      'shipping a new file to existing installations changes the plugin, so its version travels with the contract')
  })
})
