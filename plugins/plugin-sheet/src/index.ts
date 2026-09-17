/**
 * DSH APP Excel suite — host half.
 *
 * Runs the direct spreadsheet authoring loop: the model writes one
 * `.sheet.json` workspace document (columns, typed rows, optional cell
 * formulas), iterates against the read-only checker, and exports an editable
 * .xlsx once the check passes:
 *
 *   1. `sheet_write`  — validate + write the engineering document.
 *   2. `sheet_check`  — full validation, never writes.
 *   3. `sheet_render` — check again + export to .xlsx (errors refuse export).
 *
 * The check-then-render gate is what makes the export trustworthy: the
 * document's structure is validated with 表名/行号/列/JSON path locations
 * before a single byte is produced, so a malformed grid can never reach the
 * user as a half-broken workbook.
 *
 * Beyond the tools, the plugin mounts a session-level spreadsheet mode: the
 * client half's Excel capsule toggles it per session (mode routes), and while
 * it is on a system-prompt section pins every turn to the
 * sheet_write → sheet_check → sheet_render workflow. State lives in
 * `<DSH_HOME>/storages/dsh-app-plugin-sheet/mode.json` (see mode-store.ts).
 *
 * The skill half installs the `dsh-sheet` SKILL.md under the harness home
 * (see skill.ts).
 *
 * @module @dsh-app/plugin-sheet
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
// Type-only: pulls the tools Context merge (ctx.tools) into scope.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the systemPrompt Context merge (ctx.systemPrompt) and the
// AssembleContext.agent augmentation into scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SheetModeStore } from './mode-store.ts'
import { officeActiveFilePath } from './office-active-store.ts'
import { sheetDefaultSectionText, sheetModeSectionText } from './prompt.ts'
import { registerSheetRoutes } from './routes.ts'
import { outputFileRelative, sheetFileRelative, existingSheetFile, writableSheetFile } from './sheet-paths.ts'
import { formatSheetIssues, parseSheetWorkbook, sheetCheckResult } from './sheet/check.ts'
import type { SheetAnalysis } from './sheet/check.ts'
import { parseSheetText, readSheetDocument } from './sheet/load.ts'
import { renderSheetWorkbook } from './sheet/render.ts'
import type { SheetCheckResult } from './sheet/types.ts'
import { installSkill, SKILL_NAME } from './skill.ts'
import { workspaceRootOf } from './workspace.ts'

export const name = 'plugin-sheet'

/**
 * The sheet's mode routes ride the Connection exact-Fetch registry
 * (`ctx.connection.fetch`). The web server is deliberately NOT injected: the
 * desktop host disables its `webserver` row, so a plugin that waits for it
 * never activates at all.
 */
export const inject = ['tools', 'connection', 'systemPrompt']

/** Spreadsheet-mode system-prompt section order (upstream convention: 100–199). */
const PROMPT_SECTION_ORDER = 121
/** The unconditional natural-language entry rule sits right before it. */
const PROMPT_ENTRY_SECTION_ORDER = PROMPT_SECTION_ORDER - 1

/** Shared output declaration: lossless JSON, rendered as model-facing text. */
const OUTCOME_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} satisfies {
  schema: { type: 'json' }
  render(args: unknown, value: unknown): { type: 'text', text: string }[]
}

/** Error message of an unknown cause. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Tool-level failure value: Chinese, single actionable message. */
function failed(errors: string[]): JsonValue {
  return {
    status: 'needs_revision',
    errorCount: errors.length,
    warningCount: 0,
    suppressedCount: 0,
    issues: errors.map(message => ({ severity: 'error', message })),
  } as unknown as JsonValue
}

function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The countable part of a check result, shared by every tool answer. */
function checkPayload(check: SheetCheckResult): Record<string, unknown> {
  return {
    status: check.status,
    errorCount: check.errorCount,
    warningCount: check.warningCount,
    suppressedCount: check.suppressedCount,
    sheetCount: check.sheetCount,
    rowCount: check.rowCount,
    formulaCount: check.formulaCount,
    issues: check.issues,
  }
}

/** The refused result: nothing written, every issue named with its fix. */
function needsRevision(analysis: SheetAnalysis, digest = ''): JsonValue {
  const check = sheetCheckResult(analysis, digest)
  return {
    ...checkPayload(check),
    issuesText: formatSheetIssues(check),
  } as unknown as JsonValue
}

/**
 * Register the sheet tools; returns the exact disposer.
 * @param ctx - host plugin context (tools service).
 */
function registerSheetTools(ctx: Context): () => void {
  const disposers: (() => void)[] = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'sheet_write',
    description:
      'Validate and write one workspace .sheet.json engineering document (the whole workbook as JSON text: title, '
      + 'sheets with columns, typed rows and optional cell formulas). Errors are returned with sheet/row/column '
      + 'locations and nothing is written; warnings do not block the write. Replacing an existing file requires the '
      + 'SHA-256 returned by a previous read. Follow the ' + SKILL_NAME + ' skill for the format and the workflow.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内 .sheet.json 工程文件路径，例如 tables/q1.sheet.json。' },
      content: { type: 'string', required: true, description: '完整的 UTF-8 JSON 文本（含 title 与 sheets）。' },
      expected_sha256: { type: 'string', description: '替换已存在文件时必填：当前内容的 SHA-256（来自 sheet_check 或上次 sheet_write）；新建文件时省略。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePathRaw, content, expected_sha256: expectedSha256 } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      if (typeof content !== 'string') return failed(['content：必须是字符串（完整的 .sheet.json JSON 文本）'])
      try {
        const fileRelative = sheetFileRelative(filePathRaw, 'file_path')
        const loaded = parseSheetText(content)
        if (loaded.error !== undefined) return failed([`content：${loaded.error}`])
        const analysis = parseSheetWorkbook(loaded.value)
        if (analysis.errorCount > 0) return needsRevision(analysis, sha256Of(content))
        const target = await writableSheetFile(workspace.root, fileRelative, 'file_path')
        const metadata = await lstat(target).catch(() => undefined)
        if (metadata !== undefined) {
          if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
            throw new Error('expected_sha256：替换已存在文件时必须提供上次 sheet_write 或 sheet_check 返回的 SHA-256')
          }
          const current = await readFile(target)
          if (sha256Of(current) !== expectedSha256) {
            throw new Error('expected_sha256：文件在读取后已被修改；请重新 sheet_check 后再替换')
          }
        } else if (typeof expectedSha256 === 'string' && expectedSha256 !== '') {
          throw new Error('expected_sha256：仅替换已存在文件时使用；新建文件请省略或传空字符串')
        }
        const bytes = Buffer.from(content, 'utf8')
        // The containment fence proved the target is inside the workspace; the
        // parent directories (a new tables/ folder) are created on demand.
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes, { mode: 0o644 })
        return {
          status: 'written',
          filePath: fileRelative,
          sha256: sha256Of(bytes),
          sizeBytes: bytes.byteLength,
          sheetCount: analysis.sheetCount,
          rowCount: analysis.rowCount,
          formulaCount: analysis.formulaCount,
          warningCount: analysis.warningCount,
          suppressedCount: analysis.suppressedCount,
          issues: analysis.issues,
        } as unknown as JsonValue
      } catch (cause) {
        return failed([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'sheet_check',
    description:
      'Read-only validation of a workspace .sheet.json document: sheet names, unique non-empty headers, row widths '
      + 'against the column grid, cell types and text length, formula references and limits. Returns every issue with '
      + 'its sheet, row, column, JSON path and fix. needs_revision is a normal authoring result; fix the document and '
      + 'check again. Writes nothing.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内 .sheet.json 工程文件路径。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePathRaw } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      try {
        const fileRelative = sheetFileRelative(filePathRaw, 'file_path')
        const target = await existingSheetFile(workspace.root, fileRelative, 'file_path')
        const loaded = await readSheetDocument(target)
        if (loaded.error !== undefined) return failed([`file_path：${fileRelative} ${loaded.error}`])
        const check = sheetCheckResult(parseSheetWorkbook(loaded.value), sha256Of(loaded.text ?? ''))
        return {
          filePath: fileRelative,
          digest: check.digest,
          ...checkPayload(check),
          issuesText: formatSheetIssues(check),
        } as unknown as JsonValue
      } catch (cause) {
        return failed([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'sheet_render',
    description:
      'Convert a validated workspace .sheet.json document into one editable .xlsx: real columns with widths and '
      + 'number formats, typed rows, native cell formulas, a bold header row with a fill and a frozen first row. '
      + 'The document is validated again inside this operation: needs_revision means nothing was exported and the '
      + 'formatted issue list names every sheet/row/column to fix. Only status exported is a delivery; report the '
      + 'returned XLSX path and keep the .sheet.json for later edits.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内 .sheet.json 工程文件路径。' },
      output_file: { type: 'string', required: true, description: '新的工作区内 .xlsx 输出路径，例如 tables/q1.xlsx。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePathRaw, output_file: outputFileRaw } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      try {
        const fileRelative = sheetFileRelative(filePathRaw, 'file_path')
        const outputRelative = outputFileRelative(outputFileRaw, 'output_file')
        const source = await existingSheetFile(workspace.root, fileRelative, 'file_path')
        const loaded = await readSheetDocument(source)
        if (loaded.error !== undefined) return failed([`file_path：${fileRelative} ${loaded.error}`])
        const analysis = parseSheetWorkbook(loaded.value)
        if (analysis.errorCount > 0) return needsRevision(analysis, sha256Of(loaded.text ?? ''))
        const workbook = analysis.workbook
        if (workbook === undefined) {
          return failed(['工程校验未通过，未导出任何文件；请先运行 sheet_check 并逐条修复'])
        }
        // Path fence before the work, so a bad target costs no render; then
        // tmp+rename so a failed write never leaves half a workbook behind.
        const outAbs = await writableSheetFile(workspace.root, outputRelative, 'output_file')
        const rendered = await renderSheetWorkbook(workbook)
        await mkdir(dirname(outAbs), { recursive: true })
        const outTmp = `${outAbs}.${process.pid}.tmp`
        await writeFile(outTmp, Buffer.from(rendered.bytes))
        await rename(outTmp, outAbs)
        return {
          status: 'exported',
          outputPath: outputRelative,
          filePath: fileRelative,
          sheetCount: rendered.sheetCount,
          rowCount: rendered.rowCount,
          formulaCount: rendered.formulaCount,
          sizeBytes: rendered.bytes.byteLength,
          sha256: sha256Of(rendered.bytes),
          check: {
            errorCount: analysis.errorCount,
            warningCount: analysis.warningCount,
            issues: analysis.issues,
          },
        } as unknown as JsonValue
      } catch (cause) {
        return failed([`渲染失败：${messageOf(cause)}；请先运行 sheet_check 并逐条修复`])
      }
    },
  })))

  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Host apply: register the tools, mount the session-level spreadsheet mode
 * (prompt sections + mode routes), and install the skill file.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  const log = ctx.logger(name)

  // Session-level mode: the store is the shared state between the mode routes
  // (writer) and the prompt section (reader). The in-memory map is loaded once;
  // the disk copy persists toggles across restarts.
  const modeStore = new SheetModeStore(join(resolveDshHome(), 'storages', 'dsh-app-plugin-sheet', 'mode.json'), log)
  modeStore.load()
  // The suite-wide active-format claim: the mode routes write it, the client
  // polls it through /office-active to stand down when another format wins.
  const activeFile = officeActiveFilePath(resolveDshHome())
  // Residual entries are harmless, but 30-day-old ones only indicate dead
  // sessions — prune them once per boot.
  const pruned = modeStore.prune()
  if (pruned > 0) log.info(`sheet mode: pruned ${String(pruned)} stale session entries`)

  ctx.effect(() => registerSheetTools(ctx), 'plugin-sheet: llm tools')

  // The unconditional entry rule reaches every assembly: a spreadsheet
  // request in a session that never touched the capsule toggle still lands in
  // the sheet workflow instead of degrading to a Markdown table.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:sheet-entry',
    order: PROMPT_ENTRY_SECTION_ORDER,
    text: sheetDefaultSectionText(),
  }), 'plugin-sheet: sheet-entry prompt section')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:sheet-mode',
    order: PROMPT_SECTION_ORDER,
    // Per-assembly provider: '' (dropped by the renderer) unless the
    // assembling session has spreadsheet mode on.
    text: (context) => sheetModeSectionText(sessionId => modeStore.enabledOf(sessionId), context),
  }), 'plugin-sheet: sheet-mode prompt section')

  ctx.effect(() => registerSheetRoutes(ctx.connection.fetch, modeStore, activeFile), 'plugin-sheet: mode routes')

  ctx.effect(() => {
    // Fire-and-forget: the skill file outlives this fiber, so the effect owns
    // no unmount work — only the boot log entry.
    void installSkill(resolveDshHome()).then(
      (result) => {
        if (result === 'installed') log.info(`sheet skill installed: ${SKILL_NAME}`)
      },
      (cause: unknown) => {
        log.warn(`sheet skill install failed: ${messageOf(cause)}`)
      },
    )
    return () => undefined
  }, 'plugin-sheet: skill install')
}
