/**
 * Styles for the web search settings section. Alias-token colors only (light
 * and dark both legible); id-guarded injection stays idempotent across
 * mounts. Same visual language as the MCP/swarm/memory sections; class prefix
 * `dshWs-` keeps the global CSS namespace collision-free.
 *
 * @module @dsh-app/plugin-websearch/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-websearch-style'

const cssText = `
.dshWs-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dshWs-title {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary);
}
.dshWs-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dshWs-banner {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dshWs-noticeOk {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-success-secondary, rgba(34, 197, 94, 0.35));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-success-primary, #16a34a);
  font-size: 13px;
  line-height: 20px;
}
.dshWs-warning {
  padding: 6px 10px;
  border: 1px solid rgba(234, 179, 8, 0.4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dshWs-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshWs-cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dshWs-cardTitle {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary);
}
.dshWs-badge {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(148, 163, 184, 0.2);
  color: var(--dsw-alias-label-secondary);
}
.dshWs-badgeFree {
  background: rgba(34, 197, 94, 0.16);
  color: var(--dsw-alias-state-success-primary, #16a34a);
}
.dshWs-badgeKey {
  background: rgba(249, 115, 22, 0.16);
  color: #c2410c;
}
.dshWs-badgeErr {
  background: rgba(239, 68, 68, 0.14);
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dshWs-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dshWs-engineRow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshWs-engineMain {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 240px;
  min-width: 0;
}
.dshWs-engineName {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dshWs-engineHint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 17px;
}
.dshWs-engineStatus {
  font-size: 11.5px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
}
.dshWs-engineStatusOk { color: var(--dsw-alias-state-success-primary, #16a34a); }
.dshWs-engineStatusErr { color: var(--dsw-alias-state-error-primary, #dc2626); }
.dshWs-engineActions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.dshWs-order {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: none;
}
.dshWs-orderBtn {
  width: 22px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}
.dshWs-orderBtn:disabled { opacity: 0.35; cursor: not-allowed; }
.dshWs-button {
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 12px;
}
.dshWs-button:disabled { opacity: 0.5; cursor: not-allowed; }
.dshWs-buttonPrimary {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
  font-weight: 600;
}
.dshWs-toggle {
  position: relative;
  width: 36px;
  height: 20px;
  flex: none;
  border: none;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.4);
  cursor: pointer;
  transition: background 120ms ease;
}
.dshWs-toggle[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.dshWs-toggle::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 120ms ease;
}
.dshWs-toggle[aria-checked="true"]::after { transform: translateX(16px); }
.dshWs-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.dshWs-grid {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.dshWs-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dshWs-fieldGrow { flex: 1 1 240px; }
/* Column-direction sibling of the above: grows in the CROSS axis (width)
 * without a basis, so it never reserves vertical space it does not use.
 * dshWs-fieldGrow is a ROW-container class (its flex-basis is a width);
 * reusing it inside a column container makes the basis a height and blows a
 * 240px hole in the card. */
.dshWs-fieldBlock { flex: 1 1 auto; width: 100%; }
.dshWs-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dshWs-input {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}
.dshWs-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 54px;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
}
.dshWs-fieldHint {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  line-height: 16px;
}
.dshWs-segmented {
  display: inline-flex;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  overflow: hidden;
  flex: none;
}
.dshWs-segBtn {
  padding: 5px 14px;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
}
.dshWs-segBtn:disabled { cursor: default; opacity: 0.6; }
.dshWs-segBtnOn {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
  font-weight: 600;
}
.dshWs-grid {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.dshWs-probeList {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dshWs-probeRow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  word-break: break-all;
}
.dshWs-probeName { font-weight: 600; color: var(--dsw-alias-label-primary); flex: none; }
.dshWs-path {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  word-break: break-all;
}
.dshWs-empty {
  padding: 18px 12px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 20px;
  text-align: center;
}
/* Provider choice cards: a radio-style pair that carries its own status, so
 * "which source answers" and "is that source usable" read as one decision
 * instead of a switch plus a separate badge the user has to connect. */
.dshWs-providerRow {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.dshWs-providerCard {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 220px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.dshWs-providerCard:disabled { cursor: not-allowed; opacity: 0.75; }
.dshWs-providerCardOn {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary);
}
.dshWs-providerHead {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dshWs-providerDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: rgba(148, 163, 184, 0.6);
}
.dshWs-providerDotOn { background: var(--dsw-alias-state-success-primary, #16a34a); }
.dshWs-providerDotOff { background: var(--dsw-alias-state-error-primary, #dc2626); }
.dshWs-providerMeta {
  font-size: 11.5px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
}
/* Confirmation modal — the React port of the shell's in-frame dialog idiom
 * (src/main/in-frame-dialog.ts): same mask, 340px card, radius/shadow, and
 * alias-token palette with the shell's own hard fallbacks. */
.dshWs-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, .35);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.dshWs-dialogCard {
  position: relative;
  width: 340px;
  max-width: calc(100vw - 48px);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06));
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .28);
}
.dshWs-dialogTitle {
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #0f172a);
  margin-bottom: 6px;
}
.dshWs-dialogMessage {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #475569);
  line-height: 1.6;
}
.dshWs-dialogActions {
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
