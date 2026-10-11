/**
 * The DOM bridge that puts our row inside the official model menu.
 *
 * ## Why a bridge at all
 *
 * The kernel's model menu (`@deepseek-ai/dsh-client-ui-model-selection`) renders
 * its two drill rows — 模型 / 推理等级 — as plain buttons and contributes NO slot
 * inside itself; the only seat it exposes is `conversation.input.model`, which it
 * occupies. There is therefore no supported way to put a control on that row, and
 * this module is the honest version of the alternative: a bridge that finds the
 * row, appends ONE container beside it, and does nothing at all when it cannot
 * find what it expects.
 *
 * ## What it refuses to do
 *
 *   - **It never writes to the official DOM.** No inline styles on the row, no
 *     class changes, no height/padding edits. The row it found is left exactly as
 *     React rendered it, so there is no "restore" path that can fail and leave a
 *     scar behind. Only the container this module created is ever added or
 *     removed.
 *   - **It never guesses which row is the effort row.** Rows are matched against
 *     the official dictionary's own strings, read through the locale service, so
 *     a language switch cannot desynchronise the two. When neither the label nor
 *     the two-row structure matches, the bridge injects nothing — a missing
 *     slider is a cosmetic loss, a slider on the wrong row is a wrong control.
 *   - **It does not nest inside the row's button.** The row is
 *     `button[role="menuitem"]`; a button's descendants are presentational to
 *     assistive tech, so a slider inside it would be focusable but announced as
 *     nothing. A sibling container keeps the slider a real `role="slider"`, and
 *     the row's own inline padding is copied onto the container so the track still
 *     lines up with the label's left edge.
 *
 * ## The re-measure
 *
 * The official menu places itself from the trigger's rect, clamped to the
 * viewport, and re-runs that placement on window `scroll` (capture) and `resize`
 * — it does NOT observe its own height. Growing the card therefore leaves the
 * card positioned for its OLD height, which is what "the slider pushes the menu
 * over the composer" looks like. The only trigger it honours is a window resize
 * event, so that is what {@link remeasure} dispatches, coalesced to one per tick
 * and re-armed by a `ResizeObserver` on the container (which also covers a late
 * font load or an error line appearing).
 *
 * @module @dsh-app/plugin-effort/client/bridge
 */

import { ROW_PADDING_INLINE } from './geometry.ts'

/** One row of the menu's root pane, as far as identification is concerned. */
export interface MenuRow {
  /** The row's leading label text. */
  readonly label: string
  /** Whether the row carries a value cell beside its label. */
  readonly hasValue: boolean
}

/** The official copy the rows are matched against, in the active locale. */
export interface EffortRowLabels {
  /** The 模型 row's label. */
  readonly model: string
  /** The 推理等级 row's label. */
  readonly effort: string
}

/** The injected container and the row it was placed beside. */
export interface EffortBridgeHost {
  /** Our container: the React portal target. */
  readonly container: HTMLElement
  /** The official effort row, for focus hand-back. */
  readonly row: HTMLElement
}

/**
 * The window face this bridge uses.
 *
 * Structural rather than `Window`: the four timers, the event dispatch, the
 * computed-style read and the two constructors are the whole contract, and a test
 * can satisfy it without a browser. `Window` satisfies it as written, so the call
 * site still passes `window` straight through.
 */
export interface EffortBridgeWindow {
  /** Coalescing timer for the re-measure. */
  setTimeout(handler: () => void, ms: number): number
  /** Cancels a coalescing timer. */
  clearTimeout(handle: number): void
  /** Fallback sweep when no MutationObserver is available. */
  setInterval(handler: () => void, ms: number): number
  /** Stops the fallback sweep. */
  clearInterval(handle: number): void
  /** The re-measure itself: the official menu places itself on window resize. */
  dispatchEvent(event: Event): boolean
  /** Reads the official row's own padding. */
  getComputedStyle(element: Element): { readonly paddingInlineStart: string }
  /** Observer constructor; absent in a minimal host. */
  MutationObserver?: typeof MutationObserver
  /** Event constructor; absent in a minimal host. */
  Event?: typeof Event
  /** Observer constructor for the container's own height. */
  ResizeObserver?: typeof ResizeObserver
}

/** Inputs of {@link createEffortBridge}. */
export interface EffortBridgeOptions {
  /** Host document, or null outside a DOM. */
  readonly doc: Document | null
  /** Host window, or null outside a DOM. */
  readonly win: EffortBridgeWindow | null
  /** This session's own composer anchor, rendered by the slot entry. */
  readonly anchor: () => Element | null
  /** The official row labels, resolved at call time (locale may change). */
  readonly labels: () => EffortRowLabels
  /** Whether there is anything to drive right now. */
  readonly active: () => boolean
  /** Called with the container when it is placed, and with null when it is removed. */
  readonly onHost: (host: EffortBridgeHost | null) => void
}

/** The bridge handle. */
export interface EffortBridge {
  /** Begin watching for the menu. */
  start(): void
  /** Re-examine the DOM now. */
  scan(): void
  /** Remove the container and every observer. */
  dispose(): void
}

/** How long a burst of re-measure requests is collapsed into one dispatch. */
const REMEASURE_COALESCE_MS = 16

/**
 * Pick the index of the effort row out of the menu's root-pane rows.
 *
 * Two rules, in this order, and no third:
 *
 *   1. The row whose label IS the official effort label. This is the only rule
 *      that survives a menu which has grown a third row.
 *   2. Failing that, the two-row root pane whose first row is the official model
 *      row — the effort row is then the second by construction of the official
 *      component, not by our guess.
 *
 * Anything else returns -1 and the caller injects nothing. A previous
 * implementation of this idea fell back to "the second row" unconditionally,
 * which is how a slider ends up on the model row.
 *
 * @param rows - the root pane's rows, in DOM order.
 * @param labels - the official labels, in the active locale.
 * @returns the row index, or -1 when nothing matches.
 */
export function pickEffortRowIndex(rows: readonly MenuRow[], labels: EffortRowLabels): number {
  const effort = normalise(labels.effort)
  const model = normalise(labels.model)
  if (effort === '') return -1
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row === undefined || normalise(row.label) !== effort) continue
    // A row that carries the effort label but not the value cell is not the row
    // this bridge understands. Refusing here — rather than falling through to the
    // structural rule below — is what keeps a shape we do not recognise from
    // becoming a placement we cannot justify.
    return row.hasValue ? index : -1
  }
  if (rows.length !== 2) return -1
  const first = rows[0]
  const second = rows[1]
  if (first === undefined || second === undefined) return -1
  if (normalise(first.label) !== model) return -1
  // Two rows that BOTH read as the model row are not the official root pane.
  // Without this the fallback would happily put a track on the model row, which
  // is the exact failure the fallback exists to avoid.
  if (normalise(second.label) === model) return -1
  return 1
}

/**
 * Normalise a label for comparison: trimmed, internal whitespace collapsed, lower-cased.
 * @param text - the label text.
 * @returns the comparable form.
 */
function normalise(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * Create the bridge.
 * @param options - document, window, the anchor and the callbacks.
 * @returns the bridge, or null when there is no DOM to work with.
 */
export function createEffortBridge(options: EffortBridgeOptions): EffortBridge | null {
  const { doc, win, anchor, labels, active, onHost } = options
  if (doc === null || win === null || typeof doc.createElement !== 'function') return null
  // Non-null aliases: the guard above is what makes every closure below safe, and
  // TypeScript does not carry a narrowing into a nested function.
  const hostDoc: Document = doc
  const hostWin: EffortBridgeWindow = win

  let container: HTMLElement | null = null
  let row: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let resizer: ResizeObserver | null = null
  let timer: number | null = null
  let coalesce: number | null = null
  let disposed = false

  /** This session's composer card: the scope every lookup below stays inside. */
  function composerOf(): Element | null {
    const node = anchor()
    if (node === null) return null
    let element: Element | null = node
    while (element !== null) {
      if (typeof element.getAttribute === 'function' && element.getAttribute('data-composer-card') !== null) return element
      element = element.parentElement
    }
    return null
  }

  /**
   * The open model menu of this composer.
   *
   * The trigger publishes `aria-controls` ONLY while its menu is open, so the
   * pair (trigger, menu) is found together or not at all. The menu is portaled to
   * `document.body`, hence the id lookup rather than a descendant query.
   */
  function menuOf(card: Element): HTMLElement | null {
    const trigger = card.querySelector('button[aria-haspopup="menu"][aria-controls]')
    const id = trigger?.getAttribute('aria-controls') ?? ''
    if (id === '') return null
    const menu = hostDoc.getElementById(id)
    // The root pane is `role="menu"`; a drilled pane is `role="group"` and has no
    // rows of the shape below, so refusing it here is a second guard rather than
    // a duplicate of the label match.
    if (menu === null || menu.getAttribute('role') !== 'menu') return null
    return menu
  }

  /** The root pane's drill rows, in DOM order. */
  function rowsOf(menu: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = []
    for (const child of Array.from(menu.children)) {
      if (child.tagName !== 'BUTTON') continue
      if (child.getAttribute('role') !== 'menuitem') continue
      out.push(child as HTMLElement)
    }
    return out
  }

  /** Describe one row for {@link pickEffortRowIndex}. */
  function describe(button: HTMLElement): MenuRow {
    const first = button.children.item(0)
    return {
      label: first?.textContent ?? '',
      hasValue: button.children.length >= 2,
    }
  }

  /** Remove the container and tell React to unmount out of it. */
  function detach(): void {
    resizer?.disconnect()
    resizer = null
    if (container !== null) {
      onHost(null)
      container.remove()
    }
    container = null
    row = null
  }

  /**
   * Ask the official menu to place itself again.
   *
   * A synthetic window resize is the only signal its placement effect listens
   * for; see the module header. Coalesced so a burst of container resizes
   * dispatches one event per tick rather than one per notification.
   */
  function remeasure(): void {
    if (disposed || coalesce !== null) return
    coalesce = hostWin.setTimeout(() => {
      coalesce = null
      if (disposed) return
      const Ctor = hostWin.Event
      if (Ctor === undefined) return
      try {
        hostWin.dispatchEvent(new Ctor('resize'))
      } catch {
        // A host that refuses the event simply keeps the placement it had; the
        // slider itself is unaffected.
      }
    }, REMEASURE_COALESCE_MS)
  }

  /** Place the container beside the effort row and start watching its height. */
  function inject(target: HTMLElement): void {
    const node = hostDoc.createElement('div')
    // One identity for this node: the class carries the stylesheet hook.
    node.className = 'dshAppEffort'
    // A child of `role="menu"` that is not a menu item: presentation keeps the
    // slider inside it addressable on its own terms.
    node.setAttribute('role', 'none')
    // The official cell's own inline padding, so the track's left edge lands on
    // the label's left edge. Read from the live element rather than hardcoded, so
    // a kernel that changes the cell's padding moves both together.
    const padding = hostWin.getComputedStyle(target).paddingInlineStart
    node.style.paddingInline = padding !== '' ? padding : `${ROW_PADDING_INLINE}px`
    target.parentNode?.insertBefore(node, target.nextSibling)
    container = node
    row = target
    const Resize = hostWin.ResizeObserver ?? (typeof ResizeObserver === 'function' ? ResizeObserver : null)
    if (Resize !== null) {
      resizer = new Resize(() => { remeasure() })
      resizer.observe(node)
    }
    onHost({ container: node, row: target })
    remeasure()
  }

  function scan(): void {
    if (disposed) return
    try {
      if (!active()) {
        detach()
        return
      }
      const card = composerOf()
      const menu = card === null ? null : menuOf(card)
      if (menu === null) {
        detach()
        return
      }
      const rows = rowsOf(menu)
      const index = pickEffortRowIndex(rows.map(describe), labels())
      const target = index < 0 ? undefined : rows[index]
      if (target === undefined) {
        detach()
        return
      }
      // Still where we put it: nothing to do. The identity checks matter because
      // the official component REPLACES its children when the user drills into a
      // pane — our container survives that (React does not own it) while the row
      // it was placed beside does not, so a container whose row is gone must be
      // taken out rather than left floating in the other pane.
      if (container !== null && row === target && container.parentNode === menu) return
      detach()
      inject(target)
    } catch {
      // Any DOM shape this module does not understand resolves to "no slider".
      detach()
    }
  }

  return {
    start(): void {
      if (disposed) return
      scan()
      const Mutation = hostWin.MutationObserver ?? (typeof MutationObserver === 'function' ? MutationObserver : null)
      if (Mutation !== null) {
        try {
          const created = new Mutation(() => { scan() })
          created.observe(hostDoc.body ?? hostDoc.documentElement, { childList: true, subtree: true })
          observer = created
          return
        } catch {
          observer = null
        }
      }
      // No MutationObserver: a low-frequency sweep. Each pass is a handful of
      // queries, and the container is only touched when it is missing.
      timer = hostWin.setInterval(() => { scan() }, 400)
    },
    scan,
    dispose(): void {
      disposed = true
      observer?.disconnect()
      observer = null
      if (timer !== null) {
        hostWin.clearInterval(timer)
        timer = null
      }
      if (coalesce !== null) {
        hostWin.clearTimeout(coalesce)
        coalesce = null
      }
      detach()
    },
  }
}
