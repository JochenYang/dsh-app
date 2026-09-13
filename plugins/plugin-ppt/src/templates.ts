/**
 * The built-in template catalog: a read-only view over the bundled
 * `templates/` asset directory (see templates/README.md). Each category
 * bundles a base layout plus its colorway variants, and every template
 * exposes its design document, per-page structure index (zones carry the
 * `textCapacity` budget) and the Chinese PPTD layout sources. Zone coordinates
 * live in the 1280x720 reference-pixel space and are converted to the 960x540
 * point canvas on the way out.
 *
 * @module @dsh-app/plugin-ppt/templates
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { recommendedTextCapacity } from './text-layout.ts'

/** Where the bundled asset directory sits relative to the built module. */
const TEMPLATES_URL = new URL('../templates/', import.meta.url)

export const TEMPLATE_CATEGORIES = ['academic', 'business', 'consulting', 'editorial', 'promotion', 'work'] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

/** Reference canvas the zone coordinates are measured against. */
const SOURCE_CANVAS = { width: 1280, height: 720 }
/** The PPTD point canvas zones convert into. */
export const PPTD_CANVAS = { width: 960, height: 540 }

/** One template font table (per-language title/body + per-OS fallbacks). */
export interface TemplateFonts {
  readonly zh: { readonly title: string, readonly body: string }
  readonly en: { readonly title: string, readonly body: string }
  readonly fallbacks: unknown
}

/** One structural zone of a template page (source-pixel coordinates). */
export interface TemplateZone {
  readonly kind: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly shape?: string
  readonly fill?: string
  readonly textRole?: string
  readonly fontSize?: number
  readonly textCapacity?: number
  readonly [key: string]: unknown
}

/** One template page in the structure index. */
export interface TemplatePageMeta {
  readonly slideNumber: number
  readonly sourceTitle: string
  readonly family: string
  readonly density: string
  readonly relationship?: string
  readonly structureSummary: string
  readonly zones: readonly TemplateZone[]
}

export interface TemplateMetadata {
  readonly id: string
  readonly category: TemplateCategory
  readonly name: string
  readonly nameEn: string
  readonly description: string
  readonly fonts: TemplateFonts
  readonly palette: {
    readonly background: string
    readonly text: string
    readonly accent: string
    readonly surface: string
    readonly secondary: string
  }
  readonly width: number
  readonly height: number
  readonly designSummary: string
  readonly visualGrammar: string
  readonly recommendedDensity: string
  readonly layoutFamilies: readonly string[]
  readonly pages: readonly TemplatePageMeta[]
}

/** A template plus the absolute paths of its bundled assets. */
export interface TemplateEntry {
  readonly meta: TemplateMetadata
  readonly dir: string
}

function templatesRoot(): string {
  return fileURLToPath(TEMPLATES_URL)
}

/** Convert one source-pixel length to the PPTD point canvas. */
export function toPointLength(value: number, axis: 'x' | 'y'): number {
  const source = axis === 'x' ? SOURCE_CANVAS.width : SOURCE_CANVAS.height
  const target = axis === 'x' ? PPTD_CANVAS.width : PPTD_CANVAS.height
  return Number((value / source * target).toFixed(3))
}

/** Zone in PPTD point space, with a computed capacity when metadata omits it. */
export function pptdZone(zone: TemplateZone): Record<string, unknown> {
  const extra: Record<string, unknown> = { ...zone }
  delete extra.kind
  delete extra.x
  delete extra.y
  delete extra.width
  delete extra.height
  const fontSize = typeof zone.fontSize === 'number' && zone.fontSize > 0 ? zone.fontSize : 18
  const capacity = typeof zone.textCapacity === 'number' && Number.isFinite(zone.textCapacity)
    ? zone.textCapacity
    : recommendedTextCapacity(toPointLength(zone.width, 'x'), toPointLength(zone.height, 'y'), fontSize)
  return {
    kind: zone.kind,
    x: toPointLength(zone.x, 'x'),
    y: toPointLength(zone.y, 'y'),
    width: toPointLength(zone.width, 'x'),
    height: toPointLength(zone.height, 'y'),
    ...extra,
    textCapacity: capacity,
  }
}

let cache: readonly TemplateEntry[] | undefined

async function readMetadata(dir: string): Promise<TemplateMetadata | undefined> {
  try {
    const raw = await readFile(join(dir, 'metadata.json'), 'utf8')
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const meta = value as TemplateMetadata
    if (typeof meta.id !== 'string' || typeof meta.category !== 'string') return undefined
    if (!Array.isArray(meta.pages)) return undefined
    return meta
  } catch {
    return undefined
  }
}

async function scanTemplates(): Promise<readonly TemplateEntry[]> {
  const root = templatesRoot()
  const entries: TemplateEntry[] = []
  let categories: string[]
  try {
    categories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && (TEMPLATE_CATEGORIES as readonly string[]).includes(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  for (const category of categories) {
    let names: string[]
    try {
      names = (await readdir(join(root, category), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch {
      continue
    }
    for (const name of names) {
      const dir = join(root, category, name)
      const meta = await readMetadata(dir)
      if (meta === undefined) continue
      // A template without its preview images or layout sources is unusable.
      try {
        await stat(join(dir, 'pages', '01.jpg'))
        await stat(join(dir, 'source-zh', 'deck.pptd'))
      } catch {
        continue
      }
      entries.push({ meta, dir })
    }
  }
  return entries
}

/** Every bundled template, scanned once per process. */
export async function allTemplates(): Promise<readonly TemplateEntry[]> {
  if (cache === undefined) cache = await scanTemplates()
  return cache
}

export async function templateById(id: string): Promise<TemplateEntry | undefined> {
  return (await allTemplates()).find((entry) => entry.meta.id === id)
}

/** The design document text returned by ppt_get_template_reference. */
export async function templateDesignDocument(entry: TemplateEntry): Promise<string | undefined> {
  try {
    return await readFile(join(entry.dir, 'design.md'), 'utf8')
  } catch {
    return undefined
  }
}

/** Cover preview (pages/01.jpg) bytes for the template-picker UI. */
export async function templateCoverBytes(entry: TemplateEntry): Promise<Buffer | undefined> {
  try {
    return await readFile(join(entry.dir, 'pages', '01.jpg'))
  } catch {
    return undefined
  }
}

/** The Chinese PPTD layout source files of one template page, if present. */
export function templatePageSourcePath(entry: TemplateEntry, slideNumber: number): string {
  return join(entry.dir, 'source-zh', 'pages', `${String(slideNumber).padStart(2, '0')}.page`)
}

/** Default template when the mode store has no valid selection. */
export const DEFAULT_TEMPLATE_ID = 'dsh-blue-professional'

/**
 * The minimal table spec every fallback theme carries, so a table is never
 * rendered as an invisible grid: a bold tinted header over a medium rule,
 * hairline horizontal separators on data rows, and a total row that is
 * keyword-gated (`tableCellStyle` checks the first cell) rather than assumed
 * from position. Vertical rules are deliberately absent — they add noise
 * without separating anything a row band already separates. A template or
 * document that authored its own `theme.tableStyles` keeps it; this default
 * only fills the gap.
 */
export const MINIMAL_TABLE_STYLES: Record<string, unknown> = {
  rowOverColumn: true,
  cellStyle: { border: [null, null, { color: '#E2E8F0', width: 1 }, null] },
  firstRowStyle: { bold: true, fill: '#F1F5F9', border: [null, null, { color: '#334155', width: 2 }, null] },
  totalRowStyle: { bold: true, fill: '#EEF2FF', border: [{ color: '#334155', width: 2 }, null, null, null] },
}

/**
 * The "paper" default theme for sessions without a template choice: a natural
 * PPT request still produces a styled deck (warm paper ground, high-contrast
 * ink text, one blue accent) even though no template steers it. The prompt
 * names it and the render tool falls back to it; a session's explicit
 * template choice always wins over it.
 */
export const PAPER_THEME: Record<string, unknown> = {
  colors: {
    background: '#FDFAE7',
    text: '#111111',
    accent: '#1E2BFA',
    surface: '#E9E8E0',
    secondary: '#6B6B6B',
  },
  textStyles: {
    title: { fontFamily: { latin: 'Arial', ea: 'Microsoft YaHei' }, fontSize: 28, bold: true, color: '$text' },
    body: { fontFamily: { latin: 'Arial', ea: 'Microsoft YaHei' }, fontSize: 18, color: '$text' },
  },
  tableStyles: { default: MINIMAL_TABLE_STYLES },
}

/**
 * Synthesize a PPTD `theme` map from a template's palette and fonts. This is
 * the render-time fallback for documents that never wrote a theme: the
 * session's chosen template must still steer the output (default page
 * background, default text color, theme fonts), so its palette lands in the
 * project AST under the same key names an authored theme uses.
 */
export function templatePptdTheme(meta: TemplateMetadata): Record<string, unknown> {
  const hex = (value: unknown): string | undefined =>
    typeof value === 'string' && /^[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value) ? `#${value.toLowerCase()}` : undefined
  const colors = Object.fromEntries(
    Object.entries({ background: meta.palette.background, text: meta.palette.text, accent: meta.palette.accent, surface: meta.palette.surface, secondary: meta.palette.secondary })
      .map(([key, value]) => [key, hex(value)])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  const family = (face: string | undefined, eaFace: string | undefined): Record<string, string> | undefined => {
    if (typeof face !== 'string' || face === '') return undefined
    const ea = typeof eaFace === 'string' && eaFace !== '' ? eaFace : face
    return { latin: face, ea }
  }
  const titleFamily = family(meta.fonts.en?.title, meta.fonts.zh?.title)
  const bodyFamily = family(meta.fonts.en?.body, meta.fonts.zh?.body)
  return {
    colors,
    textStyles: {
      ...(titleFamily === undefined ? {} : { title: { fontFamily: titleFamily, fontSize: 28, bold: true, color: '$text' } }),
      ...(bodyFamily === undefined ? {} : { body: { fontFamily: bodyFamily, fontSize: 18, color: '$text' } }),
    },
    // The synthesized template theme owns the same minimal table spec as the
    // paper default, so the chosen template colors tables even when its
    // metadata never described one.
    tableStyles: { default: MINIMAL_TABLE_STYLES },
  }
}
