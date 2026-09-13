/**
 * The formal Chinese office-document typography, defined once as a `docx`
 * style set instead of being hard-coded per element. Every number a user would
 * tune (page geometry, the size ladder, line/paragraph spacing, fonts, colors,
 * table borders and padding) lives here, so the renderer only decides which
 * style an element wears.
 *
 * Choices worth stating:
 * - Page: A4 with 2.54cm top/bottom and 3.17cm left/right margins — Word's own
 *   default for A4 (the "普通" preset), so exported files match the page every
 *   Chinese office template is calibrated against.
 * - Headings: dark slate (`1F2937`) instead of Word's default blue, which reads
 *   as decoration rather than structure in a printed report.
 * - Table header: light slate fill (`F1F5F9`) with dark bold text. A dark fill
 *   with white text would print legibly too, but a light fill keeps the header
 *   distinguishable on a grayscale print without a solid block of toner.
 * - Tables are honest about their structure instead of drawing a full grid: a
 *   thin hairline separates data rows, and the only strong rules are the header
 *   underline and the totals overline. Vertical lines and an outer box were
 *   dropped because a text-only grid reads heavier than the data it carries.
 * - Falling back: OOXML stores one East Asian font per run, so `等线` is named
 *   and Word substitutes automatically when it is missing — a fallback chain
 *   cannot be expressed, only the first choice can.
 * - Body prose: justified, with a two-character first-line indent (the Chinese
 *   office convention for a formal report); list items, table cells, headings
 *   and metadata keep their own alignment and no first-line indent.
 *
 * @module @dsh-app/plugin-doc/docd/styles
 */

import {
  AlignmentType,
  BorderStyle,
  convertMillimetersToTwip,
  LevelFormat,
  LevelSuffix,
  ShadingType,
  TableLayoutType,
  VerticalAlign,
  WidthType,
} from 'docx'
import type {
  IBorderOptions,
  INumberingOptions,
  IStylesOptions,
} from 'docx'
import { displayWidth } from './number-format.ts'

/** Latin/numeral font; CJK glyphs use the East Asian font below. */
const LATIN_FONT = 'Calibri'
const CJK_FONT = '等线'

/** Font set shared by every style; `hint` steers ambiguous glyphs to the CJK face. */
const FONT = { ascii: LATIN_FONT, hAnsi: LATIN_FONT, eastAsia: CJK_FONT, hint: 'eastAsia' } as const

/** Font sizes in half-points (OOXML `w:sz`). A table header sits one step
 * above its data so the header line is legible without a heavier fill. */
const SIZE = {
  title: 44,
  h1: 36,
  h2: 30,
  h3: 26,
  body: 22,
  table: 20,
  tableHeader: 22,
  subtitle: 28,
  meta: 18,
} as const

/** Text colors; headings and body share one dark slate, metadata is muted gray. */
const COLOR = {
  text: '1F2937',
  heading: '1F2937',
  muted: '6B7280',
  tableRule: 'E2E8F0',
  tableStrong: '334155',
  tableHeaderFill: 'F1F5F9',
  tableTotalFill: 'EEF2FF',
} as const

/** Body line spacing: `line` is in twentieths of a point, 360 ≈ 1.5 lines. */
const LINE = { body: 360, table: 300 } as const

/**
 * Body prose geometry. Two characters at the 10.5pt body size are 420 twips,
 * and justification is OOXML `w:jc="both"`. Both are exported so the renderer
 * applies the same values to a body paragraph directly, which keeps the
 * geometry explicit in `document.xml` as well as in the `DocBody` style.
 */
export const BODY_FIRST_LINE_INDENT = 420
export const BODY_ALIGNMENT = AlignmentType.JUSTIFIED

/** Paragraph spacing in twentieths of a point (120 = 6pt, 240 = 12pt). */
const GAP = { headingBefore: 240, headingAfter: 120, bodyAfter: 120, metaAfter: 240 } as const

/** List indent: 0.74cm ≈ 420 twips, with the marker hanging half of it. */
const LIST_INDENT = { left: 420, hanging: 210 } as const

/** Page geometry in twips, derived from millimeters so the intent stays readable. */
export const PAGE = {
  width: convertMillimetersToTwip(210),
  height: convertMillimetersToTwip(297),
  margin: {
    top: convertMillimetersToTwip(25.4),
    bottom: convertMillimetersToTwip(25.4),
    left: convertMillimetersToTwip(31.7),
    right: convertMillimetersToTwip(31.7),
    header: convertMillimetersToTwip(15),
    footer: convertMillimetersToTwip(15),
  },
} as const

/** Width available to a table or figure between the left/right margins. */
export const CONTENT_WIDTH_TWIPS = PAGE.width - PAGE.margin.left - PAGE.margin.right

/**
 * Table rules, on the horizontal axis only. `insideHorizontal` draws the
 * 0.5pt hairline between data rows; the header underline and totals overline
 * use the 1.5pt rule so the two structural boundaries read without a full grid.
 * The outer frame and the vertical rules are declared `none` (see
 * {@link TABLE_NO_BORDER}), so a plain text table does not look like a
 * spreadsheet pasted into a report.
 */
export const TABLE_ROW_BORDER: IBorderOptions = {
  style: BorderStyle.SINGLE,
  size: 4,
  color: COLOR.tableRule,
}

/** The two structural rules: header underline and totals overline. */
export const TABLE_RULE_BORDER: IBorderOptions = {
  style: BorderStyle.SINGLE,
  size: 12,
  color: COLOR.tableStrong,
}

/**
 * docx renders every edge it is not told about as a default `single` rule, so
 * an edge the design does not draw must be declared `none` explicitly — that is
 * what actually removes the outer frame and the vertical lines.
 */
export const TABLE_NO_BORDER: IBorderOptions = {
  style: BorderStyle.NONE,
  size: 0,
  color: 'auto',
}

/** Cell padding in twentieths of a point: 3pt vertical, 6pt horizontal. */
export const TABLE_CELL_MARGIN = {
  top: 60,
  bottom: 60,
  left: 120,
  right: 120,
}

/** Column share band: below 10% a column is unreadable, above 35% it starves
 * the rest of a crowded grid. */
export const MIN_COLUMN_RATIO = 0.10
export const MAX_COLUMN_RATIO = 0.35

/** Table header cell fill (light slate, dark bold text). */
export const TABLE_HEADER_FILL = COLOR.tableHeaderFill
/** Totals-row fill: a weak indigo that separates the row without shouting. */
export const TABLE_TOTAL_FILL = COLOR.tableTotalFill

/** Header fill shading mode and cell width/layout primitives the renderer applies. */
export const TABLE_HEADER_SHADING = ShadingType.CLEAR
export const TABLE_LAYOUT = TableLayoutType.FIXED
export const TABLE_HEADER_VERTICAL_ALIGN = VerticalAlign.CENTER
export const CELL_WIDTH_TYPE = WidthType.DXA
export const TABLE_WIDTH_TYPE = WidthType.PERCENTAGE

/** Centered footer paragraph, the anchor for the page-number field. */
export const FOOTER_ALIGNMENT = AlignmentType.CENTER

/**
 * The document's style sheet: document defaults carry body typography, the
 * built-in Title/Heading 1–3 are re-skinned, and the custom paragraph/character
 * styles are the ones the renderer references by id.
 */
export const DOC_STYLES: IStylesOptions = {
  default: {
    document: {
      run: { font: FONT, size: SIZE.body, color: COLOR.text },
      paragraph: { spacing: { line: LINE.body, after: GAP.bodyAfter } },
    },
    title: {
      run: { font: FONT, size: SIZE.title, bold: true, color: COLOR.heading },
      paragraph: { spacing: { before: 0, after: GAP.headingBefore } },
    },
    heading1: {
      run: { font: FONT, size: SIZE.h1, bold: true, color: COLOR.heading },
      paragraph: { spacing: { before: GAP.headingBefore, after: GAP.headingAfter } },
    },
    heading2: {
      run: { font: FONT, size: SIZE.h2, bold: true, color: COLOR.heading },
      paragraph: { spacing: { before: GAP.headingBefore, after: GAP.headingAfter } },
    },
    heading3: {
      run: { font: FONT, size: SIZE.h3, bold: true, color: COLOR.heading },
      paragraph: { spacing: { before: GAP.headingBefore, after: GAP.headingAfter } },
    },
  },
  paragraphStyles: [
    {
      id: 'DocSubtitle',
      name: 'Doc Subtitle',
      basedOn: 'Normal',
      run: { font: FONT, size: SIZE.subtitle, color: COLOR.muted },
      paragraph: { spacing: { line: LINE.body, after: GAP.headingAfter } },
    },
    {
      id: 'DocBody',
      name: 'Doc Body',
      basedOn: 'Normal',
      run: { font: FONT, size: SIZE.body, color: COLOR.text },
      paragraph: {
        alignment: BODY_ALIGNMENT,
        indent: { firstLine: BODY_FIRST_LINE_INDENT },
        spacing: { line: LINE.body, after: GAP.bodyAfter },
      },
    },
    {
      id: 'DocFigure',
      name: 'Doc Figure',
      basedOn: 'Normal',
      run: { font: FONT, size: SIZE.body, color: COLOR.text },
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: GAP.headingAfter, after: GAP.headingAfter } },
    },
    {
      id: 'DocTableText',
      name: 'Doc Table Text',
      basedOn: 'Normal',
      run: { font: FONT, size: SIZE.table, color: COLOR.text },
      paragraph: { spacing: { line: LINE.table } },
    },
    {
      id: 'DocTableNumber',
      name: 'Doc Table Number',
      basedOn: 'Normal',
      run: { font: FONT, size: SIZE.table, color: COLOR.text },
      paragraph: { alignment: AlignmentType.RIGHT, spacing: { line: LINE.table } },
    },
    {
      id: 'DocTableHeader',
      name: 'Doc Table Header',
      basedOn: 'Normal',
      run: { font: FONT, size: SIZE.tableHeader, bold: true, color: COLOR.text },
      paragraph: { spacing: { line: LINE.table } },
    },
    {
      id: 'DocTableNumberHeader',
      name: 'Doc Table Number Header',
      basedOn: 'Normal',
      run: { font: FONT, size: SIZE.tableHeader, bold: true, color: COLOR.text },
      paragraph: { alignment: AlignmentType.RIGHT, spacing: { line: LINE.table } },
    },
    {
      id: 'DocSpacer',
      name: 'Doc Spacer',
      basedOn: 'Normal',
      run: { font: FONT, size: 12 },
      paragraph: { spacing: { line: 240, before: 0, after: 0 } },
    },
  ],
  characterStyles: [
    {
      id: 'DocMeta',
      name: 'Doc Meta',
      run: { font: FONT, size: SIZE.meta, color: COLOR.muted },
    },
  ],
}

/**
 * The bullet list definition. Bullets use a custom numbering reference rather
 * than docx's built-in one because the numbering level, not the paragraph
 * style, owns list indentation: the 0.74cm indent is set here so the marker
 * hangs where the design says (Word's default list indent is 720 twips).
 */
export const DOC_NUMBERING: INumberingOptions = {
  config: [{
    reference: 'DocBullets',
    levels: [{
      level: 0,
      format: LevelFormat.BULLET,
      text: '•',
      alignment: AlignmentType.LEFT,
      suffix: LevelSuffix.SPACE,
      style: {
        paragraph: { indent: { left: LIST_INDENT.left, hanging: LIST_INDENT.hanging } },
      },
    }],
  }],
}

/**
 * Per-column widths for the table grid, in twips, from each column's share of
 * the *display* width of its content (header plus every cell). Counting a CJK
 * glyph as two units is what keeps a Chinese column from being sized like a
 * half-length ASCII one.
 *
 * Each share is mapped linearly onto [{@link MIN_COLUMN_RATIO},
 * {@link MAX_COLUMN_RATIO}] and the results are normalized to the content
 * width. Mapping (rather than clamping a dominant share to the cap) is what
 * keeps the ordering intact: two textual columns whose shares both exceed the
 * cap would otherwise collapse to an even split, and a content-heavy column
 * would stop being wider than its neighbours. Rounding residue lands on the
 * widest column so the widths always sum to the content width exactly.
 */
export function columnWidthsTwips(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  totalWidth: number,
): number[] {
  const columns = headers.length
  if (columns === 0) return []
  const weights = headers.map((header, index) => {
    let weight = displayWidth(header)
    for (const row of rows) weight += displayWidth(row[index] ?? '')
    return Math.max(weight, 1)
  })
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const shares = weights.map(weight => {
    const share = weightSum === 0 ? 1 / columns : weight / weightSum
    return MIN_COLUMN_RATIO + (MAX_COLUMN_RATIO - MIN_COLUMN_RATIO) * share
  })
  const shareSum = shares.reduce((sum, share) => sum + share, 0)
  const widths = shares.map(share => Math.max(1, Math.round((share / shareSum) * totalWidth)))

  const drift = totalWidth - widths.reduce((sum, width) => sum + width, 0)
  if (drift !== 0 && widths.length > 0) {
    let widest = 0
    for (let index = 1; index < widths.length; index += 1) {
      if (widths[index] > widths[widest]) widest = index
    }
    widths[widest] = Math.max(1, widths[widest] + drift)
  }
  return widths
}
