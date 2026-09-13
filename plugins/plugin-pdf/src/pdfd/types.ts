/**
 * The PDF document AST and the closed field whitelists the parser, checker and
 * renderer agree on. A PDF project is one JSON file:
 *
 *   { title, author?, size?: 'a4' | 'letter', blocks: Block[] }
 *
 * and every Block carries exactly one content key (`heading`, `paragraph`,
 * `bullets`, `table`, `pageBreak`). The parser reduces raw JSON to these
 * structures and the checker only accepts whitelisted fields, so an authoring
 * typo fails loudly with a block index instead of silently dropping content
 * from the rendered PDF.
 *
 * @module @dsh-app/plugin-pdf/pdfd/types
 */

/** One diagnostic with its block location and a concrete fix hint. */
export interface PdfIssue {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  /** 1-based block index inside `blocks`, omitted for document-level issues. */
  readonly block?: number
  /** Dotted field path inside the block (e.g. `heading.level`). */
  readonly field?: string
  /** Actionable repair instruction, in Chinese. */
  readonly fix?: string
}

export interface PdfHeading {
  readonly level: 1 | 2 | 3
  readonly text: string
}

export interface PdfParagraph {
  readonly text: string
}

export interface PdfTable {
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

/** One content block: exactly one of the five keys is present. */
export interface PdfBlock {
  readonly heading?: PdfHeading
  readonly paragraph?: PdfParagraph
  readonly bullets?: readonly string[]
  readonly table?: PdfTable
  /** A forced page break; its value is always `true`. */
  readonly pageBreak?: true
}

/** Paper sizes the renderer knows. */
export type PdfPaperSize = 'a4' | 'letter'

/** Table header treatments the renderer knows. */
export type PdfHeaderStyle = 'light' | 'dark'

/**
 * Optional presentation switches. Absent means the renderer's own default, so a
 * document that says nothing still gets the standard light printable header.
 */
export interface PdfStyle {
  /**
   * Table header band. Absent means `light` (`F1F5F9` fill, `0F172A` text),
   * matching the Word, PPT and Excel suites; `dark` draws the inverse band for
   * screen-first decks.
   */
  readonly header?: PdfHeaderStyle
}

/** The normalized PDF project. */
export interface PdfProject {
  readonly title: string
  readonly author?: string
  readonly size: PdfPaperSize
  readonly style?: PdfStyle
  readonly blocks: readonly PdfBlock[]
}

/** Structural result of the read-only check. */
export interface PdfCheckResult {
  readonly status: 'pass' | 'warning' | 'fail'
  readonly blockCount: number
  /** Estimated printed page count at the project's own metrics. */
  readonly estimatedPages: number
  readonly errorCount: number
  readonly warningCount: number
  readonly issues: readonly PdfIssue[]
}

/** Top-level field whitelist. */
export const DOCUMENT_FIELDS: ReadonlySet<string> = new Set(['title', 'author', 'size', 'style', 'blocks'])

/** Closed field whitelist of the optional `style` object. */
export const STYLE_FIELDS: ReadonlySet<string> = new Set(['header'])

/** The content keys a block may use (exactly one per block). */
export const BLOCK_CONTENT_KEYS: readonly string[] = ['heading', 'paragraph', 'bullets', 'table', 'pageBreak']

/** Per-content closed field whitelists. */
export const BLOCK_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  heading: new Set(['level', 'text']),
  paragraph: new Set(['text']),
  bullets: new Set([]),
  table: new Set(['headers', 'rows']),
  pageBreak: new Set([]),
}

/** Heading levels the renderer maps to the 20 / 16 / 13 pt steps. */
export const HEADING_LEVELS: ReadonlySet<number> = new Set([1, 2, 3])

/** Paper sizes accepted by the `size` field. */
export const PAPER_SIZES: ReadonlySet<string> = new Set(['a4', 'letter'])

/** Table header treatments accepted by `style.header`. */
export const HEADER_STYLES: ReadonlySet<string> = new Set(['light', 'dark'])

/** Format limits the checker enforces. */
export const MAX_BLOCKS = 500
export const MAX_TITLE_CHARS = 200
export const MAX_AUTHOR_CHARS = 200
export const MAX_HEADING_CHARS = 300
export const MAX_PARAGRAPH_CHARS = 5000
export const MAX_BULLETS = 100
export const MAX_BULLET_CHARS = 500
export const MAX_TABLE_COLUMNS = 12
export const MAX_TABLE_ROWS = 200
export const MAX_CELL_CHARS = 300

/** Type guards shared by the parser and the renderer. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** A non-empty, trimmed string, or undefined. */
export function asText(value: unknown): string | undefined {
  const text = asString(value)
  if (text === undefined || text.trim() === '') return undefined
  return text
}
