---
shell: patch
plugins: none
---

`npm run dev` 启动前会重建所有源码已改动的套件插件，不再让开发运行悄悄加载上一次的构建产物。此前 `npm start` 只编译 `src/`，而插件是通过自己的 `lib/` 加载的，改了插件源码却没重建时，运行的是旧包。
`npm run dev` now rebuilds every suite plugin whose sources changed before it launches, instead of letting a dev run quietly load the previous bundle. `npm start` only compiled `src/`, while a plugin loads through its own `lib/`, so an un-rebuilt plugin ran the old package.
