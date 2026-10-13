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
 * row, turns it into the capsule its track lives in, and does nothing at all when
 * it cannot find what it expects.
 *
 * ## What it does to the official DOM
 *
 * It writes, and it puts everything back. The row becomes a CAPSULE: it may wrap
 * (`flex-wrap`), its height is released (`height: auto`), it gains `padding-block`
 * for the second line, and it carries a 1px ring plus one step of elevation as a
 * box-shadow — see {@link capsuleShadow}. The value cell beside the label is
 * tinted with the current level's own text colour, and the ring is that same
 * colour at an alpha, so the capsule's edge carries the level too.
 *
 * Every one of those writes is snapshotted BEFORE it is made (see
 * `snapshotRowStyle`) and restored verbatim by {@link detach}, so the row the
 * official component rendered is recoverable at any point — including when the
 * component has already replaced that row, where the restore writes a detached
 * element and nothing else. The snapshot is read once and never re-read, and
 * `row`/`rowStyle` are set before the first write rather than after it: every one
 * of these writes is repeated by {@link paint}, so a snapshot taken later would
 * capture our own values, and a throw in the middle of the first injection must
 * leave {@link detach} able to put the row back. There is no `try`/`catch` around
 * the restore: writing the `style` of a detached element is harmless by
 * definition, and swallowing an exception there would hide a shape this module got
 * wrong.
 *
 * ## The accessibility regression, stated rather than hidden
 *
 * The container is a child of the row's `button[role="menuitem"]`, because that
 * is what the capsule IS: the track is the row's second line, not a sibling block
 * below it. The cost is real. `button` is `Children Presentational: True` in
 * WAI-ARIA 1.1 and 1.2 alike, and 1.2 §5.2.9 says a user agent SHOULD NOT expose
 * a button's descendants (the specification itself notes that information may
 * then be announced twice if it does). So the slider is now a nested interactive
 * control inside a menu item, and which of two things happens depends on the
 * UA/AT in use: it may be suppressed as part of the button — in which case the
 * level is still reachable through the official menu's own drill-in — or it may
 * still be exposed as a nested slider, possibly read twice. Chromium-class
 * implementations are reported to expose focusable descendants of a presentational
 * subtree, which would make the second the more likely one, but this repository has
 * done NO AT measurement and does not claim to know.
 *
 * ## Why the container does not handle pointer events
 *
 * The container is the React portal's own root, so React's delegated listeners
 * are attached to that same node — and a `click` listener of ours on it would be
 * a coin flip against React's, since `stopPropagation` only takes effect when the
 * event moves on to the NEXT node. Rather than fight for the event, the container
 * is taken out of hit-testing entirely: `pointer-events: none` on
 * `.dshAppEffort`, and `pointer-events: auto` back on the track, which handles its
 * own pointer and keyboard input and nothing else.
 *
 * What that means in practice: a pointer landing on the container's own box — the
 * corners the capsule's radius cuts off, the strip the note's margin occupies —
 * passes through to the official row underneath, which is the row's own
 * behaviour and not this module's to swallow. Only the track's own area belongs
 * to the track.
 *
 * ## What it still refuses to do
 *
 *   - **It never guesses which row is the effort row.** Rows are matched against
 *     the official dictionary's own strings, read through the locale service, so
 *     a language switch cannot desynchronise the two. When neither the label nor
 *     the two-row structure matches, the bridge injects nothing — a missing
 *     slider is a cosmetic loss, a slider on the wrong row is a wrong control.
 *   - **It never guesses the value cell.** The cell is the row's second child —
 *     the same rule that decides the row has one (see {@link valueChildOf}) —
 *     never a class name, which the official build hashes.
 *
 * ## The residual: a style-only change is not observed
 *
 * The observer is `{ childList: true, subtree: true }` and stays that way. If the
 * official component disturbs the cell, it does so in one of two ways: it
 * re-renders it as a fresh node (a childList change, which is seen) or it rewrites
 * the inline style on the node it kept (an attribute change, which is not). The
 * second case is the residual: the geometry, the ring and the name's colour are
 * all re-asserted on every {@link paint} and every scan, so a style something else
 * cleared comes back on the next DOM insertion rather than at once.
 *
 * ## The other residual: the restore writes back what it captured
 *
 * {@link detach} puts back the values read at inject time. A third party that
 * rewrites the row's or the value cell's inline style WHILE the capsule is
 * injected therefore has its write overwritten on the way out. Nothing in the
 * current kernel does that — the official `.cell` and `.cellValue` carry no
 * `style` prop at all, so React never touches either attribute — which is why
 * this is a note and not a merge: a merge would need to know which of the five
 * properties someone else meant to keep.
 *
 * ## The re-measure
 *
 * The official menu places itself from the trigger's rect, clamped to the
 * viewport, and re-runs that placement on window `scroll` (capture) and `resize`
 * — it does NOT observe its own height. Growing the card therefore leaves the
 * card positioned for its OLD height, which is what "the slider pushes the menu
 * over the composer" looks like. The only trigger it honours is a window resize
 * event, so that is what {@link remeasure} dispatches.
 *
 * Two schedules, because the two callers want different things. The injection's
 * own dispatch is SYNCHRONOUS ({@link remeasureNow}): the capsule is written
 * inside a MutationObserver callback, so a coalesced dispatch would let the first
 * frame paint the menu at its old height and jump a frame later. The container's
 * `ResizeObserver` keeps the coalesced path — it fires in bursts (a late font
 * load, the error line appearing) and one dispatch per tick is enough there.
 *
 * @module @dsh-app/plugin-effort/client/bridge
 */

import { NEUTRAL_RING } from './value-color.ts'

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

/** The injected container and the row it lives in. */
export interface EffortBridgeHost {
  /** Our container: the React portal target. */
  readonly container: HTMLElement
  /** The official effort row, for focus hand-back. */
  readonly row: HTMLElement
}

/**
 * The window face this bridge uses.
 *
 * Structural rather than `Window`: the four timers, the event dispatch and the
 * three constructors are the whole contract, and a test can satisfy it without a
 * browser. `Window` satisfies it as written, so the call site still passes
 * `window` straight through.
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
  /** Observer constructor; absent in a minimal host. */
  MutationObserver?: typeof MutationObserver
  /** Event constructor; absent in a minimal host. */
  Event?: typeof Event
  /** Observer constructor for the container's own height. */
  ResizeObserver?: typeof ResizeObserver
}

/** The colours the current level gives the capsule. */
export interface LevelColors {
  /** The value cell's text colour. */
  readonly text: string
  /** The capsule ring's colour — the same level, at the ring's own alpha. */
  readonly ring: string
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
  /**
   * The colours the capsule should carry right now, or null when there is no
   * position to take them from — the cell then keeps the official colour and the
   * ring falls back to a neutral edge.
   *
   * Asked for on every paint rather than passed once, because the level and the
   * theme can both move without this module being told.
   *
   * A throw from here is caught by {@link EffortBridge.scan}'s own guard and read
   * as "a DOM shape this module does not understand", i.e. the slider is taken out
   * and the next scan may put it back. That is accepted rather than defended
   * against: the colour module only throws on a malformed constant, which is a
   * programming error rather than a runtime condition.
   */
  readonly levelColors: () => LevelColors | null
  /** Called with the container when it is placed, and with null when it is removed. */
  readonly onHost: (host: EffortBridgeHost | null) => void
}

/** The bridge handle. */
export interface EffortBridge {
  /** Begin watching for the menu. */
  start(): void
  /** Re-examine the DOM now. */
  scan(): void
  /**
   * Paint the current level onto the row: the capsule's ring and the value cell's
   * colour.
   *
   * Separate from {@link EffortBridge.scan} because the two answer different
   * questions: a scan looks for the row, a paint only says what that row should
   * look like. The level changing is a paint with no scan.
   */
  paint(): void
  /** Remove the container and every observer. */
  dispose(): void
}

/** How long a burst of re-measure requests is collapsed into one dispatch. */
const REMEASURE_COALESCE_MS = 16

/**
 * Padding the capsule gains above and below its two lines, in px.
 *
 * The row's own padding-inline stays the official component's — the container is
 * inside the row now, so the label's left edge and the track's left edge are the
 * same edge by construction, and nothing has to be read off the row to line them
 * up. What the row needs is height: the official `.cell` is `display: flex` with
 * `height: 34px`, `padding: 0 8px` and `gap: 6px` (read from the installed
 * package's own stylesheet), and the label's line plus the 28px track
 * (`TRACK_HEIGHT`) do not fit in 34px. The gap is what separates the two lines
 * once `flex-wrap` puts them on separate rows.
 */
export const ROW_PADDING_BLOCK = '10px'

/**
 * The capsule's own edge: the level's ring colour plus one soft step of
 * elevation.
 *
 * The ring is what reads as a capsule around the row's two lines; the step is
 * what keeps it from looking printed on the card. The ring carries the LEVEL,
 * which is the point of it — a capsule that changed colour with the level says
 * what the session is set to from across the menu, and a neutral hairline said
 * nothing and was, at the border token's 8% black, close to invisible on the
 * card.
 *
 * The colour arrives already at its alpha (see `value-color.ts`, which owns the
 * ramp, the lift and the alpha), so this function only composes the shadow.
 *
 * The row already carries `border-radius: var(--dsw-radius-md)`, so the ring
 * follows the official radius rather than imposing one. The menu's own padding is
 * 4px with `overflow: hidden`, which is where the 1px ring and the 3px blur land.
 *
 * @param ring - the ring's colour, alpha included.
 * @returns the row's box-shadow value.
 */
export function capsuleShadow(ring: string): string {
  return `0 0 0 1px ${ring}, 0 1px 3px rgb(15 17 21 / 6%)`
}

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
 * The row's value cell: the second child of the row's own button.
 *
 * The official row renders exactly three children in this order — the label
 * `span`, the value `span`, then the drill chevron — and this module appends the
 * container as a fourth, so index 1 is the value cell and index 2 is not. It is
 * deliberately not a class match: the official cell carries a hashed class name
 * (`_7KE1Ra_cellValue` on the installed line), and a hashed name is exactly the
 * anchor that breaks silently on the next kernel build.
 *
 * Two shapes are refused rather than tinted, because in both of them index 1 is
 * NOT the value cell: the chevron is an `<svg>` and would be recoloured instead
 * of the name, and the container this module appends is its own node — reachable
 * at index 1 only if the official component dropped children, and tinting it
 * would paint the level's colour across the whole track. Either way the answer is
 * "no cell", and the caller writes nothing.
 *
 * This is the SAME rule {@link MenuRow.hasValue} is decided by, so the row that is
 * accepted and the cell that is tinted can never disagree about the shape: a row
 * whose second child is the chevron does not carry a value cell, and is refused as
 * a row too.
 *
 * @param row - the row's button.
 * @param exclude - a node of ours that must never be taken for a cell.
 * @returns the cell, or null when the row has no second child or it is not one.
 */
export function valueChildOf(row: {
  readonly children: { readonly length: number, item(index: number): Element | null }
}, exclude: Element | null = null): HTMLElement | null {
  if (row.children.length < 2) return null
  const cell = row.children.item(1)
  if (cell === null || cell === exclude) return null
  const tag = typeof cell.tagName === 'string' ? cell.tagName.toLowerCase() : ''
  if (tag === 'svg') return null
  return cell as HTMLElement
}

/**
 * The row's own inline style, for the properties this bridge writes.
 *
 * A snapshot rather than a diff: the restore is `row.style.x = snapshot.x` for
 * each, which is exact for the case that matters (the official component had set
 * the property, and must get its own value back) and correct for the common case
 * (it had not, and the property reads as the empty string, which clears it).
 *
 * `paddingTop`/`paddingBottom` are the longhand form of the `padding-block` the
 * capsule writes — the same declaration, snapshotted in the two halves a
 * `CSSStyleDeclaration` reports so that the write and the restore are symmetric.
 */
interface RowStyleSnapshot {
  readonly height: string
  readonly flexWrap: string
  readonly paddingTop: string
  readonly paddingBottom: string
  readonly boxShadow: string
}

/**
 * Read the row's own inline values for everything this module writes to it.
 *
 * Must run BEFORE the first write — `applyCapsule`'s geometry and `paint`'s ring
 * alike: an inline value that is read after a write is our own, and restoring it
 * would leave the capsule in place forever. The shadow is the one to watch, since
 * `paint` rewrites it on every scan.
 *
 * @param row - the official effort row.
 * @returns the values to put back.
 */
function snapshotRowStyle(row: HTMLElement): RowStyleSnapshot {
  return {
    height: row.style.height ?? '',
    flexWrap: row.style.flexWrap ?? '',
    paddingTop: row.style.paddingTop ?? '',
    paddingBottom: row.style.paddingBottom ?? '',
    boxShadow: row.style.boxShadow ?? '',
  }
}

/**
 * Put the row back exactly as the official component rendered it.
 *
 * Safe on a row the official component has already replaced: a detached element
 * has no box, so the write reaches nothing and nothing has to be caught.
 *
 * @param row - the official effort row.
 * @param snapshot - the values read before the first write.
 */
function restoreRowStyle(row: HTMLElement, snapshot: RowStyleSnapshot): void {
  row.style.height = snapshot.height
  row.style.flexWrap = snapshot.flexWrap
  row.style.paddingTop = snapshot.paddingTop
  row.style.paddingBottom = snapshot.paddingBottom
  row.style.boxShadow = snapshot.boxShadow
}

/**
 * Turn the row into the capsule's GEOMETRY: the track's own line and the room
 * around it.
 *
 * `height: auto` releases the menu item's fixed height, `flex-wrap` lets the
 * container take a line of its own, and the padding is what that second line
 * needs around it. The edge is not here: the ring carries the level's colour, so
 * it belongs to {@link paint} — see {@link capsuleShadow}.
 *
 * Idempotent, and therefore safe to re-run: {@link paint} calls it on every scan,
 * so a geometry something else cleared comes back the same way the ring and the
 * name's colour do.
 *
 * @param row - the official effort row.
 */
function applyCapsule(row: HTMLElement): void {
  row.style.height = 'auto'
  row.style.flexWrap = 'wrap'
  row.style.paddingTop = ROW_PADDING_BLOCK
  row.style.paddingBottom = ROW_PADDING_BLOCK
}

/**
 * Create the bridge.
 * @param options - document, window, the anchor and the callbacks.
 * @returns the bridge, or null when there is no DOM to work with.
 */
export function createEffortBridge(options: EffortBridgeOptions): EffortBridge | null {
  const { doc, win, anchor, labels, active, levelColors, onHost } = options
  if (doc === null || win === null || typeof doc.createElement !== 'function') return null
  // Non-null aliases: the guard above is what makes every closure below safe, and
  // TypeScript does not carry a narrowing into a nested function.
  const hostDoc: Document = doc
  const hostWin: EffortBridgeWindow = win

  let container: HTMLElement | null = null
  let row: HTMLElement | null = null
  /** The row's own inline style before this bridge wrote to it, and the row it belongs to. */
  let rowStyle: RowStyleSnapshot | null = null
  /**
   * The value cell the tint is currently written on, and its own inline colour.
   * The colour is meaningful only while the cell is; `''` is what the DOM reports
   * for an inline colour nobody set, and what clears one on restore.
   */
  let valueCell: HTMLElement | null = null
  let valueCellColor = ''
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
      // The same rule `valueChildOf` places the tint by; see its own note for why
      // the two must not be able to disagree.
      hasValue: valueChildOf(button) !== null,
    }
  }

  /** Remove the container, restore the row, and tell React to unmount out of it. */
  function detach(): void {
    resizer?.disconnect()
    resizer = null
    if (container !== null) {
      onHost(null)
      container.remove()
    }
    container = null
    // Everything this module wrote to the official row goes back. The row may
    // already be detached (the official component replaced it), which is why the
    // restore needs no guard: a detached element has no box and the write is a
    // no-op on the document.
    if (row !== null && rowStyle !== null) restoreRowStyle(row, rowStyle)
    row = null
    rowStyle = null
    restoreValueCell()
  }

  /** Put the value cell's own inline colour back, and forget the cell. */
  function restoreValueCell(): void {
    if (valueCell === null) return
    valueCell.style.color = valueCellColor
    valueCell = null
    valueCellColor = ''
  }

  /**
   * Paint the current level onto the official row: the capsule's geometry, its
   * ring, and the value cell's text colour.
   *
   * Every one of these writes REPEATS rather than happening once at inject. What
   * this module can see is childList changes; a style attribute is not one, so a
   * re-render that keeps a node and rewrites its inline style — or any other
   * writer of it — would be invisible here (see the module header). Re-asserting
   * on every scan costs three style writes per scan and takes the whole question
   * away, geometry included: a capsule whose padding was cleared would otherwise
   * stay a 34px row with its track hanging out of it until the next injection.
   *
   * The ring is written here rather than once at inject because its colour IS the
   * level: a capsule whose edge does not move when the level does would be the
   * thing the user notices. `snapshotRowStyle` captured the row's own values
   * before the first of these writes and is never re-read, so the restore still
   * puts the official ones back.
   *
   * A cell the official component REPLACED is not confused with the one whose
   * colour was captured: the cell is re-resolved from the row on every paint, and
   * the incoming node's own colour is read before it is written to.
   *
   * The container itself is passed as the node to refuse, so a shape in which the
   * official component has dropped children cannot have the level's colour painted
   * across our own track instead of onto a name.
   */
  function paint(): void {
    if (row === null) return
    const colors = levelColors()
    applyCapsule(row)
    // The ring comes before the cell: it does not depend on there being a cell to
    // write to, and a capsule with no edge at all would be the more visible
    // failure of the two.
    row.style.boxShadow = capsuleShadow(colors?.ring ?? NEUTRAL_RING)
    const cell = valueChildOf(row, container)
    if (cell === null) return
    if (cell !== valueCell) {
      restoreValueCell()
      valueCell = cell
      valueCellColor = cell.style.color ?? ''
    }
    cell.style.color = colors?.text ?? valueCellColor
  }

  /**
   * Ask the official menu to place itself again.
   *
   * A synthetic window resize is the only signal its placement effect listens
   * for; see the module header. Coalesced so a burst of container resizes
   * dispatches one event per tick rather than one per notification.
   */
  /** Hand the official menu the one signal its placement effect listens for. */
  function dispatchResize(): void {
    const Ctor = hostWin.Event
    if (Ctor === undefined) return
    try {
      hostWin.dispatchEvent(new Ctor('resize'))
    } catch {
      // A host that refuses the event simply keeps the placement it had; the
      // slider itself is unaffected.
    }
  }

  /**
   * Ask the menu to place itself again on the next tick.
   *
   * The container's own `ResizeObserver` fires in bursts, so these are coalesced
   * to one dispatch per tick.
   */
  function remeasure(): void {
    if (disposed || coalesce !== null) return
    coalesce = hostWin.setTimeout(() => {
      coalesce = null
      if (disposed) return
      dispatchResize()
    }, REMEASURE_COALESCE_MS)
  }

  /**
   * Ask the menu to place itself again RIGHT NOW.
   *
   * The injection writes the capsule inside a MutationObserver callback, and the
   * menu's placement effect reads its own height — so a coalesced dispatch would
   * let the browser paint one frame with the card still positioned for the old,
   * ~40px-shorter row, which then jumps. Dispatching here forces that measurement
   * to happen against the new styles instead. Any coalesced dispatch still queued
   * is dropped: this one already covers it.
   */
  function remeasureNow(): void {
    if (disposed) return
    if (coalesce !== null) {
      hostWin.clearTimeout(coalesce)
      coalesce = null
    }
    dispatchResize()
  }

  /** Turn the row into the capsule and start watching the container's height. */
  function inject(target: HTMLElement): void {
    // Identity and snapshot FIRST, before a single write: everything below writes
    // to the official row, and a throw anywhere in the middle of it has to leave
    // `detach` able to put that row back. Reading the snapshot after the first
    // write would capture our own values and leave the capsule behind for good.
    rowStyle = snapshotRowStyle(target)
    row = target
    const node = hostDoc.createElement('div')
    // One identity for this node: the class carries the stylesheet hook, and the
    // stylesheet is what takes it out of hit-testing (`pointer-events`).
    node.className = 'dshAppEffort'
    // A child of the row's button that is not part of it: presentation, so the
    // track inside keeps its own role.
    node.setAttribute('role', 'none')
    target.appendChild(node)
    container = node
    const Resize = hostWin.ResizeObserver ?? (typeof ResizeObserver === 'function' ? ResizeObserver : null)
    if (Resize !== null) {
      resizer = new Resize(() => { remeasure() })
      resizer.observe(node)
    }
    onHost({ container: node, row: target })
    // The capsule is taller than the row was, so the menu has to place itself
    // again — synchronously, and before the first frame; the level is painted here
    // so that frame already carries it.
    paint()
    remeasureNow()
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
      // Still where we put it: nothing to do but repaint, which the official
      // component may have undone without producing a childList change (see the
      // module header). The identity checks matter because the official component
      // REPLACES its children when the user drills into a pane — our container
      // survives that (React does not own it) while the row it lives in does not,
      // so a container whose row is gone must be taken out rather than left behind
      // in the other pane.
      if (container !== null && row === target && container.parentNode === target) {
        paint()
        return
      }
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
    paint,
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
