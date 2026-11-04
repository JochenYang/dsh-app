/**
 * Schema languages: the named blocks a file declares, and the names it points at.
 *
 * Prisma and GraphQL SDL are declarative: a file is a list of named blocks (`model User`,
 * `type Query`) whose bodies are fields. That is exactly the shape this graph stores — a
 * symbol and a relation to another symbol — and it is why neither needs a grammar: the
 * pinned grammar package has none for either, and a block header is a keyword plus a name
 * where a C expression is a tree.
 *
 * One engine, two tables. The two languages differ only in which keywords declare and
 * which words are type references, so the scanner is shared and the differences are data
 * (`PRISMA` and `GRAPHQL`). A second copy of the machine would be a second place for the
 * comment syntax to be wrong.
 *
 * What this does NOT do: resolve a type to a declaration. It reports the NAME a field
 * points at, and the graph's own name resolution decides whether that name is one symbol,
 * several, or none — the same rule every other language here follows.
 *
 * @module @dsh-app/plugin-codegraph/host/schema
 */

import type { ParsedFile } from './parse.ts'
import type { SymbolKind, SymbolRecord } from './store.ts'

/** What one `declaration` pattern declares: a keyword, and the name it takes. */
interface DeclarationRule {
  readonly pattern: RegExp
  readonly kind: SymbolKind
}

/** How one schema language is written. */
interface SchemaSpec {
  readonly declarations: readonly DeclarationRule[]
  /** Matches a type reference in a body; group 1 is the name. */
  readonly references: RegExp
  /** Words that look like types but are the language's own scalars. */
  readonly scalars: ReadonlySet<string>
  /** Whether `#` starts a line comment (GraphQL) as well as `//` (Prisma). */
  readonly hashComments: boolean
  /** Whether a triple-quoted block string exists (GraphQL descriptions). */
  readonly blockStrings: boolean
}

/** Prisma: `model`, `enum`, `view` and composite `type`, plus relations by field type. */
const PRISMA: SchemaSpec = {
  declarations: [
    { pattern: /^[ 	]*(?:model|view)\s+([A-Za-z_][A-Za-z0-9_]*)/mu, kind: 'struct' },
    { pattern: /^[ 	]*enum\s+([A-Za-z_][A-Za-z0-9_]*)/mu, kind: 'enum' },
    { pattern: /^[ 	]*type\s+([A-Za-z_][A-Za-z0-9_]*)/mu, kind: 'type' },
  ],
  // A field's TYPE is the association: `author User @relation(...)` means this model
  // points at `User`. Scalars are filtered by name.
  references: /^[ 	]*[A-Za-z_][A-Za-z0-9_]*\s+([A-Za-z_][A-Za-z0-9_]*)/gmu,
  scalars: new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']),
  hashComments: false,
  blockStrings: false,
}

/** GraphQL SDL: types, interfaces, inputs, enums, unions, scalars. */
const GRAPHQL: SchemaSpec = {
  declarations: [
    { pattern: /^[ 	]*(?:extend\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)/mu, kind: 'struct' },
    { pattern: /^[ 	]*(?:extend\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/mu, kind: 'interface' },
    { pattern: /^[ 	]*(?:extend\s+)?input\s+([A-Za-z_][A-Za-z0-9_]*)/mu, kind: 'type' },
    { pattern: /^[ 	]*(?:extend\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/mu, kind: 'enum' },
    { pattern: /^[ 	]*(?:extend\s+)?scalar\s+([A-Za-z_][A-Za-z0-9_]*)/mu, kind: 'type' },
    { pattern: /^[ 	]*(?:extend\s+)?union\s+([A-Za-z_][A-Za-z0-9_]*)/mu, kind: 'type' },
  ],
  // A field type in a body, or a union member, or an `implements` clause entry.
  references: /(?::\s*\[?|\|\s*|implements\s+)([A-Za-z_][A-Za-z0-9_]*)/gu,
  scalars: new Set(['String', 'Int', 'Float', 'Boolean', 'ID']),
  hashComments: true,
  blockStrings: true,
}

/** One `;`-free block: where it starts and the line its closing brace is on. */
interface Extent {
  /** Offset just past the block's closing brace, or the end of the body. */
  readonly end: number
  readonly endLine: number
}

/**
 * Blank comments and strings, keeping length and newlines.
 *
 * Braces inside a doc string (`"""…"""`) or a comment are not structure, and counting
 * them is how a block would appear to end three lines early — the failure mode that
 * silently truncates a declaration's extent.
 *
 * @param source - the file's text.
 * @param spec - the language's comment and string rules.
 * @returns a same-length mask.
 */
function masked(source: string, spec: SchemaSpec): string {
  const characters = source.split('')
  const blank = (from: number, count: number): void => {
    for (let index = from; index < from + count && index < characters.length; index++) {
      if (characters[index] !== '\n') characters[index] = ' '
    }
  }
  for (let at = 0; at < characters.length; at++) {
    const rest = source.slice(at, at + 24)
    if (rest.startsWith('//') || (spec.hashComments && rest.startsWith('#'))) {
      const end = source.indexOf('\n', at)
      const stop = end === -1 ? characters.length : end
      blank(at, stop - at)
      at = stop
      continue
    }
    if (spec.blockStrings && rest.startsWith('"""')) {
      const end = source.indexOf('"""', at + 3)
      const stop = end === -1 ? characters.length : end + 3
      blank(at, stop - at)
      at = stop
      continue
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', at)
      const stop = end === -1 ? characters.length : end + 2
      blank(at, stop - at)
      at = stop
      continue
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0] as string
      const end = source.indexOf(quote, at + 1)
      const stop = end === -1 ? characters.length : end + 1
      blank(at, stop - at)
      at = stop
      continue
    }
  }
  return characters.join('')
}

/**
 * Where the block opened at `from` closes.
 *
 * @param mask - the comment- and string-blanked source.
 * @param from - the offset of the opening brace.
 * @param source - the original text, for line numbers.
 * @returns the offset past the closing brace, and its line.
 */
function blockEnd(mask: string, from: number, source: string): Extent {
  let depth = 0
  for (let at = from; at < mask.length; at++) {
    const character = mask[at]
    if (character === '{') depth++
    else if (character === '}') {
      depth--
      if (depth === 0) {
        return { end: at + 1, endLine: lineOf(source, at) }
      }
    }
  }
  return { end: mask.length, endLine: lineOf(source, mask.length) }
}

/**
 * The 1-based line of an offset.
 *
 * @param source - the text.
 * @param offset - the character offset.
 * @returns the line number.
 */
function lineOf(source: string, offset: number): number {
  let line = 1
  for (let at = 0; at < offset && at < source.length; at++) if (source[at] === '\n') line++
  return line
}

/**
 * Read one schema file.
 *
 * @param source - the file's text.
 * @param path - the project-relative path, for the symbol ids.
 * @param spec - the language's tables.
 * @returns what the file declares and what it names.
 */
function scan(source: string, path: string, spec: SchemaSpec): ParsedFile {
  const mask = masked(source, spec)
  const symbols: SymbolRecord[] = []
  const calls: { name: string, line: number, owner: string | undefined }[] = []
  // A block is consumed once: a `model` line inside another block is a field, not a
  // nested model, so the cursor skips past each body it has read.
  let cursor = 0
  while (cursor < mask.length) {
    const rest = mask.slice(cursor)
    let best: { readonly index: number, readonly name: string, readonly kind: SymbolKind } | undefined
    for (const rule of spec.declarations) {
      const match = rule.pattern.exec(rest)
      if (match === null || match[1] === undefined) continue
      // `^\s*` under the `m` flag anchors to a line, so the match's index is the line's
      // start and the offset of the keyword is inside it.
      const index = cursor + (match.index ?? 0)
      if (best === undefined || index < best.index) best = { index, name: match[1], kind: rule.kind }
    }
    if (best === undefined) break
    // The brace must be in this declaration's HEADER, not in the next block: a graphql
    // `extend type User @key(fields: "id")` is legal without braces, and taking the next
    // `{` would give it the following type's body — and that type's fields.
    // The brace must be on the DECLARATION'S OWN LINE. Every block header in these two
    // languages opens on the line that names it, and a wider window is how a bodiless
    // `scalar Date` or `union Search = A | B` took the next block's body — swallowing the
    // declaration after it, which then never appeared at all.
    const lineEnd = mask.indexOf('\n', best.index)
    const brace = mask.indexOf('{', best.index)
    const hasBody = brace !== -1 && (lineEnd === -1 || brace < lineEnd)
    const open = hasBody
      ? blockEnd(mask, brace, source)
      : { end: best.index, endLine: lineOf(source, best.index) }
    const line = lineOf(source, best.index)
    const id = `${path}#${best.kind}:${best.name}`
    symbols.push({ id, path, name: best.name, kind: best.kind, line, endLine: open.endLine, parent: undefined })
    // The header counts too: a graphql `implements Node` clause sits between the name and
    // the opening brace, so scanning only the body would miss every interface reference.
    // A bodiless declaration still gets its own line scanned, for the same reason.
    const body = hasBody
      ? mask.slice(best.index, open.end)
      : mask.slice(best.index, lineEnd === -1 ? mask.length : lineEnd)
    for (const match of body.matchAll(spec.references)) {
      const name = match[1]
      if (name === undefined || spec.scalars.has(name) || name === best.name) continue
      const before = body.slice(0, match.index ?? 0)
      calls.push({ name, line: line + (before.match(/\n/gu)?.length ?? 0), owner: id })
    }
    // Past this declaration, and ALWAYS forward: a bodiless declaration (`extend type X`)
    // ends where it starts, and `cursor = open.end` would then re-find the same line for
    // ever.
    cursor = Math.max(open.end, best.index + 1)
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

/**
 * Read one Prisma schema.
 *
 * @param source - the file's text.
 * @param path - the project-relative path.
 * @returns what the file declares and relates to.
 */
export function parsePrisma(source: string, path: string): ParsedFile {
  return scan(source, path, PRISMA)
}

/**
 * Read one GraphQL SDL document.
 *
 * @param source - the file's text.
 * @param path - the project-relative path.
 * @returns what the document declares and points at.
 */
export function parseGraphql(source: string, path: string): ParsedFile {
  return scan(source, path, GRAPHQL)
}
