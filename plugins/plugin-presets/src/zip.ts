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
 * Inflate every vetted member of an archive with per-member and cumulative
 * bounds. Throws from inside the stream callbacks unwind fflate's synchronous
 * push loop, so the first violation stops all further decompression.
 * @param data - the archive bytes (caller already capped).
 * @param declaredSizes - name → declared originalSize for every non-directory
 *   member, as proven by the census pass (duplicates already rejected there).
 * @param subject - zh-CN subject used in error copy ('配置备份' / '预设包').
 * @param totalCap - hard cap on the sum of actual decompressed bytes.
 * @returns the members in archive order.
 * @throws PresetPackageError with codes `bad-package` or `too-large`.
 */
export function inflateZipMembersBounded(
  data: Uint8Array,
  declaredSizes: ReadonlyMap<string, number>,
  subject: string,
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
  const unzip = new Unzip((file) => {
    if (failure !== undefined) return
    // A data-descriptor member arrives with unknown compressed size, which
    // would force one unbounded decoder push — refuse instead of buffering.
    if (file.size === undefined) {
      throw fail(new PresetPackageError('bad-package', `${subject}使用了不支持的数据描述符条目「${file.name}」，已拒绝`))
    }
    if (file.name.endsWith('/')) return // directory marker: nothing to inflate
    const declared = declaredSizes.get(file.name)
    if (declared === undefined) {
      // A local-header name the census never vetted: central/local mismatch.
      throw fail(new PresetPackageError('bad-package', `${subject}内存在未声明的成员「${file.name}」，已拒绝`))
    }
    const chunks: Uint8Array[] = []
    let memberBytes = 0
    file.ondata = (error, chunk, final) => {
      // fflate routes a callback-thrown failure back through ondata; rethrow
      // it so the unwind escapes instead of resuming the stream.
      if (failure !== undefined) throw failure
      if (error !== null) {
        throw fail(new PresetPackageError('bad-package', `无法解压${subject}：ZIP 数据损坏`))
      }
      if (!chunk) {
        throw fail(new PresetPackageError('bad-package', `无法解压${subject}：ZIP 数据损坏`))
      }
      memberBytes += chunk.length
      if (memberBytes > declared) {
        throw fail(new PresetPackageError('bad-package', `${subject}成员「${file.name}」的实际内容与声明不符，已拒绝`))
      }
      totalActual += chunk.length
      if (totalActual > totalCap) {
        throw fail(new PresetPackageError('too-large', `${subject}解压后总大小超过 ${String(Math.floor(totalCap / 1024 / 1024))}MB 上限，已拒绝`))
      }
      chunks.push(chunk)
      if (final) {
        if (memberBytes !== declared || members.has(file.name)) {
          throw fail(new PresetPackageError('bad-package', `${subject}成员「${file.name}」的实际内容与声明不符，已拒绝`))
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
    throw new PresetPackageError('bad-package', `无法解压${subject}：ZIP 数据损坏`)
  }
  if (failure !== undefined) throw failure
  for (const name of declaredSizes.keys()) {
    if (!members.has(name)) {
      throw new PresetPackageError('bad-package', `${subject}缺少声明的成员「${name}」，已拒绝`)
    }
  }
  return [...members].map(([name, bytes]) => ({ name, data: bytes }))
}
