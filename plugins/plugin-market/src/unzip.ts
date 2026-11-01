/**
 * Minimal zip reader for skill archives: central directory first, falling
 * back to a local-header walk when no directory is present. Stored (method
 * 0) and deflate (method 8) entries are supported — the two every real zip
 * tool writes. Written out rather than pulled from a dependency: the reader
 * for these two methods is far smaller than a package, and the module runs
 * where adding dependencies costs every install (the plugin runtime).
 *
 * Security-relevant limits live in the CALLER (path validation per entry in
 * skills.ts); this module only decodes what the archive names.
 *
 * @module @dsh-app/plugin-market/unzip
 */

import { inflateRawSync } from 'node:zlib'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const EOCD = 0x06054b50

/** Decode a zip buffer into `{ name: bytes }`, skipping directory entries. */
export function unzipToFiles(buf: Buffer): Record<string, Buffer> {
  const eocd = findEocd(buf)
  return eocd >= 0 ? unzipFromCentral(buf, eocd) : unzipFromLocal(buf)
}

/** Walk the central directory (authoritative sizes, no data-descriptor ambiguity). */
function unzipFromCentral(buf: Buffer, eocd: number): Record<string, Buffer> {
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const out: Record<string, Buffer> = {}
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL) {
      throw new MarketZipError('not a valid zip archive')
    }
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOff = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
    if (name === '' || name.endsWith('/')) continue
    out[name] = readEntry(buf, localOff, method, compSize, name)
  }
  return out
}

/** Fallback walk over local headers (for zips shipped without a directory). */
function unzipFromLocal(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  let offset = 0
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset)
    if (sig === CENTRAL || sig === EOCD) break
    if (sig !== LOCAL) throw new MarketZipError('not a valid zip archive')
    const generalPurpose = buf.readUInt16LE(offset + 6)
    const method = buf.readUInt16LE(offset + 8)
    const compSize = buf.readUInt32LE(offset + 18)
    const nameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8')
    const dataStart = offset + 30 + nameLen + extraLen
    // A data-descriptor entry (bit 3) carries its size AFTER the data, which
    // a sequential walk cannot skip reliably — refuse rather than misread.
    if ((generalPurpose & 0x8) !== 0) throw new MarketZipError('the zip archive carries no central directory')
    const dataEnd = dataStart + compSize
    if (dataEnd > buf.length) throw new MarketZipError('the zip archive is truncated')
    if (name !== '' && !name.endsWith('/')) {
      out[name] = inflateEntry(buf.subarray(dataStart, dataEnd), method, name)
    }
    offset = dataEnd
  }
  return out
}

/** Read one entry through its local header (the central directory's pointer). */
function readEntry(buf: Buffer, localOff: number, method: number, compSize: number, name: string): Buffer {
  if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL) {
    throw new MarketZipError(`corrupt zip entry: ${name}`)
  }
  const nameLen = buf.readUInt16LE(localOff + 26)
  const extraLen = buf.readUInt16LE(localOff + 28)
  const dataStart = localOff + 30 + nameLen + extraLen
  const dataEnd = dataStart + compSize
  if (dataEnd > buf.length) throw new MarketZipError('the zip archive is truncated')
  return inflateEntry(buf.subarray(dataStart, dataEnd), method, name)
}

/**
 * Per-member decompressed cap.
 *
 * A skill is markdown and a few assets; nothing legitimate expands past this. The
 * cap is enforced by the inflater itself (`maxOutputLength`), so a bomb is stopped
 * after one bounded buffer instead of after allocating its full output — the
 * kernel child this runs in has no other guard on this path.
 */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024

/** Stored passes through; deflate inflates. Anything else is refused. */
function inflateEntry(compressed: Buffer, method: number, name: string): Buffer {
  if (method === 0) {
    if (compressed.length > MAX_ENTRY_BYTES) {
      throw new MarketZipError(`zip entry ${name} is past the per-file cap`)
    }
    return Buffer.from(compressed)
  }
  if (method !== 8) throw new MarketZipError(`unsupported zip compression method ${method}`)
  try {
    return inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES })
  } catch (error) {
    // The inflater's own cap reports a buffer-size fault; anything else is bad data.
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new MarketZipError(`zip entry ${name} expands past the ${String(MAX_ENTRY_BYTES / (1024 * 1024))} MB per-file cap`)
    }
    throw new MarketZipError(`zip inflate failed: ${name}`)
  }
}

/** Scan backwards for the End-Of-Central-Directory record. */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let index = buf.length - 22; index >= min; index--) {
    if (buf.readUInt32LE(index) !== EOCD) continue
    const commentLen = buf.readUInt16LE(index + 20)
    if (index + 22 + commentLen === buf.length) return index
  }
  return -1
}

/** The module's error type: a message the panel can show as-is. */
class MarketZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketZipError'
  }
}
