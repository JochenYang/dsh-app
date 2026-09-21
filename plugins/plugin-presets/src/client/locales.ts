/**
 * Dictionary of the preset-packages page (the 预设包 tab of 维护), in this
 * plugin's own locale namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the keys.
 * One namespace per plugin, because a namespace has exactly one owner, and keys
 * carry a page prefix (`presets.`) so a later page of this plugin never
 * collides with this one.
 *
 * zh is the source of truth — it began as the pre-i18n page copy verbatim and
 * is corrected in place when the page's behaviour changes; {@link PresetsKey}
 * is its key union, and the English dictionary is typed with it, so a missing
 * or extra key on either side is a compile error. The same union constrains
 * the page's `t` seat (`PropsLocale`), so a key removed from the dictionary
 * cannot be rendered.
 *
 * Two remarks on the zh values, both consequences of the original i18n
 * migration:
 *
 * - A multi-line JSX text node collapses to one line with single spaces where
 *   the line breaks were; the dictionary carries the collapsed text, which is
 *   what the page rendered before.
 * - Where the pre-i18n code composed a sentence from fragments (a list of
 *   clauses joined by a separator, a conditional tail), the fragments stay
 *   separate keys and each locale's fragment carries its own punctuation — a
 *   joiner hardcoded in code cannot serve both languages.
 *
 * The `presets.host.*` block holds copy the HOST half used to send as Chinese
 * prose. The host is a long-lived child process and never sends prose: it
 * sends a stable code plus the values the sentence interpolates (see
 * `HostText` in `src/wire.ts`), and this dictionary renders it. A `params`
 * value may itself name another key's code — a nested rejection's reason
 * (`{reason}`), the archive a message is about (`{subject}`) or a missing OS
 * error code (`{code}`) — and the section resolves it with the same fallback
 * chain, one level deep.
 *
 * @module @dsh-app/plugin-presets/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.presets'

/** Simplified Chinese dictionary — the source of truth for this page. */
export const zh = {
  'presets.nav': '预设包',
  'presets.backup.title': '配置备份',
  'presets.backup.intro': '导出或恢复当前配置：备份包含模型与 provider 设置（settings.yaml）、AGENTS.md、插件配置、补丁层与 hooks 脚本。已自动扫描常见密钥形态，命中即拒绝导出；密钥本体不在包内（存于凭据库），换机器后需重新填写。包内含 provider 地址、请求头与会在本机执行的 hook 脚本，请当作私有文件，且只导入自己导出的备份——它决定请求去向、免审批范围与本机执行的命令。 依赖清单中的本地 file: 路径会按原样恢复，换机器导入可能失效。',
  'presets.backup.export': '导出配置备份',
  'presets.backup.import': '导入配置备份',
  'presets.backup.pick': '选择配置备份 zip 文件',
  'presets.intro': '把本机的自定义 agent 预设打包为 .dshpreset 文件分享，或从文件导入。仅列出本机自定义预设； 内置预设随应用提供，不可导出。导入时会校验包结构与路径安全，写入本机自定义预设目录， 之后可在会话的预设选择器中选用。',
  'presets.count': '共 {count} 个自定义预设',
  'presets.import.action': '导入预设包',
  'presets.import.pick': '选择 .dshpreset 文件',
  'presets.empty': '还没有可导出的自定义预设。在会话中复制一个现有预设即可创建，或从他人分享的 .dshpreset 文件导入。',
  'presets.row.meta': '{files} 个文件 · {size}',
  'presets.export.aria': '导出预设 {entry}',
  'presets.export.action': '导出',
  'presets.root': '预设目录：{root}',
  'presets.export.done': '已导出 {entry}.dshpreset',
  'presets.import.done': '已导入预设「{entry}」（{files} 个文件），可在会话的预设选择器中选用',
  'presets.import.unknown': '导入响应无法识别',
  'presets.import.tooLarge': '预设包超过 10MB 上限',
  'presets.backup.export.done': '已导出 {file}（密钥扫描未命中）',
  'presets.backup.restore.written': '已恢复 {written} 项配置',
  'presets.backup.restore.unchanged': '，{unchanged} 项无变化跳过',
  'presets.backup.restore.backedUp': '，补丁层与 settings.yaml 已自动备份',
  'presets.backup.restore.tail': '。模型、界面设置与依赖清单变更需重启应用后生效。',
  'presets.backup.tooLarge': '配置备份超过 20MB 上限',
  'presets.request.failed': '请求失败（HTTP {status}）',
  'presets.overwrite.title': '覆盖预设「{entry}」',
  'presets.overwrite.message': '本机已存在同名预设，覆盖导入将替换它的全部文件，且无法撤销。',
  'presets.overwrite.confirm': '覆盖导入',
  'presets.backupOverwrite.title': '覆盖现有配置',
  'presets.backupOverwrite.message': '备份中的以下文件与本机当前配置不同，覆盖导入将替换它们（其中补丁层与 settings.yaml 会先自动备份，其余文件直接替换），且无法撤销：{files}',
  'presets.conflict.none': '（服务器未返回具体清单）',
  'presets.conflict.more': '{head} 等 {count} 个文件',
  'presets.list.separator': '、',
  'presets.dialog.cancel': '取消',
  // --- Coded host messages (see HostText in src/wire.ts): the values below
  // are the sentences the host half used to send already written. ---
  'presets.host.unknownError': '未知错误',
  'presets.host.entryEmpty': '预设名为空',
  'presets.host.entryPattern': '预设名只能使用小写字母、数字以及短横线 -，以字母或数字开头，最长 64 个字符',
  'presets.host.pathEmpty': '路径为空',
  'presets.host.pathBackslash': '路径包含反斜杠',
  'presets.host.pathAbsolute': '路径是绝对路径',
  'presets.host.pathEmptySegment': '路径包含空段',
  'presets.host.pathParentSegment': '路径包含 .. 段',
  'presets.host.pathHiddenSegment': '路径段不能以 . 开头',
  'presets.host.manifestNotJson': 'manifest.json 不是有效的 JSON',
  'presets.host.manifestNotObject': 'manifest.json 应该是一个 JSON 对象',
  'presets.host.subjectPreset': '预设包',
  'presets.host.subjectBackup': '配置备份',
  'presets.host.presetManifestVersion': '预设包格式版本不支持（formatVersion={version}，当前支持 {supported}）',
  'presets.host.presetManifestKind': '这不是预设包（kind={kind}，应为 {expected}）',
  'presets.host.presetManifestEntryMissing': 'manifest.json 缺少预设名（entry）',
  'presets.host.presetManifestEntryInvalid': 'manifest.json 中的预设名不合法：{reason}',
  'presets.host.presetEntryInvalid': '预设名不合法：{reason}',
  'presets.host.presetUnknownEntry': '预设「{entry}」不存在，或不是可导出的自定义预设（内置预设不可导出）',
  'presets.host.presetCompositionMissing': '预设包缺少 {file}，导入后无法被内核识别，已拒绝',
  'presets.host.presetManifestMissing': '预设包缺少 manifest.json，不是有效的预设包',
  'presets.host.presetNotZip': '无法读取预设包：不是有效的 ZIP 数据',
  'presets.host.presetDuplicateMember': '预设包含重复的成员名「{name}」，已拒绝',
  'presets.host.presetDecompressedTooLarge': '预设包解压后总大小超过 {mb}MB 上限，已拒绝',
  'presets.host.presetImportTooManyFiles': '预设包含 {count} 个文件，超过单包 {cap} 个的上限，已拒绝',
  'presets.host.presetExportTooManyFiles': '预设包含 {count} 个文件，超过单包 {cap} 个的上限，无法导出',
  'presets.host.presetExportTooLarge': '预设总大小超过 {mb}MB 上限，无法导出',
  'presets.host.presetArchiveTooLarge': '打包后的预设包超过 {mb}MB 上限，无法导出',
  'presets.host.presetIllegalPath': '预设包内存在不允许的路径「{path}」：{reason}，已拒绝',
  'presets.host.presetOutsidePayload': '预设包内存在预设目录之外的文件「{path}」，已拒绝',
  'presets.host.presetReadDirFailed': '读取预设目录失败（{code}）',
  'presets.host.presetReadFileFailed': '读取预设文件失败（{code}）',
  'presets.host.presetReadRootFailed': '读取预设根目录失败（{code}）',
  'presets.host.presetWriteFailed': '写入预设目录失败（{code}）',
  'presets.host.backupManifestVersion': '配置备份格式版本不支持（formatVersion={version}，当前支持 {supported}）',
  'presets.host.backupManifestKind': '这不是配置备份（kind={kind}，应为 {expected}）',
  'presets.host.backupStoreEntryShape': '插件存储条目必须是 plugins/<目录>/<文件> 两层',
  'presets.host.backupStoreDirInvalid': '插件存储目录名不合法：「{dir}」',
  'presets.host.backupStoreFileNotAllowed': '插件存储文件不在白名单内：「{file}」',
  'presets.host.backupStoreFileSensitive': '插件存储文件疑似包含凭据：「{file}」',
  'presets.host.backupHookFileInvalid': 'hooks 目录下的文件名不合法：「{name}」（仅顶层，且只允许字母、数字、点、下划线与短横线）',
  'presets.host.backupHookFileSensitive': 'hooks 文件疑似包含凭据：「{name}」',
  'presets.host.backupUnknownBlock': '路径不属于配置备份的任何已知区块',
  'presets.host.backupSecretContent': '配置文件「{rel}」命中疑似凭据内容（规则 {rule}），已拒绝导出；请移除该文件中的凭据后重试',
  'presets.host.backupExportTooManyFiles': '配置备份包含 {count} 个文件，超过单包 {cap} 个的上限，无法导出',
  'presets.host.backupExportTooLarge': '配置备份总大小超过 {mb}MB 上限，无法导出',
  'presets.host.backupArchiveTooLarge': '打包后的配置备份超过 {mb}MB 上限，无法导出',
  'presets.host.backupDuplicateMember': '配置备份包含重复的成员名「{name}」，已拒绝',
  'presets.host.backupNotZip': '无法读取配置备份：不是有效的 ZIP 数据',
  'presets.host.backupDecompressedTooLarge': '配置备份解压后总大小超过 {mb}MB 上限，已拒绝',
  'presets.host.backupImportTooManyFiles': '配置备份包含 {count} 个文件，超过单包 {cap} 个的上限，已拒绝',
  'presets.host.backupIllegalPath': '配置备份内存在不允许的路径「{path}」：{reason}，已拒绝',
  'presets.host.backupManifestMissing': '配置备份缺少 manifest.json，不是有效的备份包',
  'presets.host.backupWriteFailed': '写入配置文件失败（{code}）',
  'presets.host.backupWriteFailedRestored': '写入配置文件失败（{code}），已自动还原本次导入的全部变更',
  'presets.host.backupWriteFailedRollbackFailed': '写入配置文件失败（{code}），部分变更自动还原失败，请检查上述配置文件的当前内容',
  'presets.host.zipDataDescriptor': '{subject}使用了不支持的数据描述符条目「{name}」，已拒绝',
  'presets.host.zipUndeclaredMember': '{subject}内存在未声明的成员「{name}」，已拒绝',
  'presets.host.zipCorrupt': '无法解压{subject}：ZIP 数据损坏',
  'presets.host.zipSizeMismatch': '{subject}成员「{name}」的实际内容与声明不符，已拒绝',
  'presets.host.zipTotalTooLarge': '{subject}解压后总大小超过 {mb}MB 上限，已拒绝',
  'presets.host.zipMemberMissing': '{subject}缺少声明的成员「{name}」，已拒绝',
  'presets.host.routeListFailed': '读取预设列表失败',
  'presets.host.routeExportFailed': '导出预设失败',
  'presets.host.routeBackupExportFailed': '导出配置备份失败',
  'presets.host.routeImportUnreadable': '导入失败：请求内容无法识别',
  'presets.host.routePresetTooLarge': '预设包超过 {mb}MB 上限',
  'presets.host.routeBackupTooLarge': '配置备份超过 {mb} 上限',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<PresetsKey, string> = {
  'presets.nav': 'Presets',
  'presets.backup.title': 'Configuration backup',
  'presets.backup.intro': 'Export or restore the current configuration: the backup carries model and provider settings (settings.yaml), AGENTS.md, plugin configs, the patch layer, and hook scripts. Common credential shapes are scanned automatically, and a hit refuses the export; the keys themselves are not in the package (they live in the credential store), so a new machine needs them re-entered. The package holds provider endpoints, request headers, and hook scripts that run on this machine, so treat it as a private file and import only a backup you exported yourself — it decides where requests go, what runs without approval, and which commands execute locally. Local file: paths in the dependency list are restored as-is, so importing on another machine may not work.',
  'presets.backup.export': 'Export configuration backup',
  'presets.backup.import': 'Import configuration backup',
  'presets.backup.pick': 'Choose a configuration-backup zip file',
  'presets.intro': 'Package your local custom agent presets into .dshpreset files to share, or import one from a file. Only local custom presets are listed; built-in presets ship with the app and cannot be exported. An import validates the package structure and path safety, writes into your local custom preset directory, and the session preset picker can then use it.',
  'presets.count': '{count} custom presets',
  'presets.import.action': 'Import preset package',
  'presets.import.pick': 'Choose a .dshpreset file',
  'presets.empty': 'No custom presets to export yet. Copy an existing preset in a session to create one, or import a .dshpreset file someone shared.',
  'presets.row.meta': '{files} files · {size}',
  'presets.export.aria': 'Export preset {entry}',
  'presets.export.action': 'Export',
  'presets.root': 'Preset directory: {root}',
  'presets.export.done': 'Exported {entry}.dshpreset',
  'presets.import.done': 'Imported the preset "{entry}" ({files} files); the session preset picker can now use it',
  'presets.import.unknown': 'Unrecognized import response',
  'presets.import.tooLarge': 'The preset package exceeds the 10MB limit',
  'presets.backup.export.done': 'Exported {file} (no credential pattern matched)',
  'presets.backup.restore.written': 'Restored {written} configuration items',
  'presets.backup.restore.unchanged': ', {unchanged} unchanged and skipped',
  'presets.backup.restore.backedUp': ', the patch layer and settings.yaml were backed up first',
  'presets.backup.restore.tail': '. Model, interface, and dependency-list changes take effect after an app restart.',
  'presets.backup.tooLarge': 'The configuration backup exceeds the 20MB limit',
  'presets.request.failed': 'Request failed (HTTP {status})',
  'presets.overwrite.title': 'Overwrite preset "{entry}"',
  'presets.overwrite.message': 'A preset with this name already exists. Importing with overwrite replaces every file of it and cannot be undone.',
  'presets.overwrite.confirm': 'Overwrite',
  'presets.backupOverwrite.title': 'Overwrite the current configuration',
  'presets.backupOverwrite.message': 'These files in the backup differ from the current configuration; importing with overwrite replaces them (of which the patch layer and settings.yaml are backed up first, the rest are replaced outright) and cannot be undone: {files}',
  'presets.conflict.none': '(the server returned no file list)',
  'presets.conflict.more': '{head} and {count} files in total',
  'presets.list.separator': ', ',
  'presets.dialog.cancel': 'Cancel',
  // --- Coded host messages; see the zh block above for the contract. ---
  'presets.host.unknownError': 'unknown error',
  'presets.host.entryEmpty': 'the preset name is empty',
  'presets.host.entryPattern': 'a preset name is lowercase letters, digits and hyphens only, starts with a letter or digit, and is at most 64 characters',
  'presets.host.pathEmpty': 'the path is empty',
  'presets.host.pathBackslash': 'the path contains a backslash',
  'presets.host.pathAbsolute': 'the path is absolute',
  'presets.host.pathEmptySegment': 'the path contains an empty segment',
  'presets.host.pathParentSegment': 'the path contains a .. segment',
  'presets.host.pathHiddenSegment': 'a path segment starts with a dot',
  'presets.host.manifestNotJson': 'manifest.json is not valid JSON',
  'presets.host.manifestNotObject': 'manifest.json must be a JSON object',
  'presets.host.subjectPreset': 'the preset package',
  'presets.host.subjectBackup': 'the configuration backup',
  'presets.host.presetManifestVersion': 'unsupported preset package formatVersion {version} (this build supports {supported})',
  'presets.host.presetManifestKind': 'not a preset package (kind={kind}, expected {expected})',
  'presets.host.presetManifestEntryMissing': 'manifest.json has no entry (preset name)',
  'presets.host.presetManifestEntryInvalid': 'the preset name in manifest.json is invalid: {reason}',
  'presets.host.presetEntryInvalid': 'invalid preset name: {reason}',
  'presets.host.presetUnknownEntry': 'preset "{entry}" does not exist, or is not an exportable custom preset (built-in presets cannot be exported)',
  'presets.host.presetCompositionMissing': 'the preset package has no {file}, so the kernel would not recognize it after import; refused',
  'presets.host.presetManifestMissing': 'the preset package has no manifest.json, so it is not a valid preset package',
  'presets.host.presetNotZip': 'cannot read the preset package: not valid ZIP data',
  'presets.host.presetDuplicateMember': 'the preset contains a duplicate member name "{name}"; refused',
  'presets.host.presetDecompressedTooLarge': 'the decompressed preset exceeds the {mb} MB cap; refused',
  'presets.host.presetImportTooManyFiles': 'the preset has {count} files, over the {cap}-file per-package cap; refused',
  'presets.host.presetExportTooManyFiles': 'the preset has {count} files, over the {cap}-file per-package cap; it cannot be exported',
  'presets.host.presetExportTooLarge': 'the preset is over the {mb} MB total-size cap; it cannot be exported',
  'presets.host.presetArchiveTooLarge': 'the packed preset archive is over the {mb} MB cap; it cannot be exported',
  'presets.host.presetIllegalPath': 'the preset package contains a forbidden path "{path}": {reason}; refused',
  'presets.host.presetOutsidePayload': 'the preset package contains a file outside the preset directory: "{path}"; refused',
  'presets.host.presetReadDirFailed': 'cannot read the preset directory ({code})',
  'presets.host.presetReadFileFailed': 'cannot read a preset file ({code})',
  'presets.host.presetReadRootFailed': 'cannot read the preset root directory ({code})',
  'presets.host.presetWriteFailed': 'cannot write into the preset directory ({code})',
  'presets.host.backupManifestVersion': 'unsupported configuration-backup formatVersion {version} (this build supports {supported})',
  'presets.host.backupManifestKind': 'not a configuration backup (kind={kind}, expected {expected})',
  'presets.host.backupStoreEntryShape': 'a plugin store entry must be exactly plugins/<directory>/<file>',
  'presets.host.backupStoreDirInvalid': 'invalid plugin store directory name: "{dir}"',
  'presets.host.backupStoreFileNotAllowed': 'the plugin store file is not whitelisted: "{file}"',
  'presets.host.backupStoreFileSensitive': 'the plugin store file looks credential-bearing: "{file}"',
  'presets.host.backupHookFileInvalid': 'invalid file name under the hooks directory: "{name}" (top level only, letters, digits, dot, underscore and dash)',
  'presets.host.backupHookFileSensitive': 'the hook file looks credential-bearing: "{name}"',
  'presets.host.backupUnknownBlock': 'the path belongs to no known section of a configuration backup',
  'presets.host.backupSecretContent': 'configuration file "{rel}" matched a credential-like pattern (rule {rule}); the export was refused. Remove the credential from that file and try again',
  'presets.host.backupExportTooManyFiles': 'the configuration backup has {count} files, over the {cap}-file per-package cap; it cannot be exported',
  'presets.host.backupExportTooLarge': 'the configuration backup is over the {mb} MB total-size cap; it cannot be exported',
  'presets.host.backupArchiveTooLarge': 'the packed configuration backup is over the {mb} MB cap; it cannot be exported',
  'presets.host.backupDuplicateMember': 'the configuration backup contains a duplicate member name "{name}"; refused',
  'presets.host.backupNotZip': 'cannot read the configuration backup: not valid ZIP data',
  'presets.host.backupDecompressedTooLarge': 'the decompressed configuration backup exceeds the {mb} MB cap; refused',
  'presets.host.backupImportTooManyFiles': 'the configuration backup has {count} files, over the {cap}-file per-package cap; refused',
  'presets.host.backupIllegalPath': 'the configuration backup contains a forbidden path "{path}": {reason}; refused',
  'presets.host.backupManifestMissing': 'the configuration backup has no manifest.json, so it is not a valid backup package',
  'presets.host.backupWriteFailed': 'cannot write a configuration file ({code})',
  'presets.host.backupWriteFailedRestored': 'cannot write a configuration file ({code}); every change of this import was rolled back',
  'presets.host.backupWriteFailedRollbackFailed': 'cannot write a configuration file ({code}); the automatic rollback of some changes failed, so check the current content of those files',
  'presets.host.zipDataDescriptor': '{subject} uses an unsupported data-descriptor entry "{name}"; refused',
  'presets.host.zipUndeclaredMember': '{subject} contains an undeclared member "{name}"; refused',
  'presets.host.zipCorrupt': 'cannot decompress {subject}: the ZIP data is corrupt',
  'presets.host.zipSizeMismatch': 'the actual content of {subject} member "{name}" does not match its declared size; refused',
  'presets.host.zipTotalTooLarge': '{subject} exceeds the {mb} MB decompressed-size cap; refused',
  'presets.host.zipMemberMissing': '{subject} is missing the declared member "{name}"; refused',
  'presets.host.routeListFailed': 'could not read the preset list',
  'presets.host.routeExportFailed': 'could not export the preset',
  'presets.host.routeBackupExportFailed': 'could not export the configuration backup',
  'presets.host.routeImportUnreadable': 'import failed: the request content could not be recognized',
  'presets.host.routePresetTooLarge': 'the preset package exceeds the {mb} MB cap',
  'presets.host.routeBackupTooLarge': 'the configuration backup exceeds the {mb} cap',
}

/** Key domain of the `dsh-app.presets` namespace (zh is the source of truth). */
export type PresetsKey = keyof typeof zh
