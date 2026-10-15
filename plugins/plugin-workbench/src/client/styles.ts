/**
 * Styles for the workbench container page.
 *
 * Alias-token colors only, so both themes stay legible; the injection is
 * id-guarded and therefore idempotent across re-mounts. The class prefix
 * `dshWorkbench-` keeps the global CSS namespace collision-free.
 *
 * Two decisions worth naming, both taken from the kernel's own entry pages
 * (the plugin manager and the schedule manager):
 *
 * - The head is the only thing that pads for the window's top strip. On the
 *   Windows desktop the shell draws a native title bar over the page, and on
 *   macOS the traffic lights sit over it; `--dsh-frame-top-clearance` is the
 *   frame's published inset for exactly this, and the darwin-only rule below is
 *   how the kernel's own pages consume it. A page that padded unconditionally
 *   would carry a gap on platforms that have no strip.
 * - The grid's child rule IS the card frame. A card is a component the domain
 *   registers, and the container cannot wrap a rendered slot's children one by
 *   one — so the frame is the container's own rule, which makes "one card per
 *   seat entry" the seat's visual contract rather than a convention every domain
 *   has to reproduce. It lands on `.dshWorkbench-grid > [data-slot] > *` and NOT
 *   on the grid's direct children: the renderer wraps each renderSlot call in a
 *   `display: contents` anchor, and a frame property set on an anchor is
 *   discarded, because the anchor generates no box at all.
 *
 * @module @dsh-app/plugin-workbench/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-workbench-style'

const cssText = `
.dshWorkbench-page {
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  padding: 0 clamp(24px, 4vw, 48px) 48px;
}
.dshWorkbench-inner {
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
}
.dshWorkbench-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 28px;
}
[data-platform='darwin'] .dshWorkbench-head {
  padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px));
}
.dshWorkbench-headRow {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.dshWorkbench-title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 500;
}
.dshWorkbench-intro {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dshWorkbench-back {
  flex: none;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.dshWorkbench-back:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dshWorkbench-back:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
/* The view region takes focus when it opens, so a keyboard user is not stranded
   after the card they pressed unmounts. It is a region, not a control, so it
   draws no ring of its own. */
.dshWorkbench-page:focus {
  outline: none;
}
.dshWorkbench-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 20px;
}
/* The renderer wraps each renderSlot call in a display:contents anchor, so the
   grid's DIRECT children are those anchors and not the cards. An anchor
   generates no box, so a frame property set on it is dropped — measured on this
   line: the anchor carried the border and a 0x0 box while the card beside it
   carried none of it. The frame therefore lands on the anchor's children, keyed
   on the data-slot attribute the renderer puts there: that attribute is the
   renderer's own anchor marker (SlotOutlet), NOT a documented contract, and this
   is the only place in the repository that reads it, so a kernel line that
   renames it silently drops the frame. An entry that renders several roots is
   drawn as several boxes — the seat's owner props say one root per card. */
.dshWorkbench-grid > [data-slot] > *:not(.dshWorkbench-empty) {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshWorkbench-body {
  margin-top: 20px;
}
.dshWorkbench-empty {
  /* The fallback renders INSIDE the grid's anchor, so it is a grid item: without
     spanning every column it would sit in one 240px track. */
  grid-column: 1 / -1;
  margin: 0;
  padding: 22px 14px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}
`

/** Inject once per document (id-guarded, safe across re-mounts). */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.append(style)
}
