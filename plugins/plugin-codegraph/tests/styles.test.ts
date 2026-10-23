/**
 * The stylesheet contract the type checker cannot see.
 *
 * A CSS custom property that is not defined makes its whole declaration invalid,
 * so `color: var(--dsw-alias-text-secondary)` on a token nobody defines silently
 * falls back to the inherited colour. This module shipped exactly that: it named
 * `text-*`, `bg-secondary`, `bg-tertiary` and `state-warning-*`, none of which
 * exist — the real families are `label-*`, `bg-layer-*` and `state-warn-*`. Eight
 * settings pages then had a subtle visual hierarchy this one lacked, and every
 * amber warning (including "behind the working tree", the plugin's whole reason
 * to exist) rendered as plain secondary text.
 *
 * Nothing caught it: `tsc` does not read CSS, the suites test code, and the plugin
 * gates check imports and freshness. So the token set is pinned HERE, against the
 * primitive package's own stylesheets — the authority for what a `--dsw-alias-*`
 * name may be. A typo becomes a red test instead of a colourless pill.
 *
 * The same file pins the repo's two CSS rules: no hardcoded colours (a literal
 * hex cannot follow a theme) and no backticks inside the template literal (one
 * would end the string and break the build in a place that looks like a CSS bug).
 *
 * @module plugin-codegraph/tests/styles
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { referencedTokens } from '../src/client/styles.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const SOURCE = join(pluginRoot, 'src', 'client', 'styles.ts')
// The alias tokens are DEFINED by the theme package's design variables, not by
// the primitives (which only reference them). Resolved from the repo root because
// the theme package is not a dependency of this plugin — it is the shell's.
const THEME_CLIENT = join(pluginRoot, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js')

/** Every `--dsw-alias-*` name the theme package defines. */
function themeTokens(): Set<string> {
  const tokens = new Set<string>()
  const body = readFileSync(THEME_CLIENT, 'utf8')
  for (const match of body.matchAll(/(--dsw-alias-[a-z0-9-]+)\s*:/gu)) tokens.add(match[1]!)
  return tokens
}

describe('stylesheet', () => {
  it('references only token names the theme package actually defines', () => {
    // The failure this prevents has no runtime error and no type error: an
    // undefined custom property just makes the declaration vanish. This module
    // shipped `text-*`, `bg-secondary` and `state-warning-*`, none of which exist.
    const defined = themeTokens()
    assert.ok(defined.size > 0, 'the theme stylesheet was not found; the check would pass vacuously')
    const used = referencedTokens()
    assert.ok(used.length > 0, 'no tokens found in the stylesheet')
    const unknown = used.filter(token => !defined.has(token)).sort()
    assert.deepEqual(
      unknown,
      [],
      `these tokens are not defined by the theme, so every declaration using them is dropped: ${unknown.join(', ')}`,
    )
  })

  it('never hardcodes a colour', () => {
    // A literal colour cannot follow the light/dark theme; the whole suite uses
    // alias tokens for exactly that reason.
    const body = readFileSync(SOURCE, 'utf8')
    const literals = body.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []
    assert.deepEqual(literals, [], `literal colours found: ${literals.join(', ')}`)
  })

  it('carries no backtick inside the template literal', () => {
    // The stylesheet lives in a template string, so a backtick inside it ends the
    // string early and the rest becomes a syntax error that reads like a CSS
    // problem. Measured three times while writing the row rules: prose in a CSS
    // comment named a property in backticks, and the failure surfaced as
    // "Expected ';' found 'flex'" pointing at the comment.
    //
    // esbuild catches this first — the suite cannot even bundle a broken literal —
    // so this is not a net that catches a NEW mistake. It is a READABLE failure for
    // the case where someone bisects by hand, and it documents the rule where a
    // reader of the stylesheet will meet it.
    //
    // The JSDoc above the literal legitimately carries backticks, so the check
    // cannot count them in the whole file. It finds the opening backtick and then
    // the LAST line that is exactly a closing one. Slicing to the FIRST
    // "newline + backtick" is what the earlier version did: an embedded backtick
    // became the "end", so the range it inspected was a fragment with no backticks
    // in it, and a broken file passed.
    const body = readFileSync(SOURCE, 'utf8')
    const lines = body.split('\n')
    const open = lines.findIndex(line => line.startsWith('const cssText = `'))
    assert.ok(open >= 0, 'the cssText template literal was not found')
    // The template ends on a line that is just a backtick; take the LAST such
    // line so an embedded one cannot shorten the range.
    let close = -1
    for (let index = open + 1; index < lines.length; index += 1) {
      if (lines[index] === '`') close = index
    }
    assert.ok(close > open, 'the cssText template literal is not closed')
    const literal = lines.slice(open + 1, close).join('\n')
    const inside = [...literal].filter(character => character === '`').length
    assert.equal(inside, 0, `${inside} backtick(s) inside the CSS template would terminate the string`)
  })

  it('keeps the language card from squeezing its action and its name', () => {
    // This is the SOURCE half of two defects measured in a real layout
    // (`scripts/probe-codegraph-langs.cjs`). The first: with the default
    // `flex-shrink: 1` the action button compressed to ~32px and its two-character
    // label broke onto two lines. The second, which the first fix produced and a
    // screenshot caught: on ONE flat wrapped line the button dropped below the
    // tags and an auto margin pushed it to the right edge, so neighbouring cards
    // in the grid had different heights. The card is two rows now.
    const body = readFileSync(SOURCE, 'utf8')
    const rule = (selector: string): string => {
      const start = body.indexOf(`${selector} {`)
      assert.ok(start > 0, `${selector} rule is missing from the stylesheet`)
      const end = body.indexOf('}', start)
      assert.ok(end > start, `${selector} rule is not closed`)
      return body.slice(start, end)
    }
    // The card stacks its two rows instead of wrapping one line.
    assert.match(rule('.dshcg_lang'), /flex-direction:\s*column/u, 'the card must stack its rows, not wrap one line')
    assert.equal(/flex-wrap/u.test(rule('.dshcg_lang')), false, 'a wrapping card is what stranded the action on its own line')
    assert.match(rule('.dshcg_langName'), /flex:\s*1 1 auto/u, 'the name absorbs the slack the action leaves')
    assert.match(rule('.dshcg_langName'), /min-width:\s*0/u, 'a flex item cannot ellipsis without min-width: 0')
    assert.match(rule('.dshcg_langAction'), /flex:\s*0 0 auto/u, 'the action must keep its own width')
    assert.equal(/margin-left:\s*auto/u.test(rule('.dshcg_langAction')), false, 'an auto margin is what pushed a stranded button to the edge')
    // The project row holds the same control shape (`重新索引`), so it needs the
    // same rule. Fixing only the row a screenshot happened to show is how this
    // class of defect survives.
    assert.match(rule('.dshcg_row'), /flex-wrap:\s*wrap/u, 'the project row must wrap too')
    assert.match(body, /\.dshcg_row > button\s*\{[^}]*flex:\s*0 0 auto/u, 'a control inside the project row must not shrink')
  })

  it('pins the row STRUCTURE, not only the stylesheet', () => {
    // The stylesheet fix alone is not the fix. `probe-codegraph-langs.cjs`
    // measures the CSS against a hand-written row, so deleting the
    // `.dshcg_langAction` wrapper from the component — the ORIGINAL defect
    // shape, a bare button with no `flex` rule at all — left that probe green.
    // These assertions read the component, so the two halves are pinned
    // together: the rule AND the node it applies to.
    const section = readFileSync(join(pluginRoot, 'src', 'client', 'section.tsx'), 'utf8')
    assert.match(section, /className="dshcg_langAction"/u, 'the action must stay inside the wrapper the stylesheet targets')
    // The CSS shapes two rows, so the component must emit two rows: name and
    // action together, tags below. A component that went back to one flat line
    // would make every measured geometry above describe a DOM nobody renders.
    assert.match(section, /className="dshcg_langMain"/u, 'the first row holds the name and its action')
    assert.match(section, /className="dshcg_langMeta"/u, 'the second row holds the tags')
    // An EMPTY tooltip label renders an empty bubble (the primitives document
    // `label: ''` as "shortcut keys only"), so a row whose extensions are empty
    // must render no Tooltip at all rather than a blank one. `row.ts` answers
    // `undefined` for that case; this asserts the CALL SITE honours it, which is
    // what actually stops the bubble.
    assert.match(
      section,
      /\{bubble\.label === undefined\s*\?\s*name\s*:\s*<Tooltip/u,
      'a language with no extensions must render no Tooltip',
    )
  })
})
