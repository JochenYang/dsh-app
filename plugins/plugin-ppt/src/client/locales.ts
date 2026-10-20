/**
 * Dictionary of the PPT capsule and its template panel, in the plugin's own
 * locale namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the
 * keys. One namespace per plugin, because a namespace has exactly one owner,
 * and the keys carry a surface prefix (`capsule.` for the bar entry, `panel.`
 * for the overlay, `tab.`/`card.` for what it renders) so two surfaces never
 * collide.
 *
 * zh is the source of truth and stays byte-identical to the pre-i18n copy;
 * {@link PptKey} is its key union and the English dictionary is typed with it,
 * so a missing or extra key on either side is a compile error. The same union
 * constrains the seat the client entry builds for the capsule, so a key
 * removed from the dictionary cannot be rendered.
 *
 * The anchor label `PPT` and the template names/descriptions are not here:
 * the first is a brand token, and the second is catalog content the host
 * serves (see client/api).
 *
 * @module @dsh-app/plugin-ppt/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.ppt'

/** Simplified Chinese dictionary — the pre-i18n capsule copy, verbatim. */
export const zh = {
  'capsule.hintActive': '{label}；点击关闭，点右侧箭头更换模板',
  'capsule.hintIdle': '点击开启 PPT 模式',
  'capsule.hintParked': '点击开启 PPT 模式，将在会话开始时应用',
  'capsule.pending': '将在会话开始后生效',
  'capsule.skillHint': '已开启 {label} 模式；技能引用未能放入输入框，可手动输入 {token}',
  'capsule.templateAria': '选择模板',
  'card.active': '当前使用',
  'card.noCover': '暂无预览',
  'card.picked': '已选择',
  'menu.documents.description': '创建、读取、编辑和校验 DOCX 文档',
  'menu.documents.label': '文档',
  'menu.group': '办公',
  'menu.pdf.description': '读取已有 PDF，或渲染出规范排版的 PDF',
  'menu.pdf.label': 'PDF 文档',
  'menu.presentations.description': '逐页写作工程，导出可编辑 PPTX',
  'menu.presentations.label': '演示文稿',
  'menu.spreadsheets.description': '创建、读取、编辑和校验 XLSX 工作簿',
  'menu.spreadsheets.label': '电子表格',
  'panel.apply': '使用此模板',
  'panel.cancel': '取消',
  'panel.close': '关闭',
  'panel.closeAria': '关闭模板面板',
  'panel.disable': '关闭 PPT 模式',
  'panel.hint': '模板决定配色、字体与版式骨架，内容由你的需求与材料生成',
  'panel.loadFailed': '模板目录加载失败：{message}',
  'panel.loading': '正在加载模板目录…',
  'panel.tabsAria': '模板分类',
  'panel.title': '选择 PPT 模板',
  'tab.academic': '学术',
  'tab.all': '全部',
  'tab.business': '商务',
  'tab.consulting': '咨询',
  'tab.editorial': '编辑排版',
  'tab.promotion': '宣传',
  'tab.work': '工作汇报',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<PptKey, string> = {
  'capsule.hintActive': '{label}; click to turn off, use the arrow to change the template',
  'capsule.hintIdle': 'Click to turn on PPT mode',
  'capsule.hintParked': 'Click to turn on PPT mode; it starts with the session',
  'capsule.pending': 'Applies once the session starts',
  'capsule.skillHint': '{label} mode is on, but the skill reference could not be placed in the composer — type {token} manually',
  'capsule.templateAria': 'Choose a template',
  'card.active': 'In use',
  'card.noCover': 'No preview',
  'card.picked': 'Selected',
  'menu.documents.description': 'Create, read, edit and validate DOCX documents',
  'menu.documents.label': 'Documents',
  'menu.group': 'Office',
  'menu.pdf.description': 'Read an existing PDF, or render one with proper typography',
  'menu.pdf.label': 'PDF documents',
  'menu.presentations.description': 'Author a deck page by page, export an editable PPTX',
  'menu.presentations.label': 'Presentations',
  'menu.spreadsheets.description': 'Create, read, edit and validate XLSX workbooks',
  'menu.spreadsheets.label': 'Spreadsheets',
  'panel.apply': 'Use this template',
  'panel.cancel': 'Cancel',
  'panel.close': 'Close',
  'panel.closeAria': 'Close the template panel',
  'panel.disable': 'Turn off PPT mode',
  'panel.hint': 'The template sets the colors, fonts and layout skeleton; your request and materials provide the content',
  'panel.loadFailed': 'Could not load the template catalog: {message}',
  'panel.loading': 'Loading the template catalog…',
  'panel.tabsAria': 'Template categories',
  'panel.title': 'Choose a PPT template',
  'tab.academic': 'Academic',
  'tab.all': 'All',
  'tab.business': 'Business',
  'tab.consulting': 'Consulting',
  'tab.editorial': 'Editorial',
  'tab.promotion': 'Promotion',
  'tab.work': 'Work reports',
}

/** Key domain of the `dsh-app.ppt` namespace (zh is the source of truth). */
export type PptKey = keyof typeof zh
