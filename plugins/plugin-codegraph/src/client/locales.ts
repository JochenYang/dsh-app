/**
 * The code graph page's dictionary.
 *
 * Every user-visible string on the settings page lives here, in both languages,
 * with the zh/en pair typed by {@link CodegraphKey}: a key present in one table
 * and missing from the other fails this package's typecheck, which is the same
 * discipline the rest of the suite follows (`plugins/AGENTS.md` §6).
 *
 * The host half never sends prose: a route answers a `HostText { code, params }`
 * and this table owns the sentence. That is why `host.*` keys exist — they are
 * the client's rendering of the host's failure codes, not a copy of its strings.
 *
 * @module @dsh-app/plugin-codegraph/client/locales
 */

/** The locale namespace this plugin owns. */
export const NS = 'dsh-app-codegraph'

/** The English table, which also declares the key set. */
export const en = {
  'codegraph.title': 'Code graph',
  'codegraph.intro': 'A knowledge graph of each project, built in the background the first time a session asks the graph a question. Every project keeps its own graph, and the tools and this page read the same one.',
  'codegraph.empty': 'No project has a graph yet. A graph is built the first time a session in that project uses codegraph_find, codegraph_impact or codegraph_context — nothing here needs to be started by hand. Check that the languages you need are installed below.',
  'codegraph.project.label': 'Project',
  'codegraph.state.unindexed': 'Not indexed',
  'codegraph.state.indexing': 'Indexing…',
  'codegraph.state.current': 'Up to date',
  'codegraph.state.stale': 'Behind the working tree',
  'codegraph.state.failed': 'Failed',
  'codegraph.queued': 'Waiting for a slot',
  'codegraph.stat.files': '{count} files',
  'codegraph.stat.indexed': 'Indexed {when}',
  'codegraph.stat.never': 'Never indexed',
  'codegraph.outcome': 'Last pass: {parsed} parsed, {skipped} unchanged, {removed} removed — {duration}',
  'codegraph.outcome.truncated': 'The index hit its file budget, so only part of the project is covered.',
  'codegraph.outcome.removalSkipped': 'The last pass could not verify deletions, so removed files may still appear.',
  'codegraph.outcome.unsupported': '{count} files were skipped because their language is not installed.',
  'codegraph.outcome.parseErrors': '{count} files were only partly readable.',
  'codegraph.outcome.tooLarge': '{count} files are too large to index.',
  'codegraph.failure': 'The last pass failed: {detail}',
  'codegraph.reindex': 'Re-index',
  'codegraph.reindexing': 'Re-indexing…',
  'codegraph.languages.title': 'Languages',
  'codegraph.languages.intro': 'Nine common languages ship with the plugin, over eight grammar files — C and C++ share one. The rest download on request and are checked against a recorded hash before they are used.',
  'codegraph.languages.bundled': 'Bundled',
  'codegraph.languages.installed': 'Installed',
  'codegraph.languages.missing': 'Not installed',
  'codegraph.languages.unsupported': 'No extraction rules',
  'codegraph.languages.install': 'Download',
  'codegraph.languages.remove': 'Remove',
  'codegraph.languages.installing': 'Downloading…',
  'codegraph.host.statusFailed': 'Could not read the graph status: {detail}',
  'codegraph.host.languagesFailed': 'Could not read the language list: {detail}',
  'codegraph.host.idRequired': 'That action needs a language id.',
  'codegraph.host.unknownLanguage': 'No language "{id}" is known to this plugin.',
  'codegraph.host.bundledLanguage': '"{id}" ships with the plugin. There is nothing to {action}.',
  'codegraph.host.action.install': 'download',
  'codegraph.host.action.remove': 'remove',
  'codegraph.host.action.reindex': 're-index',
  'codegraph.host.cwdRequired': 'That action needs a project directory.',
  'codegraph.host.unknownProject': 'No graph has been opened for "{cwd}".',
  'codegraph.host.unknownAction': 'Unknown action "{action}".',
  'codegraph.host.actionFailed': 'The {action} action failed: {detail}',
  'codegraph.host.unknown': 'Something went wrong talking to the graph: {detail}',
} as const

/** The key union every dictionary must cover exactly. */
export type CodegraphKey = keyof typeof en

/** The Chinese table. Typed against the English one, so a gap fails the build. */
export const zh: Readonly<Record<CodegraphKey, string>> = {
  'codegraph.title': '代码图谱',
  'codegraph.intro': '每个项目各有一张代码图谱，在会话第一次用到图谱时于后台建立。工具与本页读取的是同一份数据。',
  'codegraph.empty': '还没有项目建立过图谱。某个项目里第一次用到 codegraph_find、codegraph_impact 或 codegraph_context 时，图谱会自动建立，这里不需要手动启动。请先确认下方所需语言已安装。',
  'codegraph.project.label': '项目',
  'codegraph.state.unindexed': '未索引',
  'codegraph.state.indexing': '索引中…',
  'codegraph.state.current': '已是最新',
  'codegraph.state.stale': '落后于工作区',
  'codegraph.state.failed': '失败',
  'codegraph.queued': '等待空位',
  'codegraph.stat.files': '{count} 个文件',
  'codegraph.stat.indexed': '索引于 {when}',
  'codegraph.stat.never': '从未索引',
  'codegraph.outcome': '上一轮：解析 {parsed} 个、未变 {skipped} 个、移除 {removed} 个 — {duration}',
  'codegraph.outcome.truncated': '索引达到了文件上限，因此只覆盖了项目的一部分。',
  'codegraph.outcome.removalSkipped': '上一轮无法确认删除，已移除的文件可能仍会出现在结果里。',
  'codegraph.outcome.unsupported': '有 {count} 个文件因语言未安装而被跳过。',
  'codegraph.outcome.parseErrors': '有 {count} 个文件只能部分读取。',
  'codegraph.outcome.tooLarge': '有 {count} 个文件过大，未纳入索引。',
  'codegraph.failure': '上一轮失败：{detail}',
  'codegraph.reindex': '重新索引',
  'codegraph.reindexing': '正在重新索引…',
  'codegraph.languages.title': '语言',
  'codegraph.languages.intro': '九种常用语言随插件提供，共用八份语法文件——C 与 C++ 共用一份。其余按需下载，并在使用前与记录的哈希校验。',
  'codegraph.languages.bundled': '随包提供',
  'codegraph.languages.installed': '已安装',
  'codegraph.languages.missing': '未安装',
  'codegraph.languages.unsupported': '无提取规则',
  'codegraph.languages.install': '下载',
  'codegraph.languages.remove': '移除',
  'codegraph.languages.installing': '下载中…',
  'codegraph.host.statusFailed': '无法读取图谱状态：{detail}',
  'codegraph.host.languagesFailed': '无法读取语言列表：{detail}',
  'codegraph.host.idRequired': '该操作需要一个语言标识。',
  'codegraph.host.unknownLanguage': '本插件不认识语言 "{id}"。',
  'codegraph.host.bundledLanguage': '"{id}" 随插件提供，无需{action}。',
  'codegraph.host.action.install': '下载',
  'codegraph.host.action.remove': '移除',
  'codegraph.host.action.reindex': '重新索引',
  'codegraph.host.cwdRequired': '该操作需要一个项目目录。',
  'codegraph.host.unknownProject': '尚未为 "{cwd}" 打开过图谱。',
  'codegraph.host.unknownAction': '未知操作 "{action}"。',
  'codegraph.host.actionFailed': '{action} 操作失败：{detail}',
  'codegraph.host.unknown': '与图谱通信时出错：{detail}',
}
