/**
 * The spreadsheet-mode system-prompt sections.
 *
 * Two sections, mirroring how the workflow is actually entered:
 *
 *  - the unconditional entry rule reaches every assembly, so a
 *    natural-language spreadsheet request in a session that never touched the
 *    capsule toggle still lands in the sheet workflow instead of degrading to
 *    a Markdown table;
 *  - the mode section is a per-assembly provider returning the compact
 *    directive only when the assembling session has the mode on (an entry in
 *    the mode store) and an empty string otherwise, which the prompt renderer
 *    drops.
 *
 * The session id comes from the same agent header the tools resolve the
 * workspace cwd against, so what the tools see and what the prompt injects can
 * never diverge. The full format details live in the skill.
 *
 * @module @dsh-app/plugin-sheet/prompt
 */

/** Structural slice of the assembly context (keeps this module dep-free). */
export interface PromptAssemblyAgent {
  session?: {
    header?: {
      id?: string
    }
  }
}

/**
 * The unconditional entry rule, injected into every assembly regardless of
 * mode state: a spreadsheet request must reach the sheet workflow even when
 * the session never enabled the mode.
 */
export function sheetDefaultSectionText(): string {
  return [
    '## Excel / 表格请求',
    '用户要求生成 Excel、表格、统计表、数据表、台账、预算表，或要求把数据整理成可编辑的表格文件时：按 skill `dsh-sheet` 走表格工作流——sheet_write 写出 .sheet.json 工程 → sheet_check 校验并逐条修复 → sheet_render 导出可编辑的 .xlsx，不要用 Markdown 表格、CSV 片段或长篇文字代替交付文件。数据来自用户材料或联网检索，禁止编造。',
  ].join('\n')
}

/** The injected directive for a session with the mode on (product language: Chinese). */
export function renderSheetModeText(): string {
  return [
    '## 表格生成模式（本会话已启用）',
    '',
    '先明确这张表的用途与列定义，再动笔：确认（或从材料与需求中确定）工作表名、每列列名与含义、一行代表什么、哪些列是数字列。不要先堆数据再补列名。',
    '需求明确后严格按序执行：sheet_write 写出工作区 .sheet.json 工程 → sheet_check 全量校验并按 表名 + 行号 + 列 逐条修复（错误清单带 JSON 路径与修复方式）→ sheet_render 导出 .xlsx 并把工程文件与导出路径一并告知用户；status: exported 才算交付，error 未清零前不要反复导出。',
    '工程格式：{"title": "工作簿标题", "sheets": [{"name": "表名", "columns": [{"header": "列名", "width"?, "numberFormat"?}], "rows": [[...]], "formulas"?: {"B2": "=SUM(C2:C9)"}}]}。列名唯一且非空；每行长度必须等于列数，缺值写 null；单元格只接受字符串、数字或 null。',
    '数字纪律：金额、数量、百分比必须写成数字（可配 numberFormat 如 "#,##0"、"0.0%"、"yyyy-mm-dd"），单位、口径与期间写进列名或专门的说明列，不要混进数字单元格。计算结果用真实 Excel 公式写进 formulas（键为 A1 或绝对 R1C1 单元格），不要手算出结果填死；公式会覆盖同格数据，跨列引用时注意表头占第 1 行。',
    '禁止编造数据：每个数字都必须来自用户材料、用户提供的文件或联网检索结果；材料不足时先向用户询问，用户明确要求占位时必须在列名或说明行标注「示例」。',
  ].join('\n')
}

/**
 * Section provider body: resolve the assembling session's id and return the
 * directive, or an empty string (dropped by the renderer) when the session has
 * the mode off or the assembly has no agent.
 */
export function sheetModeSectionText(
  enabledOf: (sessionId: string) => boolean,
  context: { agent?: PromptAssemblyAgent },
): string {
  const sessionId = context.agent?.session?.header?.id
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  return enabledOf(sessionId) ? renderSheetModeText() : ''
}
