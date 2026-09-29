---
shell: patch
plugins:
---

上游那两条「仅桌面端」的产品遥测行不再显示为「启动失败」：桌面宿主把 profile 报成 `desktop`，于是上游自己的禁用判据在我们这儿不成立、该行照常加载并因缺 `DSH_CLIENT_VERSION` 校验失败；套件层现在把它们显式关掉——本客户端默认不把使用事件上报到 DeepSeek 的采集端点，安全模式下也一样。
The upstream desktop-only product-telemetry pair no longer shows up as a failed plugin: the desktop host reports the profile as `desktop`, so upstream's own guard does not hold here and the row loaded only to fail its config validation for the missing `DSH_CLIENT_VERSION`. The suite layer now switches both rows off — this client does not report usage events to DeepSeek's collector by default, safe mode included.
