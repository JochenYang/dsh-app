/**
 * DSH APP workbench hub — host half.
 *
 * Empty by design. The whole surface is the browser half: the sidebar entry and
 * the container page, plus the extension slots a domain registers into. The
 * loader row exists so the client-modules scan sees this package's `dsh.client`
 * declaration and serves `lib/client.js` — the same shape
 * `@dsh-app/plugin-effort` uses for its own pure UI plugin.
 *
 * @module @dsh-app/plugin-workbench
 */

/** Host plugin body — no host-side behaviour for this surface plugin. */
export function apply(): void {}
