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
.dshcg_tabs {
  display: flex;
  min-width: 0;
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
  /* Grows into whatever the action leaves, and truncates only when the text is
     genuinely wider than that space. It must NOT shrink-to-fit its own text:
     that is what truncated the longest language name to "Regular..." while
     empty space sat beside it. The min-width below is what lets the ellipsis
     apply to a flex item at all. */
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshcg_langAction {
  /* The action keeps its own width whatever happens to the name. */
  flex: 0 0 auto;
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
