/**
 * Styles for the preset-packages settings section. Alias-token colors only
 * (light/dark both legible); id-guarded injection stays idempotent across
 * mounts. Same visual language as the other suite sections; class prefix
 * `dshPresets-` keeps the global CSS namespace collision-free.
 *
 * @module @dsh-app/plugin-presets/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-presets-style'

const cssText = `
.dshPresets-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dshPresets-title {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary);
}
.dshPresets-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dshPresets-banner {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dshPresets-noticeOk {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-success-secondary, rgba(34, 197, 94, 0.35));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-success-primary, #16a34a);
  font-size: 13px;
  line-height: 20px;
}
.dshPresets-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.dshPresets-count {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dshPresets-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dshPresets-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  flex-wrap: wrap;
}
.dshPresets-entryName {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}
.dshPresets-meta {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  word-break: break-all;
}
.dshPresets-cardMain {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 200px;
  min-width: 0;
}
.dshPresets-cardActions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dshPresets-button {
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 12px;
}
.dshPresets-button:disabled { opacity: 0.5; cursor: not-allowed; }
.dshPresets-buttonPrimary {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
  font-weight: 600;
}
.dshPresets-empty {
  padding: 18px 12px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 20px;
  text-align: center;
}
.dshPresets-path {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  word-break: break-all;
}
/* Confirmation modal — same in-page dialog idiom as the other suite
 * sections: mask, 340px alias-token card, Esc/mask-click = cancel. */
.dshPresets-mask {
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
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, .35);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

/* Descendants too: a control inside the overlay must stay
 * clickable even where the window's native drag strip overlaps it. */
.dshPresets-mask * {
  -webkit-app-region: no-drag;
}
.dshPresets-dialogCard {
  position: relative;
  width: 340px;
  max-width: calc(100vw - 48px);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06));
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .28);
}
.dshPresets-dialogTitle {
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #0f172a);
  margin-bottom: 6px;
}
.dshPresets-dialogMessage {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #475569);
  line-height: 1.6;
}
.dshPresets-dialogActions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
`

/** Inject once per document (id-guarded, safe across HMR re-mounts). */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.append(style)
}

