/**
 * Dictionary of the Excel suite's client half, in the plugin's own locale
 * namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the
 * keys. One namespace per plugin, because a namespace has exactly one owner.
 * Keys carry the `capsule.` surface prefix, the same one the other office
 * formats use, so a language-switch diff across the suite lines up.
 *
 * zh is the source of truth and stays byte-identical to the pre-i18n copy;
 * {@link SheetKey} is its key union, and the English dictionary is typed with
 * it, so a missing or extra key on either side is a compile error.
 *
 * The capsule does not occupy a seat (the office bar is the suite's own
 * DOM-injected row), so the framework's `t` seat never arrives as a prop: the
 * capsule binds this namespace itself from the runtime the client entry hands
 * down (see client/locale-seat). Every value is read through that binding at
 * render time, so a language switch follows without a remount.
 *
 * @module @dsh-app/plugin-sheet/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.sheet'

/** Simplified Chinese dictionary — the pre-i18n copy, verbatim. */
export const zh = {
  'capsule.label': 'Excel',
  'capsule.hintOff': '点击开启表格模式',
  'capsule.hintOffPending': '点击开启表格模式，将在会话开始后生效',
  'capsule.hintOn': '点击关闭表格模式',
  'capsule.pendingNotice': '将在会话开始后生效',
  'capsule.skillHint': '已开启 {label} 模式；技能引用未能放入输入框，可手动输入 {token}',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<SheetKey, string> = {
  'capsule.label': 'Excel',
  'capsule.hintOff': 'Click to turn spreadsheet mode on',
  'capsule.hintOffPending': 'Click to turn spreadsheet mode on; it applies once the session starts',
  'capsule.hintOn': 'Click to turn spreadsheet mode off',
  'capsule.pendingNotice': 'Applies once the session starts',
  'capsule.skillHint': '{label} mode is on, but the skill reference could not be placed in the input box; type {token} manually',
}

/** Key domain of the `dsh-app.sheet` namespace (zh is the source of truth). */
export type SheetKey = keyof typeof zh
