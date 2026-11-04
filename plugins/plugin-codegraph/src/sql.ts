/**
 * SQL: the objects a migration creates, and what they refer to.
 *
 * Why a scanner instead of a grammar. Every other language here is read with a
 * tree-sitter grammar the plugin ships or downloads, and SQL is not: the pinned grammar
 * package carries sixteen languages and SQL is not one of them, so a grammar would mean
 * a second download source to pin, verify for ABI compatibility and re-verify on every
 * bump — for the one language whose declarations are a handful of `CREATE` keywords.
 * `CREATE TABLE`, `CREATE VIEW` and `REFERENCES` are not ambiguous the way a C
 * expression is, so a scanner reads them as reliably as a tree would.
 *
 * What this is not: a SQL parser. It does not resolve schemas, understand `SELECT`
 * lists, or follow a CTE. It answers one question — which named objects does this file
 * declare, and which named objects does it mention — and it answers it the same way for
 * Postgres, MySQL, SQLite and a Prisma migration dump.
 *
 * @module @dsh-app/plugin-codegraph/host/sql
 */

import type { ParsedFile } from './parse.ts'
import type { SymbolKind, SymbolRecord } from './store.ts'

/** What one `CREATE` keyword declares, in the kinds this graph already has. */
const DECLARATIONS: readonly { readonly pattern: RegExp, readonly kind: SymbolKind }[] = [
  // A table is a record shape: `struct` is what the graph already calls one, and it keeps
  // `kind:` filters meaningful (`kind:struct` answers "show me the data model").
  { pattern: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`[\]]+)/iu, kind: 'struct' },
  { pattern: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`[\]]+)/iu, kind: 'function' },
  { pattern: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([A-Za-z0-9_."`[\]]+)/iu, kind: 'function' },
  { pattern: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?TYPE\s+([A-Za-z0-9_."`[\]]+)/iu, kind: 'type' },
  { pattern: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?DOMAIN\s+([A-Za-z0-9_."`[\]]+)/iu, kind: 'type' },
]

/**
 * The statements that NAME an object.
 *
 * `FROM`, `JOIN` and `REFERENCES` are the interesting ones: they are how one migration
 * says it depends on a table another migration created, which is the edge `impact`
 * needs. The data statements are included for the same reason — "what touches this
 * table" is the question a reader has before changing it.
 */
const REFERENCES: readonly RegExp[] = [
  /\bREFERENCES\s+([A-Za-z0-9_."`[\]]+)/giu,
  /\b(?:FROM|JOIN)\s+([A-Za-z0-9_."`[\]]+)/giu,
  /\bINSERT\s+INTO\s+([A-Za-z0-9_."`[\]]+)/giu,
  /\bUPDATE\s+([A-Za-z0-9_."`[\]]+)/giu,
  /\bDELETE\s+FROM\s+([A-Za-z0-9_."`[\]]+)/giu,
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z0-9_."`[\]]+)/giu,
]

/** Words that can follow `FROM` without naming an object (`SELECT * FROM (…)`). */
const NOT_A_NAME = new Set([
  'select', 'values', 'dual', 'lateral', 'only', 'unnest', 'generate_series', 'json_each',
  'jsonb_array_elements', 'information_schema', 'pg_catalog',
])

/** One `;`-terminated statement: its MASKED text, and the lines it spans. */
interface Statement {
  readonly text: string
  readonly startLine: number
  readonly endLine: number
}

/**
 * The source with everything that cannot end a statement blanked out.
 *
 * Same length, same newlines — only the CONTENT changes: a comment becomes spaces, and
 * the inside of a quoted string, a quoted identifier or a Postgres dollar-quoted body
 * becomes spaces too. Three constructs hide a semicolon that would otherwise split one
 * statement into pieces:
 *
 *   - a string literal (`'a;b'`),
 *   - a comment (`-- ;` or `/* ; *\/`),
 *   - a dollar-quoted body (`$$ BEGIN … END; $$`), which is where an entire function
 *     body lives. Missing this one turns every statement inside a function into its own
 *     "statement", and a scanner reading garbage can invent a declaration.
 *
 * Double quotes and backticks are treated differently from single quotes on purpose:
 * they name an IDENTIFIER, which is what `CREATE TABLE "audit"` needs read, while a
 * single quote opens a string whose contents are not SQL. So `'…'` is blanked and `"…"`
 * is kept — the one shape that would mislead is a MySQL double-quoted STRING holding a
 * semicolon, which no DDL migration does.
 *
 * @param source - the file's text.
 * @returns a same-length mask with quotes, comments and bodies blanked.
 */
export function maskedSql(source: string): string {
  const characters = source.split('')
  let quote: string | undefined
  let dollar: string | undefined
  let blockComment = false
  for (let at = 0; at < characters.length; at++) {
    const rest = source.slice(at, at + 16)
    const character = characters[at] as string
    if (blockComment) {
      if (rest.startsWith('*/')) {
        blockComment = false
        // Blank the terminator too: leaving `*/` in the mask puts it in front of the
        // NEXT statement, whose `^\s*CREATE` then never matches.
        characters[at] = ' '
        characters[at + 1] = ' '
        at++
        continue
      }
      if (character !== '\n') characters[at] = ' '
      continue
    }
    if (dollar !== undefined) {
      if (rest.startsWith(dollar)) {
        for (let index = at; index < at + dollar.length; index++) characters[index] = ' '
        at += dollar.length - 1
        dollar = undefined
        continue
      }
      if (character !== '\n') characters[at] = ' '
      continue
    }
    if (quote !== undefined) {
      // Only a STRING's contents are hidden. A double quote or a backtick names an
      // IDENTIFIER — `CREATE TABLE "audit"` needs its name read — so it is kept whole.
      const blank = quote === "'"
      // A doubled quote (`''`) is an escaped one: it stays inside the literal.
      if (character === quote && source[at + 1] === quote) {
        if (blank) { characters[at] = ' '; characters[at + 1] = ' ' }
        at++
        continue
      }
      if (character === quote) { quote = undefined; if (blank) characters[at] = ' '; continue }
      if (blank && character !== '\n') characters[at] = ' '
      continue
    }
    if (rest.startsWith('--')) {
      for (let index = at; index < characters.length && characters[index] !== '\n'; index++) characters[index] = ' '
      continue
    }
    if (rest.startsWith('/*')) {
      blockComment = true
      characters[at] = ' '
      characters[at + 1] = ' '
      at++
      continue
    }
    const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(rest)
    if (tag !== null) {
      dollar = tag[0]
      for (let index = at; index < at + dollar.length; index++) characters[index] = ' '
      at += dollar.length - 1
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      if (character === "'") characters[at] = ' '
    }
  }
  return characters.join('')
}

/**
 * Split a script into statements.
 *
 * @param source - the file's text.
 * @returns the statements, in order, with the lines they span.
 */
function statements(source: string): Statement[] {
  const mask = maskedSql(source)
  // One pass to know every offset's line, so the split below is a single scan.
  const lineAt = new Int32Array(mask.length + 1)
  let line = 1
  for (let at = 0; at < mask.length; at++) {
    lineAt[at] = line
    if (mask[at] === '\n') line++
  }
  lineAt[mask.length] = line
  const found: Statement[] = []
  let start = 0
  for (let at = 0; at <= mask.length; at++) {
    if (at < mask.length && mask[at] !== ';') continue
    // The MASK is what gets matched: a statement whose first line is a comment would
    // otherwise never match a `CREATE` pattern, because the comment is still text.
    const text = mask.slice(start, at)
    if (text.trim() !== '') {
      found.push({ text, startLine: lineAt[start] ?? 1, endLine: lineAt[at] ?? lineAt[start] ?? 1 })
    }
    start = at + 1
  }
  return found
}

/** The object's own name: schema and quoting removed, so two files agree on it. */
function bareName(raw: string): string {
  const last = raw.split('.').pop() ?? raw
  return last.replace(/["`[\]]/gu, '')
}

/**
 * Read one SQL file.
 *
 * @param source - the file's text.
 * @param path - the project-relative path, for the symbol ids.
 * @returns what the file declares and what it names.
 */
export function parseSql(source: string, path: string): ParsedFile {
  const symbols: SymbolRecord[] = []
  const calls: { name: string, line: number, owner: string | undefined }[] = []
  const declaredIds = new Set<string>()

  for (const statement of statements(source)) {
    let owner: string | undefined
    for (const entry of DECLARATIONS) {
      const match = entry.pattern.exec(statement.text)
      if (match === null) continue
      const name = bareName(match[1] ?? '')
      if (name === '') break
      const id = `${path}#${entry.kind}:${name}`
      // A file that runs the same `CREATE OR REPLACE` twice declares it once: the second
      // statement updates it, and two symbols sharing one id would fail the whole file's
      // write (the id is the primary key).
      if (!declaredIds.has(id)) {
        declaredIds.add(id)
        symbols.push({
          id,
          path,
          name,
          kind: entry.kind,
          line: statement.startLine,
          // A statement's extent is the whole `CREATE … ;`, which is what a source slice
          // needs: a table's columns are inside it.
          endLine: statement.endLine,
          parent: undefined,
        })
      }
      owner = id
      break
    }

    for (const pattern of REFERENCES) {
      for (const match of statement.text.matchAll(pattern)) {
        const name = bareName(match[1] ?? '')
        if (name === '' || NOT_A_NAME.has(name.toLowerCase())) continue
        const before = statement.text.slice(0, match.index ?? 0)
        const line = statement.startLine + (before.match(/\n/gu)?.length ?? 0)
        // A reference inside a declaration belongs to that declaration ("orders
        // references users"); a bare data statement has no owner, so its edge starts at
        // the file — which is what `impact` reports as "referenced from migrations/x.sql".
        calls.push({ name, line, owner })
      }
    }
  }

  return {
    symbols,
    calls,
    imports: [],
    heritage: [],
    typeRefs: [],
    exports: [],
    hasError: false,
    unsupported: false,
  }
}
