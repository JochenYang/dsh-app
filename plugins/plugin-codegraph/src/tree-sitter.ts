/**
 * The tree-sitter bridge: loading grammars and turning a source string into the
 * parse result the index pass consumes.
 *
 * Why this is a separate module from `parse.ts`. `parse.ts` is a pure function
 * over a syntax tree — it can be tested with hand-built nodes and it knows
 * nothing about wasm. This module owns the parts that touch the runtime: the
 * `Parser.init()` singleton, the per-grammar `Language` cache, and the mapping
 * from a grammar file to a parser. Keeping them apart is what lets the extraction
 * rules be tested without loading a 200 KB wasm runtime.
 *
 * Caching. Loading a wasm module costs far more than parsing one file, so the
 * `Language` is cached per grammar FILE and the `Parser` per language id. The
 * cache entry records the file's size: a grammar that was re-downloaded at a
 * different version has a different size, and reusing the old module would keep
 * parsing with the version the user just replaced.
 *
 * @module @dsh-app/plugin-codegraph/host/tree-sitter
 */

import { statSync } from 'node:fs'
import { Language, Parser } from 'web-tree-sitter'
import { extractSymbols, type ParsedFile, type SyntaxNode } from './parse.ts'

/** One cached parser, keyed by language id, with the grammar file it came from. */
interface Cached {
  readonly parser: { setLanguage(language: unknown): void, parse(source: string): { rootNode: unknown } | null }
  readonly grammarFile: string
  readonly grammarSize: number
}

let runtime: Promise<void> | undefined
const parsers = new Map<string, Cached>()

/**
 * Initialise the tree-sitter runtime once.
 *
 * Imported STATICALLY, not through `createRequire`. The runtime never installs a
 * plugin's production dependencies — `stripShippedDependencies` in
 * `scripts/build-runtime.mjs` deletes the field from the shipped manifest — so
 * every non-framework package has to be inlined into `lib/index.js` by esbuild,
 * which only follows a static specifier. A `require('web-tree-sitter')` call
 * compiled to a runtime lookup of that name and failed in the installed artifact
 * with `Cannot find module 'web-tree-sitter'`. Measured on
 * `dsh-0.2.1-rc.3+suite-1c3251ad`: every index attempt failed that way.
 *
 * The `locateFile` callback points it at the copy this plugin ships in
 * `grammars/`, so an installed runtime does not depend on the module's own
 * layout.
 *
 * @param runtimeWasm - absolute path to `web-tree-sitter.wasm`.
 */
function loadRuntime(runtimeWasm: string): Promise<void> {
  runtime ??= Parser.init({ locateFile: () => runtimeWasm })
  return runtime
}

/**
 * A parser for one grammar, cached.
 *
 * @param grammarFile - absolute path to `tree-sitter-<lang>.wasm`.
 * @param languageId - the language id, the cache key.
 * @param runtimeWasm - absolute path to the tree-sitter runtime wasm.
 * @returns the parser.
 */
async function parserFor(grammarFile: string, languageId: string, runtimeWasm: string): Promise<Cached> {
  const size = statSync(grammarFile).size
  const cached = parsers.get(languageId)
  if (cached !== undefined && cached.grammarFile === grammarFile && cached.grammarSize === size) return cached
  await loadRuntime(runtimeWasm)
  const language = await Language.load(grammarFile)
  const parser = new Parser()
  parser.setLanguage(language)
  const entry: Cached = { parser, grammarFile, grammarSize: size }
  parsers.set(languageId, entry)
  return entry
}

/**
 * Parse one file.
 *
 * @param grammarFile - absolute path to the grammar.
 * @param runtimeWasm - absolute path to the tree-sitter runtime wasm.
 * @param source - the file's text.
 * @param path - the project-relative path, for the symbol ids.
 * @param languageId - the language id.
 * @returns what the file declares and calls.
 */
export async function parseFile(
  grammarFile: string,
  runtimeWasm: string,
  source: string,
  path: string,
  languageId: string,
): Promise<ParsedFile> {
  const { parser } = await parserFor(grammarFile, languageId, runtimeWasm)
  const tree = parser.parse(source)
  if (tree === null) {
    return { symbols: [], calls: [], imports: [], heritage: [], typeRefs: [], exports: [], hasError: true, unsupported: false }
  }
  // The tree-sitter Node type is structurally the SyntaxNode `parse.ts` reads;
  // the cast is the boundary where a real parse becomes this plugin's contract.
  return extractSymbols(tree.rootNode as SyntaxNode, path, languageId)
}

/** Drop every cached parser, for a test or a language reinstall. */
export function resetParserCache(): void {
  parsers.clear()
  runtime = undefined
}
