/**
 * Workspace PDF reading on top of unpdf's serverless PDF.js bundle.
 *
 * The reader is deliberately one document proxy, not one call per fact: unpdf
 * tears its proxy down after every helper, and a second document in the same
 * process can fail on the torn-down worker, so metadata and per-page text are
 * both taken from a single `getDocumentProxy`. Extraction is bounded on three
 * axes — source size, page count and total characters — so a hostile or simply
 * huge PDF cannot exhaust the host, and truncation is reported rather than
 * silent. Encrypted and malformed files surface as actionable Chinese errors
 * instead of a PDF.js stack.
 *
 * @module @dsh-app/plugin-pdf/pdfd/read
 */

import { readFile } from 'node:fs/promises'
import { getDocumentProxy } from 'unpdf'

/** Source PDFs above this size are refused. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024
/** Pages beyond this are not extracted. */
export const MAX_PAGES = 500
/** Total extracted characters across all pages. */
export const MAX_TEXT_CHARS = 2 * 1024 * 1024

/** The model-facing summary of one workspace PDF. */
export interface PdfReadSummary {
  readonly title?: string
  readonly author?: string
  readonly pageCount: number
  /** Per-page text, at most {@link MAX_TEXT_CHARS} characters in total. */
  readonly pages: readonly string[]
  readonly extractedChars: number
  /** Whether the character ceiling cut the extraction short. */
  readonly truncated: boolean
  /** True when the document has more pages than the extraction ceiling. */
  readonly pageLimitHit: boolean
}

/** PDF.js NUL-joins some glyph runs; the NULs are not document content. */
function cleanText(text: string): string {
  return text.replace(/\u0000/gu, '').replace(/[ \t]+$/u, '')
}

/** One page's text, joined in reading order with line breaks where PDF.js saw them. */
async function pageText(document: Awaited<ReturnType<typeof getDocumentProxy>>, pageNumber: number): Promise<string> {
  const page = await document.getPage(pageNumber)
  const content = await page.getTextContent()
  // Marked-content items carry no text; only real text items contribute.
  return cleanText(content.items
    .map(item => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
    .join(''))
}

/** Metadata strings, tolerating a document whose info dictionary is unreadable. */
async function metadataOf(document: Awaited<ReturnType<typeof getDocumentProxy>>): Promise<{ title?: string, author?: string }> {
  try {
    const metadata = await document.getMetadata()
    const info = metadata.info as { Title?: unknown, Author?: unknown }
    const title = typeof info.Title === 'string' && info.Title.trim() !== '' ? info.Title.trim() : undefined
    const author = typeof info.Author === 'string' && info.Author.trim() !== '' ? info.Author.trim() : undefined
    return { ...(title === undefined ? {} : { title }), ...(author === undefined ? {} : { author }) }
  } catch {
    // Metadata is a bonus; a file without it is still readable material.
    return {}
  }
}

/** Translate a PDF.js failure into one actionable Chinese sentence. */
export function describePdfFailure(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : ''
  const message = cause instanceof Error ? cause.message : String(cause)
  if (name === 'PasswordException' || /password/iu.test(message)) {
    return '文件已加密，需要密码才能读取；请先用其他工具去除密码后重新读取'
  }
  if (name === 'InvalidPDFException' || /invalid pdf|invalidpdf|structure/iu.test(message)) {
    return '文件不是有效的 PDF，或已损坏；请确认文件完整后重试'
  }
  return message
}

/** Extraction ceilings; overridable so tests can exercise truncation cheaply. */
export interface ReadLimits {
  readonly maxPages?: number
  readonly maxChars?: number
}

/**
 * Read one workspace PDF into a bounded summary.
 * @param absolutePath - the already-fenced absolute path.
 * @param sizeBytes - the file's size, already checked against the ceiling.
 * @param limits - optional lower ceilings (test seam; defaults to the caps).
 * @throws Error with an actionable Chinese message.
 */
export async function readPdfFile(
  absolutePath: string,
  sizeBytes: number,
  limits: ReadLimits = {},
): Promise<PdfReadSummary> {
  const maxPages = limits.maxPages ?? MAX_PAGES
  const maxChars = limits.maxChars ?? MAX_TEXT_CHARS
  if (sizeBytes > MAX_SOURCE_BYTES) {
    throw new Error(`PDF 超过 ${MAX_SOURCE_BYTES / (1024 * 1024)} MB 上限（当前 ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB）；请压缩或拆分文件`)
  }
  const bytes = new Uint8Array(await readFile(absolutePath))
  let document: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    document = await getDocumentProxy(bytes, { verbosity: 0 })
  } catch (cause) {
    throw new Error(describePdfFailure(cause))
  }

  try {
    const pageCount = document.numPages
    const pageLimitHit = pageCount > maxPages
    const readable = Math.min(pageCount, maxPages)
    const pages: string[] = []
    let extractedChars = 0
    let truncated = false
    for (let number = 1; number <= readable; number += 1) {
      let text = await pageText(document, number)
      const remaining = maxChars - extractedChars
      if (text.length > remaining) {
        text = text.slice(0, Math.max(0, remaining))
        truncated = true
      }
      pages.push(text)
      extractedChars += text.length
      if (truncated) break
    }
    if (pageLimitHit) truncated = true
    const metadata = await metadataOf(document)
    return {
      ...metadata,
      pageCount,
      pages,
      extractedChars,
      truncated,
      pageLimitHit,
    }
  } finally {
    await document.destroy().catch(() => undefined)
  }
}
