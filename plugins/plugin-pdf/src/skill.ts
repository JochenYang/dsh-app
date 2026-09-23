/**
 * Skill installation.
 *
 * The kernel exposes no skill-registry seam this plugin can call, so the skill
 * materializes as a SKILL.md under `$DSH_HOME/skills/<name>/` — the
 * conventional discovery location — written at plugin mount. The write is
 * content-compared and skipped when unchanged, so repeated boots never touch
 * the file. Failures log and degrade instead of failing the mount.
 *
 * @module @dsh-app/plugin-pdf/skill
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const SKILL_NAME = 'dsh-pdf'

/** The skill body (Chinese, per the product's user-facing language). */
export const SKILL_MARKDOWN = `---
name: ${SKILL_NAME}
description: 读取工作区 PDF 作为材料，或编写结构化 JSON 工程并渲染出规范排版的 PDF。当用户要求制作 PDF、报告、白皮书、规范排版的文档，或要求阅读/总结已有 PDF 时使用。
---

# PDF 工作流（${SKILL_NAME}）

> **与内核自带技能的分工**：内核随包提供 \`office-docx\` / \`office-pptx\` / \`office-xlsx\`，
> 用于**检查和修改已有的** OOXML 文件；本技能管的是 PDF——读它（\`pdf_read\`）、从 JSON 工程
> 产出它（\`pdf_render\`）、或把已有的 Office 文档转成它（\`office_to_pdf\`）。
> 只是想**看一眼**某个 .docx/.xlsx 的内容时不需要转换：侧栏已能原生预览 Office 与表格文件；
> 转换的用途是产出 PDF 本身。

三条腿，按任务选择：

- **读取**：把已有 PDF 当材料——\`pdf_read\` 读取工作区内 \`.pdf\`，返回页数、每页文本与标题/作者。
- **转换**：把已有的 Office 文档（\`.doc\`/\`.docx\`/\`.xls\`/\`.xlsx\`/\`.ppt\`/\`.pptx\`）原样转成 PDF——\`office_to_pdf\`（入参 \`file_path\` 与新的 \`output_file\`）。转换由本应用自带的 LibreOffice 引擎完成，用户机器不需要装 Office 或 WPS；页数、页面尺寸、配色与图表保留，文字仍可选。返回的 \`missingFonts\` 是文档声明但本机没有的字体族——出现时排版可能与原稿不同，要如实告知用户。不要改用 PowerShell/COM 驱动本机 Office 或 WPS（取决于用户装了什么、可能弹窗、结果不可复现），也不要用截图或重排冒充原样转换。
- **生成**：编写结构化 JSON 工程（\`*.pdf.json\`）——\`pdf_write\` 写入并即时校验 → \`pdf_check\` 只读全量校验 → \`pdf_render\` 渲染出规范排版的 \`.pdf\`。

## 阶段流程（生成时严格按顺序，不跳步）

1. 材料盘点与提纲：明确受众、用途和章节顺序，盘点用户需求、用户提供的材料与 \`pdf_read\` 的摘录。材料不足时先向用户提问，或联网搜索收集；示例数据必须明确标注，不得编造。
2. 用 \`pdf_write\` 把整份文档写成结构化 JSON（\`*.pdf.json\`，工作区相对路径）。\`pdf_write\` 会先校验，发现 error 时不写盘并返回问题清单。
3. 调用只读的 \`pdf_check\`（入参 \`file_path\`）。返回 \`needs_revision\` 是正常的写作反馈：问题清单完整返回，每条带块索引、字段与修复指引。
4. 按 **块索引 + 字段** 逐条修复：用普通文件工具读取该 \`.pdf.json\`，改好后用 \`pdf_write\` 整份覆盖（替换已存在文件必须带上一次返回的 \`expected_sha256\`），再次 \`pdf_check\`。
5. 校验通过后调用 \`pdf_render\`（入参 \`file_path\` 与新的 \`output_file\`，\`.pdf\` 结尾）。渲染内部仍会复验：\`status: needs_revision\` 表示未产出任何文件，回到第 4 步继续修；\`status: exported\` 才算交付。导出成功后，**若当前会话提供 \`present\` 工具，就用它把成品登记为本次交付**（\`files: [{ "path": "<产出>.pdf" }]\`；相对路径按会话工作目录解析，文件必须已经存在）——登记过的文件才会出现在会话的交付卡片里，用户能直接点开；没有该工具时跳过这一步即可。最后在回复结尾给出产出 \`.pdf\` 的**明确路径引用**与 \`.pdf.json\` 工程路径，并说明可用你本机的 PDF 阅读器打开查看；不声称已在本机打开验证过。

## 读取现有 PDF

\`pdf_read\` 入参 \`file_path\` 是工作区内 \`.pdf\` 路径，返回 \`pageCount\`、\`pages\`（每页文本数组）、\`title\`/\`author\` 与 \`extractedChars\`。限制：单文件 ≤ 50 MB、最多 500 页、提取文本合计 ≤ 2 MB（超出会截断并置 \`truncated\`）。加密或损坏的文件会返回可操作的错误提示。摘录只作为材料引用，不要臆测读不到的内容。

## 工程格式

\`\`\`json
{
  "title": "季度复盘",
  "author": "增长组",
  "size": "a4",
  "blocks": [
    { "heading": { "level": 1, "text": "结论" } },
    { "paragraph": { "text": "本季度核心指标全面达标。" } },
    { "bullets": ["营收同比增长 22%", "毛利率提升 3.3 个百分点"] },
    { "heading": { "level": 2, "text": "关键指标" } },
    { "table": { "headers": ["指标", "本期", "上期"], "rows": [["营收", "1,280 万", "1,050 万"]] } },
    { "pageBreak": true },
    { "paragraph": { "text": "附录内容另起一页。" } }
  ]
}
\`\`\`

字段与边界：

- 顶层只允许 \`title\`（必填）、\`author\`（可选）、\`size\`（可选，\`"a4"\` 或 \`"letter"\`，默认 a4）、\`style\`（可选，\`{ "header": "light" | "dark" }\`，默认 \`light\`，与 Word/PPT/Excel 的浅色表头一致）、\`blocks\`（必填，块数组，最多 500 块）；其他字段是校验错误。
- 每个块**恰好命中一种内容键**：\`heading\`、\`paragraph\`、\`bullets\`、\`table\`、\`pageBreak\`。同时写两种、或一种都不写都是错误。
- \`heading.level\` 只能是 1、2、3，\`text\` 非空。标题必须从 H1 开始，层级连续；从 H1 跳到 H3 是错误。
- \`paragraph.text\` 非空，单块文字超过一页容量是错误（拆成多个 paragraph）。
- \`bullets\` 是非空字符串数组（最多 100 条），每条用完整短句，不要自己加 "·" 前缀；整个列表不能超过一页。
- \`table\` 必须有非空 \`headers\`（最多 12 列）；每一行 \`rows[i]\` 是字符串数组，长度必须与表头列数一致；单元格非空且不超过 300 字；行数最多 200，展开后必须能放进一页（放不下就拆成多张表）。
- \`pageBreak\` 的值只能是 \`true\`，用于强制另起一页。
- 文档至少要有内容块；空 \`blocks\` 是错误。

## 排版规范（渲染器固定执行）

- 纸张 A4（或 letter），页边距 2 cm；正文 10.5 pt、行距 1.5；标题 20 / 16 / 13 pt 阶梯。
- 标题、正文、列表自动分页：块放不下当前页时另起一页；\`pageBreak\` 强制分页。
- 表格极简横向排版：表头默认浅底深字（\`F1F5F9\` 底、\`0F172A\` 字、字号比数据大 1pt，与 Word/PPT/Excel 一致；\`style.header: "dark"\` 可换成深底白字）、表头下边界与合计行上边界是中粗线、数据行之间只有 0.5 pt 细线，**不画列竖线与左右外框**；列宽按内容占比分配，表头对齐跟随所在列。
- 数字列自动右对齐并按同列最大小数位格式化（千分位、零显示 \`-\`、负数用括号）；比率列（列名含 率/占比/比例/同比/环比/增长/margin/rate/growth 且数值在 [-1.5, 1.5]）按一位小数百分比显示；\`YYYY/M/D\`、\`YYYY.M.D\`、\`YYYY年M月D日\` 统一写成 \`YYYY-MM-DD\`。
- 明细行超过 7 行时才加极浅的隔行底色；首列是 \`合计|总计|小计|汇总|Total|Subtotal|Sum\`（英文不区分大小写）的行按合计行强调（加粗、浅底、上边界中粗线）。
- 校验会提示同列小数位不一致（\`decimal-mismatch\`）、比率列未写成百分比（\`percent-column-format\`）和量级大但标题/表头没有单位（\`missing-unit\`）；整张表不跨页。
- 每页页脚居中显示 \`第 N 页 / 共 M 页\`。
- 字体：内置一份开源中文字体（Noto Sans SC，SIL OFL 1.1，GB2312 + ASCII + 中文标点子集）。若文案中出现子集未覆盖的字符（例如繁体或生僻字），渲染会报错并列出缺少的字符——改写文案、安装系统字体，或用环境变量 \`DSH_PDF_FONT\` 指向一个覆盖这些字符的 \`.ttf\`/\`.otf\`。字体集合 \`.ttc\` 不支持。

## 硬规则

- 内容全部来自用户需求、用户材料与 \`pdf_read\` 的结果；数字要同时保留单位、期间与来源。
- 未知字段（拼写错误、旧字段名）一律是 error，不会静默忽略。
- 只有表头没有数据行是 warning（不阻塞渲染），交付前应权衡处理。
- 语言遵循用户要求；禁止用图片或截图代替正文。
`

/** Where the skill file lands under the harness home. */
export function skillFilePath(dshHome: string): string {
  return join(dshHome, 'skills', SKILL_NAME, 'SKILL.md')
}

/**
 * Install (or refresh) the skill file. Content-compared: unchanged boots do not
 * rewrite. Returns what happened, for the boot log.
 */
export async function installSkill(dshHome: string): Promise<'installed' | 'unchanged'> {
  const file = skillFilePath(dshHome)
  let current: string | undefined
  try {
    current = await readFile(file, 'utf8')
  } catch {
    // Absent or unreadable → treat as a fresh install.
  }
  const changed = current !== SKILL_MARKDOWN
  if (changed) {
    // mkdir is implied by writeFileAtomic's parent creation.
    await writeFileAtomic(file, SKILL_MARKDOWN, { mode: 0o644 })
  }
  return changed ? 'installed' : 'unchanged'
}
