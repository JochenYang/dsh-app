# 内置中文字体说明

`NotoSansSC-Regular.ttf` 是渲染 PDF 时随包内嵌的中文字体，用于确保导出不依赖
运行机器是否安装中文字体。

- 来源：Noto Sans SC（Google / Adobe，SIL Open Font License 1.1，见同目录
  `LICENSE-OFL.txt`；字形源自 Source Han Sans，其保留字体名为 “Source”，本文件
  未使用该名称）。
- 修改：由 `NotoSansSC-VF.ttf` 在 `wght=400` 处实例化为静态 Regular，再子集化为
  可打印 ASCII + Latin-1 补充 + CFF 常用符号 + CJK 标点 + GB2312 全量字符
  （共 7827 个码位 / 8475 个字形），并重写名称表为 `Noto Sans SC Regular`。
  这是 OFL 允许的修改与再分发形式，版权与许可声明保留在本目录。
- 生成方式：`python scripts/build-font.py`（需要 fonttools 与 `NOTO_SANS_SC_VF`
  指向的 Noto Sans SC 可变字体，默认取 `C:/Windows/Fonts/NotoSansSC-VF.ttf`）。
- 体积：约 2.4 MB。若要覆盖繁体或生僻字，安装系统字体或设置环境变量
  `DSH_PDF_FONT` 指向一个 `.ttf` / `.otf`；字体集合 `.ttc` 不受支持。
