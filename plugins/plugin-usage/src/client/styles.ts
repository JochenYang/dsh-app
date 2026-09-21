/**
 * Styles for the usage settings section. All colors ride the shell's alias
 * token layer so light/dark themes both stay legible; the id guard makes
 * injection idempotent across section mounts.
 *
 * @module @dsh-app/plugin-usage/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-usage-style'

const cssText = `
.dshau_section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dshau_header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.dshau_title {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary);
}
.dshau_tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshau_tab {
  border: none;
  border-radius: 6px;
  padding: 3px 10px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dshau_tab[aria-selected='true'] {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 3px var(--dsw-alias-bg-mask-2);
}
.dshau_metricTabs {
  margin-left: auto;
}
.dshau_secondaryButton {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 3px 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dshau_secondaryButton:hover {
  color: var(--dsw-alias-label-primary);
}
.dshau_autoToggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dshau_banner {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 8px;
  background: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dshau_cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  min-width: 0;
}
.dshau_card {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshau_cardLabel {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dshau_cardValue {
  margin-top: 3px;
  color: var(--dsw-alias-label-primary);
  font-size: 17px;
  line-height: 24px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.dshau_cardSub {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshau_cardSubError {
  color: var(--dsw-alias-state-error-primary);
}
.dshau_cardClickable {
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.dshau_cardClickable:hover,
.dshau_cardClickable:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  outline: none;
}
.dshau_panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}
.dshau_panelHeader {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.dshau_panelTitle {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
}
.dshau_legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dshau_legendItem {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dshau_legendSwatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
.dshau_legendLine {
  width: 14px;
  height: 0;
  border-top: 1.5px dashed var(--dsw-alias-label-primary);
}
.dshau_legendCell {
  width: 11px;
  height: 11px;
  border-radius: 3px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshau_legendCell[data-level='1'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, var(--dsw-alias-bg-layer-2));
}
.dshau_legendCell[data-level='2'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 48%, var(--dsw-alias-bg-layer-2));
}
.dshau_legendCell[data-level='3'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, var(--dsw-alias-bg-layer-2));
}
.dshau_legendCell[data-level='4'] {
  background: var(--dsw-alias-brand-primary);
}
.dshau_calendar {
  position: relative;
  display: grid;
  /* Width comes from the grid template (set inline from the measured panel);
     the fallback scroll only engages at the minimum cell size. */
  width: max-content;
  max-width: 100%;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 4px;
}
/* The grid and its side stats share one row: the numbers anchor the shape
   (how many days, which one peaked) instead of leaving the reader to count. */
.dshau_calRow {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 24px;
  min-width: 0;
}
.dshau_calStats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 22px;
  margin: 0;
  padding-top: 6px;
}
.dshau_calStats dt {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dshau_calStats dd {
  margin: 2px 0 0;
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dshau_calStatsDate {
  color: var(--dsw-alias-label-tertiary) !important;
  font-size: 11px !important;
  line-height: 16px !important;
  font-weight: 400 !important;
}
/* Granularity switch and the fill scale, under the grid. */
.dshau_calFooter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dshau_calModes {
  margin-left: 0;
}
.dshau_legendScale {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dshau_calLegend {
  width: 10px !important;
  height: 10px !important;
  cursor: default;
}
.dshau_calTotal {
  font-variant-numeric: tabular-nums;
}
.dshau_calMonth {
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 14px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.dshau_calCell {
  /* Size is set inline (the grid scales to its panel); these are the
     pre-measurement fallbacks, matching the largest step. */
  width: 13px;
  height: 13px;
  border-radius: 3px;
  /* The empty-day base has to be VISIBLE against the panel, or a 53-week grid
     reads as scattered fragments instead of a calendar — the empty days are
     what give the filled ones their shape. A hairline keeps the grid legible
     in both schemes without competing with the fill scale. */
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
  cursor: default;
  overflow: hidden;
  color: transparent;
  font-size: 0;
}
.dshau_calCell[data-level='1'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, var(--dsw-alias-bg-layer-1));
}
.dshau_calCell[data-level='2'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, var(--dsw-alias-bg-layer-1));
}
.dshau_calCell[data-level='3'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 72%, var(--dsw-alias-bg-layer-1));
}
.dshau_calCell[data-level='4'] {
  background: var(--dsw-alias-brand-primary);
}
.dshau_chart {
  width: 100%;
  aspect-ratio: 680 / 240;
}
.dshau_chart text {
  fill: var(--dsw-alias-label-tertiary);
  font-size: 10px;
}
.dshau_tableWrap {
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.dshau_table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.dshau_table th,
.dshau_table td {
  padding: 5px 7px;
  text-align: right;
  white-space: nowrap;
}
.dshau_table th:first-child,
.dshau_table td:first-child {
  padding-left: 12px;
}
.dshau_table th:last-child,
.dshau_table td:last-child {
  padding-right: 12px;
}
.dshau_table th {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 600;
  font-size: 11px;
  line-height: 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshau_table th:first-child,
.dshau_table td:first-child {
  text-align: left;
}
.dshau_table td {
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}
.dshau_share {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 92px;
}
.dshau_shareBar {
  display: inline-block;
  height: 5px;
  border-radius: 3px;
  background: var(--dsw-alias-brand-primary);
}
.dshau_empty {
  padding: 26px 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
}
.dshau_tooltip {
  position: fixed;
  z-index: 2000;
  display: none;
  min-width: 160px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 6px 24px var(--dsw-alias-bg-mask-2);
  pointer-events: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshau_tooltipTitle {
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
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
