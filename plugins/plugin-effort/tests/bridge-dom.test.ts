/**
 * What the bridge does to the official DOM, and what it puts back.
 *
 * Both surfaces are WRITES to nodes this plugin does not own, which is the one
 * thing the rest of this suite never covered: every other test here is a pure
 * function, and a restore that quietly writes `"undefined"` into the row's inline
 * style, or that misses one of the five properties, passes all of them.
 *
 * So the bridge is run for real against the DOM stub, and the assertions are about
 * the DOM afterwards: the capsule's own values while it is injected, the row's
 * ORIGINAL values once it is not, and the paths that re-assert the level — a scan
 * after something cleared the inline styles, a level change, and the ring being
 * rewritten by every one of those paints. The SECOND surface gets the same
 * treatment: the composer capsule's own level text takes the same colour under the
 * mark the stylesheet keys on, is painted whether or not the menu is open, and is
 * given its own colour back — mark and all — when there is no level or the bridge is
 * disposed.
 *
 * A third group is about WHERE those writes land, and about the one observer that
 * decides when they happen again. A composer card can hold more than one
 * `button[aria-haspopup="menu"]`, so two decoys live in the fixtures — one with the
 * model trigger's own four children, one with the hero chip's three — and the answer
 * has to be the model trigger in both, because the kernel's own `aria-expanded`
 * marker outranks DOM order and a candidate whose children are the wrong shape is
 * skipped rather than answered with null. The theme observer's OPTIONS are asserted
 * for the same reason the writes are: they are what makes a theme flip a repaint,
 * and with a stub that had no `MutationObserver` — so `start()` never entered that
 * branch — a misspelled `attributeFilter`, or the whole `attributes: true` clause
 * deleted, passed every test in this suite.
 *
 * The fixture is the real shapes: the row as `[span.cellLabel, span.cellValue,
 * svg.cellChevron]` (with the container appended as a fourth child) and the model
 * trigger as `[svg.triggerIcon, span.triggerLabel, span.triggerEffort,
 * svg.chevron]`, both read from the installed kernel's own components. A
 * two-child fixture would have hidden the case where index 1 is the chevron, and a
 * three-child trigger the case where index 2 is.
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
  mutationObservers,
  resetStubs,
  resizeObservers,
} from './dom-stub.ts'

/** The level the stub hands the bridge first. */
const LEVEL: LevelColors = { level: 'max', text: '#123456', ring: 'rgb(1 2 3 / 85%)' }

/** A different level, for the paints that must overwrite the first one. */
const NEXT_LEVEL: LevelColors = { level: 'low', text: '#654321', ring: 'rgb(9 8 7 / 75%)' }

/** The same level's colours in the other theme, which a theme flip has to produce. */
const DARK_LEVEL: LevelColors = { level: 'dark-max', text: '#B9A6FF', ring: 'rgb(185 166 255 / 75%)' }

/**
 * The attribute the kernel flips on the body for the dark theme, spelled out.
 *
 * Not read from `DARK_THEME_ATTRIBUTE`: the assertion on the observer's
 * `attributeFilter` is a contract with the KERNEL, and taking the name from the
 * same constant the bridge writes would keep that assertion green if the constant
 * were renamed to something the kernel never sets. `styles.test.ts` and
 * `value-color.test.ts` spell it out the same way.
 */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** The value cell's own colour, set by the fixture before the bridge runs. */
const OWN_COLOR = 'rgb(1, 2, 3)'

/** The composer's level text own colour, set by the fixture before the bridge runs. */
const OWN_TEXT_COLOR = 'rgb(4, 5, 6)'

/** The mark the stylesheet keys on, spelled out: the two halves are one contract. */
const MARK = 'data-dshAppEffort'

/** The row's own height, as the official `.cell` declares it. */
const OWN_HEIGHT = '34px'

/** One row of the fixture: the button the bridge sees, and the cells inside it. */
interface FixtureRow {
  readonly button: StubElement
  readonly label: StubElement
  readonly value: StubElement
  readonly chevron: StubElement
}

/**
 * The composer's model trigger, as the installed model-selection component renders
 * it: `[svg icon, span modelLabel, span effortLabel, svg chevron]`.
 */
interface FixtureTrigger {
  readonly button: StubElement
  readonly icon: StubElement
  readonly label: StubElement
  readonly effort: StubElement
  readonly chevron: StubElement
}

/** A decoy menu button a fixture may be given, and the child a wrong answer lands on. */
interface FixtureDecoy {
  readonly button: StubElement
  /** The decoy's OWN third child: what a "first match" locator colours instead. */
  readonly third: StubElement
}

/** What a fixture can be asked for, beyond the shapes every test needs. */
interface FixtureOptions {
  /** Withhold the window's `MutationObserver`, which is the only way to the sweep. */
  readonly mutationObserver?: boolean
  /**
   * A second `button[aria-haspopup="menu"]` placed BEFORE the model trigger in the
   * card. `'shape-identical'` renders the trigger's own four children (the decoy
   * that took the level's colour and its mark); `'different-shape'` renders the
   * hero workspace chip's three (the decoy that made the feature do nothing at all,
   * because the shape rule rejected the button the locator stopped at).
   */
  readonly decoy?: 'shape-identical' | 'different-shape'
}

/** Everything one test needs to drive the bridge. */
interface Fixture {
  readonly doc: StubDocument
  readonly win: StubWindow
  readonly anchor: StubElement
  readonly trigger: FixtureTrigger
  readonly menu: StubElement
  readonly effort: FixtureRow
  /** The decoy button, or null when this fixture was not asked for one. */
  readonly decoy: FixtureDecoy | null
}

/**
 * Build a document shaped the way the official composer and menu are: a composer
 * card holding the anchor and the model trigger (whose own level text the bridge
 * colours), and a portaled menu whose two drill rows carry a label, a value cell
 * and a drill chevron.
 *
 * The trigger is nested two elements deep inside the card rather than left a direct
 * child, because the bridge reaches it by query and the real card has the tool row
 * and the trigger's own root in between. A decoy, when one is asked for, is a
 * DIRECT child of the card placed before both — which is where a locator that
 * answers with the first match finds it and where a candidate search has to walk
 * past it.
 *
 * @param options - the decoy to include, and which window to build.
 * @returns the fixture.
 */
function fixture(options: FixtureOptions = {}): Fixture {
  const doc = new StubDocument(new StubElement('body'))
  const card = new StubElement('div')
  card.setAttribute('data-composer-card', '')
  const anchor = new StubElement('span')
  const row = new StubElement('div')
  const root = new StubElement('div')
  const trigger = triggerShape()
  trigger.button.setAttribute('aria-controls', 'menu-1')
  row.appendChild(trigger.button)
  root.appendChild(row)
  const decoy = options.decoy === undefined ? null : decoyShape(options.decoy)
  if (decoy !== null) card.appendChild(decoy.button)
  card.appendChild(anchor)
  card.appendChild(root)
  doc.body.appendChild(card)

  const menu = new StubElement('div')
  menu.setAttribute('role', 'menu')
  doc.register('menu-1', menu)
  doc.body.appendChild(menu)

  const model = rowShape('模型', '自动')
  const effort = rowShape('推理等级', 'Max')
  menu.appendChild(model.button)
  menu.appendChild(effort.button)
  // The row as the official component rendered it: a fixed height, no wrap, and
  // an inline shadow of its own. A restore that only cleared properties would
  // pass on a row that had none, so the fixture gives it some.
  effort.button.style.height = OWN_HEIGHT
  effort.button.style.boxShadow = 'none'
  effort.value.style.color = OWN_COLOR

  return { doc, win: new StubWindow(options), anchor, trigger, menu, effort, decoy }
}

/**
 * A second menu button inside the card, in front of the model trigger.
 *
 * Two shapes, because the locator failed in two directions and both are worth a
 * fixture: the trigger's own four children (a wrong answer colours this button's
 * third child and leaves the real level text at the kernel's caption tone), and the
 * hero chip's three (a wrong answer colours nothing at all, because the shape rule
 * rejects the button the search stopped at).
 *
 * @param shape - which decoy to build.
 * @returns the button and its own third child.
 */
function decoyShape(shape: 'shape-identical' | 'different-shape'): FixtureDecoy {
  const button = new StubElement('button')
  button.setAttribute('aria-haspopup', 'menu')
  const tags = shape === 'shape-identical' ? ['svg', 'span', 'span', 'svg'] : ['svg', 'span', 'svg']
  const parts = tags.map(tag => new StubElement(tag))
  const label = parts[1] as StubElement
  label.textContent = 'workspace'
  const third = parts[2] as StubElement
  if (shape === 'shape-identical') third.textContent = 'Decoy level'
  for (const part of parts) button.appendChild(part)
  return { button, third }
}

/**
 * The composer's model trigger as the installed component renders it: the icon, the
 * model label, the level text and the drill chevron, in that order.
 *
 * @returns the trigger's parts.
 */
function triggerShape(): FixtureTrigger {
  const button = new StubElement('button')
  button.setAttribute('aria-haspopup', 'menu')
  // The kernel renders `"aria-expanded": open` on this button on EVERY render,
  // closed included, and that attribute is the marker the candidate rule ranks on —
  // so the fixture carries it too, or the fixture would be modelling a button the
  // kernel never mounts.
  button.setAttribute('aria-expanded', 'false')
  const icon = new StubElement('svg')
  const label = new StubElement('span')
  label.textContent = 'global:deepseek-v4.1-flash'
  const effort = new StubElement('span')
  effort.textContent = 'Max'
  // Its own colour, so the restore has something to put back that is not ours.
  effort.style.color = OWN_TEXT_COLOR
  const chevron = new StubElement('svg')
  for (const child of [icon, label, effort, chevron]) button.appendChild(child)
  return { button, icon, label, effort, chevron }
}

/**
 * @param label - the row's label text.
 * @param value - the row's value text.
 * @returns the row's parts.
 */
function rowShape(label: string, value: string): FixtureRow {
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

/**
 * Every mark this plugin left inside a subtree, as `tag:value`.
 * @param root - the element to walk.
 * @returns the marks, in document order.
 */
function marksIn(root: StubElement): string[] {
  const out: string[] = []
  const value = root.getAttribute(MARK)
  if (value !== null) out.push(`${root.tagName.toLowerCase()}:${value}`)
  for (const child of root.children) out.push(...marksIn(child))
  return out
}

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

describe('the composer capsule\'s level text', () => {
  it('takes the level\'s own colour, under the mark the stylesheet keys on', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    // The colour is the menu cell's colour, and the mark names the level it is the
    // colour OF. Both are spelled out: the mark is a contract with the stylesheet,
    // and an assertion against a shared constant would pass on a rename that broke
    // the rule in `styles.ts` while every test stayed green.
    assert.equal(parts.trigger.effort.style.color, LEVEL.text)
    assert.equal(parts.trigger.effort.getAttribute(MARK), 'max')
  })

  it('follows the level: the mark and the colour move in one paint', () => {
    const parts = fixture()
    let level = LEVEL
    const { bridge } = bridgeOver(parts, () => level)
    bridge.start()
    level = NEXT_LEVEL
    bridge.paint()
    assert.equal(parts.trigger.effort.style.color, NEXT_LEVEL.text)
    assert.equal(parts.trigger.effort.getAttribute(MARK), 'low')
  })

  it('is painted with the menu closed, which is when it is actually read', () => {
    const parts = fixture()
    // The steady state of a session: no open menu, no menu in the document at all,
    // and no row for the capsule's injection to live in.
    parts.trigger.button.removeAttribute('aria-controls')
    parts.menu.remove()
    const { bridge, host } = bridgeOver(parts)
    bridge.start()
    assert.equal(host(), null, 'a menu was injected out of nothing')
    assert.equal(parts.trigger.effort.style.color, LEVEL.text)
    assert.equal(parts.trigger.effort.getAttribute(MARK), 'max')
  })

  it('keeps the kernel\'s own colour while there is no level, and takes it back after', () => {
    const parts = fixture()
    let level: LevelColors | null = null
    const { bridge } = bridgeOver(parts, () => level)
    bridge.start()
    // No position on the scale: the text goes back to the caption tone the official
    // component gave it, and the mark (and with it the heavier weight) comes off.
    assert.equal(parts.trigger.effort.style.color, OWN_TEXT_COLOR)
    assert.equal(parts.trigger.effort.getAttribute(MARK), null)
    assert.equal(parts.trigger.label.style.color, undefined)
    assert.equal(parts.trigger.icon.style.color, undefined)

    level = LEVEL
    bridge.paint()
    assert.equal(parts.trigger.effort.style.color, LEVEL.text)
    assert.equal(parts.trigger.effort.getAttribute(MARK), 'max')

    level = null
    bridge.scan()
    assert.equal(parts.trigger.effort.style.color, OWN_TEXT_COLOR)
    assert.equal(parts.trigger.effort.getAttribute(MARK), null)
  })

  it('comes back on the next scan after something cleared it', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    // The official component re-rendered the span and dropped both the colour and
    // the mark. Neither is an attribute change this observer watches, so the
    // re-assert on every scan is what covers it.
    parts.trigger.effort.style.color = ''
    parts.trigger.effort.removeAttribute(MARK)
    bridge.scan()
    assert.equal(parts.trigger.effort.style.color, LEVEL.text)
    assert.equal(parts.trigger.effort.getAttribute(MARK), 'max')
  })

  it('marks one attribute on one node, however many times it is painted', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    for (let pass = 0; pass < 5; pass += 1) bridge.paint()
    bridge.scan()
    const marks = [...parts.trigger.effort.attributes.keys()].filter(name => name.startsWith('data-dshApp'))
    assert.deepEqual(marks, [MARK])
    // Still the kernel's own span: nothing was inserted beside it or in front of it.
    assert.equal(parts.trigger.button.children.length, 4)
    assert.equal(parts.trigger.button.children.item(2), parts.trigger.effort)
  })

  it('follows a level text the official component replaced', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    const replacement = new StubElement('span')
    replacement.textContent = 'Low'
    replacement.style.color = 'rgb(7, 7, 7)'
    parts.trigger.button.replaceChild(replacement, parts.trigger.effort)
    bridge.paint()
    assert.equal(replacement.style.color, LEVEL.text)
    assert.equal(replacement.getAttribute(MARK), 'max')
    // The node it replaced keeps what the bridge had put on it, and gets its own
    // colour back rather than being left coloured by a bridge that no longer owns it.
    assert.equal(parts.trigger.effort.style.color, OWN_TEXT_COLOR)
    assert.equal(parts.trigger.effort.getAttribute(MARK), null)
    bridge.dispose()
    assert.equal(replacement.style.color, 'rgb(7, 7, 7)')
    assert.equal(replacement.getAttribute(MARK), null)
  })

  it('writes nothing when the trigger is not the shape it expects', () => {
    // A model that advertises no levels renders three children, and then index 2 is
    // the chevron: colouring it would paint the level onto an icon.
    const parts = fixture()
    parts.trigger.button.removeChild(parts.trigger.effort)
    const { bridge } = bridgeOver(parts)
    bridge.start()
    assert.deepEqual(marksIn(parts.trigger.button), [])
    assert.equal(parts.trigger.chevron.style.color, undefined)
    assert.equal(parts.trigger.label.style.color, undefined)

    // And a four-child trigger whose third child is not a span is refused too.
    const other = fixture()
    other.trigger.button.removeChild(other.trigger.effort)
    const svg = new StubElement('svg')
    other.trigger.button.appendChild(svg)
    const second = bridgeOver(other)
    second.bridge.start()
    assert.equal(svg.style.color, undefined)
    assert.deepEqual(marksIn(other.trigger.button), [])
  })

  it('refuses a level text a further span was inserted in front of', () => {
    const parts = fixture()
    const button = parts.trigger.button
    // A future build inserting an element between the model name and the level
    // text: index 2 is then the INSERTED node. Under a "four or more" child test
    // that node took the level's colour and its mark while the real level text kept
    // the kernel's caption tone — a wrong node coloured, the one outcome this
    // module exists to refuse. The trigger is left alone instead.
    const badge = new StubElement('span')
    badge.textContent = 'New'
    button.removeChild(parts.trigger.chevron)
    button.removeChild(parts.trigger.effort)
    button.appendChild(badge)
    button.appendChild(parts.trigger.effort)
    button.appendChild(parts.trigger.chevron)
    const { bridge } = bridgeOver(parts)
    bridge.start()
    assert.deepEqual(marksIn(parts.doc.body), [])
    assert.equal(badge.style.color, undefined)
    assert.equal(parts.trigger.effort.style.color, OWN_TEXT_COLOR)
  })

  it('gives the official colour back when the bridge is disposed', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    assert.equal(parts.trigger.effort.style.color, LEVEL.text)
    bridge.dispose()
    assert.equal(parts.trigger.effort.style.color, OWN_TEXT_COLOR)
    assert.equal(parts.trigger.effort.getAttribute(MARK), null)
  })
})

describe('the candidates in the composer card', () => {
  it('colours the model trigger, not a shape-identical menu button in front of it', () => {
    const parts = fixture({ decoy: 'shape-identical' })
    const { bridge } = bridgeOver(parts)
    bridge.start()
    assert.equal(parts.trigger.effort.style.color, LEVEL.text)
    assert.equal(parts.trigger.effort.getAttribute(MARK), 'max')
    // The decoy carries the trigger's own four children, so the shape cannot choose
    // between the two: the kernel's own open-state attribute does, and the decoy has
    // no `aria-expanded`. A "first match" locator wrote the colour and the mark onto
    // the decoy's third child and left the real level text at the caption tone.
    const decoy = parts.decoy as FixtureDecoy
    assert.equal(decoy.third.style.color, undefined)
    assert.equal(decoy.third.getAttribute(MARK), null)
    assert.deepEqual(marksIn(decoy.button), [])
  })

  it('does not go silent when the menu button in front of the trigger is another shape', () => {
    const parts = fixture({ decoy: 'different-shape' })
    const { bridge } = bridgeOver(parts)
    bridge.start()
    // A candidate that does not match is SKIPPED rather than answered with null.
    // The previous locator queried the first `aria-haspopup="menu"` and handed that
    // button to the shape rule, so this card coloured nothing at all — the real
    // trigger was never read.
    assert.equal(parts.trigger.effort.style.color, LEVEL.text)
    assert.equal(parts.trigger.effort.getAttribute(MARK), 'max')
  })

  it('writes nothing when every menu button in the card is the wrong shape', () => {
    const parts = fixture({ decoy: 'different-shape' })
    parts.trigger.button.removeChild(parts.trigger.effort)
    const { bridge } = bridgeOver(parts)
    bridge.start()
    assert.deepEqual(marksIn(parts.doc.body), [])
  })
})

describe('the theme observer', () => {
  it('watches the one attribute that means the theme, and repaints when it flips', () => {
    const parts = fixture()
    let dark = false
    const { bridge } = bridgeOver(parts, () => (dark ? DARK_LEVEL : LEVEL))
    bridge.start()
    const observer = mutationObservers.at(-1)
    assert.ok(observer !== undefined, 'the bridge constructed no MutationObserver')
    assert.equal(observer.target, parts.doc.body)
    // The options ARE the contract: the filter is what turns a theme flip into a
    // repaint, and `attributes: true` is what makes the filter do anything at all.
    // Both halves are asserted, because deleting either one used to pass every test
    // in this suite — the stub had no observer, so `start()` never got this far.
    assert.deepEqual(observer.options, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [DARK_ATTRIBUTE],
    })
    assert.equal(parts.trigger.effort.style.color, LEVEL.text)
    // The flip itself: the kernel toggles the attribute on the body and inserts
    // nothing, so this record is the only signal there is.
    dark = true
    parts.doc.body.setAttribute(DARK_ATTRIBUTE, '')
    observer.fire([{ type: 'attributes', attributeName: DARK_ATTRIBUTE }])
    assert.equal(parts.trigger.effort.style.color, DARK_LEVEL.text)
    assert.equal(parts.trigger.effort.getAttribute(MARK), 'dark-max')
  })

  it('is disconnected on dispose', () => {
    const parts = fixture()
    const { bridge } = bridgeOver(parts)
    bridge.start()
    const observer = mutationObservers.at(-1)
    bridge.dispose()
    assert.equal(observer?.disconnected, true)
  })
})

describe('the fallback sweep', () => {
  it('is what a host without a MutationObserver gets, and it reads the theme every pass', () => {
    const parts = fixture({ mutationObserver: false })
    let dark = false
    const { bridge } = bridgeOver(parts, () => (dark ? DARK_LEVEL : LEVEL))
    bridge.start()
    assert.equal(mutationObservers.length, 0, 'an observer was built for a window that has none')
    assert.equal(parts.win.armed, 1)
    assert.equal(parts.trigger.effort.style.color, LEVEL.text)
    // No observer means no signal at all: the colour is late by up to one interval.
    // That interval is the whole size of the mistake, which is why this path is the
    // last resort rather than a second watcher — see `start` in bridge.ts.
    dark = true
    parts.doc.body.setAttribute(DARK_ATTRIBUTE, '')
    parts.win.tickIntervals()
    assert.equal(parts.trigger.effort.style.color, DARK_LEVEL.text)
    bridge.dispose()
    assert.equal(parts.win.armed, 0)
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
