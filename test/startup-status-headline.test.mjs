/**
 * The splash headline's swap rules.
 *
 * WHY THIS FILE EXISTS (measured, reported as "the extracting line blinks"):
 * `#startup-status` fades with a 200ms opacity transition, the class is held
 * for 100ms, and the kernel re-sends the line on a ~4/s throttle that carries a
 * new count in the text (see KernelManager.throttledStatus and
 * `kernel.status.extractingProgress`). The rule used to be "the text differs,
 * so fade", so every count tick restarted a fade that could not finish — the
 * element spent the whole extraction mid-fade, oscillating in opacity.
 *
 * The decision therefore lives in two PURE functions in the page
 * (`headlineIdentity` / `headlineNeedsFade`), fenced by markers so this test can
 * lift them OUT OF the page and drive them directly instead of restating them
 * here. A copy of the rule written in this file would agree with itself while
 * the page drifted.
 *
 * Run after the build: node --test test/   (or: npm test)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PAGE = path.join(ROOT, 'static', 'startup.html')

/** Markers fencing the pure rules inside the page's inline script. */
const RULES_OPEN = '/* ===== headline-swap rules (pure: no state, no DOM) ===== */'
const RULES_CLOSE = '/* ===== end headline-swap rules ===== */'

/** Every inline <script> body in the page, joined: the page holds two. */
function pageScript() {
  const html = readFileSync(PAGE, 'utf8')
  const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1])
  assert.equal(bodies.length, 2, 'static/startup.html holds a theme bootstrap and the page script')
  return bodies.join('\n')
}

/**
 * Lift the page's own pure rules out of the page and evaluate them.
 *
 * The slice is taken between two markers rather than by parsing JavaScript: the
 * boundary is the author's, it cannot be satisfied by a lookalike elsewhere in
 * the file, and a moved or renamed rule fails here instead of silently passing.
 * @returns {{ headlineIdentity: (text: string) => string, headlineNeedsFade: (shown: string, incoming: string) => boolean }}
 */
function pageRules() {
  const script = pageScript()
  const start = script.indexOf(RULES_OPEN)
  const end = script.indexOf(RULES_CLOSE)
  assert.notEqual(start, -1, `the pure rules must be fenced by ${RULES_OPEN}`)
  assert.ok(end > start, `the fence ${RULES_CLOSE} must follow the opening one`)
  const context = vm.createContext({})
  return vm.runInContext(
    `${script.slice(start + RULES_OPEN.length, end)}\n;({ headlineIdentity, headlineNeedsFade })`,
    context,
  )
}

test('the page\'s inline script parses', () => {
  // No other gate reads this file's script: a syntax error in it is invisible
  // until the splash fails to render on a user's screen. `new vm.Script` parses
  // without executing, so the page's own globals are never needed.
  assert.doesNotThrow(() => new vm.Script(pageScript()), 'static/startup.html\'s inline script must parse')
})

test('a count changing inside one line does not restart the fade', () => {
  const { headlineNeedsFade } = pageRules()
  // The reported case: every extraction tick.
  assert.equal(headlineNeedsFade('正在解压运行时…（7894/15000）', '正在解压运行时…（7895/15000）'), false)
  // Same rule for the other locale, and for the layered-install count.
  assert.equal(headlineNeedsFade('Extracting the runtime… (10/15000)', 'Extracting the runtime… (4000/15000)'), false)
  assert.equal(headlineNeedsFade('正在装配运行时…（1/3）', '正在装配运行时…（3/3）'), false)
})

test('the count APPEARING on the line is that line changing, and fades once', () => {
  // `kernel.status.extracting` (no count) is followed by the count-bearing
  // `extractingProgress` after the tarball's listing pass — seconds apart, once
  // per install. Fading there is the same event as a stage change; what the
  // rule must never do is fade the ticks that come after it, which the test
  // above pins.
  const { headlineNeedsFade } = pageRules()
  assert.equal(headlineNeedsFade('正在解压运行时…', '正在解压运行时…（1/15000）'), true)
})

test('a new message keeps its fade', () => {
  const { headlineNeedsFade } = pageRules()
  // The fades worth having: the boot moving from one stage to the next.
  assert.equal(headlineNeedsFade('正在下载 dsh…', '正在解压运行时…（1/15000）'), true)
  assert.equal(headlineNeedsFade('正在解压运行时…（15000/15000）', '正在激活运行时…'), true)
  assert.equal(headlineNeedsFade('正在下载 dsh…', 'Extracting the runtime… (1/15000)'), true)
  // And nothing fades for a message identical to the one on screen.
  assert.equal(headlineNeedsFade('正在激活运行时…', '正在激活运行时…'), false)
})

test('the identity collapses digits and nothing else', () => {
  const { headlineIdentity } = pageRules()
  assert.equal(headlineIdentity('a1b22'), 'a#b#')
  assert.equal(headlineIdentity('正在解压运行时…（7894/15000）'), '正在解压运行时…（#/#）')
  assert.notEqual(headlineIdentity('正在装配运行时…（2/3）'), headlineIdentity('正在激活运行时…'))
  assert.notEqual(headlineIdentity('正在下载 dsh 0.2.0-rc.2…'), headlineIdentity('正在下载 dsh…'))
})

test('the page routes its headline through the rules and never stacks a swap', () => {
  const script = pageScript()
  // The headline goes through the applier, which is the only writer of the
  // class: a second `classList.add('fade-trans')` is the old per-tick block
  // growing back beside it.
  const applierAt = script.indexOf('function setStatusText(')
  assert.notEqual(applierAt, -1, 'the headline must be written by setStatusText')
  assert.match(script, /setStatusText\(view\.message \|\|/u, 'render() must call the applier for the headline')
  const fadeAdds = script.match(/classList\.add\('fade-trans'\)/gu) ?? []
  assert.equal(fadeAdds.length, 1, 'exactly one place may arm the fade')
  const applier = script.slice(applierAt, script.indexOf('Reactive State Dispatcher', applierAt))
  assert.match(applier, /clearTimeout\(statusSwap\)/u,
    'a newer message must cancel the pending swap instead of stacking a second timer')
  assert.match(applier, /headlineNeedsFade\(statusEl\.textContent, text\)/u,
    'the fade decision must come from the pure rule, not from "the text differs"')
})
