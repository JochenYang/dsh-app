/**
 * Dictionary of the Word capsule, in the plugin's own locale namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the keys.
 * One namespace per plugin, because a namespace has exactly one owner, and the
 * capsule is this plugin's whole client surface.
 *
 * zh is the source of truth and stays byte-identical to the pre-i18n capsule
 * copy; {@link DocKey} is its key union and the English dictionary is typed with
 * it, so a missing or extra key on either side is a compile error. The capsule's
 * `t` seat (see client/locale-seat) is bound to the same union, so a key removed
 * from the dictionary cannot be rendered.
 *
 * @module @dsh-app/plugin-doc/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.doc'

/** Simplified Chinese dictionary — the pre-i18n capsule copy, verbatim. */
export const zh = {
  'capsule.label': 'Word',
  'capsule.hintOn': 'Word 模式已开启；点击关闭',
  'capsule.hintOffPending': '点击开启 Word 模式，将在会话开始时应用',
  'capsule.hintOff': '点击开启 Word 模式',
  'capsule.pendingNotice': '将在会话开始后生效',
  'capsule.skillHint': '已开启 {label} 模式；技能引用未能放入输入框，可手动输入 {token}',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<DocKey, string> = {
  'capsule.label': 'Word',
  'capsule.hintOn': 'Word mode is on; click to turn it off',
  'capsule.hintOffPending': 'Click to turn on Word mode; it applies when the session starts',
  'capsule.hintOff': 'Click to turn on Word mode',
  'capsule.pendingNotice': 'Applies when the session starts',
  'capsule.skillHint': '{label} mode is on, but the skill reference could not be placed in the input box; type {token} manually',
}

/** Key domain of the `dsh-app.doc` namespace (zh is the source of truth). */
export type DocKey = keyof typeof zh
