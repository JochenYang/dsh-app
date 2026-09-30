// The desktop-chrome stylesheet lives in two places by design: the shell
// injects it (src/main/window.ts DESKTOP_CHROME_CSS) and the drag probe
// mirrors it (scripts/probe-drag.cjs) to drive a real window through the same
// layout. AGENTS.md requires the two stay in sync — this is the assertion that
// makes "in sync" checkable instead of remembered. A rule edited on one side
// only (the drifted footer stack was exactly that) fails here.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * A source file with its comments removed, so an assertion can only be satisfied
 * by code. Both tests below name identifiers that the surrounding prose also
 * quotes; without this, a comment would satisfy them.
 * @param relative - path under the repository root.
 * @returns the file's text with block and line comments blanked out.
 */
function codeOf(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
}

/** The template literal behind a `const NAME = ` marker, as its raw text. */
function literal(source, marker) {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing ${marker}`)
  const open = source.indexOf('`', start)
  const end = source.indexOf('`', open + 1)
  return source.slice(open + 1, end)
}

test('probe-drag mirrors DESKTOP_CHROME_CSS rule for rule', () => {
  const shell = readFileSync(path.join(ROOT, 'src/main/window.ts'), 'utf8')
  const probe = readFileSync(path.join(ROOT, 'scripts/probe-drag.cjs'), 'utf8')
  const shellCss = literal(shell, 'DESKTOP_CHROME_CSS')
  const probeCss = literal(probe, 'const CSS')
  // Compare the selector/declaration lines, one per line: strip block comments
  // (newline-preserving so lines stay aligned) and blank lines, and compare
  // the RULES — not the prose around them.
  const rules = (css) => css
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ''))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  assert.deepEqual(rules(probeCss), rules(shellCss))
})

// The window-frame contract with the kernel, and why it is asserted on the SOURCE
// rather than on a running window: the surfaces it controls are native chrome and
// per-surface layout, so a source-level assertion is what keeps the two halves from
// drifting apart silently.
//
// The kernel's web UI ships a complete Windows caption layout gated on two values a
// document cannot know by itself: `html[data-windows-titlebar]` (a caption exists)
// and `--dsh-windows-titlebar-height` (how tall). AppFrame reserves the caption row
// and rounds the main panel, SidebarRoot repositions the brand, dockkit starts
// floats below it, and the modal mask keeps off it
// (`inset: var(--dsh-frame-chrome-top, 0px) 0 0`, derived from the same marker).
//
// Measured before this existed: none of those rules fired, so the shell held every
// surface clear of the window buttons by hand — and the right dock's tab strip,
// padded 140px on the right while its buttons ended 2px from the native zone, left
// 337px of empty strip in front of them (the reported "uncoordinated" look).
test('the shell publishes the caption markers the kernel\'s layout keys on', () => {
  // Comments are stripped first: the prose above names every one of these
  // identifiers, and an assertion that cannot tell code from a comment would pass
  // on a comment alone — the failure mode this whole file exists to prevent.
  const code = codeOf('src/main/window.ts')
  assert.match(code, /dataset\.windowsTitlebar\s*=/u, 'without the marker the kernel lays itself out as if there were no caption')
  assert.match(code, /--dsh-windows-titlebar-height/u, 'the caption height is what every derived inset is computed from')
  assert.match(code, /\$\{OVERLAY_HEIGHT\}px/u,
    'the height must be OVERLAY_HEIGHT, the value the window actually reserves')
  // It must be the platform the kernel scopes its desktop rules to (`darwin`
  // especially: traffic lights, sidebar vibrancy, the 48px clearance).
  assert.match(code, /dataset\.platform\s*=/u, 'the kernel scopes macOS and desktop rules on data-platform')
  // Fullscreen drops the clearance, like upstream: the caption is hidden, so a
  // reserved strip would leave a gap the mask has nothing to avoid.
  assert.match(code, /dataset\.fullscreen\s*=/u, 'fullscreen must drop the reserved caption')
})

test('the caption layout is the kernel\'s job, not a pile of per-surface padding', () => {
  // This is the regression that produced the uncoordinated look: each new surface
  // that reached the window's top-right got its own hand-written clearance, so the
  // set drifted surface by surface. With the marker published the kernel positions
  // them, and these patches are load-bearing only if they come back.
  const css = literal(readFileSync(path.join(ROOT, 'src/main/window.ts'), 'utf8'), 'DESKTOP_CHROME_CSS')
  for (const sel of ['_tabStrip', '_pageHeading', '_headerUtilities', '_titleRow']) {
    const patched = new RegExp(`${sel}[^}]*\\{[^}]*padding-right:\\s*\\$\\{WINDOW_CONTROLS_WIDTH\\}`, 'u').test(css)
    assert.equal(patched, false,
      `${sel} is padded by hand again; the kernel's caption layout already clears the window buttons `
      + '(see the marker test above and scripts/probe-patch-audit.mjs)')
  }
})

// The caption band's COLOUR, and why the sampler must not walk the DOM for it.
//
// The kernel paints the caption row with `--dsw-specific-sidebar-fill` — its own
// documented meaning is "Sidebar column and title-row background"
// (ui-theme/src/client/index.ts:145) — and it paints it on a PSEUDO-element
// (`AppFrame.module.css` `.frame::before`). A pseudo-element is not in the DOM, so
// the sampler's elementFromPoint + parentElement walk cannot see it and falls
// through to the body's own background, one step darker.
//
// Measured in the running app before this: the band painted rgb(27,27,28) while
// the sampler read rgb(21,21,23) in dark, and rgb(249,250,251) vs rgb(255,255,255)
// in light — a visible seam between the native strip and the page. After reading
// the token, four theme round-trips matched exactly (#1b1b1c / #f9fafb).
// The sampler's order of preference, and why it is exactly this order: getting it
// either way round produced a visible defect, one reported after the other.
//
//   1. an overlay ABOVE the frame wins — the frame is not what is painted there.
//      Measured with the plugin market open: its panel spans x 1068..1528 and
//      y 0..900, so it covers the caption's right end (window buttons included)
//      while painting rgb(35,35,36). Answering with the frame's colour left the
//      strip darker than the panel under it.
//   2. otherwise the kernel's own caption token, because the frame paints that
//      band with a PSEUDO-element: an elementFromPoint walk cannot see it and
//      falls through to the body, one step off.
//
// So the walk must STOP at the frame — anything inside it is page content, not
// something covering the caption.
test('the strip sampler prefers an overlay, then the kernel\'s caption token', () => {
  const shell = readFileSync(path.join(ROOT, 'src/main/window.ts'), 'utf8')
  // Comments stripped: the prose above names every identifier here (and mentions
  // the token before the loop), so indexOf on the raw text would measure comments.
  const sampler = literal(shell, 'const SAMPLE_FN').replace(/^\s*\/\/.*$/gmu, '')
  assert.match(sampler, /--dsw-specific-sidebar-fill/u,
    'the caption band is painted by a pseudo-element; only the kernel\'s own token names its colour')
  // The overlay walk exists, and it is bounded by the frame and the body.
  assert.match(sampler, /let covering = null/u, 'overlays above the frame must be considered')
  assert.match(sampler, /el === document\.body \|\| el === frame/u, 'the overlay walk must stop at the frame and the body, or a layout wrapper counts as a cover')
  assert.match(sampler, /el\.contains\(frame\)/u, 'a box merely CONTAINING the frame is a wrapper, never a painted cover')
  // Order: the bounded overlay walk runs before the token, and the token before
  // the unbounded fallback walk.
  const overlayAt = sampler.indexOf('let covering = null')
  const tokenAt = sampler.indexOf('--dsw-specific-sidebar-fill')
  const fallbackAt = sampler.indexOf('el2 = document.elementFromPoint')
  assert.ok(overlayAt !== -1 && tokenAt !== -1 && fallbackAt !== -1, 'all three branches must exist')
  assert.ok(overlayAt < tokenAt, 'an overlay covering the strip wins over the caption token')
  assert.ok(tokenAt < fallbackAt, 'the token wins over the unbounded fallback walk (the marker is Windows-only)')
})

// The sampler must hand the shell rgb() NUMBERS, and the failure mode this pins was
// shipped for one build: the kernel's caption token is written as HEX
// (`--dsw-specific-sidebar-fill: #1b1b1c`), and the shell's parseRgb() reads digits
// out of whatever it is given. Fed the raw hex it read "#1b1b1c" as [1, 1, 1] and
// painted the strip `#010101` — reported as "completely pure black in dark theme" —
// while "#f9fafb" failed to parse at all and fell back to `#ffffff`.
test('the sampler normalizes its colour to rgb() before the shell parses it', () => {
  const shell = readFileSync(path.join(ROOT, 'src/main/window.ts'), 'utf8')
  const sampler = literal(shell, 'const SAMPLE_FN')
  // The token branch must go through a hex parser, not return the raw property.
  assert.match(sampler, /toRgbColor/u, 'the token value is hex; it must be converted before it leaves the sampler')
  // Reading the hex PAIRS (slice + base 16) is what makes it a real conversion.
  assert.match(sampler, /parseInt\(h\.slice\(i, i \+ 2\), 16\)/u, 'the conversion must read hex pairs')
  assert.match(sampler, /return caption;/u, 'the converted token is what gets returned')
})
