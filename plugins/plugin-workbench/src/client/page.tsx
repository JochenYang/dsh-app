/**
 * The workbench container page.
 *
 * It draws the header, the grid the domain cards land in, the empty state, and
 * — when a card has asked for one — the view that card's domain registered. It
 * owns no domain behaviour: which card exists, what it says, and whether it
 * opens a view or leaves for a workspace session are the domain's own.
 *
 * TWO PROPERTIES OF THE SEAT SHAPE THIS COMPONENT, both measured on this kernel
 * line, and both are why the container needs no store of its own:
 *
 * 1. The frame renders the `main` keyed slot with `entryKey` taken from
 *    `panelInfo.activePanelId` (falling back to `conversation`). Only the
 *    SELECTED key renders, so leaving the workbench UNMOUNTS this component.
 *    A view the user had opened therefore cannot survive a round trip to a
 *    conversation and back: `useState` is the whole reset rule, and an effect
 *    watching the panel would be a second mechanism for one fact. Measured with
 *    an expando token on the mounted page: the same element survives three
 *    state changes inside the panel, and a fresh element appears after leaving
 *    and returning.
 * 2. The card grid's presence is decided by the SEAT's own `fallback`, not by
 *    this component counting registrations. Counting them here would put the
 *    decision in a component that subscribes to nothing: the registry changes
 *    would not re-render it, so a card registered while the page is open would
 *    not appear, and the last card leaving would strand an empty grid with no
 *    copy. `renderSlot`'s outlet IS subscribed, so the fallback flips exactly
 *    when the entry list does.
 *
 * The one live read left is `viewIds`, used by `openView` to refuse a view
 * nothing registered. It is read at press time rather than render time, when it
 * is fresh by construction.
 *
 * WHAT THIS COMPONENT DOES NOT DO ABOUT THE KEYBOARD. It renders the entries of
 * a seat it does not own, and the slot renderer produces no per-entry wrapper to
 * hang a handler on — so a card's own entry points have to be real `button`
 * elements (see {@link WorkbenchCardOwnerProps}). The container's own chrome is
 * therefore buttons, and the two things it CAN own it does: focus lands on the
 * view region when it opens, and Escape returns to the grid.
 *
 * @module @dsh-app/plugin-workbench/client/page
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceEntry, WorkbenchEntryProblem, WorkbenchEntryStatus } from './entry.ts'
import { NS } from './locales.ts'

/**
 * Owner share the container hands every entry rendered into the grid.
 *
 * A domain card declares which side of this it uses: a panel-mode card calls
 * {@link openView} with its own registered id, a session-mode card calls
 * {@link enterWorkspace} with a directory and never sees a rejection — the
 * result is a status token, and {@link entryMessage} turns a problem token into
 * this container's copy. Both doors are the container's own: the first switch is
 * its view seat, the second is the one place in the suite that resolves the
 * workspace services, so no domain repeats that discipline.
 *
 * ONE ROOT ELEMENT is this seat's structural contract, because the card frame
 * is a CSS rule on the outlet anchor's children (see `styles.ts`): a card that
 * renders a fragment or several roots is drawn as several bordered boxes, and a
 * card that renders `null` is invisible.
 *
 * KEYBOARD BEHAVIOUR INSIDE A CARD IS THE CARD'S. The container renders the
 * entries of a seat it does not own, and the slot renderer gives it no
 * per-entry wrapper, so a card's entry points have to be real `button` elements
 * (or carry a role plus their own key handling) for the grid to be reachable.
 * Measured: `SlotOutlet` emits one `display: contents` anchor per renderSlot
 * call and the entry component itself is the next element, with no intermediate
 * node of the renderer's.
 */
export interface WorkbenchCardOwnerProps {
  /** Show the view registered under `viewId`; no-op when nothing registered it. */
  readonly openView: (viewId: string) => void
  /**
   * Register `path` as a workspace and open it, so the frame returns to the
   * Conversation. Never rejects; resolves `ok` on success.
   */
  readonly enterWorkspace: (path: string) => Promise<WorkbenchEntryStatus>
  /**
   * This container's copy for a problem token. `ok` has no copy on purpose: the
   * frame has already left for the Conversation by then, which unmounts the page.
   */
  readonly entryMessage: (status: WorkbenchEntryProblem) => string
}

/**
 * The registration's own share.
 *
 * `viewIds` reads the LIVE seat registry on every call rather than snapshotting
 * it here, because the entries it names belong to other plugins and
 * `ctx.slots.inject` lets them arrive after this one. It is the only fact the
 * page needs from that registry — the grid's own presence belongs to the seat's
 * `fallback`, which the outlet subscribes to.
 */
export interface WorkbenchPageInjected {
  /** Keys of the registered views. */
  readonly viewIds: () => readonly string[]
  /** The session-mode entry action the page hands to every card. */
  readonly enterWorkspace: WorkspaceEntry
  /** The problem-token copy the page hands to every card. */
  readonly entryMessage: (status: WorkbenchEntryProblem) => string
}

/** Props delivered by the seat: this page's `t` seat, its render shares, its own face. */
export type WorkbenchPageProps =
  & PropsLocale<typeof NS>
  & PropsRenderSlots<'workbench.item' | 'workbench.view'>
  & WorkbenchPageInjected

/** The container: header, card grid, or one domain's view. */
export function WorkbenchPage(props: WorkbenchPageProps): ReactElement {
  const { t, renderSlot, viewIds, enterWorkspace, entryMessage } = props
  const [viewId, setViewId] = useState<string>()
  const viewRef = useRef<HTMLDivElement>(null)

  const openView = useCallback((id: string): void => {
    if (!viewIds().includes(id)) return
    setViewId(id)
  }, [viewIds])
  const closeView = useCallback((): void => { setViewId(undefined) }, [])

  // Two independent concerns, deliberately not merged into one effect:
  //
  // - FOCUS: entering a view unmounts the card that was pressed, so without this
  //   the focus falls to `body` and a keyboard user is stranded with no signal
  //   that the region changed. Moving it to the region is what makes the view
  //   announce itself.
  // - ESCAPE: a document-level listener, the same idiom the suite's dialogs use
  //   — a handler on the region would stop firing the moment focus left it. It
  //   is registered only while a view is open, so it never swallows Escape from
  //   a surface that is not this one.
  useEffect(() => { if (viewId !== undefined) viewRef.current?.focus() }, [viewId])
  useEffect(() => {
    if (viewId === undefined) return undefined
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeView() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [viewId, closeView])

  if (viewId !== undefined) {
    return (
      <div className="dshWorkbench-page" ref={viewRef} tabIndex={-1}>
        <div className="dshWorkbench-inner">
          <header className="dshWorkbench-head">
            <div className="dshWorkbench-headRow">
              <button type="button" className="dshWorkbench-back" onClick={closeView}>
                {t('workbench.back')}
              </button>
              <h1 className="dshWorkbench-title">{t('workbench.title')}</h1>
            </div>
          </header>
          <div className="dshWorkbench-body">
            {renderSlot('workbench.view', {}, { entryKey: viewId })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dshWorkbench-page">
      <div className="dshWorkbench-inner">
        <header className="dshWorkbench-head">
          <h1 className="dshWorkbench-title">{t('workbench.title')}</h1>
          <p className="dshWorkbench-intro">{t('workbench.intro')}</p>
        </header>
        <div className="dshWorkbench-grid">
          {renderSlot('workbench.item', { openView, enterWorkspace, entryMessage }, {
            fallback: <p className="dshWorkbench-empty">{t('workbench.empty')}</p>,
          })}
        </div>
      </div>
    </div>
  )
}
