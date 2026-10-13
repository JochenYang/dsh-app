/**
 * The splash wish line: ONE wish per app start, drawn at random.
 *
 * The line at the foot of the splash used to be a single fixed sentence; it is
 * now one of several, and which one is drawn once per process. Two things have
 * to hold, and both are cheap to get wrong:
 *
 *   - the draw obeys the source it is given (so a test can pin the ends of the
 *     range instead of living with a real random), and
 *   - the draw happens ONCE. `updateStartupWindow` pushes on every kernel
 *     status — several times a second during an extraction — and a draw per push
 *     would make the line jump between two wishes on screen.
 *
 * The second one is a property of the shell, not of a function, so it is read
 * off `src/main/startup-window.ts`: exactly one call, at module level, and
 * `push()` reading the constant. A copy of that rule written here would agree
 * with itself while the shell drifted.
 *
 * Run after the build: node --test test/   (or: npm test)
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { pickSaying } = require('../dist/shared/pick-saying.js')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PAGE = path.join(ROOT, 'static', 'startup.html')
const SHELL = path.join(ROOT, 'src', 'main', 'startup-window.ts')

/** Every inline <script> body in the page, joined: the page holds two. */
function pageScript() {
  const html = readFileSync(PAGE, 'utf8')
  const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1])
  assert.equal(bodies.length, 2, 'static/startup.html holds a theme bootstrap and the page script')
  return bodies.join('\n')
}

/** The wishes the shell may show, read from its own declaration. */
function shellSayingKeys() {
  const shell = readFileSync(SHELL, 'utf8')
  const listAt = shell.indexOf('const SPLASH_SAYING_KEYS: readonly MessageKey[] = [')
  assert.notEqual(listAt, -1, 'the shell must declare SPLASH_SAYING_KEYS')
  return [...shell.slice(listAt, shell.indexOf(']', shell.indexOf('= [', listAt)))
    .matchAll(/'([^']+)'/gu)].map((m) => m[1])
}

test('the draw honours the source it is given, at both ends', () => {
  const keys = ['first', 'second', 'third']
  assert.equal(pickSaying(keys, () => 0), 'first', 'a draw of 0 is the first entry')
  assert.equal(pickSaying(keys, () => 0.999), 'third', 'a draw just under 1 is the last entry')
  assert.equal(pickSaying(keys, () => 0.5), 'second')
  // Out-of-range and non-finite draws still name an entry of a non-empty list
  // rather than reading past its end.
  assert.equal(pickSaying(keys, () => 1), 'third')
  assert.equal(pickSaying(keys, () => 7), 'third')
  assert.equal(pickSaying(keys, () => -1), 'first')
  assert.equal(pickSaying(keys, () => Number.NaN), 'first')
  // The whole range is reachable: a draw is not always pinned to one entry.
  const swept = new Set([0, 0.2, 0.4, 0.6, 0.8].map((draw) => pickSaying(keys, () => draw)))
  assert.equal(swept.size, 3, `every entry must be reachable, got ${[...swept].join(',')}`)
})

test('one entry, none, and the default source', () => {
  assert.equal(pickSaying(['only'], () => 0.99), 'only', 'a single wish is always the answer')
  assert.equal(pickSaying(['only'], () => 0), 'only')
  assert.equal(pickSaying([]), undefined, 'nothing to draw from is not an error, it is no wish')
  assert.equal(pickSaying([], () => 0.5), undefined)
  // Called with no source at all it uses Math.random; the value is one of the
  // keys, which is the whole contract (no assertion on WHICH one).
  const drawn = pickSaying(['a', 'b'])
  assert.ok(drawn === 'a' || drawn === 'b', `unexpected draw ${String(drawn)}`)
})

test('the wish is drawn once per start, never per push', () => {
  const shell = readFileSync(SHELL, 'utf8')
  const calls = shell.match(/pickSaying\(/gu) ?? []
  assert.equal(calls.length, 1, 'exactly one draw site may exist in the shell')
  // …and it is a module-level constant, so one process start draws once. The
  // pattern is anchored at column 0: an indented call is inside a function, and
  // a function call site is what would draw again on every push.
  assert.match(shell, /^const SPLASH_SAYING_KEY = pickSaying\(SPLASH_SAYING_KEYS\)$/mu,
    'the draw must be a module-level constant bound to SPLASH_SAYING_KEYS')

  // push() is the per-status path: it may only READ the constant.
  const pushAt = shell.indexOf('function push(')
  assert.notEqual(pushAt, -1, 'the shell must still push through push()')
  const body = shell.slice(pushAt, shell.indexOf('lastView = next', pushAt))
  assert.doesNotMatch(body, /pickSaying\(/u, 'push() must not draw again — that is the line jumping')
  assert.match(body, /saying: SPLASH_SAYING_KEY === undefined \? '' : t\(SPLASH_SAYING_KEY\)/u,
    'push() must send the constant, and send nothing for an empty wish list')
})

test('the pushed field is one string again', () => {
  const shell = readFileSync(SHELL, 'utf8')
  assert.match(shell, /^ {2}saying: string$/mu, 'StartupView.saying must be a single string')
  assert.doesNotMatch(shell, /sayings/u, 'the array shape is gone from the shell')
  assert.match(shell, /type StartupPush = Omit<StartupView, 'brand' \| 'theme' \| 'skeleton' \| 'digest' \| 'saying'>/u,
    'the push-owned key set must exclude saying, and nothing else')
})

test('the page writes the pushed line and nothing else moves it', () => {
  const script = pageScript()
  for (const gone of ['sayingRotationPlan', 'sayingIndexAfter', 'sayingNeedsWrite', 'SAYING_ROTATE_MS', 'fade-saying']) {
    assert.doesNotMatch(script, new RegExp(gone, 'u'), `${gone} belongs to the removed rotation`)
  }
  assert.doesNotMatch(script, /view\.sayings/u, 'the page must read view.saying, the single pushed line')
  assert.match(script, /if \(typeof view\.saying === 'string' && view\.saying !== ''\) \{\r?\n\s+sayingEl\.textContent = view\.saying;/u,
    'the line is written in place, and an empty push leaves the fallback alone')
  // One lookup, one write. A timer or a fade would have to name the element
  // again, so the count is what says "nothing else moves this line".
  assert.equal((script.match(/sayingEl/gu) ?? []).length, 2,
    'sayingEl may only be looked up and written once')
})

test('the wish line carries no aria-live', () => {
  const html = readFileSync(PAGE, 'utf8')
  const span = /<span id="startup-saying"([^>]*)>/u.exec(html)
  assert.notEqual(span, null, 'the page must carry the #startup-saying span')
  assert.doesNotMatch(span[1], /aria-/u, 'this line never announces itself; the headline already is a known noisy one')
})

test('the page\'s fallback line is the shell\'s first wish', () => {
  // A page that never got a push shows the markup's own text. It has to be one
  // the shell could have drawn, or the first paint is a sentence that cannot
  // come back.
  const keys = shellSayingKeys()
  assert.ok(keys.length >= 2, `the shell must offer at least two wishes, got ${JSON.stringify(keys)}`)

  const zh = require('../dist/shared/locale.js').messagesFor('zh-CN')
  for (const key of keys) assert.ok(zh[key] !== undefined, `zh-CN is missing ${key}`)

  const html = readFileSync(PAGE, 'utf8')
  const fallback = /<span id="startup-saying">([^<]*)<\/span>/u.exec(html)
  assert.notEqual(fallback, null, 'the page must carry a #startup-saying fallback')
  assert.equal(fallback[1], zh[keys[0]], 'the page\'s fallback must be the shell\'s first wish')
  assert.equal(zh[keys[1]], '想要的太多，需要的不多', 'the second wish is the requested one')
})
