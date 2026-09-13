/**
 * PDF project → PDF rendering with pdf-lib, using the embedded CJK font chosen
 * by font.ts.
 *
 * The renderer consumes the same normalized project the checker approved and
 * re-derives nothing: it re-lays out every table with the shared table layout,
 * so the pagination the checker estimated is the pagination the reader gets.
 * The checker's estimate is font-free and deliberately conservative, but it is
 * still an estimate: every paragraph, list and table is additionally paged
 * line by line, so a block the estimate believed fit — or a table taller than
 * one sheet, its header repeated on each continuation — never draws past the
 * frame and no row or line is dropped. A footer with the page number is drawn
 * after the content so it sees the final page count. Nothing is rasterized:
 * every heading, paragraph, list item and table cell stays selectable text,
 * which is what makes the read side able to round-trip a rendered file.
 *
 * Chinese body typography is applied on top of that paging: a paragraph's first
 * line is indented two characters, every line but the paragraph's last is
 * stretched to the content width (`justify.ts`), and the basic 禁则 hold while
 * wrapping (`wrapText`) for paragraphs, list items and table cells alike.
 *
 * @module @dsh-app/plugin-pdf/pdfd/render
 */

import { PDFDocument, rgb } from 'pdf-lib'
import type { PDFFont, PDFName, PDFPage } from 'pdf-lib'
import {
  beginText,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  setFillingColor,
  setFontAndSize,
  setLineWidth,
  setStrokingColor,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { resolveReportFont } from './font.ts'
import {
  AUTHOR_FONT_SIZE,
  BODY_FIRST_LINE_INDENT,
  BODY_LINE_HEIGHT,
  BULLET_GAP,
  BULLET_INDENT,
  BULLET_MARKER,
  FOOTER_FONT_SIZE,
  FOOTER_RESERVE,
  HEADING_FONT_SIZE,
  HEADING_SPACE_AFTER,
  HEADING_SPACE_BEFORE,
  PARAGRAPH_SPACE_AFTER,
  paperMetrics,
  TABLE_BORDER_WIDTH,
  TABLE_HEADER_FONT_DELTA,
  TABLE_RULE_WIDTH_MEDIUM,
  TITLE_FONT_SIZE,
  TITLE_RULE_SPACE,
  TITLE_SPACE_AFTER,
  wrapText,
} from './metrics.ts'
import { planLine } from './justify.ts'
import { layoutTable } from './table.ts'
import type { TableLayout } from './table.ts'
import { FORMAT_GLYPHS } from './number-format.ts'
import type { PdfBlock, PdfHeaderStyle, PdfProject } from './types.ts'

/** Text colours: near-black body, muted metadata, light rules. */
const TEXT_COLOR = rgb(0.13, 0.15, 0.18)
const MUTED_COLOR = rgb(0.42, 0.45, 0.5)
const RULE_COLOR = rgb(0.79, 0.82, 0.86)

/** `#RRGGBB` → a pdf-lib colour, so the table palette stays readable. */
function hex(value: string): ReturnType<typeof rgb> {
  return rgb(
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  )
}

/**
 * The table palette, one place per colour so header, rules, banding and total
 * rows cannot drift apart. The rule colours match the word processor, slide and
 * workbook renderers (`334155` medium rules, `E2E8F0` hairlines, `F8FAFC`
 * zebra, `EEF2FF` total fill).
 */
const TABLE_COLORS = {
  headerRule: hex('#334155'),
  border: hex('#E2E8F0'),
  stripe: hex('#F8FAFC'),
  totalFill: hex('#EEF2FF'),
  totalRule: hex('#334155'),
} as const

/**
 * Header band palettes. `light` is the default because the Word, PPT and Excel
 * suites all draw a `F1F5F9` header with `0F172A` text; `dark` is the inverse
 * band for screen-first decks and is opt-in through `style.header`.
 */
const TABLE_HEADER_COLORS: Readonly<Record<PdfHeaderStyle, { fill: ReturnType<typeof rgb>, text: ReturnType<typeof rgb> }>> = {
  light: { fill: hex('#F1F5F9'), text: hex('#0F172A') },
  dark: { fill: hex('#0F172A'), text: hex('#FFFFFF') },
}

/** Stroke width of the faux-bold total row (the bundled face has no bold). */
const TABLE_BOLD_STROKE_WIDTH = 0.35
/** Leading as a multiple of the font size, used for headings and titles. */
const HEADING_LEADING = 1.3
/** Baseline depth inside a table cell's line box. */
const CELL_BASELINE_RATIO = 0.78

/** Every character the renderer may draw; drives the coverage search. */
function drawnCharacters(project: PdfProject): string {
  const parts: string[] = [project.title, project.author ?? '', BULLET_MARKER, FORMAT_GLYPHS, '第页共/0123456789']
  for (const block of project.blocks) {
    if (block.heading !== undefined) parts.push(block.heading.text)
    if (block.paragraph !== undefined) parts.push(block.paragraph.text)
    if (block.bullets !== undefined) parts.push(...block.bullets)
    if (block.table !== undefined) {
      parts.push(...block.table.headers)
      for (const row of block.table.rows) parts.push(...row)
    }
  }
  return parts.join('\n')
}

/** Centred text at the current baseline. */
function drawCentered(page: PDFPage, text: string, options: {
  y: number
  size: number
  font: PDFFont
  color: ReturnType<typeof rgb>
  pageWidth: number
}): void {
  const width = options.font.widthOfTextAtSize(text, options.size)
  page.drawText(text, {
    x: (options.pageWidth - width) / 2,
    y: options.y,
    size: options.size,
    font: options.font,
    color: options.color,
  })
}

/**
 * One paragraph line. The paragraph's first line starts at the indent, every
 * later line at the margin, and all but the paragraph's last line are stretched
 * to the width they started with. A line that continues on a fresh page is an
 * ordinary continuation line: it justifies too and is never re-indented.
 */
function drawBodyLine(page: PDFPage, text: string, options: {
  x: number
  y: number
  availableWidth: number
  size: number
  font: PDFFont
  justify: boolean
}): void {
  const plan = planLine(text, {
    x: options.x,
    availableWidth: options.availableWidth,
    size: options.size,
    measure: run => options.font.widthOfTextAtSize(run, options.size),
    justify: options.justify,
  })
  for (const run of plan.runs) {
    page.drawText(run.text, { x: run.x, y: options.y, size: options.size, font: options.font, color: TEXT_COLOR })
  }
}

/**
 * Faux bold for the total row. The embedded face is a single Regular, so a
 * fill-and-stroke text render mode thickens the glyphs without a second face,
 * and — unlike drawing the text twice — the reader still extracts it once. The
 * page's font key is registered once per page by the caller.
 */
function drawBoldText(page: PDFPage, text: string, options: {
  x: number
  y: number
  size: number
  font: PDFFont
  fontKey: PDFName
  color: ReturnType<typeof rgb>
}): void {
  page.pushOperators(
    pushGraphicsState(),
    setFillingColor(options.color),
    setStrokingColor(options.color),
    setLineWidth(TABLE_BOLD_STROKE_WIDTH),
    beginText(),
    setFontAndSize(options.fontKey, options.size),
    setTextRenderingMode(TextRenderingMode.FillAndOutline),
    moveText(options.x, options.y),
    showText(options.font.encodeText(text)),
    endText(),
    popGraphicsState(),
  )
}

/** One horizontal rule of the table, at `y`, spanning the full table width. */
function drawRule(page: PDFPage, x: number, y: number, width: number, thickness: number, color: ReturnType<typeof rgb>): void {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness, color })
}

/**
 * One slice of a table: the header band chosen by the document's style, the
 * given data rows (global indices, so banding and heights stay consistent
 * across pages) and the horizontal rules only.
 *
 * The grid is deliberately absent: a medium rule closes the header, a 0.5 pt
 * hairline separates data rows, and a total row gets a medium top rule plus a
 * fill. No column vertical and no outer frame is ever drawn, so the table reads
 * as a table instead of a wall of boxes. Alignment follows each column's plan,
 * so numeric columns are right-aligned in the header and the body alike.
 * Returns the vertical space the slice consumed, including the header.
 */
function drawTable(page: PDFPage, layout: TableLayout, options: {
  x: number
  top: number
  font: PDFFont
  fontSize: number
  rows: readonly number[]
  headerColors: { readonly fill: ReturnType<typeof rgb>, readonly text: ReturnType<typeof rgb> }
}): number {
  const totalWidth = layout.columnWidths.reduce((sum, width) => sum + width, 0)
  const { x, top, font, fontSize, rows, headerColors } = options
  const headerSize = fontSize + TABLE_HEADER_FONT_DELTA
  // A total row is the only bold text in a table, so the stroke-mode font key
  // is registered lazily, once per page that actually shows one.
  const boldFontKey = layout.rows.some(row => row.isTotal) ? page.node.newFontDictionary(font.name, font.ref) : undefined

  page.drawRectangle({
    x,
    y: top - layout.headerHeight,
    width: totalWidth,
    height: layout.headerHeight,
    color: headerColors.fill,
  })

  const drawCells = (
    lines: readonly (readonly string[])[],
    rowTop: number,
    color: ReturnType<typeof rgb>,
    size: number,
    bold: boolean,
  ): void => {
    let cellX = x
    for (const [index, cellLines] of lines.entries()) {
      const columnWidth = layout.columnWidths[index] ?? 0
      const align = layout.columnAlign[index] ?? 'left'
      const firstBaseline = rowTop - layout.cellPadding - layout.lineHeight * CELL_BASELINE_RATIO
      for (const [lineIndex, line] of cellLines.entries()) {
        if (line === '') continue
        const y = firstBaseline - lineIndex * layout.lineHeight
        const textWidth = font.widthOfTextAtSize(line, size)
        const textX = align === 'right' ? cellX + columnWidth - layout.cellPadding - textWidth : cellX + layout.cellPadding
        if (bold && boldFontKey !== undefined) drawBoldText(page, line, { x: textX, y, size, font, fontKey: boldFontKey, color })
        else page.drawText(line, { x: textX, y, size, font, color })
      }
      cellX += columnWidth
    }
  }

  drawCells(layout.headerLines, top, headerColors.text, headerSize, false)
  // The medium rule under the header, then one hairline per non-total row.
  let rowTop = top - layout.headerHeight
  drawRule(page, x, rowTop, totalWidth, TABLE_RULE_WIDTH_MEDIUM, TABLE_COLORS.headerRule)
  for (const index of rows) {
    const row = layout.rows[index]
    if (row === undefined) continue
    if (row.striped) {
      page.drawRectangle({
        x,
        y: rowTop - row.height,
        width: totalWidth,
        height: row.height,
        color: TABLE_COLORS.stripe,
      })
    }
    if (row.isTotal) {
      page.drawRectangle({
        x,
        y: rowTop - row.height,
        width: totalWidth,
        height: row.height,
        color: TABLE_COLORS.totalFill,
      })
    }
    drawCells(row.lines, rowTop, TEXT_COLOR, fontSize, row.isTotal)
    const bottom = rowTop - row.height
    // A total row's medium rule sits on its top edge, so the hairline under the
    // row above it is skipped — one boundary, one rule.
    if (row.isTotal) drawRule(page, x, rowTop, totalWidth, TABLE_RULE_WIDTH_MEDIUM, TABLE_COLORS.totalRule)
    else if (layout.rows[index + 1]?.isTotal !== true) {
      drawRule(page, x, bottom, totalWidth, TABLE_BORDER_WIDTH, TABLE_COLORS.border)
    }
    rowTop = bottom
  }
  return top - rowTop
}

/** The rendered bytes plus the font that carried them (diagnostics). */
export interface RenderPdfOutput {
  readonly bytes: Uint8Array
  /** `built-in`, `DSH_PDF_FONT`, or the absolute path of the embedded font. */
  readonly fontSource: string
}

/**
 * Render one approved project into PDF bytes.
 * @param project - the normalized project (error-free by construction).
 * @returns the bytes and the resolved font label, so callers can report which
 * font was embedded (and prove the bundled asset was found).
 * @throws Error when no available font covers the document's characters.
 */
export async function renderPdfProject(project: PdfProject): Promise<RenderPdfOutput> {
  const resolved = await resolveReportFont(drawnCharacters(project))
  const metrics = paperMetrics(project.size)

  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(resolved.bytes, { subset: true })
  pdf.setTitle(project.title)
  if (project.author !== undefined) pdf.setAuthor(project.author)
  pdf.setProducer('dsh-app plugin-pdf')
  pdf.setCreator('dsh-app plugin-pdf')

  const pages: PDFPage[] = []
  const measure = (text: string, size: number): number => font.widthOfTextAtSize(text, size)
  const headerColors = TABLE_HEADER_COLORS[project.style?.header ?? 'light']

  let page = pdf.addPage([metrics.width, metrics.height])
  pages.push(page)
  let y = metrics.contentTop

  const newPage = (): void => {
    page = pdf.addPage([metrics.width, metrics.height])
    pages.push(page)
    y = metrics.contentTop
  }
  /** Open a page when the next `height` points would cross the footer. */
  const ensure = (height: number): void => {
    if (y - height < metrics.contentBottom) newPage()
  }

  // Title block: the title, an optional byline, then a hairline rule.
  const titleLines = wrapText(project.title, metrics.contentWidth, text => measure(text, TITLE_FONT_SIZE))
  for (const line of titleLines) {
    const leading = TITLE_FONT_SIZE * HEADING_LEADING
    ensure(leading)
    y -= leading
    drawCentered(page, line, { y, size: TITLE_FONT_SIZE, font, color: TEXT_COLOR, pageWidth: metrics.width })
  }
  if (project.author !== undefined) {
    ensure(AUTHOR_FONT_SIZE * HEADING_LEADING)
    y -= AUTHOR_FONT_SIZE * HEADING_LEADING + 4
    drawCentered(page, project.author, {
      y,
      size: AUTHOR_FONT_SIZE,
      font,
      color: MUTED_COLOR,
      pageWidth: metrics.width,
    })
  }
  ensure(TITLE_SPACE_AFTER + TITLE_RULE_SPACE)
  y -= TITLE_SPACE_AFTER
  page.drawLine({
    start: { x: metrics.margin, y },
    end: { x: metrics.width - metrics.margin, y },
    thickness: 0.8,
    color: RULE_COLOR,
  })
  y -= TITLE_RULE_SPACE

  for (const block of project.blocks) {
    if (block.pageBreak === true) {
      newPage()
      continue
    }
    if (block.heading !== undefined) {
      const size = HEADING_FONT_SIZE[block.heading.level]
      const leading = size * HEADING_LEADING
      const lines = wrapText(block.heading.text, metrics.contentWidth, text => measure(text, size))
      const before = HEADING_SPACE_BEFORE[block.heading.level]
      const after = HEADING_SPACE_AFTER[block.heading.level]
      ensure(before + lines.length * leading + after)
      y -= before
      for (const line of lines) {
        y -= leading
        page.drawText(line, { x: metrics.margin, y, size, font, color: TEXT_COLOR })
      }
      y -= after
      continue
    }
    if (block.paragraph !== undefined) {
      // The indent narrows only the paragraph's first line, hence the matching
      // wrap width. Justification is decided per line afterwards, so a 禁则 mark
      // pulled back from a line head never disturbs the stretch of its line.
      const lines = wrapText(
        block.paragraph.text,
        metrics.contentWidth,
        text => measure(text, metrics.bodyFontSize),
        { firstLineIndent: BODY_FIRST_LINE_INDENT },
      )
      // Line-by-line paging: the checker estimates with a font-free measure, so
      // a paragraph it predicted as fitting can still be taller with the real
      // font. Continuing on a fresh page keeps every line inside the frame.
      for (const [index, line] of lines.entries()) {
        ensure(BODY_LINE_HEIGHT)
        y -= BODY_LINE_HEIGHT
        if (line === '') continue
        const indent = index === 0 ? BODY_FIRST_LINE_INDENT : 0
        drawBodyLine(page, line, {
          x: metrics.margin + indent,
          y,
          availableWidth: metrics.contentWidth - indent,
          size: metrics.bodyFontSize,
          font,
          justify: index < lines.length - 1,
        })
      }
      y -= PARAGRAPH_SPACE_AFTER
      continue
    }
    if (block.bullets !== undefined) {
      const items = block.bullets.map(item => wrapText(
        item,
        metrics.contentWidth - BULLET_INDENT,
        text => measure(text, metrics.bodyFontSize),
      ))
      items.forEach((lines, index) => {
        lines.forEach((line, lineIndex) => {
          ensure(BODY_LINE_HEIGHT)
          y -= BODY_LINE_HEIGHT
          if (lineIndex === 0) {
            page.drawText(BULLET_MARKER, {
              x: metrics.margin,
              y,
              size: metrics.bodyFontSize,
              font,
              color: MUTED_COLOR,
            })
          }
          if (line !== '') {
            page.drawText(line, {
              x: metrics.margin + BULLET_INDENT,
              y,
              size: metrics.bodyFontSize,
              font,
              color: TEXT_COLOR,
            })
          }
        })
        if (index < items.length - 1) {
          ensure(BULLET_GAP)
          y -= BULLET_GAP
        }
      })
      y -= PARAGRAPH_SPACE_AFTER
      continue
    }
    if (block.table !== undefined) {
      const layout = layoutTable(block.table, {
        availableWidth: metrics.contentWidth,
        measure: text => measure(text, metrics.bodyFontSize),
        headerMeasure: text => measure(text, metrics.bodyFontSize + TABLE_HEADER_FONT_DELTA),
      })
      // The checker budgets a whole table against one page, but the real font
      // can still push a row past the frame. Fill the page, then repeat the
      // header on the next — content is never clipped, even when this splits a
      // table the estimate believed fit.
      if (layout.rows.length === 0) {
        ensure(layout.headerHeight)
        y -= drawTable(page, layout, { x: metrics.margin, top: y, font, fontSize: metrics.bodyFontSize, rows: [], headerColors })
        y -= PARAGRAPH_SPACE_AFTER
        continue
      }
      let cursor = 0
      while (cursor < layout.rows.length) {
        const firstHeight = layout.rows[cursor]?.height ?? 0
        if (y - (layout.headerHeight + firstHeight) < metrics.contentBottom) newPage()
        const available = y - metrics.contentBottom - layout.headerHeight
        const slice: number[] = []
        let used = 0
        while (cursor < layout.rows.length) {
          const height = layout.rows[cursor]?.height ?? 0
          // A row taller than a whole frame is drawn alone rather than looping
          // forever; every other row stays within the available space.
          if (slice.length === 0 && height > available) {
            slice.push(cursor)
            cursor += 1
            break
          }
          if (used + height > available) break
          slice.push(cursor)
          used += height
          cursor += 1
        }
        y -= drawTable(page, layout, {
          x: metrics.margin,
          top: y,
          font,
          fontSize: metrics.bodyFontSize,
          rows: slice,
          headerColors,
        })
        if (cursor < layout.rows.length) newPage()
        else y -= PARAGRAPH_SPACE_AFTER
      }
      continue
    }
  }

  // Footers after the content so every page shows its final number.
  pages.forEach((target, index) => {
    drawCentered(target, `第 ${index + 1} 页 / 共 ${pages.length} 页`, {
      y: metrics.margin + FOOTER_RESERVE / 2 - FOOTER_FONT_SIZE / 2,
      size: FOOTER_FONT_SIZE,
      font,
      color: MUTED_COLOR,
      pageWidth: metrics.width,
    })
  })

  return { bytes: await pdf.save(), fontSource: resolved.source }
}
