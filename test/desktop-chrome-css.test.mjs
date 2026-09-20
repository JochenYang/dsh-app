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
