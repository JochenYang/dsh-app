// Generate a placeholder 512x512 app icon (rounded square + "D" glyph).
// Real brand icon should replace resources/icon.png before release.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const W = 512
const H = 512
const R = 96

function inRounded(x, y) {
  if (x < R && y < R) return (x - R) ** 2 + (y - R) ** 2 <= R * R
  if (x >= W - R && y < R) return (x - (W - R)) ** 2 + (y - R) ** 2 <= R * R
  if (x < R && y >= H - R) return (x - R) ** 2 + (y - (H - R)) ** 2 <= R * R
  if (x >= W - R && y >= H - R) return (x - (W - R)) ** 2 + (y - (H - R)) ** 2 <= R * R
  return true
}

function letterD(x, y) {
  const gx = (x - 96) / 320
  const gy = (y - 128) / 256
  if (gx < 0 || gx > 1 || gy < 0 || gy > 1) return false
  if (gx < 0.18) return true
  if (gy < 0.14 || gy > 0.86) return true
  if (gx > 0.86) return true
  const mid = Math.abs(gy - 0.5)
  const rightEdge = 0.86 - 0.3 * (1 - (1 - mid * 2) ** 2)
  return gx >= rightEdge
}

const rows = []
for (let y = 0; y < H; y++) {
  const row = Buffer.alloc(W * 4)
  for (let x = 0; x < W; x++) {
    const o = x * 4
    if (!inRounded(x, y)) {
      row[o + 3] = 0
      continue
    }
    if (letterD(x, y)) {
      row[o] = 255; row[o + 1] = 255; row[o + 2] = 255; row[o + 3] = 255
    } else {
      const t = y / H
      row[o] = Math.round(0x1e + (0x0f - 0x1e) * t)
      row[o + 1] = Math.round(0x3a + (0x17 - 0x3a) * t)
      row[o + 2] = Math.round(0x8a + (0x2a - 0x8a) * t)
      row[o + 3] = 255
    }
  }
  rows.push(row)
}

const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r])))
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (tag, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'resources', 'icon.png')
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, png)
console.log('wrote', out, png.length, 'bytes')
