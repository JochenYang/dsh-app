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
    // The name flex item is LAYOUT only, and the tooltip anchors the inline span
    // inside it. A grow-able flex box filled the row — 164px of box for the 31px
    // word "Ruby" — and because the primitive measures its CHILD rect, the bubble
    // landed out over empty card. Two rules follow: the flex item never grows
    // past its text, and the anchor itself is an inline box, which is the shape
    // `plugin-archives` uses for the same reason.
    assert.match(rule('.dshcg_langName'), /flex:\s*0 1 auto/u, 'the name flex item hugs its text')
    assert.equal(/flex:\s*[1-9]/u.test(rule('.dshcg_langName')), false, 'a growing name box detaches the tooltip from the word it labels')
    assert.match(rule('.dshcg_langName'), /min-width:\s*0/u, 'a flex item cannot ellipsis without min-width: 0')
    assert.match(rule('.dshcg_langLabel'), /display:\s*inline/u, 'the tooltip anchor must be measured by its text, not by the layout')
    // Extracted from the block's OWN declarations, with its COMMENTS stripped.
    // Two false signals had to be removed to make this honest: `rule()` slices to
    // the next `}` so a neighbouring rule's `flex` leaked in, and the block's own
    // prose says "a flex item here would…", which matches a naive `/flex/` on the
    // full body. Neither is a declaration, and an assertion that trips on either
    // is testing the wrong text.
    const labelRuleBody = /\.dshcg_langLabel\s*\{([\s\S]*?)\}/u.exec(body)?.[1] ?? ''
    assert.ok(labelRuleBody !== '', '.dshcg_langLabel rule is missing')
    const labelDeclarations = labelRuleBody.replace(/\/\*[\s\S]*?\*\//gu, '')
    assert.equal(/flex/u.test(labelDeclarations), false, 'a flex spec on the anchor is what moved the bubble')
    assert.match(rule('.dshcg_langAction'), /flex:\s*0 0 auto/u, 'the action must keep its own width')
    // The action rides the right edge. The auto margin is safe now because the
    // card is two rows and this row holds only name + action, with the NAME the
    // one that shrinks — there is no second line for the button to fall onto.
    assert.match(rule('.dshcg_langAction'), /margin-left:\s*auto/u, 'the action lines up on the right down the grid')
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
    //
    // The branch is now a ternary over `name`, not over the JSX element: the
    // anchor is the label span INSIDE the name cell, so the `undefined` arm still
    // renders the name cell (and the ellipsis with it) while the other wraps only
    // the label in the primitive.
    assert.match(
      section,
      /bubble\.label === undefined\s*\n?\s*\?\s*<span className="dshcg_langName">/u,
      'the undefined arm must render the name cell with no Tooltip',
    )
    assert.match(section, /className="dshcg_langLabel"/u, 'the tooltip anchor must be the inline label span')
    // `portal` is the positioning fix, not a preference. The bubble is
    // `position: fixed`, and the settings dialog's panel carries a transform — a
    // transformed ancestor becomes the containing block for a fixed descendant, so
    // a bubble reading "php" appeared ~70px up and to the right of PHP. Portaling
    // to the body takes that ancestor out of the chain. Removing this prop brings
    // the offset back while every other assertion here still passes.
    assert.match(
      section,
      /<Tooltip label=\{bubble\.label\}[^>]*\sportal/u,
      'the language tooltip must portal out of the dialog panel',
    )
  })
})

describe('the graph view root', () => {
  /** The declarations of one rule, with comments stripped and no neighbours. */
  const declarationsOf = (body: string, selector: string): string => {
    const at = body.indexOf(`${selector} {`)
    assert.ok(at > 0, `${selector} rule is missing from the stylesheet`)
    const block = body.slice(at, body.indexOf('\n}', at))
    return block.replace(/\/\*[\s\S]*?\*\//gu, '')
  }

  it('owns the viewport height and the scroll', () => {
    // The defect this pins, seen on screen before any test caught it: the view
    // rendered, but its root carried only padding. The conversation view area is
    // a FIXED-height region, so a root without `height: 100%` leaves the body
    // collapsed — the page reads as empty and there is nothing to scroll.
    // `dsh-context` occupies this same seat with `height: 100%` + `overflow-y:
    // auto`, read off its installed `lc-root` rule.
    const body = readFileSync(SOURCE, 'utf8')
    const pad = declarationsOf(body, '.dshcg_viewPad')
    assert.match(pad, /flex:\s*1 1 auto/u, 'the view root must GROW inside the flex-column view area')
    assert.match(pad, /min-height:\s*0/u, 'a flex child cannot scroll without min-height: 0')
    assert.match(pad, /overflow-y:\s*auto/u, 'the view root must own the scroll')
    assert.match(pad, /box-sizing:\s*border-box/u, 'padding must not push the 100% height past the region')
    // The open-file branch is a SEPARATE root (the component returns it instead
    // of the overview), so it needs the same declarations. Pinning only the
    // overview root would let the file view collapse again.
    const file = declarationsOf(body, '.dshcg_viewFile')
    assert.match(file, /flex:\s*1 1 auto/u, 'the open-file root must grow inside the view area too')
    assert.match(file, /min-height:\s*0/u, 'the open-file root needs the zero minimum as well')
    assert.match(file, /overflow-y:\s*auto/u, 'the open-file root must own its scroll')
    assert.match(file, /box-sizing:\s*border-box/u, 'the open-file root must stay inside the region')
  })

  it('renders every branch inside a root that owns the height', () => {
    // A fragment cannot claim a height: the first version returned `<>…</>` for
    // the overview, so the stylesheet had no node to apply the rule to.
    const tab = readFileSync(join(pluginRoot, 'src', 'client', 'graph-tab.tsx'), 'utf8')
    assert.match(tab, /<div className="dshcg_viewPad">/u, 'the overview must return a real root element')
    assert.equal(
      /return \(\s*<>\s*\n\s*<svg/u.test(tab), false,
      'a fragment root leaves the view with no element to give a height to',
    )
  })
})

describe('the pane takeover', () => {
  it('hides the shell composer while this view is mounted', () => {
    // The composer belongs to the conversation shell — it renders as a SIBLING of
    // the scroll area, outside the view — so a view that wants the whole pane has
    // to say so. dsh-context does it with a has-rule keyed on its own root class
    // (`[data-conversation-scroll]:has(.lc-root) > [data-composer-seat]`), read off
    // its stylesheet; this is the same rule for this view's root.
    //
    // Hiding (not unmounting) is what keeps the shell's draft: the element stays,
    // so the composer's held state survives a takeover.
    const body = readFileSync(SOURCE, 'utf8')
    assert.match(
      body,
      /\[data-conversation-scroll\]:has\(\.dshcg_viewPad, \.dshcg_viewFile\)\s*>\s*\[data-composer-seat\]/u,
      'the composer seat must be hidden while this view owns the pane',
    )
    // The carve-out is load-bearing, not decoration: an approval, a question or a
    // plan review is the session WAITING on the user. Hiding those would trap it.
    assert.match(
      body,
      /data-composer-seat\]:not\(:has\(\[data-approval-key\], \[data-question-key\], \[data-plan-review-key\]\)\)/u,
      'an approval / question / plan review must survive the takeover',
    )
  })

  it('hides the transcript width handles, as a SIBLING', () => {
    // These handles are FOLLOWING SIBLINGS of the scroller, not descendants, so the
    // combinator must be `~`. A descendant selector matches nothing here — a rule
    // that looks right and does nothing, which is exactly how it was missed.
    const body = readFileSync(SOURCE, 'utf8')
    assert.match(
      body,
      /\[data-conversation-scroll\]:has\(\.dshcg_viewPad, \.dshcg_viewFile\)\s*~\s*\[data-width-handle\]/u,
      'the width handles must be hidden through a sibling combinator',
    )
    // And it must NOT be written as a descendant selector, which is the mistake.
    assert.equal(
      /\[data-conversation-scroll\]:has\([^)]*\)\s+\[data-width-handle\]/u.test(body),
      false,
      'a descendant selector for the width handles matches nothing',
    )
  })
})

describe('the graph view screens', () => {
  /** One rule's declarations, comments stripped, no neighbours. */
  const decls = (body: string, selector: string): string => {
    const at = body.indexOf(`${selector} {`)
    assert.ok(at > 0, `${selector} rule is missing from the stylesheet`)
    const block = body.slice(at, body.indexOf('\n}', at))
    return block.replace(/\/\*[\s\S]*?\*\//gu, '')
  }

  it('lays the file list out as aligned columns, not a ring', () => {
    // The ring was the first attempt and it failed on real data: long file names
    // beside short ones on a fixed-radius circle put every label on top of its
    // neighbour. Measured on the shipped build — `RapooBatteryTray.GlobalUsings
    // .g.cs` and `AutoStart.cs` overlapped completely.
    //
    // A grid with FIXED trailing tracks is what makes the bars and counts line up
    // down the column, which is the whole reason a list reads better here.
    const body = readFileSync(SOURCE, 'utf8')
    const file = decls(body, '.dshcg_file')
    assert.match(file, /display:\s*grid/u, 'each file row is a grid')
    // Every track but the name is a fixed length: an `auto` track would size to
    // its own content, so the bar would start at a different x on every row —
    // measured at 656px and 662px before this was fixed.
    const tracks = /grid-template-columns:([^;]+);/u.exec(file)?.[1] ?? ''
    assert.match(tracks, /minmax\(0,\s*1fr\)/u, 'the name absorbs the slack')
    assert.equal(/\bauto\b/u.test(tracks), false, 'a content-sized track makes the columns ragged')
    assert.equal(/dshcg_viewDot|dshcg_viewCanvas/u.test(body), false, 'the SVG ring is gone')
  })

  it('lays the file detail out as a real table', () => {
    // Three columns of three different kinds of fact, scanned down. The flex row
    // this replaces let every row size itself, so line numbers landed at a
    // different x per row.
    const body = readFileSync(SOURCE, 'utf8')
    assert.match(decls(body, '.dshcg_symbols'), /border-collapse:\s*collapse/u, 'the symbol list is a table')
    assert.match(decls(body, '.dshcg_symbolLine'), /text-align:\s*right/u, 'line numbers are right-aligned')
    // And the view must be opaque: the conversation pane paints a watermark
    // behind the transcript, which read straight through this table.
    assert.match(decls(body, '.dshcg_viewFile'), /background:\s*var\(--dsw-alias-bg-base\)/u, 'the detail root must paint its own background')
    assert.match(decls(body, '.dshcg_viewPad'), /background:\s*var\(--dsw-alias-bg-base\)/u, 'the overview root must paint its own background')
  })

  it('gives the back control a border and a focus ring', () => {
    // It was a borderless, padding-less `<button>` sitting in the title row, which
    // read as part of the heading — the one control on the screen whose whole job
    // is to look pressable.
    const body = readFileSync(SOURCE, 'utf8')
    const back = decls(body, '.dshcg_viewBack')
    assert.match(back, /border:\s*1px solid var\(--dsw-alias-border-l2\)/u, 'the back control needs a visible edge')
    assert.match(back, /padding:\s*4px 10px/u, 'and a real hit area')
    assert.match(decls(body, '.dshcg_viewBack:focus-visible'), /outline:/u, 'and a keyboard focus ring')
  })
})

describe('the clickable rows', () => {
  /** One rule's declarations, comments stripped. */
  const decls = (body: string, selector: string): string => {
    const at = body.indexOf(`${selector} {`)
    assert.ok(at > 0, `${selector} rule is missing from the stylesheet`)
    const block = body.slice(at, body.indexOf('\n}', at))
    return block.replace(/\/\*[\s\S]*?\*\//gu, '')
  }

  it('gives a file row a hover that is actually visible', () => {
    // Measured defect: the first hover used `bg-layer-2`, which resolves to the
    // SAME colour as `bg-base` in the light theme (#fff), so hovering a row
    // changed nothing on screen and the list read as plain text. The shell's own
    // interactive wash is a 6% ink tint and is what every other clickable row
    // uses.
    const body = readFileSync(SOURCE, 'utf8')
    const hover = decls(body, '.dshcg_file:hover')
    assert.match(hover, /background:\s*var\(--dsw-alias-interactive-bg-hover\)/u, 'the row must use the interactive wash')
    assert.equal(/--dsw-alias-bg-layer/u.test(hover), false, 'a layer token equals the base colour here, so it is invisible')
    // A press state too: hover alone leaves the click feeling unacknowledged.
    assert.match(decls(body, '.dshcg_file:active'), /--dsw-alias-interactive-bg-active/u, 'a pressed row must darken')
  })

  it('gives a symbol row the same hover', () => {
    const body = readFileSync(SOURCE, 'utf8')
    const hover = decls(body, '.dshcg_symbols tbody tr:hover')
    assert.match(hover, /--dsw-alias-interactive-bg-hover/u, 'the table row must use the interactive wash')
    assert.equal(/--dsw-alias-bg-layer/u.test(hover), false, 'and not a layer token')
  })
})
