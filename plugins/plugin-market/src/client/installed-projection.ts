/**
 * Client projections over the installed view, kept free of node/framework
 * imports so the node:test suite can pin them: the installed tab's two
 * counts — the label counts every installed package (the user reads the
 * number as "what do I have"), while the update badge counts only the
 * backlog the panel can act on — and the catalog card's same-name verdict,
 * which applies the identity rule: the npm name is not an identity, the
 * normalized repo key is.
 *
 * @module @dsh-app/plugin-market/client/installed-projection
 */

import { normalizeNpmName, sameOrigin } from '../identity.ts'

/** The InstalledPackage slice the update projections need. */
export interface UpdatableProbe {
  /** True only when the registry reports a newer version. */
  readonly updateAvailable?: boolean
  /** Suite entries are host-managed and never individually updatable. */
  readonly suite?: boolean
  /** Local/git installs have no registry identity and are never updatable. */
  readonly source?: 'local' | 'git' | 'registry'
}

/** The InstalledPackage slice the same-name verdict needs. */
export interface SameNameProbe {
  /** The dependency spec's source; a registry install can share the name with a catalog entry. */
  readonly source?: 'local' | 'git' | 'registry'
  /** Normalized repo identity from the package's own manifest (absent = unprovable). */
  readonly repoKey?: string
}

/**
 * Packages with a pending update the panel can act on (suite excluded, since
 * suite versions are owned by the desktop shell, not by one-click updates;
 * local/git installs excluded, since updating them would replace the user's
 * development version with the npm release). Returns the original objects so
 * the batch-update loop can pass each one straight to the update route.
 */
export function updatablePackages<T extends UpdatableProbe>(packages: readonly T[]): T[] {
  return packages.filter(pkg =>
    pkg.updateAvailable === true
    && !pkg.suite
    && pkg.source !== 'local'
    && pkg.source !== 'git',
  )
}

/** The slice the two-phase update merge reads from the probed (`?updates=1`) rows. */
export interface UpdateFactsRow {
  readonly name: string
  /** Registry `latest` at probe time (absent = unknown or the lookup failed). */
  readonly latest?: string
  /** True only when the probe found a newer version. */
  readonly updateAvailable?: boolean
}

/**
 * Merge the update facts of the `?updates=1` answer onto the local rows
 * already on screen, keyed by normalized npm name. Only `latest` /
 * `updateAvailable` come from the probe — the local read stays authoritative
 * for every other field, and a row the probe no longer knows keeps its
 * current facts. Returns the SAME array when no row changed, so a probe that
 * confirms "no updates" (the common case) cannot rebuild the list and reset
 * its scroll position or flicker.
 */
export function mergeUpdateFacts<T extends UpdateFactsRow>(
  current: readonly T[],
  probed: readonly UpdateFactsRow[],
): readonly T[] {
  const byName = new Map(probed.map(row => [normalizeNpmName(row.name), row]))
  let changed = false
  const next = current.map((pkg) => {
    const patch = byName.get(normalizeNpmName(pkg.name))
    if (patch === undefined) return pkg
    const updateAvailable = patch.updateAvailable === true ? true : undefined
    if (pkg.latest === patch.latest && pkg.updateAvailable === updateAvailable) return pkg
    changed = true
    return {
      ...pkg,
      ...(patch.latest !== undefined ? { latest: patch.latest } : {}),
      ...(updateAvailable === true ? { updateAvailable: true } : {}),
    }
  })
  return changed ? next : current
}

/**
 * The same-name verdict of a catalog card: what an installed package with
 * the entry's npm name actually is.
 *
 * - `same-origin` — the registry install whose repo key matches the entry:
 *   the same plugin, so the 已安装/更新 path applies.
 * - `cross-origin` — a registry install from another (or unknown) repo: a
 *   different plugin sharing the name, so the card warns and its install is
 *   an explicitly confirmed replacement.
 * - `local-git` — the user-managed dev install the market never offers to
 *   overwrite; `sameRepo` marks the informational case where it provably
 *   comes from the entry's repo.
 *
 * An unknown side never matches (sameOrigin's conservative stance), so a
 * name collision without repo evidence stays on the cautious branch.
 */
export type SameNameState =
  | { readonly kind: 'none' }
  | { readonly kind: 'same-origin' }
  | { readonly kind: 'cross-origin' }
  | { readonly kind: 'local-git', readonly sameRepo: boolean }

export function sameNameStateOf(
  entry: { readonly repoKey?: string },
  pkg: SameNameProbe | undefined,
): SameNameState {
  if (pkg === undefined) return { kind: 'none' }
  const sameRepo = sameOrigin(entry.repoKey ?? null, pkg.repoKey ?? null)
  if (pkg.source === 'local' || pkg.source === 'git') return { kind: 'local-git', sameRepo }
  return sameRepo ? { kind: 'same-origin' } : { kind: 'cross-origin' }
}
