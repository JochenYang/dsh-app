---
shell: none
plugins: plugin-workbench
---

工作台插件：侧栏面板列表的「更多」菜单新增「在工作台里新建插件」，用来进入创造模式并带上工作台专用的开场提示（按界面语言取字典文案）；宿主半边把座位契约装成 `dsh-app-workbench-card` 技能，产出的插件据此注册进卡片与页面两个座位。技能正文自带完整的座位声明与 owner props 名单，并写明打包挂载归 `cordis-plugin-development`、数据落在 `$DSH_HOME/storages/<plugin-name>/`、宿主路由走会话连接，因此不指向任何仓库路径，在任意工作区里都够用。
Workbench plugin: the sidebar panel list's More menu gains "Create a plugin in the workbench", which opens Creator mode with a workbench-specific prompt taken from the dictionary in the active language; the host half now installs the seat-contract skill `dsh-app-workbench-card`, so the plugin it produces registers into both of the container's card seats. The skill body carries the declaration and the owner-prop list itself and says where everything else lives (packaging is the `cordis-plugin-development` skill, data goes to `$DSH_HOME/storages/<plugin-name>/`, host routes ride the session connection), with no repository path in it — so it works from any workspace.
