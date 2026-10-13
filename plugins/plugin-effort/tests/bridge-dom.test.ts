/**
 * What the bridge does to the official row, and what it puts back.
 *
 * The capsule is a WRITE to a node this plugin does not own, which is the one
 * thing the rest of this suite never covered: every other test here is a pure
 * function, and a restore that quietly writes `"undefined"` into the row's inline
 * style, or that misses one of the five properties, passes all of them.
 *
 * So the bridge is run for real against the DOM stub, and the assertions are about
 * the row afterwards: the capsule's own values while it is injected, the row's
 * ORIGINAL values once it is not, and the paths that re-assert the level — a scan
 * after something cleared the inline styles, a level change, and the ring being
 * rewritten by every one of those paints.
 *
 * The fixture is the real row shape: `[span.cellLabel, span.cellValue,
 * svg.cellChevron]`, read from the installed kernel's own component, with the
 * container appended as a fourth child. A two-child fixture would have hidden the
 * case where index 1 is the chevron.
 *
 * @module plugin-effort/tests/bridge-dom
 */

import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'node:test'
import {
  ROW_PADDING_BLOCK,
  capsuleShadow,
  createEffortBridge,
  type EffortBridge,
  type EffortBridgeHost,
  type EffortBridgeWindow,
  type LevelColors,
} from '../src/client/bridge.ts'
import { NEUTRAL_RING } from '../src/client/value-color.ts'
import {
  StubDocument,
  StubElement,
  StubEvent,
  StubWindow,
  resetStubs,
  resizeObservers,
} from './dom-stub.ts'

/** The level the stub hands the bridge first. */
const LEVEL: LevelColors = { text: '#123456', ring: 'rgb(1 2 3 / 85%)' }

/** A different level, for the paints that must overwrite the first one. */
const NEXT_LEVEL: LevelColors = { text: '#654321', ring: 'rgb(9 8 7 / 75%)' }

/** The value cell's own colour, set by the fixture before the bridge runs. */
const OWN_COLOR = 'rgb(1, 2, 3)'

/** The row's own height, as the official `.cell` declares it. */
const OWN_HEIGHT = '34px'

/** One row of the fixture: the button the bridge sees, and the cells inside it. */
interface FixtureRow {
  readonly button: StubElement
  readonly label: StubElement
  readonly value: StubElement
  readonly chevron: StubElement
}

/** Everything one test needs to drive the bridge. */
interface Fixture {
  readonly doc: StubDocument
  readonly win: StubWindow
  readonly anchor: StubElement
  readonly menu: StubElement
  readonly effort: FixtureRow
}

/**
 * Build a document shaped the way the official menu is: a composer card holding
 * the anchor and the menu trigger, and a portaled menu whose two drill rows carry
 * a label, a value cell and a drill chevron.
 *
 * @returns the fixture.
 */
function fixture(): Fixture {
  const doc = new StubDocument(new StubElement('body'))
  const card = new StubElement('div')
  card.setAttribute('data-composer-card', '')
  const anchor = new StubElement('span')
  const trigger = new StubElement('button')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-controls', 'menu-1')
  card.appendChild(anchor)
  card.appendChild(trigger)
  doc.body.appendChild(card)

  const menu = new StubElement('div')
  menu.setAttribute('role', 'menu')
  doc.register('menu-1', menu)
  doc.body.appendChild(menu)

  const model = row('模型', '自动')
  const effort = row('推理等级', 'Max')
  menu.appendChild(model.button)
  menu.appendChild(effort.button)
  // The row as the official component rendered it: a fixed height, no wrap, and
  // an inline shadow of its own. A restore that only cleared properties would
  // pass on a row that had none, so the fixture gives it some.
  effort.button.style.height = OWN_HEIGHT
  effort.button.style.boxShadow = 'none'
  effort.value.style.color = OWN_COLOR

  return { doc, win: new StubWindow(), anchor, menu, effort }
}

/**
 * @param label - the row's label text.
 * @param value - the row's value text.
 * @returns the row's parts.
 */
function row(label: string, value: string): FixtureRow {
  const button = new StubElement('button')
  button.setAttribute('role', 'menuitem')
  const labelCell = new StubElement('span')
  labelCell.textContent = label
  const valueCell = new StubElement('span')
  valueCell.textContent = value
  const chevron = new StubElement('svg')
  button.appendChild(labelCell)
  button.appendChild(valueCell)
  button.appendChild(chevron)
  return { button, label: labelCell, value: valueCell, chevron }
}

/**
 * Start a bridge over the fixture.
 * @param fixture - the document to drive.
 * @param levelColors - what the bridge is told the level's colours are.
 * @returns the bridge and a getter for the host it was handed.
 */
function bridgeOver(fixture: Fixture, levelColors: () => LevelColors | null = () => LEVEL): {
  bridge: EffortBridge
  host: () => EffortBridgeHost | null
} {
  let host: EffortBridgeHost | null = null
  const bridge = createEffortBridge({
    doc: fixture.doc as unknown as Document,
    win: fixture.win as unknown as EffortBridgeWindow,
    anchor: () => fixture.anchor,
    labels: () => ({ model: '模型', effort: '推理等级' }),
    active: () => true,
    levelColors,
    onHost: (next) => { host = next },
  })
  assert.ok(bridge !== null, 'the bridge refused a document that has everything it asks for')
  return { bridge, host: () => host }
}

beforeEach(() => {
  resetStubs()
})

describe('the capsule', () => {
  it('turns the official row into the container\'s own line', () => {
    const parts = fixture()
    const { bridge, host } = bridgeOver(parts)
    bridge.start()
    const container = host()?.container
    assert.ok(container !== undefined && container !== null, 'no container was handed to React')
    assert.equal(container.className, 'dshAppEffort')
    assert.equal(container.getAttribute('role'), 'none')
    // INSIDE the row, not beside it: that is what makes the track the row's
    // second line rather than a block under the menu item. It is the row's fourth
    // child, after the label, the value cell and the chevron.
    assert.equal(container.parentNode, parts.effort.button)
    assert.equal(parts.effort.button.children.length, 4)
    assert.equal(host()?.row, parts.effort.button)
    assert.equal(parts.effort.button.style.height, 'auto')
    assert.equal(parts.effort.button.style.flexWrap, 'wrap')
    assert.equal(parts.effort.button.style.paddingTop, ROW_PADDING_BLOCK)
    assert.equal(parts.effort.button.style.paddingBottom, ROW_PADDING_BLOCK)
  })

  it('edges the capsule in the level\'s own colour, and re-edges it per paint', () => {
    const parts = fixture()
    let level = LEVEL
    const { bridge } = bridgeOver(parts, () => level)
    bridge.start()
    assert.equal(parts.effort.button.style.boxShadow, capsuleShadow(LEVEL.ring))
    level = NEXT_LEVEL
    bridge.paint()
    assert.equal(parts.effort.button.style.boxShadow, capsuleShadow(NEXT_LEVEL.ring))
  })

  it('re-asserts the geometry on the next scan, not only on the next injection', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    // Something cleared the capsule's geometry. Without the re-assert in `paint`
    // the row would stay a 34px menu item with the track hanging out of it until
    // the row happened to be replaced.
    parts.effort.button.style.height = ''
    parts.effort.button.style.flexWrap = ''
    parts.effort.button.style.paddingTop = ''
    parts.effort.button.style.paddingBottom = ''
    bridge.scan()
    assert.equal(parts.effort.button.style.height, 'auto')
    assert.equal(parts.effort.button.style.flexWrap, 'wrap')
    assert.equal(parts.effort.button.style.paddingTop, ROW_PADDING_BLOCK)
    assert.equal(parts.effort.button.style.paddingBottom, ROW_PADDING_BLOCK)
  })

  it('asks the menu to place itself again before the first frame, then on container resizes', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    // Synchronous: the injection happens inside a MutationObserver callback, and a
    // coalesced dispatch would let the menu paint once at its old height.
    assert.deepEqual(parts.win.dispatched, ['resize'])
    assert.equal(parts.win.pending, 0)
    resizeObservers.at(-1)?.notify()
    assert.deepEqual(parts.win.dispatched, ['resize'], 'the observer path dispatched without being coalesced')
    parts.win.flush()
    assert.deepEqual(parts.win.dispatched, ['resize', 'resize'])
  })
})

describe('the level name', () => {
  it('carries the level\'s colour, and its own colour comes back when there is no level', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    assert.equal(parts.effort.value.style.color, LEVEL.text)
    bridge.dispose()
    assert.equal(parts.effort.value.style.color, OWN_COLOR)

    const none = fixture()
    const second = bridgeOver(none, () => null)
    second.bridge.start()
    assert.equal(none.effort.value.style.color, OWN_COLOR)
  })

  it('falls back to a neutral edge when there is no level to colour it by', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts, () => null)
    bridge.start()
    // Still an edge — the capsule has to read as a capsule — but not one that
    // claims a position.
    assert.equal(parts.effort.button.style.boxShadow, capsuleShadow(NEUTRAL_RING))
  })

  it('comes back on the next scan after something clears it', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    // The official component re-rendered the cell and dropped the inline colour.
    // That is an attribute change, which this bridge's observer does not watch —
    // the re-assert is what covers it.
    parts.effort.value.style.color = ''
    parts.effort.button.style.boxShadow = 'none'
    bridge.scan()
    assert.equal(parts.effort.value.style.color, LEVEL.text)
    assert.equal(parts.effort.button.style.boxShadow, capsuleShadow(LEVEL.ring))
  })

  it('follows a cell the official component replaced', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    const replacement = new StubElement('span')
    replacement.textContent = 'High'
    replacement.style.color = 'rgb(9, 9, 9)'
    // In place: the official component re-created the cell, it did not move it.
    parts.effort.button.replaceChild(replacement, parts.effort.value)
    bridge.paint()
    assert.equal(replacement.style.color, LEVEL.text)
    bridge.dispose()
    // The REPLACEMENT's own colour, not the one the bridge captured from the cell
    // it replaced.
    assert.equal(replacement.style.color, 'rgb(9, 9, 9)')
  })

  it('tints nothing when index 1 is the chevron instead of a value cell', () => {
    const parts = fixture()
    const { bridge, host } = bridgeOver(parts)
    bridge.start()
    // The official component dropped the value cell, so the second child is now
    // the drill chevron. It must not be recoloured as if it were the name.
    parts.effort.button.removeChild(parts.effort.value)
    bridge.paint()
    assert.equal(parts.effort.chevron.style.color, undefined)
    assert.equal(host()?.container.style.color, undefined)
    assert.equal(parts.effort.button.style.boxShadow, capsuleShadow(LEVEL.ring))
  })

  it('tints nothing when the row has no second child at all', () => {
    const parts = fixture()
    const { bridge, host } = bridgeOver(parts)
    bridge.start()
    parts.effort.button.removeChild(parts.effort.value)
    parts.effort.button.removeChild(parts.effort.chevron)
    bridge.paint()
    assert.equal(host()?.container.style.color, undefined)
  })
})

describe('the restore', () => {
  it('puts every property back to the row\'s own value', () => {
    const parts = fixture()
    const { bridge, host } = bridgeOver(parts)
    bridge.start()
    const container = host()?.container
    bridge.dispose()
    assert.equal(parts.effort.button.style.height, OWN_HEIGHT)
    assert.equal(parts.effort.button.style.boxShadow, 'none')
    // Never set by the official component, so the restore clears it rather than
    // writing a literal back.
    assert.equal(parts.effort.button.style.flexWrap, '')
    assert.equal(parts.effort.button.style.paddingTop, '')
    assert.equal(parts.effort.button.style.paddingBottom, '')
    assert.equal(parts.effort.value.style.color, OWN_COLOR)
    assert.equal(container?.parentNode, null)
  })

  it('still restores the official values after the capsule was repainted', () => {
    const parts = fixture()
    let level = LEVEL
    const { bridge } = bridgeOver(parts, () => level)
    bridge.start()
    // Every paint rewrites the geometry and the ring, so a snapshot taken after
    // the first one would capture OUR values and restore them as if they were the
    // official ones.
    for (const next of [NEXT_LEVEL, LEVEL, NEXT_LEVEL]) {
      level = next
      bridge.paint()
      bridge.scan()
    }
    assert.equal(parts.effort.button.style.boxShadow, capsuleShadow(NEXT_LEVEL.ring))
    bridge.dispose()
    assert.equal(parts.effort.button.style.height, OWN_HEIGHT)
    assert.equal(parts.effort.button.style.flexWrap, '')
    assert.equal(parts.effort.button.style.paddingTop, '')
    assert.equal(parts.effort.button.style.paddingBottom, '')
    assert.equal(parts.effort.button.style.boxShadow, 'none')
    assert.equal(parts.effort.value.style.color, OWN_COLOR)
  })

  it('is safe on a row the official component has already replaced', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    parts.effort.button.remove()
    assert.doesNotThrow(() => bridge.scan())
    // Detached, but still restored: the write reaches nothing and throws nothing.
    assert.equal(parts.effort.button.style.height, OWN_HEIGHT)
    assert.equal(parts.effort.value.style.color, OWN_COLOR)
  })

  it('injects nothing when the row it expects is not there', () => {
    const parts = fixture()
    parts.menu.removeChild(parts.effort.button)
    const { bridge, host } = bridgeOver(parts)
    bridge.start()
    assert.equal(host(), null)
    assert.equal(parts.menu.children.length, 1)
  })
})

describe('the container\'s hit area', () => {
  it('leaves the container out of the event path entirely', () => {
    const parts = fixture()
    const { bridge, host } = bridgeOver(parts)
    bridge.start()
    const container = host()?.container
    assert.ok(container !== undefined && container !== null)
    // No listener of ours: the guard is `pointer-events: none` in the stylesheet
    // (asserted in styles.test.ts), because React's own delegated listeners are
    // attached to this very node and `stopPropagation` cannot win that race.
    assert.equal(container.listeners.get('click'), undefined)
    assert.equal(container.listeners.size, 0)
  })

  it('does not swallow a click that lands on the container itself', () => {
    const parts = fixture()
    const { bridge, host } = bridgeOver(parts)
    bridge.start()
    const reached: string[] = []
    // Stands in for the app root, where React's delegated listener for the row
    // lives: a click that reaches it is a click the row's own onClick also sees.
    // That is the ROW's behaviour and not this module's to take away — what this
    // module does instead is keep the pointer off the container in the first place.
    parts.doc.body.addEventListener('click', () => reached.push('body'))
    const stray = new StubElement('div')
    host()?.container.appendChild(stray)
    stray.dispatchEvent(new StubEvent('click'))
    assert.deepEqual(reached, ['body'])
  })
})
