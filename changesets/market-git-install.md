---
shell: none
plugins: plugin-market
---

插件市场：目录里未发布 npm 包的 GitHub 仓库源码插件（实测 1774 条）现在可以直接安装——目标按白名单校验为 `github:owner/repo` 后原样交给内核 CLI，具体提交由 pnpm 解析并记录进本 profile 的 lockfile；安装确认弹窗说明来源是仓库源码而非 npm registry，卡片新增「GitHub 源码」徽章，安装后卡片通过仓库身份与已安装视图对上并显示「Git 安装」。npm 安装路径行为不变，模型面安装工具仍只装 npm 包（对这类条目如实报告不可安装）。
Market plugin: catalog entries that publish no npm package (1774 rows measured) can now be installed from their GitHub repository source — the target is whitelist-validated as `github:owner/repo` and handed to the kernel CLI unchanged, with pnpm resolving the commit and recording it in this profile's lockfile. The confirm dialog states the source is repository code rather than an npm release, cards gain a "GitHub source" badge, and an installed git plugin matches its card through the repository identity. The npm install path is unchanged, and the model-facing install tool still installs npm packages only (it reports these rows as not installable).
