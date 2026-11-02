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
.dshar_staleHint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
/* The inline notice is for a CONDITION the page is in — a listing that would not
   load, a settings file that cannot be understood. A transient result is the
   Toast primitive instead, so this rule has no "ok" variant: a success has no
   business sitting in the page after the fact. */
.dshar_notice {
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 20px;
}
.dshar_noticeWarn {
  border: 1px solid var(--dsw-alias-state-error-secondary);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-state-error-primary);
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
.dshar_btnDanger {
  color: var(--dsw-alias-state-error-primary);
}
/*
 * A FILLED danger button, for the one place a destructive action is the dialog's
 * primary: the confirm button of empty-trash and purge.
 *
 * It overrides the primitive's own fill tokens rather than its background, so the
 * primitive keeps deciding the foreground (white) and the shape. Overriding the
 * colour instead - which is what dshar_btnDanger did on a primary-variant button -
 * produced a dark fill carrying red text: neither of the two danger idioms, and
 * red on a near-black fill reads as a broken control.
 *
 * Hover reuses the same fill because the theme publishes only two error tokens,
 * primary and secondary, the latter being the border tone. Inventing a darker
 * shade here would be the only colour in this sheet not backed by a token.
 */
.dshar_dangerPrimary {
  --dsw-alias-button-primary-fill: var(--dsw-alias-state-error-primary, #dc2626);
  --dsw-alias-button-primary-hover: var(--dsw-alias-state-error-primary, #dc2626);
}
.dshar_trashInterrupted {
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-state-warning-secondary, rgba(234, 179, 8, 0.35));
  color: var(--dsw-alias-state-warning-primary, #b45309);
  font-size: 11px;
  line-height: 16px;
}
.dshar_modalBody {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
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
.dshar_search {
  display: flex;
  gap: 8px;
  align-items: center;
}
.dshar_searchInput {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
.dshar_searchResults {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dshar_searchHit {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshar_searchSnippet {
  flex: 1 1 100%;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.dshar_groupHeaderStatic {
  cursor: default;
}
/* A row's selection cell: the primitive's visible label is the row's own name,
   which the row already shows — so the text is clipped for sighted users and kept
   for assistive tech. Only the padding is ours; the control is the primitive's. */
.dshar_selectCell {
  flex: none;
}
.dshar_selectCell > span:last-child {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.dshar_bulkBar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.dshar_bulkCount {
  margin-right: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
/* The one input inside the delete dialog: the checkbox and the sentence that
   says what ticking it changes. Layout only — the control, its label and its
   keyboard behaviour are the primitive's. */
.dshar_confirmOption {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.dshar_confirmHint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dshar_retention {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
}
.dshar_tierRow {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dshar_tierLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dshar_tierGroup {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}
.dshar_tier {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 3px 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dshar_tier:hover {
  color: var(--dsw-alias-label-primary);
}
.dshar_tierOn {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.dshar_tier:disabled {
  opacity: 0.5;
  cursor: default;
}
.dshar_retentionUsage {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.dshar_retentionSpan {
  color: var(--dsw-alias-label-tertiary);
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
