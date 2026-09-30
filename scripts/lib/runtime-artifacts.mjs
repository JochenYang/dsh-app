// Discovery and retention for the artifacts under `runtime-dist/`.
//
// The directory accumulates one runtime tarball and one office payload per
// kernel version, each with a `.sha512` sidecar. Nothing ever reads an older
// one back: the shell resolves a kernel through release metadata (never a local
// file), and `prepare-bundled-kernel.mjs` takes the HIGHEST version present. So
// every kernel-line bump leaves a few hundred megabytes that no code can use
// again — measured after three lines, `runtime-dist/` held 1.9 GB, of which the
// three superseded runtime+payload pairs were ~570 MB.
//
// The rule here is deliberately narrow, because the wrong delete is expensive:
//
//   * only names shaped `<prefix><platform>-<arch>-<version>.tgz[.sha512]` are
//     candidates — `manifest.json`, `runtime-files-<cell>.json` and
//     `office-payload-<cell>.json` do not carry a version and are never touched;
//   * only the cell being built is considered, so a Windows build cannot delete
//     a darwin artifact another cell of the same release still needs;
//   * directories (`work/`, `primary-runtime-*`, the cache dirs) are out of
//     scope by construction — every candidate is a file name, and the caller
//     deletes with a non-recursive unlink.
//
// Kept pure and separate from the build so the selection is testable without a
// build, a network or a 100 MB tarball.
import semver from 'semver'

/** Release asset prefix of a runtime tarball (`dsh-runtime-<platform>-<arch>-<version>.tgz`). */
export const RUNTIME_PREFIX = 'dsh-runtime-'

/**
 * Release asset prefix of an office payload tarball
 * (`office-payload-<platform>-<arch>-<dshVersion>.tgz`). The version segment is
 * the KERNEL version, not the payload's own content version — that one lives
 * inside the archive's manifest, which is why the name can be matched here.
 */
export const OFFICE_PAYLOAD_PREFIX = 'office-payload-'

const TGZ = '.tgz'
const SHA512_SIDECAR = '.tgz.sha512'

/**
 * The version segment of one artifact name, or null when the name is not an
 * artifact of this cell.
 *
 * The sidecar suffix is tested first: `….tgz.sha512` does not end in `.tgz`, so
 * the reverse order would silently skip every sidecar and leave them orphaned.
 *
 * @param name - a bare file name (no directory part).
 * @param prefix - {@link RUNTIME_PREFIX} or {@link OFFICE_PAYLOAD_PREFIX}.
 * @param platform - Node platform of the cell (`win32`).
 * @param arch - Node arch of the cell (`x64`).
 * @returns the version segment, or null.
 */
export function artifactVersion(name, prefix, platform, arch) {
  const head = `${prefix}${platform}-${arch}-`
  if (!name.startsWith(head)) return null
  const tail = name.slice(head.length)
  const version = tail.endsWith(SHA512_SIDECAR)
    ? tail.slice(0, -SHA512_SIDECAR.length)
    : tail.endsWith(TGZ) ? tail.slice(0, -TGZ.length) : null
  // An empty version (`dsh-runtime-win32-x64-.tgz`) is not an artifact, and a
  // separator would mean the name smuggles a path rather than a version.
  if (version === null || version === '' || version.includes('/') || version.includes('\\')) return null
  return version
}

/**
 * Newest runtime tarball of one cell among `names`, or null when the cell has
 * none.
 *
 * Semver order when both candidates parse (the normal case), with a string
 * comparison as the fallback so an odd version string still yields a
 * deterministic answer instead of undefined.
 *
 * @param names - bare file names to choose from.
 * @param platform - Node platform of the cell.
 * @param arch - Node arch of the cell.
 * @returns the newest `dsh-runtime-…tgz` name, or null.
 */
export function newestRuntimeTarball(names, platform, arch) {
  const candidates = names.filter((name) => artifactVersion(name, RUNTIME_PREFIX, platform, arch) !== null && name.endsWith(TGZ))
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => {
    const va = artifactVersion(a, RUNTIME_PREFIX, platform, arch)
    const vb = artifactVersion(b, RUNTIME_PREFIX, platform, arch)
    if (semver.valid(va) !== null && semver.valid(vb) !== null) return semver.rcompare(va, vb)
    return vb.localeCompare(va)
  })[0]
}

/**
 * Artifacts of one cell that belong to a version other than `keepVersion`.
 *
 * A runtime tarball and its office payload are listed independently, so a run
 * that built only one of the two still clears what it superseded. Sidecars
 * travel with their tarball because {@link artifactVersion} reads them as the
 * same version.
 *
 * @param names - bare file names present in `runtime-dist/`.
 * @param options - the cell and the version to keep.
 * @param options.platform - Node platform of the cell.
 * @param options.arch - Node arch of the cell.
 * @param options.keepVersion - the version just built; never listed.
 * @returns the file names to delete, sorted for a stable log line.
 */
export function staleCellArtifacts(names, { platform, arch, keepVersion }) {
  const stale = []
  for (const name of names) {
    for (const prefix of [RUNTIME_PREFIX, OFFICE_PAYLOAD_PREFIX]) {
      const version = artifactVersion(name, prefix, platform, arch)
      if (version === null || version === keepVersion) continue
      stale.push(name)
      break
    }
  }
  return stale.sort()
}
