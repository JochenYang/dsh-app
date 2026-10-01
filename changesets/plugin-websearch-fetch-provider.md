---
shell: patch
plugins: plugin-websearch
---

网页搜索插件：web_fetch 改由品牌 fetch provider 承接——保留宿主原有的 URL 策略、同源重定向、字节与字符上限和错误码，在检测到 fake-IP（TUN）网络时自动改走 DoH 加密解析，地址判定改用宿主同款 ipaddr.js 复刻其谓词以修掉 `http://[::ffff:7f00:1]/` 这类字面量绕过公网校验直连本机回环的漏洞，代理路由对齐内核策略（loopback 与非法 scheme 一律直连），自检新增抓取网络与抓取探测两行真实证据。
Web search plugin: web_fetch is now served by the brand fetch provider — the host's URL policy, same-origin redirects, byte/char caps and error codes are kept, on a fake-IP (TUN) network resolution moves to DNS-over-HTTPS automatically, address classification now reproduces the host's own predicate via ipaddr.js so IPv4-mapped IPv6 literals such as `http://[::ffff:7f00:1]/` can no longer reach a loopback service, proxy routing was aligned with the kernel's policy (loopback and rejected schemes stay direct), and the self-check reports two lines of real evidence.
