/**
 * DSH APP swarm — client half.
 *
 * Registers the settings-page section ("并行子代理"): enable toggle,
 * adaptive toggle, and the scheduling knobs backed by the host half's
 * config routes. See the host half's header for the full feature contract.
 *
 * @module @dsh-app/plugin-swarm/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section'),
// the slots service face (ctx.slots), and the slot utility prop faces into
// this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the Conversation header-action slot face and the
// right-Sidebar services (sidebarRight / sidebarRightTabs) into scope.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarRightTabInfo, UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots'
import { useMemo } from 'react'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh } from './client/locales.ts'
import type { SwarmKey } from './client/locales.ts'
import { SwarmSection } from './client/swarm-section.tsx'
import { SwarmBoardTab } from './client/board/tab.tsx'
import { SwarmBoardIcon } from './client/board/icon.tsx'
import { SwarmHeaderAction } from './client/board/header-action.tsx'
import type { SwarmHeaderInjected } from './client/board/header-action.tsx'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the page's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Swarm settings-page copy. */
    [NS]: SwarmKey
  }
}

/** The client halves this plugin depends on. */
export const inject = ['slots', 'locale']

/** Nav identity of the swarm settings page. */
const SECTION_ID = 'dsh-app-swarm'

/** Implementation identity of the live board tab type and its keyed body. */
const BOARD_ID = '@dsh-app/plugin-swarm/board'

/** Page kind the header pill and the guide open. */
const BOARD_KIND = 'dsh-app-swarm-board'

/**
 * The board body needs the enclosing tab record (refresh shortcut, signal,
 * actions), so it has to supply the tab-info hook the right-Sidebar slot
 * declares. The package keeps its own factory private, and `findTabPane`
 * lives in a runtime package this plugin does not otherwise need; the board
 * uses only the tab record and never asks for the pane, so this forwarding
 * hook derives the same shape without that import. `panel.id` is the tab id
 * placeholder — the board does not read it.
 */
const boardTabInfoFactory: SlotHookFactory<'sidebar.right.pane.tab', UseSidebarRightTabInfo> =
  (standard, context) => {
    const { sessionId } = standard
    const { tabId, title, fullscreen, active, signal, actions, useStore, useTabNavigation, shortcuts } = context
    return function useBoardTabInfo() {
      const layout = useStore(state => state.bySession[sessionId]?.layout)
      const navigation = useTabNavigation(tabId)
      return useMemo(() => {
        const tab = layout?.tabs[tabId]
        if (layout === undefined || tab === undefined || navigation === undefined) {
          throw new Error(`plugin-swarm: board tab "${tabId}" is not committed in session "${sessionId}"`)
        }
        return {
          sidebar: { expanded: layout.expanded, fullscreen },
          panel: { id: tabId, isFloating: false },
          tab: {
            ...tab,
            visible: active,
            navigation,
            signal,
            actions,
            refreshShortcut: shortcuts.find(row => row.id === 'page.refresh'),
          },
        } as SidebarRightTabInfo
      }, [layout, navigation, tabId, title, fullscreen, active, signal, actions, shortcuts])
    }
  }

/**
 * Client apply: adopt styles, register the section dictionaries, register the
 * settings section, and patch the nav icon (the shell only ships a generic
 * gear for unknown section ids).
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-swarm: dictionaries')
  // Read per render, so the nav row follows a language switch without
  // re-registration — the same contract as the component's `t` seat.
  const t = ctx.locale.bind(NS)
  // The nav-icon patch finds its cell by label text, so it must read the
  // label at patch time rather than capture one language's copy.
  ctx.effect(() => mountNavIconPatch(() => t('swarm.nav')), 'plugin-swarm: nav icon patch')

  // --- Live board: a right-Sidebar page type, its body, and the session
  // header's status pill. Optional injection keeps the settings page working
  // on a composition that omits the right Sidebar; the board simply never
  // mounts there, and the capacity tool is unaffected. ---
  ctx.inject(['sidebarRight', 'sidebarRightTabs', 'uiWorkspace'], (scope) => {
    scope.effect(() => scope.sidebarRightTabs.register({
      id: BOARD_ID,
      kind: BOARD_KIND,
      // The suite is an extension layered on the kernel, and a page type that
      // declares no band defaults to `extension` anyway. Stated so a future
      // builtin with the same kind cannot quietly take the board over.
      priority: 'extension',
      title: () => t('swarm.board.tab'),
      guide: [{
        id: 'swarm-board',
        // After the shipped file/browser entries, before the tail.
        order: 40,
        title: () => t('swarm.board.open'),
        description: () => t('swarm.board.openHint'),
        icon: SwarmBoardIcon,
      }],
    }), 'plugin-swarm: board tab type')

    // Keyed by the definition id: the seat dispatches every tab of this kind
    // to the component and supplies the tab information hooks itself.
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: BOARD_ID,
      locale: NS,
      inject: () => ({
        hooks: { tabInfo: boardTabInfoFactory },
        openWorker: (address: SubagentAddress) => { scope.uiWorkspace.openSession(address) },
      }),
    }, SwarmBoardTab)), 'plugin-swarm: board tab body')

    // 11 = directly after the kernel's subagent catalog (10). The pill renders
    // nothing when no batch is running or recent, so an idle session loses no
    // header width to it.
    scope.effect(() => scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
      name: 'conversation.session.header.actions',
      id: 'dsh-app-swarm-board',
      order: 11,
      locale: NS,
      inject: (sessionId): SwarmHeaderInjected => ({
        openBoard: () => { scope.sidebarRight.openTabIn(sessionId, BOARD_KIND) },
      }),
    }, SwarmHeaderAction)), 'plugin-swarm: session header pill')
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    // 19 = the agent band: this page sits directly before upstream's
    // agent-presets (20), the surface it tunes. See the order table in
    // docs/desktop-optimization-plan.md.
    order: 19,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: NS,
    label: () => t('swarm.nav'),
  }, SwarmSection))
}
