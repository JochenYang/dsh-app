---
shell: none
plugins: plugin-sidebar
---

Git 面板：大文件 diff（如 lockfile、打包产物）不再因 4 MiB 读取上限报错，改为读取后按既有长度截断；输出确实超限时给出明确、可行动的提示，不再回显 diff 片段。
Git panel: large-file diffs (lockfiles, build output) no longer fail on the 4 MiB read ceiling and are truncated at the existing limit instead; a truly oversized read now answers an actionable message instead of echoing a diff fragment.
