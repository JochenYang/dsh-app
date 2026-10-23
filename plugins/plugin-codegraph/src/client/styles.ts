/**
 * Styles for the code graph settings page.
 *
 * Every colour is a `--dsw-alias-*` token, and the token FAMILY names are the
 * ones the primitive package actually defines — `label-*` for text, `bg-layer-*`
 * for surfaces, `state-warn-*` for the amber family. This module used to name
 * `text-*`, `bg-secondary` and `state-warning-*`, none of which exist: a CSS
 * variable that is not defined makes its whole declaration invalid, so the
 * secondary text hierarchy and every amber warning silently fell back to the
 * inherited colour. Nothing caught it — `tsc`, the suites and the plugin gates all
 * read code, not CSS — which is why `tests/styles.test.ts` now pins every token
 * used here against the set the primitives define.
 *
 * Two shapes are deliberately NOT styled here because a primitive owns them: the
 * status pill and the language tags are `Tag` (`plugins/AGENTS.md` §6 — a capsule
 * has a fixed geometry, and only its palette varies), and paths are `PathLabel`.
 *
 * @module @dsh-app/plugin-codegraph/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-codegraph-style'

const cssText = `
.dshcg_section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.dshcg_intro {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.6;
}
.dshcg_picker {
  display: flex;
  min-width: 0;
}
/* The trigger shows the CURRENT project's name and must not push the menu wider
   than the page: a long directory name truncates instead of stretching the
   control. */
.dshcg_pickerLabel {
  display: block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The chevron reads as an affordance only if it keeps its size and its gap: a
   squeezed one is decoration that looks like a rendering glitch.
   Rotating on open ties the glyph to the state it stands for; the transition
   names transform alone, which the motion rules allow, and it is dropped
   entirely under reduced motion. */
.dshcg_pickerChevron {
  flex: 0 0 auto;
  margin-left: 4px;
  opacity: 0.7;
  transition: transform var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-in-out);
}
.dshcg_picker [aria-expanded='true'] .dshcg_pickerChevron {
  transform: rotate(180deg);
}
@media (prefers-reduced-motion: reduce) {
  .dshcg_pickerChevron {
    transition: none;
  }
}
.dshcg_card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
}
.dshcg_row {
  display: flex;
  align-items: center;
  gap: 10px;
  /* Same rule as the language row below, and for the same measured reason: a
     flex item's default flex-shrink of 1 lets the container squeeze a button
     narrower than its own label, and a two-character Chinese label then breaks
     onto two lines. This row holds the re-index action, which folds the same way. */
  flex-wrap: wrap;
  min-width: 0;
}
.dshcg_row > button {
  flex: 0 0 auto;
}
.dshcg_meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  min-width: 0;
}
.dshcg_notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.55;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.dshcg_noticeWarn {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}
.dshcg_noticeError {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dshcg_langs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}
.dshcg_lang {
  /* TWO rows, not one flat flex line. The name and its action share the first
     row and the tags get the second. A single wrapped line was the reported
     layout: at the grid's 240px floor the name, two tags and the button cannot
     all fit, so the button dropped to its own line — pushed to the right edge by
     an auto margin — and a neighbouring card with shorter tags kept them inline,
     so the grid had cards of two different heights. */
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  min-width: 0;
}
.dshcg_langMain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dshcg_langMeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dshcg_langName {
  font-size: 13px;
  /* Layout only. Shrinks when the row runs out, never grows past its text. */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}
.dshcg_langLabel {
  /* The TOOLTIP ANCHOR, and deliberately an inline box: the primitive measures
     its child's rect, so the bubble lands over the word only if this box IS the
     word. A flex item here would be positioned by the layout algorithm — every
     flex value tried on the anchor put the bubble somewhere else in the card. */
  display: inline;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshcg_langAction {
  /* The action keeps its own width whatever happens to the name, and rides the
     right edge so the buttons line up down the grid. An auto left margin used to
     strand it on its own wrapped line; the card is two rows now and this row
     holds only name + action, with the name the one that shrinks — so there is
     no second line for it to fall onto. */
  flex: 0 0 auto;
  margin-left: auto;
}
.dshcg_empty {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
}
.dshcg_title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dshcg_viewPad {
  /* The view's ROOT, and it owns the scroll.
     The slot is rendered inside the conversation's viewArea element, which is a flex
     COLUMN: its height comes from flex, and a percentage height on a flex child
     resolves against that, not against the region. A first attempt of height 100%
     alone therefore left the root at content height and the surface collapsed.
     Flex-grow with a zero minimum is what makes a child fill that column, and the
     auto vertical overflow keeps a tall graph scrollable inside it. */
  box-sizing: border-box;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 32px;
  /* Opaque, so the conversation pane's watermark does not read through the
     list. The shell paints this same base colour behind the transcript. */
  background: var(--dsw-alias-bg-base);
}
/* Take the pane over while THIS view is mounted.
   The composer belongs to the conversation shell, not to the view, so a view that
   wants the whole pane has to say so — and the way dsh-context says it, read off
   its own stylesheet, is a has-rule keyed on the view's root class. Nothing reads
   state: the rule applies exactly while the root exists, and the shell's draft
   survives because the composer is hidden rather than unmounted.
   The not-has clause is the part that matters most: an approval, a
   question or a plan review must stay visible even here, or this view would hide
   the control that the session is waiting on. */
[data-conversation-scroll]:has(.dshcg_viewPad, .dshcg_viewFile) > [data-composer-seat]:not(:has([data-approval-key], [data-question-key], [data-plan-review-key])) {
  display: none;
}
/* The transcript-width handles are FOLLOWING SIBLINGS of the scroller, so the
   combinator is a sibling tilde, not a descendant selector. Without this the
   drag handles stay visible over a pane that no longer has a transcript. */
[data-conversation-scroll]:has(.dshcg_viewPad, .dshcg_viewFile) ~ [data-width-handle] {
  display: none;
}
/* The list's own header: the title and the count, above the groups. */
.dshcg_viewHead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
  min-width: 0;
}
.dshcg_viewHeadTitle {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dshcg_viewHeadMeta {
  margin-left: auto;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dshcg_group {
  margin-bottom: 18px;
}
.dshcg_groupTitle {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
  /* The directory is a heading for the rows under it, not a row itself: mono and
     subdued so it reads as a path rather than as another file name. */
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshcg_files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.dshcg_file {
  box-sizing: border-box;
  display: grid;
  /* Name takes the slack, then a proportional bar, then two right-aligned
     numbers. A GRID so the bar and both numbers line up down the column — the
     whole reason a list beats the circle this replaced. */
  grid-template-columns: minmax(0, 1fr) 88px 76px 68px;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshcg_file:hover {
  /* The shell hover wash, not a layer token. Both layer tokens resolve to the
     SAME colour as the base in the light theme, so the first hover was
     invisible: measured, the row did not change at all, and a clickable row with
     no feedback reads as plain text. This is the token every other clickable row
     uses, and it is a 6 percent ink wash rather than a surface colour. */
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshcg_file:active {
  background: var(--dsw-alias-interactive-bg-active);
}
.dshcg_file:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: -2px;
}
.dshcg_fileName {
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dshcg_fileBar {
  height: 4px;
  border-radius: 2px;
  background: var(--dsw-alias-bg-layer-3);
  overflow: hidden;
}
.dshcg_fileBarFill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--dsw-alias-state-success-primary);
}
.dshcg_fileCount {
  text-align: right;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dshcg_fileRefs {
  text-align: right;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dshcg_viewNote {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
/* --- The sidebar page: a project rail beside one project's graph. --- */
.dshcg_page {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* Opaque: this page is a whole pane, and the shell paints this colour behind
     every other one. */
  background: var(--dsw-alias-bg-base);
}
.dshcg_pageHead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex: none;
  padding: 16px 20px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  min-width: 0;
}
.dshcg_pageTitle {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dshcg_pageMeta {
  margin-left: auto;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dshcg_pageBody {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}
.dshcg_pageRail {
  flex: 0 0 232px;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 8px;
  border-right: 1px solid var(--dsw-alias-border-l1);
  min-width: 0;
}
.dshcg_projs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dshcg_proj {
  box-sizing: border-box;
  display: grid;
  /* Name on the first line, when and state under it: a project path is long and
     a single-line row would truncate the only part that identifies it. */
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'name state' 'meta state';
  align-items: center;
  gap: 1px 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshcg_proj:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshcg_proj:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: -2px;
}
/* The selected row is a STATE, not a hover: it must survive the pointer leaving,
   so it uses the pressed wash plus a rail marker. */
.dshcg_proj[data-selected='1'] {
  background: var(--dsw-alias-interactive-bg-active);
}
.dshcg_projName {
  grid-area: name;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dshcg_projMeta {
  grid-area: meta;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dshcg_projState {
  grid-area: state;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.dshcg_projState[data-state='current'] {
  color: var(--dsw-alias-state-success-primary);
}
.dshcg_projState[data-state='stale'] {
  color: var(--dsw-alias-state-warn-primary);
}
.dshcg_projState[data-state='failed'] {
  color: var(--dsw-alias-state-error-primary);
}
.dshcg_pageMain {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
.dshcg_pagePath {
  flex: none;
  padding: 10px 20px 0;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dshcg_viewFile {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* Same contract as the overview root: this IS the view's root when a file is
     open, inside the same flex-column viewArea. */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 32px;
  min-width: 0;
  /* The conversation pane draws its own watermark behind the transcript, and a
     view that leaves its background transparent shows it through the table —
     text over a whale. The base colour is what the shell itself paints. */
  background: var(--dsw-alias-bg-base);
}
.dshcg_viewFileHead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.dshcg_viewBack {
  /* A real button, not a borderless label: it is the only way back, so it has to
     look pressable and carry a hover state. Text only — the arrow that used to
     sit here was decoration beside a label that already says what it does. */
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dshcg_viewBack:hover {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-3);
}
.dshcg_viewBack:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: 1px;
}
.dshcg_viewFileTitle {
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
}
.dshcg_symbols {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  table-layout: fixed;
}
.dshcg_symbols th {
  padding: 4px 8px;
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshcg_symbols td {
  padding: 3px 8px;
  vertical-align: baseline;
  border-bottom: 1px solid var(--dsw-alias-bg-layer-2);
}
.dshcg_symbols tbody tr:hover {
  /* Same reason as the file rows: the layer token equals the base colour in the
     light theme, so a hover that used it changed nothing on screen. */
  background: var(--dsw-alias-interactive-bg-hover);
}
/* Fixed column widths: kind and line are bounded, name and calls absorb the
   slack. The whole point of the table is that these edges agree on every row. */
.dshcg_symbolKind {
  width: 76px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}
.dshcg_symbolName {
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshcg_symbolLine {
  width: 56px;
  text-align: right;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dshcg_symbolCalls {
  width: 34%;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`

/** Inject the stylesheet once. */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.append(style)
}

/** Every token this module references, for the style test to check. */
export function referencedTokens(): string[] {
  return [...cssText.matchAll(/var\((--dsw-alias-[a-z0-9-]+)\)/gu)].map(match => match[1]!)
}
