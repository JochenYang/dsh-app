/**
 * Dictionary of the workbench hub, in this plugin's own locale namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the keys.
 * One namespace per plugin, because a namespace has exactly one owner, and keys
 * carry a page prefix (`workbench.`) so a later part of this plugin never
 * collides with this one.
 *
 * zh is the source of truth; {@link WorkbenchKey} is its key union, and the
 * English dictionary is typed with it, so a missing or extra key on either side
 * is a compile error.
 *
 * The sidebar row's LABEL is resolved from `workbench.nav`, and that resolved
 * text is also the row's accessible name — the only stable way to locate the row
 * in a probe, because this kernel line renders no `data-slot` attribute on it
 * (measured: `nav[aria-label="全局面板"] > button[aria-label=<label>]`). So the
 * value is a stable interface, not copy to reword freely: a probe assertion and
 * the screen-reader name both ride it, and the collapsed rail keeps the same
 * `aria-label` while its visible text is not rendered at all.
 *
 * @module @dsh-app/plugin-workbench/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.workbench'

/** Simplified Chinese dictionary — the source of truth for this plugin. */
export const zh = {
  'workbench.nav': '工作台',
  'workbench.title': '工作台',
  'workbench.intro': '每个领域在这里放一张卡片，点开即是它自己的工作台。',
  'workbench.empty': '还没有注册任何领域工作台。领域插件向工作台的座位注册一张卡片后，它就会出现在这里。',
  'workbench.back': '返回工作台',
  'workbench.entry.pending': '会话服务还没就绪，稍后再试。',
  'workbench.entry.noPath': '没有可打开的目录。',
  'workbench.entry.missingPath': '该目录不存在或无法访问。',
  'workbench.entry.error': '打开工作区失败（{code}）。',
} as const

/** Every key this plugin's dictionaries must carry. */
export type WorkbenchKey = keyof typeof zh

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<WorkbenchKey, string> = {
  'workbench.nav': 'Workbench',
  'workbench.title': 'Workbench',
  'workbench.intro': 'Every domain keeps one card here, and opening a card is its own workbench.',
  'workbench.empty': 'No domain workbench has registered yet. A domain appears here once its plugin registers a card into the workbench seats.',
  'workbench.back': 'Back to the workbench',
  'workbench.entry.pending': 'The session services are not up yet — try again in a moment.',
  'workbench.entry.noPath': 'There is no folder to open.',
  'workbench.entry.missingPath': 'That folder does not exist or cannot be read.',
  'workbench.entry.error': 'Could not open the workspace ({code}).',
}
