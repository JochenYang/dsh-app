/**
 * The workbench glyph in the sidebar's global-panel row.
 *
 * Drawn here rather than taken from `@deepseek-ai/dsh-client-ui-primitives`
 * because that set has no glyph that reads as "several workbenches in one
 * place": the only workspace-shaped icon it ships
 * (`IconWorkspaceTreeOutlineRegular`) is ui-workspace's own "group by workspace
 * tree" view toggle, so using it for a workbench would read as a view option —
 * and it would sit directly above the 工作区 / Workspaces section header, which
 * is the one thing this row must NOT be confused with.
 *
 * The geometry is the primitives' own, so it sits beside the pinwheel and the
 * clock without reading off-theme: a 16-unit box, `currentColor` stroke, a 1px
 * Regular weight, `aria-hidden` (the row supplies the accessible name from the
 * registration's label), and the requested edge as both width and height.
 *
 * `active` is deliberately unused: the sidebar already marks the selected row
 * itself, and a glyph that painted its own selected state would be a second
 * reading of one fact.
 *
 * @module @dsh-app/plugin-workbench/client/icon
 */

import type { ReactElement } from 'react'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Four benches, one page: the container's reading of "several domains". */
export function WorkbenchPanelIcon({ size }: SidebarPanelIconOwnerProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  )
}
