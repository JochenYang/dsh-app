/**
 * The settings-nav glyph contract the type checker cannot see.
 *
 * The settings shell maps a handful of section ids to icons and falls back to a
 * generic gear for everything else (`SettingsRoot`'s `navIcon`), and it exposes
 * no icon seat on `settings.section` — the registration options are `id`,
 * `order` and `label` only. Every suite section therefore had to paint its own
 * glyph through a stylesheet, matched to the rendered label text. Seven plugins
 * do; this one did not, so 代码图谱 wore the gear.
 *
 * Nothing catches a mistake here: `tsc` does not read a mask URL, the plugin
 * gates check imports and freshness, and the DOM this runs against exists only
 * in the running app. So the three facts a silent break would need are pinned
 * against the source text:
 *
 *   1. the mask URL is a well-formed, URL-encoded SVG (an unencoded `#` or `"`
 *      truncates it and the row renders with no glyph at all);
 *   2. the rule hides the shell's own `<svg>` first child — without that the
 *      gear stays visible beside the painted glyph, which is worse than either;
 *   3. the tagged class is one no other suite plugin owns, because the patch
 *      runs against the whole document.
 *
 * @module plugin-codegraph/tests/nav-icon
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, '..', 'src', 'client', 'nav-icon.ts')
const source = readFileSync(SOURCE, 'utf8')

/** The plugin's own nav cell class, as the module declares it. */
const cellClass = /const NAV_CELL_CLASS = '([^']+)'/u.exec(source)?.[1]

describe('settings-nav glyph', () => {
  it('declares a nav cell class', () => {
    assert.equal(typeof cellClass, 'string', 'NAV_CELL_CLASS must be a literal the test can read')
    assert.match(cellClass ?? '', /^dsh[A-Za-z]+Nav$/u, 'the suite convention is dsh<Name>Nav')
  })

  it('hides the shell\'s own icon before painting its own', () => {
    // The shell renders a fallback gear as the cell's first `<svg>` child; the
    // patch draws its glyph in `::before`, so the gear must be suppressed or
    // both show.
    assert.ok(
      source.includes('> svg:first-child { display: none; }'),
      'the fallback gear must be hidden, or the row shows two icons',
    )
  })

  it('paints through a mask so the glyph follows currentColor', () => {
    // A background-image would paint the SVG's own colours and stop following
    // the rail's active/hover states.
    assert.ok(source.includes('mask-image'), 'the glyph must be a mask, not a background image')
    assert.ok(source.includes('background-color: currentColor'), 'the mask must be filled with currentColor')
  })

  it('URL-encodes the SVG into the mask URL', () => {
    assert.ok(
      source.includes('encodeURIComponent(NAV_ICON_SVG)'),
      'an unencoded SVG truncates the data URL at its first # or "',
    )
  })

  it('draws on the 16 grid the rail uses', () => {
    assert.ok(source.includes('viewBox="0 0 16 16"'), 'the nav grid is 16px')
    assert.ok(source.includes('width: 16px; height: 16px'), 'the painted box must match the grid')
  })

  it('watches characterData, because a language switch rewrites the label in place', () => {
    // React rewrites a lone text child in place, which emits no childList
    // record: a childList-only observer would drop the tag on a language switch
    // and the gear would come back until the next unrelated mutation.
    assert.ok(source.includes('characterData: true'), 'the observer must see in-place text updates')
  })

  it('removes its tag on dispose', () => {
    // The patch tags cells across the whole document; leaving them behind would
    // keep painting the glyph after the plugin is gone.
    assert.ok(
      source.includes('classList.remove(NAV_CELL_CLASS)'),
      'dispose must take the tag off, not only remove the style',
    )
  })
})
