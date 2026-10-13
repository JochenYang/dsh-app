/**
 * The level's colours, pinned.
 *
 * This is the part of the capsule whose failure is invisible to every other gate:
 * a colour is a string, so a wrong one compiles, builds and renders. Three things
 * are asserted rather than assumed — that the WCAG implementation here agrees with
 * the contrast values the stylesheet's own header recorded (an independent
 * measurement made before this module existed), that the name and the ring clear
 * their floors on EVERY surface they can be drawn on (both hover backgrounds, and
 * the composer capsule's own card among them), and that the neutral ring's real
 * token value does too.
 *
 * The sweep is the point. Checking the stops would pass for a ramp whose middle is
 * too light, and the middle is where most levels sit; checking one surface would
 * pass for a name that is unreadable exactly while it is being dragged.
 *
 * @module plugin-effort/tests/value-color
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  FILL_RAMP_DARK,
  FILL_RAMP_LIGHT,
  NEUTRAL_RING,
  RING_ALPHA_DARK,
  RING_ALPHA_LIGHT,
  RING_SURFACES_DARK,
  RING_SURFACES_LIGHT,
  TEXT_BASIS_DARK,
  TEXT_BASIS_LIGHT,
  TEXT_SURFACES_DARK,
  TEXT_SURFACES_LIGHT,
  alphaOf,
  contrastRatio,
  fillGradient,
  isDarkTheme,
  mixHex,
  over,
  rampColorAt,
  relativeLuminance,
  ringColorAt,
  textColorAt,
  textColorFor,
} from '../src/client/value-color.ts'

/** WCAG 2.x AA for body text. */
const TEXT_FLOOR = 4.5

/** WCAG 2.x AA for a graphical object. */
const GRAPHIC_FLOOR = 3

/**
 * The real values of the two tokens `NEUTRAL_RING` names, read from
 * `@deepseek-ai/dsh-client-ui-theme` on the installed line: `label-tertiary` is
 * `--dsw-static-neutral-bluish-600` in light and `-400` in dark.
 */
const LABEL_TERTIARY = { light: '#81858c', dark: '#adb2b8' }

/** The value the token falls back to when a host has no theme variables. */
const NEUTRAL_FALLBACK = '#6b7280'

/**
 * `--dsw-specific-input-major` in the dark theme: the card the COMPOSER capsule
 * draws on, read from `@deepseek-ai/dsh-client-ui-theme` on the installed line
 * (`--dsw-static-neutral-bluish-850`). In the light theme that token is `#FFFFFF`,
 * which is already in the light surface list.
 */
const COMPOSER_CARD = '#2C2C2E'

/**
 * @param actual - the measured value.
 * @param expected - the recorded one.
 * @param tolerance - how far apart they may be.
 */
function close(actual: number, expected: number, tolerance = 0.005): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, measured ${actual}`,
  )
}

/**
 * The channels and alpha of an `rgb(r g b / a%)` colour.
 * @param color - the colour.
 * @returns its channels and its `#RRGGBBAA` form.
 */
function rgbaOf(color: string): { readonly rgb: readonly number[], readonly alpha: number, readonly eight: string } {
  const match = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/u.exec(color)
  assert.ok(match !== null, `not an rgb()/alpha colour: ${color}`)
  const rgb = [Number(match[1]), Number(match[2]), Number(match[3])]
  const alpha = Number(match[4]) / 100
  const hex = rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')
  return { rgb, alpha, eight: `#${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` }
}

describe('contrastRatio', () => {
  it('agrees with the values the stylesheet recorded', () => {
    // Written into styles.ts before this module existed, from the same WCAG
    // definition. Agreement is what makes the ramp below trustworthy.
    close(contrastRatio('#3A5BD9', '#FFFFFF'), 5.71)
    close(contrastRatio('#3A5BD9', '#F5F5F5'), 5.24)
    close(contrastRatio('#5686FE', '#FFFFFF'), 3.37)
    close(contrastRatio('#4B3FD6', '#FFFFFF'), 7.04)
  })

  it('is symmetric and bounded', () => {
    close(contrastRatio('#FFFFFF', '#000000'), 21, 0.001)
    close(contrastRatio('#000000', '#FFFFFF'), 21, 0.001)
    close(contrastRatio('#777777', '#777777'), 1, 0.001)
  })

  it('refuses a colour it cannot read rather than guessing one', () => {
    assert.throws(() => relativeLuminance('red'), TypeError)
    assert.throws(() => relativeLuminance('#abc'), TypeError)
    assert.throws(() => mixHex('#12345', '#FFFFFF', 0.5), TypeError)
    assert.throws(() => rampColorAt([], 0.5), TypeError)
  })
})

describe('over', () => {
  it('composites an alpha colour the way a browser does', () => {
    // The theme's own hover colours, which is what the surfaces below are made of.
    assert.equal(over('#FFFFFF', '#2631480f'), '#F2F3F4')
    assert.equal(over('#F5F5F5', '#2631480f'), '#E9E9EB')
    assert.equal(over('#292929', '#ffffff14'), '#3A3A3A')
    assert.equal(over('#212123', '#ffffff14'), '#323234')
    // The composer capsule's own card (`--dsw-specific-input-major` in the dark
    // theme) and its hover: the surface the dark basis is computed against.
    assert.equal(over('#2C2C2E', '#ffffff14'), '#3D3D3E')
  })

  it('is the colour itself at full alpha, and the surface at none', () => {
    assert.equal(over('#123456', '#ABCDEF'), '#ABCDEF')
    assert.equal(over('#123456', '#ABCDEF00'), '#123456')
  })
})

describe('the fill ramp', () => {
  it('is the gradient the stylesheet ships', () => {
    assert.equal(
      fillGradient(FILL_RAMP_LIGHT),
      'linear-gradient(90deg, #5686FE 0%, #4176E6 42%, #3A5BD9 72%, #4B3FD6 100%)',
    )
    assert.equal(
      fillGradient(FILL_RAMP_DARK),
      'linear-gradient(90deg, #7AAAFF 0%, #8FB0FF 45%, #A98BFF 78%, #B9A6FF 100%)',
    )
  })

  it('hits its stops exactly and interpolates between them', () => {
    for (const ramp of [FILL_RAMP_LIGHT, FILL_RAMP_DARK]) {
      for (const stop of ramp) assert.equal(rampColorAt(ramp, stop.at), stop.color)
      // Halfway between the first two stops is the midpoint of their colours.
      const half = (ramp[0]?.at ?? 0) / 2 + (ramp[1]?.at ?? 0) / 2
      assert.equal(rampColorAt(ramp, half), mixHex(ramp[0]?.color ?? '', ramp[1]?.color ?? '', 0.5))
    }
  })

  it('clamps a position outside the travel instead of extrapolating', () => {
    assert.equal(rampColorAt(FILL_RAMP_LIGHT, -1), FILL_RAMP_LIGHT[0]?.color)
    assert.equal(rampColorAt(FILL_RAMP_LIGHT, 2), FILL_RAMP_LIGHT[3]?.color)
    assert.equal(rampColorAt(FILL_RAMP_DARK, Number.NaN), FILL_RAMP_DARK[0]?.color)
  })

  it('clears the graphical floor at every position, in both themes', () => {
    // The track's own bar may sit at 3:1; that is why the name needs lifting.
    for (const [ramp, surfaces] of [[FILL_RAMP_LIGHT, RING_SURFACES_LIGHT], [FILL_RAMP_DARK, RING_SURFACES_DARK]] as const) {
      for (let step = 0; step <= 200; step += 1) {
        const color = rampColorAt(ramp, step / 200)
        for (const surface of surfaces) {
          assert.ok(
            contrastRatio(color, surface) >= GRAPHIC_FLOOR,
            `${color} is only ${contrastRatio(color, surface).toFixed(2)}:1 on ${surface}`,
          )
        }
      }
    }
  })
})

describe('textColorFor', () => {
  it('leaves a colour that already clears the floor alone', () => {
    assert.equal(textColorFor('#3A5BD9', '#FFFFFF'), '#3A5BD9')
    assert.equal(textColorFor('#7AAAFF', '#292929'), '#7AAAFF')
  })

  it('darkens on a light card, by the least that clears', () => {
    const surface = '#E9E9EB'
    const lifted = textColorFor('#5686FE', surface)
    assert.notEqual(lifted, '#5686FE')
    // One step short is still under the floor: the lift is not a round number
    // somebody liked, it is the first 1% mix that passes.
    let step = 0.01
    let previous = '#5686FE'
    while (step < 1 && mixHex('#5686FE', '#000000', step) !== lifted) {
      previous = mixHex('#5686FE', '#000000', step)
      step += 0.01
    }
    assert.ok(contrastRatio(previous, surface) < TEXT_FLOOR, 'the lift overshot the floor')
    assert.ok(contrastRatio(lifted, surface) >= TEXT_FLOOR)
    assert.ok(contrastRatio(lifted, surface) <= 4.65, 'the lift went further than the floor requires')
  })

  it('lightens on a dark card, whatever the colour started as', () => {
    const lifted = textColorFor('#000000', '#3A3A3A')
    assert.ok(relativeLuminance(lifted) > relativeLuminance('#000000'), 'a black fill was darkened further')
    assert.ok(contrastRatio(lifted, '#3A3A3A') >= TEXT_FLOOR)
    assert.ok(contrastRatio(lifted, '#3A3A3A') <= 4.65, 'the lift went further than the floor requires')
  })

  it('decides the direction by the surface, so it always has an answer', () => {
    // A surface that is neither clearly light nor clearly dark still resolves: the
    // crossover is where the two directions are equally strong.
    const lifted = textColorFor('#808080', '#808080')
    assert.ok(contrastRatio(lifted, '#808080') >= TEXT_FLOOR)
  })
})

describe('textColorAt', () => {
  it('clears the text floor at every position, on every surface it can be drawn on', () => {
    for (const [dark, surfaces] of [[false, TEXT_SURFACES_LIGHT], [true, TEXT_SURFACES_DARK]] as const) {
      for (let step = 0; step <= 200; step += 1) {
        const pct = step / 200
        const name = textColorAt(pct, dark)
        for (const surface of surfaces) {
          assert.ok(
            contrastRatio(name, surface) >= TEXT_FLOOR,
            `${name} at ${pct} is only ${contrastRatio(name, surface).toFixed(2)}:1 on ${surface}`,
          )
        }
      }
    }
  })

  it('includes the hover backgrounds in those surfaces, as the strictest ones', () => {
    // The basis is not decoration: it is the hover colour over the worst card of the
    // theme, and it is what the lift is computed against. Without it the dark third
    // stop would sit at 4.04:1 exactly while the pointer is on the composer's model
    // trigger — the surface the level is read from before the menu is ever opened.
    assert.equal(TEXT_BASIS_LIGHT, over('#F5F5F5', '#2631480f'))
    assert.equal(TEXT_BASIS_DARK, over(COMPOSER_CARD, '#ffffff14'))
    assert.ok(TEXT_SURFACES_LIGHT.includes(TEXT_BASIS_LIGHT))
    assert.ok(TEXT_SURFACES_DARK.includes(TEXT_BASIS_DARK))
    // The composer's card is one of the name's surfaces in both themes: in the light
    // theme it IS the white surface, in the dark theme it is a third, lighter card.
    assert.ok(TEXT_SURFACES_LIGHT.includes('#FFFFFF'))
    assert.ok(TEXT_SURFACES_DARK.includes(COMPOSER_CARD))
    assert.ok(contrastRatio('#A98BFF', TEXT_BASIS_DARK) < TEXT_FLOOR)
    // And it IS the strictest: at every position the name is closer to the floor
    // on the basis than on any other surface of its theme.
    for (const [dark, surfaces, basis] of [
      [false, TEXT_SURFACES_LIGHT, TEXT_BASIS_LIGHT],
      [true, TEXT_SURFACES_DARK, TEXT_BASIS_DARK],
    ] as const) {
      for (let step = 0; step <= 50; step += 1) {
        const name = textColorAt(step / 50, dark)
        for (const surface of surfaces) {
          assert.ok(
            contrastRatio(name, basis) <= contrastRatio(name, surface),
            `${surface} is stricter than the basis at ${step / 50}`,
          )
        }
      }
    }
  })

  it('is the ramp itself wherever the ramp already clears the floor', () => {
    // The dark ramp is text-level on its own surfaces at three of four stops, so
    // the name and the track agree there; in light only the two darkest stops do.
    assert.equal(textColorAt(0, true), rampColorAt(FILL_RAMP_DARK, 0))
    assert.equal(textColorAt(1, true), rampColorAt(FILL_RAMP_DARK, 1))
    assert.equal(textColorAt(1, false), rampColorAt(FILL_RAMP_LIGHT, 1))
    assert.notEqual(textColorAt(0, false), rampColorAt(FILL_RAMP_LIGHT, 0))
  })

  it('lifts exactly the stops that need it', () => {
    assert.deepEqual(
      FILL_RAMP_LIGHT.map(stop => textColorFor(stop.color, TEXT_BASIS_LIGHT)),
      ['#4165BF', '#3865C6', '#3A5BD9', '#4B3FD6'],
    )
    assert.deepEqual(
      FILL_RAMP_DARK.map(stop => textColorFor(stop.color, TEXT_BASIS_DARK)),
      ['#7AAAFF', '#8FB0FF', '#B297FF', '#B9A6FF'],
    )
  })

  it('moves in the ramp\'s own direction', () => {
    assert.ok(relativeLuminance(textColorAt(1, false)) < relativeLuminance(textColorAt(0, false)))
    assert.ok(relativeLuminance(textColorAt(1, true)) > relativeLuminance(textColorAt(0, true)))
  })

  it('clamps a position outside the travel instead of extrapolating', () => {
    assert.equal(textColorAt(-1, false), textColorAt(0, false))
    assert.equal(textColorAt(2, true), textColorAt(1, true))
    assert.equal(textColorAt(Number.NaN, false), textColorAt(0, false))
  })

  it('keeps the light name inside a step of the ramp it shades', () => {
    // Two rounding effects are allowed for, both measured: one 8-bit step puts
    // luminance back by up to ~4e-4, and the light theme's lift is quantised to 1%
    // steps, which lets the name's luminance wobble by up to ~3.1e-3 while the
    // ramp underneath descends.
    //
    // Only the light ramp is checked per step. The DARK ramp is not
    // luminance-monotone at all — its middle segment trades green for red
    // (#8FB0FF → #A98BFF), which drops luminance while the level rises — so a
    // per-step assertion there would pin the wrong property; its direction is
    // asserted at the ends instead.
    const wobble = 5e-3
    let previous = relativeLuminance(textColorAt(0, false))
    for (let step = 1; step <= 50; step += 1) {
      const current = relativeLuminance(textColorAt(step / 50, false))
      assert.ok(current <= previous + wobble, `the light name brightened at ${step / 50}`)
      previous = current
    }
  })
})

describe('ringColorAt', () => {
  it('is the name\'s own colour at the theme\'s alpha', () => {
    for (const pct of [0, 0.42, 0.72, 1]) {
      const light = rgbaOf(ringColorAt(pct, false))
      assert.deepEqual(light.rgb, rgbaOf(alphaOf(textColorAt(pct, false), RING_ALPHA_LIGHT)).rgb)
      assert.equal(light.alpha, RING_ALPHA_LIGHT)
      assert.equal(rgbaOf(ringColorAt(pct, true)).alpha, RING_ALPHA_DARK)
    }
  })

  it('stays visible: the composited edge clears the graphical floor everywhere', () => {
    for (const [dark, surfaces] of [[false, RING_SURFACES_LIGHT], [true, RING_SURFACES_DARK]] as const) {
      for (let step = 0; step <= 200; step += 1) {
        const pct = step / 200
        const ring = rgbaOf(ringColorAt(pct, dark))
        for (const surface of surfaces) {
          const edge = over(surface, ring.eight)
          assert.ok(
            contrastRatio(edge, surface) >= GRAPHIC_FLOOR,
            `${dark ? 'dark' : 'light'} edge ${edge} at ${pct} is only ${contrastRatio(edge, surface).toFixed(2)}:1 on ${surface}`,
          )
        }
      }
    }
  })

  it('falls back to a neutral edge that is visible in both themes', () => {
    assert.ok(NEUTRAL_RING.includes('var(--dsw-alias-label-tertiary'), 'the neutral edge does not follow the theme')
    assert.ok(NEUTRAL_RING.includes(NEUTRAL_FALLBACK), 'the neutral edge has no fallback for a host without tokens')
    // No ramp colour in it: an unset scale must not be edged in the lowest level.
    for (const stop of FILL_RAMP_LIGHT) assert.ok(!NEUTRAL_RING.includes(stop.color), 'the neutral edge claims a level')
    // Measured at the level ring's own alpha the token gives only 2.93:1 / 2.73:1
    // on the light cards, so the neutral edge is opaque. Both the real token and
    // the hardcoded fallback have to clear the floor in both themes.
    for (const surface of RING_SURFACES_LIGHT) {
      assert.ok(contrastRatio(LABEL_TERTIARY.light, surface) >= GRAPHIC_FLOOR, `tertiary on ${surface}`)
      assert.ok(contrastRatio(NEUTRAL_FALLBACK, surface) >= GRAPHIC_FLOOR, `fallback on ${surface}`)
    }
    for (const surface of RING_SURFACES_DARK) {
      assert.ok(contrastRatio(LABEL_TERTIARY.dark, surface) >= GRAPHIC_FLOOR, `tertiary on ${surface}`)
      assert.ok(contrastRatio(NEUTRAL_FALLBACK, surface) >= GRAPHIC_FLOOR, `fallback on ${surface}`)
    }
  })
})

describe('alphaOf', () => {
  it('writes a colour as rgb() with its alpha', () => {
    assert.equal(alphaOf('#4B3FD6', 0.85), 'rgb(75 63 214 / 85%)')
    assert.equal(alphaOf('#000000', 1), 'rgb(0 0 0 / 100%)')
    assert.equal(alphaOf('#FFFFFF', 4), 'rgb(255 255 255 / 100%)')
  })
})

describe('mixHex', () => {
  it('mixes per channel in sRGB', () => {
    assert.equal(mixHex('#000000', '#FFFFFF', 0.5), '#808080')
    assert.equal(mixHex('#000000', '#FFFFFF', 0), '#000000')
    assert.equal(mixHex('#000000', '#FFFFFF', 1), '#FFFFFF')
  })
})

describe('isDarkTheme', () => {
  it('reads the attribute the stylesheet keys on, and only there', () => {
    const dark = { body: { hasAttribute: (name: string) => name === 'data-ds-dark-theme' } }
    const light = { body: { hasAttribute: () => false } }
    assert.equal(isDarkTheme(dark as unknown as Document), true)
    assert.equal(isDarkTheme(light as unknown as Document), false)
  })

  it('answers "light" for a document it cannot read', () => {
    assert.equal(isDarkTheme(null), false)
    assert.equal(isDarkTheme({} as Document), false)
    assert.equal(isDarkTheme({ body: {} } as unknown as Document), false)
  })
})
