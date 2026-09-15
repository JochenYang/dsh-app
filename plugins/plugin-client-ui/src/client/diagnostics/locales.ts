/**
 * Dictionary of the 诊断 settings page, in the plugin's own locale namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the
 * keys. One namespace per plugin, because a namespace has exactly one owner:
 * the Advanced Models page joins these dictionaries when its copy is
 * converted, and keys carry a page prefix (`diag.`) so two pages never
 * collide.
 *
 * zh is the source of truth and stays byte-identical to the pre-i18n page
 * copy; {@link DiagnosticsKey} is its key union, and the English dictionary
 * is typed with it, so a missing or extra key on either side is a compile
 * error. The same union constrains the page's `t` seat (`TranslateNS`), so a
 * key removed from the dictionary cannot be rendered.
 *
 * @module @dsh-app/plugin-client-ui/client/diagnostics/locales
 */

/** Locale namespace owned by this plugin's client half (shared by every page dictionary). */
export { NS } from '../namespace.ts'

/** Simplified Chinese dictionary — the pre-i18n page copy, verbatim. */
export const zh = {
  'diag.nav': '诊断',
  'diag.intro': '诊断页显示桌面功能状态与内核日志尾部，并可导出一份纯文本诊断包，用于排查「界面打不开」「服务起不来」这类问题。 日志已在写入时脱敏，页面只读取最近 {lines} 行。',
  'diag.bridge.title': '桌面功能',
  'diag.bridge.checking': '检测中…',
  'diag.bridge.available': '可用',
  'diag.bridge.unavailable': '不可用',
  'diag.bridge.recheck': '重新检测',
  'diag.bridge.hintAvailable': '原生动作（打开文件夹、系统通知、另存为、选目录、打开日志目录）可用。',
  'diag.bridge.hintMissing': '当前环境不支持桌面功能（开发运行或较旧的 shell），相关动作会提示不支持。',
  'diag.bridge.hintLoading': '正在读取桌面功能状态…',
  'diag.bridge.hintFailed': '未取到桌面功能状态：{message}',
  'diag.open.action': '打开日志目录',
  'diag.open.busy': '打开中…',
  'diag.open.done': '已请系统打开日志目录。',
  'diag.open.failed': '打开失败：{message}',
  'diag.open.blocked': '桌面功能不可用：当前环境无法打开日志目录。',
  'diag.export.title': '导出诊断包',
  'diag.export.action': '导出诊断包',
  'diag.export.busy': '导出中…',
  'diag.export.hint': '生成一个纯文本文件（shell 版本、内核版本与渠道、日志目录、最近日志尾部），保存位置由系统对话框选择。 文件不含密钥，也不含会话内容。',
  'diag.export.done': '已导出到 {path}',
  'diag.export.failed': '导出失败：{message}',
  'diag.export.blocked': '桌面功能不可用：当前环境无法导出诊断包。',

  // --- The exported .txt itself: the host publishes facts and this page writes
  // the file, so the SAME export reads in whatever language the UI runs in.
  // These zh strings are the file's original wording, kept byte-identical.
  'diag.report.title': 'DSH APP 诊断包',
  'diag.report.generatedAt': '生成时间：{at}（本机时间）',
  'diag.report.intro': '这是一份排查问题时附带的纯文本信息：应用版本、日志目录，以及日志尾部。',
  'diag.report.noSecrets': '本文件不含密钥，也不含会话内容，可以放心附在问题反馈里。',
  'diag.report.sectionVersions': '[应用版本]',
  'diag.report.shellVersion': 'shell 版本：{value}',
  'diag.report.kernelVersion': '内核版本：{value}',
  'diag.report.kernelChannel': '内核渠道：{value}',
  'diag.report.sectionLog': '[日志]',
  'diag.report.logDir': '日志目录：{value}',
  'diag.report.logFile': '日志文件：{file}',
  'diag.report.logTail': '日志尾部：取最近 {limit} 行，实际 {count} 行',
  'diag.report.logStart': '----- 日志尾部开始 -----',
  'diag.report.logEnd': '----- 日志尾部结束 -----',
  'diag.report.logEmpty': '（日志文件为空）',
  'diag.report.logUnavailable': '日志内容：{reason}',
  'diag.report.reason.unsupported': '本环境没有日志目录（未注入 {env}，例如开发运行或较旧的 shell）',
  'diag.report.reason.missing': '日志目录中没有内核日志文件',
  'diag.report.reason.unreadable': '日志文件读取失败',
  'diag.report.reason.unknown': '原因未知',
  'diag.report.unknown': '未知',
  'diag.report.end': '----- 文件结束 -----',
  'diag.log.title': '内核日志（最近 {lines} 行）',
  'diag.log.refresh': '刷新',
  'diag.log.refreshing': '读取中…',
  'diag.log.path': '{file} · {at} 读取',
  'diag.log.empty': '日志文件为空。',
  'diag.log.reading': '正在读取日志尾部…',
  'diag.log.failed': '读取日志失败：{message}',
  'diag.log.aria': '内核日志尾部',
  'diag.message.unsupported': '当前环境不支持该操作',
  'diag.message.unreachable': '无法连接',

  // Copy of the coded messages plugin-brand's host routes answer with. The
  // host never sends a sentence (see HostText), so these are the strings the
  // page displays; each zh entry is byte-identical to the prose the host used
  // to send, which is why the wording looks odd for an English-keyed table.
  'diag.host.trustFence': '请求未通过本机信任围栏',
  'diag.host.methodOnly': '仅支持 {method} 请求',
  'diag.host.linesInvalid': '行数需要是正整数',
  'diag.host.logReadFailed': '读取日志失败',
  'diag.host.logFileMissing': '日志目录中没有内核日志文件',
  'diag.host.bodyTooLarge': '请求体过大',
  'diag.host.invalidJson': '请求体不是合法的 JSON',
  'diag.host.bridgeBadRequest': '请求内容不合法，请检查后重试',
  'diag.host.bridgeRejected': '桌面功能拒绝了这次请求，请重启 DSH APP 后重试',
  'diag.host.bridgeFailed': '桌面操作失败，请重试',
  'diag.host.bridgeTimeout': '等待桌面功能响应超时，请重试',
  'diag.host.bridgeUnreachable': '桌面功能无响应，请重启 DSH APP 后重试',
  'diag.host.nativeDetail': '{detail}',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<DiagnosticsKey, string> = {
  'diag.nav': 'Diagnostics',
  'diag.intro': 'This page shows the desktop-feature status and the tail of the kernel log, and exports both as a plain-text diagnostics package for problems like "the interface will not open" or "the service will not start". Logs are redacted as they are written; the page reads the last {lines} lines.',
  'diag.bridge.title': 'Desktop features',
  'diag.bridge.checking': 'Checking…',
  'diag.bridge.available': 'Available',
  'diag.bridge.unavailable': 'Unavailable',
  'diag.bridge.recheck': 'Check again',
  'diag.bridge.hintAvailable': 'Native actions (open folder, system notification, save as, pick directory, open log directory) are available.',
  'diag.bridge.hintMissing': 'Desktop features are unavailable in this environment (a dev run, or an older shell); the actions report unsupported.',
  'diag.bridge.hintLoading': 'Reading the desktop-feature status…',
  'diag.bridge.hintFailed': 'Could not read the desktop-feature status: {message}',
  'diag.open.action': 'Open log directory',
  'diag.open.busy': 'Opening…',
  'diag.open.done': 'Asked the system to open the log directory.',
  'diag.open.failed': 'Open failed: {message}',
  'diag.open.blocked': 'Desktop features unavailable: this environment cannot open the log directory.',
  'diag.export.title': 'Export diagnostics',
  'diag.export.action': 'Export diagnostics',
  'diag.export.busy': 'Exporting…',
  'diag.export.hint': 'Writes one plain-text file (shell version, kernel version and channel, log directory, recent log tail); the save location comes from a native dialog. The file carries no keys and no session content.',
  'diag.export.done': 'Exported to {path}',
  'diag.export.failed': 'Export failed: {message}',
  'diag.export.blocked': 'Desktop features unavailable: this environment cannot export a diagnostics package.',

  // --- The exported .txt itself; see the zh block for the contract. ---
  'diag.report.title': 'DSH APP diagnostics',
  'diag.report.generatedAt': 'Generated: {at} (local time)',
  'diag.report.intro': 'Plain-text information to attach to a problem report: app versions, the log directory, and the log tail.',
  'diag.report.noSecrets': 'This file carries no keys and no session content, so it is safe to attach to a bug report.',
  'diag.report.sectionVersions': '[Versions]',
  'diag.report.shellVersion': 'shell version: {value}',
  'diag.report.kernelVersion': 'kernel version: {value}',
  'diag.report.kernelChannel': 'kernel channel: {value}',
  'diag.report.sectionLog': '[Log]',
  'diag.report.logDir': 'log directory: {value}',
  'diag.report.logFile': 'log file: {file}',
  'diag.report.logTail': 'log tail: last {limit} lines requested, {count} lines read',
  'diag.report.logStart': '----- log tail begins -----',
  'diag.report.logEnd': '----- log tail ends -----',
  'diag.report.logEmpty': '(the log file is empty)',
  'diag.report.logUnavailable': 'log content: {reason}',
  'diag.report.reason.unsupported': 'this environment has no log directory (no {env} injected: a development run, or an older shell)',
  'diag.report.reason.missing': 'the log directory holds no kernel log file',
  'diag.report.reason.unreadable': 'reading the log file failed',
  'diag.report.reason.unknown': 'reason unknown',
  'diag.report.unknown': 'unknown',
  'diag.report.end': '----- end of file -----',
  'diag.log.title': 'Kernel log (last {lines} lines)',
  'diag.log.refresh': 'Refresh',
  'diag.log.refreshing': 'Reading…',
  'diag.log.path': '{file} · read at {at}',
  'diag.log.empty': 'The log file is empty.',
  'diag.log.reading': 'Reading the log tail…',
  'diag.log.failed': 'Reading the log failed: {message}',
  'diag.log.aria': 'Kernel log tail',
  'diag.message.unsupported': 'This environment does not support the operation',
  'diag.message.unreachable': 'Cannot connect',

  'diag.host.trustFence': 'The request did not pass the local trust fence',
  'diag.host.methodOnly': '{method} only',
  'diag.host.linesInvalid': 'The line count must be a positive integer',
  'diag.host.logReadFailed': 'Reading the log failed',
  'diag.host.logFileMissing': 'The log directory holds no kernel log file',
  'diag.host.bodyTooLarge': 'The request body is too large',
  'diag.host.invalidJson': 'The request body is not valid JSON',
  'diag.host.bridgeBadRequest': 'A desktop feature refused the request content; check it and retry',
  'diag.host.bridgeRejected': 'A desktop feature refused the request; restart DSH APP and retry',
  'diag.host.bridgeFailed': 'The desktop feature failed; retry',
  'diag.host.bridgeTimeout': 'Timed out waiting for the desktop feature; retry',
  'diag.host.bridgeUnreachable': 'The desktop feature is not answering; restart DSH APP and retry',
  'diag.host.nativeDetail': '{detail}',
}

/** Key domain of the `dsh-app.client-ui` namespace (zh is the source of truth). */
export type DiagnosticsKey = keyof typeof zh
