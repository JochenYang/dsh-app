/**
 * The splash wish line's rotation rules.
 *
 * The line at the foot of the splash used to be one sentence, pushed by the
 * shell and written by the page. It is now a rotation through the lines the
 * shell pushes (`view.sayings`), and the page owns the clock.
 *
 * As in test/startup-status-headline.test.mjs, the decision lives in PURE
 * functions inside the page, fenced by markers, and this file LIFTS them out and
 * drives them directly instead of restating them here: a copy of the rule
 * written in this file would agree with itself while the page drifted. The
 * timings are parameters precisely so a test never has to sleep 8 real seconds
 * to watch a rotation happen.
 *
 * Run after the build: node --test test/   (or: npm test)
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PAGE = path.join(ROOT, 'static', 'startup.html')
const SHELL = path.join(ROOT, 'src', 'main', 'startup-window.ts')

/** Markers fencing the pure rules inside the page's inline script. */
const RULES_OPEN = '/* ===== saying-rotation rules (pure: no state, no DOM) ===== */'
const RULES_CLOSE = '/* ===== end saying-rotation rules ===== */'

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
 */
function pageRules() {
  const script = pageScript()
  const start = script.indexOf(RULES_OPEN)
  const end = script.indexOf(RULES_CLOSE)
  assert.notEqual(start, -1, `the pure rules must be fenced by ${RULES_OPEN}`)
  assert.ok(end > start, `the fence ${RULES_CLOSE} must follow the opening one`)
  const context = vm.createContext({})
  return vm.runInContext(
    `${script.slice(start + RULES_OPEN.length, end)}\n;({ SAYING_ROTATE_MS, sayingLines, sayingIndexAfter, sayingNeedsWrite, sayingRotationPlan })`,
    context,
  )
}

/**
 * Walk a rotation the way the page's interval does: one step per tick, using the
 * page's own index rule. Returns the lines in the order they would be shown.
 */
function walk(lines, ticks, startIndex = 0) {
  const { sayingIndexAfter } = pageRules()
  const shown = [lines[startIndex]]
  let index = startIndex
  for (let tick = 0; tick < ticks; tick += 1) {
    index = sayingIndexAfter(index, lines.length)
    shown.push(lines[index])
  }
  return shown
}

/** An array the lifted rules built lives in the vm's realm; compare a local copy. */
const localCopy = (value) => [...value]

test('the rotation advances one line per tick and wraps at the end', () => {
  const { sayingIndexAfter } = pageRules()
  const two = ['health', 'want']
  assert.deepEqual(walk(two, 4), ['health', 'want', 'health', 'want', 'health'],
    'a two-line rotation alternates, and the fifth read is the first line again')
  const three = ['a', 'b', 'c']
  assert.deepEqual(walk(three, 4), ['a', 'b', 'c', 'a', 'b'], 'a third line wraps the same way')
  // The wrap is the rule, not an accident of the list length.
  assert.equal(sayingIndexAfter(0, 2), 1)
  assert.equal(sayingIndexAfter(1, 2), 0)
  assert.equal(sayingIndexAfter(2, 3), 0)
  // No lines: staying at 0 is the only answer that cannot read past the end.
  assert.equal(sayingIndexAfter(0, 0), 0)
})

test('the interval is a parameter, and the shipped one is in the 8-10s band', () => {
  const { SAYING_ROTATE_MS, sayingRotationPlan } = pageRules()
  assert.ok(Number.isInteger(SAYING_ROTATE_MS), 'the shipped interval must be a whole number of ms')
  assert.ok(SAYING_ROTATE_MS >= 8000 && SAYING_ROTATE_MS <= 10_000,
    `the shipped interval is outside the intended band: ${SAYING_ROTATE_MS}`)
  // Injectable: a test drives the rotation on its own clock, never the real one.
  assert.equal(sayingRotationPlan(['a', 'b'], false, 5).intervalMs, 5)
  assert.equal(sayingRotationPlan(['a', 'b'], false).intervalMs, SAYING_ROTATE_MS)
})

test('reduced motion stops the rotation rather than only muting the fade', () => {
  const { sayingRotationPlan } = pageRules()
  const plan = sayingRotationPlan(['a', 'b'], true)
  assert.equal(plan.intervalMs, null, 'a reduced-motion user gets no timer at all')
  assert.deepEqual(localCopy(plan.lines), ['a', 'b'], 'the lines are still pushed, so the first one is written')
})

test('one line, no lines, and junk entries never rotate', () => {
  const { sayingRotationPlan, sayingLines } = pageRules()
  assert.equal(sayingRotationPlan(['only'], false).intervalMs, null, 'a single line has nothing to rotate to')
  assert.equal(sayingRotationPlan([], false).intervalMs, null)
  assert.equal(sayingRotationPlan(undefined, false).intervalMs, null, 'a push without the field is not an error')
  assert.deepEqual(localCopy(sayingRotationPlan(['a', '', 3, 'b'], false).lines), ['a', 'b'],
    'the page is a boundary: only real strings are shown, and they keep the shell\'s order')
  assert.deepEqual(localCopy(sayingLines(null)), [])
})

test('an unchanged line is never rewritten', () => {
  const { sayingNeedsWrite } = pageRules()
  assert.equal(sayingNeedsWrite('想要的太多，需要的不多', '想要的太多，需要的不多'), false,
    'the same line must not be re-written, which is what would replay its fade')
  assert.equal(sayingNeedsWrite('首先您要健康，其次才是其次', '想要的太多，需要的不多'), true)
  // The first push lands on a page already showing its own fallback: the same
  // text, so no write and no fade.
  assert.equal(sayingNeedsWrite('首先您要健康，其次才是其次', '首先您要健康，其次才是其次'), false)
})

test('the page writes the wish line through one applier with one pending write', () => {
  const script = pageScript()
  // The applier is the only writer of the wish line's fade class, and it is the
  // one the entry point routes through.
  const applierAt = script.indexOf('function setSayingText(')
  assert.notEqual(applierAt, -1, 'the wish line must be written by setSayingText')
  assert.match(script, /if \(view\.sayings\) startSayings\(view\.sayings\);/u,
    'render() must hand the pushed array to the rotation')
  assert.doesNotMatch(script, /view\.saying\b/u, 'the singular field is gone; the page reads the array')
  const fadeAdds = script.match(/classList\.add\('fade-saying'\)/gu) ?? []
  assert.equal(fadeAdds.length, 1, 'exactly one place may arm the wish line\'s fade')
  const headlineFadeAdds = script.match(/classList\.add\('fade-trans'\)/gu) ?? []
  assert.equal(headlineFadeAdds.length, 1, 'the headline keeps its own single fade seat')

  const applier = script.slice(applierAt, script.indexOf('function startSayings(', applierAt))
  assert.match(applier, /clearTimeout\(sayingSwap\)/u,
    'a newer line must cancel the pending write instead of stacking a second timer')
  assert.match(applier, /sayingNeedsWrite\(sayingEl\.textContent, text\)\s*\) return;/u,
    'the write decision must come from the pure rule, not from "the text differs"')
  assert.ok(applier.indexOf('sayingNeedsWrite(') < applier.indexOf("classList.add('fade-saying')"),
    'the unchanged-line exit must come before the fade is armed')

  // One timer, and the tick goes through the pure index rule.
  const installer = script.slice(script.indexOf('function startSayings(', applierAt),
    script.indexOf('Reactive State Dispatcher', applierAt))
  assert.equal((installer.match(/setInterval\(/gu) ?? []).length, 1, 'the rotation owns exactly one interval')
  assert.match(installer, /sayingIndexAfter\(sayingIndex, plan\.lines\.length\)/u,
    'each tick must advance through sayingIndexAfter')
  assert.match(installer, /if \(key === sayingKey\) return;/u,
    'an identical push must leave the timer and the index alone')
})

test('the page\'s fallback line is the shell\'s first pushed line', () => {
  // A page that never got a push shows the markup's own text. It has to be the
  // line the rotation starts from, or the first paint is a sentence the
  // rotation never shows again.
  const shell = readFileSync(SHELL, 'utf8')
  const listAt = shell.indexOf('const SPLASH_SAYING_KEYS: readonly MessageKey[] = [')
  assert.notEqual(listAt, -1, 'the shell must declare SPLASH_SAYING_KEYS')
  const keys = [...shell.slice(listAt, shell.indexOf(']', shell.indexOf('= [', listAt)))
    .matchAll(/'([^']+)'/gu)].map((m) => m[1])
  assert.ok(keys.length >= 2, `the shell must push at least two lines, got ${JSON.stringify(keys)}`)

  const zh = require('../dist/shared/locale.js').messagesFor('zh-CN')
  for (const key of keys) assert.ok(zh[key] !== undefined, `zh-CN is missing ${key}`)

  const html = readFileSync(PAGE, 'utf8')
  const fallback = /<span id="startup-saying">([^<]*)<\/span>/u.exec(html)
  assert.notEqual(fallback, null, 'the page must carry a #startup-saying fallback')
  assert.equal(fallback[1], zh[keys[0]], 'the page\'s fallback must be the shell\'s first line')
  assert.equal(zh[keys[1]], '想要的太多，需要的不多', 'the second line is the requested one')
})
