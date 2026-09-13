/**
 * DOC → .docx rendering with the `docx` library (pure JS, native Office Open
 * XML — every heading, list item, table cell and picture stays editable in
 * Word/WPS, nothing is rasterized).
 *
 * The renderer consumes the same normalized project the checker approved and
 * re-derives nothing: `renderDocProject` is the last gate, so it re-reads each
 * image from the workspace and fails with an actionable Chinese message when
 * one is missing rather than exporting a document with a hole in it.
 *
 * Typography is not decided here: the page, font size ladder, spacing, colors
 * and table geometry come from `./styles.ts` as a style sheet, and each element
 * only wears the matching style id. That is what keeps one document coherent
 * and every future adjustment a one-line edit.
 *
 * @module @dsh-app/plugin-doc/docd/render
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx'
import { imageSizeOf } from './image-size.ts'
import { isTotalRowLabel, planColumnFormat } from './number-format.ts'
import {
  BODY_ALIGNMENT,
  BODY_FIRST_LINE_INDENT,
  CELL_WIDTH_TYPE,
  CONTENT_WIDTH_TWIPS,
  DOC_NUMBERING,
  DOC_STYLES,
  FOOTER_ALIGNMENT,
  PAGE,
  TABLE_CELL_MARGIN,
  TABLE_HEADER_FILL,
  TABLE_HEADER_SHADING,
  TABLE_HEADER_VERTICAL_ALIGN,
  TABLE_LAYOUT,
  TABLE_NO_BORDER,
  TABLE_ROW_BORDER,
  TABLE_RULE_BORDER,
  TABLE_TOTAL_FILL,
  TABLE_WIDTH_TYPE,
  columnWidthsTwips,
} from './styles.ts'
import type { ITableBordersOptions } from 'docx'
import type { DocBlock, DocProject, DocTable } from './types.ts'

/** Picture box the renderer scales into (pixels at 96 dpi). */
const MAX_IMAGE_WIDTH = 600
const MAX_IMAGE_HEIGHT = 800
/** Fallback box for a format whose header could not be read. */
const FALLBACK_IMAGE_WIDTH = 480
const FALLBACK_IMAGE_HEIGHT = 320

const HEADING_BY_LEVEL = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const

/** Custom paragraph/character style ids owned by {@link DOC_STYLES}. */
const STYLE = {
  subtitle: 'DocSubtitle',
  body: 'DocBody',
  figure: 'DocFigure',
  tableText: 'DocTableText',
  tableNumber: 'DocTableNumber',
  tableHeader: 'DocTableHeader',
  tableNumberHeader: 'DocTableNumberHeader',
  spacer: 'DocSpacer',
  meta: 'DocMeta',
} as const

/** Numbering reference of the bullet list definition owned by {@link DOC_NUMBERING}. */
const BULLET_REFERENCE = 'DocBullets'

/** docx's supported embedded image types, keyed by file extension. */
const IMAGE_TYPE_BY_EXTENSION: Readonly<Record<string, 'png' | 'jpg' | 'gif' | 'bmp'>> = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.gif': 'gif',
  '.bmp': 'bmp',
}

/**
 * Data-row rules only: one hairline between rows; the outer frame and the
 * vertical lines are declared `none` (docx would otherwise draw its default
 * `single` border on every edge it is not told about). The header underline and
 * totals overline are cell-level rules ({@link TABLE_RULE_BORDER}), applied in
 * {@link tableOf}.
 */
const TABLE_BORDERS: ITableBordersOptions = {
  top: TABLE_NO_BORDER,
  bottom: TABLE_NO_BORDER,
  left: TABLE_NO_BORDER,
  right: TABLE_NO_BORDER,
  insideHorizontal: TABLE_ROW_BORDER,
  insideVertical: TABLE_NO_BORDER,
}

/** Scale an intrinsic size down into the picture box, never up. */
function fitImage(width: number, height: number): { width: number, height: number } {
  const ratio = Math.min(1, MAX_IMAGE_WIDTH / width, MAX_IMAGE_HEIGHT / height)
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) }
}

/** The blank paragraph that keeps tables off the prose around them. */
function spacer(): Paragraph {
  return new Paragraph({ style: STYLE.spacer })
}

/**
 * One full-width table: a bold header on a light fill with a 1.5pt underline,
 * a totals row marked by an overline and a weak fill, horizontal hairlines only,
 * and column widths proportional to how much *display* width each column
 * carries (see `columnWidthsTwips`). Each column resolves one format plan, so
 * numbers align right and read at a uniform precision while text stays left.
 */
function tableOf(table: DocTable): Table {
  const widths = columnWidthsTwips(table.headers, table.rows, CONTENT_WIDTH_TWIPS)
  const plans = table.headers.map((header, index) => planColumnFormat(
    table.rows.map(row => row[index] ?? ''),
    header,
  ))
  const headerRow = new TableRow({
    tableHeader: true,
    children: table.headers.map((header, index) => new TableCell({
      width: { size: widths[index], type: CELL_WIDTH_TYPE },
      shading: { fill: TABLE_HEADER_FILL, type: TABLE_HEADER_SHADING },
      verticalAlign: TABLE_HEADER_VERTICAL_ALIGN,
      margins: TABLE_CELL_MARGIN,
      borders: { bottom: TABLE_RULE_BORDER },
      children: [new Paragraph({
        style: plans[index]?.align === 'right' ? STYLE.tableNumberHeader : STYLE.tableHeader,
        children: [new TextRun({ text: header })],
      })],
    })),
  })
  const bodyRows = table.rows.map(row => {
    const total = isTotalRowLabel(row[0] ?? '')
    return new TableRow({
      children: row.map((cell, index) => new TableCell({
        width: { size: widths[index], type: CELL_WIDTH_TYPE },
        margins: TABLE_CELL_MARGIN,
        ...(total ? {
          shading: { fill: TABLE_TOTAL_FILL, type: TABLE_HEADER_SHADING },
          borders: { top: TABLE_RULE_BORDER },
        } : {}),
        children: [new Paragraph({
          style: plans[index]?.align === 'right' ? STYLE.tableNumber : STYLE.tableText,
          children: [new TextRun({
            text: plans[index]?.format(cell) ?? cell,
            ...(total ? { bold: true } : {}),
          })],
        })],
      })),
    })
  })
  return new Table({
    width: { size: 100, type: TABLE_WIDTH_TYPE },
    columnWidths: widths,
    layout: TABLE_LAYOUT,
    borders: TABLE_BORDERS,
    margins: TABLE_CELL_MARGIN,
    rows: [headerRow, ...bodyRows],
  })
}

/** Title, optional subtitle and the "作者 · 日期" metadata line. */
function masthead(project: DocProject): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: project.title })],
    }),
  ]
  if (project.subtitle !== undefined) {
    paragraphs.push(new Paragraph({
      style: STYLE.subtitle,
      children: [new TextRun({ text: project.subtitle })],
    }))
  }
  const metadata = [project.author, project.date].filter((part): part is string => part !== undefined)
  if (metadata.length > 0) {
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: metadata.join(' · '), style: STYLE.meta })],
    }))
  }
  return paragraphs
}

/**
 * Render one approved project into .docx bytes.
 * @param project - the normalized project (error-free by construction).
 * @param options - workspace root used to resolve image paths.
 * @throws Error naming every missing/unreadable image and its block index.
 */
export async function renderDocProject(
  project: DocProject,
  options: { workspaceRoot: string },
): Promise<Uint8Array> {
  const children: (Paragraph | Table)[] = masthead(project)

  const missingImages: string[] = []
  for (const [index, block] of project.sections.entries()) {
    const blockNumber = index + 1
    children.push(...await blockChildren(block, blockNumber, options.workspaceRoot, missingImages))
  }

  if (missingImages.length > 0) {
    throw new Error(`图片块引用无法读取：${missingImages.join('；')}。请把图片放入工作区并按 image.path 引用`)
  }

  const document = new Document({
    styles: DOC_STYLES,
    numbering: DOC_NUMBERING,
    sections: [{
      properties: {
        page: {
          size: { width: PAGE.width, height: PAGE.height },
          margin: PAGE.margin,
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: FOOTER_ALIGNMENT,
            // `PAGE` / `NUMPAGES` are real Word fields, so the footer renumbers
            // itself when the user edits the document; the shape matches the
            // PDF suite's `第 N 页 / 共 M 页` footer.
            children: [new TextRun({
              children: ['第 ', PageNumber.CURRENT, ' 页 共 ', PageNumber.TOTAL_PAGES, ' 页'],
            })],
          })],
        }),
      },
      children,
    }],
  })
  return Packer.toBuffer(document)
}

/** One block's docx nodes; an unreadable image is recorded, not thrown here. */
async function blockChildren(
  block: DocBlock,
  blockNumber: number,
  workspaceRoot: string,
  missingImages: string[],
): Promise<(Paragraph | Table)[]> {
  if (block.heading !== undefined) {
    return [new Paragraph({
      heading: HEADING_BY_LEVEL[block.heading.level],
      children: [new TextRun({ text: block.heading.text })],
    })]
  }
  if (block.paragraph !== undefined) {
    return [new Paragraph({
      style: STYLE.body,
      // Stated on the paragraph too, from the same constants the DocBody style
      // uses, so the exported body carries the indent and justification itself.
      alignment: BODY_ALIGNMENT,
      indent: { firstLine: BODY_FIRST_LINE_INDENT },
      children: [new TextRun({
        text: block.paragraph.text,
        ...(block.paragraph.bold === undefined ? {} : { bold: block.paragraph.bold }),
        ...(block.paragraph.italic === undefined ? {} : { italics: block.paragraph.italic }),
      })],
    })]
  }
  if (block.bullets !== undefined) {
    return block.bullets.map(item => new Paragraph({
      text: item,
      numbering: { reference: BULLET_REFERENCE, level: 0 },
    }))
  }
  if (block.table !== undefined) {
    return [spacer(), tableOf(block.table), spacer()]
  }
  if (block.image !== undefined) {
    return [await imageParagraph(block.image.path, blockNumber, workspaceRoot, missingImages)]
  }
  return []
}

/** Embed one centered picture at its intrinsic aspect ratio, bounded to the page. */
async function imageParagraph(
  imagePath: string,
  blockNumber: number,
  workspaceRoot: string,
  missingImages: string[],
): Promise<Paragraph> {
  const extension = path.posix.extname(imagePath).toLowerCase()
  const type = IMAGE_TYPE_BY_EXTENSION[extension]
  let bytes: Uint8Array
  try {
    bytes = await readFile(path.resolve(workspaceRoot, ...imagePath.split('/')))
  } catch {
    missingImages.push(`第 ${blockNumber} 块 image.path=${imagePath}`)
    return new Paragraph({ style: STYLE.body })
  }
  const intrinsic = imageSizeOf(bytes)
  const size = intrinsic === undefined
    ? { width: FALLBACK_IMAGE_WIDTH, height: FALLBACK_IMAGE_HEIGHT }
    : fitImage(intrinsic.width, intrinsic.height)
  return new Paragraph({
    style: STYLE.figure,
    children: [new ImageRun({
      type: type ?? 'png',
      data: bytes,
      transformation: size,
      altText: { name: imagePath, description: `文档插图（第 ${blockNumber} 块）` },
    })],
  })
}
