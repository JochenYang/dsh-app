/**
 * Glyphs for the Office group in the composer's `/` menu.
 *
 * The menu renderer calls a candidate's `icon` component with `{ size: 14 }`
 * and nothing else, so each row's glyph is a thin adapter over the kernel's own
 * file-type artwork — the same glyphs the file cards use, which is why an Office
 * row reads as a file format rather than as an invented icon set. Sizing and
 * colour stay with `FileTypeIcon`; this module only maps a kind to it.
 *
 * The adapter's prop type is `{ size?: number }` and not the primitives'
 * `IconProps` on purpose: that interface is not re-exported from the package's
 * index, and the menu's own contract is exactly one optional number. Anything
 * wider would be a promise this surface cannot keep.
 *
 * @module @dsh-app/plugin-ppt/client/office-menu-icons
 */

import type { ReactElement } from 'react'
import type { OfficeMenuIconKind } from './office-menu.ts'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'

/** The menu's icon contract: one optional pixel size, nothing else. */
export interface OfficeMenuIconProps {
  readonly size?: number
}

/**
 * Build one glyph component per kind.
 *
 * Components are created once at module load so a re-render of the menu hands
 * the renderer the same component identity it saw last time — a fresh closure
 * per render would remount the SVG on every keystroke.
 */
const GLYPHS: Readonly<Record<OfficeMenuIconKind, (props: OfficeMenuIconProps) => ReactElement>> = {
  word: props => <FileTypeIcon kind="word" size={props.size} />,
  pdf: props => <FileTypeIcon kind="pdf" size={props.size} />,
  ppt: props => <FileTypeIcon kind="ppt" size={props.size} />,
  excel: props => <FileTypeIcon kind="excel" size={props.size} />,
}

/** Resolve the glyph for one row kind. */
export function officeMenuIcon(kind: OfficeMenuIconKind): (props: OfficeMenuIconProps) => ReactElement {
  return GLYPHS[kind]
}
