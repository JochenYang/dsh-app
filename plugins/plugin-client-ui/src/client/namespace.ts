/**
 * Locale namespace owned by this plugin's client half.
 *
 * One namespace per plugin: a namespace has exactly one owner, and every
 * surface of this plugin writes into this one. Three page dictionaries feed it
 * today (`maintenance/locales.ts`, `diagnostics/locales.ts`,
 * `models-advanced/locales.ts`) and the client entry registers them as one
 * pair; the key domain is split by page prefix (`maint.` / `diag.` / `adv.`)
 * so two pages never collide. The namespace lives here rather than in a page
 * module because the pages are peers, not relatives.
 *
 * @module @dsh-app/plugin-client-ui/client/namespace
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.client-ui'
