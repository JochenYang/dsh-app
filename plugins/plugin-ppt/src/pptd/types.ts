/**
 * Shared PPTD v2 AST types and the closed field whitelists every layer
 * (parser, checker, renderer) agrees on. A project is a `.pptd` manifest
 * plus `.page` files; the parser reduces them to these structures and the
 * checker/renderer only ever accept what the whitelists name, so unknown
 * authoring fields fail loudly at check time instead of silently degrading.
 *
 * @module @dsh-app/plugin-ppt/pptd/types
 */

/** One diagnostic with optional file/page/elementId location. */
export interface PptdIssue {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly file?: string
  readonly page?: number
  readonly elementId?: string
}

/** One image asset confined inside the project directory. */
export interface PptdAsset {
  readonly path: string
  readonly mediaType: string
  readonly bytes: Uint8Array
  readonly sha256: string
}

/** The in-memory source plane: raw manifest text plus page texts and assets. */
export interface PptdSource {
  readonly entryName: string
  readonly manifest: string
  readonly pages: ReadonlyMap<string, string>
  readonly assets: ReadonlyMap<string, PptdAsset>
  /** Loader-level issues (unreadable pages/assets) seeded into the parse. */
  readonly issues?: readonly PptdIssue[]
}

/** One parsed page. Elements stay as loose records until per-type code reads them. */
export interface PptdPage {
  readonly file: string
  readonly pageType?: string
  readonly templateReference?: {
    readonly sourceSlideNumber: number
    readonly rationale: string
    readonly contentRelationship?: string
  }
  readonly background?: Record<string, unknown>
  readonly notes: string
  readonly elements: readonly Record<string, unknown>[]
}

/** The parsed, renderer-independent project AST. */
export interface PptdProject {
  readonly source: PptdSource
  readonly title: string
  readonly width: number
  readonly height: number
  readonly template?: Record<string, unknown>
  readonly theme: Record<string, unknown>
  readonly pages: readonly PptdPage[]
  readonly parseIssues: readonly PptdIssue[]
}

/** Structural result of the read-only check. */
export interface PptdCheckResult {
  readonly status: 'pass' | 'warning' | 'fail'
  readonly digest: string
  readonly pageCount: number
  readonly nativeObjectCount: number
  readonly warningCount: number
  readonly errorCount: number
  readonly issues: readonly PptdIssue[]
  readonly compatibility: {
    native: number
    normalized: number
    vectorFallback: number
    rasterFallback: number
    unsupported: number
  }
}

/** Type guards used across parser, checker and renderer. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** A fixed-length numeric tuple, or undefined. */
export function asTuple(value: unknown, size: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== size) return undefined
  const values = value.map(asNumber)
  return values.every((item) => item !== undefined) ? values : undefined
}

/** Text style fields that only make sense inside `content` (misplacement signal). */
export const MISPLACED_TEXT_STYLE_FIELDS: ReadonlySet<string> = new Set([
  'fontFamily', 'fontSize', 'bold', 'italic', 'color', 'lineHeight', 'letterSpacing',
  'wrap', 'align', 'verticalAlign', 'textDirection', 'style',
])

export const MANIFEST_FIELDS: ReadonlySet<string> = new Set(['version', 'title', 'size', 'template', 'theme', 'pages'])
export const TEMPLATE_FIELDS: ReadonlySet<string> = new Set(['id', 'name', 'sourceFile', 'sourceSha256'])
export const PAGE_FIELDS: ReadonlySet<string> = new Set(['pageType', 'templateReference', 'background', 'notes', 'elements'])
export const TEMPLATE_REFERENCE_FIELDS: ReadonlySet<string> = new Set(['sourceSlideNumber', 'rationale', 'contentRelationship'])
export const TEMPLATE_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'statement', 'independent', 'comparison', 'process', 'timeline', 'overlap', 'data', 'generic',
])

const ELEMENT_BASE_FIELDS = ['elementId', 'elementType', 'bounds']

/** Closed per-elementType field whitelists. */
export const ELEMENT_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  text: new Set([...ELEMENT_BASE_FIELDS, 'rotation', 'opacity', 'flip', 'content']),
  shape: new Set([...ELEMENT_BASE_FIELDS, 'rotation', 'opacity', 'flip', 'shapeName', 'adjustments', 'viewBox', 'path', 'fill', 'border', 'shadow']),
  line: new Set([...ELEMENT_BASE_FIELDS, 'rotation', 'opacity', 'flip', 'viewBox', 'points', 'curve', 'arrow', 'border', 'shadow']),
  image: new Set([...ELEMENT_BASE_FIELDS, 'rotation', 'opacity', 'flip', 'src', 'cropShape', 'fit', 'crop', 'border', 'shadow']),
  icon: new Set([...ELEMENT_BASE_FIELDS, 'rotation', 'opacity', 'flip', 'iconName', 'color', 'fill', 'border', 'shadow']),
  table: new Set([...ELEMENT_BASE_FIELDS, 'columnWidths', 'rowHeights', 'rows', 'style', 'fill', 'shadow']),
  // `chart`/`labels`/`color` belong to the flat authoring form; the rest to the
  // data-grid form. A single element must use one form or the other (checker).
  chart: new Set([...ELEMENT_BASE_FIELDS, 'chart', 'labels', 'color', 'title', 'data', 'series', 'seriesDefaults', 'xAxis', 'yAxis', 'barWidth', 'barGap', 'categoryGap', 'spokeAxis', 'legend', 'dataLabels', 'fontFamily', 'fill', 'border', 'shadow']),
}

/** Chart kinds the flat authoring form accepts (`column` renders vertical). */
export const FLAT_CHART_KINDS: ReadonlySet<string> = new Set(['bar', 'column', 'line', 'area', 'pie'])
/** Flat-form chart limits the checker enforces. */
export const MAX_CHART_LABELS = 24
export const MAX_CHART_SERIES = 6
export const MAX_CHART_TITLE_CHARS = 60

/** The element types the renderer can place natively. */
export const ELEMENT_TYPES: ReadonlySet<string> = new Set(['text', 'shape', 'line', 'image', 'icon', 'table', 'chart'])

export const NATIVE_CHART_TYPES: ReadonlySet<string> = new Set(['bar', 'line', 'area', 'scatter', 'bubble', 'pie', 'radar'])
export const UNSUPPORTED_CHART_TYPES: ReadonlySet<string> = new Set(['candlestick', 'waterfall', 'heatmap', 'treemap', 'sunburst', 'sankey'])

/** Format limits the loader enforces (bytes / counts). */
export const MAX_MANIFEST_BYTES = 512 * 1024
export const MAX_PAGE_BYTES = 2 * 1024 * 1024
export const MAX_ASSET_BYTES = 32 * 1024 * 1024
export const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024
export const MAX_PAGES = 100
export const MAX_ELEMENTS_PER_PAGE = 2000

export const POINTS_PER_INCH = 72
