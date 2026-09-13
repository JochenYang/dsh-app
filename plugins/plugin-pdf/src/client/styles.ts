/**
 * Styles for the office bar and the PDF capsule. Alias-token colors only
 * (light and dark both legible); id-guarded injection stays idempotent across
 * mounts. The bar is a row of format capsules inserted directly after the
 * composer card, so it takes the card's measured width and the capsules sit
 * left-aligned at the card's inset — the container rules are restated here
 * because this plugin bundles standalone and must render the bar correctly even
 * when no sibling format plugin is installed. The capsule is one compact 28px
 * rounded entry: neutral outline while the mode is off, theme outline while it
 * is on. No transitions or animations anywhere: selection feedback is an
 * instant class toggle.
 *
 * @module @dsh-app/plugin-pdf/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-pdf-style'

const cssText = `
.dshOfficeBar {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  max-width: var(--dsh-composer-card-max-width, 100%);
  min-width: 0;
  margin-top: 8px;
}
.dshOfficeFormat {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dshPdfCapsule {
  display: inline-flex;
  align-items: center;
  height: 28px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.dshPdfCapsule:hover {
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-label-primary);
}
/* Active capsule: the brand fill + foreground text (the same solid treatment
 * as the PPT panel's active tab), so "selected" reads at a glance instead of
 * from a subtle outline. */
.dshPdfCapsuleActive,
.dshPdfCapsuleActive:hover {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dshPdfCapsuleBody {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 100%;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}
.dshPdfCapsuleBody:disabled {
  cursor: default;
  opacity: 0.55;
}
.dshPdfCapsuleBody:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshPdfCapsuleIcon {
  flex: none;
  width: 14px;
  height: 14px;
}
.dshPdfCapsuleLabel {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshPdfCapsuleError {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
.dshPdfCapsuleNotice {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
`

/** Inject the bar and capsule styles once per document. */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.append(style)
}
