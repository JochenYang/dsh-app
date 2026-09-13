/**
 * PDF project checker: structure, closed-field validation, heading-level
 * continuity and the measurable page-fit rules, all without external effects.
 * A failed check is a normal authoring result — the point is to hand the model
 * every problem (document, 1-based block index, field, actionable Chinese
 * message with a fix hint) in one pass, which is what makes the render gate
 * trustworthy: an unknown field, a malformed table or a block taller than a
 * sheet is refused before a PDF exists.
 *
 * The same parse feeds the renderer, so what the checker accepted is exactly
 * what gets rendered (`loadPdfDocument` normalizes to the AST both share).
 *
 * @module @dsh-app/plugin-pdf/pdfd/check
 */

import {
  approxMeasure,
  BODY_FIRST_LINE_INDENT,
  BODY_FONT_SIZE,
  BODY_LINE_HEIGHT,
  BULLET_GAP,
  BULLET_INDENT,
  HEADING_FONT_SIZE,
  HEADING_SPACE_AFTER,
  HEADING_SPACE_BEFORE,
  paperMetrics,
  PARAGRAPH_SPACE_AFTER,
  TABLE_HEADER_FONT_DELTA,
  wrapText,
} from './metrics.ts'
import { layoutTable } from './table.ts'
import {
  decimalPlacesOfText,
  isRatioColumn,
  parseNumber,
} from './number-format.ts'
import {
  asRecord,
  asText,
  BLOCK_CONTENT_KEYS,
  BLOCK_FIELDS,
  DOCUMENT_FIELDS,
  HEADING_LEVELS,
  HEADER_STYLES,
  MAX_AUTHOR_CHARS,
  MAX_BLOCKS,
  MAX_BULLET_CHARS,
  MAX_BULLETS,
  MAX_CELL_CHARS,
  MAX_HEADING_CHARS,
  MAX_PARAGRAPH_CHARS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MAX_TITLE_CHARS,
  PAPER_SIZES,
  STYLE_FIELDS,
} from './types.ts'
import type { PdfBlock, PdfCheckResult, PdfHeaderStyle, PdfIssue, PdfPaperSize, PdfProject, PdfStyle, PdfTable } from './types.ts'

/** The normalized project plus every diagnostic found while building it. */
export interface ParsedPdf {
  readonly project: PdfProject
  readonly issues: readonly PdfIssue[]
}

/** The content key present in one block, or `undefined` when it is malformed. */
function contentKeysOf(block: Record<string, unknown>): string[] {
  return BLOCK_CONTENT_KEYS.filter(key => block[key] !== undefined)
}

/** Unknown own properties, in authoring order. */
function unknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(record).filter(key => !allowed.has(key))
}

/** Body lines one piece of text occupies in the text frame. */
function bodyLines(text: string, contentWidth: number): number {
  return wrapText(text, contentWidth, approxMeasure(BODY_FONT_SIZE), {
    firstLineIndent: BODY_FIRST_LINE_INDENT,
  }).length
}

/** Height a block adds to its page, in points (what the pagination estimate sums). */
function blockHeight(block: PdfBlock, contentWidth: number): number {
  if (block.heading !== undefined) {
    const size = HEADING_FONT_SIZE[block.heading.level]
    const lines = wrapText(block.heading.text, contentWidth, approxMeasure(size)).length
    return HEADING_SPACE_BEFORE[block.heading.level] + lines * size * 1.4 + HEADING_SPACE_AFTER[block.heading.level]
  }
  if (block.paragraph !== undefined) {
    const lines = bodyLines(block.paragraph.text, contentWidth)
    return lines * BODY_LINE_HEIGHT + PARAGRAPH_SPACE_AFTER
  }
  if (block.bullets !== undefined) {
    const lines = block.bullets.reduce(
      (sum, item) => sum + wrapText(item, contentWidth - BULLET_INDENT, approxMeasure(BODY_FONT_SIZE)).length,
      0,
    )
    return lines * BODY_LINE_HEIGHT + Math.max(0, block.bullets.length - 1) * BULLET_GAP + PARAGRAPH_SPACE_AFTER
  }
  if (block.table !== undefined) {
    return layoutTable(block.table, {
      availableWidth: contentWidth,
      measure: approxMeasure(BODY_FONT_SIZE),
      headerMeasure: approxMeasure(BODY_FONT_SIZE + TABLE_HEADER_FONT_DELTA),
    }).totalHeight + PARAGRAPH_SPACE_AFTER
  }
  return 0
}

/** Estimated printed pages: the same accounting the renderer performs. */
function estimatePages(project: PdfProject): number {
  const metrics = paperMetrics(project.size)
  let pages = 1
  let used = TITLE_BLOCK_ESTIMATE
  for (const block of project.blocks) {
    if (block.pageBreak === true) {
      pages += 1
      used = 0
      continue
    }
    const height = blockHeight(block, metrics.contentWidth)
    if (used > 0 && used + height > metrics.contentHeight) {
      pages += 1
      used = height
    } else {
      used += height
    }
  }
  return pages
}

/** Title + author + rule on the first page. */
const TITLE_BLOCK_ESTIMATE = 62

/**
 * Parse and validate raw JSON into the shared PDF AST.
 *
 * Normalization is best-effort by design: invalid blocks are dropped from the
 * returned project, and the renderer is only ever reached with zero errors, so
 * a dropped block can never be silently missing from a delivered PDF.
 */
export function loadPdfDocument(value: unknown): ParsedPdf {
  const issues: PdfIssue[] = []
  const root = asRecord(value)
  if (root === undefined) {
    issues.push({
      code: 'invalid-document',
      severity: 'error',
      message: '文档根节点必须是一个 JSON 对象（{ title, author?, size?, style?, blocks }）。',
      fix: '把顶层改成对象，包含 title 与 blocks 两个字段。',
    })
    return { project: { title: '', size: 'a4', blocks: [] }, issues }
  }

  for (const field of unknownFields(root, DOCUMENT_FIELDS)) {
    issues.push({
      code: 'unknown-field',
      severity: 'error',
      field,
      message: `顶层存在未知字段 ${field}。`,
      fix: `删除 ${field}；顶层只允许 title、author、size、style、blocks。`,
    })
  }

  const title = asText(root.title)
  if (title === undefined) {
    issues.push({
      code: 'invalid-title',
      severity: 'error',
      field: 'title',
      message: 'title 必须是非空字符串。',
      fix: '补上文档标题，例如 "title": "季度复盘"。',
    })
  } else if (title.length > MAX_TITLE_CHARS) {
    issues.push({
      code: 'title-too-long',
      severity: 'error',
      field: 'title',
      message: `title 超过 ${MAX_TITLE_CHARS} 字上限（当前 ${title.length} 字）。`,
      fix: '把标题压缩为一句短语。',
    })
  }

  let author: string | undefined
  if (root.author !== undefined) {
    const parsed = asText(root.author)
    if (parsed === undefined) {
      issues.push({
        code: 'invalid-author',
        severity: 'error',
        field: 'author',
        message: 'author 必须是非空字符串（不需要时直接省略该字段）。',
        fix: '删除 author 或填入作者名。',
      })
    } else if (parsed.length > MAX_AUTHOR_CHARS) {
      issues.push({
        code: 'author-too-long',
        severity: 'error',
        field: 'author',
        message: `author 超过 ${MAX_AUTHOR_CHARS} 字上限。`,
        fix: '只保留作者姓名或团队名。',
      })
    } else {
      author = parsed
    }
  }

  let size: PdfPaperSize = 'a4'
  if (root.size !== undefined) {
    const parsed = asText(root.size)
    if (parsed === undefined || !PAPER_SIZES.has(parsed)) {
      issues.push({
        code: 'invalid-size',
        severity: 'error',
        field: 'size',
        message: 'size 只能是 "a4" 或 "letter"（省略时为 a4）。',
        fix: '把 size 改为 "a4" 或 "letter"，或直接省略该字段。',
      })
    } else {
      size = parsed as PdfPaperSize
    }
  }

  // `style` is optional and closed like every other object: an unknown switch
  // or an unknown header value is an error, not a silent fallback, and the
  // renderer only ever sees the two names it knows.
  let style: PdfStyle | undefined
  if (root.style !== undefined) {
    const record = asRecord(root.style)
    if (record === undefined) {
      issues.push({
        code: 'invalid-style',
        severity: 'error',
        field: 'style',
        message: 'style 必须是对象 { header? }。',
        fix: '写成 { "style": { "header": "light" } }，或直接省略该字段。',
      })
    } else {
      for (const field of unknownFields(record, STYLE_FIELDS)) {
        issues.push({
          code: 'unknown-field',
          severity: 'error',
          field: `style.${field}`,
          message: `style 内存在未知字段 ${field}。`,
          fix: `删除 style.${field}；style 只允许 header。`,
        })
      }
      if (record.header !== undefined) {
        const parsed = asText(record.header)
        if (parsed === undefined || !HEADER_STYLES.has(parsed)) {
          issues.push({
            code: 'invalid-style-header',
            severity: 'error',
            field: 'style.header',
            message: 'style.header 只能是 "light" 或 "dark"（省略时为 light）。',
            fix: '把 style.header 改为 "light" 或 "dark"，或直接省略该字段。',
          })
        } else {
          style = { header: parsed as PdfHeaderStyle }
        }
      }
    }
  }

  if (!Array.isArray(root.blocks)) {
    issues.push({
      code: 'invalid-blocks',
      severity: 'error',
      field: 'blocks',
      message: 'blocks 必须是块数组。',
      fix: '把 blocks 写成 [{ "heading": ... }, { "paragraph": ... }] 形式的数组。',
    })
    return { project: { title: title ?? '', ...(author === undefined ? {} : { author }), size, ...(style === undefined ? {} : { style }), blocks: [] }, issues }
  }

  if (root.blocks.length === 0) {
    issues.push({
      code: 'empty-document',
      severity: 'error',
      field: 'blocks',
      message: 'blocks 为空：文档至少需要一个内容块。',
      fix: '按提纲写入标题块与正文块后再渲染。',
    })
  } else if (root.blocks.length > MAX_BLOCKS) {
    issues.push({
      code: 'too-many-blocks',
      severity: 'error',
      field: 'blocks',
      message: `块数 ${root.blocks.length} 超过单文档上限 ${MAX_BLOCKS}。`,
      fix: '合并重复段落，或拆成多份文档。',
    })
  }

  const metrics = paperMetrics(size)
  const blocks: PdfBlock[] = []
  let previousHeadingLevel: number | undefined
  for (const [index, raw] of root.blocks.entries()) {
    const block = index + 1
    const record = asRecord(raw)
    if (record === undefined) {
      issues.push({
        code: 'invalid-block',
        severity: 'error',
        block,
        message: '块必须是 JSON 对象。',
        fix: '把该块改成 { "paragraph": { "text": "..." } } 形式。',
      })
      continue
    }
    for (const field of unknownFields(record, new Set(BLOCK_CONTENT_KEYS))) {
      issues.push({
        code: 'unknown-field',
        severity: 'error',
        block,
        field,
        message: `块内存在未知字段 ${field}。`,
        fix: `删除 ${field}；每个块只允许 ${BLOCK_CONTENT_KEYS.join('、')} 之一。`,
      })
    }
    const keys = contentKeysOf(record)
    if (keys.length === 0) {
      issues.push({
        code: 'missing-content',
        severity: 'error',
        block,
        message: '块内没有任何内容键。',
        fix: `给该块加一个内容键（${BLOCK_CONTENT_KEYS.join('、')} 之一）。`,
      })
      continue
    }
    if (keys.length > 1) {
      issues.push({
        code: 'multiple-content',
        severity: 'error',
        block,
        message: `一个块只能有一种内容，当前同时出现 ${keys.join('、')}。`,
        fix: '拆成多个块，每块只保留一种内容。',
      })
      continue
    }

    const key = keys[0] as string
    switch (key) {
      case 'heading': {
        const level = parseHeading(record.heading, block, issues)
        const text = parseBlockText(record.heading, block, 'heading.text', MAX_HEADING_CHARS, issues)
        if (level !== undefined) {
          if (previousHeadingLevel === undefined && level !== 1) {
            issues.push({
              code: 'heading-level-jump',
              severity: 'error',
              block,
              field: 'heading.level',
              message: `第一个标题是 H${level}：文档必须从 H1 开始。`,
              fix: '把该块 level 改为 1。',
            })
          } else if (previousHeadingLevel !== undefined && level > previousHeadingLevel + 1) {
            issues.push({
              code: 'heading-level-jump',
              severity: 'error',
              block,
              field: 'heading.level',
              message: `标题层级从 H${previousHeadingLevel} 跳到 H${level}，排版会缺一层。`,
              fix: `把 level 改为 ${previousHeadingLevel + 1}，或在其间补一个 H${previousHeadingLevel + 1} 标题。`,
            })
          }
          previousHeadingLevel = level
        }
        if (level !== undefined && text !== undefined) blocks.push({ heading: { level, text } })
        break
      }
      case 'paragraph': {
        const container = asRecord(record.paragraph)
        if (container !== undefined) {
          for (const field of unknownFields(container, BLOCK_FIELDS.paragraph)) {
            issues.push({
              code: 'unknown-field',
              severity: 'error',
              block,
              field: `paragraph.${field}`,
              message: `paragraph 内存在未知字段 ${field}。`,
              fix: `删除 paragraph.${field}；paragraph 只允许 text。`,
            })
          }
        }
        const text = parseBlockText(record.paragraph, block, 'paragraph.text', MAX_PARAGRAPH_CHARS, issues)
        if (text !== undefined) {
          if (bodyLines(text, metrics.contentWidth) > metrics.bodyLinesPerPage) {
            issues.push({
              code: 'block-too-tall',
              severity: 'error',
              block,
              field: 'paragraph.text',
              message: `该段落约 ${bodyLines(text, metrics.contentWidth)} 行，超过单页可容纳的 ${metrics.bodyLinesPerPage} 行。`,
              fix: '拆成多个 paragraph 块，每个块不超过一页。',
            })
          }
          blocks.push({ paragraph: { text } })
        }
        break
      }
      case 'bullets': {
        const bullets = parseBullets(record.bullets, block, issues)
        if (bullets !== undefined) {
          const lineCount = bullets.reduce(
            (sum, item) => sum + wrapText(item, metrics.contentWidth - BULLET_INDENT, approxMeasure(BODY_FONT_SIZE)).length,
            0,
          )
          const effective = lineCount + Math.max(0, bullets.length - 1) * (BULLET_GAP / BODY_LINE_HEIGHT)
          if (effective > metrics.bodyLinesPerPage) {
            issues.push({
              code: 'block-too-tall',
              severity: 'error',
              block,
              field: 'bullets',
              message: `该列表约 ${Math.ceil(effective)} 行，超过单页可容纳的 ${metrics.bodyLinesPerPage} 行。`,
              fix: '拆成多个 bullets 块，或改用段落并精简。',
            })
          }
          blocks.push({ bullets })
        }
        break
      }
      case 'table': {
        const table = parseTable(record.table, block, issues)
        if (table !== undefined) {
          const layout = layoutTable(table, {
            availableWidth: metrics.contentWidth,
            measure: approxMeasure(BODY_FONT_SIZE),
            headerMeasure: approxMeasure(BODY_FONT_SIZE + TABLE_HEADER_FONT_DELTA),
          })
          if (layout.totalHeight > metrics.contentHeight) {
            issues.push({
              code: 'table-too-tall',
              severity: 'error',
              block,
              field: 'table.rows',
              message: `表格展开后高约 ${Math.round(layout.totalHeight)} pt，超过单页可用的 ${Math.round(metrics.contentHeight)} pt。`,
              fix: '拆成多张表（每张放在独立的块里），或减少列宽占用较大的列。',
            })
          }
          checkTablePresentation(table, block, title ?? '', issues)
          blocks.push({ table })
        }
        break
      }
      case 'pageBreak': {
        if (record.pageBreak !== true) {
          issues.push({
            code: 'invalid-page-break',
            severity: 'error',
            block,
            field: 'pageBreak',
            message: 'pageBreak 的值只能是 true。',
            fix: '写成 { "pageBreak": true }，或删除该块。',
          })
          break
        }
        blocks.push({ pageBreak: true })
        break
      }
      default:
        break
    }
  }

  return {
    project: {
      title: title ?? '',
      ...(author === undefined ? {} : { author }),
      size,
      ...(style === undefined ? {} : { style }),
      blocks,
    },
    issues,
  }
}

/** Heading level: an integer 1–3, reported with its own field path. */
function parseHeading(value: unknown, block: number, issues: PdfIssue[]): 1 | 2 | 3 | undefined {
  const container = asRecord(value)
  if (container === undefined) {
    issues.push({
      code: 'invalid-heading',
      severity: 'error',
      block,
      field: 'heading',
      message: 'heading 必须是对象 { level, text }。',
      fix: '写成 { "heading": { "level": 2, "text": "小节标题" } }。',
    })
    return undefined
  }
  for (const field of unknownFields(container, BLOCK_FIELDS.heading)) {
    issues.push({
      code: 'unknown-field',
      severity: 'error',
      block,
      field: `heading.${field}`,
      message: `heading 内存在未知字段 ${field}。`,
      fix: `删除 heading.${field}；heading 只允许 level、text。`,
    })
  }
  const level = container.level
  if (typeof level !== 'number' || !Number.isInteger(level) || !HEADING_LEVELS.has(level)) {
    issues.push({
      code: 'invalid-heading-level',
      severity: 'error',
      block,
      field: 'heading.level',
      message: 'heading.level 必须是 1、2 或 3。',
      fix: '把 level 改为 1（章）、2（节）或 3（小节）。',
    })
    return undefined
  }
  return level as 1 | 2 | 3
}

/** Non-empty text field with its own length bound. */
function parseBlockText(
  value: unknown,
  block: number,
  fieldPath: string,
  maxChars: number,
  issues: PdfIssue[],
): string | undefined {
  const container = asRecord(value)
  if (container === undefined) {
    issues.push({
      code: 'invalid-block',
      severity: 'error',
      block,
      field: fieldPath,
      message: `${fieldPath} 所属的内容必须是对象。`,
      fix: '按格式写成 { "<内容键>": { ... } } 的对象。',
    })
    return undefined
  }
  const text = asText(container.text)
  if (text === undefined) {
    issues.push({
      code: 'invalid-text',
      severity: 'error',
      block,
      field: fieldPath,
      message: `${fieldPath} 必须是非空字符串。`,
      fix: '填入实际内容；空块请直接删除。',
    })
    return undefined
  }
  if (text.length > maxChars) {
    issues.push({
      code: 'text-too-long',
      severity: 'error',
      block,
      field: fieldPath,
      message: `${fieldPath} 超过 ${maxChars} 字上限（当前 ${text.length} 字）。`,
      fix: '拆成多个块，或精简这段文字。',
    })
    return undefined
  }
  return text
}

/** Bullet list: a bounded, non-empty array of non-empty strings. */
function parseBullets(value: unknown, block: number, issues: PdfIssue[]): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({
      code: 'invalid-bullets',
      severity: 'error',
      block,
      field: 'bullets',
      message: 'bullets 必须是字符串数组。',
      fix: '写成 [ "第一条", "第二条" ]。',
    })
    return undefined
  }
  if (value.length === 0) {
    issues.push({
      code: 'empty-bullets',
      severity: 'error',
      block,
      field: 'bullets',
      message: 'bullets 为空数组：列表至少需要一条。',
      fix: '写入至少一条，或把该块改成 paragraph。',
    })
    return undefined
  }
  if (value.length > MAX_BULLETS) {
    issues.push({
      code: 'too-many-bullets',
      severity: 'error',
      block,
      field: 'bullets',
      message: `bullets 条目 ${value.length} 条超过上限 ${MAX_BULLETS}。`,
      fix: '拆成多个列表块。',
    })
    return undefined
  }
  const items: string[] = []
  let valid = true
  for (const [position, item] of value.entries()) {
    const text = asText(item)
    if (text === undefined) {
      issues.push({
        code: 'invalid-bullet',
        severity: 'error',
        block,
        field: `bullets[${position}]`,
        message: `bullets[${position}] 必须是非空字符串。`,
        fix: '删除空条目或补齐文字。',
      })
      valid = false
      continue
    }
    if (text.length > MAX_BULLET_CHARS) {
      issues.push({
        code: 'text-too-long',
        severity: 'error',
        block,
        field: `bullets[${position}]`,
        message: `bullets[${position}] 超过 ${MAX_BULLET_CHARS} 字上限（当前 ${text.length} 字）。`,
        fix: '把长句改成短句，或改用段落块。',
      })
      valid = false
      continue
    }
    items.push(text)
  }
  return valid ? items : undefined
}

/** Table: a header row plus rows that all match its column count. */
function parseTable(value: unknown, block: number, issues: PdfIssue[]): PdfTable | undefined {
  const container = asRecord(value)
  if (container === undefined) {
    issues.push({
      code: 'invalid-table',
      severity: 'error',
      block,
      field: 'table',
      message: 'table 必须是对象 { headers, rows }。',
      fix: '写成 { "table": { "headers": ["列1"], "rows": [["值"]] } }。',
    })
    return undefined
  }
  for (const field of unknownFields(container, BLOCK_FIELDS.table)) {
    issues.push({
      code: 'unknown-field',
      severity: 'error',
      block,
      field: `table.${field}`,
      message: `table 内存在未知字段 ${field}。`,
      fix: `删除 table.${field}；table 只允许 headers、rows。`,
    })
  }
  let valid = true
  const headers: string[] = []
  if (!Array.isArray(container.headers)) {
    issues.push({
      code: 'invalid-table-headers',
      severity: 'error',
      block,
      field: 'table.headers',
      message: 'table.headers 必须是字符串数组。',
      fix: '给表格写上表头，例如 ["指标", "本期"]。',
    })
    valid = false
  } else if (container.headers.length === 0) {
    issues.push({
      code: 'empty-table-headers',
      severity: 'error',
      block,
      field: 'table.headers',
      message: 'table.headers 为空：表格必须有表头。',
      fix: '写入至少一列表头。',
    })
    valid = false
  } else if (container.headers.length > MAX_TABLE_COLUMNS) {
    issues.push({
      code: 'too-many-columns',
      severity: 'error',
      block,
      field: 'table.headers',
      message: `表格列数 ${container.headers.length} 超过上限 ${MAX_TABLE_COLUMNS}。`,
      fix: '合并列或拆成多张表。',
    })
    valid = false
  } else {
    for (const [position, header] of container.headers.entries()) {
      const text = asText(header)
      if (text === undefined) {
        issues.push({
          code: 'invalid-table-header',
          severity: 'error',
          block,
          field: `table.headers[${position}]`,
          message: `table.headers[${position}] 必须是非空字符串。`,
          fix: '补齐表头文字；确实为空时写 "-"。',
        })
        valid = false
        continue
      }
      headers.push(text)
    }
  }

  const rows: string[][] = []
  if (!Array.isArray(container.rows)) {
    issues.push({
      code: 'invalid-table-rows',
      severity: 'error',
      block,
      field: 'table.rows',
      message: 'table.rows 必须是二维字符串数组。',
      fix: '写成 [ ["值1", "值2"] ]。',
    })
    return undefined
  }
  if (container.rows.length === 0) {
    issues.push({
      code: 'empty-table-rows',
      severity: 'warning',
      block,
      field: 'table.rows',
      message: '表格只有表头，没有数据行。',
      fix: '补上数据行，或改用 paragraph 说明。',
    })
  }
  if (container.rows.length > MAX_TABLE_ROWS) {
    issues.push({
      code: 'too-many-rows',
      severity: 'error',
      block,
      field: 'table.rows',
      message: `表格行数 ${container.rows.length} 超过上限 ${MAX_TABLE_ROWS}。`,
      fix: '拆成多张表，或改用段落。',
    })
    valid = false
  }
  for (const [rowIndex, row] of container.rows.entries()) {
    if (!Array.isArray(row)) {
      issues.push({
        code: 'invalid-table-row',
        severity: 'error',
        block,
        field: `table.rows[${rowIndex}]`,
        message: `table.rows[${rowIndex}] 必须是字符串数组。`,
        fix: '每行写成与表头等长的字符串数组。',
      })
      valid = false
      continue
    }
    if (headers.length > 0 && row.length !== headers.length) {
      issues.push({
        code: 'table-row-shape',
        severity: 'error',
        block,
        field: `table.rows[${rowIndex}]`,
        message: `第 ${rowIndex + 1} 行有 ${row.length} 个单元格，与表头的 ${headers.length} 列不一致。`,
        fix: `把该行补齐/删减为 ${headers.length} 个单元格。`,
      })
      valid = false
      continue
    }
    const cells: string[] = []
    let rowValid = true
    for (const [cellIndex, cell] of row.entries()) {
      const text = asText(cell)
      if (text === undefined) {
        issues.push({
          code: 'invalid-table-cell',
          severity: 'error',
          block,
          field: `table.rows[${rowIndex}][${cellIndex}]`,
          message: `单元格 table.rows[${rowIndex}][${cellIndex}] 必须是非空字符串。`,
          fix: '补齐文字；确实为空时写 "-"。',
        })
        rowValid = false
        continue
      }
      if (text.length > MAX_CELL_CHARS) {
        issues.push({
          code: 'cell-too-long',
          severity: 'error',
          block,
          field: `table.rows[${rowIndex}][${cellIndex}]`,
          message: `单元格超过 ${MAX_CELL_CHARS} 字上限（当前 ${text.length} 字）。`,
          fix: '把长句改成短语、拆行或改用段落块。',
        })
        rowValid = false
        continue
      }
      cells.push(text)
    }
    if (rowValid) rows.push(cells)
    else valid = false
  }

  return valid ? { headers, rows } : undefined
}

/** Unit vocabulary scanned in the document title and the table headers. */
const UNIT_WORD_PATTERN = /单位|万元|亿元|百万元|元|million|thousand|¥|￥/iu
/** A numeric column whose |value| median reaches this needs a declared unit. */
const MAJOR_VALUE_MEDIAN = 1e4

/** Middle value of an unsorted sample; 0 for an empty sample. */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * Presentation rules for one parsed table: decimal consistency, ratio columns
 * written as plain decimals and large numbers without a declared unit. All
 * three are warnings that locate the column by index and header and name the
 * fix; none of them blocks the render, they only tell the author how the table
 * will read once the column plans have been applied.
 */
function checkTablePresentation(table: PdfTable, block: number, title: string, issues: PdfIssue[]): void {
  const titleHasUnit = UNIT_WORD_PATTERN.test(title)
  const headersHaveUnit = table.headers.some(header => UNIT_WORD_PATTERN.test(header))
  for (let column = 0; column < table.headers.length; column += 1) {
    const header = table.headers[column] ?? ''
    const values = table.rows.map(row => row[column] ?? '').filter(value => value.trim() !== '')
    if (values.length === 0) continue
    const field = `table.columns[${column}]`
    const locate = `表格第 ${column + 1} 列（表头「${header}」）`
    const numeric = values
      .map(value => ({ value, number: parseNumber(value) }))
      .filter((entry): entry is { value: string, number: number } => entry.number !== undefined)

    // Decimal consistency is what makes a numeric column read as one column;
    // two precisions are worth a nudge, three or more are a real defect.
    if (numeric.length >= 2) {
      const distinct = [...new Set(numeric.map(entry => decimalPlacesOfText(entry.value)))].sort((left, right) => left - right)
      const widest = distinct[distinct.length - 1] ?? 0
      if (distinct.length > 2) {
        issues.push({
          code: 'decimal-mismatch',
          severity: 'error',
          block,
          field,
          message: `${locate}：同一列混用 ${distinct.length} 种小数位（${distinct.join('、')} 位），显示不齐。`,
          fix: `把该列数值统一到同一精度；渲染会按最大位数 ${widest} 位统一显示。`,
        })
      } else if (distinct.length === 2) {
        issues.push({
          code: 'decimal-mismatch',
          severity: 'warning',
          block,
          field,
          message: `${locate}：同一列混用 ${distinct.join('、')} 位小数，渲染会按最大位数（${widest} 位）统一显示。`,
          fix: `把该列补齐或统一为 ${widest} 位小数。`,
        })
      }
    }

    // A ratio column stored as a plain decimal is ambiguous to a reader (0.128
    // vs 128); the fix is to write it as a percentage, which is also how the
    // column plan would render it.
    if (isRatioColumn(header, values) && !values.some(value => value.includes('%'))) {
      issues.push({
        code: 'percent-column-format',
        severity: 'warning',
        block,
        field,
        message: `${locate}：列名像比率（率/占比/同比/环比 等）且数值都在 [-1.5, 1.5]，当前按小数书写。`,
        fix: '把该列数值写成百分比（如 12.8%），渲染会统一保留一位小数。',
      })
    }

    const magnitudes = numeric.map(entry => Math.abs(entry.number))
    if (magnitudes.length > 0 && medianOf(magnitudes) >= MAJOR_VALUE_MEDIAN && !titleHasUnit && !headersHaveUnit) {
      issues.push({
        code: 'missing-unit',
        severity: 'warning',
        block,
        field,
        message: `${locate}：数值量级较大（|值| 中位数 ${Math.round(medianOf(magnitudes))}），但标题与表头都没有单位。`,
        fix: '在表头写清单位（如「营收（万元）」），或在标题中说明量纲。',
      })
    }
  }
}

/** Count diagnostics by severity into the structural check result. */
export function checkPdfDocument(value: unknown): PdfCheckResult {
  const { project, issues } = loadPdfDocument(value)
  const errorCount = issues.filter(issue => issue.severity === 'error').length
  const warningCount = issues.length - errorCount
  return {
    status: errorCount > 0 ? 'fail' : warningCount > 0 ? 'warning' : 'pass',
    blockCount: project.blocks.length,
    estimatedPages: estimatePages(project),
    errorCount,
    warningCount,
    issues,
  }
}
