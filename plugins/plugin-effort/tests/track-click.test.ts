/**
 * The track swallows the `click` that follows a press-and-release on it.
 *
 * The failure this pins came from a user report rather than a theory: dragging the
 * knob and letting go opened the official level picker over the capsule. The
 * track's own handling is `pointer*`, so nothing in it stopped the `click` the
 * browser also emits for a down-and-up on one element — and that click bubbles out
 * of the container into the official row, whose `onClick` drills into the list.
 *
 * Every case here is a source rule (docs/agents/testing.md), for the same reason
 * plugin-rewind's icon is pinned that way: this plugin has no test that mounts
 * React. The bridge has a DOM harness; the component does not. Each rule is
 * scoped to the handler it describes. An earlier version matched
 * `onTrackClick` with a lazy pattern that scanned on to the NEXT
 * `stopPropagation()` in the file, so the track could lose its own with this
 * file green — measured. A comment that explains a handler is not something a
 * test can lose, and the rule that pinned one is gone.
 *
 * @module plugin-effort/tests/track-click
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const slider = readFileSync(
  fileURLToPath(new URL('../src/client/slider.tsx', import.meta.url)),
  'utf8',
)

/**
 * The block body of the arrow that follows `marker`, found by brace matching, so
 * a rule can only be satisfied by that handler's own code.
 *
 * @param text - the component's source.
 * @param marker - where the callback is declared.
 * @returns what sits between the arrow's braces.
 */
function blockAfter(text: string, marker: string): string {
  const at = text.indexOf(marker)
  assert.notEqual(at, -1, `${marker} is gone`)
  const open = text.indexOf('{', text.indexOf('=>', at))
  assert.notEqual(open, -1, `${marker} has no block body`)
  let depth = 1
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}' && (depth -= 1) === 0) return text.slice(open + 1, i)
  }
  assert.fail(`${marker} never closes`)
}

test('source rule: the track carries a click handler that stops propagation', () => {
  assert.match(slider, /onClick=\{onTrackClick\}/u, 'the track has no click handler')
  assert.match(
    blockAfter(slider, 'const onTrackClick = useCallback('),
    /event\.stopPropagation\(\)/u,
    'onTrackClick does not stop propagation',
  )
})

/**
 * The hover mark and the themed hint, pinned at the source.
 *
 * Both are one-line wiring facts that a green suite of geometry and CSS would not
 * notice losing: the component could fall back to a native `title` and the tests
 * would still pass, and the tick could stop deriving `data-hover` from the hover
 * state while the CSS rule stayed correct.
 */
test('source rule: the hint rides the kernel Tooltip, not a native title', () => {
  assert.match(slider, /import \{[^}]*\bTooltip\b[^}]*\} from '@deepseek-ai\/dsh-client-ui-primitives'/u, 'the themed tooltip is not imported')
  // The hint is the Tooltip's own label, on the opening tag: loose about where
  // the dictionary lookup lives (it could be hoisted to a const), strict about
  // which element carries it.
  const tag = /<Tooltip\b[^>]*>/u.exec(slider)?.[0] ?? ''
  assert.match(tag, /effort\.hint\.keys/u, 'the hint text is not on the Tooltip')
  assert.match(tag, /\bportal\b/u, 'the bubble is not portaled; `contain: inline-size` would misplace it')
  // `\s` rather than `\b`: `title="…"` is the natural way to put the native hint
  // back, and a `\btitle=\{` guard (this rule's first draft) let it through — the
  // exact regression this case exists to catch.
  assert.doesNotMatch(slider, /\stitle=/u, 'a native title is back, which the themed tooltip replaced')
})

test('source rule: the tick derives its hover mark from the hover state', () => {
  assert.match(slider, /data-hover=\{index === hoverIndex \? '1' : '0'\}/u, 'the tick no longer reports the hovered level')
  // One mapping for the mark and the write: the hover path must not re-implement
  // the mapping inline (the shape that was removed).
  assert.doesNotMatch(slider, /indexFromPct\(pct, count\)\)\n\s*setHoverIndex/u, 'the hover path re-implements the mapping inline')
})

test('source rule: the keys hint still reaches assistive technology', () => {
  // Replacing a native `title` with a hover-only bubble drops the description from
  // the accessibility tree, so the track states the shortcut itself.
  assert.match(slider, /aria-keyshortcuts="ArrowLeft ArrowRight"/u, 'the track no longer states its arrow keys')
})

test('source rule: the arrow keys the hint promises work from the official ROW too, not only the track', () => {
  // The defect this pins: the hint says "arrow keys change the level" and sits
  // beside the capsule, but the only listener used to be the track's own — the
  // thin bar. A user who clicked the capsule had focus on the ROW, pressed a key,
  // and nothing happened. `aria-keyshortcuts` was present the whole time, which is
  // why the rule above cannot see it: an attribute is not a behaviour.
  assert.match(
    slider,
    /row\.addEventListener\('keydown', listener\)/u,
    'the official row no longer listens for the arrow keys the hint promises',
  )
  // One key press must move one step: the track lives INSIDE the row, so the row
  // listener has to skip events whose target is inside the track.
  assert.match(
    slider,
    /track\.contains\(event\.target\)\) return/u,
    'the row listener does not exempt the track, so one press would step twice',
  )
})

test('source rule: the step table is shared by both listeners instead of written twice', () => {
  // Two copies of "ArrowLeft means index-1" is how the two surfaces drift apart.
  // The count is the rule: whichever callback holds the table, both the track and
  // the row must step through it.
  const stepCalls = [...slider.matchAll(/if \(stepTo\(/gu)].length
  assert.equal(stepCalls, 2, `stepTo is called from ${String(stepCalls)} listener(s); both the track and the row must call it`)
})
