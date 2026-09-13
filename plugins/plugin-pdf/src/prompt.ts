/**
 * The PDF-mode system-prompt section.
 *
 * The section is registered once and its text is a per-assembly provider: when
 * the assembling agent's session has PDF mode on (an entry in the mode store),
 * the provider returns the compact workflow directive; otherwise it returns an
 * empty string, which the prompt renderer drops. The session id comes from the
 * same agent header the tools resolve the workspace cwd against, so what the
 * tools see and what the prompt injects can never diverge.
 *
 * The directive pins both legs of the workflow — read an existing PDF as
 * material, or author a project and render it — plus the ordering and the
 * no-fabrication rule; the full format details live in the skill.
 *
 * @module @dsh-app/plugin-pdf/prompt
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
 * The unconditional PDF-entry rule, injected into every assembly regardless of
 * mode state: an explicit PDF / report / white-paper request must reach the PDF
 * workflow even when the session never toggled the capsule.
 */
export function pdfDefaultSectionText(): string {
  return [
    '## PDF / 报告请求',
    '用户提到 PDF，或要求制作报告、白皮书、规范排版的文档，或提供了 PDF 材料时：按 skill `dsh-pdf` 走 PDF 工作流——需要理解已有 PDF 时用 pdf_read 读取为结构化文本；要产出 PDF 时用 pdf_write 写入结构化 JSON 工程（*.pdf.json）→ pdf_check 校验并逐条修复 → pdf_render 渲染出规范排版的 PDF，不要用普通长文回答，也不要用截图代替正文。内容必须来自用户需求与其提供的材料。',
  ].join('\n')
}

/** The injected directive for an active PDF mode, in Chinese. */
export function renderPdfModeText(): string {
  return [
    '## PDF 模式（本会话已启用）',
    '',
    '先判断这条任务属于哪条腿：① 把已有 PDF 当材料——用 pdf_read 读取工作区内的 .pdf（返回页数、每页文本、标题/作者），再基于摘录写作；② 按需求生成 PDF——先做材料盘点与提纲，明确受众、用途与章节顺序。内容只能来自用户需求、用户提供的材料与 pdf_read 的结果；材料不足时先向用户提问或联网收集。禁止编造数据与来源，示例数据必须明确标注。',
    '按提纲用 pdf_write 写入结构化 JSON 工程：顶层 { title, author?, size?: "a4"|"letter", style?: {header?: "light"|"dark"}, blocks }，blocks 是按顺序排列的内容块数组，每个块恰好命中一种内容键——heading{level:1|2|3,text}、paragraph{text}、bullets:string[]、table{headers,rows}、pageBreak:true。标题必须从 H1 开始且层级连续，不要跳级；表格每行的单元格数与表头一致，单元格放短语；单块不能超出一页。',
    '任何产出必须按序执行：pdf_write（写入并即时校验）→ pdf_check（只读全量校验，按块索引与字段逐条修复）→ pdf_render（先强制校验，error 拒绝渲染；通过后产出 .pdf）。把返回的 .pdf 路径与工程文件路径告知用户；只有 status: exported 才算交付，needs_revision 时继续修复而不是反复渲染。若 pdf_render 报字体缺字符，按提示改写文案或改用覆盖该字符的字体。',
  ].join('\n')
}

/**
 * Section provider body: resolve the assembling session's id and return the
 * directive, or an empty string (dropped by the renderer) when the session has
 * PDF mode off or the assembly has no agent.
 */
export function pdfModeSectionText(
  isEnabled: (sessionId: string) => boolean,
  context: { agent?: PromptAssemblyAgent },
): string {
  const sessionId = context.agent?.session?.header?.id
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  if (!isEnabled(sessionId)) return ''
  return renderPdfModeText()
}
