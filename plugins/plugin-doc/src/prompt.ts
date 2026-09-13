/**
 * The Word-mode system-prompt section.
 *
 * The section is registered once and its text is a per-assembly provider: when
 * the assembling agent's session has Word mode on (an entry in the mode store),
 * the provider returns the compact workflow directive; otherwise it returns an
 * empty string, which the prompt renderer drops. The session id comes from the
 * same agent header the tools resolve the workspace cwd against, so what the
 * tools see and what the prompt injects can never diverge.
 *
 * The directive pins the workflow ordering and the content-sourcing rule; the
 * full format details live in the skill.
 *
 * @module @dsh-app/plugin-doc/prompt
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
 * The unconditional Word-entry rule, injected into every assembly regardless
 * of mode state: an explicit Word/.docx/document request must reach the DOC
 * workflow even when the session never toggled the capsule.
 */
export function docDefaultSectionText(): string {
  return [
    '## Word / 文档请求',
    '用户明确要求制作 Word 文档、.docx 或「文档」时可编辑文档时：按 skill `dsh-word` 走 DOC 工作流——doc_write 写入结构化 JSON 工程（*.doc.json）→ doc_check 校验并逐条修复 → doc_render 导出可编辑的 .docx，不要用普通长文回答，也不要用截图或图片代替正文。内容必须来自用户需求与其提供的材料。',
  ].join('\n')
}

/** The injected directive for an active Word mode, in Chinese. */
export function renderDocModeText(): string {
  return [
    '## Word 生成模式（本会话已启用）',
    '',
    '先做材料盘点与提纲：明确受众、文档目的与章节顺序；内容只能来自用户需求、用户提供的文档与材料，材料不足时先向用户提问或联网收集资料。禁止虚构数据与来源，示例数据必须明确标注。',
    '按提纲用 doc_write 写入结构化 JSON 工程：顶层 { title, subtitle?, author?, date?, sections }，sections 是按顺序排列的内容块数组，每个块恰好命中一种内容键——heading{level:1|2|3,text}、paragraph{text,bold?,italic?}、bullets:string[]、table{headers,rows}、image{path}。标题层级连续（H1 → H2 → H3），不要跳级；标题写成 42 字以内的短句，每个 H1/H2 标题后必须紧跟正文块；表格列数不超过 8、每行的单元格数与表头一致，单元格放短语；超过 600 字的段落拆成多段或列表。',
    '任何文档产出必须按序执行：doc_write（写入并即时校验）→ doc_check（只读全量校验，按块索引与字段逐条修复）→ doc_render（先强制校验，error 拒绝导出；通过后产出 .docx）。把返回的 .docx 路径与工程文件路径告知用户；只有 status: exported 才算交付，needs_revision 时继续修复而不是反复导出。',
  ].join('\n')
}

/**
 * Section provider body: resolve the assembling session's id and return the
 * directive, or an empty string (dropped by the renderer) when the session has
 * Word mode off or the assembly has no agent.
 */
export function docModeSectionText(
  isEnabled: (sessionId: string) => boolean,
  context: { agent?: PromptAssemblyAgent },
): string {
  const sessionId = context.agent?.session?.header?.id
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  if (!isEnabled(sessionId)) return ''
  return renderDocModeText()
}
