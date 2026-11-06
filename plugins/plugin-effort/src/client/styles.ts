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
 * ## The composer capsule's level text
 *
 * One rule in this sheet is about the kernel's DOM rather than the slider's: the
 * level's name is rendered in the composer too (`… Max` beside the model name), and
 * that text is styled from the same level colour the menu capsule carries — see
 * {@link EFFORT_TEXT_ATTRIBUTE} for what the mark buys and why the colour itself is
 * a write rather than a rule.
 *
 * ## One box, whatever the state
 *
 * The injected control must keep the SAME box in every shape, because the official
 * menu is placed from its own height and re-laid out from its own content: a line
 * that comes and goes moves the card, and a card that moves re-measures the track
 * under the pointer. So the note line is always mounted with a height floor
 * ({@link NOTE_LINE_HEIGHT}), and the container is taken out of its own inline
 * intrinsic size (`contain: inline-size`) so its text can never decide the card's
 * width. Both rules are load-bearing rather than cosmetic — with either one gone the
 * card jumps by 20px vertically and 86px horizontally on the first drag, measured on
 * the real app.
 *
 * ## Why the fill is clipped rather than sized
 *
 * The fill layer spans the whole track and carries the full gradient; its
 * `clip-path` is what follows the knob. Sizing it instead would rescale the
 * gradient on every frame, so the colour under a fixed point would change as the
 * user drags — the bar would look like it was being repainted rather than
 * uncovered. See {@link ./geometry.fillClip}.
 *
 * ## Where the position comes from
 *
 * Not from this file's callers. A level change is a step, and the three
 * expressions that place things on the track — the knob's `left`, the fill's clip,
 * the bloom's edge — read {@link PCT_VAR} instead of a literal, because
 * `./motion` writes that property every frame from a spring. The React layer
 * writes nothing positional at all: a render carries the level's identity, and the
 * position is a continuous value no render can represent.
 *
 * ## The field
 *
 * The texture over the whole bar — the starfield in `./starfield` — is a canvas
 * inside a rounded, clipped wrapper, so it is drawn at every level and never
 * leaves the capsule. It reads {@link ENERGY_VAR} and {@link GALAXY_VAR} only
 * through `./motion`, which is also what paints it; nothing about it is expressible
 * in CSS, so this sheet only states the layer and its clip.
 *
 * ## Reduced motion
 *
 * The field is decoration, but it is not motion: a reduced-motion reader gets the
 * same sky at a frozen instant — one painted frame, no loop, no springs (see
 * `./motion`). The transitions this sheet declares are the ones that survive that
 * decision, and they are switched off here too.
 *
 * @module @dsh-app/plugin-effort/client/styles
 */

import {
  BLOOM_WIDTH,
  ENERGY_VAR,
  GALAXY_VAR,
  KNOB_SIZE,
  NOTE_LINE_HEIGHT,
  NOTE_MARGIN_TOP,
  PCT_VAR,
  TICK_HOVER_SCALE,
  TICK_SIZE,
  TRACK_HEIGHT,
  fillClip,
  headEdgeExpr,
  offsetExpr,
} from './geometry.ts'
import { FILL_RAMP_DARK, FILL_RAMP_LIGHT, fillGradient } from './value-color.ts'

/** Id of the injected stylesheet, so a second mount is a no-op. */
const STYLE_ID = 'dsh-app-plugin-effort-style'

/**
 * The animated position, as it appears inside a CSS expression: the custom property
 * `./motion` writes, with the left end as its fallback for a frame before the loop
 * has run (or for a control the loop never started in).
 */
const PCT_TOKEN = `var(${PCT_VAR}, 0)`

/**
 * The attribute this plugin marks the COMPOSER capsule's level text with, and the
 * weight that text carries while marked.
 *
 * The attribute is the couple between the two halves of this feature: the bridge
 * writes it (with the level id as its value) onto the kernel's own effort span, and
 * this stylesheet is what the mark means. Naming it here keeps the rule and the
 * write from drifting apart; the value is the level the colour was taken from, so
 * the DOM says which level `color` belongs to.
 *
 * The COLOUR is not in this sheet. It is one value per level, computed from the
 * ramp at the position in use (`value-color.ts`), and a stylesheet cannot
 * enumerate levels a provider owns — the same reason the menu row's value cell is
 * coloured by a write rather than by a rule.
 */
export const EFFORT_TEXT_ATTRIBUTE = 'data-dshAppEffort'

/** The `font-weight` the marked text takes. Heavier than the trigger's own 400. */
export const EFFORT_TEXT_WEIGHT = '600'

const cssText = `
.dshAppEffort {
  box-sizing: border-box;
  /* The container lives inside the row's button, which the bridge makes wrap
     (flex-wrap); a width of 100% is what gives the track a line of its own
     instead of sharing the label's. */
  width: 100%;
  min-width: 0;
  /* The note line must not decide how wide the card is.
     The official menu is width: max-content, so anything inside it that has a
     max-content width of its own pushes the card — and the track, which is 100%
     of this container — wider. The note is the only child here with text, so its
     sentence was the card's width: a 17-character caption made the card 334px and
     the same card without the line 248px, which is a 86px jump of the track under
     the pointer the moment a drag turned "following the default" into a level.
     Inline-size containment takes the node's contents out of its own inline
     intrinsic size, so the card is the same width in every shape while the note
     still lays out and wraps at the width it actually gets. */
  contain: inline-size;
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
  /* The top level's outer halo, on the knob. The end of this theme's own ramp, at
     an alpha that reads as light on the knob's rim rather than as a glow cloud
     around it — the bar behind it is at full strength now, so it does not need the
     extra reach it had when the fill receded. */
  --dshAppEffort-halo: rgb(75 63 214 / 40%);
}
body[data-ds-dark-theme] .dshAppEffort {
  /* Dark theme: brand blue brightening toward a light violet. */
  --dshAppEffort-fill: ${fillGradient(FILL_RAMP_DARK)};
  --dshAppEffort-glow: rgb(185 166 255 / 50%);
  --dshAppEffort-ring: rgb(185 166 255 / 62%);
  --dshAppEffort-bloom: rgb(255 255 255 / 34%);
  --dshAppEffort-halo: rgb(185 166 255 / 50%);
}

/* The anchor the bridge walks up from. It must stay in the DOM — an unmounted
   node cannot reach its composer card — but it has no box of its own. */
.dshAppEffortAnchor {
  display: none;
}

/* The composer capsule's own level text — the "… Max" the kernel renders beside
   the model name — which this plugin STYLES and nothing else: no copy is added or
   rewritten, and no property that decides the box is set, so the capsule's layout
   is the kernel's. The weight is what the mark itself buys, and a declaration on
   the element always beats the 400 it would inherit from the trigger, so this rule
   does not depend on where in the head it lands. The COLOUR is written by the
   bridge on the same element: it is one value per level, taken from the ramp. */
[${EFFORT_TEXT_ATTRIBUTE}] {
  font-weight: ${EFFORT_TEXT_WEIGHT};
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
  /* The glow grows with the position, which the animation writes. Not
     transitioned: its radius is a variable that is already being eased every
     frame, and a transition on top of that would chase a moving target. */
  box-shadow: 0 0 calc(var(${ENERGY_VAR}, 0) * 12px) var(--dshAppEffort-glow);
}
.dshAppEffort-track[data-mode="static"],
.dshAppEffort-track[data-mode="single"] {
  cursor: default;
}
.dshAppEffort-track:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}

.dshAppEffort-fill {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--dshAppEffort-fill);
  /* The clip reads the animated position; see the header. */
  clip-path: ${fillClip(PCT_TOKEN)};
  pointer-events: none;
  /* The top level DEEPENS the bar rather than fading it.
     The reference fades its fill out completely, and that is right there: its
     track sits on near-black, so what shows through is a dark bar with coloured
     pixels in it. Here the card behind the track is white in the light theme, so
     the same fade mixes the gradient toward the CARD — the bar goes pale, and the
     top level reads as washed out instead of as the richest one. Keeping nearly
     all of the gradient and letting the field sit on top of it is the same idea
     translated to a surface that is not dark. */
  opacity: calc(1 - 0.12 * var(${GALAXY_VAR}, 0));
}

/* The starfield. A canvas inside a capsule-shaped clip, drawn by motion.ts:
   at every level (faintly at the bottom — see starfield.ts), pushed into a
   burst at the top one. It sits above the fill so a dense field is not tinted by
   the gradient under it, and below the bloom so the leading edge stays the
   brightest thing in the row. */
.dshAppEffort-field {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  overflow: hidden;
  pointer-events: none;
}
.dshAppEffort-field canvas {
  display: block;
  width: 100%;
  height: 100%;
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
  /* Derived here rather than written by the component: the animation owns the
     position, and a value written from two places is a value that disagrees with
     itself for one frame per level change. */
  --dshAppEffort-head: ${headEdgeExpr(PCT_TOKEN)};
  background: linear-gradient(
    90deg,
    transparent calc(var(--dshAppEffort-head) - ${BLOOM_WIDTH}px),
    var(--dshAppEffort-bloom) var(--dshAppEffort-head)
  );
  clip-path: ${fillClip(PCT_TOKEN)};
  /* The energy the position carries, so the edge highlight arrives with the field
     rather than on a level boundary — and it RETREATS at the top level. The bloom
     is a white ramp sitting exactly where the knob is about to be, so keeping it at
     full opacity under an enlarged knob is a third white source in the same 30px;
     the top level's edge light is the knob's own halo instead. */
  opacity: calc(min(1, var(${ENERGY_VAR}, 0) * 3) * (1 - 0.7 * var(${GALAXY_VAR}, 0)));
}

.dshAppEffort-tick {
  position: absolute;
  top: 50%;
  width: ${TICK_SIZE}px;
  height: ${TICK_SIZE}px;
  margin: ${-TICK_SIZE / 2}px 0 0 ${-TICK_SIZE / 2}px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 26%, transparent);
  pointer-events: none;
  /* Scale rather than width/height, for two real reasons: a transform is
     composited (no layout pass per pointer sample), and it grows about the tick's
     own CENTRE — the absolutely-positioned box has a fixed offset and a negative
     margin, so a size change would keep the top-left corner and shift the circle by
     half the growth. The neighbours would not move either way (every tick is
     absolutely positioned), but the mark would sit off its level.
     The transition names the transform ALONE so a level change — a background swap
     on the ticks at or below the value — stays instant: the colour reports state,
     the size reports the pointer. */
  transform: scale(1);
  transition: transform 120ms cubic-bezier(0.2, 0, 0.2, 1);
}
.dshAppEffort-tick[data-on="1"] {
  background: rgb(255 255 255 / 55%);
}
/* The level a click would select. It grows rather than changing colour: colour on
   this track already means "at or below the current level", and a hover that
   recoloured a tick would read as a value change. */
.dshAppEffort-tick[data-hover="1"] {
  transform: scale(${TICK_HOVER_SCALE});
  background: var(--dsw-alias-label-primary, #0f1115);
}
.dshAppEffort-tick[data-hover="1"][data-on="1"] {
  background: rgb(255 255 255 / 92%);
}

.dshAppEffort-knob {
  position: absolute;
  top: 50%;
  /* The position, from the animation's own variable. Nothing positional is
     written by a render: a level change is a step and this is a spring. */
  left: ${offsetExpr(PCT_TOKEN)};
  width: ${KNOB_SIZE}px;
  height: ${KNOB_SIZE}px;
  margin: ${-KNOB_SIZE / 2}px 0 0 ${-KNOB_SIZE / 2}px;
  border-radius: 50%;
  background: #fff;
  /* Three shadows for two facts. The ring's width is the mid-band energy — the
     same signal the track's own glow carries — and the halo's radius is the top
     level's swell, so the atmosphere is a thing the knob DOES rather than a class
     the component toggles. Both are scaled from a variable that is being eased
     every frame, so neither is transitioned.

     The halo is a tight 12px, not the 20px a first cut had: the knob is already a
     white disc on a coloured bar, and a wide soft glow around it reads as one white
     blob with the bar's end erased, which on a light card is exactly the "washed
     out" the fill no longer causes. */
  box-shadow:
    0 1px 5px rgb(0 0 0 / 34%),
    0 0 0 calc(2px * var(${ENERGY_VAR}, 0)) var(--dshAppEffort-ring),
    0 0 calc(var(${GALAXY_VAR}, 0) * 12px) var(--dshAppEffort-halo);
  pointer-events: none;
  will-change: transform;
  /* A 15% swell: enough that the knob is visibly the event's centre, small enough
     that it stays inside the track's own height instead of becoming a ball the bar
     hangs off. */
  transform: scale(calc(1 + 0.15 * var(${GALAXY_VAR}, 0)));
}
/* The one line under the track: the sentence the current state needs, and — when
   it needs none — the empty box of that line. The line is ALWAYS mounted, and its
   box is what keeps the container the same height in every shape: the official
   menu is placed from its own height, so a line that comes and goes moves the card
   by its own 20px every time a drag turns "following the default" into a level. An
   empty <p> collapses to 0, which is why the floor is declared rather than left to
   the line-height. */
.dshAppEffort-note {
  margin: ${NOTE_MARGIN_TOP}px 0 0;
  font-size: 11px;
  line-height: ${NOTE_LINE_HEIGHT}px;
  min-height: ${NOTE_LINE_HEIGHT}px;
  color: var(--dsw-alias-label-caption);
}
.dshAppEffort-note[data-tone="error"] {
  color: var(--dsw-alias-state-error-primary);
}

@media (prefers-reduced-motion: reduce) {
  /* The field is NOT hidden: a reduced-motion reader gets the same sky at a
     frozen instant (see motion.ts), because the texture is information about how
     much of the scale is in play, not an animation. What goes is everything that
     moves between frames — the springs are already skipped in the loop, and the
     transitions declared above are what is left. */
  .dshAppEffort-track,
  .dshAppEffort-knob,
  .dshAppEffort-tick { transition: none; }
  .dshAppEffort-knob { will-change: auto; }
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
