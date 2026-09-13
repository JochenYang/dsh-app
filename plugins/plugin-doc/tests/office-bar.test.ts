/**
 * The office-bar DOM contract as this plugin implements it: one container per
 * document however many contributors ask for it, one host per format however
 * often a plugin remounts, canonical format order, and no residue (host, bar or
 * observer) after a contributor leaves. The placement decision and slot order
 * are pure and pinned directly; the write helpers run against a minimal element
 * double so the shared-bar invariants are exercised for real.
 *
 * @module @dsh-app/plugin-doc/tests/office-bar
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPOSER_CARD_SELECTOR,
  OFFICE_BAR_CLASS,
  OFFICE_FORMAT_ATTR,
  OFFICE_SLOT_CLASS,
  acquireOfficeBar,
  contributeOfficeCapsule,
  ensureOfficeSlot,
  findOfficeBar,
  officeBarPlacement,
  orderOfficeFormats,
  sortOfficeSlots,
} from '../src/client/office-bar.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Element double covering exactly the operations office-bar.ts performs. */
class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly nodes: FakeElement[] = []
  parent: FakeElement | undefined
  private readonly classes = new Set<string>()

  constructor(private readonly tag: string) {}

  get className(): string { return [...this.classes].join(' ') }
  set className(value: string) {
    this.classes.clear()
    for (const name of value.split(/\s+/)) if (name !== '') this.classes.add(name)
  }
  get classList(): { contains: (name: string) => boolean } {
    return { contains: name => this.classes.has(name) }
  }
  get children(): FakeElement[] { return this.nodes }
  get nextElementSibling(): FakeElement | undefined {
    const parent = this.parent
    if (parent === undefined) return undefined
    return parent.nodes[parent.nodes.indexOf(this) + 1]
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.detachFromParent()
      node.parent = this
      this.nodes.push(node)
    }
  }
  remove(): void {
    this.detachFromParent()
    this.parent = undefined
  }
  insertAdjacentElement(position: string, node: FakeElement): void {
    if (position !== 'afterend') throw new Error(`unsupported position: ${position}`)
    const parent = this.parent
    if (parent === undefined) throw new Error('afterend requires a parent')
    node.detachFromParent()
    parent.nodes.splice(parent.nodes.indexOf(this) + 1, 0, node)
    node.parent = parent
  }
  matches(selector: string): boolean {
    const parsed = /^([a-z]+)(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/.exec(selector)
    if (parsed === null) throw new Error(`unsupported selector: ${selector}`)
    const [, tag, className, attribute] = parsed
    if (tag !== undefined && this.tag !== tag) return false
    if (className !== undefined && !this.classes.has(className)) return false
    if (attribute !== undefined && !this.attributes.has(attribute)) return false
    return true
  }
  querySelector(selector: string): FakeElement | null {
    for (const node of this.nodes) {
      if (node.matches(selector)) return node
      const nested = node.querySelector(selector)
      if (nested !== null) return nested
    }
    return null
  }
  private detachFromParent(): void {
    const parent = this.parent
    if (parent === undefined) return
    const index = parent.nodes.indexOf(this)
    if (index !== -1) parent.nodes.splice(index, 1)
  }
}

/** The document double: a root element that also mints elements. */
class FakeDocument extends FakeElement {
  constructor() { super('#document') }
  createElement(tag: string): FakeElement { return new FakeElement(tag) }
}

interface FakeDom {
  document: FakeDocument
  mutate: () => void
  flush: () => void
  restore: () => void
}

/** Install the double over the globals office-bar.ts reads at call time. */
function installFakeDom(): FakeDom {
  const doc = new FakeDocument()
  const targets = globalThis as unknown as Record<string, unknown>
  const saved = {
    document: targets.document,
    MutationObserver: targets.MutationObserver,
    requestAnimationFrame: targets.requestAnimationFrame,
    cancelAnimationFrame: targets.cancelAnimationFrame,
  }
  const observers: (() => void)[] = []
  const frames = new Map<number, () => void>()
  let nextFrame = 1

  targets.document = doc
  targets.MutationObserver = class {
    constructor(callback: () => void) { observers.push(callback) }
    observe(): void { /* the test calls mutate() explicitly */ }
    disconnect(): void { /* nothing scheduled in the double */ }
  }
  targets.requestAnimationFrame = (callback: () => void): number => {
    const id = nextFrame
    nextFrame += 1
    frames.set(id, callback)
    return id
  }
  targets.cancelAnimationFrame = (id: number): void => { frames.delete(id) }

  return {
    document: doc,
    mutate: () => { for (const callback of [...observers]) callback() },
    flush: () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback()
    },
    restore: () => {
      for (const key of Object.keys(saved)) targets[key] = saved[key as keyof typeof saved]
    },
  }
}

const fake = (value: unknown): FakeElement => value as FakeElement

/** A document with a composer card in it, the bar's landmark. */
function cardIn(document: FakeDocument): FakeElement {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', 'true')
  document.append(card)
  return card
}

test('office bar placement: fresh, stale, anchored and absent', () => {
  assert.equal(officeBarPlacement({ cardPresent: true, barPresent: false, barAnchored: false }), 'insert')
  // Re-anchoring the same element is what preserves the other plugins' hosts.
  assert.equal(officeBarPlacement({ cardPresent: true, barPresent: true, barAnchored: false }), 'insert')
  // The termination rule: a pass that has nothing to fix must not write.
  assert.equal(officeBarPlacement({ cardPresent: true, barPresent: true, barAnchored: true }), 'keep')
  assert.equal(officeBarPlacement({ cardPresent: false, barPresent: true, barAnchored: false }), 'detach')
  assert.equal(officeBarPlacement({ cardPresent: false, barPresent: false, barAnchored: false }), 'none')
})

test('office bar order: formats are deduplicated and put in canonical order', () => {
  assert.deepEqual(orderOfficeFormats([]), [])
  assert.deepEqual(orderOfficeFormats(['word', 'word']), ['word'])
  assert.deepEqual(orderOfficeFormats(['pdf', 'word', 'ppt']), ['ppt', 'word', 'pdf'])
  assert.deepEqual(orderOfficeFormats(['pdf', 'sheet', 'ppt', 'sheet']), ['ppt', 'pdf', 'sheet'])
})

test('office bar: the first contributor creates one bar after the composer card', (t) => {
  const dom = installFakeDom()
  t.after(dom.restore)
  const card = cardIn(dom.document)
  assert.equal(COMPOSER_CARD_SELECTOR, 'div[data-composer-card]')

  const first = acquireOfficeBar()
  assert.ok(first !== undefined)
  assert.equal(first.className, OFFICE_BAR_CLASS)
  assert.equal(card.nextElementSibling, fake(first))

  assert.equal(acquireOfficeBar(), first)
  assert.equal(dom.document.nodes.filter(node => node.className === OFFICE_BAR_CLASS).length, 1)
})

test('office bar: the bar is absent until a composer card exists', (t) => {
  const dom = installFakeDom()
  t.after(dom.restore)
  assert.equal(acquireOfficeBar(), undefined)
  assert.equal(findOfficeBar(), undefined)
})

test('office bar: one host per format, kept in canonical order', (t) => {
  const dom = installFakeDom()
  t.after(dom.restore)
  cardIn(dom.document)
  const bar = acquireOfficeBar()
  assert.ok(bar !== undefined)

  const word = ensureOfficeSlot(bar, 'word')
  assert.equal(ensureOfficeSlot(bar, 'word'), word)
  assert.equal(word.className, OFFICE_SLOT_CLASS)
  assert.equal(word.getAttribute(OFFICE_FORMAT_ATTR), 'word')
  assert.equal(fake(bar).children.length, 1)

  ensureOfficeSlot(bar, 'pdf')
  ensureOfficeSlot(bar, 'ppt')
  const formats = (): (string | null)[] => fake(bar).children.map(child => child.getAttribute(OFFICE_FORMAT_ATTR))
  assert.deepEqual(formats(), ['ppt', 'word', 'pdf'])

  // A host out of order is moved, never duplicated.
  fake(word).remove()
  fake(bar).append(fake(word))
  sortOfficeSlots(bar)
  assert.deepEqual(formats(), ['ppt', 'word', 'pdf'])
  assert.equal(fake(bar).children.length, 3)
})

test('office bar: contribution mounts once, survives a missing composer and cleans up', (t) => {
  const dom = installFakeDom()
  t.after(dom.restore)
  const card = cardIn(dom.document)
  let mounts = 0
  let unmounts = 0
  const dispose = contributeOfficeCapsule('word', (slot) => {
    mounts += 1
    assert.equal(slot.getAttribute(OFFICE_FORMAT_ATTR), 'word')
    return () => { unmounts += 1 }
  })

  const bar = findOfficeBar()
  assert.ok(bar !== undefined)
  assert.equal(card.nextElementSibling, fake(bar))
  const host = fake(bar).children[0]
  assert.equal(host.getAttribute(OFFICE_FORMAT_ATTR), 'word')

  // The composer disappears (settings and other views) and comes back: the
  // host is detached in between, but nothing is remounted.
  fake(card).remove()
  dom.mutate()
  dom.flush()
  assert.equal(findOfficeBar(), undefined)
  dom.document.append(fake(card))
  dom.mutate()
  dom.flush()
  assert.equal(card.nextElementSibling, fake(bar))
  assert.equal(host.parent, fake(bar))
  assert.equal(mounts, 1)

  dispose()
  assert.equal(unmounts, 1)
  // An empty bar is not left behind.
  assert.equal(host.parent, undefined)
  assert.equal(findOfficeBar(), undefined)
})

test('office bar: a foreign host of the same format is residue and is dropped', (t) => {
  const dom = installFakeDom()
  t.after(dom.restore)
  cardIn(dom.document)
  const dispose = contributeOfficeCapsule('word', () => () => {})
  const bar = findOfficeBar()
  assert.ok(bar !== undefined)
  const host = fake(bar).children[0]

  // What an instance that failed to clean up would leave behind.
  const residue = dom.document.createElement('div')
  residue.setAttribute(OFFICE_FORMAT_ATTR, 'word')
  fake(bar).append(residue)
  assert.equal(fake(bar).children.length, 2)

  dom.mutate()
  dom.flush()
  assert.deepEqual(fake(bar).children, [host])
  dispose()
})

test('office bar: the landmarks stay the ones the stylesheet styles', () => {
  const styles = readFileSync(join(pluginRoot, 'src', 'client', 'styles.ts'), 'utf8')
  assert.equal(OFFICE_BAR_CLASS, 'dshOfficeBar')
  assert.equal(OFFICE_SLOT_CLASS, 'dshOfficeFormat')
  assert.equal(OFFICE_FORMAT_ATTR, 'data-office-format')
  assert.match(styles, /\.dshOfficeBar\s*\{/u)
  assert.match(styles, /\.dshOfficeFormat\s*\{/u)
  assert.match(
    readFileSync(join(pluginRoot, 'src', 'client', 'office-bar.ts'), 'utf8'),
    /COMPOSER_CARD_SELECTOR = 'div\[data-composer-card\]'/u,
  )
})
