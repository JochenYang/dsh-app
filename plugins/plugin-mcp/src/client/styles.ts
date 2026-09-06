/**
 * Styles for the MCP settings section. Alias-token colors only (light/dark
 * both legible); id-guarded injection stays idempotent across mounts. Same
 * visual language as the swarm/memory sections; class prefix `dshMcp-` keeps
 * the global CSS namespace collision-free.
 *
 * @module @dsh-app/plugin-mcp/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-mcp-style'

const cssText = `
.dshMcp-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dshMcp-title {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary);
}
.dshMcp-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dshMcp-banner {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dshMcp-noticeOk {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-success-secondary, rgba(34, 197, 94, 0.35));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-success-primary, #16a34a);
  font-size: 13px;
  line-height: 20px;
}
.dshMcp-warning {
  padding: 6px 10px;
  border: 1px solid rgba(234, 179, 8, 0.4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dshMcp-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.dshMcp-toolbarActions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dshMcp-formHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.dshMcp-viewToggle {
  display: inline-flex;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  overflow: hidden;
  flex: none;
}
.dshMcp-viewBtn {
  padding: 3px 12px;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
}
.dshMcp-viewBtn:disabled { cursor: default; }
.dshMcp-viewBtnOn {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
  font-weight: 600;
}
/* Compound selector (0,2,0) on purpose: it must beat the base
 * .dshMcp-textarea rule (0,1,0) regardless of stylesheet order — a plain
 * same-specificity override silently lost to the base min-height. */
.dshMcp-textarea.dshMcp-jsonArea {
  /* Tall by default: the placeholder example and a pasted mcpServers block
     should read whole without the user having to drag the resizer. */
  min-height: 260px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  white-space: pre;
  overflow-x: auto;
}
.dshMcp-importReport {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dshMcp-count {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dshMcp-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dshMcp-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshMcp-cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dshMcp-serverName {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}
.dshMcp-badge {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(148, 163, 184, 0.2);
  color: var(--dsw-alias-label-secondary);
}
.dshMcp-badgeOn {
  background: rgba(34, 197, 94, 0.16);
  color: var(--dsw-alias-state-success-primary, #16a34a);
}
.dshMcp-badgeOff {
  background: rgba(148, 163, 184, 0.14);
  color: var(--dsw-alias-label-tertiary);
}
.dshMcp-badgeErr {
  background: rgba(239, 68, 68, 0.14);
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dshMcp-meta {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  word-break: break-all;
}
.dshMcp-cardActions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dshMcp-button {
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 12px;
}
.dshMcp-button:disabled { opacity: 0.5; cursor: not-allowed; }
.dshMcp-buttonPrimary {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
  font-weight: 600;
}
.dshMcp-buttonDanger { color: var(--dsw-alias-state-error-primary, #dc2626); }
.dshMcp-toggle {
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
.dshMcp-toggle[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.dshMcp-toggle::after {
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
.dshMcp-toggle[aria-checked="true"]::after { transform: translateX(16px); }
.dshMcp-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.dshMcp-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshMcp-formTitle {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary);
}
.dshMcp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dshMcp-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dshMcp-fieldGrow { flex: 1 1 240px; }
.dshMcp-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dshMcp-input {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}
.dshMcp-textarea {
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
.dshMcp-fieldHint {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  line-height: 16px;
}
.dshMcp-radioGroup {
  display: flex;
  gap: 14px;
}
.dshMcp-radioGroup label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dshMcp-formActions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dshMcp-empty {
  padding: 18px 12px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 20px;
  text-align: center;
}
.dshMcp-path {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  word-break: break-all;
}
/* Confirmation modal — the React port of the shell's in-frame dialog idiom
 * (src/main/in-frame-dialog.ts): same mask, 340px card, radius/shadow, and
 * alias-token palette with the shell's own hard fallbacks. */
.dshMcp-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, .35);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.dshMcp-dialogCard {
  position: relative;
  width: 340px;
  max-width: calc(100vw - 48px);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06));
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .28);
}
.dshMcp-dialogTitle {
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #0f172a);
  margin-bottom: 6px;
}
.dshMcp-dialogMessage {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #475569);
  line-height: 1.6;
}
.dshMcp-dialogActions {
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
