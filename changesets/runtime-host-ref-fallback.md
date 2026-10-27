---
shell: none
plugins:
---

构建：运行时构建在克隆上游源码时，分支不存在会回退到同名 git tag，两者都缺失时给出可操作的错误，而不是让六个平台都死在 clone 上。
Build: the runtime build now falls back to a same-named git tag when the upstream branch is missing, and fails with an actionable message when neither ref exists instead of dying in `git clone` on all six platforms.
