/**
 * DSH APP PDF suite — host half.
 *
 * Two legs meet in one mode:
 *
 *   1. Reading — `pdf_read` extracts a workspace PDF into a bounded structured
 *      summary (page count, per-page text, title/author) the model can use as
 *      material. Encrypted and malformed files come back as actionable errors,
 *      and the extraction is capped by size, page count and characters.
 *   2. Generating — the model authors one structured JSON project
 *      (`*.pdf.json`) into the workspace, iterates against the read-only
 *      checker, and renders a typographically regular PDF once the check
 *      passes: `pdf_write` validates then writes, `pdf_check` is read-only, and
 *      `pdf_render` validates again (errors refuse the export) before laying
 *      the document out with the bundled CJK font, paginating blocks and
 *      stamping a page-number footer.
 *
 * The project model is deliberately small — headings 1–3, paragraphs, bullet
 * lists, tables and forced page breaks — so every construct maps onto real
 * selectable text a reader can round-trip; the checker refuses unknown fields,
 * malformed tables, heading-level jumps and blocks taller than a sheet before a
 * file is rendered.
 *
 * Beyond the tools, the plugin mounts a session-level PDF mode: the client
 * half's capsule toggles it per session (mode route), and while it is on a
 * system-prompt section pins every turn to the workflow. State lives in
 * `<DSH_HOME>/storages/dsh-app-plugin-pdf/mode.json` (see mode-store.ts).
 *
 * The skill half installs the `dsh-pdf` SKILL.md under the harness home
 * (see skill.ts).
 *
 * @module @dsh-app/plugin-pdf
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
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the systemPrompt Context merge into scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { checkPdfDocument, loadPdfDocument } from './pdfd/check.ts'
import { renderPdfProject } from './pdfd/render.ts'
import { MAX_SOURCE_BYTES, readPdfFile } from './pdfd/read.ts'
import { formatValidation, validationReport } from './pdfd/report.ts'
import type { ValidationReport } from './pdfd/report.ts'
import {
  existingWorkspaceFile,
  MAX_PROJECT_TEXT_BYTES,
  pdfFileRelative,
  pdfProjectRelative,
  writableWorkspaceFile,
} from './pdf-paths.ts'
import { PdfModeStore } from './mode-store.ts'
import { officeActiveFilePath } from './office-active-store.ts'
import { pdfDefaultSectionText, pdfModeSectionText } from './prompt.ts'
import { registerPdfRoutes } from './routes.ts'
import { installSkill, SKILL_NAME } from './skill.ts'
import { workspaceRootOf } from './workspace.ts'

export const name = 'plugin-pdf'
export const inject = ['tools', 'webServer', 'systemPrompt']

/** PDF-mode system-prompt section order (after the sibling office plugins). */
const PROMPT_SECTION_ORDER = 123
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

/** Authoring failure value: Chinese, single actionable message per issue. */
function needsRevision(errors: string[]): JsonValue {
  return {
    status: 'needs_revision',
    errorCount: errors.length,
    warningCount: 0,
    issues: errors.map(message => ({ severity: 'error', message })),
    issuesText: errors.join('\n'),
  } as unknown as JsonValue
}

/** Read failure value: the read leg has no revision loop to offer. */
function readFailed(errors: string[]): JsonValue {
  return {
    status: 'failed',
    errorCount: errors.length,
    issues: errors.map(message => ({ severity: 'error', message })),
    issuesText: errors.join('\n'),
  } as unknown as JsonValue
}

function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Model-facing slice of a validation report (no status, so callers own it). */
function checkValue(report: ValidationReport): Record<string, unknown> {
  return {
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    blockCount: report.blockCount,
    estimatedPages: report.estimatedPages,
    issues: report.issues,
  }
}

/**
 * Read and parse one workspace project, then validate it. Both pdf_check and
 * pdf_render go through here, so the render gate validates exactly the bytes it
 * is about to render.
 */
async function loadWorkspaceProject(
  workspaceRoot: string,
  filePath: unknown,
): Promise<{ relative: string, raw: string, check: ReturnType<typeof checkPdfDocument>, parsed: unknown }> {
  const relative = pdfProjectRelative(filePath, 'file_path')
  const absolute = await existingWorkspaceFile(workspaceRoot, relative, 'file_path')
  const metadata = await lstat(absolute)
  if (metadata.size > MAX_PROJECT_TEXT_BYTES) {
    throw new Error(`file_path：文件超过 ${MAX_PROJECT_TEXT_BYTES} 字节上限`)
  }
  const raw = await readFile(absolute, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('file_path：文件不是合法 JSON；请用 pdf_write 重写整份工程')
  }
  return { relative, raw, check: checkPdfDocument(parsed), parsed }
}

/**
 * Register the PDF tools; returns the exact disposer.
 * @param ctx - host plugin context (tools service).
 */
function registerPdfTools(ctx: Context): () => void {
  const disposers: (() => void)[] = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'pdf_read',
    description:
      'Read one workspace PDF (*.pdf) into a structured summary for use as material: page count, per-page text and '
      + 'the document title/author metadata. Extraction is capped (50 MB source, 500 pages, 2 MB of text) and says so '
      + 'when it truncates. Encrypted, corrupt or non-PDF files return an actionable Chinese error. Read-only.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内相对路径的 .pdf 文件，例如 reports/q1.pdf。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePath } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return readFailed([workspace.reason])
      try {
        const relative = pdfFileRelative(filePath, 'file_path')
        const absolute = await existingWorkspaceFile(workspace.root, relative, 'file_path')
        const metadata = await lstat(absolute)
        if (metadata.size > MAX_SOURCE_BYTES) {
          throw new Error(`file_path：PDF 超过 ${MAX_SOURCE_BYTES / (1024 * 1024)} MB 上限（当前 ${(metadata.size / (1024 * 1024)).toFixed(1)} MB）`)
        }
        const summary = await readPdfFile(absolute, metadata.size)
        return {
          status: 'ok',
          filePath: relative,
          sizeBytes: metadata.size,
          pageCount: summary.pageCount,
          ...(summary.title === undefined ? {} : { title: summary.title }),
          ...(summary.author === undefined ? {} : { author: summary.author }),
          extractedChars: summary.extractedChars,
          truncated: summary.truncated,
          pages: summary.pages,
        } as unknown as JsonValue
      } catch (cause) {
        return readFailed([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'pdf_write',
    description:
      'Create or replace one structured JSON PDF project (*.pdf.json) inside the workspace. The content is validated '
      + 'first: errors are returned as a block-indexed fix list and nothing is written. Replacing an existing file '
      + 'requires the SHA-256 returned by the previous pdf_write. Follow the ' + SKILL_NAME + ' skill for the format and '
      + 'the authoring workflow.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内相对路径，.pdf.json 结尾，例如 docs/report.pdf.json。' },
      content: { type: 'string', required: true, description: '完整的 UTF-8 JSON 工程内容（{ title, author?, size?, blocks }）。' },
      expected_sha256: { type: 'string', description: '替换已存在文件时必填：当前内容的 SHA-256（来自上一次 pdf_write）；新建时省略。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePath, content, expected_sha256: expectedSha256 } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return needsRevision([workspace.reason])
      if (typeof content !== 'string' || content.trim() === '') {
        return needsRevision(['content：必须是非空的 JSON 字符串'])
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_PROJECT_TEXT_BYTES) {
        return needsRevision([`content：超过单文件上限 ${MAX_PROJECT_TEXT_BYTES} 字节`])
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (cause) {
        return needsRevision([`content：不是合法 JSON（${messageOf(cause)}）；请提交完整 JSON 文本`])
      }
      // Validate before touching the filesystem: an error is an authoring
      // result, and writing a broken project would only move the failure to
      // pdf_render with less context.
      const check = checkPdfDocument(parsed)
      if (check.errorCount > 0) {
        const report = validationReport(check, { file: typeof filePath === 'string' ? filePath : '' })
        return { status: 'needs_revision', ...checkValue(report), issuesText: formatValidation(report) } as unknown as JsonValue
      }
      try {
        const relative = pdfProjectRelative(filePath, 'file_path')
        const target = await writableWorkspaceFile(workspace.root, relative, 'file_path')
        const metadata = await lstat(target).catch(() => undefined)
        let exists = false
        if (metadata !== undefined) {
          if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('file_path：目标不是普通文件')
          exists = true
        }
        if (exists) {
          if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
            throw new Error('expected_sha256：替换已存在文件时必须提供上一次 pdf_write 返回的 SHA-256')
          }
          const current = await readFile(target)
          if (sha256Of(current) !== expectedSha256) {
            throw new Error('expected_sha256：文件在读取后已被修改；请重新 pdf_check 后再覆盖')
          }
        } else if (typeof expectedSha256 === 'string' && expectedSha256 !== '') {
          throw new Error('expected_sha256：仅替换已存在文件时使用；新建文件请省略或传空字符串')
        }
        await mkdir(dirname(target), { recursive: true })
        await writeFileAtomic(target, content, { mode: 0o644 })
        return {
          status: 'written',
          operation: exists ? 'replace' : 'create',
          filePath: relative,
          sha256: sha256Of(Buffer.from(content, 'utf8')),
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          check: checkValue(validationReport(check, { file: relative })),
        } as unknown as JsonValue
      } catch (cause) {
        return needsRevision([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'pdf_check',
    description:
      'Read-only validation of one workspace *.pdf.json project: document structure, unknown fields, heading levels and '
      + 'continuity, bullet lists, table row/column shape, cell and block limits, and whether any single block would '
      + 'overflow one printed page. Returns every issue with its 1-based block index, field and fix hint. '
      + 'needs_revision is a normal authoring result; fix the blocks and check again. Writes nothing.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内相对路径的 .pdf.json 文件。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePath } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return needsRevision([workspace.reason])
      try {
        const { relative, check } = await loadWorkspaceProject(workspace.root, filePath)
        const report = validationReport(check, { file: relative })
        return {
          status: report.status === 'needs_revision' ? 'needs_revision' : 'ok',
          ...checkValue(report),
          issuesText: formatValidation(report),
        } as unknown as JsonValue
      } catch (cause) {
        return needsRevision([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'pdf_render',
    description:
      'Render one workspace *.pdf.json project into a typographically regular PDF (*.pdf): A4 (or letter) with 2 cm '
      + 'margins, the 20/16/13 pt heading ladder, 10.5 pt body at 1.5 line spacing, dark header table rows, automatic '
      + 'pagination and a page-number footer. The project is validated again inside this operation: needs_revision '
      + 'means nothing was written and the formatted issue list names every block and field to fix. Only status exported '
      + 'is a delivery; report the returned .pdf path and keep the JSON project for later edits.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内相对路径的 .pdf.json 文件。' },
      output_file: { type: 'string', required: true, description: '新的工作区内 .pdf 输出路径。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePath, output_file: outputFile } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return needsRevision([workspace.reason])
      try {
        const { relative, parsed, check } = await loadWorkspaceProject(workspace.root, filePath)
        const report = validationReport(check, { file: relative })
        if (report.status === 'needs_revision') {
          return { status: 'needs_revision', ...checkValue(report), issuesText: formatValidation(report) } as unknown as JsonValue
        }
        // The gate holds: only an error-free parse reaches the renderer, and
        // the normalized project it renders is the one the checker approved.
        const { project } = loadPdfDocument(parsed)
        const rendered = await renderPdfProject(project)
        const bytes = rendered.bytes
        const target = await writableWorkspaceFile(workspace.root, pdfFileRelative(outputFile, 'output_file'), 'output_file')
        await mkdir(dirname(target), { recursive: true })
        // tmp + rename so a failure never leaves half a PDF behind and a
        // symlink at the destination is replaced, not followed.
        const tmp = `${target}.${process.pid}.tmp`
        await writeFile(tmp, Buffer.from(bytes))
        await rename(tmp, target)
        return {
          status: 'exported',
          outputPath: outputFile,
          filePath: relative,
          blockCount: project.blocks.length,
          sizeBytes: bytes.byteLength,
          fontSource: rendered.fontSource,
          sha256: sha256Of(bytes),
          check: checkValue(report),
        } as unknown as JsonValue
      } catch (cause) {
        return needsRevision([`渲染失败：${messageOf(cause)}；请先运行 pdf_check 并逐条修复`])
      }
    },
  })))

  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Host apply: register the tools, mount the session-level PDF mode (prompt
 * sections + mode route), and install the skill file.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  const log = ctx.logger(name)

  // Session-level PDF mode: the store is the shared state between the mode
  // route (writer) and the prompt section (reader). The in-memory map is
  // loaded once; the disk copy persists toggles across restarts.
  const modeStore = new PdfModeStore(join(resolveDshHome(), 'storages', 'dsh-app-plugin-pdf', 'mode.json'), log)
  modeStore.load()
  // The suite-wide active-format claim: the mode routes write it, the client
  // polls it through /office-active to stand down when another format wins.
  const activeFile = officeActiveFilePath(resolveDshHome())
  // Residual entries are harmless, but 30-day-old ones only indicate dead
  // sessions — prune them once per boot.
  const pruned = modeStore.prune()
  if (pruned > 0) log.info(`pdf mode: pruned ${String(pruned)} stale session entries`)

  ctx.effect(() => registerPdfTools(ctx), 'plugin-pdf: llm tools')

  // The unconditional entry rule reaches every assembly: an explicit PDF /
  // report request in a session that never touched the capsule still lands in
  // the PDF workflow instead of degrading to prose.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:pdf-entry',
    order: PROMPT_ENTRY_SECTION_ORDER,
    text: pdfDefaultSectionText(),
  }), 'plugin-pdf: pdf-entry prompt section')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:pdf-mode',
    order: PROMPT_SECTION_ORDER,
    // Per-assembly provider: '' (dropped by the renderer) unless the
    // assembling session has PDF mode on.
    text: context => pdfModeSectionText(sessionId => modeStore.isEnabled(sessionId), context),
  }), 'plugin-pdf: pdf-mode prompt section')

  ctx.effect(() => registerPdfRoutes(ctx.webServer, modeStore, activeFile), 'plugin-pdf: mode routes')

  ctx.effect(() => {
    // Fire-and-forget: the skill file outlives this fiber, so the effect owns
    // no unmount work — only the boot log entry.
    void installSkill(resolveDshHome()).then(
      (result) => {
        if (result === 'installed') log.info(`pdf skill installed: ${SKILL_NAME}`)
      },
      (cause: unknown) => {
        log.warn(`pdf skill install failed: ${messageOf(cause)}`)
      },
    )
    return () => undefined
  }, 'plugin-pdf: skill install')
}
