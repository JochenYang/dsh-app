/**
 * Skill installation.
 *
 * The kernel exposes no skill-registry seam this plugin can call, so the
 * skill materializes as a SKILL.md under `$DSH_HOME/skills/<name>/` — the
 * conventional discovery location — written at plugin mount. The write is
 * content-compared and skipped when unchanged, so repeated boots never touch
 * the file. Failures log and degrade instead of failing the mount.
 *
 * @module @dsh-app/plugin-sheet/skill
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const SKILL_NAME = 'dsh-sheet'

/** The skill body (Chinese, per the product's user-facing language). */
export const SKILL_MARKDOWN = `---
name: ${SKILL_NAME}
description: 编写本地 .sheet.json 表格工程并导出可编辑 .xlsx。当用户要求制作、生成 Excel / 表格 / 统计表 / 数据表 / 台账 / 预算表，或要求把数据整理成可编辑的表格文件时使用。
---

# 表格生成（${SKILL_NAME}）

> **与内核自带技能的分工**：内核随包提供 \`office-xlsx\`（以及 \`office-docx\` / \`office-pptx\`），
> 用于**检查和修改已有的** OOXML 文件；本技能用于**从结构化 JSON 工程产出新的** .xlsx
> （\`sheet_write\` → \`sheet_check\` → \`sheet_render\`）。手边是要改的表格时用内核技能，
> 要交一份排版规范的成品时用本技能。

本 Skill 由用户选中的表格模式启用，也适用于用户直接提出的 Excel / 表格请求。目标：为用户产出**可编辑**的 .xlsx 与可复用的 .sheet.json 工程。数据、公式、列宽与数字格式都写进单元格，不使用整表截图或图片代替数据。

## 阶段流程（严格按顺序，不跳步）

1. 列定义先行：明确这张表回答什么问题（用途）、一行代表什么、每列的含义与单位。列名要精简（建议不超过 12 字）且能独立读懂（如「营收（万元）」而不是「数值」），单位写在列名括号里或 title/subtitle；哪些列是数字列、用什么格式（金额 \`#,##0.00\`、比率 \`0.0%\`、日期 \`yyyy-mm-dd\`）在这一步定下来。
2. 材料盘点：逐列确认数据来源（用户材料、用户提供的文件、联网检索结果）。材料不足以支撑数据时先向用户提问，或联网收集后再动笔；用户要求占位时必须在列名或说明行标注「示例」。**禁止编造数据。**
3. 用 \`sheet_write\` 一次性写出工作区 \`.sheet.json\` 工程（完整 JSON 文本，不是片段）。字段与边界见下。
4. 调用只读的 \`sheet_check\`（入参 \`file_path\`）。返回 \`needs_revision\` 是正常反馈：每条问题都带 表名、行号、列、JSON 路径与修复方式。按清单逐条修改后重新 \`sheet_write\` 再 \`sheet_check\`，error 清零前不要导出。
5. 调用 \`sheet_render\`（入参 \`file_path\` 与新的 \`output_file\`，.xlsx 结尾）。渲染内部会再次全量校验：\`status: needs_revision\` 表示未导出任何文件，回到第 4 步继续修；\`status: exported\` 才算交付。
6. 导出成功后，**若当前会话提供 \`present\` 工具，就用它把成品登记为本次交付**（\`files: [{ "path": "<产出>.xlsx" }]\`；相对路径按会话工作目录解析，文件必须已经存在）——登记过的文件才会出现在会话的交付卡片里，用户能直接点开；没有该工具时跳过这一步即可。随后在回复结尾给出产出 .xlsx 的**明确路径引用**与 .sheet.json 工程路径，说明哪些数字来自哪里，并说明可用你本机的 Excel/WPS 打开继续编辑；不声称已在本机打开验证过。

## 工程格式

一个 \`.sheet.json\` 文件就是一本工作簿；\`sheets\` 的顺序就是工作表顺序。

\`\`\`json
{
  "title": "2026 年一季度经营数据",
  "subtitle": "单位：万元；统计期间 2026-01-01 至 2026-03-31",
  "notes": "数据来源：用户材料；同比为示例占位，请替换为真实数据。",
  "sheets": [
    {
      "name": "分月营收",
      "columns": [
        { "header": "月份" },
        { "header": "营收（万元）", "width": 14, "numberFormat": "#,##0" },
        { "header": "同比（%）", "numberFormat": "0.0%" }
      ],
      "rows": [
        ["1 月", 1280, 0.128],
        ["2 月", 1050, 0.083],
        ["3 月", null, null]
      ],
      "formulas": {
        "B5": "=SUM(B2:B4)",
        "C5": "=AVERAGE(C2:C4)"
      }
    }
  ]
}
\`\`\`

字段规则（校验器按此拒绝写出与导出）：

- \`title\`：非空字符串，工作簿标题（写入文档属性，并作为每张表上方的合并标题行），不超过 200 字。
- \`subtitle\` / \`notes\`：可选说明文本，各不超过 200 字；渲染成标题下方的合并说明行（9pt 灰色）。单位、期间、口径、数据来源写在这里，不要塞进数据单元格。
- \`style\`：可选 \`{"stripes"?: 布尔, "tabColor"?: "RRGGBB", "palette"?: "neutral"|"tech"|"warm", "dates"?: 布尔}\`。\`stripes\` 省略时数据行超过 7 行才开启极弱隔行底色，设 \`false\` 关闭；\`palette\` 省略时用 \`neutral\`（浅色表头，适合财务/打印），指标型表格可用 \`tech\`，教育/报告类可用 \`warm\`；\`tabColor\` 省略时跟随所选配色；\`dates\` 省略时把整列合法日期文本（如 \`2024-01-31\`、\`2024年1月\`、\`2026Q1\`）转成真正的日期类型（无法精确还原的日期文本如 \`2024.02.31\` 保持原文），设 \`false\` 则完全不转换。
- \`sheets\`：非空数组，最多 20 张；每张含 \`name\`、\`columns\`、\`rows\`，\`formulas\` 可选。
- \`name\`：1–31 字符，不能包含 \`[ ] : * ? / \\\`，不能以单引号开头或结尾，且不能与其他工作表重名（不区分大小写）。
- \`columns\`：建议 1–12 列（超过 12 列是 error，存储上限 64 列）。\`header\` 非空且唯一（不区分大小写），建议不超过 12 字（超过 24 字是 error），存储上限 200 字；\`width\` 为 1–255 的列宽（可选，省略时按表头与格式化后数值自动取值，中文字符按 2 个单位宽，渲染自动落在 6–60；显式 width 小于所需宽度是 error，会导致数字显示成 \`###\`）；\`numberFormat\` 为 Excel 数字格式字符串（可选，如 \`#,##0.00\`、\`0.0%\`、\`yyyy-mm-dd\`；文本编码列写 \`@\` 声明为文本）。
- \`rows\`：每行一个数组，**长度必须等于列数**（缺值写 \`null\`），单表最多 5000 行；单元格只接受字符串、数字或 \`null\`，单格文本不超过 32767 字。金额、数量、百分比写成数字，单位写进列名，不要写成 \`"1280 万元"\` 这样的文本。
- \`formulas\`：键是目标单元格（A1 如 \`"B5"\`、\`"$B$5"\`，或绝对 R1C1 如 \`"R5C2"\`；相对 R1C1 不支持），值是以 \`=\` 开头的 Excel 公式（如 \`"=SUM(B2:B4)"\`）。单元格必须落在数据范围内：**第 1 行是表头行，数据从第 2 行开始**，列数不超过本表列数；同一单元格只能有一条公式。公式会覆盖该格原值（校验会给出警告），所以把合计行放在数据下方并留出空行占位。

## 排版规范（导出即生效）

- **先定列定义与单位**：列名要短（建议不超过 12 字，校验上限 24 字）且自带单位，如「营收（万元）」「同比（%）」；单位也可以写在 \`title\`/\`subtitle\`。一行代表一条记录，不要把同类指标排成几十列。
- **数值列用数字类型，不要用字符串**：金额、数量、比率、日期都写成数字/日期形态，单位与口径写进列名或 \`subtitle\`/\`notes\`，不要写成 \`"1280 万元"\`。整列「看起来像数字的文本」超过一半会被提醒；工号/科目编码这类编码列请显式写 \`"numberFormat": "@"\` 声明为文本。
- **比率列存小数真值**：列名含「率/占比/同比/环比/增长」且数值都落在 [-1.5, 1.5] 时，必须写 \`"numberFormat": "0.0%"\`，存 \`0.128\` 而不是 \`12.8\`，也不要写成 \`"12.8%"\` 文本。
- **小数位统一**：同一列的小数位保持一致，渲染按列内最大小数位固定（负数显示为红色括号，零显示 \`-\`，颜色不是唯一区分手段）；小数位混用会被提醒。
- **合计行放最后**：首列写「合计」「总计」「小计」或「汇总」，渲染会整行加粗并加浅色强调底与上边线；合计前面至少要有 2 行明细，否则校验给出提醒。计算结果用 \`formulas\` 写公式，不要手算填死。
- **不要留空列/空行**：整列为空、数据行整行为空都是 error（被公式引用的占位空行除外）；请补齐或删除。
- **超宽/超长优先拆表**：单表列数超过 12 列、表头超过 24 字是 error；数据超过 2000 行是 warning。超过时请拆表、转置或精简，而不是硬塞。
- **配色**：未指定 \`palette\` 时用 \`neutral\`（浅色表头，适合财务/打印）；产品指标类可用 \`tech\`，教育/报告类可用 \`warm\`。
- **说明写进工程字段，不要塞单元格**：单位、期间、口径、数据来源放 \`title\`/\`subtitle\`/\`notes\`，渲染成表格上方的合并说明行；不要用一行数据或一个「说明」列来承载整段文字。
- **长文本表不要放进 Excel**：如果某一列超过 60% 的单元格都超过 40 字，说明内容形态更适合文档——改用 dsh-doc 文档模式，或把长文拆成短列后放进表格。

## 硬规则

- 导出前 error 必须清零：行长度不一致、列名重复或为空、表名非法或重复、公式越界、超行/超列/超单元格上限、列数超过 12、表头超过 24 字、整列/整行为空、比率列未声明百分比格式、显式列宽小于所需宽度都是 error，\`sheet_render\` 会拒绝导出并原样返回问题清单。
- 导出会自动排版：标题/说明合并行、浅色表头（深色加粗字、默认 24 行高、超宽表头换行并加高）、冻结表头、数据行之间仅水平细线（无左右竖线、无外框）、按所选 \`palette\` 着色、表头对齐跟随该列数据（数字/日期右对齐、文本左对齐）、合计行加粗+强调底+上边线、按内容自适应的列宽（中文字符按 2 个单位，列宽 6–60，保证数字列不出现 \`###\`）与数字格式推断。条件格式、图表、数据透视不在工程格式里，需要时在 Excel 中补充。
- 数字格式推断只在整列同型时生效：全数字 → 按列内最大小数位固定（如 \`#,##0.00;[Red](#,##0.00);"-"\`），整列日期文本 → \`yyyy-mm-dd\` / \`yyyy"年"m"月"\` / \`yyyy"Q"q\`（同列混合不推断），整列百分比文本 → \`0.0%\`（文本百分比会按 ÷100 转成比率数字）；比率列按 \`0.0%\` 存真值；列内混合类型保持原样不推断。要精确控制时给该列显式写 \`numberFormat\`。
- 数据要能追溯：每个数字对应一个来源（用户材料 / 用户文件 / 联网检索 / 明确标注的示例）；来源口径写进 \`subtitle\`/\`notes\`，不要塞进数据单元格。
- 一个 \`.sheet.json\` 只表达一本工作簿的**数据与结构**；多表关系优先拆成多张工作表，而不是把不同性质的数据堆进同一张表。
`

/** Where the skill file lands under the harness home. */
export function skillFilePath(dshHome: string): string {
  return join(dshHome, 'skills', SKILL_NAME, 'SKILL.md')
}

/**
 * Install (or refresh) the skill file. Content-compared: unchanged boots do
 * not rewrite. Returns what happened, for the boot log.
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
