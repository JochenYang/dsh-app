/**
 * The Creator row in the sidebar's global-panel More menu.
 *
 * It lives in `sidebar.panellist.actions` — the list the sidebar declares for
 * extra rows beside the panel list — which is also where the kernel's own
 * "Create your plugin" row sits. Ours says where the plugin will land: the
 * workbench, as a card.
 *
 * COMPOSED FROM THE PRIMITIVE, NOT DRAWN. The row is the primitives package's
 * `MenuItemButton`, the same component the kernel's own rows in that menu use.
 * Everything that makes a row belong in that list comes with it: the
 * `role="menuitem"` button, the group hairline (`separatorBefore`), the row
 * padding and hover fill, and the keyboard behaviour — the menu's arrow walk is
 * `querySelectorAll('button:not(:disabled)')` and Tab selects a focused
 * `menuitem`, both of which a hand-rolled div would miss while looking identical.
 * Nothing here is imported at build time beyond the specifier: `buildClient`
 * marks every `@deepseek-ai/*` external (`plugins/build-lib.mjs`
 * `externalFramework`), so the composed loader's module table answers it at run
 * time.
 *
 * The icon is the package's own plus (`IconPlusOutlineRegular`) for the same
 * reason: "create" is a plus in this set already, and a second glyph for one
 * verb would read as a different action.
 *
 * THE PROMPT IS DICTIONARY COPY. The string this row hands the action is
 * pre-filled into the new session's draft, where the user reads and edits it —
 * so it is resolved through `workbench.createPrompt` at press time, in the
 * language in force then, with the skill name interpolated from
 * `src/contract.ts`. A constant in `client/create.ts` would have shown English
 * in a Chinese UI.
 *
 * WHY A PROBLEM LINE AT ALL. The action answers a status token instead of
 * throwing (`client/create.ts`), and the menu stays open when that token is a
 * problem: a row that swallowed it would leave a user pressing a control that
 * does nothing, with no way to tell a slow start from a missing service. The
 * sentence is the container's own (`entryMessage`, the same copy the page hands
 * every card), so the tokens keep exactly one set of words. On success the menu
 * dismisses itself: the frame leaves for the new session, which unmounts this
 * row anyway.
 *
 * @module @dsh-app/plugin-workbench/client/create-row
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { IconPlusOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelActionsOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { WORKBENCH_SKILL_NAME } from '../contract.ts'
import type { CreateCreatorSession } from './create.ts'
import type { WorkbenchEntryProblem } from './entry.ts'
import { NS } from './locales.ts'

/** The business face this registration injects into the row. */
export interface WorkbenchCreateRowInjected {
  /** Start a Creator session; never rejects, answers a status token. */
  readonly createPlugin: CreateCreatorSession
  /** This container's copy for a problem token (the page's own, so both read alike). */
  readonly entryMessage: (status: WorkbenchEntryProblem) => string
}

/** Props delivered by the seat: the More menu's owner share, this row's face, its `t` seat. */
export type WorkbenchCreateRowProps =
  & SidebarPanelActionsOwnerProps
  & PropsLocale<typeof NS>
  & WorkbenchCreateRowInjected

/** One Creator row, with the last problem it answered and whether a start is in flight. */
export function WorkbenchCreateRow(props: WorkbenchCreateRowProps): ReactElement {
  const { t, createPlugin, entryMessage, onDismiss } = props
  const [problem, setProblem] = useState<WorkbenchEntryProblem>()
  const [starting, setStarting] = useState(false)

  const select = (): void => {
    // Clearing first makes a second press a fresh attempt rather than a row that
    // keeps showing the previous failure while the new one is in flight.
    setProblem(undefined)
    setStarting(true)
    // The prompt is DRAFT text the user will read and edit, so it is resolved
    // through the dictionary at press time — in the language in force now, not
    // the one in force when this row mounted. The skill name rides in as a
    // parameter from its one source (`src/contract.ts`).
    void createPlugin(t('workbench.createPrompt', { skill: WORKBENCH_SKILL_NAME })).then((status) => {
      setStarting(false)
      if (status === 'ok') {
        onDismiss()
        return
      }
      setProblem(status)
    })
  }

  return (
    <MenuItemButton
      separatorBefore
      icon={<IconPlusOutlineRegular size={16} />}
      // The primitive sets `disabled` on the row's own button, and the menu's
      // arrow walk skips `:disabled` — so a second press cannot start a second
      // session while the first is still beginning.
      disabled={starting}
      onSelect={select}
    >
      <span className="dshWorkbench-create">
        <span className="dshWorkbench-createLabel">{t('workbench.create')}</span>
        {problem === undefined ? null : (
          <span className="dshWorkbench-createProblem" role="status">{entryMessage(problem)}</span>
        )}
      </span>
    </MenuItemButton>
  )
}
