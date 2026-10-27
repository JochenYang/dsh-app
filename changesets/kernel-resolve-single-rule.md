---
shell: none
plugins:
---

构建：`kernel-line.mjs --resolve` 与其他构建入口现在共用同一个内核版本解析规则（先读 `package-lock.json`），发版文档同步说明「只改套件时内核不随 npm `next` 漂移」。
Build: `kernel-line.mjs --resolve` and the other build entry points now share one kernel-version rule (the committed `package-lock.json` first), and the release docs state that a suite-only release keeps the pinned kernel instead of following npm `next`.
