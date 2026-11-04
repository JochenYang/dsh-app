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
 * Bundled vs on-demand. Fourteen bundled grammar FILES ship inside the plugin (see the
 * `files` field), because a first parse that waits on a network fetch is a worse first
 * impression than the install size. More languages than files: C and C++ share one
 * build, and Vue/Svelte/Astro share TypeScript's because the code in a component's
 * `<script>` block IS TypeScript (`sfc.ts` masks the markup away). Everything else is
 * downloaded into `$DSH_HOME/storages/dsh-app-plugin-codegraph/grammars/` on request
 * from the settings page, and a language that is not installed answers
 * `LANGUAGE_NOT_INSTALLED` — never a silent fallback, because a graph silently missing
 * a language looks like a graph where that language has no symbols.
 *
 * The on-demand set has TWO sources, and the difference is which package the bytes
 * could come from: the pinned grammar package for a language it carries, and this app's
 * own kernel release for a grammar this plugin builds itself. See `grammarUrls`.
 *
 * @module @dsh-app/plugin-codegraph/host/languages
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where an on-demand grammar's bytes come from. */
export type GrammarSource = 'cdn' | 'release'

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
  /**
   * Where a NON-bundled grammar is downloaded from. Absent means `cdn` — the
   * pinned grammar package. `release` means the app's own runtime release, which
   * is the only place a grammar this plugin builds itself can live.
   */
  readonly source?: GrammarSource
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
  // The twelve grammars BUILT for this plugin rather than taken from the pinned
  // package: `tree-sitter build --wasm` over the upstream grammar sources. Six of them
  // ship beside the other eight because they are what a phone, a desktop or a data
  // team's project is written in — Android, iOS, Flutter, Apple's legacy Objective-C,
  // Lua and R. The other six are large and rarely the language of a whole repository,
  // so they are downloaded on request from this app's own kernel release (see
  // `grammarUrls`): Scala, Elixir, Zig, Julia, Haskell and Groovy together are 13 MB of
  // an artifact every user downloads, and none of them answers "what is this project"
  // for more than a handful of repositories.
  //
  // The upstream commits the committed bytes came from are in
  // `docs/agents/codegraph.md` §11 — a `--depth 1` clone of `main` does not reproduce
  // them, and the files live in `grammars-optional/` in the repository until they are
  // uploaded beside a release.
  { id: 'kotlin', grammar: 'kotlin', label: 'Kotlin', extensions: ['.kt', '.kts'], bundled: true },
  { id: 'swift', grammar: 'swift', label: 'Swift', extensions: ['.swift'], bundled: true },
  { id: 'dart', grammar: 'dart', label: 'Dart', extensions: ['.dart'], bundled: true },
  { id: 'objc', grammar: 'objc', label: 'Objective-C', extensions: ['.m', '.mm'], bundled: true },
  { id: 'lua', grammar: 'lua', label: 'Lua', extensions: ['.lua'], bundled: true },
  { id: 'r', grammar: 'r', label: 'R', extensions: ['.r', '.R'], bundled: true },
  // Single-file components cost NOTHING to ship: the code in one is TypeScript or
  // JavaScript, so `sfc.ts` masks the markup away and the grammar above reads what is
  // left, at its original line numbers. A component whose `<script>` says `lang="tsx"`
  // is read as TypeScript, which is the one shape this does not cover.
  { id: 'vue', grammar: 'typescript', label: 'Vue', extensions: ['.vue'], bundled: true },
  { id: 'svelte', grammar: 'typescript', label: 'Svelte', extensions: ['.svelte'], bundled: true },
  // Astro's `---` frontmatter is TypeScript; the template beside it is markup, masked away
  // by the same module (`sfc.ts`).
  { id: 'astro', grammar: 'typescript', label: 'Astro', extensions: ['.astro'], bundled: true },
  // SQL ships as CODE, not as a grammar: the pinned grammar package has none, and
  // `sql.ts` reads the handful of `CREATE` keywords with a scanner (see its header).
  // `grammar: ''` is what marks that here — nothing will ever be downloaded for it.
  { id: 'sql', grammar: '', label: 'SQL', extensions: ['.sql', '.ddl'], bundled: true },
  // Schema languages, scanned for the same reason SQL is: a block header is a keyword and
  // a name, and the pinned grammar package has neither (`schema.ts`).
  { id: 'prisma', grammar: '', label: 'Prisma', extensions: ['.prisma'], bundled: true },
  { id: 'graphql', grammar: '', label: 'GraphQL', extensions: ['.graphql', '.gql'], bundled: true },
  // Terraform / HCL, scanned for the same reason: block headers are labels, and the
  // backend's has no HCL grammar (`hcl.ts`).
  { id: 'terraform', grammar: '', label: 'Terraform / HCL', extensions: ['.tf', '.tfvars', '.hcl', '.tofu'], bundled: true },
  // Everything below is on-demand. `source: 'release'` entries are the six grammars
  // this plugin builds itself, fetched from the app's own runtime release; the rest come
  // from the pinned grammar package.
  { id: 'scala', grammar: 'scala', label: 'Scala', extensions: ['.scala', '.sc'], bundled: false, source: 'release' },
  { id: 'elixir', grammar: 'elixir', label: 'Elixir', extensions: ['.ex', '.exs'], bundled: false, source: 'release' },
  { id: 'zig', grammar: 'zig', label: 'Zig', extensions: ['.zig'], bundled: false, source: 'release' },
  { id: 'julia', grammar: 'julia', label: 'Julia', extensions: ['.jl'], bundled: false, source: 'release' },
  { id: 'haskell', grammar: 'haskell', label: 'Haskell', extensions: ['.hs'], bundled: false, source: 'release' },
  { id: 'groovy', grammar: 'groovy', label: 'Groovy', extensions: ['.groovy'], bundled: false, source: 'release' },
  { id: 'rust', grammar: 'rust', label: 'Rust', extensions: ['.rs'], bundled: false },
  { id: 'ruby', grammar: 'ruby', label: 'Ruby', extensions: ['.rb'], bundled: false },
  { id: 'php', grammar: 'php', label: 'PHP', extensions: ['.php'], bundled: false },
  { id: 'bash', grammar: 'bash', label: 'Shell', extensions: ['.sh', '.bash', '.zsh'], bundled: false },
  { id: 'css', grammar: 'css', label: 'CSS', extensions: ['.css', '.scss', '.less'], bundled: false },
  { id: 'ini', grammar: 'ini', label: 'INI / TOML', extensions: ['.ini', '.toml', '.cfg'], bundled: false },
  { id: 'powershell', grammar: 'powershell', label: 'PowerShell', extensions: ['.ps1', '.psm1', '.psd1'], bundled: false },
  { id: 'regex', grammar: 'regex', label: 'Regular expression', extensions: [], bundled: false },
]

/** The languages whose grammar ships inside the plugin, as the plan's default set. */
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
 * The base URL a grammar from the pinned package is downloaded from.
 *
 * Pinned to the exact version whose wasm this plugin's runtime was measured
 * against: a newer grammar can bump the ABI and stop loading, which is the
 * failure that ruled out the other package. Changing this version means
 * re-measuring, not just editing the string.
 */
export const GRAMMAR_BASE_URL = 'https://unpkg.com/@vscode/tree-sitter-wasm@0.3.1/wasm'

/**
 * Release coordinates for a grammar this plugin builds itself.
 *
 * These MIRROR `src/shared/constants.ts` and `src/kernel/sources/artifact.ts` in the
 * shell, which cannot be imported from here: the plugin runs inside the kernel child,
 * the shell resolves its own artifacts. The duplication is deliberate and CHECKED —
 * `test/codegraph-grammar-release.test.mjs` reads both sides and fails when they drift,
 * because a plugin pointing at a release path the upload never wrote is a download that
 * 404s for every user.
 *
 * Why the kernel release, of all places: it is the one artifact the app already
 * publishes on every cut, through the mirror chain a mainland user can reach, and it is
 * cut from THIS repository — so the bytes and the code that verifies them travel
 * together. Nothing new has to be hosted.
 */
export const GRAMMAR_RELEASE = {
  /** ModelScope's copy, which leads the chain for the same reason the kernel's does. */
  modelscopeEndpoint: 'https://www.modelscope.cn',
  modelscopeRepo: 'jochenYang/dsh-app',
  /** The GitHub release host, second. */
  githubRepo: 'JochenYang/dsh-app',
  /** Kernel releases are tagged `runtime-<version>`. */
  tagPrefix: 'runtime-',
} as const

/**
 * sha512 (base64) of every grammar this plugin can download.
 *
 * The download path loads a remote binary into the kernel process, so the bytes
 * are verified against this table before they are renamed into place — the same
 * rule the kernel's own artifact downloads follow
 * (`docs/agents/security-invariants.md`: "Kernel downloads are sha512-verified
 * before activation"). A CDN compromise or a swapped response is refused rather
 * than executed. Updating the grammar version means recomputing these values;
 * that is the point, not an inconvenience.
 *
 * One table for both sources: a digest describes BYTES, and which host serves them
 * must not change what they have to be.
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
  powershell: 'G47wlygEk/shL0R6E1Wz819Ltv+Qt6yAFA6PU1IjVGzcHZ2E6/cC0R4UlWz6x3fAmrukUUbjOKp7sZC3ysocrA==',
  regex: 'Pxh69HAvK/prkTy3SpvQW5Z46HN4pEKyhRyIeg/20HdiOeNy0YngRvoFlYoV+mJc5zPtx7Uhph/3XRl8eKZIbg==',
  // The six built here. These bytes are in the repository under `grammars-optional/`
  // and upload beside a kernel release; the digest is what makes that upload
  // verifiable in both directions.
  scala: 'VF0Oi7jZYAVGsDk7bgMDWmeTd+PWU4QlBc28HJoMmpUnrn8JmQjfae4RmCK1hIjfytqNE9ZLqSHSEt3XNcoiPQ==',
  elixir: 'XI2yyZsLOtbZjm/rSWchtqecnmg9wCXFhhZ7UpeFEHj2xDadQ5yrfVbsyz/6Q3sr6cv8VdKWOUOL1SIhl35hIw==',
  zig: 's9ZRHygEiEschYMWA9p3whp4GCid1X8B2vH4+8GjGaKQLfZ2qYjjIL7Uy2N9J6eZAEbbIARKonJzOe0xZuCtDQ==',
  julia: 'ZLBArp7nKHGVdKRHvu+CaUP/5SSmUa/0SQJGMvRye6AaxzAc1Hlgvyq/9xTAFcTOxRVhHODkPJ9ElcNL9t6WiQ==',
  haskell: 'WZe0ZFRH58fAa5q6jlCiT75n/ZSuPGMGZ2sq8W8Hq2skCr0ptHr/bztixy6VTY2NakV0yE8GoBu91aOrykZeVw==',
  groovy: 'C3DiGVmv1jJMZ/617psZxcId4i+XrS1CZepgzaZj/JY4+ufeCXnHsJYM6QFN2J4X/Kw+ejtVfLp4SH/5aW8nuw==',
}

/** The kernel version this build belongs to, as the shell tells its child. */
export function kernelVersion(): string {
  return (process.env.DSH_APP_KERNEL_VERSION ?? '').trim()
}

/**
 * Ordered URLs to try for one on-demand grammar, or `[]` when this build cannot
 * name one.
 *
 * Two sources, for two kinds of grammar. A language the pinned package carries is
 * fetched from it under a pinned version. A language this plugin BUILDS has no
 * package to pin to, so its bytes come from the app's own kernel release — the
 * artifact every cut already publishes through the mainland-reachable mirror, which
 * means no new hosting and no second trust root. The mirror leads and the official
 * host follows, matching `assetCandidates` in the shell's `src/kernel/sources/`.
 *
 * @param spec - the language to locate.
 * @param version - the kernel version (defaults to the env the shell sets).
 * @returns candidate URLs in download order.
 */
export function grammarUrls(spec: LanguageSpec, version: string = kernelVersion()): string[] {
  if (spec.bundled) return []
  const asset = `tree-sitter-${spec.grammar}.wasm`
  if (spec.source !== 'release') return [`${GRAMMAR_BASE_URL}/${asset}`]
  if (version === '') return []
  const tag = `${GRAMMAR_RELEASE.tagPrefix}${version}`
  // Segment-wise encoding keeps the slashes literal while a crafted version string
  // can neither smuggle `&`/`#` into the query nor turn a literal `+` into a space.
  const encoded = `releases/runtime/${tag}/${asset}`.split('/').map(encodeURIComponent).join('/')
  return [
    `${GRAMMAR_RELEASE.modelscopeEndpoint}/api/v1/models/${GRAMMAR_RELEASE.modelscopeRepo}/repo?Revision=master&FilePath=${encoded}`,
    `https://github.com/${GRAMMAR_RELEASE.githubRepo}/releases/download/${tag}/${asset}`,
  ]
}

/** The largest grammar this plugin will accept, in bytes (kotlin is ~5.8 MB). */
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
  const candidates = grammarUrls(spec)
  if (candidates.length === 0) {
    // Two different situations, two different sentences: a source this build cannot
    // name at all is an environment problem, a table entry with no source is a bug.
    throw new Error(spec.source === 'release'
      ? `grammar "${spec.grammar}" comes from this app's kernel release, and this run names no kernel version (DSH_APP_KERNEL_VERSION is unset) — a dev tree cannot download it; point DSH_APP_CODEGRAPH_GRAMMARS at a directory holding tree-sitter-${spec.grammar}.wasm instead`
      : `no download source for grammar "${spec.grammar}"`)
  }
  mkdirSync(paths.downloadDir, { recursive: true })
  const target = join(paths.downloadDir, `tree-sitter-${spec.grammar}.wasm`)
  // Every candidate is verified against the SAME digest. A mirror that serves a
  // different build therefore fails and falls through to the next one instead of
  // substituting content — the ordering is a transport preference, never an
  // authority.
  const attempts: string[] = []
  let bytes: Uint8Array | undefined
  for (const url of candidates) {
    try {
      bytes = await fetchVerifiedGrammar(url, spec, expected, fetchImpl)
      break
    } catch (error) {
      attempts.push(`${hostOf(url)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (bytes === undefined) {
    throw new Error(`grammar download for ${spec.id} failed from every source — ${attempts.join('; ')}`)
  }
  // Unique per attempt: a fixed `.partial` name lets two concurrent downloads
  // rename each other's in-progress file and publish a truncated wasm.
  const partial = `${target}.partial-${String(process.pid)}-${String(Date.now())}`
  writeFileSync(partial, bytes)
  renameSync(partial, target)
  return target
}

/** The host of a URL, for an error message that names where the bytes came from. */
function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url }
}

/**
 * Fetch one URL and refuse anything that is not exactly the expected grammar.
 *
 * Three refusals before the digest, in increasing cost: a non-2xx status, an
 * oversized body, and a body that does not start with `\0asm` (a CDN error page
 * arrives with a 200). The digest is the one that matters — the others exist so a
 * wrong response is reported as what it is instead of as a digest mismatch.
 */
async function fetchVerifiedGrammar(
  url: string,
  spec: LanguageSpec,
  expected: string,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, {
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
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error(`grammar download for ${spec.id} returned something that is not a wasm module`)
  }
  const digest = createHash('sha512').update(bytes).digest('base64')
  if (digest !== expected) {
    throw new Error(`grammar download for ${spec.id} failed its sha512 check`)
  }
  return bytes
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
