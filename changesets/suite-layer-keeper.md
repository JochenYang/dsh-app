---
shell: patch
---

修复套件层被包管理器删掉后整套插件消失：profile 里跑一次 pnpm（插件页安装/卸载、`dsh plugin …`）会把 `node_modules/@dsh-app/suite-layer` 当多余目录清掉，而套件所有补丁行只走这一个 bundle，于是设置栏整排消失、插件页报「未安装」，直到重启应用才恢复。现在应用运行期间会盯着这个目录，被删就在几秒内重建（连同 profile 清单里的 bundle 声明），下一次组合即可读到。
Fix the suite disappearing after a package manager prunes it: one pnpm run in the profile (`dsh plugin … install|remove`, the plugin manager's own page) removes `node_modules/@dsh-app/suite-layer` as an extraneous directory — and the suite's rows travel only through that bundle, so the whole settings rail vanished and the plugin page reported it as "not installed" until the app restarted. A keeper now watches that directory while the app runs and rebuilds it within seconds (manifest entry included), so the next composition finds it.
