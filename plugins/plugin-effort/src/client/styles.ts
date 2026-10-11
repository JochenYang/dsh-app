/**
 * The slider's stylesheet.
 *
 * ## Colours
 *
 * Two ramps, one per theme, both anchored on the DeepSeek brand blue that
 * `--dsw-alias-state-business-primary` resolves to in that theme
 * (`--dsw-static-deepseek-500` in light, `--dsw-static-deepseek-400` in dark).
 * They run in OPPOSITE directions on purpose:
 *
 *   - light: the ramp darkens as effort rises (#5686FE → #4B3FD6), because
 *     "stronger" has to survive a white card;
 *   - dark: the ramp brightens (#7AAAFF → #B9A6FF), because the same values would
 *     sink into #292929.
 *
 * Measured contrast (WCAG 2.x, relative luminance): the light ramp's lightest
 * stop is 3.37:1 on white — above the 3:1 floor for a graphical object — and its
 * darkest is 7.04:1. The dark ramp runs 6.25:1 to 6.90:1 on #292929. The text
 * tones are the ones that carry copy, so they clear the 4.5:1 body threshold:
 * #3A5BD9 is 5.71:1 on white and 5.24:1 on #F5F5F5; #9DBBFF is 7.61:1 on
 * #292929 and 8.41:1 on #212123.
 *
 * ## Why the fill is clipped rather than sized
 *
 * The fill layer spans the whole track and carries the full gradient; its
 * `clip-path` is what follows the knob. Sizing it instead would rescale the
 * gradient on every frame, so the colour under a fixed point would change as the
 * user drags — the bar would look like it was being repainted rather than
 * uncovered. See {@link ./geometry.fillClip}.
 *
 * ## Reduced motion
 *
 * The mosaic is decoration with no information the fill does not already carry,
 * so `prefers-reduced-motion` removes it outright rather than parking a cluster
 * of squares at the fill's edge.
 *
 * @module @dsh-app/plugin-effort/client/styles
 */

import { KNOB_SIZE, TRACK_HEIGHT } from './geometry.ts'

/** Id of the injected stylesheet, so a second mount is a no-op. */
const STYLE_ID = 'dsh-app-plugin-effort-style'

const cssText = `
.dshAppEffort {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  /* Light theme: brand blue deepening toward indigo as effort rises. */
  --dshAppEffort-fill: linear-gradient(90deg, #5686FE 0%, #4176E6 42%, #3A5BD9 72%, #4B3FD6 100%);
  --dshAppEffort-glow: rgb(75 63 214 / 42%);
  --dshAppEffort-ring: rgb(75 63 214 / 55%);
}
body[data-ds-dark-theme] .dshAppEffort {
  /* Dark theme: brand blue brightening toward a light violet. */
  --dshAppEffort-fill: linear-gradient(90deg, #7AAAFF 0%, #8FB0FF 45%, #A98BFF 78%, #B9A6FF 100%);
  --dshAppEffort-glow: rgb(185 166 255 / 50%);
  --dshAppEffort-ring: rgb(185 166 255 / 62%);
}

/* The anchor the bridge walks up from. It must stay in the DOM — an unmounted
   node cannot reach its composer card — but it has no box of its own. */
.dshAppEffortAnchor {
  display: none;
}

.dshAppEffort-track {
  position: relative;
  box-sizing: border-box;
  height: ${TRACK_HEIGHT}px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l1, rgb(15 17 21 / 8%));
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  transition: box-shadow 160ms ease;
}
.dshAppEffort-track[data-mode="static"],
.dshAppEffort-track[data-mode="single"] {
  cursor: default;
}
.dshAppEffort-track:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dshAppEffort-track[data-energy="1"] {
  box-shadow: 0 0 calc(var(--dshAppEffort-energy, 0) * 12px) var(--dshAppEffort-glow);
}

.dshAppEffort-fill {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--dshAppEffort-fill);
  pointer-events: none;
}
.dshAppEffort-mosaic {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  overflow: hidden;
  pointer-events: none;
  transition: opacity 160ms ease;
}
.dshAppEffort-tile {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  animation-name: dshAppEffort-sweep;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
.dshAppEffort-square {
  position: absolute;
  left: 100%;
  top: 0;
  border-radius: 1px;
  background: #fff;
  transform: translate(-50%, -50%);
}
body[data-ds-dark-theme] .dshAppEffort-square {
  background: #f2eeff;
}
@keyframes dshAppEffort-sweep {
  0% { transform: translate3d(0, 0, 0); }
  100% { transform: translate3d(-100%, 0, 0); }
}

.dshAppEffort-tick {
  position: absolute;
  top: 50%;
  width: 3px;
  height: 3px;
  margin: -1.5px 0 0 -1.5px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 26%, transparent);
  pointer-events: none;
}
.dshAppEffort-tick[data-on="1"] {
  background: rgb(255 255 255 / 55%);
}

.dshAppEffort-knob {
  position: absolute;
  top: 50%;
  width: ${KNOB_SIZE}px;
  height: ${KNOB_SIZE}px;
  margin: ${-KNOB_SIZE / 2}px 0 0 ${-KNOB_SIZE / 2}px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 5px rgb(0 0 0 / 34%), 0 0 0 0.5px rgb(0 0 0 / 6%);
  pointer-events: none;
  transition: box-shadow 160ms ease;
}
.dshAppEffort-track[data-energy="1"] .dshAppEffort-knob {
  box-shadow: 0 1px 5px rgb(0 0 0 / 34%), 0 0 0 2px var(--dshAppEffort-ring);
}
.dshAppEffort-track[data-dragging="1"] .dshAppEffort-knob {
  transition: none;
}

.dshAppEffort-note {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-caption);
}
.dshAppEffort-note[data-tone="error"] {
  color: var(--dsw-alias-state-error-primary);
}

@media (prefers-reduced-motion: reduce) {
  .dshAppEffort-mosaic { display: none; }
  .dshAppEffort-track,
  .dshAppEffort-knob,
  .dshAppEffort-mosaic { transition: none; }
}
`

/**
 * Inject the stylesheet once per document.
 *
 * Id-guarded rather than reference-counted: the sheet is static and identical
 * for every mount, so the first mount owns it and later mounts reuse it. It is
 * deliberately NOT removed on unmount — another composer may still be mounted,
 * and a sheet that disappears with one of them would restyle the other.
 */
export function adoptStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.append(style)
}
