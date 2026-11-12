---
shell: patch
plugins: plugin-pdf, plugin-swarm, plugin-rewind
---

跟随内核线 0.2.2-rc.2。三处真断裂：办公提供方 `dsh-office-to-pdf` 改名 `dsh-office-kit` 且服务 id 从 `officeToPdf` 变成 `officeKit`（`plugin-pdf`，否则转换工具永远报"没有可用的转换服务"）；`startActivation` 去掉了 `request` 包装（`plugin-swarm` 两处调用点摊平）；`dsh-session-projection` 现在依赖 zod 4.6.6 而 `plugin-rewind` 钉在 4.4.3，投影的 `ZodType` 缺 `validate`/`validateAsync`。另有两类配套改动：`dsh-llm`/`dsh-attachment` 把 `dsh-error` 声明成新 peer，按本仓 `--legacy-peer-deps` 的约定补进 6 个 manifest；`skill-office` 的技能从 7 项减到 4 项，构建期与启动期的两份名单、以及两份测试夹具一起收敛。

Follow the 0.2.2-rc.2 kernel line. Three real breaks: the Office provider moved from `dsh-office-to-pdf` to `dsh-office-kit` and its service id from `officeToPdf` to `officeKit` (`plugin-pdf`, otherwise the conversion tool can only report that no service is available); `startActivation` dropped its `request` wrapper (`plugin-swarm`, two call sites flattened); and `dsh-session-projection` now depends on zod 4.6.6 while `plugin-rewind` pinned 4.4.3, leaving the projection's `ZodType` without `validate`/`validateAsync`. Two supporting changes: `dsh-llm` and `dsh-attachment` declare `dsh-error` as a new peer, so six manifests now list it under this repo's `--legacy-peer-deps` rule, and `skill-office` shrank from seven skills to four, which moves both name lists (build and boot) and both test fixtures.
