/**
 * The static import gate: every package a plugin's sources import must be
 * accounted for by a dependency field, and a kernel package must be a peer.
 *
 * Why this exists, next to the type gate: `plugins/build-lib.mjs` marks every
 * `@deepseek-ai/*`, `react` and `react-dom` specifier EXTERNAL, so esbuild
 * neither resolves nor inlines them — it writes the specifier into the bundle
 * and the composed loader answers it at load time. Nothing on the packaging
 * path therefore sees a specifier the plugin never declared: tsc reads the
 * ROOT tree (which carries most `@deepseek-ai/*` packages as devDependencies),
 * esbuild resolves nothing for an external, and `npm install
 * --legacy-peer-deps` installs no peer. The result is the shape of the incident
 * this suite already paid for once (`plugin-effort` calling an export its own
 * `geometry.ts` had stopped exporting, green everywhere, `ReferenceError` in
 * the renderer): a green log that vouches for a bundle whose import nothing
 * installed.
 *
 * Three verdicts, one per specifier the sources name:
 *
 *   1. an UNDECLARED package — the name is in no dependency field of the
 *      plugin's own manifest, of an ancestor manifest, and resolves from
 *      nothing on the plugin's resolution chain. This is the one the gate
 *      refuses.
 *   2. a KERNEL package imported for RUNTIME but not declared as a
 *      peerDependency — `@deepseek-ai/*` is provided by the running kernel,
 *      never installed from the registry for a user, so a plugin that imports
 *      one has to declare it as a PEER. tsc is satisfied by a devDependency and
 *      the pack carries no dependency information at all, so the mistake
 *      surfaces only when the kernel's module table fails to answer the
 *      specifier. Only an import esbuild KEEPS can fail that way, so a
 *      statement-level `import type` — erased, and resolved by tsc alone — is
 *      exempt; it is the Context-merge idiom (`import type {} from
 *      '@deepseek-ai/dsh-client-connection'`) seventeen plugins use.
 *   3. everything else — declared, or explained (see `explainSpecifier`).
 *
 * The specifier set is read from the plugin's own `src/**` only: that is what
 * esbuild bundles. Tests, `build.mjs` and `scripts/` run in the repository, not
 * in a user's profile, and are outside this gate.
 *
 * Measured over the suite: hundreds of package imports, none UNDECLARED, and one
 * kernel package imported for runtime while declared only as a devDependency —
 * `@deepseek-ai/schemastery` in `plugin-market`, which is red until it declares
 * the peer. Six others were closed the same way in `plugin-presets`,
 * `plugin-memory` and `plugin-rewind`. The exact count is deliberately not
 * written down: it moves with every plugin, and a stale number in a sentence
 * about "none UNDECLARED" is a claim nobody re-measures. Detail:
 * `docs/agents/build-and-release.md`.
 *
 * @module dsh-app/scripts/lib/plugin-imports
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { stripComments } from './strip-comments.mjs'

/** Extensions that hold a plugin's shipped sources. */
const SOURCE_FILE = /\.tsx?$/u

/** Directories a source walk never enters: neither is the plugin's own bytes. */
const NON_SOURCE_DIRS = new Set(['node_modules', 'lib', 'dist', '.test-dist', '.git'])

/** The three fields a specifier may be declared in. */
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'devDependencies']

/** Packages the running kernel's module table answers, whatever the manifest says. */
const KERNEL_PACKAGE = '@deepseek-ai/'

/** Every builtin, bare and `node:`-prefixed, as this Node reports them. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

/**
 * The source files under a plugin's `src/`, posix-relative, sorted by name.
 *
 * Sorted so two runs over one tree report the same order — a gate whose output
 * reorders itself is a gate whose diff nobody reads. Symlinks are skipped: a
 * link is not a source, and following one could walk into a runtime tree.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @returns `{ path, text }` per file, `path` posix-relative to the plugin.
 */
export function pluginSourceFiles(pluginDir) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (NON_SOURCE_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue
      found.push({ path: path.relative(pluginDir, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') })
    }
  }
  walk(path.join(pluginDir, 'src'))
  return found
}

/**
 * Every token a scanner needs, with the position the line number is read from.
 *
 * `kind` is `word` (an identifier or keyword), `string` (a quoted literal) or
 * `punct` (one character). Template literals become `template` tokens: their
 * contents are not scanned, so a specifier a `${}` computes is deliberately
 * invisible to this gate rather than guessed at.
 *
 * @param text - comment-stripped source.
 * @returns `{ kind, value, index }[]`, in source order.
 */
function tokenize(text) {
  const tokens = []
  let index = 0
  while (index < text.length) {
    const ch = text[index]
    if (/\s/u.test(ch)) {
      index += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== ch) end += text[end] === '\\' ? 2 : 1
      tokens.push({ kind: 'string', value: text.slice(index + 1, Math.min(end, text.length)), index })
      index = end + 1
      continue
    }
    if (ch === '`') {
      let end = index + 1
      while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1
      tokens.push({ kind: 'template', value: '', index })
      index = end + 1
      continue
    }
    if (ch === '/' && regexCanStartAfter(tokens[tokens.length - 1])) {
      let end = index + 1
      let inClass = false
      while (end < text.length) {
        const current = text[end]
        if (current === '\\') {
          end += 2
          continue
        }
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) break
        else if (current === '\n') break
        end += 1
      }
      index = end + 1
      continue
    }
    if (/[\w$]/u.test(ch)) {
      let end = index
      while (end < text.length && /[\w$]/u.test(text[end])) end += 1
      tokens.push({ kind: 'word', value: text.slice(index, end), index })
      index = end
      continue
    }
    tokens.push({ kind: 'punct', value: ch, index })
    index += 1
  }
  return tokens
}

/**
 * Whether a `/` at this position starts a regex literal rather than a division.
 *
 * The classic heuristic, and it only has to be right about one thing: a `/`
 * read as a division would let a regex's contents be scanned as code, and a
 * regex like `/from 'x'/` would then read as an import of `x`. Reading a real
 * division as a regex instead swallows one line and loses nothing — a division
 * cannot hide a specifier.
 *
 * @param previous - the token before the `/`, or undefined at the file's start.
 * @returns true when the `/` opens a regex literal.
 */
function regexCanStartAfter(previous) {
  if (previous === undefined) return true
  if (previous.kind === 'string' || previous.kind === 'template') return false
  if (previous.kind === 'word') {
    // A keyword is followed by an expression (`return /re/`), an identifier by
    // an operator (`a / b`).
    return new Set([
      'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
      'do', 'else', 'case', 'yield', 'await', 'throw',
    ]).has(previous.value)
  }
  return ![')', ']'].includes(previous.value)
}

/** How far back a statement's leading keyword is looked for; a static import is short. */
const STATEMENT_LOOKBACK = 400

/**
 * Every module specifier a source file names, with the line it is on.
 *
 * The pure core of the gate, and the only place a specifier is recognised.
 * Four shapes count, because all four must RESOLVE — for the bundle's loader,
 * for tsc, or for both:
 *
 *   - `import … from 'x'` and `import 'x'`
 *   - `export … from 'x'`
 *   - `import('x')`
 *   - `import type { … } from 'x'` — erased by esbuild, but tsc still has to
 *     resolve it, and tsc is the gate whose precondition this one feeds
 *
 * The context test is on the tokens around the literal, never a regex over the
 * text: a specifier is a string whose previous token is the word `from` or the
 * word `import`, or a `(` the word `import` opened. Comments are removed first
 * (quote-aware, line numbers kept), so a specifier quoted in a comment or a
 * JSDoc block is not an import.
 *
 * `typeOnly` marks the imports esbuild DELETES, which is what separates "must
 * resolve at load time" from "must resolve for tsc": a statement-level
 * `import type` / `export type`, decided by looking back for the statement's
 * leading keyword. An inline `type` modifier (`import { type A } from 'x'`) is
 * read as a value import — the conservative direction, since the stricter
 * reading only ever reports more.
 *
 * @param source - the file's text.
 * @returns `{ specifier, line, typeOnly }[]` in source order, duplicates included.
 */
export function importSpecifiers(source) {
  const text = stripComments(source)
  const lineStarts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lineStarts.push(index + 1)
  }
  const lineOf = (index) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (lineStarts[mid] <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }

  const tokens = tokenize(text)
  const found = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'string') continue
    const previous = tokens[index - 1]
    const before = tokens[index - 2]
    const afterFrom = previous?.kind === 'word' && previous.value === 'from' && !(before?.kind === 'punct' && before.value === '.')
    const afterImport = previous?.kind === 'word' && previous.value === 'import'
    const dynamic = previous?.kind === 'punct' && previous.value === '(' && before?.kind === 'word' && before.value === 'import'
    if (!afterFrom && !afterImport && !dynamic) continue
    found.push({ specifier: token.value, line: lineOf(token.index), typeOnly: isTypeOnlyStatement(tokens, index - 1) })
  }
  return found
}

/**
 * Whether the statement a token sits in is a type-only import or export.
 *
 * Walks back to the nearest `import` / `export` word, which is the statement's
 * own leading keyword — a static import holds no `;` before its `from`, so the
 * walk cannot leave the statement it started in, and it stops at one anyway.
 *
 * @param tokens - the file's tokens.
 * @param from - index of the token the walk starts at.
 * @returns true for `import type …` / `export type …`.
 */
function isTypeOnlyStatement(tokens, from) {
  for (let index = from; index >= 0 && index > from - STATEMENT_LOOKBACK; index -= 1) {
    const token = tokens[index]
    if (token.kind !== 'word') {
      if (token.kind === 'punct' && token.value === ';') return false
      continue
    }
    if (token.value === 'import' || token.value === 'export') return tokens[index + 1]?.kind === 'word' && tokens[index + 1].value === 'type'
  }
  return false
}

/**
 * The package a specifier names, or null when it names no package at all.
 *
 * Null for a relative path (`./x`, `../x`), an absolute path, a builtin — bare
 * (`node:fs`, `fs`) or `node:`-prefixed — and for a specifier that is not a
 * package name at all (a dynamic import's computed value, an empty string).
 * Subpaths resolve to their package: `react-dom/client` is `react-dom`,
 * `@scope/pkg/sub` is `@scope/pkg`.
 *
 * @param specifier - the literal as written.
 * @returns the package name, or null.
 */
export function packageNameOf(specifier) {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (BUILTINS.has(specifier)) return null
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) {
    return segments.length >= 2 && segments[0].length > 1 && segments[1] !== '' ? `${segments[0]}/${segments[1]}` : null
  }
  return segments[0] === '' ? null : segments[0]
}

/**
 * The DefinitelyTyped package a name's types would come from.
 *
 * `@types/react` for `react`; `@types/scope__pkg` for `@scope/pkg`, the name
 * DefinitelyTyped actually publishes. The same mapping `pluginMissingPeers`
 * uses, for the same reason: it is what tsc reads for an import whose package
 * is provided by the host rather than installed.
 */
function typesPackageFor(name) {
  if (!name.startsWith('@')) return `@types/${name}`
  const [scope, rest] = name.split('/')
  return `@types/${scope.slice(1)}__${rest}`
}

/** Read a directory's own manifest, or null when it has none. */
function readManifest(dir) {
  const manifestPath = path.join(dir, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

/** The names one manifest declares, across the three dependency fields. */
function declaredNames(manifest) {
  if (manifest === null) return new Set()
  return new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})))
}

/**
 * How a plugin's own manifest accounts for one package, or null when nothing does.
 *
 * The gate is deliberately wider than "declared in this plugin's own manifest",
 * because a package can be legitimately accounted for without that — and a gate
 * that refused those would be switched off within a week:
 *
 *   - `own` / `ancestor-manifest` — a dependency field names it. An ancestor's
 *     manifest counts for the same reason node's resolution walks upward: the
 *     repository root carries the kernel packages as devDependencies, and a
 *     plugin that imports one is not importing something nothing provides.
 *   - `installed` — a `node_modules/<name>/package.json` exists on the
 *     plugin's resolution chain. A transitively installed package (this tree's
 *     `@deepseek-ai/schemastery`, which arrives through the kernel packages) is
 *     present, and esbuild resolves and inlines a non-external import at build
 *     time, so its absence could not have reached a user.
 *   - `own-types` / `ancestor-manifest-types` / `installed-types` — the name's
 *     DefinitelyTyped package is the one accounted for. `react-dom` is the case
 *     this clause exists for: twelve plugins import it (esbuild marks it
 *     external, the host answers it) and every one of them declares
 *     `@types/react-dom` instead — the sibling npm idiom for a package whose
 *     types, not its code, are a plugin's own dependency. These are reported as
 *     `typesOnly`, so a green run can say how many specifiers rest on that
 *     weaker footing rather than counting them as plainly declared.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @param name - the package name.
 * @returns `{ via, typesOnly }`, or null when nothing explains it.
 */
export function explainSpecifier(pluginDir, name) {
  const types = typesPackageFor(name)
  for (let dir = path.resolve(pluginDir); ; dir = path.dirname(dir)) {
    const own = dir === path.resolve(pluginDir)
    const declared = declaredNames(readManifest(dir))
    if (declared.has(name)) return { via: own ? 'own' : 'ancestor-manifest', typesOnly: false }
    if (declared.has(types)) return { via: own ? 'own-types' : 'ancestor-manifest-types', typesOnly: true }
    for (const [lookup, typesOnly] of [[name, false], [types, true]]) {
      if (existsSync(path.join(dir, 'node_modules', lookup, 'package.json'))) {
        return { via: typesOnly ? 'installed-types' : 'installed', typesOnly }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
  }
}

/**
 * Every specifier a plugin's sources name that its own manifest cannot account for.
 *
 * Two rules, and the report says which one a finding broke:
 *
 *   - `undeclared` — nothing on the resolution chain accounts for the package.
 *   - `kernel-peer` — a `@deepseek-ai/*` package the plugin imports but does not
 *     declare as its OWN peerDependency. The kernel provides these at runtime;
 *     a devDependency satisfies tsc and travels nowhere, so the failure would
 *     wait for the user's first load. An ancestor's declaration cannot satisfy
 *     this rule: the kernel resolves a plugin's imports against the plugin's own
 *     declaration, and a package declared only at the root is not one the
 *     plugin promised to accept.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @returns `{ files, checked, gaps, typesOnly }` — `gaps` is one entry per
 *   offending specifier, `typesOnly` the packages explained only by their
 *   `@types/` sibling (empty on a tree that declares what it imports).
 */
export function pluginImportGaps(pluginDir) {
  const manifest = readManifest(pluginDir)
  const own = declaredNames(manifest)
  const peers = new Set(Object.keys(manifest?.peerDependencies ?? {}))
  const files = pluginSourceFiles(pluginDir)
  const gaps = []
  const typesOnly = new Set()
  let checked = 0
  for (const file of files) {
    for (const { specifier, line, typeOnly } of importSpecifiers(file.text)) {
      const name = packageNameOf(specifier)
      if (name === null) continue
      checked += 1
      const explanation = explainSpecifier(pluginDir, name)
      if (explanation === null) {
        gaps.push({
          file: file.path,
          line,
          specifier,
          pkg: name,
          rule: 'undeclared',
          suggestion: `declare "${name}" in dependencies, peerDependencies or devDependencies`,
        })
        continue
      }
      if (explanation.typesOnly) typesOnly.add(name)
      // Only the imports that survive the build: esbuild deletes a type-only
      // import, so nothing resolves it at load time and a devDependency — what
      // tsc needs and what `--legacy-peer-deps` installs — is the right field
      // for it. Requiring a peer there would refuse the Context-merge idiom
      // (`import type {} from '@deepseek-ai/dsh-client-connection'`) that
      // seventeen plugins use.
      if (!typeOnly && name.startsWith(KERNEL_PACKAGE) && !peers.has(name)) {
        gaps.push({
          file: file.path,
          line,
          specifier,
          pkg: name,
          rule: 'kernel-peer',
          suggestion: `declare "${name}" in peerDependencies as well (the kernel provides it at load time; a ${own.has(name) ? 'devDependency' : 'root-only declaration'} satisfies tsc and ships nothing)`,
        })
      }
    }
  }
  return { files: files.length, checked, gaps, typesOnly: [...typesOnly].sort() }
}

/**
 * Refuse a plugin whose sources import a package its own manifest cannot account for.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @returns the report, for a caller that wants to log what was found.
 * @throws {Error} naming the plugin and every offending specifier, with the
 *   field each one belongs in.
 */
export function assertPluginImports(pluginDir) {
  const report = pluginImportGaps(pluginDir)
  if (report.gaps.length === 0) return report
  const lines = report.gaps.map(
    (gap) => `${gap.file}:${String(gap.line)} imports "${gap.specifier}" — ${gap.suggestion}`,
  )
  throw new Error(
    `[plugin-gate] ${path.basename(pluginDir)}: ${String(report.gaps.length)} import(s) its own package.json does not account for — refusing to pack it.\n`
    + lines.map((line) => `  - ${line}`).join('\n'),
  )
}

/**
 * The one line that must accompany a run in which specifiers rested on a weaker explanation.
 *
 * Same discipline as `typecheckSkipSummary`: a green run must not read as more
 * than it checked. The count is printed either way, and the packages explained
 * only by a `@types/` sibling are named, because that clause is the one a
 * reader would otherwise assume away.
 *
 * @param total - plugins the run covered.
 * @param checked - import specifiers naming a package.
 * @param typesOnly - packages explained only by their DefinitelyTyped sibling.
 * @returns the log line, prefixed like every other verdict.
 */
export function importGateSummary(total, checked, typesOnly) {
  const base = `[plugin-gate] import gate: ${String(checked)} package import(s) across ${String(total)} plugins, all declared`
  if (typesOnly.length === 0) return `${base} in a dependency field or installed on the resolution chain`
  return `${base} — ${String(typesOnly.length)} only through their @types/ sibling (${typesOnly.join(', ')})`
}
