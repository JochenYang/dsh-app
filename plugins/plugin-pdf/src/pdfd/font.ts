/**
 * CJK font resolution for the renderer.
 *
 * pdf-lib's built-in fonts are WinAnsi only, so a Chinese PDF needs an embedded
 * font. The plugin bundles one open-source subset (Noto Sans SC, SIL OFL 1.1,
 * instanced to Regular and subset to GB2312 + ASCII + CJK punctuation — about
 * 2.4 MB). A GB2312 subset cannot cover Traditional-only or rare characters, so
 * resolution is a coverage search: the bundled asset is tried first, then an
 * explicit `DSH_PDF_FONT`, then the platform's single-file CJK fonts, and the
 * chosen font is the first candidate that covers every character the project
 * contains. When nothing covers the text the failure names the exact missing
 * characters and the two ways to fix it, instead of exporting a PDF with blank
 * glyphs. Font *collections* (.ttc) are deliberately skipped: pdf-lib cannot
 * subset a collection, so admitting one would only move the failure deeper.
 *
 * @module @dsh-app/plugin-pdf/pdfd/font
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fontkit from '@pdf-lib/fontkit'

/** One embeddable font: its bytes plus a short label for diagnostics. */
export interface ResolvedFont {
  readonly bytes: Uint8Array
  /** `built-in`, `DSH_PDF_FONT`, or the absolute file path. */
  readonly source: string
}

/** A font file worth trying, in resolution order. */
interface FontCandidate {
  readonly source: string
  readonly file: string
  /** A missing required candidate is an error rather than a fall-through. */
  readonly required: boolean
}

/** Bundled asset name (written by scripts/build-font.py). */
export const BUNDLED_FONT_FILE = 'NotoSansSC-Regular.ttf'

/** Environmental override for machines that need wider coverage. */
export const FONT_ENV_VAR = 'DSH_PDF_FONT'

/**
 * Where the bundled asset sits, relative to this module at runtime. The module
 * is bundled into `lib/index.js` (and, under test, into `.test-dist/`), while a
 * direct TS import would sit one level deeper in `src/pdfd/`; both parent
 * depths are probed so resolution never depends on the build layout.
 */
export function bundledFontCandidates(): string[] {
  return [
    fileURLToPath(new URL(`../assets/fonts/${BUNDLED_FONT_FILE}`, import.meta.url)),
    fileURLToPath(new URL(`../../assets/fonts/${BUNDLED_FONT_FILE}`, import.meta.url)),
  ]
}

/** Single-file CJK fonts commonly present per platform (collections excluded). */
export function systemFontCandidates(): string[] {
  const windowsRoot = process.env.WINDIR ?? 'C:\\Windows'
  const windows = [
    path.join(windowsRoot, 'Fonts', 'simhei.ttf'),
    path.join(windowsRoot, 'Fonts', 'simkai.ttf'),
    path.join(windowsRoot, 'Fonts', 'simfang.ttf'),
    path.join(windowsRoot, 'Fonts', 'Deng.ttf'),
  ]
  const mac = [
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
  ]
  const linux = [
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  ]
  if (process.platform === 'win32') return windows
  if (process.platform === 'darwin') return mac
  return linux
}

/** Every candidate in resolution order: explicit, bundled, then the platform. */
export function fontCandidates(): FontCandidate[] {
  const candidates: FontCandidate[] = []
  const override = process.env[FONT_ENV_VAR]
  if (typeof override === 'string' && override.trim() !== '') {
    candidates.push({ source: FONT_ENV_VAR, file: override, required: true })
  }
  for (const file of bundledFontCandidates()) {
    candidates.push({ source: 'built-in', file, required: false })
  }
  for (const file of systemFontCandidates()) {
    candidates.push({ source: file, file, required: false })
  }
  return candidates
}

/** Characters a font must carry; whitespace is never worth reporting. */
function requiredChars(text: string): string[] {
  const unique = new Set<string>()
  for (const char of text) {
    if (/\s/u.test(char)) continue
    unique.add(char)
  }
  return [...unique]
}

/** Characters in `chars` the font cannot address, or `undefined` when unusable. */
export function missingCharsIn(bytes: Uint8Array, chars: readonly string[]): string[] | undefined {
  let font: ReturnType<typeof fontkit.create>
  try {
    font = fontkit.create(bytes)
  } catch {
    return undefined
  }
  const has = (font as { hasGlyphForCodePoint?: (codePoint: number) => boolean }).hasGlyphForCodePoint
  if (typeof has !== 'function') return undefined
  return chars.filter(char => {
    const code = char.codePointAt(0)
    if (code === undefined) return false
    try {
      return !has.call(font, code)
    } catch {
      return true
    }
  })
}

/** Read one candidate, or `undefined` when it is absent or unreadable. */
async function readCandidate(candidate: FontCandidate): Promise<Uint8Array | undefined> {
  try {
    const bytes = await readFile(candidate.file)
    return new Uint8Array(bytes)
  } catch {
    return undefined
  }
}

/** Human-readable list of the characters no candidate covers. */
function describeMissing(chars: readonly string[]): string {
  const shown = chars.slice(0, 24).map(char => `「${char}」`).join('')
  return chars.length > 24 ? `${shown} 等 ${chars.length} 个字符` : shown
}

/**
 * Pick the first font that covers every character of `text`.
 * @throws Error naming the missing characters and how to fix them.
 */
export async function resolveReportFont(text: string): Promise<ResolvedFont> {
  const required = requiredChars(text)
  const failures: string[] = []
  let closest: { font: ResolvedFont, missing: readonly string[] } | undefined

  for (const candidate of fontCandidates()) {
    if (candidate.required && !existsSync(candidate.file)) {
      throw new Error(`${FONT_ENV_VAR}：找不到字体文件（${candidate.file}）；请指向一个 .ttf 或 .otf 中文字体`)
    }
    const bytes = await readCandidate(candidate)
    if (bytes === undefined) {
      if (candidate.required) {
        throw new Error(`${FONT_ENV_VAR}：字体文件不可读（${candidate.file}）`)
      }
      failures.push(candidate.source)
      continue
    }
    const missing = missingCharsIn(bytes, required)
    if (missing === undefined) {
      if (candidate.required) {
        throw new Error(`${FONT_ENV_VAR}：不是可用的字体文件（${candidate.file}）；请提供 .ttf 或 .otf`)
      }
      failures.push(candidate.source)
      continue
    }
    if (missing.length === 0) return { bytes, source: candidate.source }
    if (closest === undefined || missing.length < closest.missing.length) {
      closest = { font: { bytes, source: candidate.source }, missing }
    }
  }

  if (closest !== undefined) {
    throw new Error(
      `没有字体能覆盖文档中的全部字符：${closest.font.source} 缺少 ${describeMissing(closest.missing)}。`
      + `请安装中文字体，或用 ${FONT_ENV_VAR} 指向一个覆盖这些字符的 .ttf/.otf 文件（字体集合 .ttc 不受支持）`,
    )
  }
  throw new Error(
    `找不到可用的中文字体：内置字体不可读，系统也没有可用的单文件中文字体。`
    + `请安装中文字体，或用 ${FONT_ENV_VAR} 指向一个 .ttf/.otf 字体文件`
    + (failures.length > 0 ? `（已尝试：${failures.join('、')}）` : ''),
  )
}
