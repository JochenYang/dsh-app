/**
 * Dictionary of the 维护 settings page — the container that holds the usage,
 * preset-package and diagnostics pages as three tabs.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the
 * keys, which carry the `maint.` prefix so the three page dictionaries of this
 * namespace never collide.
 *
 * zh is the source of truth; {@link MaintenanceKey} is its key union, and the
 * English dictionary is typed with it, so a missing or extra key on either
 * side is a compile error. The same union constrains the container's `t` seat
 * (`TranslateNS`), so a key removed from the dictionary cannot be rendered.
 *
 * @module @dsh-app/plugin-client-ui/client/maintenance/locales
 */

/** Locale namespace owned by this plugin's client half (shared by every page dictionary). */
export { NS } from '../namespace.ts'

/** Simplified Chinese dictionary. */
export const zh = {
  // The rail row and the page heading: one key, two seats — the same shape the
  // usage page already uses for its own title/label.
  //
  // Four characters, matching the 通用设置 family it belongs to (通用设置 /
  // 维护设置): the row read as a bare 维护 next to 模型高级设置 and 并行子代理,
  // and "维护设置" says both what it is and that it is a settings page. The
  // English side keeps `Maintenance` — no English word improves on it.
  'maint.nav': '维护设置',
  // Accessible name of the tab strip; the pages inside draw their own tablists
  // (the usage page's day range), so this name must not read like theirs.
  'maint.tabs': '维护视图',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<MaintenanceKey, string> = {
  'maint.nav': 'Maintenance',
  'maint.tabs': 'Maintenance views',
}

/** Key domain of this page's entries in the `dsh-app.client-ui` namespace. */
export type MaintenanceKey = keyof typeof zh
