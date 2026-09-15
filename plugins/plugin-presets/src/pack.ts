/**
 * The `.dshpreset` pack/unpack engine over fflate (pure JS zip, bundled).
 *
 * Export: walk the preset directory (regular files only — symlinks are
 * skipped so a link can never pull content from outside the preset root into
 * a shareable archive), lay the tree under `preset/`, prepend a fresh
 * `manifest.json`, zip in memory.
 *
 * Import: two fflate passes over the untrusted archive. The first is a
 * metadata census whose filter decompresses NOTHING — it proves every member
 * path safe and unique and keeps the declared uncompressed total and file
 * count under the caps before a single byte is inflated, so a hostile zip
 * cannot spend host memory on files it will never be allowed to write. The
 * second pass then inflates the already-vetted members with a bounded
 * per-member stream (zip.ts) that refuses any member whose real byte count
 * diverges from its declared size — a plain unzipSync pass would silently
 * truncate such content and restore it as corrupt bytes.
 *
 * @module @dsh-app/plugin-presets/pack
 */

import { statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import {
  COMPOSITION_FILE,
  FORMAT_VERSION,
  MAX_FILE_COUNT,
  MAX_TOTAL_BYTES,
  MAX_ZIP_BYTES,
  MANIFEST_NAME,
  PAYLOAD_PREFIX,
  PRESET_KIND,
  PresetPackageError,
  fsErrorCode,
  parseManifest,
  sanitizeArchivePath,
  zipPathSafetyProblem,
} from './wire.ts'
import { inflateZipMembersBounded } from './zip.ts'

/** One regular file of a preset tree, relative to the preset directory. */
export interface WalkedFile {
  readonly rel: string
  readonly size: number
}

/**
 * Walk a preset directory depth-first and collect its regular files.
 * Directory entries are sorted for a deterministic archive layout.
 * @param dir - the preset directory.
 * @returns its regular files with sizes, sorted by relative path.
 * @throws PresetPackageError when the tree cannot be read.
 */
export async function walkPresetFiles(dir: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    let children
    try {
      children = await readdir(current, { withFileTypes: true })
    } catch (error) {
      throw new PresetPackageError('io', {
        code: 'preset.readDirFailed',
        params: { code: fsErrorCode(error) },
        text: `cannot read the preset directory (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
      })
    }
    for (const child of [...children].sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? child.name : `${prefix}/${child.name}`
      // Containment: a symlink's target lives outside the preset; skip it
      // rather than dereferencing into whatever it points at.
      if (child.isSymbolicLink()) continue
      if (child.isDirectory()) {
        await walk(join(current, child.name), rel)
        continue
      }
      if (!child.isFile()) continue
      let size: number
      try {
        size = (await stat(join(current, child.name))).size
      } catch (error) {
        throw new PresetPackageError('io', {
          code: 'preset.readFileFailed',
          params: { code: fsErrorCode(error) },
          text: `cannot read a preset file (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
        })
      }
      out.push({ rel, size })
    }
  }
  await walk(dir, '')
  return out
}

/**
 * Pack one preset directory into `.dshpreset` archive bytes.
 * @param dir - the preset directory on disk.
 * @param entry - the preset's entry name (goes into the manifest verbatim).
 * @returns the archive bytes (≤ MAX_ZIP_BYTES).
 * @throws PresetPackageError with codes `too-many-files`, `too-large`, `io`.
 */
export async function packPresetDir(dir: string, entry: string): Promise<Uint8Array> {
  const walked = await walkPresetFiles(dir)
  if (walked.length > MAX_FILE_COUNT) {
    throw new PresetPackageError('too-many-files', {
      code: 'preset.exportTooManyFiles',
      params: { count: walked.length, cap: MAX_FILE_COUNT },
      text: `the preset has ${String(walked.length)} files, over the ${String(MAX_FILE_COUNT)}-file per-package cap; it cannot be exported`,
    })
  }
  const total = walked.reduce((sum, file) => sum + file.size, 0)
  if (total > MAX_TOTAL_BYTES) {
    throw new PresetPackageError('too-large', {
      code: 'preset.exportTooLarge',
      params: { mb: Math.floor(MAX_TOTAL_BYTES / 1024 / 1024) },
      text: `the preset is over the ${String(Math.floor(MAX_TOTAL_BYTES / 1024 / 1024))} MB total-size cap; it cannot be exported`,
    })
  }
  const manifest = {
    formatVersion: FORMAT_VERSION,
    kind: PRESET_KIND,
    exportedAt: new Date().toISOString(),
    entry,
  }
  const files: Zippable = { [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)) }
  for (const file of walked) {
    // readFile returns a Buffer, which satisfies fflate's Uint8Array slots.
    files[`${PAYLOAD_PREFIX}${file.rel}`] = await readFile(join(dir, file.rel))
  }
  const bytes = zipSync(files)
  if (bytes.byteLength > MAX_ZIP_BYTES) {
    throw new PresetPackageError('too-large', {
      code: 'preset.archiveTooLarge',
      params: { mb: Math.floor(MAX_ZIP_BYTES / 1024 / 1024) },
      text: `the packed preset archive is over the ${String(Math.floor(MAX_ZIP_BYTES / 1024 / 1024))} MB cap; it cannot be exported`,
    })
  }
  return bytes
}

/** One payload file of an unpacked archive, relative to the preset directory. */
export interface UnpackedFile {
  readonly rel: string
  readonly data: Uint8Array
}

/** The validated content of an imported archive. */
export interface UnpackedPreset {
  readonly entry: string
  readonly files: UnpackedFile[]
}

/**
 * Unpack and fully validate an uploaded archive. Every safety decision is
 * made before inflation: paths, caps, then manifest, then layout.
 * @param data - the uploaded archive bytes (caller already capped at MAX_ZIP_BYTES).
 * @returns the entry name and the payload files to write.
 * @throws PresetPackageError with codes `bad-package`, `illegal-path`,
 * `too-large`, `too-many-files`.
 */
export function unpackPresetZip(data: Uint8Array): UnpackedPreset {
  // Pass 1 — census: the filter always returns false, so fflate enumerates
  // every member and decompresses none; we learn names and declared sizes
  // without spending memory on hostile content. Duplicate names are refused
  // here (later entries would otherwise silently shadow earlier ones).
  const names: string[] = []
  const declaredSizes = new Map<string, number>()
  let totalOriginal = 0
  let payloadCount = 0
  try {
    unzipSync(data, {
      filter: (info) => {
        if (declaredSizes.has(info.name)) {
          throw new PresetPackageError('bad-package', {
            code: 'preset.duplicateMember',
            params: { name: info.name },
            text: `the preset contains a duplicate member name "${info.name}"; refused`,
          })
        }
        names.push(info.name)
        if (!info.name.endsWith('/')) {
          declaredSizes.set(info.name, info.originalSize)
          totalOriginal += info.originalSize
          if (info.name !== MANIFEST_NAME) payloadCount += 1
        }
        return false
      },
    })
  } catch (error) {
    if (error instanceof PresetPackageError) throw error
    throw new PresetPackageError('bad-package', { code: 'preset.notZip', text: 'cannot read the preset package: not valid ZIP data' })
  }
  if (totalOriginal > MAX_TOTAL_BYTES) {
    throw new PresetPackageError('too-large', {
      code: 'preset.decompressedTooLarge',
      params: { mb: Math.floor(MAX_TOTAL_BYTES / 1024 / 1024) },
      text: `the decompressed preset exceeds the ${String(Math.floor(MAX_TOTAL_BYTES / 1024 / 1024))} MB cap; refused`,
    })
  }
  if (payloadCount > MAX_FILE_COUNT) {
    throw new PresetPackageError('too-many-files', {
      code: 'preset.importTooManyFiles',
      params: { count: payloadCount, cap: MAX_FILE_COUNT },
      text: `the preset has ${String(payloadCount)} files, over the ${String(MAX_FILE_COUNT)}-file per-package cap; refused`,
    })
  }
  // Containment first: every member (directories included) must pass the
  // path rules before anything is inflated.
  for (const name of names) {
    const problem = zipPathSafetyProblem(name)
    if (problem !== undefined) {
      throw new PresetPackageError('illegal-path', {
        code: 'preset.illegalPath',
        params: { path: sanitizeArchivePath(name), reason: problem.code },
        text: `the preset package contains a forbidden path "${sanitizeArchivePath(name)}": ${problem.text ?? problem.code}; refused`,
      })
    }
  }
  // Pass 2 — bounded inflate of the vetted members: every member's actual
  // byte count must equal its declared size, and the running total aborts
  // the moment it crosses the cap (see zip.ts for why unzipSync cannot).
  const inflated = inflateZipMembersBounded(data, declaredSizes, 'preset', MAX_TOTAL_BYTES)
  const manifestRaw = inflated.find(member => member.name === MANIFEST_NAME)?.data
  if (manifestRaw === undefined) {
    throw new PresetPackageError('bad-package', {
      code: 'preset.manifestMissing',
      text: `the preset package has no ${MANIFEST_NAME}, so it is not a valid preset package`,
    })
  }
  const manifest = parseManifest(manifestRaw)
  const files: UnpackedFile[] = []
  for (const member of inflated) {
    if (member.name === MANIFEST_NAME) continue
    if (!member.name.startsWith(PAYLOAD_PREFIX)) {
      throw new PresetPackageError('illegal-path', {
        code: 'preset.outsidePayload',
        params: { path: sanitizeArchivePath(member.name) },
        text: `the preset package contains a file outside the preset directory: "${sanitizeArchivePath(member.name)}"; refused`,
      })
    }
    const rel = member.name.slice(PAYLOAD_PREFIX.length)
    if (rel === '') continue // a bare `preset/` marker carries no data
    files.push({ rel, data: member.data })
  }
  return { entry: manifest.entry, files }
}

/**
 * Whether a directory qualifies as an exportable preset: the kernel's roster
 * only mounts directories carrying the composition file, so anything else is
 * inert residue and stays out of the export surface.
 */
export function isPresetDirectory(dir: string): boolean {
  try {
    return statSync(join(dir, COMPOSITION_FILE)).isFile()
  } catch {
    return false
  }
}
