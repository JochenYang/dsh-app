/**
 * Grammar loading: which languages are available, and getting one ready to parse.
 *
 * The grammars are `@vscode/tree-sitter-wasm` (0.3.1), chosen after measuring
 * that `tree-sitter-wasms` 0.1.13 does NOT load into `web-tree-sitter` 0.27 —
 * its wasm fails `getDylinkMetadata` with an empty error, which is an ABI
 * mismatch between the grammar build and the runtime. A grammar that does not
 * load is worth nothing, so the choice is measured rather than assumed.
 *
 * Two facts about this grammar set that the language table encodes:
 *
 *   - **C is parsed with the C++ grammar.** The set has no pure-C grammar, and
 *     C is a subset of C++: a C translation unit parses through `cpp` with no
 *     ERROR node (measured on a file with `#include`, a function, a struct and
 *     a call). Declaring C separately would mean shipping a grammar nobody
 *     built, for a language this one already reads.
 *   - **C# is `c-sharp` on disk, `c_sharp` in our table.** The file name and the
 *     language id disagree upstream; the mapping lives here so nothing else has
 *     to know.
 *
 * Bundled vs on-demand. The eight bundled grammars ship inside the plugin (see
 * the `files` field), because a first parse that waits on a network fetch is a
 * worse first impression than ~10 MB of install size. Everything else is
 * downloaded into `$DSH_HOME/storages/dsh-app-plugin-codegraph/grammars/` on
 * request from the settings page, and a language that is not installed answers
 * `LANGUAGE_NOT_INSTALLED` — never a silent fallback, because a graph silently
 * missing a language looks like a graph where that language has no symbols.
 *
 * @module @dsh-app/plugin-codegraph/host/languages
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One language this plugin can parse. */
export interface LanguageSpec {
  /** The id the graph stores in `files.lang` and the tools report. */
  readonly id: string
  /** The grammar's file name stem under the grammar directory. */
  readonly grammar: string
  /** Human label for the settings page. */
  readonly label: string
  /** Extensions that select this language (lower case, with the dot). */
  readonly extensions: readonly string[]
  /** True when the grammar ships inside the plugin. */
  readonly bundled: boolean
}

/**
 * Every language this plugin knows.
 *
 * Deliberately a table rather than discovery: an extension has to map to exactly
 * one grammar, and a directory scan cannot decide that (`.h` is C and C++).
 */
export const LANGUAGES: readonly LanguageSpec[] = [
  { id: 'typescript', grammar: 'typescript', label: 'TypeScript', extensions: ['.ts', '.mts', '.cts'], bundled: true },
  { id: 'tsx', grammar: 'tsx', label: 'TypeScript JSX', extensions: ['.tsx'], bundled: true },
  { id: 'javascript', grammar: 'javascript', label: 'JavaScript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], bundled: true },
  { id: 'python', grammar: 'python', label: 'Python', extensions: ['.py', '.pyi'], bundled: true },
  { id: 'go', grammar: 'go', label: 'Go', extensions: ['.go'], bundled: true },
  { id: 'java', grammar: 'java', label: 'Java', extensions: ['.java'], bundled: true },
  { id: 'c', grammar: 'cpp', label: 'C', extensions: ['.c', '.h'], bundled: true },
  { id: 'cpp', grammar: 'cpp', label: 'C++', extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'], bundled: true },
  { id: 'c_sharp', grammar: 'c-sharp', label: 'C#', extensions: ['.cs'], bundled: true },
  // Everything below is on-demand: present in the grammar package, absent from
  // the plugin's own bundle.
  { id: 'rust', grammar: 'rust', label: 'Rust', extensions: ['.rs'], bundled: false },
  { id: 'ruby', grammar: 'ruby', label: 'Ruby', extensions: ['.rb'], bundled: false },
  { id: 'php', grammar: 'php', label: 'PHP', extensions: ['.php'], bundled: false },
  { id: 'bash', grammar: 'bash', label: 'Shell', extensions: ['.sh', '.bash', '.zsh'], bundled: false },
  { id: 'css', grammar: 'css', label: 'CSS', extensions: ['.css', '.scss', '.less'], bundled: false },
  { id: 'ini', grammar: 'ini', label: 'INI / TOML', extensions: ['.ini', '.toml', '.cfg'], bundled: false },
  { id: 'regex', grammar: 'regex', label: 'Regular expression', extensions: [], bundled: false },
]

/** The bundled eight, as the plan's default set. */
export const BUNDLED_LANGUAGE_IDS: readonly string[] = LANGUAGES.filter(language => language.bundled).map(language => language.id)

/** Extension → language, built once. A duplicate extension is a table bug. */
const BY_EXTENSION: ReadonlyMap<string, LanguageSpec> = (() => {
  const map = new Map<string, LanguageSpec>()
  for (const language of LANGUAGES) {
    for (const extension of language.extensions) {
      const existing = map.get(extension)
      // Two languages claiming one extension would make selection depend on
      // table order. Keep the FIRST and let a test catch the collision.
      if (existing === undefined) map.set(extension, language)
    }
  }
  return map
})()

/**
 * The language that parses a path, or undefined for a file this plugin ignores.
 *
 * Selection is by extension only. Content sniffing would be more precise for
 * extensionless scripts, but it costs a read of every candidate file during a
 * scan — which is the cost the index pass is trying to keep small.
 *
 * @param path - a project-relative path.
 * @returns the matching language.
 */
export function languageForPath(path: string): LanguageSpec | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  return BY_EXTENSION.get(path.slice(dot).toLowerCase())
}

/** Where a grammar's wasm lives. */
export interface GrammarPaths {
  /** The directory holding the bundled grammars (inside the plugin's lib). */
  readonly bundledDir: string
  /** The directory holding downloaded grammars (under the storage root). */
  readonly downloadDir: string
}

/** The absolute path of one grammar's wasm, or undefined when it is not installed. */
export function grammarPath(spec: LanguageSpec, paths: GrammarPaths): string | undefined {
  // A bundled grammar is read from the plugin; an on-demand one only from the
  // download directory, so a language the user did not install cannot be picked
  // up by accident.
  const candidate = spec.bundled
    ? join(paths.bundledDir, `tree-sitter-${spec.grammar}.wasm`)
    : join(paths.downloadDir, `tree-sitter-${spec.grammar}.wasm`)
  return existsSync(candidate) ? candidate : undefined
}

/** Install state of one language, as the settings page reports it. */
export interface LanguageStatus {
  readonly id: string
  readonly label: string
  readonly bundled: boolean
  /** True when the wasm is on disk and loadable by path. */
  readonly installed: boolean
  /** Bytes on disk, 0 when not installed. */
  readonly bytes: number
}

/** Every language with its install state. */
export function languageStatuses(paths: GrammarPaths): LanguageStatus[] {
  return LANGUAGES.map((spec) => {
    const file = grammarPath(spec, paths)
    return {
      id: spec.id,
      label: spec.label,
      bundled: spec.bundled,
      installed: file !== undefined,
      bytes: file === undefined ? 0 : statSync(file).size,
    }
  })
}

/**
 * The base URL a grammar is downloaded from.
 *
 * Pinned to the exact version whose wasm this plugin's runtime was measured
 * against: a newer grammar can bump the ABI and stop loading, which is the
 * failure that ruled out the other package. Changing this version means
 * re-measuring, not just editing the string.
 */
export const GRAMMAR_BASE_URL = 'https://unpkg.com/@vscode/tree-sitter-wasm@0.3.1/wasm'

/**
 * sha512 (base64) of every grammar this plugin can download, at
 * {@link GRAMMAR_BASE_URL}.
 *
 * The download path loads a remote binary into the kernel process, so the bytes
 * are verified against this table before they are renamed into place — the same
 * rule the kernel's own artifact downloads follow
 * (`docs/agents/security-invariants.md`: "Kernel downloads are sha512-verified
 * before activation"). A CDN compromise or a swapped response is refused rather
 * than executed. Updating the grammar version means recomputing these values;
 * that is the point, not an inconvenience.
 */
export const GRAMMAR_SHA512: Readonly<Record<string, string>> = {
  typescript: 'aYh34S26Dvk4RZH6AMz8ucTwiz2fbkZYxIGhErtcdSz0shUwDQEzIhNkEM+wFNGyNeeHp3VeAxqjAMDKF1b1mg==',
  tsx: 'pxWR0Lc74I0qmHEk4eWyBBPW8XiHzdn/LbrDNjSB5rc5j4P6RkJkY2CFstB+ABDBdanqGDvXkpJCbxzoWV52Cw==',
  javascript: 'paGoSfNEI5EHUxstm0+F7Z235bbfhmzj5TnHY60bEL2KTCeZx4rjX+TQ7fWzc5/7CQ2A2E0+qsC6DB5QtobnFw==',
  python: 'yuY10cSZ9XthtGrtdfFZJOJrswQrayfRD1gKQ8pbpAsNeiFHB1bLN9/kJ5JawVBNBV8gD/hCBmy3Dw3JG3r5KQ==',
  go: 'H5KDUos7INW0bY4iZMAqdI38V4iE3remRX7pqOUM6KUcM5nNZIFOqgxv+Dqye2lKnDV6pdcsHQqhnFDlhp7KJg==',
  java: 'EN0CCauhYLP3LJXyZqGK9CnorGHUbQA8mdeafEFW/LiKkO5FTJFyRzRJYOnS1uskxH9HtnPrMsA1OcqNG0c/LA==',
  cpp: 'lBgqyfgsafxELRdFS3QxjF2jFpQhcbogOrfIZ3B/NKkDDqGkDH9sbXe6os9DAdChCxLjFbweYyq7IqDiBeBbVw==',
  'c-sharp': 'BcGTmUK43qlYIRs0I079QXCf/f3thn8eBstNJVx6kINgCYosHakTvbVxpSLz5pYW3ymz/iJE+xcr5o7ZDaMwEA==',
  rust: 'zHgH8NvuJ4wJD0iFSx8LMpR75KGQctinqAawKuei8rjFhCQmT1EqShdfVti7LiC73gUeXkHJfVs7MLecE7sslQ==',
  ruby: 'jcKWK3oaQbcjXI7kr3h+7gyT8Yla33//i0tDazGKZQdbQns0ISM7mf0p9NH9R2BKeHR43Xy9vvqUZy8grVD7dw==',
  php: 'sHhpbX3KwUnZ3BsbaClYqhfta7hnSiPiNXeZYrMz//+6NeezXp7D/OI4GKl/yFBhgJyozTwjMEqc2dVKGKtAoA==',
  bash: 'wa3L7EfD6bhq2k3zSkesmgAz0cxfLUyPW+VpLQkN8yHHDWAIGE51HdcOVZADwmgHXkm70gM04aE3Nplst2nQUQ==',
  css: 'b8nIiSr/hb+tr0ZB9LfrtOyqHjOLLnk2dlI9bW7iW4Ww6jzzo+xvHhCzoIGaEE1YOGF74fmmGDuAwPaQw9I/pQ==',
  ini: 'jky36dOyF+89iyv7eEy5MDTvnq5A2iobv+c8febN5zTJHr6KZRJ4q4E3IEQlEDF8L3s3Sbv3fWMFE3xyPFxLEA==',
  regex: 'Pxh69HAvK/prkTy3SpvQW5Z46HN4pEKyhRyIeg/20HdiOeNy0YngRvoFlYoV+mJc5zPtx7Uhph/3XRl8eKZIbg==',
}

/** The largest grammar this plugin will accept, in bytes (cpp is ~5.4 MB). */
const MAX_GRAMMAR_BYTES = 12 * 1024 * 1024

/**
 * Download one on-demand grammar.
 *
 * Writes to a UNIQUE temporary name and renames on success, so an interrupted
 * download cannot leave a half-file that later looks installed, and two
 * concurrent downloads of one language cannot write over each other's bytes.
 *
 * @param spec - the language to install.
 * @param paths - the grammar directories.
 * @param fetchImpl - the fetch to use (injectable for tests).
 * @returns the installed path.
 */
export async function downloadGrammar(
  spec: LanguageSpec,
  paths: GrammarPaths,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (spec.bundled) {
    const bundled = grammarPath(spec, paths)
    if (bundled === undefined) throw new Error(`bundled grammar for ${spec.id} is missing from the plugin`)
    return bundled
  }
  const expected = GRAMMAR_SHA512[spec.grammar]
  if (expected === undefined) {
    // A language in the table with no recorded digest must not download: the
    // alternative is executing bytes nobody verified.
    throw new Error(`no recorded sha512 for grammar "${spec.grammar}"; refusing to download it unverified`)
  }
  mkdirSync(paths.downloadDir, { recursive: true })
  const target = join(paths.downloadDir, `tree-sitter-${spec.grammar}.wasm`)
  const response = await fetchImpl(`${GRAMMAR_BASE_URL}/tree-sitter-${spec.grammar}.wasm`, {
    // A CDN that stalls must not hang the settings page forever.
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`grammar download for ${spec.id} failed: HTTP ${String(response.status)}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > MAX_GRAMMAR_BYTES) {
    throw new Error(`grammar download for ${spec.id} exceeded ${String(MAX_GRAMMAR_BYTES)} bytes`)
  }
  // A wasm module starts with \0asm; a CDN error page does not.
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error(`grammar download for ${spec.id} returned something that is not a wasm module`)
  }
  const digest = createHash('sha512').update(bytes).digest('base64')
  if (digest !== expected) {
    throw new Error(`grammar download for ${spec.id} failed its sha512 check (got ${digest})`)
  }
  // Unique per attempt: a fixed `.partial` name lets two concurrent downloads
  // rename each other's in-progress file and publish a truncated wasm.
  const partial = `${target}.partial-${String(process.pid)}-${String(Date.now())}`
  writeFileSync(partial, bytes)
  renameSync(partial, target)
  return target
}

/**
 * The directory bundled grammars are read from, resolved relative to this module.
 *
 * `build.mjs` copies `grammars/*.wasm` beside `lib/`, so the path is
 * `../grammars` from `lib/index.js` and `../grammars` from `src/` in a test run
 * (where the source tree's own `grammars/` is used).
 *
 * @returns the absolute directory.
 */
export function bundledGrammarDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'grammars')
}

/** Every `.wasm` file name currently installed in a directory (for diagnostics). */
export function installedGrammarFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.wasm'))
}
