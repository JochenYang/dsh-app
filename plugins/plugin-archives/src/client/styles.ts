/**
 * Styles for the archive manager settings section. All colors ride the
 * shell's alias token layer so light/dark themes both stay legible; the id
 * guard makes injection idempotent across section mounts.
 *
 * @module @dsh-app/plugin-archives/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-archives-style'

const cssText = `
.dshar_section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dshar_header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.dshar_title {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary);
}
.dshar_sub {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dshar_notice {
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 20px;
}
.dshar_noticeOk {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.dshar_noticeWarn {
  border: 1px solid var(--dsw-alias-state-error-secondary);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-error-primary);
}
.dshar_confirm {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dshar_confirmActions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}
.dshar_group {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.dshar_groupHeader {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  min-width: 0;
  cursor: pointer;
  user-select: none;
}
.dshar_groupCollapsed > .dshar_groupHeader {
  border-bottom: none;
}
.dshar_groupHeader:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dshar_caret {
  width: 0;
  height: 0;
  flex: none;
  border-left: 4px solid currentColor;
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 0.15s ease;
}
.dshar_groupExpanded .dshar_caret {
  transform: rotate(90deg);
}
.dshar_groupTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshar_groupPath {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dshar_groupMeta {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.dshar_row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  min-width: 0;
}
.dshar_row + .dshar_row {
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dshar_rowTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dshar_rowTitleUnnamed {
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dshar_rowMeta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.dshar_button {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 3px 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dshar_button:hover {
  color: var(--dsw-alias-label-primary);
}
.dshar_button:disabled {
  opacity: 0.5;
  cursor: default;
}
.dshar_buttonDanger {
  border-color: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-state-error-primary);
}
.dshar_empty {
  padding: 26px 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
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
