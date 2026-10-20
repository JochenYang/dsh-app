/**
 * Page-level editing of an existing workspace PDF: metadata, page selection,
 * rotation, deletion and merging — the operations a user means by "edit this
 * PDF" far more often than "rewrite its text".
 *
 * This is the one PDF surface the plugin did not have. `pdf_write` /
 * `pdf_check` / `pdf_render` author a document from a JSON project and
 * `pdf_read` reads one, but none of them could take a PDF someone already had
 * and change its pages. The gap mattered because the suite's own menu offers
 * "PDF documents" as a format entry, and a user handing over an existing file
 * is the common case.
 *
 * Everything here is pure `pdf-lib` — no external runtime, no Python, no
 * LibreOffice — so it works in the same self-contained way every other tool in
 * this plugin does. The input bytes are never mutated: the operations are
 * applied to an in-memory copy, and the caller writes the result to a NEW
 * workspace path.
 *
 * Two deliberate restrictions:
 *
 * - **Page indexes are zero-based**, matching `pdf-lib` and the rest of this
 *   plugin's vocabulary. A negative or out-of-range index is refused with the
 *   page count named, rather than silently ignored, because "I asked to remove
 *   page 5 of a 4-page file" is a mistake the user needs to see.
 * - **A merge source is appended in the order given**, and its pages are never
 *   renumbered by the caller's expectations: the result's page count is
 *   reported so a caller can verify what happened instead of assuming.
 *
 * @module @dsh-app/plugin-pdf/pdfd/edit
 */

import { PDFDocument, degrees } from 'pdf-lib'

/** Which page operations one edit applies, in the order this module defines. */
export interface PdfEditRequest {
  /** Metadata to set; an absent field is left as the document had it. */
  readonly metadata?: {
    readonly title?: string
    readonly author?: string
    readonly subject?: string
    readonly keywords?: readonly string[]
  }
  /**
   * Zero-based pages to KEEP, in the order given. Mutually exclusive with
   * {@link removePages}: keeping a selection and deleting from the original at
   * the same time is ambiguous, so the tool refuses the combination instead of
   * picking one.
   */
  readonly keepPages?: readonly number[]
  /** Zero-based pages to delete from the original. */
  readonly removePages?: readonly number[]
  /** Clockwise rotation in degrees; must be a multiple of 90. */
  readonly rotate?: { readonly degrees: 90 | 180 | 270, readonly pages?: readonly number[] }
  /** Other workspace PDFs whose pages are appended after the edited original. */
  readonly merge?: readonly { readonly label: string, readonly bytes: Uint8Array }[]
}

/** What one edit did, for the model to report and verify. */
export interface PdfEditSummary {
  /** Page count of the ORIGINAL document, before any operation. */
  readonly originalPageCount: number
  /** Page count of the result. */
  readonly pageCount: number
  /** Pages removed, as zero-based indexes into the original. */
  readonly removed: readonly number[]
  /** Pages rotated, as zero-based indexes into the result. */
  readonly rotated: readonly number[]
  /** How many pages each merge source contributed, in input order. */
  readonly merged: readonly { readonly label: string, readonly pages: number }[]
  /** Which metadata fields were actually written. */
  readonly metadataWritten: readonly string[]
}

/** One actionable refusal: the caller turns this into the tool's error list. */
export class PdfEditRefusal extends Error {}

/** Every page index of a document with `count` pages. */
function allIndexes(count: number): readonly number[] {
  return Array.from({ length: count }, (_, index) => index)
}

/**
 * Validate one page index against the ORIGINAL page count.
 * @param value - the caller's index.
 * @param count - the original page count.
 * @param what - field name, for the message.
 * @param seen - indexes already accepted for this field, to refuse duplicates.
 */
function pageIndex(value: unknown, count: number, what: string, seen: Set<number>): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PdfEditRefusal(`${what}：页码必须是整数（收到 ${String(value)}）`)
  }
  if (value < 0 || value >= count) {
    throw new PdfEditRefusal(`${what}：页码 ${String(value)} 超出范围，该文件共 ${String(count)} 页，页码从 0 开始`)
  }
  if (seen.has(value)) {
    throw new PdfEditRefusal(`${what}：页码 ${String(value)} 重复出现`)
  }
  seen.add(value)
  return value
}

/** Validate a page list, refusing duplicates and out-of-range indexes. */
function pageList(value: unknown, count: number, what: string): readonly number[] {
  if (!Array.isArray(value)) throw new PdfEditRefusal(`${what}：必须是页码数组`)
  if (value.length === 0) throw new PdfEditRefusal(`${what}：数组不能为空；要保留/删除全部页时请省略该字段`)
  const seen = new Set<number>()
  return value.map(entry => pageIndex(entry, count, what, seen))
}

/**
 * Apply one edit to an existing PDF.
 *
 * @param sourceBytes - the original document; never mutated.
 * @param request - the operations to apply.
 * @param loadMergeSource - resolves one merge source's bytes; called once per
 *   entry in `request.merge`, in order, so a caller can enforce its own
 *   workspace checks per file.
 * @returns the result bytes and a summary of what changed.
 * @throws PdfEditRefusal for a request that cannot be honoured.
 */
export async function editPdf(
  sourceBytes: Uint8Array,
  request: PdfEditRequest,
  loadMergeSource?: (label: string) => Promise<Uint8Array>,
): Promise<{ bytes: Uint8Array, summary: PdfEditSummary }> {
  let source: PDFDocument
  try {
    source = await PDFDocument.load(sourceBytes, { updateMetadata: false })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/encrypted|password/iu.test(message)) {
      throw new PdfEditRefusal('文件已加密，需要密码才能编辑；请先用其他工具去除密码后重试')
    }
    throw new PdfEditRefusal('文件不是有效的 PDF，或已损坏；请确认文件完整后重试')
  }

  if (source.getPageCount() === 0) throw new PdfEditRefusal('该 PDF 没有任何页面，无法编辑')
  const originalPageCount = source.getPageCount()

  // Keeping a selection and deleting from the original describe the same result
  // two ways; accepting both would leave the order of operations undefined.
  if (request.keepPages !== undefined && request.removePages !== undefined) {
    throw new PdfEditRefusal('keepPages 与 removePages 不能同时使用：保留一份页码与删除一份页码语义重叠，请只选一种')
  }

  const keep = request.keepPages === undefined ? undefined : pageList(request.keepPages, originalPageCount, 'keepPages')
  const remove = request.removePages === undefined ? undefined : pageList(request.removePages, originalPageCount, 'removePages')
  if (remove !== undefined && remove.length >= originalPageCount) {
    throw new PdfEditRefusal(`removePages：会删除全部 ${String(originalPageCount)} 页，结果将没有页面；请保留至少一页`)
  }

  // Rotation is expressed against the RESULT's page numbering when a selection
  // is kept, which is what the user sees after the edit.
  const keptPages = keep ?? allIndexes(originalPageCount).filter(index => remove === undefined || !remove.includes(index))
  const resultIndexByOriginal = new Map<number, number>()
  keptPages.forEach((original, position) => resultIndexByOriginal.set(original, position))

  const rotationTargets: readonly number[] = request.rotate === undefined
    ? []
    : request.rotate.pages === undefined
      ? allIndexes(keptPages.length)
      : pageList(request.rotate.pages, keptPages.length, 'rotate.pages')
  if (request.rotate !== undefined && ![90, 180, 270].includes(request.rotate.degrees)) {
    throw new PdfEditRefusal(`rotate：度数只能是 90 / 180 / 270（收到 ${String(request.rotate.degrees)}）`)
  }

  // The output document is built COPY BY COPY rather than by deleting from the
  // source: `pdf-lib`'s removal renumbers as it goes, which makes a second
  // removal target the wrong page.
  const output = await PDFDocument.create()
  const copied = await output.copyPages(source, [...keptPages])
  for (const page of copied) output.addPage(page)

  // The output is a NEW document, so it starts with no metadata at all. The
  // source's own metadata is carried over first, then the request's fields
  // overwrite what it names — otherwise editing a page would silently drop a
  // title and author the user never asked to change.
  const sourceTitle = source.getTitle()
  const sourceAuthor = source.getAuthor()
  const sourceSubject = source.getSubject()
  const sourceKeywords = source.getKeywords()
  const sourceCreator = source.getCreator()
  const sourceProducer = source.getProducer()
  if (sourceTitle !== undefined) output.setTitle(sourceTitle)
  if (sourceAuthor !== undefined) output.setAuthor(sourceAuthor)
  if (sourceSubject !== undefined) output.setSubject(sourceSubject)
  if (sourceKeywords !== undefined) output.setKeywords([...sourceKeywords])
  if (sourceCreator !== undefined) output.setCreator(sourceCreator)
  if (sourceProducer !== undefined) output.setProducer(sourceProducer)

  for (const index of rotationTargets) {
    const page = output.getPage(index)
    // Rotation accumulates: a page already turned by the source stays turned,
    // and the request is applied on top of it rather than replacing it.
    const current = page.getRotation().angle
    page.setRotation(degrees((current + (request.rotate?.degrees ?? 0)) % 360))
  }

  const merged: { label: string, pages: number }[] = []
  for (const entry of request.merge ?? []) {
    const bytes = loadMergeSource === undefined ? entry.bytes : await loadMergeSource(entry.label)
    let other: PDFDocument
    try {
      other = await PDFDocument.load(bytes, { updateMetadata: false })
    } catch {
      throw new PdfEditRefusal(`merge：${entry.label} 不是有效的 PDF，或已加密`)
    }
    if (other.getPageCount() === 0) {
      throw new PdfEditRefusal(`merge：${entry.label} 没有任何页面`)
    }
    const pages = await output.copyPages(other, [...allIndexes(other.getPageCount())])
    for (const page of pages) output.addPage(page)
    merged.push({ label: entry.label, pages: pages.length })
  }

  const metadataWritten: string[] = []
  const metadata = request.metadata
  if (metadata !== undefined) {
    if (metadata.title !== undefined) {
      output.setTitle(metadata.title)
      metadataWritten.push('title')
    }
    if (metadata.author !== undefined) {
      output.setAuthor(metadata.author)
      metadataWritten.push('author')
    }
    if (metadata.subject !== undefined) {
      output.setSubject(metadata.subject)
      metadataWritten.push('subject')
    }
    if (metadata.keywords !== undefined) {
      if (metadata.keywords.length === 0) throw new PdfEditRefusal('metadata.keywords：数组不能为空；要清除关键词请省略该字段')
      output.setKeywords([...metadata.keywords])
      metadataWritten.push('keywords')
    }
  }

  const removed = remove ?? allIndexes(originalPageCount).filter(index => !keptPages.includes(index))

  return {
    bytes: await output.save(),
    summary: {
      originalPageCount,
      pageCount: output.getPageCount(),
      removed,
      rotated: rotationTargets,
      merged,
      metadataWritten,
    },
  }
}
