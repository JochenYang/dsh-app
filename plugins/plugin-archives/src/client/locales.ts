/**
 * Dictionary of the 会话归档 settings page, in the plugin's own locale
 * namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the
 * keys. One namespace per plugin, because a namespace has exactly one owner,
 * and every key carries a surface prefix (`sub.`, `stale.`, `search.`,
 * `confirm.`, `skip.`, `notice.`) so two surfaces never collide.
 *
 * zh is the source of truth and stays byte-identical to the pre-i18n page
 * copy; {@link ArchivesKey} is its key union, and the English dictionary is
 * typed with it, so a missing or extra key on either side is a compile error.
 * The same union constrains the page's `t` seat (`PropsLocale`), so a key
 * removed from the dictionary cannot be rendered.
 *
 * Host FACTS (session titles, ids, byte counts, project paths) are NOT here:
 * they are data, and the page shows them verbatim. Host ERRORS are here: the
 * host sends a stable code plus the values the sentence interpolates (see
 * `HostText` in ../types.ts), never a sentence, and the `archives.host.*` keys
 * below are the wording — each zh entry byte-identical to the sentence it
 * replaced. Only the page's own copy — including its empty, loading and failure
 * wording — lives in this table beside them. The two joiners are keys because
 * they are visible punctuation and a language-sensitive one at that (zh joins
 * with full-width marks, en with ASCII ones).
 *
 * @module @dsh-app/plugin-archives/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.archives'

/** Simplified Chinese dictionary — the pre-i18n page copy, verbatim. */
export const zh = {
  'archives.title': '会话归档',
  'archives.loading': '正在读取归档会话…',
  'archives.empty': '归档的会话会在这里按项目分组显示，可在此彻底删除以释放磁盘空间。',
  'archives.sub.empty': '没有已归档的会话',
  'archives.sub.summary': '{count} 个会话 · {bytes} · {projects} 个项目',
  'archives.stale.hint': '这些归档记录还在，但当前内核列不出对应的会话日志（较新内核写入的日志，旧内核不会列出——文件通常仍在磁盘上）。清理只会移除日志确实已不在磁盘上的记录',
  'archives.stale.count': '另有 {count} 条归档记录无日志',
  'archives.prune': '清理',
  'archives.delete': '删除',
  'archives.deleteAll': '删除全部',
  'archives.group.sessions': '{count} 个会话',
  'archives.group.noCwd': '未记录项目目录',

  'archives.search.placeholder': '搜索历史会话内容…',
  'archives.search.action': '搜索',
  'archives.search.busy': '搜索中…',
  'archives.search.empty': '未找到匹配的会话。',
  'archives.search.noAgentTool': 'agent 侧的 session_search 工具尚未挂载（该包暂未进入内核运行时，模型无法主动检索历史会话），页面搜索不受影响。',

  'archives.confirm.ariaPrune': '确认清理归档记录',
  'archives.confirm.ariaDelete': '确认删除归档会话',
  'archives.confirm.prune': '即将清理 {count} 条无日志的归档记录，仅移除记录本身，不影响任何会话数据。',
  'archives.confirm.delete': '即将删除{label}（约 {bytes}）；该会话的日志目录会被整体移除——所有世代与 sidecar 一并消失，且无法恢复。',
  'archives.confirm.pruneBusy': '清理中…',
  'archives.confirm.pruneAction': '确认清理',
  'archives.confirm.deleteBusy': '删除中…',
  'archives.confirm.deleteAction': '确认删除',
  'archives.confirm.cancel': '取消',
  'archives.target.session': '“{title}”',
  'archives.target.group': '“{title}”的 {count} 个会话',

  'archives.notice.pruned': '已清理 {count} 条无效归档记录',
  'archives.notice.deleted': '已删除 {count} 个会话，释放 {bytes}',
  'archives.notice.recordsKept': '归档记录已保留，可用上方「清理」移除',
  'archives.notice.skipped': '跳过 {count} 个（{reasons}）',
  'archives.notice.join.notices': '；',
  'archives.notice.join.reasons': '、',

  'archives.skip.live': '会话正在进行',
  'archives.skip.notArchived': '不在归档中',
  'archives.skip.missing': '会话日志已不存在或无法定位',
  'archives.skip.io': '读写失败',
  'archives.skip.unsupported': '当前内核不支持物理删除',

  // --- Reasons a route refused the request. The host sends a code plus the
  // values the sentence interpolates; these are the sentences. ---
  'archives.host.idsRequired': '请求体需要非空的 ids 字符串数组',
  'archives.host.listFailed': '读取归档会话失败（{detail}）',
  'archives.host.deleteFailed': '删除归档会话失败（{detail}）',
  'archives.host.pruneUnsupported': '当前内核版本不支持清理归档记录',
  'archives.host.pruneFailed': '清理归档记录失败（{detail}）',
  'archives.host.sessionQueryUnavailable': '当前内核未提供会话检索服务（session-query-sqlite 未启用）',
  'archives.host.queryRequired': '查询词不能为空',
  'archives.host.searchFailed': '会话检索失败（{detail}）',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<ArchivesKey, string> = {
  'archives.title': 'Session archives',
  'archives.loading': 'Reading archived sessions…',
  'archives.empty': 'Archived sessions are grouped by project here; delete them from this page to reclaim disk space.',
  'archives.sub.empty': 'No archived sessions',
  'archives.sub.summary': '{count} sessions · {bytes} · {projects} projects',
  'archives.stale.hint': 'These archive records are still here, but this kernel does not list their session logs (a log written by a NEWER kernel is not listed by an older one — its file is usually still on disk). Pruning removes only records whose log really is gone from disk',
  'archives.stale.count': '{count} archive records have no logs',
  'archives.prune': 'Prune',
  'archives.delete': 'Delete',
  'archives.deleteAll': 'Delete all',
  'archives.group.sessions': '{count} sessions',
  'archives.group.noCwd': 'No project directory recorded',

  'archives.search.placeholder': 'Search session history…',
  'archives.search.action': 'Search',
  'archives.search.busy': 'Searching…',
  'archives.search.empty': 'No matching sessions.',
  'archives.search.noAgentTool': 'The session_search tool is not mounted on the agent side yet (that package is not in the kernel runtime, so the model cannot search session history on its own); page search is unaffected.',

  'archives.confirm.ariaPrune': 'Confirm pruning archive records',
  'archives.confirm.ariaDelete': 'Confirm deleting archived sessions',
  'archives.confirm.prune': 'About to prune {count} archive records with no logs; this removes the records only and touches no session data.',
  'archives.confirm.delete': 'About to delete {label} (about {bytes}); the session\'s whole log directory goes with it — every generation and sidecar, with no way back.',
  'archives.confirm.pruneBusy': 'Pruning…',
  'archives.confirm.pruneAction': 'Prune',
  'archives.confirm.deleteBusy': 'Deleting…',
  'archives.confirm.deleteAction': 'Delete',
  'archives.confirm.cancel': 'Cancel',
  'archives.target.session': '"{title}"',
  'archives.target.group': 'the {count} sessions in "{title}"',

  'archives.notice.pruned': 'Pruned {count} invalid archive records',
  'archives.notice.deleted': 'Deleted {count} sessions, freeing {bytes}',
  'archives.notice.recordsKept': 'Archive records were kept; remove them with "Prune" above',
  'archives.notice.skipped': 'Skipped {count} ({reasons})',
  'archives.notice.join.notices': '; ',
  'archives.notice.join.reasons': ', ',

  'archives.skip.live': 'The session is running',
  'archives.skip.notArchived': 'Not in the archive set',
  'archives.skip.missing': 'The session log is gone or could not be located',
  'archives.skip.io': 'Read/write failed',
  'archives.skip.unsupported': 'This kernel does not support physical deletion',

  'archives.host.idsRequired': 'The body needs a non-empty array of string ids',
  'archives.host.listFailed': 'Could not read archived sessions: {detail}',
  'archives.host.deleteFailed': 'Could not delete archived sessions: {detail}',
  'archives.host.pruneUnsupported': 'This kernel version cannot prune archive records',
  'archives.host.pruneFailed': 'Could not prune archive records: {detail}',
  'archives.host.sessionQueryUnavailable': 'This kernel provides no session search service (session-query-sqlite is not enabled)',
  'archives.host.queryRequired': 'The query must not be empty',
  'archives.host.searchFailed': 'Session search failed: {detail}',
}

/** Key domain of the `dsh-app.archives` namespace (zh is the source of truth). */
export type ArchivesKey = keyof typeof zh
