---
shell: none
plugins: plugin-market
---

插件市场：npm 目录源的 registry 元数据与 tarball 两条读取补上字节上限（超限即失败并给出本地化文案，读取在越过上限的当下停止）；`/install-intent` 签发按 profile 加令牌桶限流（突发 8 次、每秒回填 1 次），安装确认的过期改由单调时钟判定，系统时间回拨不再延长有效期；插件导入的 `@deepseek-ai/schemastery` 补声明为 peerDependency，并同步补进 devDependencies。
Market plugin: the npm catalog source's registry-metadata and tarball reads are now byte-capped (past the cap they fail with localized copy, and the read stops where the cap is crossed); `/install-intent` issuance is rate-fenced per profile (burst 8, refill 1/s), and an install confirmation's expiry is decided on a monotonic clock, so a wall clock set back no longer extends it; the `@deepseek-ai/schemastery` import is now declared as a peerDependency, with the matching devDependency.
