# 内置模板库

本目录是 PPT 插件的版式模板库资产，随插件分发，仅供本插件的模板工具
（`ppt_list_templates` / `ppt_get_template_reference` / `ppt_get_template_pages`）
与模板选择面板读取。运行时不会写本目录。

## 目录结构

每个模板一个目录：`<分类>/<模板 id>/`。

| 文件/目录 | 用途 |
|---|---|
| `metadata.json` | 模板元数据：名称、分类、字体、色板、逐页结构索引（含每个文本区的 `textCapacity` 建议字符数，坐标为 1280x720 参考图像素空间） |
| `design.md` | 模板设计说明：版式语法、字体配对、配色语义与组合规则（`ppt_get_template_reference` 的返回内容） |
| `pages/NN.jpg` | 逐页版式预览图（统一压缩到宽 560px、质量 70；`pages/01.jpg` 同时作为选择面板封面） |
| `source-zh/` | 中文示例 PPTD 工程（`deck.pptd` 清单 + `pages/NN.page`，bounds 为 960x540 点空间），作为逐页布局参考 |

## 分类

`academic` / `business` / `consulting` / `editorial` / `promotion` / `work` 六类，每类五支模板。

每个分类有一支基础款，其余为该基础款的配色变体：沿用同一套版式骨架（`source-zh` 几何与字体配对完全一致），仅替换色板，`pages/` 预览图按变体色板重新渲染。变体由
`scripts/generate-template-variant.mjs`（配置见 `scripts/template-variants.json`）从基础款派生，条目可用 `baseCategory` 指向别的分类里的基础款；流程与用法见该脚本头部注释。

## 几何版式族

除各分类原有的版式骨架外，`business/dsh-slate-grid`（灰阶网格）及其配色变体引入了一套独立的几何版式族：十二页分别取自开源的 16:9 结构版式资产（封面 / 章节 / 正文 / 三卡 / 双栏对比 / 时间线 / KPI / 图表 / 表格 / 金句 / 图文分栏 / 结尾），页面几何互不相同。该族由
`scripts/import-layout-family.mjs`（配置见 `scripts/layout-family-imports.json`）从 `--layouts <资产根目录>` 抽取：SVG 中的 `data-pptx-placeholder` 槽转为可编辑文本元素，固定装饰转为形状与线条，像素坐标一次性换算到 `.page` 的 960x540 点空间（zones 保留 1280x720 参考像素）。`picture` / `chart` / `table` 槽在结构资产里没有数据，本版降级为保持同一矩形与 zone 的占位文本块（抽取脚本会打印降级清单）。

## 来源与许可

内置模板库源自开源项目，MIT/Apache-2.0。模板重建为原生可编辑版式并补充中文示例与
Office 字体配对；不含任何字体二进制文件。预览图为版式缩略图，不是输出背景。
几何版式族的结构参考自开源版式资产（MIT/Apache-2.0）。
