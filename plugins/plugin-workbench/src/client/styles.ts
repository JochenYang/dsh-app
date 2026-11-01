/**
 * Styles for the workbench container page.
 *
 * Alias-token colors only, so both themes stay legible; the injection is
 * id-guarded and therefore idempotent across re-mounts. The class prefix
 * `dshWorkbench-` keeps the global CSS namespace collision-free.
 *
 * Decisions worth naming:
 *
 * - The top strip is the only thing that pads for the window's frame. On the
 *   Windows desktop the shell draws a native title bar over the page, and on
 *   macOS the traffic lights sit over it; `--dsh-frame-top-clearance` is the
 *   frame's published inset for exactly this, and the darwin-only rules below are
 *   how the kernel's own pages consume it. A page that padded unconditionally
 *   would carry a gap on platforms that have no strip.
 * - The back control is a single 28px link with a drawn chevron, not a bordered
 *   pill: it names the way out and nothing else, and the domain page below it
 *   carries its own title, so the container adds no second heading.
 * - The grid's child rule IS the card frame. A card is a component the domain
 *   registers, and the container cannot wrap a rendered slot's children one by
 *   one — so the frame is the container's own rule, which makes "one card per
 *   seat entry" the seat's visual contract rather than a convention every domain
 *   has to reproduce. It lands on `.dshWorkbench-grid > [data-slot] > *` and NOT
 *   on the grid's direct children: the renderer wraps each renderSlot call in a
 *   `display: contents` anchor, and a frame property set on an anchor is
 *   discarded, because the anchor generates no box at all.
 * - The card surface is a 3 percent tint of the label colour over the layer
 *   colour rather than the layer colour alone: in the light theme the base and
 *   the layer are both white, so an untinted card has no surface at all.
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
  padding: 0 clamp(20px, 4vw, 40px) 48px;
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
/* The shell injects a 36px window-drag strip over the top of the centre column
   whenever no session title bar is showing (src/main/window.ts, OVERLAY_HEIGHT).
   A control INSIDE that strip never receives a mouse event — the drag region
   consumes it — which is how the back link became inert while a scripted
   element.click() still worked, so no probe caught it. The bar therefore starts
   its control BELOW the strip: 36px of clearance, the 28px control, and a 4px gap
   before the page body. */
.dshWorkbench-viewBar {
  box-sizing: border-box;
  display: flex;
  align-items: flex-end;
  height: 72px;
  padding-bottom: 4px;
}
[data-platform='darwin'] .dshWorkbench-viewBar {
  height: calc(72px + var(--dsh-frame-top-clearance, 0px));
}
.dshWorkbench-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.dshWorkbench-back::before {
  content: '';
  flex: none;
  width: 6px;
  height: 6px;
  border-left: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
}
.dshWorkbench-back:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}
.dshWorkbench-back:active {
  background: var(--dsw-alias-interactive-bg-active);
}
.dshWorkbench-back:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
/* The view region takes focus when it opens, so a keyboard user is not stranded
   after the card they pressed unmounts. It is a region, not a control, so it
   draws no ring of its own. */
.dshWorkbench-page:focus {
  outline: none;
}
.dshWorkbench-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
  margin-top: 24px;
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
  min-width: 0;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);
  border-radius: var(--dsw-radius-lg);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, var(--dsw-alias-bg-layer-1));
  box-shadow: var(--dsw-shadow-lv1);
  transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
}
/* The frame is the card's only affordance at rest, so it answers the pointer:
   the border steps up and the surface lifts by one shadow step. Measured border
   contrast against the page: about 1.4:1 at rest on the light theme and 1.6:1 on
   the dark one, 1.8:1 and 2.3:1 under the pointer. The card is identified by its
   title and figures, so the border is the pressable cue rather than the only
   identifier. The lift is a transform, the one motion property the motion rules
   allow here. */
.dshWorkbench-grid > [data-slot] > *:not(.dshWorkbench-empty):hover {
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent);
  box-shadow: var(--dsw-shadow-lv2);
  transform: translateY(-1px);
}
.dshWorkbench-body {
  margin-top: 4px;
}
.dshWorkbench-empty {
  /* The fallback renders INSIDE the grid's anchor, so it is a grid item: without
     spanning every column it would sit in one track. */
  grid-column: 1 / -1;
  margin: 0;
  padding: 22px 16px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}
@media (prefers-reduced-motion: reduce) {
  .dshWorkbench-grid > [data-slot] > *:not(.dshWorkbench-empty),
  .dshWorkbench-grid > [data-slot] > *:not(.dshWorkbench-empty):hover {
    transition: none;
    transform: none;
  }
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
