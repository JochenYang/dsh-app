/**
 * DSH APP effort slider — host half.
 *
 * Empty by design. The whole surface is the browser half: a draggable
 * reasoning-effort track injected into the official model menu's effort row.
 * The loader row exists so the client-modules scan sees this package's
 * `dsh.client` declaration and serves `lib/client.js` — the same shape
 * `@deepseek-ai/dsh-client-ui-model-selection` uses for its own pure UI plugin.
 *
 * @module @dsh-app/plugin-effort
 */

/** Host plugin body — no host-side behaviour for this surface plugin. */
export function apply(): void {}
