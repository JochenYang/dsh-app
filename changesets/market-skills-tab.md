---
shell: none
plugins: plugin-market
---

插件市场新增「技能」页签：接入公开技能目录（服务端搜索、分类筛选、分页），技能以 zip 下载后安装到 `$DSH_HOME/skills`（逐条目路径校验 + 暂存目录原子替换，缺 SKILL.md 即拒装），支持已装列表（文件数/体积）与卸载；安装后提示内核下次扫描时发现。分类标签与全部界面文案走双语词典；zip 解压错误改为英文诊断。
The plugin market gains a Skills tab: the public skills catalog is in (server-side search, category chips, paging), skills install as zips into `$DSH_HOME/skills` (per-entry path checks + staged atomic replace, missing SKILL.md refused), with an installed list (file count/size) and uninstall; the hint after install is that the kernel discovers it on its next scan. Category labels and every string ride the bilingual dictionaries, and zip extraction errors are English diagnostics.
