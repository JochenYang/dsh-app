/**
 * DOC checker: structure, closed-field validation and the measurable authoring
 * rules, all without external effects. A failed check is a normal authoring
 * result — the point is to hand the model every problem (document, 1-based
 * block index, field, actionable Chinese message with a fix hint) in one pass,
 * which is what makes the render gate trustworthy: an unknown field, a
 * malformed table or an over-long cell is refused before a .docx exists.
 *
 * The same parse feeds the renderer, so what the checker accepted is exactly
 * what gets rendered (`loadDocDocument` normalizes to the AST both share).
 *
 * @module @dsh-app/plugin-doc/docd/check
 */

import {
  asBoolean,
  asRecord,
  asText,
  BLOCK_CONTENT_KEYS,
  BLOCK_FIELDS,
  charCount,
  DOCUMENT_FIELDS,
  HEADING_LEVELS,
  IMAGE_EXTENSIONS,
  MAX_AUTHOR_CHARS,
  MAX_BLOCKS,
  MAX_BULLET_CHARS,
  MAX_BULLETS,
  MAX_CELL_CHARS,
  MAX_DATE_CHARS,
  MAX_HEADING_CHARS,
  MAX_HEADING_SENTENCE_CHARS,
  MAX_IMAGE_PATH_CHARS,
  MAX_PARAGRAPH_CHARS,
  MAX_PARAGRAPH_SENTENCE_CHARS,
  MAX_SUBTITLE_CHARS,
  MAX_TABLE_HEADERS,
  MAX_TABLE_ROWS,
  MAX_TABLE_SOFT_ROWS,
  MAX_TITLE_CHARS,
} from './types.ts'
import {
  decimalPlacesOf,
  isRatioHeader,
  MAJOR_VALUE_MEDIAN,
  medianOf,
  numericValueOf,
  percentValueOf,
  planColumnFormat,
  RATIO_VALUE_BOUND,
  UNIT_WORD_PATTERN,
} from './number-format.ts'
import type { DocBlock, DocCheckResult, DocImage, DocIssue, DocProject, DocTable } from './types.ts'

/** The normalized document plus every diagnostic found while building it. */
export interface ParsedDoc {
  readonly project: DocProject
  readonly issues: readonly DocIssue[]
}

/** The content key present in one block, or `undefined` when it is malformed. */
function contentKeysOf(block: Record<string, unknown>): string[] {
  return BLOCK_CONTENT_KEYS.filter(key => block[key] !== undefined)
}

/** Unknown own properties, in authoring order. */
function unknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(record).filter(key => !allowed.has(key))
}

/**
 * Parse and validate raw JSON into the shared DOC AST.
 *
 * Normalization is best-effort by design: invalid blocks are dropped from the
 * returned project, and the renderer is only ever reached with zero errors, so
 * a dropped block can never be silently missing from a delivered .docx.
 */
export function loadDocDocument(value: unknown): ParsedDoc {
  const issues: DocIssue[] = []
  const root = asRecord(value)
  if (root === undefined) {
    issues.push({
      code: 'invalid-document',
      severity: 'error',
      message: '文档根节点必须是一个 JSON 对象（{ title, author?, sections }）。',
      fix: '把顶层改成对象，包含 title 与 sections 两个字段。',
    })
    return { project: { title: '', sections: [] }, issues }
  }

  for (const field of unknownFields(root, DOCUMENT_FIELDS)) {
    issues.push({
      code: 'unknown-field',
      severity: 'error',
      field,
      message: `顶层存在未知字段 ${field}。`,
      fix: `删除 ${field}；顶层只允许 title、author、sections。`,
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

  const subtitle = parseOptionalMeta(root, 'subtitle', MAX_SUBTITLE_CHARS, issues)
  const author = parseOptionalMeta(root, 'author', MAX_AUTHOR_CHARS, issues)
  const date = parseOptionalMeta(root, 'date', MAX_DATE_CHARS, issues)

  // Document text a table's numbers may borrow their unit from: a unit stated
  // in the title or subtitle applies to every table in the report.
  const captionText = [title, subtitle].filter((part): part is string => part !== undefined).join(' ')

  if (!Array.isArray(root.sections)) {
    issues.push({
      code: 'invalid-sections',
      severity: 'error',
      field: 'sections',
      message: 'sections 必须是块数组。',
      fix: '把 sections 写成 [{ "heading": ... }, { "paragraph": ... }] 形式的数组。',
    })
    return { project: projectOf(title ?? '', [], { subtitle, author, date }), issues }
  }

  if (root.sections.length === 0) {
    issues.push({
      code: 'empty-document',
      severity: 'error',
      field: 'sections',
      message: 'sections 为空：文档至少需要一个内容块。',
      fix: '按提纲写入标题块与正文块后再导出。',
    })
  } else if (root.sections.length > MAX_BLOCKS) {
    issues.push({
      code: 'too-many-blocks',
      severity: 'error',
      field: 'sections',
      message: `块数 ${root.sections.length} 超过单文档上限 ${MAX_BLOCKS}。`,
      fix: '合并重复段落，或拆成多份文档。',
    })
  }

  // Normalized blocks keep their original 1-based index: the structural pass
  // below reports on the accepted blocks, and the model still needs to know
  // where they sit in the JSON it wrote.
  const entries: { readonly number: number, readonly block: DocBlock }[] = []
  let previousHeadingLevel: number | undefined
  for (const [index, raw] of root.sections.entries()) {
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
        const text = parseBlockText(record.heading, 'text', block, 'heading.text', MAX_HEADING_CHARS, issues)
        if (level !== undefined) {
          if (previousHeadingLevel !== undefined && level > previousHeadingLevel + 1) {
            issues.push({
              code: 'heading-level-jump',
              severity: 'error',
              block,
              field: 'heading.level',
              message: `标题层级从 H${previousHeadingLevel} 跳到 H${level}，Word 大纲会缺一层。`,
              fix: `把 level 改为 ${previousHeadingLevel + 1}，或在其间补一个 H${previousHeadingLevel + 1} 标题。`,
            })
          }
          previousHeadingLevel = level
        }
        if (level !== undefined && text !== undefined) entries.push({ number: block, block: { heading: { level, text } } })
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
              fix: `删除 paragraph.${field}；paragraph 只允许 text、bold、italic。`,
            })
          }
        }
        const text = parseBlockText(record.paragraph, 'text', block, 'paragraph.text', MAX_PARAGRAPH_CHARS, issues)
        const bold = parseOptionalBoolean(container, 'bold', block, issues)
        const italic = parseOptionalBoolean(container, 'italic', block, issues)
        if (text !== undefined) {
          entries.push({
            number: block,
            block: {
              paragraph: {
                text,
                ...(bold === undefined ? {} : { bold }),
                ...(italic === undefined ? {} : { italic }),
              },
            },
          })
        }
        break
      }
      case 'bullets': {
        const bullets = parseBullets(record.bullets, block, issues)
        if (bullets !== undefined) entries.push({ number: block, block: { bullets } })
        break
      }
      case 'table': {
        const table = parseTable(record.table, block, issues)
        if (table !== undefined) {
          entries.push({ number: block, block: { table } })
          checkTableQuality(table, block, captionText, issues)
        }
        break
      }
      case 'image': {
        const image = parseImage(record.image, block, issues)
        if (image !== undefined) entries.push({ number: block, block: { image } })
        break
      }
      default:
        break
    }
  }

  checkStructure(entries, issues)

  return {
    project: projectOf(title ?? '', entries.map(entry => entry.block), { subtitle, author, date }),
    issues,
  }
}

/** Assemble the normalized project, omitting absent optional metadata. */
function projectOf(
  title: string,
  sections: readonly DocBlock[],
  meta: { subtitle?: string, author?: string, date?: string },
): DocProject {
  return {
    title,
    ...(meta.subtitle === undefined ? {} : { subtitle: meta.subtitle }),
    ...(meta.author === undefined ? {} : { author: meta.author }),
    ...(meta.date === undefined ? {} : { date: meta.date }),
    sections,
  }
}

/** Optional top-level text field (subtitle/author/date) with its own bound. */
function parseOptionalMeta(
  root: Record<string, unknown>,
  field: string,
  maxChars: number,
  issues: DocIssue[],
): string | undefined {
  if (root[field] === undefined) return undefined
  const parsed = asText(root[field])
  if (parsed === undefined) {
    issues.push({
      code: `invalid-${field}`,
      severity: 'error',
      field,
      message: `${field} 必须是非空字符串（不需要时直接省略该字段）。`,
      fix: `删除 ${field} 或填入实际内容。`,
    })
    return undefined
  }
  if (charCount(parsed) > maxChars) {
    issues.push({
      code: `${field}-too-long`,
      severity: 'error',
      field,
      message: `${field} 超过 ${maxChars} 字上限（当前 ${charCount(parsed)} 字）。`,
      fix: '精简该字段，只保留必要信息。',
    })
    return undefined
  }
  return parsed
}

/**
 * Structural authoring rules that need the accepted blocks as a sequence: a
 * heading is a short label for the content right after it, not a paragraph and
 * not a lone outline node. Dropping straight from a chapter into a section is
 * normal Chinese structure, so entering a deeper heading only warns; a heading
 * that is followed by a same/higher heading or ends the document has nothing
 * at all and stays an error. These are the rules that keep the rendered .docx
 * from degrading into loose headings and a wall of text.
 */
function checkStructure(
  entries: readonly { readonly number: number, readonly block: DocBlock }[],
  issues: DocIssue[],
): void {
  for (const [index, entry] of entries.entries()) {
    const { block, number } = entry
    if (block.heading !== undefined) {
      const length = charCount(block.heading.text)
      if (length > MAX_HEADING_SENTENCE_CHARS) {
        issues.push({
          code: 'heading-too-long',
          severity: 'error',
          block: number,
          field: 'heading.text',
          message: `标题 ${length} 字，超过 ${MAX_HEADING_SENTENCE_CHARS} 字上限：标题不是句子。`,
          fix: '把标题提炼为核心论点（短句），细节移到正文承接。',
        })
      }
      if (block.heading.level <= 2) {
        const next = entries[index + 1]
        if (next === undefined) {
          issues.push({
            code: 'empty-section',
            severity: 'error',
            block: number,
            field: 'heading',
            message: `H${block.heading.level} 标题后没有正文内容：章节是空的。`,
            fix: `在该标题后补至少一个段落、列表、表格或图片块；确实无内容时删除这个标题。`,
          })
        } else if (next.block.heading !== undefined && next.block.heading.level > block.heading.level) {
          // H1 → H2/H3 is a chapter opening its first section; ask for a
          // transition paragraph without blocking the export.
          issues.push({
            code: 'empty-section',
            severity: 'warning',
            block: number,
            field: 'heading',
            message: `H${block.heading.level} 标题后直接进入下级 H${next.block.heading.level} 标题，缺少承接正文。`,
            fix: '在该标题与下级标题之间补一段过渡段落；确无内容时删除这个标题。',
          })
        } else if (next.block.heading !== undefined) {
          // Same or higher level: the chapter has no body and nothing below it
          // to carry the outline, which is the empty section this rule refuses.
          issues.push({
            code: 'empty-section',
            severity: 'error',
            block: number,
            field: 'heading',
            message: `H${block.heading.level} 标题后紧跟 H${next.block.heading.level} 标题，章节没有任何内容。`,
            fix: `在该标题后补至少一个段落、列表、表格或图片块；确实无内容时删除这个标题。`,
          })
        }
      }
    }
    if (block.paragraph !== undefined) {
      const length = charCount(block.paragraph.text)
      if (length > MAX_PARAGRAPH_SENTENCE_CHARS) {
        issues.push({
          code: 'paragraph-too-long',
          severity: 'warning',
          block: number,
          field: 'paragraph.text',
          message: `段落 ${length} 字，超过建议的 ${MAX_PARAGRAPH_SENTENCE_CHARS} 字：长段影响阅读。`,
          fix: '按语义拆成多个段落，或把并列要点改写为 bullets。',
        })
      }
    }
    if (block.table !== undefined && block.table.rows.length > MAX_TABLE_SOFT_ROWS) {
      issues.push({
        code: 'table-too-long',
        severity: 'warning',
        block: number,
        field: 'table.rows',
        message: `表格 ${block.table.rows.length} 行，超过建议的 ${MAX_TABLE_SOFT_ROWS} 行。`,
        fix: '拆成多张表，或把明细移到附录。',
      })
    }
  }
}

/** Heading level: an integer 1–3, reported with its own field path. */
function parseHeading(value: unknown, block: number, issues: DocIssue[]): 1 | 2 | 3 | undefined {
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
  field: string,
  block: number,
  fieldPath: string,
  maxChars: number,
  issues: DocIssue[],
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
  const text = asText(container[field])
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
      fix: '拆成多个段落块，或精简这段文字。',
    })
    return undefined
  }
  return text
}

/** Optional boolean flag that must be a real boolean when present. */
function parseOptionalBoolean(
  container: Record<string, unknown> | undefined,
  field: string,
  block: number,
  issues: DocIssue[],
): boolean | undefined {
  if (container === undefined || container[field] === undefined) return undefined
  const parsed = asBoolean(container[field])
  if (parsed === undefined) {
    issues.push({
      code: 'invalid-flag',
      severity: 'error',
      block,
      field: `paragraph.${field}`,
      message: `paragraph.${field} 必须是 true 或 false。`,
      fix: '删除该字段或写成布尔值。',
    })
  }
  return parsed
}

/** Bullet list: a bounded, non-empty array of non-empty strings. */
function parseBullets(value: unknown, block: number, issues: DocIssue[]): string[] | undefined {
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
function parseTable(value: unknown, block: number, issues: DocIssue[]): DocTable | undefined {
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
  } else if (container.headers.length > MAX_TABLE_HEADERS) {
    issues.push({
      code: 'too-many-columns',
      severity: 'error',
      block,
      field: 'table.headers',
      message: `表格列数 ${container.headers.length} 超过上限 ${MAX_TABLE_HEADERS}。`,
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
          fix: '补齐表头文字。',
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
  // The soft row limit is reported once, by checkStructure; repeating it here
  // would put two identical `table-too-long` warnings on the same table.
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

/**
 * Presentation rules for one accepted table, reported per column with the
 * column's header as the location. They are signals about how the table reads,
 * not structural faults: decimal drift, a ratio written as a bare fraction, and
 * large values whose unit is stated nowhere. The renderer infers formats with
 * the same helpers, so a warning here is exactly the shape the .docx will take.
 */
function checkTableQuality(
  table: DocTable,
  block: number,
  captionText: string,
  issues: DocIssue[],
): void {
  for (let index = 0; index < table.headers.length; index += 1) {
    const header = table.headers[index] ?? ''
    const cells = table.rows.map(row => row[index] ?? '').filter(cell => cell.trim() !== '')
    if (cells.length === 0) continue
    const numbers = cells.map(numericValueOf).filter((value): value is number => value !== undefined)
    const plan = planColumnFormat(cells, header)
    const field = `table.headers[${index}]`
    const locate = `第 ${index + 1} 列「${header}」`

    // A column that mixes 0, 1 and 2 decimal places reads as unaligned. The
    // message names the precision the renderer actually resolves, so it can
    // never promise a display the .docx will not have.
    if (numbers.length >= 2) {
      const distinct = [...new Set(numbers.map(decimalPlacesOf))].sort((left, right) => left - right)
      const renderedAs = plan.kind === 'number'
        ? `渲染会按 ${plan.decimals} 位小数统一显示。`
        : plan.kind === 'percent'
          ? '该列会按百分比（一位小数）显示。'
          : '该列不是纯数字列，渲染会保留原样。'
      if (distinct.length > 2) {
        issues.push({
          code: 'decimal-mismatch',
          severity: 'error',
          block,
          field,
          message: `${locate}混用 ${distinct.length} 种小数位（${distinct.join('、')} 位），同一列显示不齐；${renderedAs}`,
          fix: '把该列数值统一为相同小数位（例如全部保留 2 位），或改写为文本说明。',
        })
      } else if (distinct.length === 2) {
        issues.push({
          code: 'decimal-mismatch',
          severity: 'warning',
          block,
          field,
          message: `${locate}混用 ${distinct.join('、')} 位小数；${renderedAs}`,
          fix: '如需不同精度，请把该列数值统一为相同小数位。',
        })
      }
    }

    // A ratio column stored as a bare fraction is ambiguous to a reader: 0.128
    // and 128 are one glance apart. Percent text already carries its unit, so a
    // column already written as "12.8%" is left alone.
    if (numbers.length > 0 && isRatioHeader(header)
      && numbers.every(value => Math.abs(value) <= RATIO_VALUE_BOUND)
      && numbers.some(value => value !== 0)
      && !cells.some(cell => percentValueOf(cell) !== undefined)) {
      issues.push({
        code: 'percent-column-format',
        severity: 'warning',
        block,
        field,
        message: `${locate}的列名是比率，但数值按小数书写（如 ${numbers[0]}），读者无法分辨 12.8% 与 0.128。`,
        fix: '把该列写成百分比文本（如 12.8%），保持一位小数。',
      })
    }

    // Large magnitudes need a unit somewhere: the column header or the
    // document title/subtitle. The checker only warns; it never adds one.
    if (numbers.length > 0 && !UNIT_WORD_PATTERN.test(captionText) && !UNIT_WORD_PATTERN.test(header)) {
      const median = medianOf(numbers.map(value => Math.abs(value)))
      if (median >= MAJOR_VALUE_MEDIAN) {
        issues.push({
          code: 'missing-unit',
          severity: 'warning',
          block,
          field,
          message: `${locate}数值量级较大（|值| 中位数 ${Math.round(median)}），但列名与文档标题都没有单位。`,
          fix: '在列名或标题中写清单位（例如「营收（万元）」）。',
        })
      }
    }
  }
}

/** Image: a workspace-relative path with an embeddable extension. */
function parseImage(value: unknown, block: number, issues: DocIssue[]): DocImage | undefined {
  const container = asRecord(value)
  if (container === undefined) {
    issues.push({
      code: 'invalid-image',
      severity: 'error',
      block,
      field: 'image',
      message: 'image 必须是对象 { path }。',
      fix: '写成 { "image": { "path": "assets/logo.png" } }。',
    })
    return undefined
  }
  for (const field of unknownFields(container, BLOCK_FIELDS.image)) {
    issues.push({
      code: 'unknown-field',
      severity: 'error',
      block,
      field: `image.${field}`,
      message: `image 内存在未知字段 ${field}。`,
      fix: `删除 image.${field}；image 只允许 path。`,
    })
  }
  const raw = asText(container.path)
  if (raw === undefined) {
    issues.push({
      code: 'invalid-image-path',
      severity: 'error',
      block,
      field: 'image.path',
      message: 'image.path 必须是非空字符串。',
      fix: '填入工作区内的图片相对路径。',
    })
    return undefined
  }
  if (raw.length > MAX_IMAGE_PATH_CHARS) {
    issues.push({
      code: 'invalid-image-path',
      severity: 'error',
      block,
      field: 'image.path',
      message: `image.path 超过 ${MAX_IMAGE_PATH_CHARS} 字符上限。`,
      fix: '简化文件名与目录层级。',
    })
    return undefined
  }
  if (raw.includes('\\') || /^([a-zA-Z]:|\/)/u.test(raw) || raw.split('/').includes('..')) {
    issues.push({
      code: 'invalid-image-path',
      severity: 'error',
      block,
      field: 'image.path',
      message: `image.path 必须是工作区内相对路径（收到 ${raw}）。`,
      fix: '使用正斜杠相对路径，例如 assets/figure.png，不要用绝对路径或 ..。',
    })
    return undefined
  }
  const extension = raw.slice(raw.lastIndexOf('.')).toLowerCase()
  if (raw.lastIndexOf('.') <= raw.lastIndexOf('/') || !IMAGE_EXTENSIONS.has(extension)) {
    issues.push({
      code: 'invalid-image-path',
      severity: 'error',
      block,
      field: 'image.path',
      message: `image.path 的扩展名不受支持（${raw}）。`,
      fix: `只支持 ${[...IMAGE_EXTENSIONS].join('、')}。`,
    })
    return undefined
  }
  return { path: raw }
}

/** Count diagnostics by severity into the structural check result. */
export function checkDocDocument(value: unknown): DocCheckResult {
  const { project, issues } = loadDocDocument(value)
  const errorCount = issues.filter(issue => issue.severity === 'error').length
  const warningCount = issues.length - errorCount
  return {
    status: errorCount > 0 ? 'fail' : warningCount > 0 ? 'warning' : 'pass',
    blockCount: project.sections.length,
    errorCount,
    warningCount,
    issues,
  }
}
