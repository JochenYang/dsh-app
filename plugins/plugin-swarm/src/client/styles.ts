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

/* --- swarm board: session header pill ------------------------------------ */
.dshs_headerAction {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}
.dshs_headerAction:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dshs_headerAction:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

/* --- swarm board: right Sidebar tab -------------------------------------- */
.dshs_boardRoot {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 10px 12px 12px;
  gap: 10px;
}
.dshs_boardHeader {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: none;
}
.dshs_boardTitleRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dshs_boardTitle {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
  font-weight: 650;
}
.dshs_boardLive {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dshs_boardBody {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.dshs_boardBodyFeed {
  overflow: hidden;
}
.dshs_boardStats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  flex: none;
}
.dshs_stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshs_statValue {
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 20px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.dshs_statValue[data-tone='bad'] { color: var(--dsw-alias-state-error-primary); }
.dshs_statLabel {
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  line-height: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshs_batchList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dshs_batchCard {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
}
.dshs_batchHead {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dshs_batchLabel {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 600;
}
.dshs_batchStatus {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  line-height: 15px;
}
.dshs_batchMeta,
.dshs_batchFoot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}
.dshs_batchBar {
  position: relative;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshs_batchBarFill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary);
  transition: width 0.3s ease;
}
.dshs_bad { color: var(--dsw-alias-state-error-primary); }
.dshs_warn { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary)); }
.dshs_stop {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  line-height: 16px;
  cursor: pointer;
}
.dshs_stop:hover:not(:disabled) {
  border-color: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-state-error-primary);
}
.dshs_stopArmed {
  border-color: var(--dsw-alias-state-error-secondary);
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-bg-layer-1);
}
.dshs_stop:disabled {
  opacity: 0.5;
  cursor: default;
}
.dshs_boardStale {
  flex: none;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dshs_boardError {
  flex: none;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 16px;
}
.dshs_boardEmpty {
  margin: 0;
  padding: 18px 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 19px;
  text-align: center;
}
.dshs_boardEmpty p { margin: 0; }
.dshs_boardHint {
  margin-top: 6px !important;
  font-size: 11px;
  line-height: 17px;
  opacity: 0.85;
}
.dshs_feedTools {
  display: flex;
  justify-content: flex-end;
  flex: none;
}
.dshs_feed {
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  scroll-behavior: smooth;
}
.dshs_event {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: 6px;
  align-items: start;
  min-width: 0;
}
.dshs_eventTime {
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 16px;
  font-family: var(--dsw-alias-font-mono, monospace);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dshs_eventBody {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 17px;
}
.dshs_eventBatch {
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshs_eventDetail {
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  line-height: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshs_memberList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dshs_memberRow {
  min-width: 0;
}
.dshs_workerMeta {
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}
.dshs_workerIds {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  line-height: 15px;
}
.dshs_workerDetailBlock {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}
.dshs_workerDetailLabel {
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 14px;
}
.dshs_workerDetail {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow: auto;
}
.dshs_mono {
  font-family: var(--dsw-alias-font-mono, monospace);
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
