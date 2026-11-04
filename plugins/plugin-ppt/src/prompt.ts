/**
 * The PPT-mode system-prompt section.
 *
 * The section is registered once and its text is a per-assembly provider:
 * when the assembling agent's session has PPT mode on (an entry in the mode
 * store), the provider returns the compact workflow directive; otherwise it
 * returns an empty string, which the prompt renderer drops. The session id
 * comes from the same agent header the tools resolve the workspace cwd
 * against, so what the tools see and what the prompt injects can never
 * diverge.
 *
 * The directive pins the workflow ordering, the active template's name and
 * the content-sourcing rule (materials from the user or web search, never
 * template sample copy); the full schema details live in the skill.
 *
 * The one IMPURE thing this module does is colour: when the session carries a brand
 * colour, the provider hands the model the finished `theme.colors` block derived by
 * `palette.ts` instead of letting it adjust six hex values itself. That import is a
 * local pure module, so the provider still reads no clock, no disk and no graph.
 *
 * @module @dsh-app/plugin-ppt/prompt
 */

import { resolvePalette, themeColorsYaml, type ResolvedPalette } from './palette.ts'

/** Structural slice of the assembly context (keeps this module dep-free). */
export interface PromptAssemblyAgent {
  session?: {
    header?: {
      id?: string
    }
  }
}

/**
 * The unconditional PPT-entry rule, injected into every assembly regardless
 * of mode state: a natural-language PPT request must reach the pptd workflow
 * even when the session never enabled PPT mode. Without a template choice the
 * document defaults to the paper theme and the pages are organized freely
 * from the content; an explicit template (mode on with a pick) keeps priority.
 */
export function pptDefaultSectionText(): string {
  return [
    '## PPT / 演示文稿请求',
    '用户请求制作 PPT、幻灯片或演示文稿时：按 skill `dsh-ppt` 启用 pptd 工作流——pptd_write_file 建立 PPTD 工程 → pptd_check 校验并逐条修复 → pptd_render 导出可编辑的 .pptx，不要用普通长文回答。会话未开启 PPT 模式（未选模板）时，不套用任何固定模板版式，按内容关系自行组织页面；theme 缺省用 paper 主题（暖纸底色 + 深色正文 + 蓝色 accent，调色板与写法见 skill）。会话已选模板时，所选模板的主题与版式仍优先。',
  ].join('\n')
}

/**
 * The mode state the section provider reads for the assembling session.
 *
 * Built by {@link modeStateFrom} rather than inline at the registration site: the
 * inline object is what silently dropped the colour fields once, so the provider kept
 * telling the model about a brand colour that never reached it.
 */
export interface PptModeState {
  /** Whether the session's PPT mode is on. */
  readonly enabled: boolean
  /** The chosen template, or `null` for the 常规主题 free mode. */
  readonly template: string | null
  /** The organisation's brand colour (`#RRGGBB`), when one was supplied. */
  readonly brand?: string | null
  /** A curated colourway id (`PALETTE_PRESETS`), when one was chosen. */
  readonly palette?: string | null
}

/** The store face {@link modeStateFrom} reads; structural so tests need no store. */
export interface ModeStateSource {
  isEnabled(sessionId: string): boolean
  templateOf(sessionId: string): string | null
  brandOf(sessionId: string): string | null
  paletteOf(sessionId: string): string | null
}

/**
 * One session's prompt state, read from the mode store.
 *
 * A function, not four expressions written at the call site, because forgetting one of
 * them is invisible: the provider then simply says nothing about a colour the host did
 * record, and the model asks the user again for something it was already told.
 *
 * @param store - the mode store (or anything with the same four reads).
 * @param sessionId - the assembling session.
 * @returns the state the section renders from.
 */
export function modeStateFrom(store: ModeStateSource, sessionId: string): PptModeState {
  return {
    enabled: store.isEnabled(sessionId),
    template: store.templateOf(sessionId),
    brand: store.brandOf(sessionId),
    palette: store.paletteOf(sessionId),
  }
}

/**
 * The injected directive for an active session that has not picked a template:
 * pages are organized by content relationships instead of any template
 * skeleton, on the built-in paper default theme, under the same gates as the
 * template mode.
 */
/**
 * The injected directive for an active session that has not picked a template:
 * pages are organized by content relationships instead of any template
 * skeleton, on the built-in paper default theme, under the same gates as the
 * template mode.
 *
 * @param colours - the session's colour source, when one is set. Colours are
 *   independent of the template choice, so 常规主题 carries them too: measured in a
 *   real session, the colour block lived only in the template branch, so a session
 *   with a brand colour and no template received the paper default and the model had
 *   to read the colours back out of the tool result.
 */
export function renderPptFreeModeText(colours: { readonly brand?: string | null, readonly palette?: string | null } = {}): string {
  const lines = [
    '## PPT 生成模式（本会话已启用，常规主题）',
    '',
    '本会话未选择模板：不要参考任何模板版式，按内容关系自行组织每页结构与视觉层级（趋势用折线/面积、比较用条形/柱状、占比用饼图、进度用 KPI、精确数值用表格、层级流程用图示化文本），不套用固定版式骨架。',
    '清单 theme 缺省用 paper 主题：背景 #FDFAE7、正文 #111111、accent #1E2BFA、surface #E9E8E0、次要 #6B6B6B；字体与元素引用写法见 skill。',
    '任何演示文稿产出必须按序执行：pptd_write_file 建立 PPTD 工程 → pptd_check 校验并按 文件/页/元素 ID 逐条修复 → pptd_render 产出 .pptx；status: exported 才算交付。禁止虚构数据，禁止用整页截图或图片代替文字。',
    '质量门禁与模板模式完全一致：textCapacity 上限、封面单主信息、颜色合法性与图表写法都必须遵守。',
  ]
  // Same rule as the template branch: the colour block lands last, beside the theme
  // sentence it overrides, and nothing is printed when the session has no colour.
  const colourLines = renderColourText(resolvePalette(colours))
  if (colourLines.length > 0) lines.push('', ...colourLines)
  return lines.join('\n')
}

/**
 * The colour block injected after the template directive: a derived brand palette or a
 * chosen colourway.
 *
 * The model is handed the finished `theme.colors` block because it must NOT do the
 * colour maths: a derived palette was computed in OKLCH and gated on WCAG contrast by
 * the host (`palette.ts`), and a model re-deriving six hex values from one brand
 * colour produces the exact failure the module exists to prevent — an accent pale
 * enough to disappear, or body text a shade too light to read on a projector. The
 * measured ratios are printed beside it so a reviewer can check the claim instead of
 * trusting it.
 *
 * @param resolved - the session's resolved colour source.
 * @returns the directive lines, or an empty array when the template's own colours stand.
 */
export function renderColourText(resolved: ResolvedPalette): string[] {
  if (resolved.palette === undefined) return []
  const block = ['```yaml', '  colors:', ...themeColorsYaml(resolved.palette), '```', '']
  if (resolved.source === 'brand' && resolved.report !== undefined) {
    const report = resolved.report
    return [
      '## 品牌色（本会话已设定）',
      '',
      '品牌色已换算成一套通过对比度校验的配色，**把这六行原样写进清单的 `theme.colors`，不要自己改色值、不要自己再算一遍**：',
      '',
      ...block,
      `实测对比度：正文 ${String(report.textOnBackground)}:1、accent ${String(report.accentOnBackground)}:1、secondary ${String(report.secondaryOnBackground)}:1、muted ${String(report.mutedOnBackground)}:1（阈值 7 / 3 / 4.5 / 4.5）。`,
      '模板仍然决定版式骨架与字体，品牌色只替换颜色；页面里不要出现除这套配色以外的色值。',
    ]
  }
  const preset = resolved.preset
  const label = preset === undefined ? '' : `${preset.name}（${preset.nameEn}）`
  const loud = preset !== undefined && preset.accentOnBackground < 3
    ? `这套配色的 accent 与背景只有 ${String(preset.accentOnBackground)}:1 —— 它是**色块用色**，不要拿它压文字；把它当填充，文字用正文色。`
    : ''
  return [
    `## 配色：${label}`,
    '',
    '本会话选择了一套独立于版式的配色，**把这六行原样写进清单的 `theme.colors`，版式仍按所选模板的骨架排**：',
    '',
    ...block,
    ...(loud === '' ? [] : [loud]),
    '页面里不要出现除这套配色以外的色值。',
  ]
}

/**
 * The injected directive for one active template, in Chinese (the product's
 * user-facing language, matching the skill text).
 */
export function renderPptModeText(
  templateId: string,
  templateName: string,
  colours: { readonly brand?: string | null, readonly palette?: string | null } = {},
): string {
  const lines = [
    '## PPT 生成模式（本会话已启用）',
    '',
    `模板「${templateName}」（${templateId}）。先调用 ppt_list_templates 确认目录，再用 ppt_get_template_reference 和 ppt_get_template_pages 读取版式（单次最多 12 页），按内容关系选择版式并用用户自己的文字重建可编辑元素。`,
    '模板只决定配色、字体与版式骨架，不提供内容：所有文字必须来自用户需求、用户提供的文档与材料；材料不足时先向用户询问，或使用联网搜索收集资料后再动笔。禁止虚构数据，禁止把模板示例文案当作演示内容。',
    '任何演示文稿产出必须按序执行：pptd_write_file 建立 PPTD 工程（清单顶层必须写 theme 字段：当前模板的调色板写入 theme.colors、字体写入 theme.textStyles，元素以 $名称 引用）→ pptd_check 校验并按 文件/页/元素 ID 逐条修复 → pptd_render 产出 .pptx 并把工程目录与输出路径告知用户；status: exported 才算交付，渲染报 needs_revision 时继续修复而不是反复导出。禁止用整页截图或图片代替文字。',
    '每个文本区的 textCapacity 是最大建议字符数：超限先改写、扩大区域或拆页，不要靠缩小字号塞入。封面只保留一条主信息（不超过 3 个文本元素），表格单元格放短句，颜色只写 #RRGGBB 或 theme.colors 的 $引用。',
  ]
  // The colour block comes LAST so it lands beside the theme instruction it overrides.
  const resolved = resolvePalette(colours)
  const colourLines = renderColourText(resolved)
  if (colourLines.length > 0) lines.push('', ...colourLines)
  else if (resolved.source === 'brand' || resolved.source === 'preset') {
    // Unreachable through `resolvePalette`, stated so a future edit that adds a source
    // without a palette cannot silently produce a deck with no colour instruction.
    lines.push('', '## 配色：无法解析', '本会话记录了一个配色选择，但无法解析成具体色值；按模板自带的调色板执行，并在回复里说明这一点。')
  }
  return lines.join('\n')
}

/**
 * Section provider body: resolve the assembling session's id and return the
 * directive, or an empty string (dropped by the renderer) when the session
 * has PPT mode off or the assembly has no agent. An on-without-template
 * session gets the free-mode directive instead of the template one.
 */
export function pptModeSectionText(
  modeOf: (sessionId: string) => PptModeState,
  templateNameOf: (templateId: string) => string | undefined,
  context: { agent?: PromptAssemblyAgent },
): string {
  const sessionId = context.agent?.session?.header?.id
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const mode = modeOf(sessionId)
  if (!mode.enabled) return ''
  if (mode.template === null) {
    return renderPptFreeModeText({ brand: mode.brand ?? null, palette: mode.palette ?? null })
  }
  return renderPptModeText(mode.template, templateNameOf(mode.template) ?? mode.template, { brand: mode.brand ?? null, palette: mode.palette ?? null })
}
