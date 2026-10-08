/**
 * Dictionary of the rewind plugin's client half.
 *
 * zh is the source of truth — {@link RewindKey} is its key union, and the
 * English table is typed with it, so a missing or extra key on either side is a
 * compile error. The same union constrains the components' `t` seat.
 *
 * The `rewind.host.*` block holds copy the HOST half used to send as prose.
 * The host is a long-lived child process and never sends prose: it sends a
 * stable code plus the values the sentence interpolates (see `HostText` in
 * `src/wire.ts`), and this dictionary renders it.
 *
 * @module @dsh-app/plugin-rewind/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.rewind'

/** Simplified Chinese dictionary — the source of truth. */
export const zh = {
  'rewind.message.action.aria': '撤回这条消息',
  'rewind.message.action.hint': '撤回这条消息',

  'rewind.host.busy': '当前回合还没结束，等它跑完再撤回。',
  'rewind.host.badArg': '参数只能是编号，例如 /rewind 2；留空则列出可撤回的消息。',
  'rewind.host.outOfRange': '只有 {available} 条可撤回的消息，没有第 {requested} 条。',
  'rewind.host.empty': '还没有可撤回的消息。',
  'rewind.host.notUserMessage': '这条消息不能作为撤回点。',
  'rewind.host.rejected': '撤回被内核拒绝了：{detail}',
  'rewind.host.list': '共有 {count} 条可撤回的消息。',
  'rewind.host.done': '已撤回第 {n} 条消息，原文已回到输入框。',
  'rewind.host.plan': '这是撤回预览。',

  'rewind.error.unavailable': '撤回功能当前不可用（缺少必要的内核能力）。',
  'rewind.error.noSession': '先打开一个会话。',
  'rewind.files.unrestorable': '{count} 个文件无法恢复（不在撤回覆盖范围内）：{paths}',

  'rewind.confirm.title': '确认撤回',
  'rewind.confirm.nofiles': '这次撤回不会改动任何文件。',
  'rewind.confirm.summary': '这次撤回会改动 {files} 个文件。',
  'rewind.confirm.restore': '恢复',
  'rewind.confirm.remove': '移走',
  'rewind.confirm.unrestorable': '{n} 个文件无法恢复（不在撤回覆盖范围内）',
  'rewind.confirm.showDiff': '查看差异',
  'rewind.confirm.hideDiff': '收起差异',
  'rewind.confirm.cancel': '取消',
  'rewind.confirm.confirm': '确认撤回',
  'rewind.confirm.working': '正在撤回…',
  'rewind.confirm.note': '被移走的文件会存进隔离区，不会删除。',
  'rewind.diff.copy': '复制',
  'rewind.diff.copied': '已复制',
  'rewind.diff.wrap': '自动换行',
  'rewind.diff.unwrap': '取消换行',
  'rewind.diff.collapse': '收起',
  'rewind.diff.expand': '展开其余 {count} 行',
  'rewind.diff.collapseAria': '收起差异',
  'rewind.diff.expandAria': '展开其余 {count} 行',

  'rewind.quarantine.title': '撤回隔离区',
  'rewind.quarantine.empty': '隔离区是空的。撤回时被移走的文件会保存到这里。',
  'rewind.quarantine.intro': '这里保存着 {count} 份被移走的内容，共 {size}。撤回本身是可撤销的，靠的就是这些副本；确认不再需要时可以在这里清掉。',
  'rewind.quarantine.kindCreated': '新建',
  'rewind.quarantine.kindReplaced': '被替换',
  'rewind.quarantine.kindUnknown': '未知来源',
  'rewind.quarantine.discard': '删除',
  'rewind.quarantine.discardAll': '清空此会话',
  'rewind.quarantine.targetFile': '文件 {path} 的隔离副本',
  'rewind.quarantine.targetSlot': '隔离项 {slot}',
  'rewind.quarantine.targetSession': '会话 {session} 的全部 {count} 项',
  'rewind.quarantine.confirmTitle': '删除隔离内容',
  'rewind.quarantine.confirmBody': '将永久删除{label}（{size}）。',
  'rewind.quarantine.confirmWarn': '这是唯一的一份。删除后，这次撤回就无法再撤销了——撤回前的文件内容将彻底丢失。',
  'rewind.quarantine.confirm': '删除',
  'rewind.quarantine.cancel': '取消',
  'rewind.quarantine.purged': '已删除 {count} 项。',
  'rewind.quarantine.purgedPartial': '已删除 {count} 项，{failed} 项删除失败。',

  'rewind.route.listFailed': '读取隔离区失败：{detail}',
  'rewind.route.badBody': '请求格式不正确（必须是大小限制内的 JSON）。',
  'rewind.route.targetsRequired': '请求需要 targets 数组（每项含 sessionId 与 slot），或 all: true。',
  'rewind.route.tooMany': '一次最多删除 {max} 项，请分批操作。',
  'rewind.route.purgeFailed': '删除隔离内容失败：{detail}',
} as const

/** Key union of the dictionary. */
export type RewindKey = keyof typeof zh

/** English dictionary, keyed by the same union. */
export const en: Record<RewindKey, string> = {
  'rewind.message.action.aria': 'Recall this message',
  'rewind.message.action.hint': 'Recall this message',

  'rewind.host.busy': 'The current turn is still running; recall after it finishes.',
  'rewind.host.badArg': 'The argument must be an ordinal, e.g. /rewind 2; leave it empty to list recallable messages.',
  'rewind.host.outOfRange': 'Only {available} recallable messages; there is no number {requested}.',
  'rewind.host.empty': 'No recallable messages yet.',
  'rewind.host.notUserMessage': 'That message cannot be a recall point.',
  'rewind.host.rejected': 'The kernel refused the recall: {detail}',
  'rewind.host.list': '{count} recallable messages.',
  'rewind.host.done': 'Recalled message {n}; its text is back in the composer.',
  'rewind.host.plan': 'This is a recall preview.',

  'rewind.error.unavailable': 'Recall is unavailable right now (a required kernel capability is missing).',
  'rewind.error.noSession': 'Open a session first.',
  'rewind.files.unrestorable': '{count} file(s) could NOT be restored (outside what a recall can see): {paths}',

  'rewind.confirm.title': 'Confirm recall',
  'rewind.confirm.nofiles': 'This recall will not change any files.',
  'rewind.confirm.summary': 'This recall will change {files} file(s).',
  'rewind.confirm.restore': 'Restore',
  'rewind.confirm.remove': 'Move away',
  'rewind.confirm.unrestorable': '{n} file(s) cannot be restored (outside what a recall can see)',
  'rewind.confirm.showDiff': 'View diff',
  'rewind.confirm.hideDiff': 'Hide diff',
  'rewind.confirm.cancel': 'Cancel',
  'rewind.confirm.confirm': 'Recall',
  'rewind.confirm.working': 'Recalling…',
  'rewind.confirm.note': 'Moved files are kept in the quarantine, never deleted.',
  'rewind.diff.copy': 'Copy',
  'rewind.diff.copied': 'Copied',
  'rewind.diff.wrap': 'Wrap lines',
  'rewind.diff.unwrap': 'Unwrap lines',
  'rewind.diff.collapse': 'Collapse',
  'rewind.diff.expand': 'Show {count} more line(s)',
  'rewind.diff.collapseAria': 'Collapse diff',
  'rewind.diff.expandAria': 'Show the remaining {count} line(s)',

  'rewind.quarantine.title': 'Recall quarantine',
  'rewind.quarantine.empty': 'The quarantine is empty. Files a recall moves aside are kept here.',
  'rewind.quarantine.intro': '{count} displaced item(s) are kept here, {size} in total. These copies are what make a recall reversible; discard them here once you are sure you no longer need them.',
  'rewind.quarantine.kindCreated': 'Created',
  'rewind.quarantine.kindReplaced': 'Replaced',
  'rewind.quarantine.kindUnknown': 'Unknown origin',
  'rewind.quarantine.discard': 'Delete',
  'rewind.quarantine.discardAll': 'Clear this session',
  'rewind.quarantine.targetFile': 'the quarantine copy of {path}',
  'rewind.quarantine.targetSlot': 'quarantine item {slot}',
  'rewind.quarantine.targetSession': 'all {count} item(s) of session {session}',
  'rewind.quarantine.confirmTitle': 'Delete quarantined content',
  'rewind.quarantine.confirmBody': 'This permanently deletes {label} ({size}).',
  'rewind.quarantine.confirmWarn': 'This is the only copy. Once it is gone this recall can no longer be undone — the file content from before the recall is lost for good.',
  'rewind.quarantine.confirm': 'Delete',
  'rewind.quarantine.cancel': 'Cancel',
  'rewind.quarantine.purged': 'Deleted {count} item(s).',
  'rewind.quarantine.purgedPartial': 'Deleted {count} item(s); {failed} could not be deleted.',

  'rewind.route.listFailed': 'Could not read the quarantine: {detail}',
  'rewind.route.badBody': 'The request was malformed (JSON, within the size limit).',
  'rewind.route.targetsRequired': 'The request needs a targets array of { sessionId, slot }, or all: true.',
  'rewind.route.tooMany': 'At most {max} items at a time; purge in batches.',
  'rewind.route.purgeFailed': 'Could not purge the quarantine: {detail}',
}
