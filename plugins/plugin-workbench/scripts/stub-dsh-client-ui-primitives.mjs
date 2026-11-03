/**
 * Test-time stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * Why a stub instead of the real package. The primitives package is a BROWSER
 * bundle: it imports `clsx`, `*.module.css` files and dynamic `@shikijs/*`
 * chunks, none of which node can load and none of which esbuild can resolve from
 * this plugin's tree. The plugin's test harness bundles `tests/*.test.ts` with
 * esbuild and runs them under node, and `tests/client-entry.test.ts` imports
 * `src/client.ts` — which reaches the primitives package through the Creator row.
 * `scripts/test.mjs` therefore aliases the specifier to this file, the same
 * device `plugin-swarm` uses for `@deepseek-ai/dsh-session`.
 *
 * The BUILD path needs no stub: `buildClient` (`plugins/build-lib.mjs`
 * `externalFramework`) marks every `@deepseek-ai/*` specifier external, so
 * `lib/client.js` carries the import and the composed loader's module table
 * answers it at run time with the real package.
 *
 * Nothing here renders. The entries exist so the module graph loads and so the
 * assertions about the row can be identity comparisons (`element.type ===
 * MenuItemButton`) rather than name matching. An import this file does not
 * cover fails loudly at bundle time ("No matching export"), which is the
 * intended failure: add it here, do not drop the import.
 */

/**
 * The menu row the Creator row composes.
 * @returns nothing; no test renderer exists in this suite.
 */
export function MenuItemButton() {
  return null
}

/**
 * The plus the Creator row shows.
 * @returns nothing; no test renderer exists in this suite.
 */
export function IconPlusOutlineRegular() {
  return null
}
