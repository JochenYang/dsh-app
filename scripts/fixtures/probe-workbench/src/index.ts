/**
 * Workbench probe fixture — host half.
 *
 * Empty by design (the `plugin-effort` shape): the whole surface is the browser
 * half, and the loader row exists so the client-modules scan sees this
 * package's `dsh.client` declaration and serves `lib/client.js`.
 *
 * Built and linked by `scripts/probe-workbench.cjs`; nothing else reads it.
 *
 * @module @dsh-app/probe-workbench
 */

/** Host plugin body — the probe has no host-side behaviour. */
export function apply(): void {}
