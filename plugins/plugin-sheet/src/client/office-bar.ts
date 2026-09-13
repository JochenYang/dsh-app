/**
 * The shared office-suite capsule bar — this plugin's minimal implementation
 * of the cross-plugin DOM contract.
 *
 * The contract (defined by the suite, shared by every format plugin):
 * one container `div.dshOfficeBar` inserted directly after the composer card
 * (`div[data-composer-card]`, the InputBar card in ui-conversation, which is
 * the same DOM in the new-session hero and in an open session), holding one
 * host `div.dshOfficeFormat[data-office-format="<fmt>"]` per format, ordered
 * `ppt, word, excel, pdf` — this plugin owning `excel`.
 *
 * Each plugin bundles standalone (no shared runtime module), so this file is a
 * self-contained copy of the contract rather than an import of another
 * plugin's code: the bar is created by whichever contributor arrives first and
 * adopted by the rest, slots are deduplicated by their format attribute, and
 * placement is reconciled once per animation frame because the composer card
 * belongs to a React root that re-renders on every keystroke and disappears
 * outside the conversation.
 *
 * @module @dsh-app/plugin-sheet/client/office-bar
 */

/** The shared container's class; the convention every format plugin follows. */
export const OFFICE_BAR_CLASS = 'dshOfficeBar'

/** Attribute identifying one format's capsule host inside the bar. */
export const OFFICE_FORMAT_ATTR = 'data-office-format'

/** Class of a per-format host element (one flex item of the bar). */
export const OFFICE_SLOT_CLASS = 'dshOfficeFormat'

/**
 * The composer card landmark: the class suffix is build-hashed
 * (`<hash>_card` in ui-conversation's InputBar.module.css), so the stable
 * marker is the `data-composer-card` attribute InputBar renders on it.
 */
export const COMPOSER_CARD_SELECTOR = 'div[data-composer-card]'

/** Canonical left-to-right order; formats outside it keep their insert order. */
export const OFFICE_FORMAT_ORDER: readonly string[] = ['ppt', 'word', 'excel', 'pdf']

/** What one reconciliation pass does with the bar. */
export type OfficeBarPlacement = 'none' | 'detach' | 'insert' | 'keep'

/**
 * Decide the bar's placement from the state of one observer pass.
 *
 * `insert` is both the fresh and the stale case: a bar the tracker holds but
 * that no longer follows the card is re-anchored rather than rebuilt, which is
 * what preserves the other plugins' capsules. `keep` is the termination rule —
 * a bar already following the card must produce no write, or the mutation it
 * caused would schedule the next pass forever.
 */
export function officeBarPlacement(state: {
  /** Whether the composer card is currently in the document. */
  readonly cardPresent: boolean
  /** Whether this plugin holds a bar element (connected or not). */
  readonly barPresent: boolean
  /** Whether that element is the card's next element sibling. */
  readonly barAnchored: boolean
}): OfficeBarPlacement {
  if (!state.cardPresent) return state.barPresent ? 'detach' : 'none'
  if (!state.barPresent) return 'insert'
  return state.barAnchored ? 'keep' : 'insert'
}

/**
 * Order and deduplicate slot format ids: known formats by
 * {@link OFFICE_FORMAT_ORDER}, anything else after them in first-seen order.
 */
export function orderOfficeFormats(
  formats: readonly string[],
  priority: readonly string[] = OFFICE_FORMAT_ORDER,
): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const format of formats) {
    if (seen.has(format)) continue
    seen.add(format)
    unique.push(format)
  }
  const rank = (format: string): number => {
    const index = priority.indexOf(format)
    return index === -1 ? priority.length : index
  }
  return unique
    .map((format, position) => ({ format, position }))
    .sort((left, right) => rank(left.format) - rank(right.format) || left.position - right.position)
    .map(entry => entry.format)
}

/** The shared bar currently in the document, when there is one. */
export function findOfficeBar(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(`div.${OFFICE_BAR_CLASS}`) ?? undefined
}

/**
 * The shared bar, created and inserted after the composer card on first use.
 * @returns the bar, or `undefined` while no composer card is on screen.
 */
export function acquireOfficeBar(): HTMLElement | undefined {
  const existing = findOfficeBar()
  if (existing !== undefined) return existing
  const card = document.querySelector<HTMLElement>(COMPOSER_CARD_SELECTOR)
  if (card === null) return undefined
  const bar = document.createElement('div')
  bar.className = OFFICE_BAR_CLASS
  card.insertAdjacentElement('afterend', bar)
  return bar
}

/** The bar's format hosts, in DOM order. */
function officeSlots(bar: HTMLElement): HTMLElement[] {
  return [...bar.children] as HTMLElement[]
}

/**
 * Reorder the bar's hosts into {@link orderOfficeFormats}. Writes only when
 * the current order differs, so a pass that has nothing to fix stays silent.
 */
export function sortOfficeSlots(bar: HTMLElement): void {
  const slots = officeSlots(bar)
  const current = slots.map(slot => slot.getAttribute(OFFICE_FORMAT_ATTR) ?? '')
  const planned = orderOfficeFormats(current)
  if (planned.length === current.length && planned.every((format, index) => format === current[index])) return
  const byFormat = new Map(slots.map(slot => [slot.getAttribute(OFFICE_FORMAT_ATTR) ?? '', slot]))
  for (const format of planned) {
    const slot = byFormat.get(format)
    if (slot !== undefined) bar.append(slot)
  }
}

/**
 * Get this format's host inside the bar, or create it. Idempotent: a repeat
 * call finds the host it created, so a plugin that remounts cannot end up with
 * two capsules of the same format.
 */
export function ensureOfficeSlot(bar: HTMLElement, format: string): HTMLElement {
  const existing = officeSlots(bar).find(slot => slot.getAttribute(OFFICE_FORMAT_ATTR) === format)
  if (existing !== undefined) return existing
  const slot = document.createElement('div')
  slot.className = OFFICE_SLOT_CLASS
  slot.setAttribute(OFFICE_FORMAT_ATTR, format)
  bar.append(slot)
  sortOfficeSlots(bar)
  return slot
}

/** Drop stale hosts of `format` (residue of a dead instance) and adopt ours. */
function adoptOfficeSlot(bar: HTMLElement, slot: HTMLElement, format: string): void {
  for (const child of officeSlots(bar)) {
    if (child !== slot && child.getAttribute(OFFICE_FORMAT_ATTR) === format) child.remove()
  }
  if (slot.parentElement !== bar) bar.append(slot)
  sortOfficeSlots(bar)
}

/**
 * Mount one format's capsule into the shared bar and keep it there.
 *
 * The host element is created once, on the first pass that finds a composer
 * card, and the React root lives inside it across detachments, so leaving the
 * composer and coming back costs no remount. Passes are coalesced per
 * animation frame, and {@link officeBarPlacement} is what keeps a pass from
 * re-inserting what it just inserted, so the observer cannot feed itself.
 *
 * @param format - stable format id, written to `data-office-format`.
 * @param mount - creates the capsule inside the host; returns its unmount.
 * @returns the disposer that stops the observer and unmounts the capsule.
 */
export function contributeOfficeCapsule(
  format: string,
  mount: (slot: HTMLElement) => () => void,
): () => void {
  let slot: HTMLElement | undefined
  let unmount: (() => void) | undefined
  let bar: HTMLElement | undefined

  const reconcile = (): void => {
    const card = document.querySelector<HTMLElement>(COMPOSER_CARD_SELECTOR)
    const placement = officeBarPlacement({
      cardPresent: card !== null,
      barPresent: bar !== undefined,
      barAnchored: card !== null && bar !== undefined && card.nextElementSibling === bar,
    })
    if (placement === 'none') return
    if (placement === 'detach') {
      // No composer on screen (settings and other views): the host leaves the
      // document while its React root stays alive for the next visit.
      bar?.remove()
      return
    }
    if (bar === undefined) {
      bar = acquireOfficeBar()
      if (bar === undefined) return
    }
    if (slot === undefined) {
      // First time the composer appears: create the host and the capsule once,
      // so later detachments move the same nodes instead of remounting.
      slot = ensureOfficeSlot(bar, format)
      unmount = mount(slot)
    } else {
      adoptOfficeSlot(bar, slot, format)
    }
    if (placement === 'insert' && card !== null && card.nextElementSibling !== bar) {
      card.insertAdjacentElement('afterend', bar)
    }
  }

  let frame = 0
  const schedule = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      reconcile()
    })
  }

  reconcile()
  const observer = new MutationObserver(schedule)
  observer.observe(document, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    if (frame !== 0) cancelAnimationFrame(frame)
    unmount?.()
    slot?.remove()
    // The bar is shared: it goes away only when this was its last capsule, so
    // an unloaded format plugin leaves no empty row behind.
    if (bar !== undefined && officeSlots(bar).length === 0) bar.remove()
  }
}
