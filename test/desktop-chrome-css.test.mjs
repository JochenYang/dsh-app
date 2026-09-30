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

// The caption-strip inset, and why it is asserted on the SOURCE rather than on a
// running window: the defect it guards is invisible in the page and only shows on
// native chrome. The kernel's modal mask paints `inset: var(--dsh-frame-chrome-top, 0px) 0 0`
// (packages/client/ui-primitives/src/Modal.module.css), and it only reserves the
// caption when that variable is set. Measured in the running app with the
// add-plugin dialog open, before the fix: `--dsh-frame-chrome-top` unset and the
// mask's computed top inset `0px`, i.e. the scrim painted over the window buttons
// and the strip went near-black over the page.
//
// The narrow scope is the point of the second test: publishing the whole
// `data-windows-titlebar` marker instead would hand the kernel
// `--dsh-frame-top-clearance` / `--dsh-frame-overlay-top` too, and upstream's
// AppFrame then reserves a 36px caption row, pads the frame and rounds the main
// panel — a layout change this fix must NOT make.
test('the shell publishes the caption inset the kernel\'s modal mask reserves', () => {
  // Comments are stripped first: the prose above quotes both the variable and the
  // marker, and an assertion that cannot tell code from a comment would pass on a
  // comment alone — the very failure mode this pair of tests exists to prevent.
  const code = codeOf('src/main/window.ts')
  assert.match(code, /--dsh-frame-chrome-top/u, 'the mask reads this variable; without it the scrim covers the caption')
  // It must be the real overlay height, not a literal that can drift from the window.
  assert.match(code, /\$\{OVERLAY_HEIGHT\}px/u,
    'the inset must be OVERLAY_HEIGHT, the height the window actually reserves')
  // Windows only: the strip is a Windows caption (macOS keeps its traffic lights).
  assert.match(code, /installFrameMetrics\(win: BrowserWindow\): void \{\s*\n\s*if \(process\.platform !== 'win32'\) return/u,
    'the caption only exists on Windows')
  // Fullscreen drops it, like upstream: the caption is hidden, so a reserved strip
  // would leave a gap under a mask that has nothing to avoid.
  assert.match(code, /'0px'/u, 'fullscreen must zero the inset')
})

test('the caption fix does not hand the kernel a caption LAYOUT', () => {
  const code = codeOf('src/main/window.ts')
  // Setting the marker would make upstream's AppFrame reserve a 36px row and
  // round the main panel's corner — measured in the running window as frame
  // `padding-top: 0px` -> `36px`. That is a redesign, not this fix.
  assert.doesNotMatch(code, /dataset\.windowsTitlebar\s*=/u,
    'publishing data-windows-titlebar changes the layout; only the mask inset may be set')
  assert.doesNotMatch(code, /--dsh-windows-titlebar-height/u,
    'this variable drives AppFrame padding and the rounded corner; not part of this fix')
})
