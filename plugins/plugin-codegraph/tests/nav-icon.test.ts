/**
 * The settings-nav glyph: what the patch does to a page, and what every copy
 * agrees on.
 *
 * The settings shell maps a handful of section ids to icons and falls back to a
 * generic gear for everything else (`SettingsRoot`'s `navIcon`), and it exposes
 * no icon seat on `settings.section` — the registration options are `id`,
 * `order` and `label` only. Every suite section therefore had to paint its own
 * glyph through a stylesheet, matched to the rendered label text. Seven plugins
 * do; this one did not, so 代码图谱 wore the gear.
 *
 * `tsc` does not read a mask URL, the plugin gates check imports and freshness,
 * and the DOM this runs against exists only in the running app. So the first
 * block RUNS the patch: against a document small enough to write down (the patch
 * reads five members of `document` and one observer), asserting on the style it
 * injected, the cells it tagged and the options it observed with. It used to
 * assert those facts against the module's source text, which cannot tell a
 * well-formed mask URL from an encoded string nobody decodes, nor a tag that
 * comes off on dispose from a `classList.remove` that is never reached.
 *
 * The second block is a source rule (docs/agents/testing.md): the suite ships no
 * shared package, so each plugin carries its own copy of the stylesheet, and the
 * copies are compared as text.
 *
 * @module plugin-codegraph/tests/nav-icon
 */

import { strict as assert } from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountNavIconPatch } from '../src/client/nav-icon.ts'

// ------------------------------------------------------------ a document to patch

/** An element with exactly the surface the patch touches: a method it does not call is not here. */
class StubElement {
  readonly classes = new Set<string>()
  readonly appended: StubElement[] = []
  removed = false
  private text: string | null = null
  constructor(readonly parent: StubElement | null = null) {}
  get textContent(): string | null { return this.text }
  set textContent(value: string | null) { this.text = value }
  get classList(): { add: (name: string) => void, remove: (name: string) => void } {
    return {
      add: (name: string): void => { this.classes.add(name) },
      remove: (name: string): void => { this.classes.delete(name) },
    }
  }
  closest(selector: string): StubElement | null { return selector === 'button' ? this.parent : null }
  append(child: StubElement): void { this.appended.push(child) }
  remove(): void { this.removed = true }
}

/** What the patch asked the page's observer to watch, and how to run its pass. */
interface Watching {
  target: StubElement
  options: Record<string, unknown>
  disconnected: boolean
  /** Run the observer's callback, as a mutation record would. */
  run: () => void
}

/**
 * Install a page under the globals the patch reads, and take it away afterwards.
 *
 * @param cells - the nav cells on the page, each a label inside a button.
 * @param withNav - whether the page has a settings nav at all.
 * @returns the page's parts, the observers it created, and how its labels can move.
 */
function installPage(cells: { cell: StubElement, label: StubElement }[], withNav = true): {
  head: StubElement, observers: Watching[], forget: () => void
} {
  const head = new StubElement()
  const body = new StubElement()
  const nav = new StubElement()
  const observers: Watching[] = []
  const document = {
    body,
    head,
    createElement: (): StubElement => new StubElement(),
    querySelector: (selector: string): StubElement | null => (selector.includes('navList') && withNav ? nav : null),
    querySelectorAll: (selector: string): StubElement[] => {
      if (selector.includes('navLabel')) return cells.map(({ label }) => label)
      // `button.<class>`: the cells that carry the tag, which is what dispose walks.
      return cells.map(({ cell }) => cell).filter((cell) => cell.classes.size > 0)
    },
  }
  class RecordingObserver {
    disconnected = false
    readonly record: Watching
    constructor(callback: () => void) {
      this.record = { target: body, options: {}, disconnected: false, run: callback }
      observers.push(this.record)
    }
    observe(target: StubElement, options: Record<string, unknown>): void {
      this.record.target = target
      this.record.options = options
    }
    disconnect(): void { this.disconnected = true; this.record.disconnected = true }
  }
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'MutationObserver', { value: RecordingObserver, configurable: true, writable: true })
  return {
    head,
    observers,
    forget: (): void => {
      Reflect.deleteProperty(globalThis, 'document')
      Reflect.deleteProperty(globalThis, 'MutationObserver')
    },
  }
}

/** A nav cell: a labelled span inside a button. */
function navCell(text: string): { cell: StubElement, label: StubElement } {
  const cell = new StubElement()
  const label = new StubElement(cell)
  label.textContent = text
  return { cell, label }
}

/** The stylesheet the patch injected, as its text. */
function injectedCss(head: StubElement): string {
  const style = head.appended[0]
  assert.ok(style !== undefined, 'the patch injected no style')
  assert.equal(style.removed, false)
  return style.textContent ?? ''
}

describe('settings-nav glyph', () => {
  const pages: ReturnType<typeof installPage>[] = []
  const disposers: (() => void)[] = []
  function mount(
    cells: { cell: StubElement, label: StubElement }[],
    labels: string[] | (() => string[]) = ['代码图谱'],
    withNav = true,
  ): ReturnType<typeof installPage> {
    const page = installPage(cells, withNav)
    pages.push(page)
    disposers.push(mountNavIconPatch(typeof labels === 'function' ? labels : () => labels))
    return page
  }
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
    for (const page of pages.splice(0)) page.forget()
  })

  it('tags the cell whose label is the section, and nobody else\'s', () => {
    const own = navCell('代码图谱')
    const other = navCell('记忆')
    mount([own, other])
    assert.ok(own.cell.classes.has('dshCgNav'), 'the code graph row is not tagged')
    assert.equal(other.cell.classes.size, 0, 'a row with another label was tagged')
  })

  it('hides the shell\'s own icon before painting its own', () => {
    // 0.2.2-rc.1 renders the shell's glyph inside a `.navIcon` cell whose class
    // carries a build hash; the patch draws its glyph in `::before`, so the cell
    // must be suppressed or both show.
    const page = mount([navCell('代码图谱')])
    assert.match(injectedCss(page.head), /button\.dshCgNav \[class\*="navIcon"\][^\n]*display: none;/u,
      'the shell\'s icon cell must be hidden, or the row shows two icons')
  })

  it('paints through a mask so the glyph follows currentColor', () => {
    // A background-image would paint the SVG's own colours and stop following
    // the rail's active/hover states.
    const page = mount([navCell('代码图谱')])
    const css = injectedCss(page.head)
    assert.match(css, /-webkit-mask-image: url\(/u, 'the glyph must be a mask, not a background image')
    assert.match(css, /background-color: currentColor/u, 'the mask must be filled with currentColor')
  })

  it('URL-encodes a 16-grid SVG into the mask URL', () => {
    // An unencoded `#` or `"` truncates the data URL, and the row renders with no
    // glyph at all.
    const page = mount([navCell('代码图谱')])
    const encoded = /mask-image: url\("data:image\/svg\+xml,([^"]+)"\)/u.exec(injectedCss(page.head))?.[1]
    assert.ok(encoded !== undefined, 'no mask URL was injected')
    assert.doesNotMatch(encoded, /[#"]/u, 'the SVG reached the URL unencoded')
    const svg = decodeURIComponent(encoded)
    assert.match(svg, /<svg[^>]*viewBox="0 0 16 16"/u, 'the nav grid is 16px')
    assert.match(injectedCss(page.head), /width: 16px; height: 16px/u, 'the painted box must match the grid')
  })

  it('watches characterData, because a language switch rewrites the label in place', () => {
    // React rewrites a lone text child in place, which emits no childList
    // record: a childList-only observer would drop the tag on a language switch
    // and the gear would come back until the next unrelated mutation.
    const cell = navCell('记忆')
    let section = ['Memory']
    const page = mount([cell], () => section)
    assert.deepEqual(page.observers[0]?.options, { childList: true, subtree: true, characterData: true })
    assert.equal(cell.cell.classes.size, 0, 'a row is tagged before its label is the section\'s')
    // The switch: the section is called 记忆 now, and the row's label was rewritten
    // in place. The pass reads both again and finds the row.
    section = ['记忆']
    cell.label.textContent = '记忆'
    page.observers[0]?.run()
    assert.ok(cell.cell.classes.has('dshCgNav'), 'the row was not tagged after a language switch')
  })

  it('does nothing without a settings nav', () => {
    // Chat-view mutations must not pay for a label scan.
    const own = navCell('代码图谱')
    mount([own], ['代码图谱'], false)
    assert.equal(own.cell.classes.size, 0, 'a page with no settings nav had a cell tagged')
  })

  it('removes its style, its observer and its tag on dispose', () => {
    // The patch tags cells across the whole document; leaving them behind would
    // keep painting the glyph after the plugin is gone.
    const own = navCell('代码图谱')
    const page = mount([own])
    const style = page.head.appended[0]
    disposers.pop()?.()
    assert.equal(style?.removed, true, 'the style stayed in the document')
    assert.equal(page.observers[0]?.disconnected, true, 'the observer kept running')
    assert.equal(own.cell.classes.has('dshCgNav'), false, 'dispose must take the tag off, not only remove the style')
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
 *
 * A source rule: the copies are compared as text, because each plugin's patch
 * runs only in the running app.
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

  it('source rule: hides the shell icon cell in every copy, identically', () => {
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

  it('source rule: paints the class each copy actually tags its rows with', () => {
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
