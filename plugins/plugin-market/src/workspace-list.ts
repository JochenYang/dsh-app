/**
 * One list key of the profile's pnpm-workspace.yaml, merged in place.
 *
 * Two pnpm supply-chain policies need a list in that file: the build-script
 * whitelist (`onlyBuiltDependencies`, see build-allow.ts) and the release-age
 * exclusion list (`minimumReleaseAgeExclude`, see release-age.ts). Both writes
 * must obey the same discipline, which is why the document surgery lives here
 * once:
 *
 *   - the target key is the ONLY thing the merge touches; a read-modify-write
 *     preserves every existing byte it does not own (user-edited settings,
 *     comments, ordering, line endings);
 *   - list items and inserted lines adopt the file's line endings;
 *   - values are plain YAML scalars only — anything that could terminate the
 *     scalar (whitespace, quotes, colons, comments, alias/tag marks) is
 *     refused rather than written;
 *   - writes are atomic (tmp + rename) so a concurrent package-manager run
 *     never observes a half-written file.
 *
 * @module @dsh-app/plugin-market/workspace-list
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MarketValidationError } from './errors.ts'

/** A list-item line under the key (`- <scalar>`), indent captured. */
const ITEM_LINE = /^(\s*)-\s+(.*)$/

/**
 * YAML-safety fence for values this module writes: a scalar whose characters
 * cannot end it early. Upper case is admitted because a version tag may carry
 * one (`1.0.0-RC.1`); everything else that YAML would treat specially —
 * whitespace, quotes, `:`, `#`, `*`, `~`, newlines — is out.
 */
const SAFE_YAML_SCALAR = /^[A-Za-z0-9@][A-Za-z0-9@/._+-]{0,213}$/

/** The key line in block style (`key:` alone on the line). */
function blockKeyPattern(key: string): RegExp {
  return new RegExp(`^${key}:\\s*(?:#.*)?$`)
}

/** The key line in flow style (`key: [a, b]`), capturing the inner list. */
function flowKeyPattern(key: string): RegExp {
  return new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*(?:#.*)?$`)
}

/**
 * Render one value as a YAML scalar. Plain when the shape is unambiguous;
 * single-quoted otherwise (a scoped name or a `name@version` entry starts with
 * `@`, a YAML reserved indicator that would corrupt a plain scalar).
 */
function yamlScalar(value: string): string {
  return /^[a-z0-9][a-z0-9/._-]*$/.test(value) ? value : `'${value}'`
}

/** Trim, drop a trailing comment, unwrap one quote pair. */
function scalarOf(raw: string): string {
  let value = raw.trim().replace(/\s+#.*$/, '')
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

/**
 * Build the error a refused value raises. The rule (below) lives here once;
 * the wording and the message code belong to the caller, whose dictionary the
 * panel resolves.
 */
export type ValueRefusal = (value: string) => MarketValidationError

/** Default refusal, for a caller with no message of its own. */
const genericRefusal: ValueRefusal = value => new MarketValidationError({
  code: 'workspaceList.unsafeValue',
  params: { value },
  text: `the value cannot be written into pnpm-workspace.yaml safely: "${value}"`,
})

/** Validate the caller-supplied values before any of them reaches the file. */
function assertSafeValues(values: readonly string[], refuse: ValueRefusal): void {
  for (const value of values) {
    // A value that cannot be a plain YAML scalar is refused rather than
    // quoted blindly: it could terminate the scalar and inject a sibling key.
    if (!SAFE_YAML_SCALAR.test(value)) throw refuse(value)
  }
}

/** The minimal workspace document created when no file exists yet. */
export function minimalWorkspace(key: string, values: readonly string[]): string {
  const items = values.map(value => `  - ${yamlScalar(value)}\n`).join('')
  return `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n${key}:\n${items}`
}

/**
 * Merge `values` into the `key` list of a pnpm-workspace.yaml document,
 * touching nothing else.
 *
 * - no file (null) → the minimal workspace document carrying the list;
 * - block-style key → new values appended after the last existing item,
 *   deduped against it (an already-listed value changes nothing);
 * - flow-style key → rewritten with the merged list;
 * - no key → the key appended at the end.
 *
 * @param existing - the current file content, or null when the file is absent.
 * @param key - the list key to merge into (a top-level pnpm setting).
 * @param values - values to list (pre-validated by the caller).
 * @param refuse - error factory for a value that cannot be written safely.
 * @returns the new content; the input itself when nothing would change.
 */
export function withWorkspaceList(
  existing: string | null,
  key: string,
  values: readonly string[],
  refuse: ValueRefusal = genericRefusal,
): string {
  assertSafeValues(values, refuse)
  if (existing === null) return minimalWorkspace(key, values)
  const elements = existing.split(/(?<=\n)/)
  // Inserted lines adopt the file's line endings; existing bytes stay as-is.
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'

  const block = blockKeyPattern(key)
  const keyIndex = elements.findIndex(element => block.test(element.replace(/\r?\n$/, '')))
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
    const additions = values.filter(value => !current.includes(value))
    if (additions.length === 0) return existing
    const rows = additions.map(value => `${indent}- ${yamlScalar(value)}${eol}`)
    elements.splice(lastItem >= 0 ? lastItem + 1 : keyIndex + 1, 0, ...rows)
    return elements.join('')
  }

  const flow = flowKeyPattern(key)
  const flowIndex = elements.findIndex(element => flow.test(element.replace(/\r?\n$/, '')))
  if (flowIndex >= 0) {
    const match = flow.exec(elements[flowIndex]!.replace(/\r?\n$/, ''))!
    const current = match[1]!.trim() === '' ? [] : match[1]!.split(',').map(scalarOf)
    const additions = values.filter(value => !current.includes(value))
    if (additions.length === 0) return existing
    const lineEnd = /\r?\n$/.exec(elements[flowIndex]!)?.[0] ?? eol
    elements[flowIndex] = `${key}: [${[...current, ...additions].map(yamlScalar).join(', ')}]${lineEnd}`
    return elements.join('')
  }

  const appended = `${key}:${eol}${values.map(value => `  - ${yamlScalar(value)}${eol}`).join('')}`
  const last = elements[elements.length - 1]
  if (last !== undefined && !/\n$/.test(last)) elements[elements.length - 1] = last + eol
  return [...elements, appended].join('')
}

/**
 * Merge `values` into the key's list on disk (creates the file and its parent
 * directory when absent). The write is atomic (tmp + rename).
 * @param path - absolute path of the profile's pnpm-workspace.yaml.
 * @param key - the list key to merge into.
 * @param values - values to list (pre-validated by the caller).
 * @param refuse - error factory for a value that cannot be written safely.
 * @returns whether the file content changed.
 */
export function writeWorkspaceList(
  path: string,
  key: string,
  values: readonly string[],
  refuse: ValueRefusal = genericRefusal,
): boolean {
  let current: string | null = null
  try {
    current = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const next = withWorkspaceList(current, key, values, refuse)
  if (next === current) return false
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, path)
  return true
}
