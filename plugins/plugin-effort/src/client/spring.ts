/**
 * The two springs the track moves on.
 *
 * A level change is a step function — the position jumps by one node of the scale
 * — and a step function on screen reads as a jump cut: the knob teleports, the
 * fill's clip snaps to the new width, and nothing in between is ever drawn. The
 * whole of the motion work in this plugin is turning that step into a continuous
 * displacement, and a spring is what does it: it chases the target with velocity,
 * overshoots slightly, and settles, so one crossing reads as one movement rather
 * than as two still frames.
 *
 * Two springs, deliberately not one:
 *
 *   - {@link POSITION_SPRING} is stiff (κ 420) and heavily damped (32), because it
 *     drives a POINTER. A soft spring behind a drag feels broken: the knob would
 *     trail the finger by tens of pixels. The measured curve settles in about
 *     150ms, which is fast enough to feel attached and slow enough to read as
 *     movement.
 *   - {@link GALAXY_SPRING} is loose (κ 190, damping 25), because it drives an
 *     ATMOSPHERE. The top level's star density, fill fade and knob glow arrive over
 *     ~400ms and leave the same way; a stiff spring on the same values would make
 *     the atmosphere snap like a switch, which is the reading we are removing.
 *
 * Integration is semi-implicit Euler in {@link SPRING_SUBSTEPS} equal sub-steps.
 * One step per frame is the obvious version and it is unstable at the frame times
 * that actually occur (a 32ms hitch after a layout pass makes `κ·dt` large enough
 * to ring), so the frame is divided instead. The result is stable for any `dt`
 * this file admits, which is why {@link MAX_STEP_SECONDS} also clamps the input.
 *
 * @module @dsh-app/plugin-effort/client/spring
 */

/** A value and the velocity carrying it, in the value's own units per second. */
export interface SpringState {
  /** Current value. May overshoot the target; the caller clamps at read time. */
  value: number
  /** Current velocity, value units per second. */
  velocity: number
}

/** A spring's constants. */
export interface SpringConfig {
  /** κ: how hard it pulls toward the target. Larger is faster and bouncier. */
  readonly stiffness: number
  /** Damping: how much velocity is bled off per unit of displacement. */
  readonly damping: number
}

/** The knob, the fill's clip and the bloom's edge: stiff, so the pointer feels attached. */
export const POSITION_SPRING: SpringConfig = { stiffness: 420, damping: 32 }

/** The top level's atmosphere: loose, so it arrives and leaves as a swell. */
export const GALAXY_SPRING: SpringConfig = { stiffness: 190, damping: 25 }

/** Sub-steps per frame; see the module header for why one is not enough. */
export const SPRING_SUBSTEPS = 3

/**
 * The longest frame the integrator accepts, in seconds.
 *
 * A hidden tab or a long layout stall produces a frame of hundreds of
 * milliseconds; integrating that in one go is the case that rings. Clamping
 * instead means the spring moves a normal frame's worth and the rest of the stall
 * is simply lost, which nobody can see.
 */
export const MAX_STEP_SECONDS = 0.032

/** Distance below which a spring is considered to have arrived. */
export const REST_DISTANCE = 0.0002

/** Speed below which a spring is considered to have arrived. */
export const REST_SPEED = 0.002

/**
 * A spring resting on a value.
 * @param value - where it starts.
 * @returns the state.
 */
export function createSpring(value = 0): SpringState {
  return { value, velocity: 0 }
}

/**
 * One frame of integration.
 *
 * @param state - mutated in place.
 * @param target - where the spring is heading.
 * @param seconds - the frame's duration; clamped to {@link MAX_STEP_SECONDS}.
 * @param config - the spring's constants.
 * @returns true while it is still moving; false once it has snapped onto the target.
 */
export function advanceSpring(
  state: SpringState,
  target: number,
  seconds: number,
  config: SpringConfig,
): boolean {
  const dt = Math.min(MAX_STEP_SECONDS, Math.max(0, seconds)) / SPRING_SUBSTEPS
  for (let step = 0; step < SPRING_SUBSTEPS; step += 1) {
    state.velocity += ((target - state.value) * config.stiffness - state.velocity * config.damping) * dt
    state.value += state.velocity * dt
  }
  // Snapping at the end is not cosmetic: an exponential approach never actually
  // arrives, so without it every spring keeps a rAF loop alive for the lifetime of
  // the control.
  if (Math.abs(state.value - target) < REST_DISTANCE && Math.abs(state.velocity) < REST_SPEED) {
    state.value = target
    state.velocity = 0
    return false
  }
  return true
}
