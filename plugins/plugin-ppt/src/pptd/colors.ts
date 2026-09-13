/**
 * PPTD color resolution: `$name` theme references resolve against the
 * manifest's `theme.colors` map with no silent fallback — an unresolvable
 * reference is a check error, never an invented color at render time.
 *
 * @module @dsh-app/plugin-ppt/pptd/colors
 */

import { asRecord } from './types.ts'

/** Deterministic series palette used when a chart series omits an explicit color. */
export const PPTD_CHART_SERIES_PALETTE: readonly string[] = [
  '#2563EB', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#06B6D4',
]

/** Lightness multipliers cycled to derive flat-chart series colors from one accent. */
const ACCENT_LIGHTNESS_FACTORS: readonly number[] = [1, 0.72, 1.28, 0.55, 0.86, 0.4]

function hexToHsl(hex: string): [number, number, number] {
  const digits = hex.replace('#', '')
  const red = Number.parseInt(digits.slice(0, 2), 16) / 255
  const green = Number.parseInt(digits.slice(2, 4), 16) / 255
  const blue = Number.parseInt(digits.slice(4, 6), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue: number
  if (max === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6
  else if (max === green) hue = ((blue - red) / delta + 2) / 6
  else hue = ((red - green) / delta + 4) / 6
  return [hue, saturation, lightness]
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const secondary = chroma * (1 - Math.abs((hue * 6) % 2 - 1))
  const base = lightness - chroma / 2
  const segment = Math.floor(((hue * 6) % 6 + 6) % 6)
  const [red, green, blue] = segment === 0 ? [chroma, secondary, 0]
    : segment === 1 ? [secondary, chroma, 0]
    : segment === 2 ? [0, chroma, secondary]
    : segment === 3 ? [0, secondary, chroma]
    : segment === 4 ? [secondary, 0, chroma]
    : [chroma, 0, secondary]
  const channel = (value: number): string => Math.round((value + base) * 255).toString(16).padStart(2, '0')
  return `#${channel(red)}${channel(green)}${channel(blue)}`.toUpperCase()
}

/**
 * Flat-chart series colors: `count` variants of one accent cycled through the
 * lightness ladder (first series keeps the accent itself), so multi-series
 * charts stay on the theme hue without a fixed palette.
 */
export function accentSeriesColors(accent: string, count: number): string[] {
  const [hue, saturation, lightness] = hexToHsl(accent)
  return Array.from({ length: Math.max(1, count) }, (_, index) => {
    const factor = ACCENT_LIGHTNESS_FACTORS[index % ACCENT_LIGHTNESS_FACTORS.length] ?? 1
    const derived = Math.max(0.08, Math.min(0.92, lightness * factor))
    return hslToHex(hue, saturation, derived)
  })
}

interface PptdLike {
  readonly theme: Record<string, unknown>
}

function themeColors(project: PptdLike): Record<string, unknown> {
  return asRecord(project.theme.colors) ?? {}
}

function isColor(value: string): boolean {
  return /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value)
}

/** Resolve a literal or theme-referenced color; undefined when unresolvable. */
export function resolvePptdColor(project: PptdLike, value: unknown): string | undefined {
  let current: unknown = value
  const colors = themeColors(project)
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'string' || !current.startsWith('$')) break
    current = colors[current.slice(1)]
  }
  return typeof current === 'string' && isColor(current) ? current : undefined
}

/**
 * Normalize chart-series colors from color scalars or solid paint objects.
 * Pie series may supply an array; anything else unresolved voids the set so
 * the checker can demand a fix.
 */
export function resolvePptdChartSeriesColors(project: PptdLike, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0) return undefined
  const resolved = values.map((item) => {
    const paint = asRecord(item)
    if (paint === undefined) return resolvePptdColor(project, item)
    if (paint.type !== 'solid') return undefined
    return resolvePptdColor(project, paint.color)
  })
  return resolved.every((item) => item !== undefined) ? resolved : undefined
}

/** Parse `#RRGGBB[AA]` into { color: RRGGBB, transparency } for pptxgenjs. */
export function colorOptions(resolved: string, opacity = 1): { color: string, transparency?: number } {
  const alpha = resolved.length === 9 ? Number.parseInt(resolved.slice(7, 9), 16) / 255 : 1
  const transparency = Math.round((1 - Math.max(0, Math.min(1, alpha * opacity))) * 100)
  return {
    color: resolved.slice(1, 7).toUpperCase(),
    ...(transparency === 0 ? {} : { transparency }),
  }
}

/** Near-black or near-white foreground that stays readable on the background. */
export function readableForeground(backgroundHex: string): string {
  const red = Number.parseInt(backgroundHex.slice(0, 2), 16) / 255
  const green = Number.parseInt(backgroundHex.slice(2, 4), 16) / 255
  const blue = Number.parseInt(backgroundHex.slice(4, 6), 16) / 255
  return red * 0.2126 + green * 0.7152 + blue * 0.0722 < 0.5 ? 'E2E8F0' : '1F2937'
}
