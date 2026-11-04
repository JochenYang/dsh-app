/**
 * Brand colour → a palette a template can wear.
 *
 * Why this exists. The bundled templates each carry a hand-picked six-colour
 * palette, which is what makes them look designed — and what makes them useless to
 * the one thing every organisation actually has: a brand colour. Hand-editing a
 * colourway per customer is not a feature, and letting a model "adjust the colours"
 * produces the thing this module exists to prevent: a deck whose accent is a
 * pale pastel used as body text, or whose secondary is lighter than the paper.
 *
 * So the conversion is code, not judgement, and it works in OKLCH rather than in
 * sRGB. Equal lightness steps in sRGB are not equal perceptual steps: a naive
 * "darken the brand by 30%" turns yellow into olive and blue into navy at the same
 * instruction. Chroma and lightness are separate in OKLCH, which is what lets this
 * module hold hue constant — one deck, one hue — while moving the other two axes
 * into the ranges a slide can actually carry.
 *
 * The output is the SAME six slots every bundled template's `metadata.json` has
 * (`background / text / accent / surface / secondary / muted`), so it drops into
 * `theme.colors` without a second vocabulary.
 *
 * WHAT ENFORCES THE RESULT. Contrast is checked with the WCAG 2.1 ratio, which is
 * what a reviewer, an accessibility audit and the skill's own checklist all quote.
 * APCA is deliberately NOT computed here: its constants change between drafts, this
 * repository has no authoritative table to test an implementation against, and a
 * number nobody can verify is worse than no number. The two gates that matter are
 * enforced below with a repair loop, and every repair is reported rather than made
 * silently — a palette that needed five repairs is a brand colour worth telling the
 * user about.
 *
 * @module @dsh-app/plugin-ppt/palette
 */

/** The six colour slots every template palette carries, as `#RRGGBB`. */
export interface Palette {
  readonly background: string
  readonly text: string
  readonly accent: string
  readonly surface: string
  readonly secondary: string
  readonly muted: string
}

/** A named colourway a deck can wear instead of its template's own. */
export interface PalettePreset {
  /** Stable id, stored in the session's mode state. */
  readonly id: string
  /** Chinese label (the product's user-facing language). */
  readonly name: string
  /** English label, for the panel beside a Chinese UI. */
  readonly nameEn: string
  /** Which visual family the colourway belongs to. */
  readonly family: 'magazine' | 'swiss'
  readonly scheme: PaletteScheme
  /** The colourway, expanded from its paper / ink / accent triple. */
  readonly colors: Palette
  /**
   * Accent against background, measured.
   *
   * NOT a gate for a preset. A curated colourway sometimes uses its accent as a
   * BLOCK (Swiss yellow, safety orange) rather than as ink, and clamping it would
   * destroy the identity the preset exists for. The number is published so the
   * skill's rule — "any colour that carries text must clear 4.5:1 against it" —
   * can be applied by the page that uses it.
   */
  readonly accentOnBackground: number
}

/** Which way round the deck is: dark ink on paper, or light ink on a dark ground. */
export type PaletteScheme = 'light' | 'dark'

/** What the derivation measured, and what it had to change to get there. */
export interface PaletteReport {
  /** WCAG 2.1 ratios, in the order the skill states them. */
  readonly textOnBackground: number
  readonly accentOnBackground: number
  readonly secondaryOnBackground: number
  readonly mutedOnBackground: number
  /**
   * Every adjustment the gate forced, one sentence each. Empty means the brand
   * colour already sat inside every range.
   */
  readonly repairs: readonly string[]
}

/** One derived palette plus its measurements. */
export interface DerivedPalette {
  readonly palette: Palette
  readonly report: PaletteReport
}

/** The floors the derivation guarantees. */
export const CONTRAST_FLOOR = {
  /** Body text against the page. AAA for normal text, and what the skill asks for. */
  textOnBackground: 7,
  /** Accent against the page: 3 is the WCAG floor for a non-text graphic. */
  accentOnBackground: 3,
  /** Secondary and muted are text colours (subtitles, sources), so AA applies. */
  supportingOnBackground: 4.5,
} as const

/** A parsed colour, 0–255 per channel. */
interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** OKLCH: perceptual lightness 0–1, chroma, hue in degrees. */
interface Oklch {
  readonly l: number
  readonly c: number
  readonly h: number
}

/**
 * Parse `#RRGGBB` (the only form the PPTD schema accepts) into channels.
 *
 * @param hex - the colour text, with or without the leading `#`.
 * @returns the channels.
 */
export function parseHex(hex: string): Rgb {
  const digits = hex.trim().replace(/^#/u, '')
  if (!/^[0-9a-fA-F]{6}$/u.test(digits)) {
    throw new Error(`颜色必须是 #RRGGBB 六位十六进制：收到 "${hex}"`)
  }
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  }
}

/** Format channels as the `#RRGGBB` the schema requires. */
function toHex({ r, g, b }: Rgb): string {
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))
  return `#${[clamp(r), clamp(g), clamp(b)].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

/** sRGB channel (0–255) → linear light (0–1), per the WCAG definition. */
function toLinear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** Linear light (0–1) → sRGB channel (0–255). */
function fromLinear(value: number): number {
  const clamped = Math.max(0, Math.min(1, value))
  return 255 * (clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055)
}

/**
 * WCAG 2.1 relative luminance.
 * @param rgb - the colour.
 * @returns luminance in 0–1.
 */
function luminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b)
}

/**
 * WCAG 2.1 contrast ratio between two colours, 1–21.
 *
 * This is the number the skill quotes and an audit checks, so it is the number this
 * module gates on.
 *
 * @param a - one colour, `#RRGGBB`.
 * @param b - the other.
 * @returns the ratio, rounded to two decimals.
 */
export function contrastRatio(a: string, b: string): number {
  const first = luminance(parseHex(a))
  const second = luminance(parseHex(b))
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100
}

/** `#RRGGBB` → OKLCH. Standard sRGB → linear → LMS → OKLab conversion. */
function toOklch(rgb: Rgb): Oklch {
  const r = toLinear(rgb.r)
  const g = toLinear(rgb.g)
  const b = toLinear(rgb.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const aAxis = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const chroma = Math.hypot(aAxis, bAxis)
  // `atan2` answers in radians; a colour with no chroma has no hue to report, and
  // 0° is the conventional stand-in.
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(bAxis, aAxis) * 180) / Math.PI + 360) % 360
  return { l: lightness, c: chroma, h: hue }
}

/** OKLCH → `#RRGGBB`, clamping out-of-gamut results per channel. */
function fromOklch({ l, c, h }: Oklch): string {
  const radians = (h * Math.PI) / 180
  const aAxis = c * Math.cos(radians)
  const bAxis = c * Math.sin(radians)
  const lPrime = l + 0.3963377774 * aAxis + 0.2158037573 * bAxis
  const mPrime = l - 0.1055613458 * aAxis - 0.0638541728 * bAxis
  const sPrime = l - 0.0894841775 * aAxis - 1.291485548 * bAxis
  const lms = [lPrime ** 3, mPrime ** 3, sPrime ** 3]
  const r = 4.0767416621 * lms[0]! - 3.3077115913 * lms[1]! + 0.2309699292 * lms[2]!
  const g = -1.2684380046 * lms[0]! + 2.6097574011 * lms[1]! - 0.3413193965 * lms[2]!
  const b = -0.0041960863 * lms[0]! - 0.7034186147 * lms[1]! + 1.707614701 * lms[2]!
  return toHex({ r: fromLinear(r), g: fromLinear(g), b: fromLinear(b) })
}

/**
 * Move a colour's lightness until it clears a ratio against a fixed ground.
 *
 * The direction is decided by the ground: on a light page a colour must get DARKER
 * to gain contrast, on a dark page lighter. Steps are small (0.01 in OKLCH
 * lightness) so the hue survives — a bigger step is what turns a brand colour into
 * something the user does not recognise.
 *
 * @param colour - starting colour.
 * @param ground - the colour it has to be legible against.
 * @param floor - the ratio to reach.
 * @param direction - which way lightness may move.
 * @param label - what to call this repair in the report.
 * @returns the adjusted colour and the repairs it took.
 */
function repairAgainst(
  colour: Oklch,
  ground: string,
  floor: number,
  direction: -1 | 1,
  label: string,
): { oklch: Oklch, repairs: string[] } {
  const repairs: string[] = []
  let current = colour
  let steps = 0
  while (contrastRatio(fromOklch(current), ground) < floor && steps < 60) {
    const next = Math.max(0, Math.min(1, current.l + direction * 0.01))
    if (next === current.l) break
    current = { ...current, l: next }
    steps += 1
  }
  if (steps > 0) {
    repairs.push(`${label} 的明度被移动 ${String(steps)} 档（OKLCH L ${String(Math.round(colour.l * 100))} → ${String(Math.round(current.l * 100))}）以满足 ${String(floor)}:1`)
  }
  return { oklch: current, repairs }
}

/**
 * Derive the six-slot palette from one brand colour.
 *
 * The shape of the result is fixed, not stylistic: `background` is a near-white (or
 * near-black) tint of the brand hue, `surface` one step stronger so panels read as
 * raised, `text` a near-neutral ink carrying a trace of the hue so the page does not
 * look tinted against it, `accent` the brand itself pushed into the lightness and
 * chroma band a slide can carry, and `secondary` / `muted` two neutrals that stay
 * legible as text.
 *
 * @param brandHex - the brand colour, `#RRGGBB`.
 * @param scheme - `light` (default) for ink on paper, `dark` for the inverse.
 * @returns the palette and every measurement the gate made.
 */
export function derivePalette(brandHex: string, scheme: PaletteScheme = 'light'): DerivedPalette {
  const brand = toOklch(parseHex(brandHex))
  const repairs: string[] = []
  const dark = scheme === 'dark'

  // Background and surface: the same hue at paper lightness. Chroma is capped hard —
  // a tinted page is a choice, a saturated page fights every colour placed on it.
  const background = fromOklch({ l: dark ? 0.16 : 0.97, c: Math.min(brand.c * 0.15, 0.015), h: brand.h })
  const surface = fromOklch({ l: dark ? 0.22 : 0.93, c: Math.min(brand.c * 0.22, 0.028), h: brand.h })

  // Text: near-neutral ink with a trace of the hue, then repaired toward AAA. On a
  // light page it darkens; on a dark page it lightens.
  const inkStart: Oklch = { l: dark ? 0.92 : 0.2, c: Math.min(brand.c * 0.2, 0.02), h: brand.h }
  const ink = repairAgainst(inkStart, background, CONTRAST_FLOOR.textOnBackground, dark ? 1 : -1, '正文色')
  const text = fromOklch(ink.oklch)
  repairs.push(...ink.repairs)

  // Accent: the brand as the deck's one loud colour. Lightness is clamped into a band
  // that reads as a deliberate colour rather than a pastel or a shadow, then repaired
  // only if it still fails the graphic floor.
  //
  // A brand with no chroma (white, black, a true grey) is NOT given one: forcing the
  // chroma floor there invents a hue the organisation never had — measured, pure white
  // came out mauve. Such a brand gets a neutral accent, which is what a monochrome
  // identity actually is.
  const achromatic = brand.c < 0.01
  const accentStart: Oklch = {
    l: Math.max(dark ? 0.62 : 0.38, Math.min(dark ? 0.82 : 0.58, brand.l)),
    c: achromatic ? 0 : Math.max(0.06, Math.min(0.18, brand.c)),
    h: brand.h,
  }
  if (Math.abs(accentStart.l - brand.l) > 0.02 || Math.abs(accentStart.c - brand.c) > 0.02) {
    const round = (value: number, digits: number): string => (Math.round(value * 10 ** digits) / 10 ** digits).toFixed(digits)
    const moved = [
      Math.abs(accentStart.l - brand.l) > 0.02 ? `L ${round(brand.l, 2)}→${round(accentStart.l, 2)}` : '',
      Math.abs(accentStart.c - brand.c) > 0.02 ? `C ${round(brand.c, 3)}→${round(accentStart.c, 3)}` : '',
    ].filter(part => part !== '').join('，')
    repairs.push(achromatic
      ? `品牌色没有彩度，accent 改用中性深色（${moved}）`
      : `accent 的品牌色被收进可读区间（${moved}）`)
  }
  const accent = repairAgainst(accentStart, background, CONTRAST_FLOOR.accentOnBackground, dark ? 1 : -1, 'accent')

  // Secondary and muted are TEXT colours (subtitles, sources, page numbers), so the
  // AA floor applies to both. Muted starts lighter than secondary so the two remain
  // distinguishable after repair.
  const secondaryStart: Oklch = { l: dark ? 0.78 : 0.42, c: Math.min(brand.c * 0.25, 0.03), h: brand.h }
  const secondary = repairAgainst(secondaryStart, background, CONTRAST_FLOOR.supportingOnBackground, dark ? 1 : -1, 'secondary')
  const mutedStart: Oklch = { l: dark ? 0.7 : 0.48, c: Math.min(brand.c * 0.2, 0.02), h: brand.h }
  const muted = repairAgainst(mutedStart, background, CONTRAST_FLOOR.supportingOnBackground, dark ? 1 : -1, 'muted')
  repairs.push(...accent.repairs, ...secondary.repairs, ...muted.repairs)

  const palette: Palette = {
    background,
    text,
    accent: fromOklch(accent.oklch),
    surface,
    secondary: fromOklch(secondary.oklch),
    muted: fromOklch(muted.oklch),
  }
  return {
    palette,
    report: {
      textOnBackground: contrastRatio(palette.text, palette.background),
      accentOnBackground: contrastRatio(palette.accent, palette.background),
      secondaryOnBackground: contrastRatio(palette.secondary, palette.background),
      mutedOnBackground: contrastRatio(palette.muted, palette.background),
      repairs,
    },
  }
}

/**
 * The `theme.colors` block a PPTD manifest wants, as YAML lines.
 *
 * The model is told to copy this text rather than to compute colours: the six values
 * are already gated, and a model re-deriving them would be doing arithmetic the host
 * has already done correctly.
 *
 * @param palette - the six slots.
 * @returns the YAML lines, indented for `theme.colors`.
 */
export function themeColorsYaml(palette: Palette): string[] {
  return [
    `    background: "${palette.background}"`,
    `    text: "${palette.text}"`,
    `    accent: "${palette.accent}"`,
    `    surface: "${palette.surface}"`,
    `    secondary: "${palette.secondary}"`,
    `    muted: "${palette.muted}"`,
  ]
}

/**
 * The curated colourways, as `paper / ink / accent` triples.
 *
 * Why a second source of palettes at all: a template's own colours are tied to its
 * layout family, so changing the look of a deck used to mean changing its structure
 * too. These are colourways a page can wear on top of ANY layout, which is what makes
 * "the slate grid, in ink classic" expressible. The four loud ones are deliberately
 * published with an accent that fails the text floor — they use the accent as a
 * BLOCK, and the measured ratio travels with the preset so the page that puts words
 * on it can see why.
 *
 * The triples are recorded here rather than derived from anything: a colourway is a
 * design decision, and a runtime derivation would drift the moment the algorithm
 * changed.
 */
const PRESET_TRIPLES: readonly {
  readonly id: string
  readonly name: string
  readonly nameEn: string
  readonly family: 'magazine' | 'swiss'
  readonly scheme: PaletteScheme
  readonly paper: string
  readonly ink: string
  readonly accent: string
}[] = [
  { id: 'ink-classic', name: '墨水经典', nameEn: 'Ink Classic', family: 'magazine', scheme: 'light', paper: '#f1efea', ink: '#0a0a0b', accent: '#111111' },
  { id: 'indigo-porcelain', name: '靛蓝瓷', nameEn: 'Indigo Porcelain', family: 'magazine', scheme: 'light', paper: '#f1f3f5', ink: '#0a1f3d', accent: '#315d93' },
  { id: 'forest-ink', name: '森林墨', nameEn: 'Forest Ink', family: 'magazine', scheme: 'light', paper: '#f5f1e8', ink: '#1a2e1f', accent: '#2e6b4f' },
  { id: 'kraft-paper', name: '牛皮纸', nameEn: 'Kraft Paper', family: 'magazine', scheme: 'light', paper: '#eedfc7', ink: '#2a1e13', accent: '#9b5a2e' },
  { id: 'dune', name: '沙丘', nameEn: 'Dune', family: 'magazine', scheme: 'light', paper: '#f0e6d2', ink: '#1f1a14', accent: '#8f7650' },
  { id: 'midnight-ink', name: '午夜墨', nameEn: 'Midnight Ink', family: 'magazine', scheme: 'dark', paper: '#0e0d0c', ink: '#ece2cf', accent: '#d4a04a' },
  { id: 'ikb', name: '克莱因蓝', nameEn: 'Klein Blue', family: 'swiss', scheme: 'light', paper: '#fafaf8', ink: '#0a0a0a', accent: '#002fa7' },
  { id: 'lemon', name: '柠檬黄', nameEn: 'Lemon', family: 'swiss', scheme: 'light', paper: '#fafaf8', ink: '#0a0a0a', accent: '#ffd500' },
  { id: 'lemon-green', name: '柠檬绿', nameEn: 'Lemon Green', family: 'swiss', scheme: 'light', paper: '#fafaf8', ink: '#0a0a0a', accent: '#c5e803' },
  { id: 'safety-orange', name: '安全橙', nameEn: 'Safety Orange', family: 'swiss', scheme: 'light', paper: '#fafaf8', ink: '#0a0a0a', accent: '#ff6b35' },
]

/**
 * Expand one triple into the six slots a manifest needs.
 *
 * `surface`, `secondary` and `muted` are not in the triple because they are DERIVED
 * roles: a panel that is slightly off the paper, and two neutrals that stay legible as
 * text. Deriving them from the paper's own hue keeps the colourway coherent instead of
 * pairing a warm paper with a blue-grey panel.
 */
function expandPreset(triple: (typeof PRESET_TRIPLES)[number]): PalettePreset {
  const paper = toOklch(parseHex(triple.paper))
  const dark = triple.scheme === 'dark'
  const colors: Palette = {
    background: triple.paper,
    text: triple.ink,
    accent: triple.accent,
    surface: fromOklch({ l: Math.max(0, Math.min(1, paper.l + (dark ? 0.05 : -0.045))), c: paper.c, h: paper.h }),
    secondary: fromOklch({ l: dark ? 0.78 : 0.42, c: Math.min(paper.c * 0.6, 0.02), h: paper.h }),
    muted: fromOklch({ l: dark ? 0.7 : 0.48, c: Math.min(paper.c * 0.4, 0.015), h: paper.h }),
  }
  return {
    id: triple.id,
    name: triple.name,
    nameEn: triple.nameEn,
    family: triple.family,
    scheme: triple.scheme,
    colors,
    accentOnBackground: contrastRatio(colors.accent, colors.background),
  }
}

/** Every colourway a deck can wear regardless of its layout. */
export const PALETTE_PRESETS: readonly PalettePreset[] = PRESET_TRIPLES.map(expandPreset)

/**
 * One preset by id.
 * @param id - the stable id stored in mode state.
 * @returns the preset, or undefined for an unknown id.
 */
export function presetById(id: string): PalettePreset | undefined {
  return PALETTE_PRESETS.find(preset => preset.id === id)
}

/** Which source a deck's colours came from, for the sentence the prompt states. */
export type PaletteSource = 'template' | 'preset' | 'brand'

/** The colours a session runs with, and where they came from. */
export interface ResolvedPalette {
  readonly source: PaletteSource
  /** The preset used, when `source` is `preset`. */
  readonly preset?: PalettePreset | undefined
  /** The palette to write into `theme.colors`; absent means "the template's own". */
  readonly palette?: Palette | undefined
  /** The derivation report, when `source` is `brand`. */
  readonly report?: PaletteReport | undefined
}

/**
 * Resolve the colours a session should use.
 *
 * Precedence is brand over preset over the template's own, and it is stated rather
 * than implied: a session can carry both values (the user typed a brand colour and
 * later picked a colourway), and a silent winner is how a deck ends up wearing neither
 * of the two the user chose.
 *
 * @param state - the session's `brand` and `palette` fields.
 * @returns the resolved source; `template` carries no palette, because the manifest is
 *   supposed to take the template's own and this module never sees it.
 */
export function resolvePalette(state: { readonly brand?: string | null, readonly palette?: string | null }): ResolvedPalette {
  if (typeof state.brand === 'string' && state.brand !== '') {
    const derived = derivePalette(state.brand)
    return { source: 'brand', palette: derived.palette, report: derived.report }
  }
  if (typeof state.palette === 'string' && state.palette !== '') {
    const preset = presetById(state.palette)
    if (preset !== undefined) return { source: 'preset', preset, palette: preset.colors }
  }
  return { source: 'template' }
}
