/**
 * Minimal ZIP reader for the render tests: enough to pull one entry (or all of
 * them) out of a .docx so the assertions can be made at the OOXML level instead
 * of trusting the file size. Handles stored and deflated entries, with and
 * without data descriptors.
 *
 * @module @dsh-app/plugin-doc/tests/zip
 */

import { inflateRawSync } from 'node:zlib'

const LOCAL_FILE_HEADER = 0x04034b50

function decode(raw: Uint8Array, method: number): string {
  return method === 0 ? Buffer.from(raw).toString('utf8') : inflateRawSync(raw).toString('utf8')
}

/** Every entry in the archive, keyed by its name. */
export function readZipEntries(bytes: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>()
  const buffer = Buffer.from(bytes)
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === LOCAL_FILE_HEADER) {
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const dataStart = offset + 30 + nameLength + extraLength
    if ((flags & 0x08) === 0) {
      entries.set(name, decode(buffer.subarray(dataStart, dataStart + compressedSize), method))
      offset = dataStart + compressedSize
    } else {
      let next = dataStart
      while (next < buffer.length && buffer.readUInt32LE(next) !== LOCAL_FILE_HEADER) next += 1
      offset = next
    }
  }
  return entries
}

/** One entry, or undefined when the archive does not contain it. */
export function readZipEntry(bytes: Uint8Array, name: string): string | undefined {
  return readZipEntries(bytes).get(name)
}

/** Whether the buffer starts with the ZIP local-file-header signature. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && Buffer.from(bytes).readUInt32LE(0) === LOCAL_FILE_HEADER
}
