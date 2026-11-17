/**
 * Dictionary of the 「关于 DSH-APP」 settings page, in the plugin's own locale
 * namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`); this module
 * owns the keys, prefixed `about.` so they cannot collide with the diagnostics
 * page's `diag.` keys in the same namespace.
 *
 * zh is the source of truth; {@link AboutKey} is its key union, and the English
 * dictionary is typed with it, so a missing or extra key on either side is a
 * compile error. The same union constrains the page's `t` seat
 * (`TranslateNS`), so a key removed from the dictionary cannot be rendered.
 *
 * @module @dsh-app/plugin-client-ui/client/about/locales
 */

/** Locale namespace owned by this plugin's client half (shared by every page dictionary). */
export { NS } from '../namespace.ts'

/** Simplified Chinese dictionary. */
export const zh = {
  'about.nav': '关于 DSH-APP',
  'about.intro': '这里显示当前安装的版本信息，并提供检查更新与重启服务的操作。',
  'about.versions.title': '版本信息',
  'about.loading': '读取中…',
  'about.failed': '读取失败：{message}',
  'about.retry': '重新读取',
  'about.shell.label': 'DSH APP',
  'about.kernel.label': '内核',
  'about.channel.label': '内核通道',
  'about.electron.label': 'Electron',
  'about.node.label': 'Node',
  'about.platform.label': '平台',
  'about.unknown': '未知',
  'about.paths.title': '位置',
  'about.paths.hint': '数据目录存放会话、设置与插件；日志目录存放内核运行日志。',
  'about.paths.home': '数据目录',
  'about.paths.logs': '日志目录',
  'about.repo': 'GitHub 仓库',
  'about.changelog.title': '更新日志',
  'about.changelog.hint': '安装包自带最近几个版本的更新说明，离线也能看。',
  'about.changelog.open': '查看更新日志',
  'about.changelog.failed': '读取更新日志失败，稍后可重试。',
  'about.changelog.empty': '这个版本没有更新说明。',
  'about.changelog.close': '关闭',
  'about.paths.openLogs': '打开日志目录',
  'about.paths.opening': '打开中…',
  'about.paths.opened': '已请系统打开日志目录。',
  'about.paths.copyHome': '复制路径',
  'about.paths.copied': '已复制。',
  'about.paths.copyFailed': '复制失败，请手动选择文本。',
  'about.actions.title': '操作',
  'about.actions.hint': '检查更新会由外壳接管并显示进度，重启服务会重新启动内核。',
  'about.actions.checkApp': '检查应用更新',
  'about.actions.checkKernel': '检查内核更新',
  'about.actions.restart': '重启服务',
  'about.actions.started': '已开始，请留意窗口中的进度提示。',
  'about.actions.unsupported': '当前环境不支持此操作（开发运行或较旧的 shell）。',
  'about.actions.devHint': '开发运行不检查更新；安装版才有可用的更新来源。',
  'about.actions.failed': '操作失败：{message}',
} as const

/** Every key of the About page's dictionary. */
export type AboutKey = keyof typeof zh

/** English dictionary, typed against the Chinese key union. */
export const en: Record<AboutKey, string> = {
  'about.nav': 'About DSH-APP',
  'about.intro': 'This page shows what is installed and offers update checks and a service restart.',
  'about.versions.title': 'Versions',
  'about.loading': 'Loading…',
  'about.failed': 'Could not read: {message}',
  'about.retry': 'Read again',
  'about.shell.label': 'DSH APP',
  'about.kernel.label': 'Kernel',
  'about.channel.label': 'Kernel channel',
  'about.electron.label': 'Electron',
  'about.node.label': 'Node',
  'about.platform.label': 'Platform',
  'about.unknown': 'Unknown',
  'about.paths.title': 'Locations',
  'about.paths.hint': 'The data directory holds sessions, settings and plugins; the log directory holds the kernel\'s own logs.',
  'about.paths.home': 'Data directory',
  'about.paths.logs': 'Log directory',
  'about.repo': 'GitHub repository',
  'about.changelog.title': 'Changelog',
  'about.changelog.hint': 'The last few releases ship with the app, so the notes read offline too.',
  'about.changelog.open': 'View changelog',
  'about.changelog.failed': 'Could not read the changelog; try again later.',
  'about.changelog.empty': 'No release notes for this version.',
  'about.changelog.close': 'Close',
  'about.paths.openLogs': 'Open log directory',
  'about.paths.opening': 'Opening…',
  'about.paths.opened': 'Asked the system to open the log directory.',
  'about.paths.copyHome': 'Copy path',
  'about.paths.copied': 'Copied.',
  'about.paths.copyFailed': 'Copy failed — select the text by hand.',
  'about.actions.title': 'Actions',
  'about.actions.hint': 'An update check is taken over by the shell, which shows its own progress; restarting the service restarts the kernel.',
  'about.actions.checkApp': 'Check for app updates',
  'about.actions.checkKernel': 'Check for kernel updates',
  'about.actions.restart': 'Restart service',
  'about.actions.started': 'Started — watch for the progress notice in the window.',
  'about.actions.unsupported': 'This environment cannot do that (a dev run, or an older shell).',
  'about.actions.devHint': 'A dev run does not check for updates; only an installed build has a source to check against.',
  'about.actions.failed': 'Action failed: {message}',
}
