/**
 * Byte-level zip crafting for hostile-archive tests. fflate cannot produce
 * archives whose declared sizes lie, whose member names repeat, or whose
 * entries use data descriptors — exactly the shapes a hostile packager would
 * forge — so these helpers patch the archive's own structures directly.
 *
 * @module plugin-presets/tests/zip-craft
 */

const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
/** Local-header general-purpose flag bit 3: sizes follow in a data descriptor. */
const DATA_DESCRIPTOR_FLAG = 0x0008

interface DataViewable {
  readonly buffer: ArrayBuffer
  readonly byteOffset: number
  readonly byteLength: number
}

function dataViewOf(bytes: DataViewable): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Locate the central-directory entry whose stored name matches. */
function findCentralEntry(bytes: Uint8Array, name: string): { readonly start: number, readonly length: number, readonly eocd: number } {
  const data = dataViewOf(bytes)
  const nameBytes = new TextEncoder().encode(name)
  let eocd = bytes.length - 22
  while (eocd >= 0 && data.getUint32(eocd, true) !== EOCD_SIGNATURE) eocd -= 1
  if (eocd < 0) throw new Error('test helper: no end-of-central-directory record')
  const entryCount = data.getUint16(eocd + 10, true)
  let cursor = data.getUint32(eocd + 16, true)
  for (let index = 0; index < entryCount; index += 1) {
    if (data.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new Error('test helper: broken central directory')
    const nameLength = data.getUint16(cursor + 28, true)
    const entryLength = 46 + nameLength + data.getUint16(cursor + 30, true) + data.getUint16(cursor + 32, true)
    const nameStart = cursor + 46
    if (nameLength === nameBytes.length && bytes.subarray(nameStart, nameStart + nameLength).every((byte, index) => byte === nameBytes[index])) {
      return { start: cursor, length: entryLength, eocd }
    }
    cursor += entryLength
  }
  throw new Error(`test helper: central entry not found: ${name}`)
}

/** Rewrite the declared uncompressed size of one central-directory entry. */
export function patchCentralOriginalSize(bytes: Uint8Array, name: string, declared: number): Uint8Array {
  const patched = Uint8Array.from(bytes)
  const entry = findCentralEntry(patched, name)
  dataViewOf(patched).setUint32(entry.start + 24, declared, true)
  return patched
}

/**
 * Duplicate one central-directory entry in place, producing an archive whose
 * census sees the same member name twice (later entries would otherwise
 * shadow earlier ones silently).
 */
export function zipWithDuplicatedCentralEntry(bytes: Uint8Array, name: string): Uint8Array {
  const entry = findCentralEntry(bytes, name)
  const data = dataViewOf(bytes)
  const grown = new Uint8Array(bytes.length + entry.length)
  grown.set(bytes.subarray(0, entry.start + entry.length), 0)
  grown.set(bytes.subarray(entry.start, entry.start + entry.length), entry.start + entry.length)
  grown.set(bytes.subarray(entry.start + entry.length), entry.start + 2 * entry.length)
  const view = dataViewOf(grown)
  // The EOCD moved by one entry length; its counts and size fields must grow.
  // Both count fields need the bump: readers disagree on which one is total.
  const shiftedEocd = entry.eocd + entry.length
  const entriesOnDisk = data.getUint16(entry.eocd + 8, true) + 1
  view.setUint16(shiftedEocd + 8, entriesOnDisk, true)
  view.setUint16(shiftedEocd + 10, data.getUint16(entry.eocd + 10, true) + 1, true)
  view.setUint32(shiftedEocd + 12, data.getUint32(entry.eocd + 12, true) + entry.length, true)
  return grown
}

/** Mark one member's local header as data-descriptor (sizes not up front). */
export function setDataDescriptorFlag(bytes: Uint8Array, name: string): Uint8Array {
  const patched = Uint8Array.from(bytes)
  const entry = findCentralEntry(patched, name)
  const view = dataViewOf(patched)
  const localOffset = view.getUint32(entry.start + 42, true)
  view.setUint16(localOffset + 6, view.getUint16(localOffset + 6, true) | DATA_DESCRIPTOR_FLAG, true)
  return patched
}
