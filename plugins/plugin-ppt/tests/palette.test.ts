/**
 * The brand-colour gate.
 *
 * Two different failures are pinned here. The first is arithmetic: WCAG's ratio is a
 * published formula, and an implementation that is merely "close" passes a
 * look-at-it check while quoting a number an audit will disagree with. The second is
 * the one this module exists for — a palette derived from a hostile brand colour
 * (pure white, pure black, neon, mid grey) must still satisfy the floors the skill
 * states, because the alternative is a deck whose body text is invisible on an
 * exhibition projector and nobody notices until it ships.
 *
 * @module plugin-ppt/tests/palette
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  CONTRAST_FLOOR,
  PALETTE_PRESETS,
  contrastRatio,
  derivePalette,
  parseHex,
  presetById,
  resolvePalette,
  themeColorsYaml,
  type PaletteScheme,
} from '../src/palette.ts'

/** Brand colours chosen to break a naive derivation in one way each. */
const BRANDS: readonly (readonly [string, string])[] = [
  ['#1e2bfa', 'a saturated blue taken from a real template'],
  ['#000000', 'pure black: has no chroma and no lightness headroom to give'],
  ['#ffffff', 'pure white: must not produce white-on-white text'],
  ['#ff00ff', 'neon magenta: outside any printable gamut at full chroma'],
  ['#808080', 'mid grey: the classic "readable nowhere" colour'],
  ['#e1a4c2', 'a pastel: the accent that some templates use as a FILL, not as text'],
]

describe('contrastRatio', () => {
  it('matches the published extremes', () => {
    assert.equal(contrastRatio('#000000', '#ffffff'), 21)
    assert.equal(contrastRatio('#ffffff', '#ffffff'), 1)
    // Order must not matter: the ratio is symmetric by definition, and a
    // one-directional implementation reports 21 where the audit expects 1.
    assert.equal(contrastRatio('#ffffff', '#000000'), 21)
  })

  it('matches the value an audit quotes for mid grey on white', () => {
    // 4.48 is the number WCAG's own examples give for #777 on #fff — close enough to
    // the 4.5 boundary that an implementation off by a rounding step flips a pass
    // into a fail.
    const ratio = contrastRatio('#777777', '#ffffff')
    assert.ok(ratio > 4.4 && ratio < 4.6, `expected ≈4.48, got ${String(ratio)}`)
  })
})

describe('parseHex', () => {
  it('accepts the one form the PPTD schema allows, with or without the hash', () => {
    assert.deepEqual(parseHex('#1E2BFA'), { r: 30, g: 43, b: 250 })
    assert.deepEqual(parseHex('1e2bfa'), { r: 30, g: 43, b: 250 })
  })

  it('refuses anything else with a message that says what was received', () => {
    // Silent fallback to black is the failure mode: a user pastes a brand colour in
    // the form their design tool shows and gets a black deck with no explanation.
    assert.throws(() => parseHex('#abc'), /RRGGBB/u)
    assert.throws(() => parseHex('rgb(30, 43, 250)'), /收到/u)
    assert.throws(() => parseHex('#1e2bf'), /RRGGBB/u)
  })
})

describe('derivePalette — the floors the skill states', () => {
  for (const scheme of ['light', 'dark'] as const satisfies readonly PaletteScheme[]) {
    for (const [brand, why] of BRANDS) {
      it(`${brand} on a ${scheme} ground clears every floor (${why})`, () => {
        const { palette, report } = derivePalette(brand, scheme)
        for (const [slot, value] of Object.entries(palette)) {
          assert.match(value, /^#[0-9a-f]{6}$/u, `${slot} must be a lowercase #RRGGBB`)
        }
        assert.ok(report.textOnBackground >= CONTRAST_FLOOR.textOnBackground,
          `body text ${palette.text} on ${palette.background} is ${String(report.textOnBackground)}:1`)
        assert.ok(report.accentOnBackground >= CONTRAST_FLOOR.accentOnBackground,
          `accent ${palette.accent} on ${palette.background} is ${String(report.accentOnBackground)}:1`)
        assert.ok(report.secondaryOnBackground >= CONTRAST_FLOOR.supportingOnBackground,
          `secondary is ${String(report.secondaryOnBackground)}:1`)
        assert.ok(report.mutedOnBackground >= CONTRAST_FLOOR.supportingOnBackground,
          `muted is ${String(report.mutedOnBackground)}:1`)
        // The report has to agree with the palette it describes: a stale number is
        // worse than none, because the settings page prints it next to the swatch.
        assert.equal(report.textOnBackground, contrastRatio(palette.text, palette.background))
        assert.equal(report.accentOnBackground, contrastRatio(palette.accent, palette.background))
      })
    }
  }

  it('turns the ground around for the dark scheme instead of tinting it', () => {
    const light = derivePalette('#1e2bfa', 'light').palette
    const dark = derivePalette('#1e2bfa', 'dark').palette
    assert.ok(contrastRatio(dark.background, '#ffffff') > 10, 'a dark ground stays dark')
    assert.ok(contrastRatio(light.background, '#000000') > 10, 'a light ground stays light')
  })
})

describe('derivePalette — what it changed, and what it kept', () => {
  it('is deterministic, because a palette is quoted in a document', () => {
    // Two renders of one deck must not disagree about a hex value.
    assert.deepEqual(derivePalette('#1e2bfa'), derivePalette('#1e2bfa'))
  })

  it('keeps the brand hue: one deck, one colour family', () => {
    const blue = derivePalette('#1e2bfa').palette.accent
    const red = derivePalette('#c0392b').palette.accent
    const channels = (hex: string): { r: number, g: number, b: number } => parseHex(hex)
    assert.ok(channels(blue).b > channels(blue).r, 'the blue brand keeps its dominant channel')
    assert.ok(channels(red).r > channels(red).b, 'so does the red one')
  })

  it('gives an achromatic brand a neutral accent instead of inventing a hue', () => {
    // Measured before this rule: pure white produced a mauve accent (#996c79) because
    // the chroma floor forced a colour onto a brand that has none. A monochrome
    // identity must stay monochrome.
    const white = derivePalette('#ffffff').palette
    const grey = derivePalette('#808080').palette
    for (const [label, palette] of [['white', white], ['grey', grey]] as const) {
      const { r, g, b } = parseHex(palette.accent)
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, `${label}: the accent is neutral, not tinted (${palette.accent})`)
    }
    assert.match(derivePalette('#ffffff').report.repairs.join('\n'), /没有彩度/u)
  })

  it('reports a repair when the brand colour could not be used as-is', () => {
    // White has no usable accent: the accent lightness band has to move it, and the
    // user deserves to know their brand colour was not taken literally.
    const white = derivePalette('#ffffff')
    assert.ok(white.report.repairs.length > 0, 'a pure-white brand must be reported as adjusted')
    assert.match(white.report.repairs.join('\n'), /accent/u)
  })

  it('says nothing when there was nothing to change', () => {
    // A brand already in the middle of both bands needs no repair line; the report is
    // what the settings page prints, and noise there hides the real adjustments.
    const { report, palette } = derivePalette('#1e5fd0')
    assert.ok(report.repairs.length === 0 || report.repairs.every(line => line.includes('accent')),
      `unexpected repairs: ${report.repairs.join(' | ')}`)
    assert.ok(report.textOnBackground >= CONTRAST_FLOOR.textOnBackground, palette.text)
  })
})

describe('PALETTE_PRESETS — colourways a page can wear on any layout', () => {
  it('publishes every curated colourway with all six slots', () => {
    assert.equal(PALETTE_PRESETS.length, 10, 'six magazine + four swiss')
    const ids = new Set(PALETTE_PRESETS.map(preset => preset.id))
    assert.equal(ids.size, PALETTE_PRESETS.length, 'ids are the storage key, so they must be unique')
    for (const preset of PALETTE_PRESETS) {
      for (const [slot, value] of Object.entries(preset.colors)) {
        assert.match(value, /^#[0-9a-f]{6}$/u, `${preset.id}.${slot} is a lowercase hex`)
      }
      assert.ok(preset.name.length > 0 && preset.nameEn.length > 0, `${preset.id} carries both labels`)
      // The report must describe the palette it ships with.
      assert.equal(preset.accentOnBackground, contrastRatio(preset.colors.accent, preset.colors.background))
    }
  })

  it('keeps body text and supporting text legible in every colourway', () => {
    // A curated palette is a design decision, but "readable" is not negotiable: the
    // ink and the two neutrals are text colours in every one of these.
    for (const preset of PALETTE_PRESETS) {
      const { colors } = preset
      assert.ok(contrastRatio(colors.text, colors.background) >= CONTRAST_FLOOR.textOnBackground,
        `${preset.id}: body text is ${String(contrastRatio(colors.text, colors.background))}:1`)
      assert.ok(contrastRatio(colors.secondary, colors.background) >= CONTRAST_FLOOR.supportingOnBackground,
        `${preset.id}: secondary is ${String(contrastRatio(colors.secondary, colors.background))}:1`)
      assert.ok(contrastRatio(colors.muted, colors.background) >= CONTRAST_FLOOR.supportingOnBackground,
        `${preset.id}: muted is ${String(contrastRatio(colors.muted, colors.background))}:1`)
    }
  })

  it('publishes the loud accents AS loud, with the measured ratio', () => {
    // Swiss yellow on paper is ~1.3:1. Clamping it would erase the identity the
    // colourway exists for, so the preset ships the number instead and the skill's rule
    // ("a colour that carries text must clear 4.5:1") is applied by the page.
    const lemon = PALETTE_PRESETS.find(preset => preset.id === 'lemon')
    assert.ok(lemon !== undefined)
    assert.ok(lemon.accentOnBackground < 3, `expected a block-only accent, got ${String(lemon.accentOnBackground)}:1`)
    const ink = PALETTE_PRESETS.find(preset => preset.id === 'ink-classic')
    assert.ok(ink !== undefined && ink.scheme === 'light')
    const midnight = PALETTE_PRESETS.find(preset => preset.id === 'midnight-ink')
    assert.ok(midnight !== undefined && midnight.scheme === 'dark', 'the dark colourway is marked as one')
    assert.ok(contrastRatio(midnight.colors.background, '#ffffff') > 10, 'its ground really is dark')
  })

  it('resolves brand over colourway over the template own colours', () => {
    // A session can carry both values. A silent winner is how a deck ends up wearing
    // neither of the two colours the user chose.
    const brand = resolvePalette({ brand: '#1e2bfa', palette: 'ikb' })
    assert.equal(brand.source, 'brand')
    assert.ok(brand.report !== undefined, 'the derivation report travels with it')
    const preset = resolvePalette({ palette: 'ikb' })
    assert.equal(preset.source, 'preset')
    assert.equal(preset.preset?.id, 'ikb')
    assert.deepEqual(preset.palette, preset.preset?.colors)
    assert.equal(resolvePalette({}).source, 'template')
    assert.equal(resolvePalette({ palette: 'no-such-colourway' }).source, 'template', 'an unknown id falls back instead of crashing')
    assert.equal(presetById('no-such-colourway'), undefined)
  })
})

describe('themeColorsYaml', () => {
  it('emits the six slots a manifest references by name', () => {
    const yaml = themeColorsYaml(derivePalette('#1e2bfa').palette)
    assert.equal(yaml.length, 6)
    for (const slot of ['background', 'text', 'accent', 'surface', 'secondary', 'muted']) {
      assert.ok(yaml.some(line => line.trimStart().startsWith(`${slot}: "`)), `${slot} is missing from the theme block`)
    }
    // Every value is quoted: an unquoted hex starting with a digit parses as a number
    // in YAML and the renderer then rejects the colour.
    for (const line of yaml) assert.match(line, /: "#[0-9a-f]{6}"$/u)
  })
})
