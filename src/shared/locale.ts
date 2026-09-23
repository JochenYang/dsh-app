/**
 * Shell message table (zh-CN / en-US) and the lookup every user-visible shell
 * string goes through.
 *
 * Locale resolution, in order:
 *   1. `DSH_APP_LOCALE` — dev/test override, so a run can be forced into one
 *      language without touching the OS.
 *   2. Electron's `app.getLocale()` — the language the OS reports. A `zh`
 *      prefix (zh, zh-TW, zh-Hans-CN) means zh-CN; anything else means en-US.
 *   3. {@link DEFAULT_LOCALE} — the product's primary market. It is also what a
 *      non-Electron process resolves to (the node test suite).
 *
 * The winner is cached on first use, so one run renders one language. The cache
 * is deliberately NOT filled while there is nothing real to resolve (no
 * override, Electron app not ready): a module-level string evaluated at import
 * time must not freeze the wrong language for the whole run, so such a call
 * answers with the default without being remembered, and `initLocale()` — the
 * one call from boot — resolves for real.
 *
 * A missing key or an unfilled `{param}` throws instead of degrading to the key
 * or a blank line: a half-translated screen must fail loudly in development
 * rather than ship.
 *
 * Scope: the Electron shell (src/main) and the kernel runtime manager
 * (src/kernel), whose status lines and install errors reach the user through the
 * splash, the update card and themed dialogs. static/startup.html keeps a
 * hard-coded Chinese step list and is NOT localized yet — the shell therefore
 * carries the step index on the status payload (see
 * {@link ZH_KERNEL_STATUS_STEP_KEYWORDS}).
 */

import type { KernelChannel } from './types'

export type LocaleId = 'zh-CN' | 'en-US'

/** Locales the shell can render. */
export const LOCALES: readonly LocaleId[] = ['zh-CN', 'en-US']

/** Fallback when neither the environment nor the OS names a usable locale. */
export const DEFAULT_LOCALE: LocaleId = 'zh-CN'

/** Environment override for the shell language (development and tests). */
export const LOCALE_ENV = 'DSH_APP_LOCALE'

/** zh-CN table. Its key set is the single source of truth for `MessageKey`. */
const ZH_CN = {
  // ------------------------------------------------------------- tray menu
  'tray.checkKernelUpdate': '检查内核更新…',
  'tray.checkKernelUpdateWithVersion': '检查内核更新…（当前 dsh {version}）',
  'tray.openApp': '打开 {app}',
  'tray.checkAppUpdate': '检查应用更新…',
  'tray.restartServer': '重启服务',
  'tray.rollbackApp': '回滚到上一版本',
  'tray.exitSafeMode': '退出安全模式',
  'tray.enterSafeMode': '以安全模式重启',
  'tray.quit': '退出',
  'tray.safeModeTag': '（安全模式）',

  // -------------------------------------------------------- close question
  'closeDialog.title': '关闭 DSH APP',
  'closeDialog.message': '关闭窗口后要如何运行？',
  'closeDialog.cancel': '取消',
  'closeDialog.quit': '退出程序',
  'closeDialog.tray': '最小化到托盘',

  // ---------------------------------------------------------------- shared
  'common.ok': '确定',
  'common.later': '稍后',
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.unknown': '未知',
  'common.unknownError': '未知错误',

  // ----------------------------------------------------- first-launch splash
  'splash.starting': '正在启动 DSH APP…',
  'splash.openingUi': '正在打开界面…',
  'splash.retry': '重试',
  'splash.openLogs': '打开日志目录',
  'splash.installMissing': '安装缺失的包并重启',
  'splash.hint': '首次启动需要准备运行环境，可能需要几十秒。',
  'splash.failureHint': '可重试启动，或打开日志目录查看最新日志。',
  'splash.step.prepare': '准备运行时',
  'splash.step.extract': '解压运行时',
  'splash.step.activate': '激活运行时',
  'splash.step.server': '启动内核服务',
  'splash.step.window': '打开界面',
  'splash.pauseDownload': '暂停下载',
  'splash.resumeDownload': '继续下载',

  // The line at the foot of the splash: a fixed wish, not fetched copy. The
  // English is a rendering of the Chinese rather than a translation of its pun
  // (「其次」 is a play on "second"), so the two read as the same sentiment.
  'splash.saying': '首先您要健康，其次才是其次',
  // --------------------------------------- shell status lines (card, tooltip)
  'status.startingServer': '正在启动 dsh 服务…',
  'status.installingMissing': '正在把缺失的包装进当前档案…',
  'status.ready': '就绪',
  'status.serverDown': '服务{reason}',
  'status.serverExited': '已退出（code {code}, signal {signal}）',
  'status.serverStartFailed': '启动失败：{detail}',
  'status.installFailed': '安装失败',
  'status.kernelActivated': '已激活 dsh {version}',
  'status.kernelUpdated': '内核已更新到 dsh {version}',
  'status.layersVerified': '{count} 个层已逐层校验',

  // ------------------------------------------------ server-boot give-up card
  'serverFailure.summary': 'dsh 服务无法启动。{advice}',
  'serverFailure.pluginTree': '疑似套件插件加载失败（patch 冲突或配置无效）。可尝试以安全模式重启，跳过套件插件后排查。',
  'serverFailure.module': '内核缺少模块文件，安装可能不完整。可从托盘菜单执行「检查内核更新」重装内核。',
  'serverFailure.other': '可查看安装目录 logs 文件夹中最新的 dsh-server 日志定位原因。',
  'serverFailure.safeModeDetail': '以安全模式重启将跳过套件插件，仅加载官方内核与你自己的配置。',
  'serverFailure.willExit': '{message}\n\n应用即将退出。',
  'serverFailure.homeRowsIntro': '你的常驻配置 {file} 里有 {count} 行在当前档案（{profile}）中加载不到：',
  'serverFailure.homeRowLine': '· 第 {line} 行：{specifier}',
  'serverFailure.homeRowsHint': '上面这些行会让插件树加载失败，应用因此打不开。把它们删掉或注释掉（或先把它们指向的包装进当前档案），再重试；配置的其他部分不会被改动。',
  'serverFailure.installNoCli': '找不到内核命令行，无法自动安装。请从托盘菜单执行「检查内核更新」重装内核后再试。',
  'serverFailure.installFailed': '自动安装没有成功：{detail}',

  // ------------------------------------------------------------ dev mode
  'devMode.workspaceHint': '开发模式使用本地 deepseek-harness 工作区；若刚拉取上游代码，请先在该目录执行 pnpm install && pnpm run build',
  'devMode.workspaceHintAt': '开发模式使用本地工作区 {checkout}；若刚拉取上游代码，请先在该目录执行 pnpm install && pnpm run build',

  // ------------------------------------------------------- desktop host
  'hostFailure.nodeMissing': '运行时缺少 Node 可执行文件 {path}，内核安装不完整。可从托盘菜单执行「检查内核更新」重装内核。',
  'hostFailure.devHostMissing': '开发模式工作区 {checkout} 未构建桌面宿主。请先在该目录执行 pnpm install && pnpm run build（或在 apps/desktop-host 下执行 tsc -b 与 tsdown）。',

  // -------------------------------------------------  shell action seam
  'shellAction.forbidden': '请求未通过本机信任围栏',
  'shellAction.unknown': '未知的桌面动作',
  'shellAction.method': '仅支持 POST 请求',
  'shellAction.contentType': '仅支持 application/json 请求',
  'shellAction.params': '请求参数不合法',
  'shellAction.tooLarge': '请求内容过大',
  'shellAction.failed': '该桌面操作未能完成',

  // ---------------------------------------------------------- launch folder
  'workspace.openFailedTitle': '无法打开文件夹',
  'workspace.openFailedMissing': '这个文件夹不存在或无法访问：\n{path}',
  'workspace.openFailedOther': '无法把 {path} 作为工作区打开（{code}）。',

  // ------------------------------------------------------ kernel update flow
  'kernelUpdate.devAvailable': '开发模式下内核固定为本地源码，不支持自动更新。\n检测到新版本：dsh {current} → {latest}。\n请以正式安装方式启动后更新，或手动拉取源码。',
  'kernelUpdate.devUpToDate': '开发模式下内核固定为本地源码，不支持在线更新。\n当前版本：dsh {current}（已是最新）。',
  'kernelUpdate.registryUnreachable': '无法连接更新源，请检查网络后重试。',
  'kernelUpdate.artifactPending': '检测到新版本 dsh {latest}，但安装包尚未发布。\n将保持当前版本（dsh {current}），请稍后再试。',
  'kernelUpdate.githubUnreachable': '无法连接更新源（GitHub），请检查网络或稍后重试。',
  'kernelUpdate.busy': '内核更新或安装正在进行中，请稍候再检查。',
  'kernelUpdate.upToDate': '内核已是最新版本（dsh {current}）。',
  'kernelUpdate.checkFailed': '更新检查失败：{detail}',
  'kernelUpdate.cardTitle': '内核更新可用',
  'kernelUpdate.cardMessageMulti': 'dsh {current} 有多个新版本可选',
  'kernelUpdate.cardDetail': '选择要安装的版本，服务将会重启。',
  'kernelUpdate.option': '更新到 dsh {version}',
  'kernelUpdate.optionWithChannel': '更新到 dsh {version}（{channel}）',
  'kernelUpdate.installFailed': '内核安装失败：{detail}\n\n请检查网络连接，然后从托盘菜单重新执行「检查内核更新」。',
  'kernelUpdate.updateFailed': '内核更新失败：{detail}',
  'kernelUpdate.rollbackBootFailed': '内核更新启动失败，已回滚到 dsh {version}。',
  'kernelUpdate.rollbackHidesNewerSessions': '内核更新启动失败，已回滚到 dsh {version}。注意：这台机器上有 {count} 个会话是在较新的内核上写入的，回滚后的内核不会把它们列出来——文件仍在磁盘上，回到较新的内核即可恢复，请先不要清理会话。',

  // ------------------------------------------------------- kernel channels
  'channel.stable': '正式版',
  'channel.beta': '候选版',
  'channel.alpha': '测试版',

  // ------------------------------------------- in-page kernel update card
  'updateCard.title': '发现内核更新',
  'updateCard.titleMulti': '发现多个内核更新',
  'updateCard.detail': '当前版本 dsh {current}。更新将下载新运行时并重启服务。',
  'updateCard.optionNow': '立即更新到 {version}',
  'updateCard.optionWithChannel': '更新到 {version}（{channel}）',

  // ------------------------------------------------------ export feedback
  'export.completedTitle': 'Session 导出完成',
  'export.failedTitle': 'Session 导出失败',
  'export.savedTo': '已保存到：{path}',
  'export.cancelled': '已取消',
  'export.interrupted': '已中断',

  // -------------------------------------------------------- shell updater
  'updater.checking': '正在检查应用更新…',
  'updater.checkingBusy': '正在检查应用更新，请稍候…',
  'updater.downloading': '正在下载 {app} {version}…',
  'updater.downloadFailed': '下载失败：{detail}',
  'updater.readyTitle': '{app} 更新就绪',
  'updater.readyMessage': '更新已下载完成，将在退出时安装。',
  'updater.restartNow': '立即重启',
  'updater.installNow': '立即安装',
  'updater.availableTitle': '{app} 更新可用',
  'updater.availableMessage': '发现新版本 {app}（{version}）。',
  'updater.availableDetail': '当前 v{current} → v{version}。将下载并静默安装，安装完成后需重新打开应用。',
  'updater.updateNow': '立即更新',
  'updater.skipThisVersion': '跳过此版本',
  'updater.skippedMessage': '检测到 {app} {version}（你曾跳过此版本）。',
  'updater.skippedDetail': '仍要安装该版本吗？',
  'updater.keepSkipped': '保持跳过',
  'updater.installAnyway': '仍要安装',
  'updater.skipToast': '已跳过 {app} {version}，之后将不再自动提醒',
  'updater.upToDate': '已是最新版本（{app} {current}）。',
  'updater.metadataFailed': '无法获取更新元数据（latest.yml）或格式无法解析。{hint}',
  'updater.badVersion': '更新元数据版本格式异常',
  'updater.noAsset': '未找到适用于当前系统的安装包',
  'updater.badAssetName': '更新包文件名格式异常',
  'updater.manualHint': '可手动从镜像仓库下载：{url}',
  'updater.allSourcesFailed': '无法从任何源下载更新包：{detail}。{hint}',
  'updater.integrityFailed': '完整性校验失败（期望 {expected}…，实际 {actual}…）',
  'updater.updateFailedMessage': '应用更新失败：{message}',
  'updater.updateFailedDetail': '你可以稍后重试，或从镜像仓库手动下载安装包。',
  'updater.openMirror': '打开镜像下载页',
  'updater.downloadedToast': '{app} {version} 下载完成',
  'updater.installPromptMessage': '将关闭当前应用并打开 {app} {version} 安装向导（与首次安装相同）。',
  'updater.installPromptDetail': '按向导完成安装后，应用会重新启动。安装包将在安装完成后自动删除。',
  'updater.rollbackDevUnsupported': '开发模式下不支持回滚应用版本（当前运行的是未打包构建）。',
  'updater.noRollbackTarget': '没有可回滚的历史版本。',
  'updater.rollbackFetching': '正在获取 {app} {previous} 的安装包信息…',
  'updater.rollbackMetadataFailed': '无法获取 {app} {previous} 的更新元数据，请检查网络后重试。{hint}',
  'updater.rollbackNoAsset': '未找到 {app} {previous} 适用于当前系统的安装包。',
  'updater.rollbackTitle': '{app} 回滚到上一版本',
  'updater.rollbackMessage': '将把 {app} 从 v{current} 回滚到 v{previous}。',
  'updater.rollbackDetail': '将下载该版本的安装包并打开安装向导，完成后应用会重新启动。',
  'updater.rollbackConfirm': '确认回滚',
  'updater.rollbackReadyTitle': '{app} 回滚就绪',
  'updater.rollbackReadyMessage': '将关闭当前应用并安装 {app} {previous}（回滚到上一版本）。',
  'updater.rollbackFailed': '回滚失败：{detail}',
  'updater.devCheckNewer': '开发模式下不支持自动更新应用（当前运行的是未打包构建）。\n检测到新版本：v{current} → v{latest}，请从正式安装的副本更新。',
  'updater.devCheckSame': '开发模式下不支持自动更新应用（当前运行的是未打包构建）。\n当前版本 v{current}，远端为同一版本。',
  'updater.devCheckFailed': '开发模式下不支持自动更新应用，且远端版本检查失败：{detail}',
  'updater.previousIncomplete': '上次应用更新未完成（当前仍为 v{current}），可从托盘「检查应用更新」重试',

  // --------------------------------------------------- kernel runtime copy
  // Errors thrown while resolving/installing a kernel. Actionable, and free of
  // paths that are not already part of the failing operation.
  'kernel.devCheckoutMissing': '开发模式需要配置 devCheckoutDir（本地 deepseek-harness 源码目录）',
  'kernel.devManifestUnreadable': '开发模式内核目录无效：{checkout} 下缺少可读的 package.json，请确认 DSH_APP_DEV_RUNTIME 指向 deepseek-harness 源码根目录',
  'kernel.devManifestNoVersion': '开发模式内核目录无效：{checkout}/package.json 缺少 version 字段',
  'kernel.devKernelMissing': '这次开发运行没有可用的内核：既没有已安装的运行时，本构建也没有随包内核。请先正常启动一次应用完成安装，或用 DSH_APP_DEV_KERNEL 指向一个已构建的运行时目录',
  'kernel.localRuntimeUnreadable': 'DSH_APP_DEV_KERNEL 指向的目录不是运行时树：{dir} 下缺少可读的 manifest.json',
  'kernel.localRuntimeIncomplete': 'DSH_APP_DEV_KERNEL 指向的运行时树不完整：{dir} 下缺少 {entry}',
  'kernel.notInitialized': '内核尚未初始化',
  'kernel.installBusy': '内核安装正在进行中，请稍候',
  'kernel.registryUnreachable': '无法连接 npm 注册表以解析 dsh 版本',
  'kernel.artifactSourceConfig': '制品源需要配置 artifactOwner/artifactRepo（GitHub 仓库）',
  'kernel.artifactMissing': '未找到 dsh {version} 在 {platform}-{arch} 上的运行时产物',
  'kernel.artifactPlatformMismatch': '产物平台不匹配：{artifactPlatform}-{artifactArch} 与 {platform}-{arch}',
  'kernel.artifactVersionMismatch': '产物版本不匹配：{artifactVersion} 与请求的 {version}，已拒绝安装',
  'kernel.manifestMissing': '运行时产物缺少 manifest.json',
  'kernel.rollbackManifestMissing': '回滚失败：上一个内核 {dir} 缺少 manifest.json',
  'kernel.rolledBack': '已回滚到 {dir}',
  'kernel.integrityFailed': '完整性校验失败（期望 {expected}…，实际 {actual}…）',
  'kernel.bundledIntegrityFailed': '内置运行时完整性校验失败（期望 {expected}…，实际 {actual}…）',
  'kernel.layerIntegrityFailed': '层文件 {name} 完整性校验失败（期望 {expected}…，实际 {actual}…）',
  'kernel.layerMissing': '缺少层文件 {name}（层索引引用了它，但 {dir} 中没有）',
  'kernel.layerDownloadFailed': '运行时分层 {name}：{detail}',
  'kernel.downloadHttpFailed': '下载失败：HTTP {status}',
  'kernel.downloadTooLarge': '下载失败：安装包过大（{bytes} 字节）',
  'kernel.downloadTooLargeReceived': '下载失败：安装包过大（已接收 {bytes} 字节）',

  // ------------------------------------------ kernel status lines (splash)
  'kernel.status.checkKernelUpdate': '正在检查内核更新…',
  'kernel.status.checkUpdate': '正在检查更新…',
  'kernel.status.prepareInstall': '正在准备首次安装…',
  'kernel.status.downloadingDefault': '正在下载 dsh…',
  'kernel.status.downloading': '正在下载 dsh {version}…',
  'kernel.status.layerCacheVerify': '正在校验内核分层缓存…',
  'kernel.status.layerDownloading': '正在下载运行时分层（{done}/{total}）…',
  'kernel.status.assembling': '正在装配运行时…（{done}/{total}）',
  'kernel.status.extracting': '正在解压运行时…',
  'kernel.status.extractingProgress': '正在解压运行时…（{done}/{total}）',
  'kernel.status.activating': '正在激活运行时…',
  'kernel.status.verifyBundled': '正在校验内置运行时…',
  'kernel.status.verifyLayers': '正在校验运行时分层…',
  'kernel.status.paused': '已暂停下载',

  // -------------------------------------------- split-layer index faults
  'kernel.layerIndexVersionMismatch': '层索引版本不匹配：{indexVersion} 与 {version}',
  'kernel.layerIndex.fieldMissing': '层索引 {label} 的字段 {field} 缺失或不是非空字符串',
  'kernel.layerIndex.entryAt': '层索引 {label} 的第 {position} 层',
  'kernel.layerIndex.notObject': '{at} 不是对象',
  'kernel.layerIndex.badKind': '{at} 的 kind 无效：{kind}',
  'kernel.layerIndex.badName': '{at} 的 name 不是合法的层文件名：{name}',
  'kernel.layerIndex.duplicateName': '{at} 的 name 与另一层重复：{name}',
  'kernel.layerIndex.badSha512': '{at} 的 sha512 不是 128 位十六进制摘要',
  'kernel.layerIndex.badBytes': '{at} 的 bytes 不是正整数',
  'kernel.layerIndex.noEntries': '{at} 的 entries 缺失或为空',
  'kernel.layerIndex.badEntryPath': '{at} 的 entries 含非法路径：{entry}',
  'kernel.layerIndex.notJsonObject': '层索引 {label} 不是 JSON 对象',
  'kernel.layerIndex.badChannel': '层索引 {label} 的 channel 无效：{channel}',
  'kernel.layerIndex.badSource': '层索引 {label} 的 source 无效：{source}',
  'kernel.layerIndex.badIntegrity': '层索引 {label} 的 integrity 缺失或不是字符串',
  'kernel.layerIndex.noLayers': '层索引 {label} 的 layers 缺失或为空',
  'kernel.layerIndex.unreadable': '无法读取层索引 {label}：{detail}',
  'kernel.layerIndex.invalidJson': '层索引 {label} 不是有效的 JSON：{detail}',
  'kernel.layerIndex.platformMismatch': '层索引平台不匹配：{indexPlatform}-{indexArch} 与 {platform}-{arch}',

  // ------------------------------------------------- kernel download failure
  'downloadFailure.integrity': '下载内容与官方摘要不符，已中止以防被篡改。这通常意味着中间环节（代理或镜像）改动了内容，请更换网络后重试。',
  'downloadFailure.missing': '该版本的安装包尚未发布（{sources}）。稍后重试，或从托盘菜单重新检查更新。',
  'downloadFailure.network': '无法连接任何更新源（{sources}：GitHub 与镜像均不可达）。请检查网络与代理设置，或稍后重试。',
  'downloadFailure.sources': '已尝试 {count} 个来源',
  'downloadFailure.reason': '\n原因：{detail}',

  // ------------------------------------------------------- office payload
  // The LibreOffice engine the kernel converts office documents with. It is a
  // separate, on-demand download (see src/kernel/office-payload.ts), so these
  // lines are what the settings row and the failure answers say.
  'officePayload.status.unsupported': '当前内核未声明办公组件（开发模式或旧内核），无需下载',
  'officePayload.status.missing': '未安装（需要 v{version}）',
  'officePayload.status.installed': '已安装 v{version}',
  'officePayload.status.downloading': '下载中 {percent}%',
  'officePayload.status.installing': '正在安装办公组件…',
  'officePayload.artifactMissing': '未找到办公组件产物 office-payload-{platform}-{arch}-{dshVersion}.tgz，可能尚未发布，请稍后重试',
  'officePayload.manifestMismatch': '办公组件产物与当前内核不匹配：{detail}',
  'officePayload.downloadFailed': '下载办公组件失败：{detail}',
  'officePayload.installFailed': '安装办公组件失败：{detail}',
} as const

/** Every message key. Both tables must cover exactly this set. */
export type MessageKey = keyof typeof ZH_CN

/**
 * en-US table. Typed as `Record<MessageKey, string>`, so a missing or extra key
 * is a compile error — the two languages cannot drift apart silently.
 */
const EN_US: Record<MessageKey, string> = {
  // ------------------------------------------------------------- tray menu
  'tray.checkKernelUpdate': 'Check for kernel updates…',
  'tray.checkKernelUpdateWithVersion': 'Check for kernel updates… (current dsh {version})',
  'tray.openApp': 'Open {app}',
  'tray.checkAppUpdate': 'Check for app updates…',
  'tray.restartServer': 'Restart server',
  'tray.rollbackApp': 'Roll back to the previous version',
  'tray.exitSafeMode': 'Leave safe mode',
  'tray.enterSafeMode': 'Restart in safe mode',
  'tray.quit': 'Quit',
  'tray.safeModeTag': ' (safe mode)',

  // -------------------------------------------------------- close question
  'closeDialog.title': 'Close DSH APP',
  'closeDialog.message': 'How should the app keep running after the window closes?',
  'closeDialog.cancel': 'Cancel',
  'closeDialog.quit': 'Quit the app',
  'closeDialog.tray': 'Minimize to tray',

  // ---------------------------------------------------------------- shared
  'common.ok': 'OK',
  'common.later': 'Later',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.unknown': 'unknown',
  'common.unknownError': 'unknown error',

  // ----------------------------------------------------- first-launch splash
  'splash.starting': 'Starting DSH APP…',
  'splash.openingUi': 'Opening the interface…',
  'splash.retry': 'Retry',
  'splash.openLogs': 'Open log folder',
  'splash.installMissing': 'Install the missing packages and restart',
  'splash.hint': 'The first launch prepares the runtime, which can take a while.',
  'splash.failureHint': 'Retry the launch, or open the log folder for the latest lines.',
  'splash.step.prepare': 'Preparing the runtime',
  'splash.step.extract': 'Extracting the runtime',
  'splash.step.activate': 'Activating the runtime',
  'splash.step.server': 'Starting the kernel service',
  'splash.step.window': 'Opening the interface',
  'splash.pauseDownload': 'Pause download',
  'splash.resumeDownload': 'Resume download',

  'splash.saying': 'Stay healthy first. Everything else comes second.',
  // --------------------------------------- shell status lines (card, tooltip)
  'status.startingServer': 'Starting the dsh server…',
  'status.installingMissing': 'Installing the missing packages into the current profile…',
  'status.ready': 'Ready',
  'status.serverDown': 'Server {reason}',
  'status.serverExited': 'exited (code {code}, signal {signal})',
  'status.serverStartFailed': 'failed to start: {detail}',
  'status.installFailed': 'Installation failed',
  'status.kernelActivated': 'Activated dsh {version}',
  'status.kernelUpdated': 'Kernel updated to dsh {version}',
  'status.layersVerified': '{count} layers verified one by one',

  // ------------------------------------------------ server-boot give-up card
  'serverFailure.summary': 'The dsh server could not start. {advice}',
  'serverFailure.pluginTree': 'The brand plugin suite appears to have failed to load (patch conflict or invalid config). Restarting in safe mode skips the suite plugins so you can narrow it down.',
  'serverFailure.module': 'The kernel is missing module files, so the installation may be incomplete. Run "Check for kernel updates" from the tray menu to reinstall it.',
  'serverFailure.other': 'Check the newest dsh-server log in the logs folder of the installation directory to find the cause.',
  'serverFailure.safeModeDetail': 'Restarting in safe mode skips the suite plugins and loads only the official kernel plus your own configuration.',
  'serverFailure.willExit': '{message}\n\nThe app will now exit.',
  'serverFailure.homeRowsIntro': 'Your home-layer configuration {file} has {count} row(s) the current profile ({profile}) cannot load:',
  'serverFailure.homeRowLine': '· line {line}: {specifier}',
  'serverFailure.homeRowsHint': 'Those rows make the plugin tree fail to load, which is why the app does not open. Remove or comment them out (or install the packages they name into the current profile) and retry; nothing else in your configuration is changed.',
  'serverFailure.installNoCli': 'The kernel command line is not available, so the packages cannot be installed automatically. Run "Check for kernel updates" from the tray menu, then try again.',
  'serverFailure.installFailed': 'The automatic install did not succeed: {detail}',

  // ------------------------------------------------------------ dev mode
  'devMode.workspaceHint': 'Dev mode runs the local deepseek-harness workspace; after pulling upstream code, run pnpm install && pnpm run build in that directory first',
  'devMode.workspaceHintAt': 'Dev mode runs the local workspace {checkout}; after pulling upstream code, run pnpm install && pnpm run build in that directory first',

  // ------------------------------------------------------- desktop host
  'hostFailure.nodeMissing': 'The runtime is missing its Node executable at {path}, so the kernel installation is incomplete. Run "Check for kernel updates" from the tray menu to reinstall it.',
  'hostFailure.devHostMissing': 'The dev workspace {checkout} has not built the desktop host. Run pnpm install && pnpm run build in that directory first (or tsc -b and tsdown inside apps/desktop-host).',

  // -------------------------------------------------  shell action seam
  'shellAction.forbidden': 'The request did not pass the local trust fence',
  'shellAction.unknown': 'Unknown desktop action',
  'shellAction.method': 'POST only',
  'shellAction.contentType': 'application/json only',
  'shellAction.params': 'Invalid request parameters',
  'shellAction.tooLarge': 'The request body is too large',
  'shellAction.failed': 'The desktop action did not complete',

  // ---------------------------------------------------------- launch folder
  'workspace.openFailedTitle': 'Could not open folder',
  'workspace.openFailedMissing': 'That folder does not exist or is not accessible:\n{path}',
  'workspace.openFailedOther': 'Could not open {path} as a workspace ({code}).',

  // ------------------------------------------------------ kernel update flow
  'kernelUpdate.devAvailable': 'In dev mode the kernel is pinned to the local source, so it cannot be updated automatically.\nNewer version detected: dsh {current} → {latest}.\nStart a packaged build to update, or pull the source manually.',
  'kernelUpdate.devUpToDate': 'In dev mode the kernel is pinned to the local source, so it cannot be updated online.\nCurrent version: dsh {current} (already the newest).',
  'kernelUpdate.registryUnreachable': 'Could not reach the update source. Check your network and retry.',
  'kernelUpdate.artifactPending': 'A newer version dsh {latest} was found, but its package is not published yet.\nKeeping the current version (dsh {current}) — try again later.',
  'kernelUpdate.githubUnreachable': 'Could not reach the update source (GitHub). Check your network or try again later.',
  'kernelUpdate.busy': 'A kernel update or installation is already running — check again in a moment.',
  'kernelUpdate.upToDate': 'The kernel is already the newest version (dsh {current}).',
  'kernelUpdate.checkFailed': 'Update check failed: {detail}',
  'kernelUpdate.cardTitle': 'Kernel update available',
  'kernelUpdate.cardMessageMulti': 'Several newer versions are available for dsh {current}',
  'kernelUpdate.cardDetail': 'Pick the version to install; the server will restart.',
  'kernelUpdate.option': 'Update to dsh {version}',
  'kernelUpdate.optionWithChannel': 'Update to dsh {version} ({channel})',
  'kernelUpdate.installFailed': 'Kernel installation failed: {detail}\n\nCheck your network, then run "Check for kernel updates" from the tray menu again.',
  'kernelUpdate.updateFailed': 'Kernel update failed: {detail}',
  'kernelUpdate.rollbackBootFailed': 'The updated kernel failed to start; rolled back to dsh {version}.',
  'kernelUpdate.rollbackHidesNewerSessions': 'The updated kernel failed to start; rolled back to dsh {version}. {count} sessions on this machine were written by the NEWER kernel, and the older one does not list them — their files are still on disk, so returning to the newer kernel brings them back. Please do not clean up sessions until then.',

  // ------------------------------------------------------- kernel channels
  'channel.stable': 'stable',
  'channel.beta': 'beta',
  'channel.alpha': 'alpha',

  // ------------------------------------------- in-page kernel update card
  'updateCard.title': 'Kernel update available',
  'updateCard.titleMulti': 'Multiple kernel updates available',
  'updateCard.detail': 'Current version dsh {current}. The update downloads a new runtime and restarts the server.',
  'updateCard.optionNow': 'Update to {version} now',
  'updateCard.optionWithChannel': 'Update to {version} ({channel})',

  // ------------------------------------------------------ export feedback
  'export.completedTitle': 'Session export complete',
  'export.failedTitle': 'Session export failed',
  'export.savedTo': 'Saved to: {path}',
  'export.cancelled': 'Cancelled',
  'export.interrupted': 'Interrupted',

  // -------------------------------------------------------- shell updater
  'updater.checking': 'Checking for app updates…',
  'updater.checkingBusy': 'Already checking for app updates — please wait…',
  'updater.downloading': 'Downloading {app} {version}…',
  'updater.downloadFailed': 'Download failed: {detail}',
  'updater.readyTitle': '{app} update ready',
  'updater.readyMessage': 'The update has been downloaded and will be installed when the app exits.',
  'updater.restartNow': 'Restart now',
  'updater.installNow': 'Install now',
  'updater.availableTitle': '{app} update available',
  'updater.availableMessage': 'A new version of {app} is available ({version}).',
  'updater.availableDetail': 'Current v{current} → v{version}. The update downloads and installs silently; reopen the app when it finishes.',
  'updater.updateNow': 'Update now',
  'updater.skipThisVersion': 'Skip this version',
  'updater.skippedMessage': '{app} {version} found (you skipped this version).',
  'updater.skippedDetail': 'Install this version anyway?',
  'updater.keepSkipped': 'Keep it skipped',
  'updater.installAnyway': 'Install anyway',
  'updater.skipToast': 'Skipped {app} {version}; you will not be reminded automatically again',
  'updater.upToDate': 'Already the newest version ({app} {current}).',
  'updater.metadataFailed': 'Could not fetch the update metadata (latest.yml) or it could not be parsed. {hint}',
  'updater.badVersion': 'Malformed version in the update metadata',
  'updater.noAsset': 'No installer found for this system',
  'updater.badAssetName': 'Malformed installer file name',
  'updater.manualHint': 'You can download it manually from the mirror repository: {url}',
  'updater.allSourcesFailed': 'Could not download the update package from any source: {detail}. {hint}',
  'updater.integrityFailed': 'Integrity check failed (expected {expected}…, got {actual}…)',
  'updater.updateFailedMessage': 'App update failed: {message}',
  'updater.updateFailedDetail': 'You can retry later, or download the installer manually from the mirror repository.',
  'updater.openMirror': 'Open the mirror download page',
  'updater.downloadedToast': '{app} {version} downloaded',
  'updater.installPromptMessage': 'The app will close and open the {app} {version} setup wizard (same as a first install).',
  'updater.installPromptDetail': 'The app restarts after you finish the wizard. The installer package is deleted once the installation completes.',
  'updater.rollbackDevUnsupported': 'Rolling back the app version is not supported in dev mode (this is an unpackaged build).',
  'updater.noRollbackTarget': 'No earlier version to roll back to.',
  'updater.rollbackFetching': 'Fetching the package info for {app} {previous}…',
  'updater.rollbackMetadataFailed': 'Could not fetch the update metadata for {app} {previous}. Check your network and retry. {hint}',
  'updater.rollbackNoAsset': 'No installer found for {app} {previous} on this system.',
  'updater.rollbackTitle': '{app}: roll back to the previous version',
  'updater.rollbackMessage': '{app} will be rolled back from v{current} to v{previous}.',
  'updater.rollbackDetail': 'That version downloads and opens the setup wizard; the app restarts when it finishes.',
  'updater.rollbackConfirm': 'Confirm rollback',
  'updater.rollbackReadyTitle': '{app} rollback ready',
  'updater.rollbackReadyMessage': 'The app will close and install {app} {previous} (rolling back to the previous version).',
  'updater.rollbackFailed': 'Rollback failed: {detail}',
  'updater.devCheckNewer': 'Automatic app updates are not supported in dev mode (this is an unpackaged build).\nNewer version detected: v{current} → v{latest}; update from a packaged copy.',
  'updater.devCheckSame': 'Automatic app updates are not supported in dev mode (this is an unpackaged build).\nCurrent version v{current}; the remote offers the same version.',
  'updater.devCheckFailed': 'Automatic app updates are not supported in dev mode, and the remote version check failed: {detail}',
  'updater.previousIncomplete': 'The last app update did not complete (still running v{current}); retry from the tray menu via "Check for app updates"',

  // --------------------------------------------------- kernel runtime copy
  'kernel.devCheckoutMissing': 'Dev mode needs devCheckoutDir (the local deepseek-harness source directory)',
  'kernel.devManifestUnreadable': 'The dev-mode kernel directory is invalid: no readable package.json under {checkout}; make sure DSH_APP_DEV_RUNTIME points at the root of a deepseek-harness checkout',
  'kernel.devManifestNoVersion': 'The dev-mode kernel directory is invalid: {checkout}/package.json has no version field',
  'kernel.devKernelMissing': 'This dev run has no kernel to boot: nothing is installed and this build ships no bundled kernel. Start the app normally once to install one, or point DSH_APP_DEV_KERNEL at a built runtime directory',
  'kernel.localRuntimeUnreadable': 'DSH_APP_DEV_KERNEL does not name a runtime tree: no readable manifest.json under {dir}',
  'kernel.localRuntimeIncomplete': 'The runtime tree DSH_APP_DEV_KERNEL names is incomplete: {entry} is missing under {dir}',
  'kernel.notInitialized': 'The kernel has not been initialized yet',
  'kernel.installBusy': 'A kernel installation is already running — please wait',
  'kernel.registryUnreachable': 'Could not reach the npm registry to resolve a dsh version',
  'kernel.artifactSourceConfig': 'Artifact mode needs artifactOwner/artifactRepo (the GitHub repository holding the runtime artifacts)',
  'kernel.artifactMissing': 'No runtime artifact found for dsh {version} on {platform}-{arch}',
  'kernel.artifactPlatformMismatch': 'The artifact targets another platform: {artifactPlatform}-{artifactArch} instead of {platform}-{arch}',
  'kernel.artifactVersionMismatch': 'The artifact is for another version: {artifactVersion} instead of the requested {version} — install refused',
  'kernel.manifestMissing': 'The runtime artifact has no manifest.json',
  'kernel.rollbackManifestMissing': 'Rollback failed: the previous kernel {dir} has no manifest.json',
  'kernel.rolledBack': 'Rolled back to {dir}',
  'kernel.integrityFailed': 'Integrity check failed (expected {expected}…, got {actual}…)',
  'kernel.bundledIntegrityFailed': 'The bundled runtime failed its integrity check (expected {expected}…, got {actual}…)',
  'kernel.layerIntegrityFailed': 'Layer file {name} failed its integrity check (expected {expected}…, got {actual}…)',
  'kernel.layerMissing': 'Missing layer file {name} (the layer index names it, but {dir} does not contain it)',
  'kernel.layerDownloadFailed': 'Runtime layer {name}: {detail}',
  'kernel.downloadHttpFailed': 'Download failed: HTTP {status}',
  'kernel.downloadTooLarge': 'Download failed: the package is too large ({bytes} bytes)',
  'kernel.downloadTooLargeReceived': 'Download failed: the package is too large ({bytes} bytes received)',

  // ------------------------------------------ kernel status lines (splash)
  'kernel.status.checkKernelUpdate': 'Checking for kernel updates…',
  'kernel.status.checkUpdate': 'Checking for updates…',
  'kernel.status.prepareInstall': 'Preparing the first installation…',
  'kernel.status.downloadingDefault': 'Downloading dsh…',
  'kernel.status.downloading': 'Downloading dsh {version}…',
  'kernel.status.layerCacheVerify': 'Verifying the kernel layer cache…',
  'kernel.status.layerDownloading': 'Downloading runtime layers ({done}/{total})…',
  'kernel.status.assembling': 'Assembling the runtime… ({done}/{total})',
  'kernel.status.extracting': 'Extracting the runtime…',
  'kernel.status.extractingProgress': 'Extracting the runtime… ({done}/{total})',
  'kernel.status.activating': 'Activating the runtime…',
  'kernel.status.verifyBundled': 'Verifying the bundled runtime…',
  'kernel.status.verifyLayers': 'Verifying the runtime layers…',
  'kernel.status.paused': 'Download paused',

  // -------------------------------------------- split-layer index faults
  // Composed from `{at}` on purpose: the index faults share one "layer index
  // <file>, layer <n>" prefix, which `kernel.layerIndex.entryAt` supplies.
  'kernel.layerIndexVersionMismatch': 'The layer index is for another version: {indexVersion} instead of {version}',
  'kernel.layerIndex.fieldMissing': 'layer index {label}: field {field} is missing or is not a non-empty string',
  'kernel.layerIndex.entryAt': 'layer index {label}, layer {position}',
  'kernel.layerIndex.notObject': '{at} is not an object',
  'kernel.layerIndex.badKind': '{at} has an invalid kind: {kind}',
  'kernel.layerIndex.badName': '{at} has a name that is not a valid layer file name: {name}',
  'kernel.layerIndex.duplicateName': '{at} reuses the name of another layer: {name}',
  'kernel.layerIndex.badSha512': '{at} has a sha512 that is not a 128-digit hex digest',
  'kernel.layerIndex.badBytes': '{at} has bytes that are not a positive integer',
  'kernel.layerIndex.noEntries': '{at} is missing entries or they are empty',
  'kernel.layerIndex.badEntryPath': '{at} has an entry with an illegal path: {entry}',
  'kernel.layerIndex.notJsonObject': 'layer index {label} is not a JSON object',
  'kernel.layerIndex.badChannel': 'layer index {label} has an invalid channel: {channel}',
  'kernel.layerIndex.badSource': 'layer index {label} has an invalid source: {source}',
  'kernel.layerIndex.badIntegrity': 'layer index {label} is missing integrity or it is not a string',
  'kernel.layerIndex.noLayers': 'layer index {label} has no layers or they are empty',
  'kernel.layerIndex.unreadable': 'Could not read the layer index {label}: {detail}',
  'kernel.layerIndex.invalidJson': 'layer index {label} is not valid JSON: {detail}',
  'kernel.layerIndex.platformMismatch': 'The layer index targets another platform: {indexPlatform}-{indexArch} instead of {platform}-{arch}',

  // ------------------------------------------------- kernel download failure
  'downloadFailure.integrity': 'The downloaded content does not match the official digest, so the download was aborted to prevent tampering. This usually means something in the middle (a proxy or mirror) changed the content; try another network.',
  'downloadFailure.missing': 'The package for this version is not published yet ({sources}). Retry later, or check for updates again from the tray menu.',
  'downloadFailure.network': 'Could not reach any update source ({sources}: GitHub and the mirrors are all unreachable). Check your network and proxy settings, or retry later.',
  'downloadFailure.sources': '{count} sources tried',
  'downloadFailure.reason': '\nCause: {detail}',

  // ------------------------------------------------------- office payload
  'officePayload.status.unsupported': 'This kernel declares no office components (a dev run, or an older kernel); nothing to download',
  'officePayload.status.missing': 'Not installed (v{version} needed)',
  'officePayload.status.installed': 'Installed v{version}',
  'officePayload.status.downloading': 'Downloading {percent}%',
  'officePayload.status.installing': 'Installing the office components…',
  'officePayload.artifactMissing': 'No office-payload artifact office-payload-{platform}-{arch}-{dshVersion}.tgz was found; it may not be published yet — retry later',
  'officePayload.manifestMismatch': 'The office payload does not match this kernel: {detail}',
  'officePayload.downloadFailed': 'Downloading the office components failed: {detail}',
  'officePayload.installFailed': 'Installing the office components failed: {detail}',
}

const TABLES: Readonly<Record<LocaleId, Readonly<Record<string, string>>>> = {
  'zh-CN': ZH_CN,
  'en-US': EN_US,
}

/** The whole table of one locale (read-only; used by the locale test). */
export function messagesFor(locale: LocaleId): Readonly<Record<string, string>> {
  return TABLES[locale]
}

/** `{name}` placeholder in a message template. */
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g
/** Same shape, without the sticky `lastIndex` of a global regex. */
const HAS_PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/

/**
 * Map a locale tag to a supported locale, or null when there is nothing to map
 * (null / blank tag, e.g. an unset override). `zh`, `zh-TW`, `zh-Hans-CN` and
 * `zh_CN` all resolve to zh-CN; every other tag resolves to en-US.
 */
export function resolveLocale(raw: string | null | undefined): LocaleId | null {
  if (raw === null || raw === undefined) return null
  const tag = raw.trim().toLowerCase().replace(/_/g, '-')
  if (tag === '') return null
  return tag.startsWith('zh') ? 'zh-CN' : 'en-US'
}

/**
 * The locale for a run: the environment override wins (it is explicit), then
 * the OS tag, then {@link DEFAULT_LOCALE}.
 */
export function chooseLocale(env: string | null | undefined, system: string | null | undefined): LocaleId {
  return resolveLocale(env) ?? resolveLocale(system) ?? DEFAULT_LOCALE
}

/** The locale tag Electron reports, or null outside Electron / before ready. */
function systemLocale(): string | null {
  try {
    // Required lazily: this module is also loaded by the node test suite, where
    // `electron` resolves to the binary path rather than to its API surface.
    const electron = require('electron') as { app?: { isReady?: () => boolean; getLocale?: () => string } } | undefined
    const api = electron?.app
    if (api === undefined || typeof api.getLocale !== 'function') return null
    // Electron documents getLocale() as valid only after 'ready'; before that
    // there is no answer to remember, so report none (see the module header).
    if (typeof api.isReady === 'function' && !api.isReady()) return null
    const tag = api.getLocale()
    return typeof tag === 'string' && tag !== '' ? tag : null
  } catch {
    return null
  }
}

let cached: LocaleId | null = null

/** The locale in effect for this process (resolved on first use). */
export function getLocale(): LocaleId {
  if (cached !== null) return cached
  const fromEnv = resolveLocale(process.env[LOCALE_ENV])
  if (fromEnv !== null) return (cached = fromEnv)
  const fromSystem = resolveLocale(systemLocale())
  if (fromSystem !== null) return (cached = fromSystem)
  // Nothing real to resolve yet: answer with the default WITHOUT caching, so a
  // module-level string read at import time cannot freeze the wrong language.
  return DEFAULT_LOCALE
}

/**
 * Re-resolve and cache the locale. Called once at boot, after Electron's app is
 * ready — the first point where `app.getLocale()` carries an answer.
 */
export function initLocale(): LocaleId {
  cached = null
  return getLocale()
}

/**
 * One user-visible message, with `{param}` substitution.
 *
 * @param key - a key of the table; unknown keys are impossible in TypeScript
 *   and throw at runtime.
 * @param params - values for the template's placeholders.
 * @throws when the key is missing, when the template needs placeholders and
 *   none were given, or when a referenced placeholder has no value.
 */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const table: Readonly<Record<string, string | undefined>> = TABLES[getLocale()]
  const template = table[key]
  if (template === undefined) throw new Error(`[locale] no message for key "${key}"`)
  if (!HAS_PLACEHOLDER.test(template)) return template
  if (params === undefined) throw new Error(`[locale] key "${key}" needs params`)
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`[locale] key "${key}" is missing param "${name}"`)
    return value.toString()
  })
}

/**
 * The constant head of a message template: the text before its first `{param}`,
 * or the whole template when it has none.
 *
 * Exists so a classifier can recognize a line THIS app threw without repeating
 * the wording — see `kernel/failures.ts`, which classifies a download error by
 * the message it carries. A copied literal would only ever match the language it
 * was copied in, while this stays in step with the table by construction.
 *
 * Resolved against the CURRENT locale, like {@link t}: the line being matched
 * was produced by this process, so it is in this process's language.
 */
export function messageHead(key: MessageKey): string {
  const template = TABLES[getLocale()][key]
  if (template === undefined) throw new Error(`[locale] no message for key "${key}"`)
  const at = template.indexOf('{')
  return at < 0 ? template : template.slice(0, at)
}

/**
 * zh-CN fragments the shell matches inside a KERNEL status line to pick the
 * splash step it advances to (`src/main/startup-window.ts`).
 *
 * This is a FALLBACK, not the primary path: every status the shell produces now
 * carries `KernelStatusPayload.step`, which `stageForMessage()` prefers. The
 * fragments remain for a status that arrives without one — an injected status
 * from an older build, or a new call site that has not declared its step yet.
 * Matching the wording is only possible in zh-CN (the fragments are Chinese and
 * the lines are localized), so a payload that carries no step under any other
 * language degrades to "keep the current step": the status line still tells the
 * truth, only the highlight stops advancing.
 *
 * Steps (1-based) index the progress list in static/startup.html; a line that
 * matches nothing keeps the current step.
 */
export const ZH_KERNEL_STATUS_STEP_KEYWORDS: ReadonlyArray<{ readonly step: number; readonly keywords: readonly string[] }> = [
  { step: 1, keywords: ['校验', '下载', '准备'] },
  { step: 2, keywords: ['解压'] },
  { step: 3, keywords: ['激活'] },
  { step: 4, keywords: ['启动'] },
]

/**
 * Localized name of a kernel update channel ('stable' | 'beta' | 'alpha').
 * An unknown channel is returned verbatim rather than blanked, so an upstream
 * addition degrades to a plain line name instead of an empty label.
 */
export function kernelChannelLabel(channel: KernelChannel): string {
  return channel === 'stable' || channel === 'beta' || channel === 'alpha'
    ? t(`channel.${channel}`)
    : channel
}

/**
 * Localized button label for installing one kernel version in the MODAL update
 * prompt (manual check). The persistent in-page card has its own frozen wording
 * — see the `updateCard.option*` keys.
 *
 * With more than one option the channel is named too: the user is picking a
 * LINE, not just a version, so `0.1.5-rc.2` vs `0.1.5-alpha.3` must be
 * distinguishable.
 */
export function kernelUpdateOptionLabel(version: string, channel: KernelChannel, multiple: boolean): string {
  return multiple
    ? t('kernelUpdate.optionWithChannel', { version, channel: kernelChannelLabel(channel) })
    : t('kernelUpdate.option', { version })
}
