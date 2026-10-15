/**
 * DSH APP workbench hub — client half.
 *
 * Contributes ONE row to the sidebar's global-panel list (`sidebar.panellist`):
 * the 工作台 / Workbench entry, ordered above the kernel's own rows. The same id
 * addresses this plugin's page in the layout's root-scoped `main` keyed slot —
 * the row and the page are one panel, addressed by one string, and a row whose
 * `main` entry is missing makes `ctx.layout.selectPanel` throw rather than
 * showing an empty column.
 *
 * The row is registered with `order: -1`. Measured on this kernel line: the
 * kernel's own two rows carry `order: 0` (插件 / Plugins) and `order: 10`
 * (自动化任务 / Schedules), the list sorts ascending, and `order` defaults to 0
 * when omitted — so any negative value sits above both. `-1` rather than a
 * round number because it is the smallest claim that satisfies the requirement;
 * a tie would have fallen back to registration order, and this plugin registers
 * after the kernel's.
 *
 * @module @dsh-app/plugin-workbench/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slots service face (ctx.slots) into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the layout contract's `main` SlotMap entry into this
// compilation unit. The `main` seat is declared by the layout package, so its
// keyed panel key is only a known slot name where that package's types are in
// scope — without this import `ctx.slots.inject('main', …)` does not compile.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the sidebar contract's SlotMap merge ('sidebar.panellist'
// and its owner props) into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createWorkspaceEntry } from './client/entry.ts'
import type { WorkspaceEntry, WorkbenchEntryProblem } from './client/entry.ts'
import { WorkbenchPanelIcon } from './client/icon.tsx'
import { en as workbenchEn, NS as WORKBENCH_NS, zh as workbenchZh } from './client/locales.ts'
import type { WorkbenchKey } from './client/locales.ts'
import { WorkbenchPage } from './client/page.tsx'
import type { WorkbenchCardOwnerProps } from './client/page.tsx'
import { adoptStyles } from './client/styles.ts'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workbench hub copy (the sidebar row label and the container page), in this plugin's namespace. */
    [WORKBENCH_NS]: WorkbenchKey
  }

  /**
   * The two seats a domain registers into.
   *
   * They are DECLARED here, by the container that renders them, because the
   * slot model makes the declaring entry the only one allowed to render the
   * key — so `workbench.item` is a seat a domain may fill but never replace,
   * and the grid cannot be drawn twice by two owners.
   *
   * Both are root-scoped and carry no session: a card exists before any
   * conversation does, and a card whose domain is session-bound leaves for a
   * workspace of its own choosing rather than reading the current one.
   */
  // BEGIN workbench-card-slot — a domain card repeats this block VERBATIM.
  // The suite ships no shared package and this plugin publishes no types, so a
  // card has nothing to import: the declaration and the owner-props interface
  // are copied by hand, and a misspelt field would leave both sides compiling
  // while the card disappears into the outlet's error boundary at run time. The
  // markers are what a drift test will compare once the first real card lands.
  interface SlotMap {
    /** One card per domain workbench, ordered by the registration's `order`. */
    'workbench.item': {
      kind: 'list'
      scope: 'root'
      owner: WorkbenchCardOwnerProps
    }
    /** A domain's own page, addressed by the card's registered `id`. */
    'workbench.view': {
      kind: 'keyed'
      scope: 'root'
    }
  }
  // END workbench-card-slot
}

/**
 * The client halves this plugin declares a dependency on.
 *
 * `workspaces` and `uiWorkspace` are deliberately NOT here. A declaration is a
 * wait — this whole entry would stay dormant until those services activate —
 * while the entry is built to answer `pending` for exactly the case where they
 * are absent. Two measured facts make that the right shape: `ctx.get` answers
 * `undefined` during apply and comes up when a page renders, and cordis's untyped
 * lookup returns undefined rather than throwing for a service nobody provides.
 */
export const inject = ['slots', 'locale']

/**
 * Id shared by the sidebar row and the main panel it opens.
 *
 * EXPORTED, and imported by the panel registration, because the two must be the
 * same string and nothing else checks it: the list slot types `id` as an open
 * `string`; the sidebar's own metadata type points at the layout package's
 * `MainPanelId`, whose character set this repository cannot read (the layout
 * package is not installed here, and this plugin's tsconfig skips lib checks);
 * and the slot-registration gate compares slot names, never panel keys. A drift
 * therefore surfaces only as a thrown `selectPanel: main panel "…" is not
 * registered` in the running app — one shared constant is what turns it into a
 * compile error instead.
 *
 * A bare id rather than a namespaced one (`dsh-app.workbench`): the suite's
 * convention is a short generic id per seat — `plugin-sidebar` registers
 * `conversation.view` as `git` — and the registry refuses a collision loudly
 * rather than silently, which is the acceptable failure shape here.
 */
export const PANEL_ID = 'workbench'

/**
 * Row order. `-1` is the smallest claim that meets the requirement: the row must
 * sort above the kernel's own rows, which carry `order: 0` (插件) and `order: 10`
 * (自动化任务) on this line, and the list sorts ascending with an omitted `order`
 * defaulting to 0.
 */
export const PANEL_ORDER = -1

/**
 * Client apply: register the dictionaries, then the sidebar row.
 *
 * `ctx.slots.inject` (rather than a bare register) is what makes this work
 * whichever order the sidebar and this plugin activate in: it waits for the
 * `sidebar.panellist` declaration, removes the contribution if the declaration
 * folds, and re-registers when it returns.
 *
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // --- Dictionaries first: the row's label resolves through this namespace,
  // and the effect disposes the pair with this plugin's fiber. ---
  ctx.effect(
    () => ctx.locale.register(WORKBENCH_NS, { zh: workbenchZh, en: workbenchEn }),
    'dsh-app plugin-workbench: dictionaries',
  )
  // The sidebar resolves list metadata per ledger pass rather than per render,
  // so the label arrives as a thunk over this binding: a language switch is
  // re-read on the next pass instead of needing a re-registration.
  const t = ctx.locale.bind(WORKBENCH_NS)

  // The session-mode door. Built once per apply because it closes over this
  // context; the SERVICES themselves are resolved inside it, per call — see
  // `client/entry.ts` for why that is a rule and not an optimisation.
  const enterWorkspace: WorkspaceEntry = createWorkspaceEntry(ctx)

  /**
   * This container's copy for a problem token.
   *
   * Two codes get a sentence of their own because they are the two a user can
   * act on: `invalid-argument` (the card asked for nothing) and the host's
   * `workspace/invalid-path` (the folder is missing or unreadable — measured as
   * the one code `create` can realistically answer, since the host's create is
   * create-or-resolve). Everything else keeps the code inside the sentence as a
   * diagnostic marker, rather than inventing copy for a token this build does
   * not own; a host that adds a code gets a readable sentence and no wrong claim.
   *
   * `ok` has none on purpose: a successful entry opens the workspace, the frame
   * returns to the Conversation, and this page unmounts — a card rendering a
   * success message would be racing its own teardown. The parameter type excludes
   * `ok` so that branch cannot be written by mistake.
   *
   * @param status - a token that is not `ok`.
   * @returns the localized sentence for it.
   */
  const entryMessage = (status: WorkbenchEntryProblem): string => {
    switch (status) {
      case 'pending': return t('workbench.entry.pending')
      case 'error:invalid-argument': return t('workbench.entry.noPath')
      case 'error:workspace/invalid-path': return t('workbench.entry.missingPath')
      default: {
        // Every remaining member of the union starts with `error:`, but the type
        // is a template literal, so a status added later would land here rather
        // than failing to compile. Showing its own name beats showing nothing.
        const code = status.startsWith('error:') ? status.slice('error:'.length) : String(status)
        return t('workbench.entry.error', { code })
      }
    }
  }

  // Id-guarded, so a re-apply is a no-op rather than a second stylesheet.
  adoptStyles()

  /**
   * Keys of the views currently registered into `workbench.view`, read from the
   * LIVE registry on every call.
   *
   * Deliberately not snapshotted at registration time: the entries these name
   * belong to other plugins, and `ctx.slots.inject` lets them arrive after this
   * one. A keyed entry is addressed by `key`; the `typeof` guard is a runtime
   * fence for a registrant written in plain JS, where nothing checks it.
   *
   * @returns the view keys, in the order the seat will render them.
   */
  const viewKeys = (): readonly string[] =>
    ctx.slots.entriesOfSlot('workbench.view').flatMap((entry) => {
      const key = entry.options.key
      return typeof key === 'string' ? [key] : []
    })

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    // `locale:` puts the namespace-bound `t` seat on the component's props and
    // makes the label itself part of the checked dictionary surface.
    locale: WORKBENCH_NS,
    label: () => t('workbench.nav'),
  }, WorkbenchPanelIcon))

  // --- The page the row opens. `key` is the SAME constant the row's `id` is,
  // and that identity is the whole panel: nothing in the type system relates a
  // list id to a keyed main key, so one exported constant is what keeps them
  // from drifting (see PANEL_ID's note). ---
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: WORKBENCH_NS,
    // The registration's own share, handed to the page as props. The grid's own
    // presence is NOT in here: that belongs to the seat's `fallback`, which the
    // outlet subscribes to, so a card registered after the page rendered still
    // appears without this plugin holding a store or a subscription.
    inject: () => ({
      viewIds: viewKeys,
      enterWorkspace,
      entryMessage,
    }),
    // Declaring a child seat is what authorizes this entry — and only this
    // entry — to render it, so a second owner cannot draw the grid.
    children: {
      'workbench.item': { kind: 'list', scope: 'root' },
      'workbench.view': { kind: 'keyed', scope: 'root' },
    },
  }, WorkbenchPage))
}
