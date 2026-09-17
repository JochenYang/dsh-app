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
 * module touches. The document surgery itself (byte preservation, line
 * endings, scalar safety, atomic write) lives in workspace-list.ts, shared
 * with the release-age exclusion list.
 *
 * @module @dsh-app/plugin-market/build-allow
 */

import { MarketValidationError } from './errors.ts'
import { writeWorkspaceList, withWorkspaceList, type ValueRefusal } from './workspace-list.ts'

/** The single workspace key this module owns. */
const ALLOW_KEY = 'onlyBuiltDependencies'

/**
 * Message for a name that could not be written as a plain YAML scalar.
 * Package names arrive validated through the npm grammar, but the grammar
 * admits leading `*`/`~`, which YAML would read as alias/null — those must
 * never reach the file.
 */
const refuseName: ValueRefusal = name => new MarketValidationError({
  code: 'buildAllow.unsafeName',
  params: { name },
  text: `the package name cannot be written into the build-script whitelist safely: "${name}"`,
})

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
  return withWorkspaceList(existing, ALLOW_KEY, packages, refuseName)
}

/**
 * Merge `packages` into the whitelist file on disk (creates the file and its
 * parent directory when absent). The write is atomic (tmp + rename).
 * @param path - absolute path of the profile's pnpm-workspace.yaml.
 * @param packages - package names to allow (pre-validated by the caller).
 * @returns whether the file content changed.
 */
export function allowBuilds(path: string, packages: readonly string[]): boolean {
  return writeWorkspaceList(path, ALLOW_KEY, packages, refuseName)
}
