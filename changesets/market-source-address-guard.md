---
shell: none
plugins: plugin-market
---

插件市场：目录源的目标地址按宿主同款策略判定（解析结果与 npm 源的 dist.tarball 在内），内网、回环、链路本地与云 metadata 地址被拒；重定向不再直接跟随（镜像的一跳 302 重新判定地址后放行）；请求失败详情不再渲染到面板。例外：假 IP 段 198.18.0.0/15 仍放行，IPv4-compatible 写法 [::7f00:1] 不判定（本平台连不到）。
Market plugin: a catalog source's destination is judged before the request by the host's own address policy (resolved answers and the npm source's dist.tarball included), refusing private, loopback, link-local and cloud-metadata addresses; redirects are no longer followed blindly (a mirror's one 302 is followed only after its address is judged); a failed catalog request no longer renders the upstream response text. Exceptions: the fake-IP block 198.18.0.0/15 stays allowed, and the IPv4-compatible spelling [::7f00:1] is not classified (it connects nowhere on this platform).
