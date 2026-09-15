/**
 * Bounded per-member ZIP inflation shared by the preset-package and
 * config-backup unpack paths.
 *
 * Why not a plain unzipSync pass: fflate preallocates each member's output
 * from the archive's DECLARED size and silently truncates when the real
 * content is longer, so a lying-small member would pass a census cap and
 * still restore as corrupt bytes. This helper streams the archive through
 * fflate's Unzip in bounded compressed feeds, counts every member's ACTUAL
 * output, and unwinds the inflation (via a thrown failure) the moment a
 * member outgrows its declared size or the running total outgrows the cap —
 * memory stays at declared-size scale and hostile streams never finish
 * walking. Data-descriptor members (compressed size unknown until the
 * central directory) cannot be fed in bounded pieces and are refused
 * outright. The census pass stays responsible for caps, layout and name
 * uniqueness; this helper adds the actual-vs-declared verdict per member.
 *
 * @module @dsh-app/plugin-presets/zip
 */

import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import { PresetPackageError } from './wire.ts'

/**
 * Compressed bytes handed to the streaming parser per feed. Small feeds keep
 * the decoder's output chunks small, so an abort lands after one feed's worth
 * of decompression instead of a whole member.
 */
const FEED_BYTES = 64 * 1024

/** One decompressed archive member, actual size already proven == declared. */
export interface BoundedZipMember {
  readonly name: string
  readonly data: Uint8Array
}

/**
 * Which archive a composed message is about. The helper serves both the
 * preset-package and the config-backup path, and every sentence it raises names
 * its archive, so the subject travels as a code the client's dictionary
 * resolves (see `HostText` in wire.ts) rather than as prose.
 */
export type ZipSubject = 'preset' | 'backup'

/** Dictionary code of one subject. */
function subjectCode(subject: ZipSubject): string {
  return `subject.${subject}`
}

/**
 * Inflate every vetted member of an archive with per-member and cumulative
 * bounds. Throws from inside the stream callbacks unwind fflate's synchronous
 * push loop, so the first violation stops all further decompression.
 * @param data - the archive bytes (caller already capped).
 * @param declaredSizes - name → declared originalSize for every non-directory
 *   member, as proven by the census pass (duplicates already rejected there).
 * @param subject - which archive this is ('preset' | 'backup'), for the copy.
 * @param totalCap - hard cap on the sum of actual decompressed bytes.
 * @returns the members in archive order.
 * @throws PresetPackageError with codes `bad-package` or `too-large`.
 */
export function inflateZipMembersBounded(
  data: Uint8Array,
  declaredSizes: ReadonlyMap<string, number>,
  subject: ZipSubject,
  totalCap: number,
): BoundedZipMember[] {
  const members = new Map<string, Uint8Array>()
  let failure: PresetPackageError | undefined
  let totalActual = 0
  // Records the failure and returns it so every call site throws uniformly.
  const fail = (error: PresetPackageError): PresetPackageError => {
    failure = error
    return error
  }
  const corrupt = (): PresetPackageError => new PresetPackageError('bad-package', {
    code: 'zip.corrupt',
    params: { subject: subjectCode(subject) },
    text: `cannot decompress the ${subject} archive: the ZIP data is corrupt`,
  })
  const sizeMismatch = (name: string): PresetPackageError => new PresetPackageError('bad-package', {
    code: 'zip.sizeMismatch',
    params: { subject: subjectCode(subject), name },
    text: `the actual content of ${subject} member "${name}" does not match its declared size; refused`,
  })
  const unzip = new Unzip((file) => {
    if (failure !== undefined) return
    // A data-descriptor member arrives with unknown compressed size, which
    // would force one unbounded decoder push — refuse instead of buffering.
    if (file.size === undefined) {
      throw fail(new PresetPackageError('bad-package', {
        code: 'zip.dataDescriptor',
        params: { subject: subjectCode(subject), name: file.name },
        text: `the ${subject} archive uses an unsupported data-descriptor entry "${file.name}"; refused`,
      }))
    }
    if (file.name.endsWith('/')) return // directory marker: nothing to inflate
    const declared = declaredSizes.get(file.name)
    if (declared === undefined) {
      // A local-header name the census never vetted: central/local mismatch.
      throw fail(new PresetPackageError('bad-package', {
        code: 'zip.undeclaredMember',
        params: { subject: subjectCode(subject), name: file.name },
        text: `the ${subject} archive contains an undeclared member "${file.name}"; refused`,
      }))
    }
    const chunks: Uint8Array[] = []
    let memberBytes = 0
    file.ondata = (error, chunk, final) => {
      // fflate routes a callback-thrown failure back through ondata; rethrow
      // it so the unwind escapes instead of resuming the stream.
      if (failure !== undefined) throw failure
      if (error !== null) {
        throw fail(corrupt())
      }
      if (!chunk) {
        throw fail(corrupt())
      }
      memberBytes += chunk.length
      if (memberBytes > declared) {
        throw fail(sizeMismatch(file.name))
      }
      totalActual += chunk.length
      if (totalActual > totalCap) {
        throw fail(new PresetPackageError('too-large', {
          code: 'zip.totalTooLarge',
          params: { subject: subjectCode(subject), mb: Math.floor(totalCap / 1024 / 1024) },
          text: `decompressed ${subject} content exceeds the ${Math.floor(totalCap / 1024 / 1024)} MB cap; refused`,
        }))
      }
      chunks.push(chunk)
      if (final) {
        if (memberBytes !== declared || members.has(file.name)) {
          throw fail(sizeMismatch(file.name))
        }
        const out = new Uint8Array(memberBytes)
        let offset = 0
        for (const piece of chunks) {
          out.set(piece, offset)
          offset += piece.length
        }
        members.set(file.name, out)
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  unzip.register(UnzipPassThrough)
  try {
    for (let offset = 0; offset < data.length; offset += FEED_BYTES) {
      unzip.push(data.subarray(offset, Math.min(offset + FEED_BYTES, data.length)), offset + FEED_BYTES >= data.length)
    }
  } catch (error) {
    if (failure !== undefined) throw failure
    throw corrupt()
  }
  if (failure !== undefined) throw failure
  for (const name of declaredSizes.keys()) {
    if (!members.has(name)) {
      throw new PresetPackageError('bad-package', {
        code: 'zip.memberMissing',
        params: { subject: subjectCode(subject), name },
        text: `the ${subject} archive is missing the declared member "${name}"; refused`,
      })
    }
  }
  return [...members].map(([name, bytes]) => ({ name, data: bytes }))
}
