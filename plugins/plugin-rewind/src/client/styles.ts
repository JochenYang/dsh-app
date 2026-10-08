/**
 * Styles for the per-message recall icon and the `/rewind` transcript row.
 *
 * Alias-token colours only, so both themes stay legible; the id-guarded
 * injection stays idempotent across mounts. The `dshRewind-` prefix keeps the
 * global CSS namespace collision-free.
 *
 * @module @dsh-app/plugin-rewind/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-rewind-style'

const cssText = `
.dshRewind-iconRow {
  /*
   * The icon joins the built-in actions line rather than stacking a second row
   * under it.
   *
   * The built-in user bubble ends with its own actions row (the time label plus
   * the copy button), and that row is not addressable by name — its classes are
   * build-hashed. So the icon is absolutely positioned into the free space at
   * the row's right end, and the actions row is shifted left by the icon's
   * footprint to make that space (see the [data-clock] rule below).
   */
  position: absolute;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  opacity: 0;
  transition: opacity 80ms;
}
.dshRewind-iconAction {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
/*
 * The reveal keys off the CHAT FLOW ITEM, not this row.
 *
 * This row is absolutely positioned over the message block, so a rule on the
 * row's own :hover would only fire once the pointer had already left the
 * bubble — the user hovers the message, which is the whole point. The flow item
 * wraps the bubble and this row, so hovering anywhere in the message reveals
 * the icon: the same mechanism the built-in message actions use.
 */
[data-chat-flow-kind="user"]:hover .dshRewind-iconRow,
[data-chat-flow-kind="steering"]:hover .dshRewind-iconRow,
.dshRewind-iconRow:focus-within {
  opacity: 1;
}
.dshRewind-iconAction:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dshRewind-iconAction:focus-visible {
  outline: 2px solid var(--dsw-alias-state-primary-primary);
  outline-offset: 1px;
}
/* The containing block for the absolutely positioned icon row. */
[data-chat-flow-kind="user"],
[data-chat-flow-kind="steering"] {
  position: relative;
}
/*
 * Make room for the icon at the right end of the built-in actions line.
 *
 * data-clock is the stable semantic attribute the kernel's own
 * MessageIconActions emits on that row (a user message renders it with
 * data-clock="start"); its class names are build-hashed and unusable as a
 * selector. The row is a flex container, so a right margin moves the icon's
 * space to the far right without disturbing the time/copy order.
 */
[data-chat-flow-kind="user"] [data-clock="start"] {
  margin-right: 32px;
}
@media (hover: none) {
  /* A touch device has no hover, so the icon must always be reachable. */
  .dshRewind-iconRow {
    opacity: 1;
  }
}
/*
 * The confirmation dialog's CONTENT only.
 *
 * The frame — mask, card, elevation, title, close affordance, footer buttons —
 * comes from the host's own Modal and Button components (confirm-dialog.tsx), so
 * these rules style just the file list inside it. Redrawing the frame here is what
 * made an earlier version look wrong in both themes.
 *
 * The one exception is the CARD WIDTH, set through the primitive's own
 * className seat: its 380px default suits a sentence and wraps a code line three
 * times in a diff. A wider card is a content requirement, and overriding it
 * through the documented hook is not redrawing the frame.
 *
 * The selector is doubled on purpose. The primitive's own dialog class is a
 * single class too, so an equal-specificity rule would win or lose by whichever
 * stylesheet the document happened to load last — a race, not a decision.
 * Doubling makes the override order-independent.
 */
.dshRewind-confirmDialog.dshRewind-confirmDialog {
  width: min(880px, 100%);
}
.dshRewind-fileList {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.dshRewind-fileRow {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
}
.dshRewind-fileHead {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dshRewind-fileAction {
  flex: none;
  padding: 0 6px;
  border-radius: var(--dsw-radius-xs);
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshRewind-fileAction[data-action="restore"] {
  color: var(--dsw-alias-state-warning-primary);
}
.dshRewind-fileAction[data-action="remove"] {
  color: var(--dsw-alias-state-error-primary);
}
.dshRewind-filePath {
  flex: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}


/*
 * The one sentence a user must not miss: what this recall CANNOT put back. It
 * stays visible even at zero, so silence never reads as "nothing else changed".
 */
.dshRewind-dialogNote {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dshRewind-dialogNote[data-tone="warn"] {
  color: var(--dsw-alias-state-warning-primary);
}
/*
 * The quarantine manager (a tab of the suite's maintenance settings section).
 *
 * Content only, like the confirm dialog: the frame is the settings shell's. The
 * colours are alias tokens so both themes stay legible, and the size figures use
 * tabular numerals so a column of them lines up.
 */
.dshRewind-quarantine {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dshRewind-quarantineIntro {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dshRewind-quarantineError {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
}
.dshRewind-quarantineNotice {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dshRewind-quarantineGroup {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dshRewind-quarantineHead {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 4px 0;
}
.dshRewind-quarantineSession {
  flex: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dshRewind-quarantineMeta {
  flex: none;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dshRewind-quarantineList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dshRewind-quarantineRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 4px 8px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
}
.dshRewind-quarantineRowMain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: auto;
}
.dshRewind-quarantineKind {
  flex: none;
  padding: 0 6px;
  border-radius: var(--dsw-radius-xs);
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshRewind-quarantineKind[data-kind="created"] {
  color: var(--dsw-alias-state-warning-primary);
}
.dshRewind-quarantinePath {
  flex: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dshRewind-quarantineWarn {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
}
.dshRewind-commandRow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dshRewind-commandRow[data-tone="error"] {
  color: var(--dsw-alias-state-error-primary);
}
.dshRewind-commandText {
  min-width: 0;
}
`

/** Inject the stylesheet once per document. */
export function adoptStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-app/plugin-rewind'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = cssText
  document.head.appendChild(tag)
}
