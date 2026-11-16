/**
 * Styles for the swarm settings section. Alias-token colors only (light/
 * dark both legible); id-guarded injection stays idempotent across mounts.
 * Same visual language as the memory/usage sections.
 *
 * @module @dsh-app/plugin-swarm/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-swarm-style'

const cssText = `
.dshs_section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dshs_title {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary);
}
.dshs_hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dshs_banner {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dshs_noticeOk {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dshs_toggleRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshs_toggleLabel {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dshs_toggleHint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dshs_toggle {
  margin-left: auto;
  width: 34px;
  height: 20px;
  flex: none;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  cursor: pointer;
  padding: 0;
  position: relative;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.dshs_toggle::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-label-secondary);
  transition: transform 0.15s ease, background 0.15s ease;
}
.dshs_toggle[aria-checked='true'] {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dshs_toggle[aria-checked='true']::after {
  transform: translateX(14px);
  background: var(--dsw-alias-bg-layer-1);
}
.dshs_toggle:disabled {
  opacity: 0.5;
  cursor: default;
}
.dshs_grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
  min-width: 0;
}
.dshs_field {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dshs_fieldLabel {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}
.dshs_fieldBadge {
  margin-left: auto;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 14px;
}
.dshs_fieldBadgeCustom {
  color: var(--dsw-alias-brand-primary);
}
.dshs_fieldInput {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}
.dshs_fieldInput:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dshs_fieldHint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dshs_actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.dshs_button {
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dshs_button:hover:not(:disabled) {
  border-color: var(--dsw-alias-brand-primary);
}
.dshs_button:disabled {
  opacity: 0.5;
  cursor: default;
}
.dshs_buttonPrimary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-layer-1);
}
.dshs_path {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  font-family: var(--dsw-alias-font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`

/** Inject the section styles once per document. */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.append(style)
}
