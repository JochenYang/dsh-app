/**
 * Which of a fixed set of strings to show for this run.
 *
 * The splash's wish line is one of several, chosen at random ONCE per app
 * start. This module holds only the choice, so it can be exercised without
 * Electron and without a real random source: `random` is a parameter, and the
 * caller decides when it is called (see `SPLASH_SAYING_KEY` in
 * src/main/startup-window.ts, a module-level constant — the splash is pushed
 * several times a second while the kernel boots, and a choice made per push
 * would make the line jump between two wishes).
 */

/**
 * Pick one entry from `keys`, uniformly.
 *
 * @param keys - the strings to choose from. An empty list has nothing to pick:
 *   the answer is `undefined`, and the caller decides whether that means "no
 *   line" or "keep the fallback".
 * @param random - the source of randomness, in `[0, 1)`. Injected so a test can
 *   pin both ends of the range instead of relying on a real draw.
 * @returns the chosen entry, or `undefined` for an empty list.
 */
export function pickSaying<T>(keys: readonly T[], random: () => number = Math.random): T | undefined {
  if (keys.length === 0) return undefined
  const draw = random()
  // Clamped rather than trusted: a source that answers exactly 1 (or a value
  // outside the range, or a non-finite one) must still name an entry of `keys`
  // instead of reading past the end and answering undefined for a non-empty
  // list. A non-finite draw lands on the first entry.
  const index = Math.min(keys.length - 1, Math.max(0, Math.floor(Number.isFinite(draw) ? draw * keys.length : 0)))
  return keys[index]
}
