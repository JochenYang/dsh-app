---
shell: patch
plugins:
---

办公 payload 升到内核 0.2.2-rc.2 的引擎：kit 0.1.2 → 0.2.3。换线后提供方改名，让 kit 的加载期垫片不再被打进运行树（构建报 `no @deepseek-ai/dsh-office-to-pdf in the tree; no kit shim needed`），转换能力会静默变成 unavailable；垫片已改指新包名并重新打入。payload 的 pnpm 组装现在与运行树共用一份构建脚本白名单——kit 0.2.3 新增 `koffi`，缺白名单会让 payload 构建直接失败。另：overlay 关掉官方品牌行，首页不再同时出现两层鲸鱼；`dsh-tool-session-query` 那段注释改成实测到的事实。

Office payload moves to the engine of the 0.2.2-rc.2 line: kit 0.1.2 → 0.2.3. The provider's rename made the kit loader shim stop being staged — the build logged `no @deepseek-ai/dsh-office-to-pdf in the tree; no kit shim needed`, which would have left conversion silently unavailable; the shim now points at the new package and is staged again. The payload's pnpm assembly also shares one build-script allowlist with the runtime tree, since kit 0.2.3 adds `koffi` and a missing entry fails the payload build outright. The overlay additionally disables the official brand row so the home screen no longer paints two whales, and the `dsh-tool-session-query` note now states what was measured.
