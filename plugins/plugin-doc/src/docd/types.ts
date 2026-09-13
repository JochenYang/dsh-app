/**
 * The DOC document AST and the closed field whitelists the parser, checker
 * and renderer agree on. A document project is one JSON file:
 *
 *   { title, author?, sections: Block[] }
 *
 * and every Block carries exactly one content key (`heading`, `paragraph`,
 * `bullets`, `table`, `image`). The parser reduces raw JSON to these
 * structures and the checker only accepts whitelisted fields, so an
 * authoring typo fails loudly with a block index instead of silently
 * dropping content from the .docx.
 *
 * @module @dsh-app/plugin-doc/docd/types
 */

/** One diagnostic with its block location and a concrete fix hint. */
export interface DocIssue {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  /** 1-based block index inside `sections`, omitted for document-level issues. */
  readonly block?: number
  /** Dotted field path inside the block (e.g. `heading.level`). */
  readonly field?: string
  /** Actionable repair instruction, in Chinese. */
  readonly fix?: string
}

export interface DocHeading {
  readonly level: 1 | 2 | 3
  readonly text: string
}

export interface DocParagraph {
  readonly text: string
  readonly bold?: boolean
  readonly italic?: boolean
}

export interface DocTable {
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

export interface DocImage {
  readonly path: string
}

/** One content block: exactly one of the five keys is present. */
export interface DocBlock {
  readonly heading?: DocHeading
  readonly paragraph?: DocParagraph
  readonly bullets?: readonly string[]
  readonly table?: DocTable
  readonly image?: DocImage
}

/** The normalized document project. */
export interface DocProject {
  readonly title: string
  /** Optional one-line subtitle below the title. */
  readonly subtitle?: string
  readonly author?: string
  /** Optional one-line date shown next to the author in the metadata line. */
  readonly date?: string
  readonly sections: readonly DocBlock[]
}

/** Structural result of the read-only check. */
export interface DocCheckResult {
  readonly status: 'pass' | 'warning' | 'fail'
  readonly blockCount: number
  readonly errorCount: number
  readonly warningCount: number
  readonly issues: readonly DocIssue[]
}

/** Top-level field whitelist. */
export const DOCUMENT_FIELDS: ReadonlySet<string> = new Set(['title', 'subtitle', 'author', 'date', 'sections'])

/** The content keys a block may use (exactly one per block). */
export const BLOCK_CONTENT_KEYS: readonly string[] = ['heading', 'paragraph', 'bullets', 'table', 'image']

/** Per-content closed field whitelists. */
export const BLOCK_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  heading: new Set(['level', 'text']),
  paragraph: new Set(['text', 'bold', 'italic']),
  bullets: new Set([]),
  table: new Set(['headers', 'rows']),
  image: new Set(['path']),
}

/** Heading levels the renderer maps to native Word Heading 1–3. */
export const HEADING_LEVELS: ReadonlySet<number> = new Set([1, 2, 3])

/** Image formats the renderer can embed (docx supports no webp). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp'])

/** Format limits the checker enforces. */
export const MAX_BLOCKS = 500
export const MAX_TITLE_CHARS = 200
export const MAX_SUBTITLE_CHARS = 120
export const MAX_AUTHOR_CHARS = 200
export const MAX_DATE_CHARS = 40
/** Absolute per-field ceiling; the authoring rule below is what really shapes headings. */
export const MAX_HEADING_CHARS = 300
/**
 * A heading is a short claim, not a paragraph: longer text stops reading as a
 * title and starts competing with the body it introduces.
 */
export const MAX_HEADING_SENTENCE_CHARS = 42
export const MAX_PARAGRAPH_CHARS = 5000
/** Soft ceiling: above this a paragraph should be split or turned into a list. */
export const MAX_PARAGRAPH_SENTENCE_CHARS = 600
export const MAX_BULLETS = 100
export const MAX_BULLET_CHARS = 500
/** Beyond this a table no longer fits a portrait A4 content column legibly. */
export const MAX_TABLE_HEADERS = 8
export const MAX_TABLE_ROWS = 200
/** Soft ceiling: longer tables should be split or moved to an appendix. */
export const MAX_TABLE_SOFT_ROWS = 60
export const MAX_CELL_CHARS = 300
export const MAX_IMAGE_PATH_CHARS = 400

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

/**
 * Code-point length: one CJK character or emoji counts as one, so the authoring
 * limits measure what a reader perceives rather than UTF-16 units.
 */
export function charCount(text: string): number {
  return [...text].length
}
