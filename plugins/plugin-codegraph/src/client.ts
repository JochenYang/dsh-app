/**
 * DSH APP code graph — browser half.
 *
 * The settings section (language packs, per-project index status) lands here in
 * phase 5 of `docs/plans/plugin-codegraph.md`. The module exists from phase 1 so
 * the build recipe and the `dsh.client` declaration stay wired while the host
 * half is developed.
 *
 * @module @dsh-app/plugin-codegraph/client
 */

/** The client half's entry point; the settings registration arrives in W10. */
export function apply(): void {
  // Phase 5 registers the settings section through ctx.slots.
}
