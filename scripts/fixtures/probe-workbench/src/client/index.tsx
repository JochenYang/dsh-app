/**
 * Workbench probe fixture — browser half (never shipped).
 *
 * Answers one question against a REAL kernel: does `@dsh-app/plugin-workbench`'s
 * container actually hand a domain plugin the two seats it declares, and does
 * the container page behave the way its own header claims?
 *
 * This plugin is an ordinary DOMAIN, not a container: it registers
 *   - one card into the container's `workbench.item` list seat (`id: probe`);
 *   - one view into the container's `workbench.view` keyed seat (`key: probe`).
 * Both registrations go through `ctx.slots.inject`, because the two seats only
 * EXIST while the container's `main` registration is live — the container's
 * `children` table is what declares them, and registering into an undeclared
 * slot throws.
 *
 * `sessionStorage.probeNoCard` is the empty-state control: set before a reload,
 * the card registration is skipped while the view's is not, so the container
 * renders its "nothing registered yet" branch. The flag is read at apply time,
 * and a page reload re-runs every client entry, so one reload switches branches
 * without touching the container.
 *
 * The harness seam `window.__probeWorkbenchPage` exists so the probe
 * (`scripts/probe-workbench.cjs`) can drive the panel store directly
 * (`selectPanel(null)` is the "leave the panel" move that unmounts the page) and
 * so the live seat registry can be read from outside the container.
 *
 * The card carries THREE entry points, one per door the container offers: the
 * view door (`openView`, panel mode), the workspace door with a real directory
 * (`enterWorkspace`, session mode) and the same door with an empty path, which
 * is the failed case the container owns copy for. The directory arrives through
 * `window.__probeWorkbenchEntryPath`, published by the harness before the click,
 * so no path is baked into this bundle.
 *
 * @module @dsh-app/probe-workbench/client
 */

import { useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** The client services this probe touches. */
export const inject = ['slots', 'layout']

/** The container's panel id: the sidebar row and the `main` key are one string. */
export const PANEL_ID = 'workbench'

/** The single domain id this probe registers both its card and its view under. */
const DOMAIN_ID = 'probe'

/** Entry as `entriesOfSlot` reports it (the seat's own, type-erased shape). */
interface StoredEntryLike {
  readonly options: { readonly key?: unknown; readonly id?: unknown }
}

/** The slice of the slots service this probe uses. */
interface SlotsService {
  inject(key: string, callback: () => (() => void) | readonly (() => void)[]): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
  entriesOfSlot(key: string): readonly StoredEntryLike[]
}

/** The slice of the layout service this probe uses. */
interface LayoutService {
  selectPanel(panelId: string | null): void
  panelInfo: { getSnapshot(): { activePanelId: string | null } }
}

/** Owner props the container hands every card it renders into its grid. */
interface CardOwnerProps {
  /** Show the view registered under this id. */
  readonly openView?: (viewId: string) => void
  /** The view the container is showing, or `undefined` while the grid is shown. */
  readonly activeView?: string | undefined
  /** Register a directory as a workspace and open it. Never rejects. */
  readonly enterWorkspace?: (path: string) => Promise<string>
  /** This container's copy for a problem token. */
  readonly entryMessage?: (status: string) => string
}

/** What the harness hands this card through the page global. */
interface ProbeEntryState {
  readonly path: string
  readonly token: string
  readonly message: string
}

/** The directory the harness publishes for the success-path button. */
function entryPath(): string {
  const value = (window as unknown as Record<string, unknown>).__probeWorkbenchEntryPath
  return typeof value === 'string' ? value : ''
}

/**
 * The card. Its behaviours are all owner props: the container hands it the two
 * doors (a view inside the container, a workspace of its own) and the copy for a
 * failed entry, and the card decides only where the words go.
 *
 * The status token and the rendered message are BOTH kept, in separate elements,
 * so a probe can tell apart "the call returned the right token" from "the card
 * rendered the container's sentence for it".
 */
function ProbeCard(props: CardOwnerProps): JSX.Element {
  const { openView, activeView, enterWorkspace, entryMessage } = props
  const [entry, setEntry] = useState<ProbeEntryState>()

  const enter = (path: string): void => {
    if (typeof enterWorkspace !== 'function') {
      setEntry({ path, token: 'NO-enterWorkspace-prop', message: 'NO-enterWorkspace-prop' })
      return
    }
    // No `catch`: `enterWorkspace` answers a status token instead of rejecting,
    // so a rejection here is the design constraint breaking and must surface as
    // an unhandled rejection rather than be swallowed.
    void enterWorkspace(path).then((token) => {
      setEntry({
        path,
        token,
        message: token === 'ok'
          ? ''
          : (typeof entryMessage === 'function' ? entryMessage(token) : 'NO-entryMessage-prop'),
      })
    })
  }

  return (
    <div data-probe-card={DOMAIN_ID}>
      <span data-probe-card-title="true">PROBE DOMAIN CARD</span>
      <button
        type="button"
        data-probe-open={DOMAIN_ID}
        onClick={(): void => { if (typeof openView === 'function') openView(DOMAIN_ID) }}
      >
        OPEN PROBE VIEW
      </button>
      <button
        type="button"
        data-probe-enter-workspace="true"
        onClick={(): void => { enter(entryPath()) }}
      >
        ENTER WORKSPACE
      </button>
      <button
        type="button"
        data-probe-enter-empty="true"
        onClick={(): void => { enter('') }}
      >
        ENTER EMPTY PATH
      </button>
      <span data-probe-entry-token="true">{`entry=${entry === undefined ? 'none' : entry.token}`}</span>
      <span data-probe-entry-path="true">{entry === undefined ? '' : entry.path}</span>
      <span data-probe-entry-message="true">{entry === undefined ? '' : entry.message}</span>
      <span>{`activeView=${String(activeView)}`}</span>
    </div>
  )
}

/** The view the card asks for. */
function ProbeView(): JSX.Element {
  return <div data-probe-view={DOMAIN_ID}>PROBE VIEW CONTENT</div>
}

/** Read the addressable names currently in one of the container's child seats. */
function entryNames(slots: SlotsService, key: string): string[] {
  return slots.entriesOfSlot(key).map((entry) => {
    const options = entry.options
    const address = typeof options.key === 'string' ? options.key : options.id
    return typeof address === 'string' ? address : ''
  })
}

/**
 * Register the domain's card and view into the container's seats, and publish
 * the harness seam.
 *
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.slots as unknown as SlotsService
  const layout = ctx.layout as unknown as LayoutService
  const skipCard = sessionStorage.getItem('probeNoCard') === '1'

  if (!skipCard) {
    slots.inject('workbench.item', () => slots.register({
      name: 'workbench.item',
      id: DOMAIN_ID,
      order: 0,
    }, ProbeCard))
  }
  slots.inject('workbench.view', () => slots.register({
    name: 'workbench.view',
    key: DOMAIN_ID,
  }, ProbeView))

  const globals = window as unknown as Record<string, unknown>
  globals.__probeWorkbenchPage = {
    /** Drive the panel store directly (null = back to the conversation). */
    selectPanel: (panelId: string | null): void => { layout.selectPanel(panelId) },
    /** The store's current selection. */
    activePanelId: (): string | null => layout.panelInfo.getSnapshot().activePanelId,
    /** Live card ids in the container's grid seat. */
    cardIds: (): string[] => entryNames(slots, 'workbench.item'),
    /** Live view keys in the container's view seat. */
    viewIds: (): string[] => entryNames(slots, 'workbench.view'),
    /** The directory the success-path button will hand `enterWorkspace`. */
    entryPath: (): string => entryPath(),
    /** Whether the empty-state control suppressed this load's card. */
    skipCard,
  }
}
