/**
 * Minimal intrinsic-size reader for the raster formats the DOC renderer can
 * embed. The image block carries only a path, so the .docx needs a size to
 * place the picture at; a header walk for PNG/JPEG/GIF/BMP keeps the plugin
 * free of an extra dependency for that one number. Unknown formats return
 * undefined and the renderer falls back to a bounded default box.
 *
 * @module @dsh-app/plugin-doc/docd/image-size
 */

export interface ImageSize {
  readonly width: number
  readonly height: number
}

function sizeOfPng(bytes: Uint8Array): ImageSize | undefined {
  // 8-byte signature, 4-byte chunk length, 4-byte 'IHDR', then width/height.
  if (bytes.length < 24) return undefined
  const width = Buffer.from(bytes).readUInt32BE(16)
  const height = Buffer.from(bytes).readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

function sizeOfGif(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 10) return undefined
  const buffer = Buffer.from(bytes)
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
}

function sizeOfBmp(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 26) return undefined
  const buffer = Buffer.from(bytes)
  return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) }
}

function sizeOfJpeg(bytes: Uint8Array): ImageSize | undefined {
  const buffer = Buffer.from(bytes)
  let offset = 2
  // Walk the marker chain to the first start-of-frame segment, which carries
  // the real dimensions (EXIF orientation is intentionally not applied).
  while (offset + 9 <= buffer.length) {
    if (buffer.readUInt8(offset) !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer.readUInt8(offset + 1)
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      const height = buffer.readUInt16BE(offset + 5)
      const width = buffer.readUInt16BE(offset + 7)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

/** Intrinsic pixel size from the file header, or undefined when unreadable. */
export function imageSizeOf(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return sizeOfPng(bytes)
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return sizeOfJpeg(bytes)
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return sizeOfGif(bytes)
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return sizeOfBmp(bytes)
  return undefined
}
