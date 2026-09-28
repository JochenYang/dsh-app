---
shell: patch
plugins: plugin-market
---

外壳不再重建 profile 的 cordis.patch.yml：0.1.7 起内核把用户设置写在该文件，而每次启动的重建会把它们冲掉（全新 profile 上外观、首启声明、搜索 provider、账号身份四项全丢）；套件的行改由 profile 自己的 bundle 层承载，内核成为唯一写者，启动时顺带清掉 patch 里残留的套件 insert 块。插件市场同时修正：块内与内核设置行同 id 时，启用不再连带删掉用户的设置行，禁用也不再静默不生效。
The shell no longer regenerates the profile's cordis.patch.yml: since 0.1.7 the kernel stores user settings there and the per-start rewrite dropped them (a fresh profile lost appearance, the first-run notice, the search provider and the account identity); the suite's rows now travel in a bundle layer the profile names, the kernel is its only writer, and each start clears any suite insert blocks left in the patch. The plugin market also stops confusing the kernel's settings row with its own disable row: enabling no longer deletes the user's setting, and disabling no longer silently does nothing.
