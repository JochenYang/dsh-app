/**
 * pnpm build-script allowance for the profile.
 *
 * pnpm ≥10 refuses to run dependency build scripts unless the package is
 * whitelisted under `onlyBuiltDependencies` in `pnpm-workspace.yaml` next to
 * the profile manifest — a blocked build leaves the dependency installed but
 * without its postinstall output (native binaries), which surfaces only as a
 * broken plugin at runtime. When the install output carries pnpm's blocked
 * signal, this module merges the named packages into that whitelist so a
 * retry can run the scripts.
 *
 * Scope discipline mirrors patchfile.ts: the whitelist is the ONLY key this
 * module touches. A read-modify-write preserves every existing byte it does
 * not own (user-edited settings, comments, ordering); writes are atomic
 * (tmp + rename) so a concurrent package-manager run never observes a
 * half-written file.
 *
 * @module @dsh-app/plugin-market/build-allow
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MarketValidationError } from './errors.ts'

/** The single workspace key this module owns. */
const ALLOW_KEY = 'onlyBuiltDependencies'

/** The key line in block style; list items follow on deeper-indented lines. */
const KEY_LINE = /^onlyBuiltDependencies:\s*(?:#.*)?$/
/** The key line in flow style (`onlyBuiltDependencies: [a, b]`). */
const KEY_LINE_FLOW = /^onlyBuiltDependencies:\s*\[(.*)\]\s*(?:#.*)?$/
/** A list-item line under the key (`- <scalar>`), indent captured. */
const ITEM_LINE = /^(\s*)-\s+(.*)$/

/**
 * YAML-safety fence for names this module writes: plain scalars only, no
 * whitespace or YAML indicators (quotes, colons, comments, alias/tag marks,
 * boolean/null lookalikes). Package names arrive validated through the npm
 * grammar, but the grammar admits leading `*`/`~` which YAML would parse as
 * alias/null — those must never reach the file, so this check is the boundary.
 */
const SAFE_YAML_SCALAR = /^[a-z0-9@][a-z0-9@/._-]{0,213}$/

/**
 * Render one name as a safe YAML scalar. Plain when the shape is unambiguous;
 * single-quoted otherwise (scoped names start with `@`, a YAML reserved
 * indicator that would corrupt a plain scalar).
 */
function yamlScalar(name: string): string {
  return /^[a-z0-9][a-z0-9/._-]*$/.test(name) ? name : `'${name}'`
}

/** Trim, drop a trailing comment, unwrap one quote pair. */
function scalarOf(raw: string): string {
  let value = raw.trim().replace(/\s+#.*$/, '')
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

/** Validate the caller-supplied names before any of them reaches the file. */
function assertSafeNames(packages: readonly string[]): void {
  for (const name of packages) {
    if (!SAFE_YAML_SCALAR.test(name)) {
      throw new MarketValidationError(`包名不能安全写入构建脚本白名单：「${name}」`)
    }
  }
}

/** The minimal workspace document created when no file exists yet. */
function minimalWorkspace(packages: readonly string[]): string {
  const items = packages.map(name => `  - ${yamlScalar(name)}\n`).join('')
  return `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n${ALLOW_KEY}:\n${items}`
}

/**
 * Merge `packages` into the `onlyBuiltDependencies` whitelist of a
 * pnpm-workspace.yaml document, touching nothing else.
 *
 * - no file (null) → the minimal workspace document with the whitelist;
 * - block-style key → new names appended after the last existing item,
 *   deduped against it (an already-listed name changes nothing);
 * - flow-style key → rewritten with the merged list;
 * - no key → the key appended at the end.
 *
 * @param existing - the current file content, or null when the file is absent.
 * @param packages - package names to allow (pre-validated by the caller).
 * @returns the new content; the input itself when nothing would change.
 */
export function withAllowedBuilds(existing: string | null, packages: readonly string[]): string {
  assertSafeNames(packages)
  if (existing === null) return minimalWorkspace(packages)
  const elements = existing.split(/(?<=\n)/)
  // Inserted lines adopt the file's line endings; existing bytes stay as-is.
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'

  const keyIndex = elements.findIndex(element => KEY_LINE.test(element.replace(/\r?\n$/, '')))
  if (keyIndex >= 0) {
    let lastItem = -1
    let indent = '  '
    const current: string[] = []
    for (let i = keyIndex + 1; i < elements.length; i += 1) {
      const line = elements[i]!.replace(/\r?\n$/, '')
      const item = ITEM_LINE.exec(line)
      if (item === null) break
      if (current.length === 0) indent = item[1]!
      current.push(scalarOf(item[2]!))
      lastItem = i
    }
    const additions = packages.filter(name => !current.includes(name))
    if (additions.length === 0) return existing
    const rows = additions.map(name => `${indent}- ${yamlScalar(name)}${eol}`)
    elements.splice(lastItem >= 0 ? lastItem + 1 : keyIndex + 1, 0, ...rows)
    return elements.join('')
  }

  const flow = elements.findIndex(element => KEY_LINE_FLOW.test(element.replace(/\r?\n$/, '')))
  if (flow >= 0) {
    const match = KEY_LINE_FLOW.exec(elements[flow]!.replace(/\r?\n$/, ''))!
    const current = match[1]!.trim() === '' ? [] : match[1]!.split(',').map(scalarOf)
    const additions = packages.filter(name => !current.includes(name))
    if (additions.length === 0) return existing
    const lineEnd = /\r?\n$/.exec(elements[flow]!)?.[0] ?? eol
    elements[flow] = `${ALLOW_KEY}: [${[...current, ...additions].map(yamlScalar).join(', ')}]${lineEnd}`
    return elements.join('')
  }

  const block = `${ALLOW_KEY}:${eol}${packages.map(name => `  - ${yamlScalar(name)}${eol}`).join('')}`
  const last = elements[elements.length - 1]
  if (last !== undefined && !/\n$/.test(last)) elements[elements.length - 1] = last + eol
  return [...elements, block].join('')
}

/**
 * Merge `packages` into the whitelist file on disk (creates the file and its
 * parent directory when absent). The write is atomic (tmp + rename).
 * @param path - absolute path of the profile's pnpm-workspace.yaml.
 * @param packages - package names to allow (pre-validated by the caller).
 * @returns whether the file content changed.
 */
export function allowBuilds(path: string, packages: readonly string[]): boolean {
  let current: string | null = null
  try {
    current = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const next = withAllowedBuilds(current, packages)
  if (next === current) return false
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, path)
  return true
}
