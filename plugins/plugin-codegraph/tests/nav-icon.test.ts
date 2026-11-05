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
 *   2. the rule hides the shell's own icon cell — without that the gear stays
 *      visible beside the painted glyph, which is worse than either;
 *   3. the tagged class is one no other suite plugin owns, because the patch
 *      runs against the whole document.
 *
 * @module plugin-codegraph/tests/nav-icon
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
    // 0.2.2-rc.1 renders the shell's glyph inside a `.navIcon` cell whose class
    // carries a build hash; the patch draws its glyph in `::before`, so the cell
    // must be suppressed or both show.
    assert.ok(
      source.includes('button.${NAV_CELL_CLASS} [class*="navIcon"]'),
      'the shell\'s icon cell must be hidden, or the row shows two icons',
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

/** The raw icon-hiding line of one copy, trimmed. */
function hideRuleLine(text: string): string | undefined {
  return text
    .split('\n')
    .find((row) => row.includes('display: none; }') && row.includes('navIcon'))
    ?.trim()
}

/** Normalize an icon-hiding rule so copies written in different shapes compare. */
function hideRule(text: string): string | undefined {
  const line = hideRuleLine(text)
  if (line === undefined) return undefined
  return line
    .replace(/[`',]/gu, '')
    .replace(/\$\{[^}]+\}/gu, '<CELL>')
    .replace(/dsh[A-Za-z]+Nav/gu, '<CELL>')
    .trim()
}

/** The class token a copy's rule paints, normalized to the identifier it uses. */
function ruleToken(line: string): string | undefined {
  const match = /button\.(\$\{[^}]+\}|[A-Za-z0-9_$-]+)/u.exec(line)
  return match?.[1]?.replace(/[$'`"{}\s]/gu, '')
}

/** The class token a copy tags its rows with, normalized the same way. */
function tagToken(text: string): string | undefined {
  const match = /classList\.add\(([^()]+)\)/u.exec(text)
  return match?.[1]?.replace(/[$'`"{}\s]/gu, '')
}

/**
 * The same rule lives in every plugin that paints a rail glyph.
 *
 * The suite ships no shared package, so each of them carries its own copy of the
 * stylesheet. A copy that keeps the pre-0.2.2-rc.1 selector compiles, passes all
 * four artifact gates, and still draws the shell's default gear beside its own
 * glyph: the doubling is visible only in the running app, on that one row. That
 * is how it shipped — this test is what would have caught it.
 *
 * Two things it therefore pins beyond "the copies agree":
 *
 *   1. the rule names the class THE SAME COPY tags its rows with. Agreeing text
 *      with the wrong class is still a doubled icon, and it is the mistake a
 *      normalized comparison of two interpolated rules cannot see;
 *   2. the copies are DISCOVERED, not listed. A ninth glyph added tomorrow is
 *      covered the moment it exists, instead of after someone remembers this file.
 */
describe('settings-nav glyph copies', () => {
  /** Every suite source that paints a glyph, found by the rule it carries. */
  function copies(): { name: string, text: string }[] {
    const pluginsDir = fileURLToPath(new URL('../../', import.meta.url))
    const found: { name: string, text: string }[] = []
    for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!plugin.isDirectory() || !plugin.name.startsWith('plugin-')) continue
      const src = join(pluginsDir, plugin.name, 'src')
      if (!existsSync(src)) continue
      // Only `src/`: recursing into a plugin's `node_modules` would scan tens of
      // thousands of third-party files for a rule none of them carries.
      for (const entry of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
        if (!/\.(?:ts|tsx)$/u.test(entry)) continue
        const text = readFileSync(join(src, entry), 'utf8')
        // Matched by the ATTRIBUTE SELECTOR, allowing any quoting and spacing: a
        // copy that writes `[class*=navIcon]` is still a copy, and keying discovery
        // on one spelling is how a ninth one stays invisible.
        if (!/\[class\*=\s*['"]?navIcon/u.test(text)) continue
        found.push({ name: `${plugin.name}/${entry}`, text })
      }
    }
    return found
  }

  it('hides the shell icon cell in every copy, identically', () => {
    const rules = copies().map(({ name, text }) => ({ name, rule: hideRule(text) }))
    assert.ok(rules.length >= 8, `expected at least 8 glyph copies, found ${String(rules.length)}`)
    for (const { name, rule } of rules) {
      assert.ok(rule !== undefined, `${name} has no rule hiding the shell's icon`)
    }
    const distinct = new Set(rules.map(({ rule }) => rule))
    assert.equal(
      distinct.size,
      1,
      `copies disagree:\n${rules.map(({ name, rule }) => `  ${name}: ${String(rule)}`).join('\n')}`,
    )
    assert.ok(
      [...distinct][0]?.includes('[class*="navIcon"]'),
      'the rule must hide the shell\'s icon cell by class substring, not by position',
    )
  })

  it('paints the class each copy actually tags its rows with', () => {
    for (const { name, text } of copies()) {
      const raw = hideRuleLine(text)
      assert.ok(raw !== undefined, `${name} has no icon-hiding rule`)
      // The RAW line, not the normalized one: normalizing replaces the class with
      // a placeholder, which is exactly the difference this case exists to see.
      const painted = ruleToken(raw)
      const tagged = tagToken(text)
      assert.ok(tagged !== undefined, `${name} never tags a row, so its glyph cannot appear`)
      assert.equal(
        painted,
        tagged,
        `${name} paints "${String(painted)}" but tags rows with "${String(tagged)}"`,
      )
    }
  })
})
