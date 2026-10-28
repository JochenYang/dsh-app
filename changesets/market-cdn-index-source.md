---
shell: none
plugins: plugin-market
---

插件市场默认目录源换成 jsDelivr 上的 format-1 索引（`dsh-plugin-catalog/index.json`，约 610 KB 压缩传输），一次请求即可打开面板；原来走腾讯镜像的 metadata + tarball 两跳退为可手动添加的源，仍是完整目录。新增该索引格式的解析与契约测试。
Market catalog now opens from the format-1 index on jsDelivr (`dsh-plugin-catalog/index.json`, ~610 KB compressed) in a single request; the Tencent-mirror metadata + tarball transport is no longer a preset source but stays addable and remains the complete directory. Adds the parser and contract coverage for the index format.
