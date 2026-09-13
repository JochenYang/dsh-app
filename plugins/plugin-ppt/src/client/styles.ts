/**
 * Styles for the office bar, its PPT capsule and the template panel.
 * Alias-token colors only (light and dark both legible); id-guarded injection
 * stays idempotent across mounts. The bar is a row of format capsules inserted
 * directly after the composer card, so it takes the card's measured width and
 * the capsules sit left-aligned at the card's inset. Each capsule is one
 * compact 28px rounded entry: neutral outline while the mode is off, theme
 * outline plus the template name and the ▾ dropdown while it is on. The
 * template panel is a body-portal overlay (mask + card) so the grid never
 * reflows the conversation, with compact buttons (~30px) and a tightened card
 * grid keeping the whole surface proportionate. No transitions or animations
 * anywhere: selection feedback is an instant class toggle, which is both the
 * perf contract and the visual one.
 *
 * @module @dsh-app/plugin-ppt/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-ppt-style'

const cssText = `
.dshOfficeBar {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  max-width: var(--dsh-composer-card-max-width, 100%);
  min-width: 0;
  margin-top: 8px;
}
.dshOfficeFormat {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dshPptCapsule {
  display: inline-flex;
  align-items: center;
  height: 28px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.dshPptCapsule:hover {
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-label-primary);
}
/* Active capsule: the brand fill + foreground text (the same solid treatment
 * as the panel's active tab), so "selected" reads at a glance instead of from
 * a subtle outline. */
.dshPptCapsuleActive,
.dshPptCapsuleActive:hover {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dshPptCapsuleBody {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 100%;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}
.dshPptCapsuleBody:disabled {
  cursor: default;
  opacity: 0.55;
}
.dshPptCapsuleBody:focus-visible,
.dshPptCapsuleCaret:focus-visible,
.dshPptPanelButton:focus-visible,
.dshPptCard:focus-visible,
.dshPptTab:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshPptCapsuleIcon {
  flex: none;
  width: 14px;
  height: 14px;
}
.dshPptCapsuleLabel {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshPptCapsuleCaret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 9px 0 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dshPptCapsuleCaretIcon {
  flex: none;
  width: 12px;
  height: 12px;
}
.dshPptCapsuleError {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
.dshPptCapsuleNotice {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dshPptOverlay {
  /* The native window-control strip owns the top of the window: its buttons
   * are painted by the OS over the page and no page content can cover or
   * receive clicks inside that rectangle. Keeping the whole overlay below the
   * strip (36px = the shell's titleBarOverlay height) means our own controls
   * never sit under it, so they stay clickable in their natural position. */
  inset: 36px 0 0 0;
  /* The window's top strip is a native drag region (the shell marks it with
   * -webkit-app-region: drag), and clicks landing there are swallowed by the
   * OS window drag before any element sees them — z-index does not help. A
   * full-bleed overlay must therefore opt every part of itself out of the
   * drag region, or its top-row controls (close buttons) become unclickable.
   */
  -webkit-app-region: no-drag;
  position: fixed;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.35);
}

/* Descendants too: a control inside the overlay must stay
 * clickable even where the window's native drag strip overlaps it. */
.dshPptOverlay * {
  -webkit-app-region: no-drag;
}
.dshPptPanel {
  display: flex;
  flex-direction: column;
  width: 860px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
}
.dshPptPanelHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 8px;
}
.dshPptPanelTitle {
  flex: none;
  font-size: 14px;
  font-weight: 600;
}
/* Panel subtitle: pins the template semantics (style + layout skeleton, not
 * fixed content) at the exact moment the user is picking one. */
.dshPptPanelHint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
/* Compact panel buttons: ~30px tall, 13px text — sized to the panel, not to
 * the capsule that opens it. */
.dshPptPanelButton {
  flex: none;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.dshPptPanelButton:hover {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dshPptPanelButton:disabled {
  cursor: default;
  opacity: 0.55;
}
.dshPptPanelButtonPrimary {
  background: var(--dsw-alias-button-primary-fill);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground);
}
.dshPptPanelButtonPrimary:hover {
  background: var(--dsw-alias-button-primary-hover);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground);
}
.dshPptPanelDisable {
  margin-right: auto;
}
.dshPptTabs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 16px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2));
}
.dshPptTab {
  padding: 2px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dshPptTab:hover {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
}
.dshPptTabActive {
  background: var(--dsw-alias-button-primary-fill);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground);
}
.dshPptTabActive:hover {
  color: var(--dsw-alias-label-primary-foreground);
}
.dshPptTabCount {
  margin-left: 4px;
  opacity: 0.7;
}
.dshPptGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(188px, 1fr));
  gap: 10px;
  padding: 12px 16px;
  overflow-y: auto;
}
.dshPptCard {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshPptCard:hover {
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
}
.dshPptCardPicked,
.dshPptCardPicked:hover {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary);
}
.dshPptCardFrame {
  position: relative;
  display: block;
}
.dshPptCardBadge {
  position: absolute;
  top: 5px;
  right: 5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
}
.dshPptCardName {
  margin-top: 1px;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-weight: 600;
}
.dshPptCardBlurb {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 1.45;
}
.dshPptCardCover {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  overflow: hidden;
}
.dshPptCardCoverMissing {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
}
.dshPptPanelStatus {
  grid-column: 1 / -1;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dshPptPanelStatusError {
  color: var(--dsw-alias-state-error-primary);
}
.dshPptPanelFooter {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 8px 16px 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
`

/** Inject the capsule and panel styles once per document. */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.append(style)
}

