# 内核交付改为「包集」（profile 自持核心）

> 2026-09-17 立项。来源：上游桌面端 0.1.6-alpha.2 的组装方式调研
> （`apps/desktop/scripts/prepare-package-set.ts`、`prepare-dsh.ts`、
> `src/core-package-set.ts`、`src/project-manager.ts:139`）。
> **已定的方向**：学它的「装法」，不学它的「版本绑定应用发布」。

## 为什么

我们现在的内核是**预装好的运行树**：CI 六格产物 → `runtime-<v>` GitHub 附件（+ 镜像链）→
解压进 `kernel/<v>/` → 写 `current.json` 激活。rc 线还要把这棵树**硬链接镜像**进 profile，
而那份镜像在 pnpm 眼里是外来物——市场在同一个 profile 里跑一次 pnpm 就会把它当多余包剪掉
（实测：镜像条目被清空，下次启动重做 25397 个文件、14–17 秒）。

上游的做法：核心包（`@deepseek-ai/dsh` + 私有宿主）打成**本地 npm tarball 集** +
摘要清单（`desktop-packages.json`：name/version/bytes/sha512）随应用走，由 pnpm **离线装进
profile**。核心因此是 profile 清单里的**声明依赖**——pnpm 不会剪它；`runtimeDir` 也能直接
指 profile（宿主的 `installAnchor = <runtimeDir>/node_modules/@deepseek-ai/dsh/package.json`
正是为此设计的）。

## 方案（三步）

1. **产物形态**：运行时产物从「预装树 tgz」改为「tarball 集 + 摘要清单」，每平台一份。
   `scripts/build-runtime.mjs` 已经在做大部分前置（npm-pack 各插件与私有宿主、锁文件驱动的
   pnpm 组装、按层出 tgz），改的是最后一步：打包集而不是打树。层缓存的价值不丢——更新只下
   变化的 tarball。
2. **客户端**：`KernelManager` 从「下载 → 解压 → 写 `current.json` 激活」改为
   「把包集装进 profile」（pnpm 离线、`--frozen-lockfile`、摘要逐个校验）。激活 = 指向新装好
   的 profile 状态；回滚 = 用保留的上一份包集重装；`hostProfileAnchor` 的 profile 旁路与
   `mirrorRuntimeIntoProfile` / `dropRuntimeMirror` 整体退场，`runtimeDir` 指 profile。
3. **迁移**：已装用户从 `kernel/<v>/` 迁到 profile 形式——一次性把核心重装进 profile，
   `$DSH_HOME` 下的会话/设置/凭据/插件 storages 不受影响；内置内核从「采纳已解压树」变成
   「随安装包带一份包集」。

顺带落地：alpha.2 线要求的 office 载荷（`<runtimeDir>/../runtime/office-skills`）随包集一起发，
不再单独补一次。

## 明确不做

**内核版本绑定应用版本**。上游的包集版本与 `release.version` 绑定
（`verifyDesktopCorePackageSet(projectDir, release.version)`），换内核 = 换应用。对我们意味着
每次 dsh 更新都要发新安装包（200 MB 级），而现在的通道约 10 MB（只下变化的层），并且我们能
跟上游 alpha/rc 的节奏而不发安装包。通道保留：独立解析 → 下载 → 校验 → 可回滚。

## 风险与验收

- 新增耦合：pnpm 进入**启动关键路径**（今天只有市场用它）。核心是声明依赖，方向一致，但要验
  三种情形：无网、pnpm store 为空、市场正在装插件时换内核（并发互斥）。
- 验收：全新安装（断网）能起；内核更新只下变化 tarball；回滚一次成功；市场装卸不再影响核心；
  `npm run smoke:package` 与 `npm run check:plugins` 在真实产物上通过；两条支持线的启动参数
  形状（`hostArgShape`）在 profile 形态下不变。
