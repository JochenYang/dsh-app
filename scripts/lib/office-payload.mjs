// Office payload: the separately published artifact that carries the
// LibreOffice kit, its per-platform engine and (when staged) the Python set the
// office skills run on.
//
// Why it is a separate artifact: the engine is ~330 MiB unpacked and is only
// needed when a document is actually converted, while the runtime artifact is
// downloaded by every user on every kernel update. The kit package itself stays
// in the runtime as a tiny loader shim (scripts/runtime-stubs/libreoffice-kit),
// because `@deepseek-ai/dsh-office-to-pdf` imports the specifier statically and
// would fail to LOAD without it.
//
// Naming:
//   office-payload-<platform>-<arch>-<dshVersion>.tgz        (+ .sha512)
//   office-payload-<platform>-<arch>.json                    release sidecar manifest
//
// Two names, two different versions, both load-bearing:
//   * the ASSET name carries the dsh version, because a release's assets are
//     version-addressed (the mirror completeness check reads a runtime release
//     that way, and it must be able to tell which kernel a payload belongs to);
//   * the payload's own version (inside the manifest) is the CONTENT identity —
//     kit version, plus the Python version when a Python set is carried — which
//     is what the shell keys the installed directory on. A kernel update
//     therefore installs nothing at all when the payload it needs is the
//     payload already on disk, and a rollback never re-downloads it.
//
// The `office-payload-` prefix is deliberate beyond looks: the mirror's
// `is_layer_asset` treats `node-|vendor-|meta-|suite-|dsh-`-prefixed tarballs as
// split-runtime layers and requires every one of them to be named by a layer
// index (`runtime_layer_problems`). A payload named `dsh-office-payload-…`
// would match that pattern and fail the mirror run as an orphan layer.
import path from 'node:path'

/** Top-level directory inside the payload tarball, and the leaf of its install path. */
export const PAYLOAD_ARCHIVE_DIR = 'payload'

/** The payload's own metadata file, at the root of the archive. */
export const PAYLOAD_MANIFEST_FILE = 'manifest.json'

/** The directory an optional Python set occupies inside the archive. */
export const PAYLOAD_PRIMARY_RUNTIME_DIR = 'primary-runtime'

/** Package holding the conversion API; the runtime carries a shim of it. */
export const OFFICE_KIT_PACKAGE = '@deepseek-ai/libreoffice-kit'

/** Where the kit's runtime dependencies and its engine live inside the payload. */
export const PAYLOAD_MODULES_DIR = 'node_modules'

/** The engine package a target loads, named as the kit declares it. */
export function kitEnginePackage(engine) {
  return `${OFFICE_KIT_PACKAGE}-${engine}`
}

/**
 * Release asset name of one cell's payload tarball.
 * @param platform - Node platform of the artifact (win32 | darwin | linux).
 * @param arch - Node arch of the artifact (x64 | arm64).
 * @param dshVersion - kernel version whose release carries it.
 */
export function officePayloadAssetName(platform, arch, dshVersion) {
  return `office-payload-${platform}-${arch}-${dshVersion}.tgz`
}

/**
 * Release asset name of the payload's metadata sidecar. Platform-suffixed like
 * `manifest-<platform>-<arch>.json`, so six parallel cells never clobber a
 * shared name.
 */
export function officePayloadManifestName(platform, arch) {
  return `office-payload-${platform}-${arch}.json`
}

/**
 * The payload's content identity — what the shell keys the installed directory
 * on. Never the dsh version: that would re-download the engine on every kernel
 * update, which is the cost this artifact exists to remove.
 *
 * @param kitVersion - version of the installed `@deepseek-ai/libreoffice-kit`.
 * @param pythonVersion - Python version of a carried Python set, or null.
 * @returns a version string usable as a directory and an asset-name component.
 */
export function officePayloadVersion(kitVersion, pythonVersion = null) {
  return pythonVersion === null || pythonVersion === ''
    ? String(kitVersion)
    : `${String(kitVersion)}-py${String(pythonVersion)}`
}

/**
 * The payload manifest, written inside the archive and copied beside the
 * tarball (where the copy additionally carries `integrity` and `publishedAt`).
 *
 * @param input - payload identity and components.
 * @returns the document to serialize.
 */
export function createOfficePayloadManifest(input) {
  return {
    payloadVersion: input.payloadVersion,
    dshVersion: input.dshVersion,
    platform: input.platform,
    arch: input.arch,
    components: {
      kit: input.kitVersion,
      engine: input.engine,
      python: input.pythonVersion ?? null,
    },
    source: 'artifact',
  }
}

/** Fields the reader requires, and their accepted shapes. */
const COMPONENT_KEYS = ['kit', 'engine', 'python']

/**
 * Problems with a payload manifest, for a given target; an empty list means it
 * is usable. The shell's own reader (`src/kernel/office-payload.ts`) applies
 * the same rules to what it extracts — this is the build-side half of one
 * contract, and `test/office-payload.test.mjs` drives both with one fixture so
 * the two cannot drift apart.
 *
 * @param value - parsed manifest.json.
 * @param target - `{ platform, arch, engine? }` the manifest must describe.
 *   The engine is optional because the release sidecar is validated before the
 *   engine is known; the shell (which does know it) passes it.
 * @param expectedVersion - payload version the kernel requires, when known.
 * @returns a list of human-readable problems.
 */
export function officePayloadManifestProblems(value, target, expectedVersion) {
  const problems = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['the manifest is not a JSON object']
  const record = value
  if (typeof record.payloadVersion !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(record.payloadVersion)) {
    problems.push('manifest.payloadVersion is missing or not a version-shaped string')
  } else if (expectedVersion !== undefined && expectedVersion !== null && record.payloadVersion !== expectedVersion) {
    problems.push(`the payload is version ${record.payloadVersion}, but this kernel requires ${expectedVersion}`)
  }
  if (typeof record.dshVersion !== 'string' || record.dshVersion === '') problems.push('manifest.dshVersion is missing')
  if (record.platform !== target.platform || record.arch !== target.arch) {
    problems.push(`the payload is built for ${String(record.platform)}-${String(record.arch)}, not ${target.platform}-${target.arch}`)
  }
  const components = record.components
  if (typeof components !== 'object' || components === null || Array.isArray(components)) {
    problems.push('manifest.components is missing')
  } else {
    for (const key of COMPONENT_KEYS) {
      const component = components[key]
      if (component !== null && (typeof component !== 'string' || component === '')) {
        problems.push(`manifest.components.${key} must be a non-empty string or null`)
      }
    }
    // Without an engine the artifact cannot convert anything: the whole reason
    // the payload is downloaded. A manifest that claims none is refused here so
    // the client never installs a payload that answers nothing.
    if (components.engine === null || components.engine === undefined) {
      problems.push('manifest.components.engine is null: this payload carries no engine')
    } else if (target.engine !== undefined && components.engine !== target.engine) {
      problems.push(`the payload carries the ${components.engine} engine, but the target needs ${target.engine}`)
    }
  }
  return problems
}

/**
 * Files a payload directory must hold to be usable: the manifest, the kit's
 * entry and the target engine's own package manifest.
 *
 * The engine marker is the engine package's `package.json` because that is what
 * every engine kind has — including `wasm`, which is the kit's own fallback for
 * a target without a native engine and does not ship the native engines'
 * `prebuilds.json`. For a NATIVE engine that file is required as well, matching
 * upstream's packaging assertion; `wasm` is the kit's own name for the fallback
 * (see `selectOfficeEngine` in scripts/build-runtime.mjs).
 *
 * @param payloadDir - absolute path of an extracted payload.
 * @param engine - engine suffix the target loads.
 * @returns relative paths that must exist.
 */
export function officePayloadRequiredFiles(engine) {
  const engineDir = path.join(PAYLOAD_MODULES_DIR, kitEnginePackage(engine))
  return [
    PAYLOAD_MANIFEST_FILE,
    path.join(PAYLOAD_MODULES_DIR, OFFICE_KIT_PACKAGE, 'package.json'),
    path.join(engineDir, 'package.json'),
    ...(engine === 'wasm' ? [] : [path.join(engineDir, 'prebuilds.json')]),
  ]
}
