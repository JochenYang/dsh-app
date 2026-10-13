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
 * darkest is 7.04:1. The dark ramp runs 5.42:1 to 7.62:1 on the dark cards.
 *
 * These stops are NOT defined here: `./value-color.ts` owns them and this sheet
 * interpolates them into the gradient below, because the level name and the
 * capsule's edge are the same ramp read at the current position (lifted to text
 * contrast where the ramp's own colour is too light to carry copy). One ramp,
 * three surfaces, one file — the alternative is three copies of eight hex values
 * that drift apart the first time a colour is adjusted.
 *
 * ## Why the fill is clipped rather than sized
 *
 * The fill layer spans the whole track and carries the full gradient; its
 * `clip-path` is what follows the knob. Sizing it instead would rescale the
 * gradient on every frame, so the colour under a fixed point would change as the
 * user drags — the bar would look like it was being repainted rather than
 * uncovered. See {@link ./geometry.fillClip}.
 *
 * ## The two moving parts
 *
 * The mosaic's tiles sweep, and at the top of the energy range they also drift
 * vertically. Both are driven by the component through the two variables the
 * stylesheet exposes for them: the tile's own animation (duration, delay, and the
 * `data-on` that pauses it) and the `data-drift` gate on the track.
 *
 * ## Reduced motion
 *
 * The mosaic is decoration with no information the fill does not already carry,
 * so `prefers-reduced-motion` removes it outright rather than parking a cluster
 * of squares at the fill's edge. The drift lives inside that layer, so it goes
 * with it — the bloom does not, and does not need to: it is a static highlight,
 * not motion.
 *
 * @module @dsh-app/plugin-effort/client/styles
 */

import { BLOOM_WIDTH, KNOB_SIZE, TRACK_HEIGHT } from './geometry.ts'
import { DRIFT_AMPLITUDE, DRIFT_MS } from './mosaic.ts'
import { FILL_RAMP_DARK, FILL_RAMP_LIGHT, fillGradient } from './value-color.ts'

/** Id of the injected stylesheet, so a second mount is a no-op. */
const STYLE_ID = 'dsh-app-plugin-effort-style'

const cssText = `
.dshAppEffort {
  box-sizing: border-box;
  /* The container lives inside the row's button, which the bridge makes wrap
     (flex-wrap); a width of 100% is what gives the track a line of its own
     instead of sharing the label's. */
  width: 100%;
  min-width: 0;
  /* The row is a flex box with a 6px gap, which is what separates the two lines
     once it wraps; this is the small amount of extra air above the track. */
  margin-top: 2px;
  /* The container is the React portal's root, so React's delegated listeners are
     attached to this very node and a click handler of ours here would race them
     (stopPropagation only takes effect at the NEXT node). Instead the container
     is removed from hit-testing: a pointer that lands on its own box — the
     corners the capsule's radius cuts off, the strip the note's margin occupies —
     passes through to the official row underneath, which is the row's own
     behaviour, and the track below takes its own area back. */
  pointer-events: none;
  /* Light theme: brand blue deepening toward indigo as effort rises. The stops
     live in value-color.ts, with the level name and the capsule ring. */
  --dshAppEffort-fill: ${fillGradient(FILL_RAMP_LIGHT)};
  --dshAppEffort-glow: rgb(75 63 214 / 42%);
  --dshAppEffort-ring: rgb(75 63 214 / 55%);
  /* The leading edge's bloom. WHITE in both themes, for the reason the startup
     page gives for its own: the edge is the one thing worth looking at, and on a
     saturated blue-to-indigo fill a second blue has nothing to say. The alphas
     differ because the fills do — measured as the step between the bloomed and
     the plain fill under it, light 26% is 1.40–1.77:1 and dark 34% is 1.31–1.44:1
     across the whole range. Below the light alpha the highlight disappears into
     the fill at the deep indigo end; above the dark one it goes to near-white and
     stops reading as a push. */
  --dshAppEffort-bloom: rgb(255 255 255 / 26%);
}
body[data-ds-dark-theme] .dshAppEffort {
  /* Dark theme: brand blue brightening toward a light violet. */
  --dshAppEffort-fill: ${fillGradient(FILL_RAMP_DARK)};
  --dshAppEffort-glow: rgb(185 166 255 / 50%);
  --dshAppEffort-ring: rgb(185 166 255 / 62%);
  --dshAppEffort-bloom: rgb(255 255 255 / 34%);
}

/* The anchor the bridge walks up from. It must stay in the DOM — an unmounted
   node cannot reach its composer card — but it has no box of its own. */
.dshAppEffortAnchor {
  display: none;
}

.dshAppEffort-track {
  position: relative;
  box-sizing: border-box;
  /* The container above is taken out of hit-testing; the track is the one part
     of it that belongs to the user. */
  pointer-events: auto;
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

/* The bloom at the fill's visible leading edge. It rides the SAME variable the
   knob's offset is written to, minus the radius the knob covers, so its bright end
   lands on the edge the eye actually sees; the ramp fades back into the fill over
   BLOOM_WIDTH. It is clipped to the fill like the layers beside it, which keeps the
   flat part of the gradient — everything to the right of its last stop — off the
   empty half of the track.

   It does not compete with the other two glows in this area: the track's own glow
   and the capsule's ring are box-shadows drawn OUTSIDE the track's border box, and
   the knob's ring is on the knob. This one is inside the fill, ending where the
   knob begins. */
.dshAppEffort-bloom {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    transparent calc(var(--dshAppEffort-head) - ${BLOOM_WIDTH}px),
    var(--dshAppEffort-bloom) var(--dshAppEffort-head)
  );
  /* The same 160ms the mosaic layer uses, because the two fade in together and
     read as one thing; without it the bloom would step at each level crossing
     while the tiles beside it glided. */
  transition: opacity 160ms ease;
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
/* A tile that is not part of the mosaic stays mounted and keeps its phase — it is
   its square that fades. Paused as well: fourteen invisible elements sweeping is
   fourteen elements' worth of compositing for nothing. */
.dshAppEffort-tile[data-on="0"] {
  animation-play-state: paused;
}
.dshAppEffort-square {
  position: absolute;
  left: 100%;
  top: 0;
  border-radius: 1px;
  background: #fff;
  transform: translate(-50%, -50%);
  /* The fade is the whole point of keeping the tile mounted: the square's opacity
     is its own tone while the tile is on and 0 while it is not, so it always comes
     to rest exactly on the tone it had. */
  transition: opacity 260ms ease;
}
body[data-ds-dark-theme] .dshAppEffort-square {
  background: #f2eeff;
}
@keyframes dshAppEffort-sweep {
  0% { transform: translate3d(0, 0, 0); }
  100% { transform: translate3d(-100%, 0, 0); }
}

/* The high-energy drift. Gated on the data-drift attribute, which is the TOP of
   the energy range — not the same threshold as data-energy, which only says the
   mosaic is on at all. It is gated on the lit tiles too, so an unlit one is not
   drifting invisibly. The keyframe carries the centring transform as well: a
   keyframe replaces the element's transform outright, so a drift that only wrote
   the vertical offset would slide every square half a tile up and left. */
@keyframes dshAppEffort-drift {
  0%, 100% { transform: translate(-50%, -50%) translateY(${-DRIFT_AMPLITUDE}px); }
  50% { transform: translate(-50%, -50%) translateY(${DRIFT_AMPLITUDE}px); }
}
.dshAppEffort-track[data-drift="1"] .dshAppEffort-tile[data-on="1"] .dshAppEffort-square {
  animation-name: dshAppEffort-drift;
  animation-duration: ${DRIFT_MS}ms;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
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
