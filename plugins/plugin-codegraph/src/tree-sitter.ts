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
import { createRequire } from 'node:module'
import { extractSymbols, type ParsedFile, type SyntaxNode } from './parse.ts'

/** The shape of the `web-tree-sitter` module this bridge uses. */
interface TreeSitterModule {
  Parser: {
    init(options: { locateFile: (file: string) => string }): Promise<void>
    new (): { setLanguage(language: unknown): void, parse(source: string): { rootNode: unknown } | null }
  }
  Language: { load(path: string): Promise<unknown> }
}

/** One cached parser, keyed by language id, with the grammar file it came from. */
interface Cached {
  readonly parser: { setLanguage(language: unknown): void, parse(source: string): { rootNode: unknown } | null }
  readonly grammarFile: string
  readonly grammarSize: number
}

let runtime: Promise<TreeSitterModule> | undefined
const parsers = new Map<string, Cached>()

/**
 * Load the tree-sitter runtime once.
 *
 * `web-tree-sitter` is CommonJS and resolves its own wasm beside its entry; the
 * `locateFile` callback points it at the copy this plugin ships in `grammars/`,
 * so an installed runtime does not depend on the module's own layout.
 *
 * @param runtimeWasm - absolute path to `web-tree-sitter.wasm`.
 * @returns the module.
 */
function loadRuntime(runtimeWasm: string): Promise<TreeSitterModule> {
  runtime ??= (async () => {
    // `createRequire` rather than a dynamic `import()`: the package is CommonJS,
    // and the plugin bundle externalises `@deepseek-ai/*` only — everything else
    // is inlined, so the runtime resolves from this bundle's own scope.
    const require = createRequire(import.meta.url)
    const module = require('web-tree-sitter') as TreeSitterModule
    await module.Parser.init({ locateFile: () => runtimeWasm })
    return module
  })()
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
  const module = await loadRuntime(runtimeWasm)
  const language = await module.Language.load(grammarFile)
  const parser = new module.Parser()
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
