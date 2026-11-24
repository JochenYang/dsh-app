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
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

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
// A source rule: the markers are assignments in an injected script that no test
// can run against a native window, so what is checked is that the shell writes
// each of them. The sampler further down IS run (see `sample()` below).
test('source rule: the shell publishes the caption markers the kernel\'s layout keys on', () => {
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

// The image lightbox's CLOSE CONTROL, and why the shell has to move it.
//
// Measured on the installed 0.2.0-rc.2 build: the primitive paints the control
// `position: fixed; top: 20px; right: 20px` — the viewport's top-right corner,
// which in this frameless window is the box the native window buttons own
// (`titleBarOverlay`), so the control renders underneath them and reads as a
// clipped circle (reported from a packaged build by opening an image in a
// conversation). The kernel's other overlays already clear the caption: Modal's
// close is in-flow inside its dialog and its mask starts at
// `--dsh-frame-chrome-top`. Fullscreen has no window buttons, so the correction
// must drop there — upstream's own rule does the same by zeroing that inset.
test('the image lightbox\'s close control clears the caption band', () => {
  // Comments stripped: the prose above names the selectors this test asserts on.
  const css = literal(readFileSync(path.join(ROOT, 'src/main/window.ts'), 'utf8'), 'DESKTOP_CHROME_CSS')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
  // Slice from the selector to the rule's own closing line: a brace-matching
  // regex would stop inside the declaration's `${...}` interpolation.
  const at = css.indexOf('html[data-windows-titlebar]:not([data-fullscreen]) [class*="_backdrop"]')
  assert.notEqual(at, -1,
    'without an offset the lightbox close renders under the native window buttons')
  const end = css.indexOf('\n}', at)
  assert.notEqual(end, -1, 'the lightbox rule must be a rule of its own')
  const rule = css.slice(at, end + 2)
  assert.match(rule, /\[class\*="_backdrop"\]\s*>\s*\[class\*="_close"\]\s*\{/u,
    'scope it to the lightbox close: other `_close` controls are in-flow inside their own dialogs')
  assert.match(rule, /top:\s*calc\(\$\{OVERLAY_HEIGHT\}px \+ 20px\);/u,
    'the control must move below the caption band, keeping its own 20px gap')
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
//
// The sampler is RUN here, inside the wrapper the shell injects, against a page
// this file describes. Matching its source text instead (what this file used to
// do) could not tell the token branch from a dead one: `toRgbColor` may be
// named anywhere in the function and still never be reached.

/**
 * Run the injected sampler against a page this test describes.
 *
 * @param {object} page
 * @param {Array<object|string>} [page.stack] what `elementFromPoint` returns,
 *   innermost first: an element spec, or `'body'`.
 * @param {string} [page.caption] the kernel's caption token, as declared on body.
 * @param {string} [page.documentCaption] the same token, declared on
 *   documentElement only.
 * @returns the colour the sampler hands the shell.
 */
function sample({ stack = [], caption = '', documentCaption = '' } = {}) {
  const shell = readFileSync(path.join(ROOT, 'src/main/window.ts'), 'utf8')
  // The template as a STRING: its `\\(` is `\(` once evaluated, and its two
  // interpolations only decide where the page is sampled — the fake document
  // below answers every point alike.
  const script = literal(shell, 'const SAMPLE_FN')
    .replace(/\\\\/gu, '\\')
    .replace(/\$\{WINDOW_CONTROLS_WIDTH\}/gu, '0')
    .replace(/\$\{OVERLAY_HEIGHT\}/gu, '0')
  const frame = {}
  const body = { background: 'rgb(21, 21, 23)', token: caption, parentElement: null }
  const documentElement = { background: '', token: documentCaption }
  const elements = stack.map((entry) => {
    if (entry === 'body') return body
    // `containsFrame`: a plain layout wrapper, which merely holds the frame.
    const { containsFrame, ...painted } = entry
    return { parentElement: null, background: 'rgba(0, 0, 0, 0)', token: '', contains: () => containsFrame === true, ...painted }
  })
  elements.forEach((element, index) => { element.parentElement = elements[index + 1] ?? null })
  const document = {
    body,
    documentElement,
    querySelector: (selector) => (selector.includes('_frame') ? frame : null),
    elementFromPoint: () => elements[0] ?? null,
  }
  const getComputedStyle = (element) => ({
    backgroundColor: element.background ?? '',
    getPropertyValue: (name) => (name === '--dsw-specific-sidebar-fill' ? element.token ?? '' : ''),
  })
  // The same wrapper the shell injects (`SAMPLE_SCRIPT` in window.ts).
  return vm.runInNewContext(`(function () {${script} return sample(); })()`, { document, window: { innerWidth: 1200 }, getComputedStyle })
}

test('the strip sampler prefers an overlay, then the kernel\'s caption token', () => {
  // 1. An element that PAINTS over the sample point wins: it is what is visible
  // there, whatever the frame would have drawn.
  assert.equal(sample({ stack: [{ background: 'rgb(35, 35, 36)' }], caption: '#1b1b1c' }), 'rgb(35, 35, 36)')
  // ...unless it is the frame, the body, or a plain box that merely CONTAINS the
  // frame (a layout wrapper — never the painted surface).
  assert.equal(sample({ stack: [{ background: 'rgb(1, 2, 3)', containsFrame: true }], caption: '#1b1b1c' }), 'rgb(27, 27, 28)')
  assert.equal(sample({ stack: ['body'], caption: '#1b1b1c' }), 'rgb(27, 27, 28)')
  // A transparent element paints nothing there, so the walk goes on past it.
  assert.equal(sample({ stack: [{}, { background: 'rgb(35, 35, 36)' }], caption: '#1b1b1c' }), 'rgb(35, 35, 36)')
  // 2. Otherwise the kernel's own caption token.
  assert.equal(sample({ caption: '#1b1b1c' }), 'rgb(27, 27, 28)')
  // No token (a kernel that predates it, or a window without the marker): the
  // plain page walk, which is correct there because nothing paints over the strip.
  assert.equal(sample({ stack: [{ background: 'rgb(9, 9, 9)' }] }), 'rgb(9, 9, 9)')
})

// The sampler must hand the shell rgb() NUMBERS, and the failure mode this pins was
// shipped for one build: the kernel's caption token is written as HEX
// (`--dsw-specific-sidebar-fill: #1b1b1c`), and the shell's parseRgb() reads digits
// out of whatever it is given. Fed the raw hex it read "#1b1b1c" as [1, 1, 1] and
// painted the strip `#010101` — reported as "completely pure black in dark theme" —
// while "#f9fafb" failed to parse at all and fell back to `#ffffff`.
test('the sampler normalizes its colour to rgb() before the shell parses it', () => {
  assert.equal(sample({ caption: '#1b1b1c' }), 'rgb(27, 27, 28)')
  assert.equal(sample({ caption: '#f9fafb' }), 'rgb(249, 250, 251)')
  assert.equal(sample({ caption: '#abc' }), 'rgb(170, 187, 204)')
  // It is read from BODY, where the theme presenter declares it. With nothing
  // covering the strip and no token on body, the sampler must fall through to
  // the page's own background — a reader that looked at documentElement instead
  // would find the token declared there and answer with the caption colour.
  assert.equal(sample({ documentCaption: '#1b1b1c' }), 'rgb(21, 21, 23)')
})
