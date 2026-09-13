/**
 * Deterministic text-box capacity estimates shared by the template references
 * and the PPTD checker: given a text run and its box in PowerPoint points,
 * estimate how many lines the text needs and whether it overflows the box.
 * The checker turns an overflow into a `text-overflow` issue BEFORE rendering,
 * which is what keeps multi-line copy from stacking or spilling in the deck.
 *
 * @module @dsh-app/plugin-ppt/text-layout
 */

/** Usable fraction of the box width (text boxes have inner padding). */
const WIDTH_RESERVE = 0.95
/** Default line-height multiplier when the content omits one. */
export const DEFAULT_LINE_HEIGHT = 1.15

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Per-character advance width as a fraction of the font size. Deliberately
 * coarse (CJK ≈ 1em, narrow Latin ≈ 0.3em) — the goal is a stable upper
 * estimate, not font metrics.
 */
function glyphWidth(character: string): number {
  if (/\p{Mark}/u.test(character)) return 0
  if (/\s/u.test(character)) return 0.33
  if (/^[ilI1|.,'`:;!]$/u.test(character)) return 0.3
  if (/^[mwMW@%&]$/u.test(character)) return 0.82
  if (/^[A-Z]$/u.test(character)) return 0.68
  if (/^[\u0000-\u00ff]$/u.test(character)) return 0.56
  return 1
}

function lineWidth(text: string, fontSize: number, letterSpacing: number, bold: boolean): number {
  const characters = Array.from(text)
  const glyphs = characters.reduce((sum, character) => sum + glyphWidth(character), 0)
  const spacing = Math.max(0, characters.length - 1) * letterSpacing
  return glyphs * fontSize * (bold ? 1.04 : 1) + spacing
}

export interface TextLayoutInput {
  text: string
  width: number
  height: number
  fontSize: number
  bold?: boolean
  lineHeight?: number
  letterSpacing?: number
  wrap?: boolean
}

export interface TextLayoutResult {
  lineCount: number
  maxLineCount: number
  requiredHeight: number
  availableLineWidth: number
  widestLine: number
  horizontalOverflow: boolean
  overflow: boolean
}

/**
 * Estimate native text wrapping while retaining the authored font size.
 * Returns the line use and the overflow state the checker reports.
 */
export function measureTextLayout(input: TextLayoutInput): TextLayoutResult {
  const fontSize = positive(input.fontSize, 18)
  const lineHeight = positive(input.lineHeight, DEFAULT_LINE_HEIGHT)
  const letterSpacing = typeof input.letterSpacing === 'number' && Number.isFinite(input.letterSpacing) ? input.letterSpacing : 0
  const availableLineWidth = Math.max(0, input.width) * WIDTH_RESERVE
  const paragraphWidths = input.text.length === 0
    ? []
    : input.text.split('\n').map((line) => lineWidth(line, fontSize, letterSpacing, input.bold === true))
  const widestLine = Math.max(0, ...paragraphWidths)
  const wrap = input.wrap !== false
  const lineCount = paragraphWidths.reduce((sum, width) => {
    if (!wrap || availableLineWidth === 0) return sum + 1
    return sum + Math.max(1, Math.ceil(width / availableLineWidth))
  }, 0)
  const requiredHeight = lineCount * fontSize * lineHeight
  const maxLineCount = Math.max(0, Math.floor(Math.max(0, input.height) / (fontSize * lineHeight)))
  const horizontalOverflow = !wrap && widestLine > availableLineWidth
  return {
    lineCount,
    maxLineCount,
    requiredHeight,
    availableLineWidth,
    widestLine,
    horizontalOverflow,
    overflow: horizontalOverflow || lineCount > maxLineCount,
  }
}

/**
 * The maximum suggested character count for one text zone — the
 * `textCapacity` the template page references expose to the model.
 */
export function recommendedTextCapacity(width: number, height: number, fontSize: number, lineHeight: number = DEFAULT_LINE_HEIGHT): number {
  const size = positive(fontSize, 18)
  const spacing = positive(lineHeight, DEFAULT_LINE_HEIGHT)
  const charactersPerLine = Math.max(1, Math.floor(Math.max(0, width) * WIDTH_RESERVE / size))
  const lines = Math.max(1, Math.floor(Math.max(0, height) / (size * spacing)))
  return Math.max(1, Math.min(1000, Math.floor(charactersPerLine * lines * 0.9)))
}
