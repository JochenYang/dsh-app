/**
 * The colours a level gives the surfaces that carry it: the name's text colour —
 * on the official menu row's value cell and on the composer capsule's own level
 * text, one colour for both — and the capsule's own ring.
 *
 * ## One ramp, three surfaces
 *
 * The track's fill gradient, the level name and the capsule's edge are one
 * signal, so they come from one ramp: {@link FILL_RAMP_LIGHT} /
 * {@link FILL_RAMP_DARK} are the stops the stylesheet's `--dshAppEffort-fill`
 * gradient is built from (see {@link fillGradient}), and the name and the ring
 * are that same ramp read at the current position.
 *
 * The NAME is drawn in two places — the official menu row's own value cell, and
 * the composer capsule's own level text (the `… Max` beside the model name) — and
 * it is ONE colour in both. A level that looked one way inside the menu and
 * another way on the composer would be two signals out of one selection, and what
 * the composer's text carried instead was the kernel's own caption tone
 * (`--dsw-alias-label-caption`), which is exactly why it read pale beside a menu
 * capsule that did not. The two places differ only in their surfaces, and the lift
 * below is computed against the strictest surface of the theme across both of
 * them, so a single colour clears the floor on every one.
 *
 * The ramp is a GRAPHICAL object's colours, though — its light-theme start,
 * `#5686FE`, is 3.37:1 on white, which is a deliberate choice for a 28px bar and
 * below the 4.5:1 floor WCAG asks of body text. So the name takes the ramp colour
 * and lifts it only as far as the floor requires, toward black on a light surface
 * and toward white on a dark one:
 *
 *   - light: two of the four stops are lifted (`#5686FE` → `#4165BF`,
 *     `#4176E6` → `#3865C6`), the two that are already dark enough are not;
 *   - dark: three of the four stops are the track's own colours exactly, and the
 *     third (`#A98BFF` → `#B297FF`) moves only because the surfaces it is drawn
 *     on cost it contrast. See `Measured` below for why hover is in the basis.
 *
 * ## The one honest asymmetry
 *
 * In the light theme the name can never be as bright as the start of the track.
 * `#5686FE` on white is 3.37:1, and no amount of care makes a 3.37:1 colour
 * readable as text, so the name is always the track's colour in its DARKER
 * same-family form (`#5686FE` reads as `#4165BF`). The name therefore moves less
 * than the track does — same direction, same hue family, compressed range. In the
 * dark theme there is almost no such gap: three of its four stops are the track's
 * own colours exactly.
 *
 * ## Measured
 *
 * `raw` is the track's own colour at that stop; `name` is what the name actually
 * carries. Every surface the name can be drawn on is in the row, and the hover
 * ones are the strictest: the official row paints
 * `--dsw-alias-interactive-bg-hover` behind itself while the pointer is over it or
 * it has focus-visible, and the composer's own model trigger paints the same token
 * behind its level text on hover — which is exactly when a level is being read or
 * dragged. That colour darkens a light card and lightens a dark one.
 *
 * | light stop | raw: white / #F5F5F5 / hover-white / hover-#F5F5F5 | name: same four |
 * |------------|-----------------------------------------------------|-----------------|
 * | `#5686FE`  | 3.37 / 3.09 / 3.03 / 2.78 | `#4165BF` 5.47 / 5.02 / 4.92 / 4.51 |
 * | `#4176E6`  | 4.23 / 3.88 / 3.81 / 3.49 | `#3865C6` 5.46 / 5.01 / 4.92 / 4.50 |
 * | `#3A5BD9`  | 5.71 / 5.24 / 5.14 / 4.71 | unchanged 5.71 / 5.24 / 5.14 / 4.71 |
 * | `#4B3FD6`  | 7.04 / 6.46 / 6.34 / 5.81 | unchanged 7.04 / 6.46 / 6.34 / 5.81 |
 *
 * The composer capsule draws its level text on `--dsw-specific-input-major`, which
 * is `#FFFFFF` in the light theme — the white surface already in the table above,
 * its hover included — and `#2C2C2E` in the dark one. That is NOT either of the
 * menu's dark cards, and it is the LIGHTER of the three, so it is the dark theme's
 * strictest surface; the two columns at the end of this table are what moved the
 * dark basis:
 *
 * | dark stop | raw: #292929 / #212123 / hover-#292929 / hover-#212123 / #2C2C2E / hover-#2C2C2E | name |
 * |-----------|-----------------------------------------------------------------------------------|------|
 * | `#7AAAFF` | 6.25 / 6.91 / 4.89 / 5.50 / 5.99 / 4.66 | unchanged |
 * | `#8FB0FF` | 6.80 / 7.52 / 5.32 / 5.98 / 6.52 / 5.07 | unchanged |
 * | `#A98BFF` | 5.42 / 5.99 / 4.24 / 4.77 / 5.19 / 4.04 | `#B297FF` 6.07 / 6.71 / 4.75 / 5.34 / 5.82 / 4.53 |
 * | `#B9A6FF` | 6.90 / 7.62 / 5.40 / 6.07 / 6.61 / 5.15 | unchanged 6.90 / 7.62 / 5.40 / 6.07 / 6.61 / 5.15 |
 *
 * Swept over the whole ramp rather than at the stops, the name never drops below
 * 4.50:1 — on a hover surface in both themes, which is the number the lift is
 * computed to hold. Away from hover the same colours are never below 5.01:1
 * (light) / 5.78:1 (dark).
 *
 * The lift is computed against the STRICTEST surface of the theme — the light
 * theme's is the menu's hover over its darker card, the dark theme's is the
 * composer's hover over its own — because that is the moment the user is actually
 * reading the level. Lifting against the plain card alone would leave the light
 * start at 4.29:1 while the pointer is on the row; lifting the dark name against
 * the menu's own hover alone left the composer at 4.29:1 while the pointer was on
 * the trigger, which is the case this basis exists for.
 *
 * ## What these numbers hold for, and what they do not
 *
 * They are exact for the six opaque surfaces above: the two menu cards and the
 * composer's own, each plain and hovered. They do NOT cover a card drawn
 * translucently over brighter content — both card tokens are opaque today. Against
 * a brighter surface every figure here falls, the kernel's own tertiary copy
 * included; a surface nobody has measured cannot be lifted against.
 *
 * ## The ring
 *
 * The ring is the name's own colour at an alpha, so the capsule's edge and the
 * level name are one colour and the track is the un-lifted original. It is drawn
 * by a `box-shadow` with a spread — that is, OUTSIDE the row's border box — so
 * its surfaces are the two plain menu cards, never the row's hover colour, and the
 * composer capsule (which this plugin does not ring) is not one of them.
 *
 * Composited over those cards, the worst stop measures 4.04:1 (light, white) /
 * 3.80:1 (light, #F5F5F5) at {@link RING_ALPHA_LIGHT}, and 4.19:1 (dark,
 * #292929) / 4.51:1 (dark, #212123) at {@link RING_ALPHA_DARK} — all clear of the
 * 3:1 floor for a graphical object, which is what a 1px hairline has to clear to
 * read as an edge at all. The dark theme's alpha is lower because its ramp is
 * brighter throughout, so the same alpha would composite to a heavier edge there.
 *
 * ## The theme
 *
 * Read from `document.body[data-ds-dark-theme]` — the same hook the stylesheet
 * switches on (see `styles.ts`). It is read when the colour is ASKED for rather
 * than captured, so the next paint after a theme switch carries the right ramp, and
 * the bridge observes that one attribute (see {@link DARK_THEME_ATTRIBUTE}: a
 * filtered `MutationObserver` on the body) so the flip is a paint rather than
 * something the next unrelated DOM insertion has to correct.
 *
 * @module @dsh-app/plugin-effort/client/value-color
 */

import { clamp01 } from './geometry.ts'

/** One stop of a ramp: a colour and where it sits. */
export interface RampStop {
  /** The stop's colour, `#RRGGBB`. */
  readonly color: string
  /** Position along the ramp, 0..1. */
  readonly at: number
}

/**
 * The track fill's ramp in the light theme, low effort first.
 *
 * The stylesheet's gradient is generated from these, so the track, the name and
 * the ring cannot drift apart.
 */
export const FILL_RAMP_LIGHT: readonly RampStop[] = [
  { color: '#5686FE', at: 0 },
  { color: '#4176E6', at: 0.42 },
  { color: '#3A5BD9', at: 0.72 },
  { color: '#4B3FD6', at: 1 },
]

/** The track fill's ramp in the dark theme, low effort first. */
export const FILL_RAMP_DARK: readonly RampStop[] = [
  { color: '#7AAAFF', at: 0 },
  { color: '#8FB0FF', at: 0.45 },
  { color: '#A98BFF', at: 0.78 },
  { color: '#B9A6FF', at: 1 },
]

/**
 * `--dsw-alias-interactive-bg-hover`, the background the official row paints
 * behind itself while the pointer is over it or it has focus-visible (`.cell:hover`
 * / `.cell:focus-visible` in the kernel's own stylesheet). Written as the theme
 * declares it: `#RRGGBBAA`, alpha last.
 *
 * It matters here because hovering the row is exactly what a user does before
 * dragging the track, and it moves the surface under the NAME in the direction
 * that costs contrast — darker on a light card, lighter on a dark one.
 */
const HOVER_LIGHT = '#2631480f'
const HOVER_DARK = '#ffffff14'

/** The light card the menu draws on. */
const LIGHT_CARD = '#F5F5F5'

/** The dark card the menu draws on. */
const DARK_CARD = '#292929'

/**
 * The card the COMPOSER capsule draws on: `--dsw-specific-input-major`, which the
 * installed theme resolves to `--dsw-static-neutral-bluish-00` (`#FFFFFF`) in the
 * light theme and to `--dsw-static-neutral-bluish-850` (`#2C2C2E`) in the dark one.
 *
 * The level text the composer shows beside the model name (`… Max`) is drawn on
 * this card, not on the menu's, and the two dark cards are not the same colour.
 */
const COMPOSER_CARD_LIGHT = '#FFFFFF'
const COMPOSER_CARD_DARK = '#2C2C2E'

/**
 * Every surface the NAME can be drawn on in the light theme.
 *
 * Both of the composer capsule's surfaces — its card and that card hovered — are
 * already here: its card IS `#FFFFFF` and it hovers with the same token the menu
 * row uses. {@link TEXT_BASIS_LIGHT} is the strictest of them, and is the one the
 * lift is computed against.
 */
export const TEXT_SURFACES_LIGHT: readonly string[] = [
  COMPOSER_CARD_LIGHT,
  LIGHT_CARD,
  over(COMPOSER_CARD_LIGHT, HOVER_LIGHT),
  over(LIGHT_CARD, HOVER_LIGHT),
]

/** Every surface the name can be drawn on in the dark theme. */
export const TEXT_SURFACES_DARK: readonly string[] = [
  DARK_CARD,
  '#212123',
  over(DARK_CARD, HOVER_DARK),
  over('#212123', HOVER_DARK),
  COMPOSER_CARD_DARK,
  over(COMPOSER_CARD_DARK, HOVER_DARK),
]

/**
 * The surface the light theme's name is lifted against: the strictest of
 * {@link TEXT_SURFACES_LIGHT} — the hover colour over the darker light card,
 * which is the least contrast dark text can have in this theme. The composer's own
 * card is the lighter of the two, so it is not the binding one here.
 */
export const TEXT_BASIS_LIGHT = over(LIGHT_CARD, HOVER_LIGHT)

/**
 * The surface the dark theme's name is lifted against: the strictest of
 * {@link TEXT_SURFACES_DARK} — the hover colour over the composer's card, which is
 * the LIGHTEST surface light text can be drawn on in this theme and therefore the
 * one that costs it the most contrast.
 *
 * It is the composer card and not the menu's for exactly that reason. Lifting
 * against the menu's own hover (`#3A3A3A`) alone left the third stop's name at
 * 4.29:1 while the pointer was over the composer's model trigger — the text the
 * user reads a level from before ever opening the menu.
 */
export const TEXT_BASIS_DARK = over(COMPOSER_CARD_DARK, HOVER_DARK)

/**
 * Every surface the RING is drawn on.
 *
 * The ring is a `box-shadow` with a spread, so it is painted OUTSIDE the row's
 * border box — over the menu card, never over the row's own hover background.
 * The card itself does not change while the row is hovered.
 */
export const RING_SURFACES_LIGHT: readonly string[] = ['#FFFFFF', LIGHT_CARD]
export const RING_SURFACES_DARK: readonly string[] = [DARK_CARD, '#212123']

/** WCAG 2.x AA for body text. */
const TEXT_FLOOR = 4.5

/**
 * The luminance at which a surface gains the same contrast from a darker colour
 * as from a lighter one: solving (L + 0.05) / 0.05 = 1.05 / (L + 0.05) gives
 * L = √0.0525 − 0.05 ≈ 0.1791. Above it the surface is light and text gains
 * contrast by darkening; below it, by lightening.
 */
const LIGHT_SURFACE_LUMINANCE = Math.sqrt(0.0525) - 0.05

/** The step the lift mixes by, as a fraction — 1%, which is under a colour step. */
const LIFT_STEP = 0.01

/** Alpha of the capsule ring in the light theme. */
export const RING_ALPHA_LIGHT = 0.85

/** Alpha of the capsule ring in the dark theme. */
export const RING_ALPHA_DARK = 0.75

/**
 * The ring's colour when there is no level to take a colour from.
 *
 * Deliberately a neutral token rather than the ramp's start: a capsule edged in
 * the lowest level's colour would claim a position, which is the same claim the
 * track refuses to make by leaving its knob off an unset scale.
 *
 * OPAQUE, not an alpha of the token. Measured at the level ring's own alpha the
 * token gives only 2.93:1 on white and 2.73:1 on #F5F5F5 — under the 3:1 floor
 * this module holds itself to — because the tertiary tone is chosen to be read as
 * small copy, not to be a hairline. At full strength it is 3.71:1 / 3.40:1 light
 * and 6.81:1 / 7.53:1 dark, and the hardcoded fallback is 4.83:1 / 4.43:1 light
 * and 3.01:1 / 3.32:1 dark.
 */
export const NEUTRAL_RING = 'var(--dsw-alias-label-tertiary, #6b7280)'

/**
 * The attribute the kernel toggles on `document.body` for the dark theme
 * (`document.body.toggleAttribute`, in `@deepseek-ai/dsh-client-ui-theme`).
 *
 * Exported because the bridge filters its mutation observer on this one name: a
 * theme flip is an attribute change and produces no DOM insertion, so without that
 * filter the composer capsule's level text would keep the other theme's colour
 * until the next unrelated re-render.
 */
export const DARK_THEME_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * The name's colour for one position on the track.
 *
 * Lifted against the strictest surface the name can be drawn on in that theme — in
 * the light theme the menu row's hover background over its darker card, in the dark
 * theme the composer's hover over its own — so the floor holds in the moment a level
 * is actually being read: while the pointer is on the row, or on the composer's
 * model trigger.
 *
 * @param pct - fraction of the travel, 0..1 (clamped).
 * @param dark - whether the dark theme is in effect.
 * @returns a `#RRGGBB` colour.
 */
export function textColorAt(pct: number, dark: boolean): string {
  const ramp = dark ? FILL_RAMP_DARK : FILL_RAMP_LIGHT
  return textColorFor(rampColorAt(ramp, pct), dark ? TEXT_BASIS_DARK : TEXT_BASIS_LIGHT)
}

/**
 * The capsule ring's colour for one position on the track.
 * @param pct - fraction of the travel, 0..1 (clamped).
 * @param dark - whether the dark theme is in effect.
 * @returns an `rgb(r g b / a%)` colour, the same level as {@link textColorAt}.
 */
export function ringColorAt(pct: number, dark: boolean): string {
  return alphaOf(textColorAt(pct, dark), dark ? RING_ALPHA_DARK : RING_ALPHA_LIGHT)
}

/**
 * The text colour for a fill colour on a surface: the fill itself when it already
 * clears the floor, otherwise the least darkening (or lightening) that does.
 *
 * The direction is decided by the SURFACE, not by the colour: contrast against a
 * light card is gained by going darker, against a dark one by going lighter. That
 * makes the function total — {@link LIGHT_SURFACE_LUMINANCE} is exactly the
 * crossover where the two directions are equally strong, and the extreme in the
 * chosen direction always clears the floor there — so there is no case in which
 * it has to answer with a colour that fails.
 *
 * @param fill - the ramp colour.
 * @param surface - the card surface behind the text.
 * @returns a `#RRGGBB` colour that clears the text floor on that surface.
 */
export function textColorFor(fill: string, surface: string): string {
  if (contrastRatio(fill, surface) >= TEXT_FLOOR) return fill
  const towards = relativeLuminance(surface) < LIGHT_SURFACE_LUMINANCE ? '#FFFFFF' : '#000000'
  const lifted = liftTowards(fill, surface, towards)
  // Unreachable, by the same argument: on a surface above the crossover, black
  // itself is at least 4.58:1, and below it, white is.
  if (lifted === null) throw new TypeError(`no colour clears ${TEXT_FLOOR}:1 on ${surface}`)
  return lifted
}

/**
 * The least mix of `fill` toward `towards` that clears the text floor.
 * @param fill - the colour to move.
 * @param surface - the card surface behind it.
 * @param towards - the extreme to move toward.
 * @returns the colour, or null when not even the extreme clears.
 */
function liftTowards(fill: string, surface: string, towards: string): string | null {
  for (let step = LIFT_STEP; step < 1; step += LIFT_STEP) {
    const candidate = mixHex(fill, towards, step)
    if (contrastRatio(candidate, surface) >= TEXT_FLOOR) return candidate
  }
  const extreme = mixHex(fill, towards, 1)
  return contrastRatio(extreme, surface) >= TEXT_FLOOR ? extreme : null
}

/**
 * What an alpha colour paints when it is drawn over an opaque one.
 *
 * Chromium composites in the sRGB space this module works in, so a rounded
 * per-channel blend is what the screen shows — which is the whole point of the
 * numbers below: the tokens are translucent, and their contrast depends on what
 * is behind them.
 *
 * @param surface - the opaque colour behind.
 * @param color - the colour on top, `#RRGGBB` or `#RRGGBBAA`.
 * @returns the composited `#RRGGBB`.
 */
export function over(surface: string, color: string): string {
  const back = parseHex(surface)
  const front = parseHexAlpha(color)
  const blended = back.map((value, index) => front.alpha * (front.rgb[index] as number) + (1 - front.alpha) * value)
  return `#${blended.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/**
 * The colour at one position along a ramp of two or more stops.
 * @param ramp - the stops, low effort first.
 * @param pct - fraction of the travel, 0..1 (clamped).
 * @returns a `#RRGGBB` colour.
 */
export function rampColorAt(ramp: readonly RampStop[], pct: number): string {
  const count = ramp.length
  if (count === 0) throw new TypeError('a ramp with no stops has no colour')
  const first = ramp[0] as RampStop
  if (count === 1) return first.color
  const t = clamp01(pct)
  for (let index = 0; index < count - 1; index += 1) {
    const from = ramp[index] as RampStop
    const to = ramp[index + 1] as RampStop
    if (t > to.at) continue
    const span = to.at - from.at
    return mixHex(from.color, to.color, span > 0 ? (t - from.at) / span : 0)
  }
  return (ramp[count - 1] as RampStop).color
}

/**
 * A ramp as a CSS `linear-gradient`, for the stylesheet's fill.
 * @param ramp - the stops, low effort first.
 * @returns the gradient expression.
 */
export function fillGradient(ramp: readonly RampStop[]): string {
  const stops = ramp.map(stop => `${stop.color} ${(stop.at * 100).toFixed(0)}%`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/**
 * A `#RRGGBB` colour as an `rgb(r g b / a%)` one.
 * @param color - the colour.
 * @param alpha - the alpha, 0..1 (clamped).
 * @returns the colour with that alpha.
 */
export function alphaOf(color: string, alpha: number): string {
  const [r, g, b] = parseHex(color)
  return `rgb(${r} ${g} ${b} / ${Math.round(clamp01(alpha) * 100)}%)`
}

/**
 * Whether the dark theme is in effect for this document.
 *
 * `document.body` is read rather than `documentElement`, because that is the
 * element the kernel stamps and the one our stylesheet keys on.
 *
 * @param doc - the host document, or null outside a DOM.
 * @returns true when the dark theme is in effect.
 */
export function isDarkTheme(doc: Document | null): boolean {
  const body = doc?.body
  if (body === null || body === undefined) return false
  return typeof body.hasAttribute === 'function' && body.hasAttribute(DARK_THEME_ATTRIBUTE)
}

/**
 * Mix two `#RRGGBB` colours per channel in sRGB.
 * @param from - the colour at t = 0.
 * @param to - the colour at t = 1.
 * @param t - the position, 0..1 (clamped).
 * @returns the mixed colour.
 */
export function mixHex(from: string, to: string, t: number): string {
  const a = parseHex(from)
  const b = parseHex(to)
  const k = clamp01(t)
  const mixed = a.map((value, index) => Math.round(value + ((b[index] as number) - value) * k))
  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/**
 * WCAG relative luminance of a `#RRGGBB` colour.
 * @param color - the colour.
 * @returns the luminance, 0..1.
 */
export function relativeLuminance(color: string): number {
  const [r, g, b] = parseHex(color).map(linearise) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * WCAG contrast ratio between two `#RRGGBB` colours.
 * @param a - one colour.
 * @param b - the other.
 * @returns the ratio, 1..21.
 */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * One sRGB channel's linear-light value, per WCAG's definition.
 * @param channel - the channel, 0..255.
 * @returns the linear value, 0..1.
 */
function linearise(channel: number): number {
  const scaled = channel / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

/**
 * Parse a `#RRGGBB` colour.
 *
 * Only the form this module's own constants use: a value that does not parse is
 * a programming error, and answering it with a guess would put a colour nobody
 * chose on the official row.
 *
 * @param color - the colour.
 * @returns its three channels.
 */
function parseHex(color: string): readonly [number, number, number] {
  return parseHexAlpha(color).rgb
}

/**
 * Parse a `#RRGGBB` or `#RRGGBBAA` colour, the two forms the theme tokens use.
 * @param color - the colour.
 * @returns its channels and its alpha, 0..1.
 */
function parseHexAlpha(color: string): {
  readonly rgb: readonly [number, number, number]
  readonly alpha: number
} {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(color.trim())
  if (match === null) throw new TypeError(`not a #RRGGBB or #RRGGBBAA colour: ${color}`)
  const digits = match[1] as string
  const alpha = match[2]
  return {
    rgb: [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ],
    alpha: alpha === undefined ? 1 : Number.parseInt(alpha, 16) / 255,
  }
}
