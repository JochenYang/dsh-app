/**
 * Dictionary of the Git view tab (the sidebar dock), in the plugin's own
 * locale namespace.
 *
 * The namespace is declared by the client entry (`src/client/index.tsx`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the
 * keys. One namespace per plugin, because a namespace has exactly one owner,
 * and every key carries a surface prefix (`branch.`, `commit.`, `list.`,
 * `files.`, `graph.`, `restore.`, `stash.`) so two surfaces never collide.
 *
 * zh is the source of truth and stays byte-identical to the pre-i18n tab
 * copy; {@link SidebarKey} is its key union, and the English dictionary is
 * typed with it, so a missing or extra key on either side is a compile error.
 * The same union constrains the view's `t` seat (`PropsLocale`), so a key
 * removed from the dictionary cannot be rendered.
 *
 * Not here, by policy: the tab label `Git` (a brand token — the same slots
 * carry `对话`/`审查`/`轨迹` upstream), git's own porcelain status letters and
 * stdout excerpts, single-glyph affordances (`⎇ ↑ ↓ ✕ ↺ ◈ −`), and the wire
 * error text of the host routes, all of which the tab shows verbatim. Every
 * sentence the tab itself writes — including its loading, empty and failure
 * wording — lives in this table.
 *
 * @module @dsh-app/plugin-sidebar/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.sidebar'

/** Simplified Chinese dictionary — the pre-i18n tab copy, verbatim. */
export const zh = {
  'sidebar.loading': '加载中…',
  'sidebar.retry': '重试',
  'sidebar.refresh': '刷新',
  'sidebar.refreshAria': '刷新 Git 状态',
  'sidebar.cancel': '取消',
  'sidebar.noSession': '打开一个会话后，可在这里查看其工作区的 Git 状态。',
  'sidebar.resizeAria': '调整面板宽度',

  'sidebar.fail.gitMissing': '未找到 Git，请先安装 Git 或检查 PATH。',
  'sidebar.fail.timeout': '网络操作超时，请检查网络或远程仓库后重试。',
  'sidebar.fail.forbidden': '当前会话的工作区校验失败，请刷新会话后重试。',
  'sidebar.fail.generic': 'Git 操作失败。',
  'sidebar.fail.detail': 'Git 操作失败：{detail}',
  'sidebar.fail.noSession': '当前会话缺少安全标识，请重新打开该会话。',
  // The six below used to be sent BY THE HOST as sentences; the host now sends
  // a code (`git.noRemote*` / `git.detachedPull` / `git.branchName*`) and these
  // entries keep the copy byte-identical to what the tab already displayed.
  'sidebar.fail.noRemoteSync': '当前仓库未配置可用的远程（remote），无法同步',
  'sidebar.fail.noRemotePull': '当前仓库未配置可用的远程（remote），无法拉取',
  'sidebar.fail.noRemotePush': '当前仓库未配置可用的远程（remote），无法推送',
  'sidebar.fail.detachedPull': '当前处于分离头指针（detached HEAD）状态，无法拉取',
  'sidebar.fail.branchNameMissing': '缺少分支名',
  'sidebar.fail.branchNameInvalid': '无效的分支名（仅支持字母、数字、点、下划线、连字符与斜杠，且不能以 .. 开头）',

  'sidebar.branch.loading': '正在读取 Git…',
  'sidebar.branch.unavailable': 'Git 状态不可用',
  'sidebar.branch.detached': '⎇ 分离头指针',
  'sidebar.branch.unnamed': '（未命名分支）',
  'sidebar.branch.named': '⎇ {branch}',
  'sidebar.branch.switch': '切换分支',
  'sidebar.branch.local': '本地分支',
  'sidebar.branch.reading': '正在读取分支…',
  'sidebar.branch.empty': '暂无本地分支。',
  'sidebar.branch.current': '当前分支：{name}',
  'sidebar.branch.switchTo': '切换到 {name}',
  'sidebar.branch.switched': '已切换到 {name}',
  'sidebar.branch.newName': '新分支名称',
  'sidebar.branch.create': '创建',
  'sidebar.branch.created': '已创建并切换到 {name}',
  'sidebar.branch.ahead': '领先远程 {count} 个提交',
  'sidebar.branch.behind': '落后远程 {count} 个提交',

  'sidebar.sync.group': '远程同步',
  'sidebar.pull.title': '拉取远程更新（仅快进合并）',
  'sidebar.pull.aria': '拉取远程更新',
  'sidebar.pull.action': '拉取',
  'sidebar.pull.done': '已拉取',
  'sidebar.pull.upToDate': '已是最新，无新提交',
  'sidebar.push.title': '推送本地提交到远程',
  'sidebar.push.aria': '推送本地提交到远程',
  'sidebar.push.action': '推送',
  'sidebar.push.done': '已推送',
  'sidebar.push.upToDate': '远程已是最新，无可推送',
  'sidebar.fetch.title': '同步远程状态（不合并）',
  'sidebar.fetch.aria': '同步远程状态',
  'sidebar.fetch.action': '同步',
  'sidebar.fetch.done': '已同步远程状态',

  'sidebar.stash.group': '贮藏',
  'sidebar.stash.pushTitle': '将当前修改入栈贮藏（含未跟踪文件）',
  'sidebar.stash.pushAria': '入栈贮藏当前修改',
  'sidebar.stash.push': '入栈',
  'sidebar.stash.pushDone': '已贮藏当前修改',
  'sidebar.stash.popTitle': '弹出最近一次贮藏',
  'sidebar.stash.popAria': '弹出最近一次贮藏',
  'sidebar.stash.pop': '弹出',
  'sidebar.stash.popDone': '已弹出贮藏',

  'sidebar.commit.placeholder': '提交信息（提交前可查看全部变更）',
  'sidebar.commit.label': '提交信息',
  'sidebar.commit.title': '提交已暂存的内容',
  'sidebar.commit.action': '提交',
  'sidebar.commit.done': '已提交',

  'sidebar.list.aria': 'Git 列表',
  'sidebar.list.changes': '变更（{count}）',
  'sidebar.list.files': '仓库文件',
  'sidebar.stageAll': '全部暂存',
  'sidebar.stageAll.done': '已暂存全部变更',
  'sidebar.unstageAll': '全部取消暂存',
  'sidebar.unstageAll.done': '已取消全部暂存',
  'sidebar.status.loading': '正在读取 Git 状态…',
  'sidebar.status.clean': '工作区干净。',
  'sidebar.status.staged': '已暂存（{count}）',
  'sidebar.status.noStaged': '无已暂存变更。',
  'sidebar.detail.empty': '点击左侧文件查看预览。',

  'sidebar.action.stage': '暂存 {path}',
  'sidebar.action.unstage': '取消暂存 {path}',
  'sidebar.action.staged': '已暂存',
  'sidebar.action.unstaged': '已取消暂存',
  'sidebar.action.restore': '还原 {path}',
  'sidebar.action.restored': '已还原',

  'sidebar.diff.empty': '无差异（未变更）',
  'sidebar.diff.truncated': '差异较大，仅显示前 500 KB。',
  'sidebar.files.hint': '仓库跟踪文件——点击查看它与 HEAD 的差异；无变化的文件标注“未变更”。',
  'sidebar.files.loading': '正在读取仓库文件…',
  'sidebar.files.truncated': '仓库文件较多，仅显示前 20,000 个。',
  'sidebar.files.empty': '仓库无跟踪文件。',

  'sidebar.graph.open': '◈ 图谱',
  'sidebar.graph.title': 'Git 图谱',
  'sidebar.graph.close': '关闭图谱',
  'sidebar.graph.back': '← 返回图谱',
  'sidebar.graph.commit': 'commit {sha}',
  'sidebar.graph.noBody': '（该提交没有正文）',
  'sidebar.graph.empty': '暂无提交。',
  'sidebar.graph.rowTitle': '查看提交变更',
  'sidebar.graph.readFailed': '读取失败：{message}',

  'sidebar.restore.title': '还原文件？',
  'sidebar.restore.before': '这会丢弃 ',
  'sidebar.restore.after': ' 的未暂存修改，且无法从 Git 管理面板恢复。',
  'sidebar.restore.confirm': '确认还原',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<SidebarKey, string> = {
  'sidebar.loading': 'Loading…',
  'sidebar.retry': 'Retry',
  'sidebar.refresh': 'Refresh',
  'sidebar.refreshAria': 'Refresh Git status',
  'sidebar.cancel': 'Cancel',
  'sidebar.noSession': 'Open a session to see the Git state of its workspace here.',
  'sidebar.resizeAria': 'Resize the panel',

  'sidebar.fail.gitMissing': 'Git was not found. Install Git or check your PATH.',
  'sidebar.fail.timeout': 'The network operation timed out. Check your network or the remote, then retry.',
  'sidebar.fail.forbidden': 'The workspace check for this session failed. Refresh the session and retry.',
  'sidebar.fail.generic': 'The Git operation failed.',
  'sidebar.fail.detail': 'The Git operation failed: {detail}',
  'sidebar.fail.noSession': 'This session has no security identity; reopen it.',
  'sidebar.fail.noRemoteSync': 'This repository has no usable remote, so it cannot be synced',
  'sidebar.fail.noRemotePull': 'This repository has no usable remote, so it cannot be pulled from',
  'sidebar.fail.noRemotePush': 'This repository has no usable remote, so it cannot be pushed to',
  'sidebar.fail.detachedPull': 'This repository is on a detached HEAD, so it cannot be pulled',
  'sidebar.fail.branchNameMissing': 'A branch name is required',
  'sidebar.fail.branchNameInvalid': 'Invalid branch name (letters, digits, dot, underscore, hyphen and slash only; it may not start with "..")',

  'sidebar.branch.loading': 'Reading Git…',
  'sidebar.branch.unavailable': 'Git status unavailable',
  'sidebar.branch.detached': '⎇ detached HEAD',
  'sidebar.branch.unnamed': '(unnamed branch)',
  'sidebar.branch.named': '⎇ {branch}',
  'sidebar.branch.switch': 'Switch branch',
  'sidebar.branch.local': 'Local branches',
  'sidebar.branch.reading': 'Reading branches…',
  'sidebar.branch.empty': 'No local branches.',
  'sidebar.branch.current': 'Current branch: {name}',
  'sidebar.branch.switchTo': 'Switch to {name}',
  'sidebar.branch.switched': 'Switched to {name}',
  'sidebar.branch.newName': 'New branch name',
  'sidebar.branch.create': 'Create',
  'sidebar.branch.created': 'Created and switched to {name}',
  'sidebar.branch.ahead': '{count} commits ahead of the remote',
  'sidebar.branch.behind': '{count} commits behind the remote',

  'sidebar.sync.group': 'Remote sync',
  'sidebar.pull.title': 'Pull remote updates (fast-forward only)',
  'sidebar.pull.aria': 'Pull remote updates',
  'sidebar.pull.action': 'Pull',
  'sidebar.pull.done': 'Pulled',
  'sidebar.pull.upToDate': 'Already up to date; no new commits',
  'sidebar.push.title': 'Push local commits to the remote',
  'sidebar.push.aria': 'Push local commits to the remote',
  'sidebar.push.action': 'Push',
  'sidebar.push.done': 'Pushed',
  'sidebar.push.upToDate': 'The remote is already up to date; nothing to push',
  'sidebar.fetch.title': 'Sync the remote state (no merge)',
  'sidebar.fetch.aria': 'Sync the remote state',
  'sidebar.fetch.action': 'Fetch',
  'sidebar.fetch.done': 'Remote state synced',

  'sidebar.stash.group': 'Stash',
  'sidebar.stash.pushTitle': 'Stash the current changes (including untracked files)',
  'sidebar.stash.pushAria': 'Stash the current changes',
  'sidebar.stash.push': 'Stash',
  'sidebar.stash.pushDone': 'Current changes stashed',
  'sidebar.stash.popTitle': 'Pop the most recent stash',
  'sidebar.stash.popAria': 'Pop the most recent stash',
  'sidebar.stash.pop': 'Pop',
  'sidebar.stash.popDone': 'Stash popped',

  'sidebar.commit.placeholder': 'Commit message (review every change before committing)',
  'sidebar.commit.label': 'Commit message',
  'sidebar.commit.title': 'Commit the staged changes',
  'sidebar.commit.action': 'Commit',
  'sidebar.commit.done': 'Committed',

  'sidebar.list.aria': 'Git list',
  'sidebar.list.changes': 'Changes ({count})',
  'sidebar.list.files': 'Repository files',
  'sidebar.stageAll': 'Stage all',
  'sidebar.stageAll.done': 'All changes staged',
  'sidebar.unstageAll': 'Unstage all',
  'sidebar.unstageAll.done': 'All changes unstaged',
  'sidebar.status.loading': 'Reading Git status…',
  'sidebar.status.clean': 'The working tree is clean.',
  'sidebar.status.staged': 'Staged ({count})',
  'sidebar.status.noStaged': 'Nothing is staged.',
  'sidebar.detail.empty': 'Click a file on the left to preview it.',

  'sidebar.action.stage': 'Stage {path}',
  'sidebar.action.unstage': 'Unstage {path}',
  'sidebar.action.staged': 'Staged',
  'sidebar.action.unstaged': 'Unstaged',
  'sidebar.action.restore': 'Restore {path}',
  'sidebar.action.restored': 'Restored',

  'sidebar.diff.empty': 'No differences (not modified)',
  'sidebar.diff.truncated': 'The diff is large; only the first 500 KB is shown.',
  'sidebar.files.hint': 'Tracked files — click one to see its diff against HEAD; files with no changes are marked "not modified".',
  'sidebar.files.loading': 'Reading repository files…',
  'sidebar.files.truncated': 'The repository has many files; only the first 20,000 are shown.',
  'sidebar.files.empty': 'The repository has no tracked files.',

  'sidebar.graph.open': '◈ Graph',
  'sidebar.graph.title': 'Git graph',
  'sidebar.graph.close': 'Close the graph',
  'sidebar.graph.back': '← Back to the graph',
  'sidebar.graph.commit': 'commit {sha}',
  'sidebar.graph.noBody': '(this commit has no body)',
  'sidebar.graph.empty': 'No commits.',
  'sidebar.graph.rowTitle': 'View the commit changes',
  'sidebar.graph.readFailed': 'Could not read: {message}',

  'sidebar.restore.title': 'Restore this file?',
  'sidebar.restore.before': 'This discards the unstaged changes to ',
  'sidebar.restore.after': ' and they cannot be recovered from the Git panel.',
  'sidebar.restore.confirm': 'Restore',
}

/** Key domain of the `dsh-app.sidebar` namespace (zh is the source of truth). */
export type SidebarKey = keyof typeof zh
