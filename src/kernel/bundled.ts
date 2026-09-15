import semver from 'semver'
import type { CurrentKernel } from '../shared/types'

/**
 * The fields the boot check reads from the installer's
 * `resources/kernel/manifest.json`. All optional on purpose: the file is read
 * with a plain JSON.parse, so a truncated or hand-edited copy must be able to
 * answer "do not adopt" instead of taking the boot down.
 */
export interface BundledManifestFields {
  dshVersion?: string
  suiteVersion?: string
  platform?: string
  arch?: string
}

export type BundledAdoptionReason =
  | 'platform-mismatch'
  | 'already-adopted'
  | 'online-ahead'
  | 'not-adopted-yet'

export interface BundledAdoptionDecision {
  /** True when the caller should re-activate the bundled tarball. */
  adopt: boolean
  reason: BundledAdoptionReason
}

/**
 * Decide whether the runtime bundled inside this shell build should replace
 * the active installation.
 *
 * The versioned kernel directory is named `dsh-<v>+suite-<v>`, so a NEW shell
 * shipping a same-version kernel whose content changed (the brand suite gained
 * a plugin) would otherwise have its directory reused verbatim and the new
 * content would never land — linkSuitePlugins then bails on the missing member
 * and the whole suite silently boots vanilla.
 *
 * Adoption is keyed on the bundle's semantic identity
 * (`<dshVersion>+<suiteVersion>` from the runtime's own manifest.json), never
 * on the tarball sha512: a packaged runtime tarball is not byte-reproducible
 * across builds (file mtimes and entry order differ), so comparing hashes
 * would re-extract an already-identical runtime on every boot.
 *
 * `active` is a structural subset of CurrentKernel, which keeps the decision
 * testable without touching a disk.
 */
export function decideBundledAdoption(
  bundled: BundledManifestFields,
  active: Pick<CurrentKernel, 'manifest' | 'bundledStamp'>,
): BundledAdoptionDecision {
  // A runtime built for another cell can never be activated here.
  if (bundled.platform !== active.manifest.platform || bundled.arch !== active.manifest.arch) {
    return { adopt: false, reason: 'platform-mismatch' }
  }

  const stamp = bundled.dshVersion !== undefined && bundled.suiteVersion !== undefined
    ? `${bundled.dshVersion}+${bundled.suiteVersion}`
    : undefined

  // "Has this install already adopted this exact bundle?" — the only question
  // that matters here, and one version arithmetic cannot answer: the previous
  // `sameVersion && suiteDrift` test fired just as readily when the bundle's
  // suite was OLDER than the installed one, silently downgrading a kernel the
  // user had already updated online.
  if (stamp !== undefined && active.bundledStamp === stamp) {
    return { adopt: false, reason: 'already-adopted' }
  }

  // An online update ahead of this shell's bundled kernel must survive: the
  // bundle is a snapshot from build time and is routinely older than what the
  // user installed from the registry.
  //
  // semver.gt throws on an unparseable version — the same behaviour the inline
  // check had before this extraction, and why the boot path keeps its
  // try/catch around the whole check.
  if (bundled.dshVersion !== undefined && semver.gt(active.manifest.dshVersion, bundled.dshVersion)) {
    return { adopt: false, reason: 'online-ahead' }
  }

  return { adopt: true, reason: 'not-adopted-yet' }
}
