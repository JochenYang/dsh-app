/**
 * A DOM small enough to drive the bridge offline.
 *
 * The bridge's own module header calls its DOM contract "the honest version of
 * the alternative", and what it writes to the official row is exactly the part
 * that no pure test can reach: the capsule's properties, the value cell's colour,
 * and the restore that has to put both back. This stub is the smallest shape that
 * lets `createEffortBridge` run for real — no browser, no React — so those writes
 * and that restore are exercised rather than described.
 *
 * What it models deliberately:
 *
 *   - **The element surface the bridge touches**, and nothing else. A method the
 *     bridge does not call is not here, so a new dependency on one shows up as a
 *     failing test rather than as a silent no-op.
 *   - **Inline style as a plain object**: a property nobody set READS as
 *     `undefined`, which is NOT what a browser does — a `CSSStyleDeclaration`
 *     reports `''` there. The bridge normalises every snapshot read with `?? ''`,
 *     and this stub is the reason that guard is worth having: a restore without it
 *     would write the string "undefined" onto the row.
 *   - **Bubbling with `stopPropagation`**: a listener on an ancestor sees an event
 *     its descendant stopped, and one on the SAME node does not — which is the
 *     distinction that made a same-node click guard the wrong tool.
 *   - **Timers that do not run by themselves**: `flush()` runs what the bridge
 *     queued, so a test asserts the re-measure happened without racing a real
 *     clock, and `node --test` never waits on a pending interval. `tickIntervals()`
 *     is the same for the fallback sweep, which arms an interval instead.
 *   - **A `MutationObserver` that RECORDS the options it was given**, because those
 *     options are the contract that makes a theme flip a repaint. A window without a
 *     constructor puts `start()` on the fallback sweep — so with the stub lacking
 *     one, the branch the app actually runs was the branch no test entered, and a
 *     misspelled `attributeFilter` (or a deleted `attributes: true`) kept the whole
 *     suite green. The window withholds it only when a test says
 *     `{ mutationObserver: false }`.
 *
 * One difference from a browser, so an assertion is not read as more than it is:
 * a stored style value comes back VERBATIM here, while a real
 * `CSSStyleDeclaration` normalises a colour to `rgb(...)`. An assertion on the
 * stored string is therefore about the contract — the value the bridge asked for
 * — and not about how a browser would serialise it.
 *
 * @module plugin-effort/tests/dom-stub
 */

/** An event with just the one thing the bridge's guard uses. */
export class StubEvent {
  readonly type: string
  target: StubElement | null = null
  private stopped = false

  /**
   * @param type - the event type.
   */
  constructor(type: string) {
    this.type = type
  }

  /** Stop the walk up the tree at the element that handles this. */
  stopPropagation(): void {
    this.stopped = true
  }

  /** Whether propagation was stopped. */
  get propagationStopped(): boolean {
    return this.stopped
  }
}

/** A child list with the DOM's own `item()` on it. */
export class StubChildList extends Array<StubElement> {
  /**
   * @param index - the child's position.
   * @returns the child, or null.
   */
  item(index: number): StubElement | null {
    return this[index] ?? null
  }
}

/** One element. */
export class StubElement {
  readonly tagName: string
  className = ''
  readonly attributes = new Map<string, string>()
  readonly children = new StubChildList()
  readonly style: Record<string, string> = {}
  readonly listeners = new Map<string, ((event: StubEvent) => void)[]>()
  parentNode: StubElement | null = null
  private own = ''

  /**
   * @param tagName - the tag name.
   */
  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  /** The parent, as an element; the bridge walks up through this. */
  get parentElement(): StubElement | null {
    return this.parentNode
  }

  /** Own text plus every descendant's, the way the DOM reports it. */
  get textContent(): string {
    return this.own + this.children.map(child => child.textContent).join('')
  }

  set textContent(value: string) {
    this.own = value
    this.children.length = 0
  }

  /**
   * @param child - the child to add.
   * @returns the child.
   */
  appendChild(child: StubElement): StubElement {
    child.parentNode?.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  /**
   * @param child - the child to remove.
   * @returns the child.
   */
  removeChild(child: StubElement): StubElement {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  /**
   * Swap one child for another IN PLACE, which is what React's reconciliation
   * does when it replaces a node rather than updating it — the shape a fixture
   * needs to model an official component that re-created its value cell.
   *
   * @param next - the child to insert.
   * @param current - the child it replaces.
   * @returns the replaced child.
   */
  replaceChild(next: StubElement, current: StubElement): StubElement {
    const index = this.children.indexOf(current)
    if (index < 0) throw new Error('replaceChild: the node to replace is not a child')
    next.parentNode?.removeChild(next)
    this.children[index] = next
    next.parentNode = this
    current.parentNode = null
    return current
  }

  /** Detach this element from its parent. */
  remove(): void {
    this.parentNode?.removeChild(this)
  }

  /**
   * @param name - the attribute.
   * @param value - its value.
   */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  /**
   * @param name - the attribute.
   * @returns its value, or null.
   */
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  /**
   * @param name - the attribute.
   * @returns whether it is set.
   */
  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  /**
   * @param name - the attribute to remove.
   */
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  /**
   * @param type - the event type.
   * @param handler - the listener.
   */
  addEventListener(type: string, handler: (event: StubEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  /**
   * Dispatch to this element and up its ancestors, honouring `stopPropagation`.
   * @param event - the event.
   * @returns true, as the DOM does.
   */
  dispatchEvent(event: StubEvent): boolean {
    event.target = this
    let node: StubElement | null = this
    while (node !== null) {
      for (const handler of node.listeners.get(event.type) ?? []) handler.call(node, event)
      if (event.propagationStopped) break
      node = node.parentNode
    }
    return true
  }

  /**
   * The first descendant matching a `tag[attr="value"]` selector.
   * @param selector - the selector.
   * @returns the element, or null.
   */
  querySelector(selector: string): StubElement | null {
    for (const child of this.children) {
      if (matchesSelector(child, selector)) return child
      const found = child.querySelector(selector)
      if (found !== null) return found
    }
    return null
  }

  /**
   * Every descendant matching a selector, in document order — the plural of
   * {@link querySelector}, which is what the candidate search over a card's menu
   * buttons needs (one `querySelector` cannot see past a shape it cannot use).
   *
   * Descendants only, never this node, exactly as the DOM defines the method.
   *
   * @param selector - the selector.
   * @returns the matches.
   */
  querySelectorAll(selector: string): StubElement[] {
    const out: StubElement[] = []
    for (const child of this.children) {
      if (matchesSelector(child, selector)) out.push(child)
      out.push(...child.querySelectorAll(selector))
    }
    return out
  }

  /** The bridge only asks for focus; there is no focus model here. */
  focus(): void {}
}

/** Every `ResizeObserver` the bridge constructed, newest last. */
export const resizeObservers: StubResizeObserver[] = []

/** A resize observer that notifies only when a test asks it to. */
export class StubResizeObserver {
  private readonly handler: () => void

  /**
   * @param handler - what the bridge wants called on a size change.
   */
  constructor(handler: () => void) {
    this.handler = handler
    resizeObservers.push(this)
  }

  /** Begin observing. */
  observe(): void {}

  /** Stop observing. */
  disconnect(): void {}

  /** Report a size change, as the browser would. */
  notify(): void {
    this.handler()
  }
}

/** Every `MutationObserver` the bridge constructed, newest last. */
export const mutationObservers: StubMutationObserver[] = []

/** A mutation record, as far as a test needs one to hand to `fire`. */
export interface StubMutationRecord {
  /** What kind of change it is. */
  readonly type?: string
  /** The attribute's name, for an attribute record. */
  readonly attributeName?: string | null
}

/** The `observe` options, as the bridge asked for them. */
export interface StubObserveOptions {
  readonly childList?: boolean
  readonly subtree?: boolean
  readonly attributes?: boolean
  readonly attributeFilter?: readonly string[]
}

/**
 * A mutation observer that notifies only when a test asks it to, and RECORDS the
 * target and the options exactly as they were given.
 *
 * The recording is the point. The bridge's observer is what makes a theme flip a
 * repaint, and the one thing that decides whether it fires is the options object:
 * with a stub that dropped it, a misspelled `attributeFilter` name — or the whole
 * `attributes: true` clause deleted — left every test in this suite green while the
 * composer's level text silently kept the other theme's ramp. A test asserts the
 * options; this stub is what makes that assertion possible.
 *
 * It deliberately does NOT filter the records a test hands {@link fire}: the
 * bridge's callback ignores their contents, and a stub that filtered would be
 * asserting the options it was given rather than the options the bridge asked for.
 */
export class StubMutationObserver {
  private readonly handler: (records: readonly StubMutationRecord[]) => void
  /** The node `observe` was called with. */
  target: StubElement | null = null
  /** The options `observe` was called with, verbatim. */
  options: StubObserveOptions | null = null
  /** Whether `disconnect` has been called. */
  disconnected = false

  /**
   * @param handler - what the bridge wants called on a mutation.
   */
  constructor(handler: (records: readonly StubMutationRecord[]) => void) {
    this.handler = handler
    mutationObservers.push(this)
  }

  /**
   * @param target - the node to observe.
   * @param options - the options, recorded as given.
   */
  observe(target: StubElement, options: StubObserveOptions): void {
    this.target = target
    this.options = options
  }

  /** Stop observing. */
  disconnect(): void {
    this.disconnected = true
  }

  /**
   * Report mutations, as the browser would.
   * @param records - what is reported; the bridge ignores their contents.
   */
  fire(records: readonly StubMutationRecord[] = []): void {
    this.handler(records)
  }
}

/** The document face the bridge uses. */
export class StubDocument {
  readonly body: StubElement
  readonly documentElement: StubElement
  private readonly byId = new Map<string, StubElement>()

  /**
   * @param body - the document body.
   */
  constructor(body: StubElement) {
    this.body = body
    this.documentElement = body
  }

  /**
   * @param tagName - the tag name.
   * @returns a new element.
   */
  createElement(tagName: string): StubElement {
    return new StubElement(tagName)
  }

  /**
   * @param id - the element id.
   * @returns the registered element, or null.
   */
  getElementById(id: string): StubElement | null {
    return this.byId.get(id) ?? null
  }

  /**
   * Register an element under an id, which is how the portaled menu is reachable.
   * @param id - the element id.
   * @param element - the element.
   */
  register(id: string, element: StubElement): void {
    this.byId.set(id, element)
  }
}

/**
 * The window face the bridge uses, with timers that only run when a test says so.
 *
 * `MutationObserver` is present by default, because it is present in every renderer
 * this plugin ships in: a stub without one put `start()` on the fallback sweep, so
 * the branch the app actually takes — the observer, and with it the theme filter —
 * was the branch no test ever entered. `{ mutationObserver: false }` is how the
 * sweep is reached on purpose.
 */
export class StubWindow {
  /** Every event dispatched through this window, in order. */
  readonly dispatched: string[] = []
  /** Event constructor, as the host window carries one. */
  readonly Event = StubEvent
  /** Observer constructor for the container's own height. */
  readonly ResizeObserver = StubResizeObserver
  /** Mutation observer constructor; see the class note for why it is here by default. */
  readonly MutationObserver?: typeof StubMutationObserver
  private readonly timeouts = new Map<number, () => void>()
  private readonly intervals = new Map<number, () => void>()
  private nextHandle = 1

  /**
   * @param options - `mutationObserver: false` withholds the constructor, which is
   * the only way `start()` reaches the fallback sweep.
   */
  constructor(options: { readonly mutationObserver?: boolean } = {}) {
    if (options.mutationObserver !== false) this.MutationObserver = StubMutationObserver
  }

  /**
   * @param handler - the callback.
   * @returns a handle.
   */
  setTimeout(handler: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.timeouts.set(handle, handler)
    return handle
  }

  /**
   * @param handle - the handle to cancel.
   */
  clearTimeout(handle: number): void {
    this.timeouts.delete(handle)
  }

  /**
   * @param handler - the callback.
   * @returns a handle. Nothing fires by itself; `tickIntervals()` does.
   */
  setInterval(handler: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.intervals.set(handle, handler)
    return handle
  }

  /**
   * @param handle - the handle to cancel.
   */
  clearInterval(handle: number): void {
    this.intervals.delete(handle)
  }

  /**
   * @param event - the event.
   * @returns true, as the DOM does.
   */
  dispatchEvent(event: StubEvent): boolean {
    this.dispatched.push(event.type)
    return true
  }

  /** Run everything queued so far, in the order it was queued. */
  flush(): void {
    const queued = [...this.timeouts.values()]
    this.timeouts.clear()
    for (const handler of queued) handler()
  }

  /** Run one period of every armed interval, as the host would. */
  tickIntervals(): void {
    for (const handler of [...this.intervals.values()]) handler()
  }

  /** How many callbacks are still queued. */
  get pending(): number {
    return this.timeouts.size
  }

  /** How many intervals are armed. */
  get armed(): number {
    return this.intervals.size
  }
}

/** Drop the observers a previous test constructed. */
export function resetStubs(): void {
  resizeObservers.length = 0
  mutationObservers.length = 0
}

/**
 * Match a `tag`, `[attr]`, `[attr="value"]` or `tag[attr="value"][attr2]` selector.
 * @param node - the element to test.
 * @param selector - the selector.
 * @returns whether it matches.
 */
function matchesSelector(node: StubElement, selector: string): boolean {
  const parsed = /^([a-zA-Z0-9-]*)((?:\s*\[[a-zA-Z0-9-]+(?:="[^"]*")?\])*)$/u.exec(selector.trim())
  if (parsed === null) return false
  const tag = parsed[1] ?? ''
  if (tag !== '' && node.tagName !== tag.toUpperCase()) return false
  for (const attr of (parsed[2] ?? '').match(/\[[a-zA-Z0-9-]+(?:="[^"]*")?\]/gu) ?? []) {
    const name = /\[([a-zA-Z0-9-]+)/u.exec(attr)?.[1] ?? ''
    const value = /="([^"]*)"/u.exec(attr)?.[1]
    if (!node.hasAttribute(name)) return false
    if (value !== undefined && node.getAttribute(name) !== value) return false
  }
  return true
}
