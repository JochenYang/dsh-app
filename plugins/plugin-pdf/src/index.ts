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
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the systemPrompt Context merge into scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the office provider's Context merge (ctx.officeToPdf) into scope.
import type {} from '@deepseek-ai/dsh-office-to-pdf'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { checkPdfDocument, loadPdfDocument } from './pdfd/check.ts'
import { PdfEditRefusal, editPdf } from './pdfd/edit.ts'
import type { PdfEditRequest } from './pdfd/edit.ts'
import { renderPdfProject } from './pdfd/render.ts'
import { MAX_SOURCE_BYTES, readPdfFile } from './pdfd/read.ts'
import { formatValidation, validationReport } from './pdfd/report.ts'
import type { ValidationReport } from './pdfd/report.ts'
import {
  existingWorkspaceFile,
  MAX_PROJECT_TEXT_BYTES,
  officeFileRelative,
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

/**
 * The mode routes ride the Connection exact-Fetch registry
 * (`ctx.connection.fetch`). The web server is deliberately NOT injected: the
 * desktop host disables its `webserver` row, so a plugin that waits for it
 * never activates at all.
 */
export const inject = ['tools', 'connection', 'systemPrompt']

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

/** A JSON-array argument as strings, refusing a non-array or a non-string entry. */
function asStrings(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${what}：必须是字符串数组`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${what}[${String(index)}]：必须是非空字符串`)
    }
    return entry
  })
}

/** A JSON-array argument as numbers, refusing a non-array or a non-number entry. */
function asNumbers(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${what}：必须是数字数组`)
  return value.map((entry, index) => {
    if (typeof entry !== 'number') throw new Error(`${what}[${String(index)}]：必须是数字`)
    return entry
  })
}

/** A JSON-array argument as a list, refusing a non-array. */
function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}：必须是数组`)
  return value
}

/** Whether the caller supplied any metadata field at all. */
function hasMetadata(record: Record<string, unknown>): boolean {
  return record.title !== undefined || record.author !== undefined
    || record.subject !== undefined || record.keywords !== undefined
}

/**
 * The environment variable the shell sets to the payload directory it expects.
 *
 * Present whenever the running kernel DECLARES an office component, absent when
 * it declares none (development runs boot the local checkout, which ships no
 * engine) — the one fact that tells the two very different states wearing the
 * engine's `unavailable` code apart.
 */
const OFFICE_PAYLOAD_ENV = 'DSH_APP_OFFICE_PAYLOAD'

/** Whether the running kernel declares an office component at all. */
function officeComponentDeclared(): boolean {
  const dir = process.env[OFFICE_PAYLOAD_ENV]
  return typeof dir === 'string' && dir !== ''
}

/**
 * `details.reason` of a document-render failure, when the cause carries one.
 *
 * The provider folds every engine error into one remote code
 * (`document-render/failed`) plus the engine's own reason; reading that reason
 * structurally keeps this plugin free of the protocol's error class, and an
 * unrecognized shape only costs a generic message.
 */
function officeReasonOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('details' in cause)) return undefined
  const details = (cause as { details?: unknown }).details
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined
  const reason = (details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : undefined
}

/**
 * Office conversion failures, worded for the model and the user.
 *
 * The provider's own client-side wording is about the preview feature and never
 * names the fix; here — the only place a conversion is asked for by a tool —
 * every reason gets a sentence that says what to do. `unavailable` is the one
 * reason with two causes under one code: a kernel that declares no office
 * component (a development run boots the local checkout, which has no engine)
 * and one whose payload is not downloaded yet. Only the second has a button to
 * send the user to, so the message must not confuse them.
 */
function officeFailureText(cause: unknown): string {
  switch (officeReasonOf(cause)) {
    case 'unavailable':
      return officeComponentDeclared()
        ? '办公文档转换引擎尚未安装：请到「设置 → 诊断 → 办公组件」点「下载」安装，装好后直接重试，不需要重启应用'
        : '当前内核未声明办公组件（开发运行或旧内核），没有可用的转换引擎；请在随包内核或已声明办公组件的内核里重试'
    case 'unsupported-format':
      return 'file_path：只支持 .doc / .docx / .xls / .xlsx / .ppt / .pptx'
    case 'input-too-large':
      return '源文件超过转换引擎的输入上限，请拆分或压缩后重试'
    case 'output-too-large':
      return '转换后的 PDF 超过引擎的输出上限'
    case 'invalid-document':
      return '引擎无法解析这个文件：可能已损坏、受密码保护，或扩展名与实际格式不符'
    case 'invalid-output':
      return '引擎没有产出可用的 PDF，请重试'
    case 'timeout':
      return '转换超时，请重试'
    case 'busy':
      return '转换任务较多，请稍后重试'
    case 'source-changed':
      return '文件在转换过程中被修改，请重试'
    default:
      return `转换失败：${messageOf(cause)}`
  }
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
    name: 'office_to_pdf',
    description:
      'Convert one workspace Office document (*.doc, *.docx, *.xls, *.xlsx, *.ppt, *.pptx) into a PDF with the '
      + 'application\'s own bundled LibreOffice engine — the engine the document preview uses, downloaded on demand '
      + 'and independent of office software on the user\'s machine. Slides, sheets and pages keep their layout, '
      + 'colours and charts, and the text stays selectable. The result names the font families the document asks for '
      + 'that this machine cannot supply (missingFonts), so a reflowed page is explained rather than mysterious. '
      + 'Read-only on the source; writes only output_file.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内相对路径的 Office 文档（.doc/.docx/.xls/.xlsx/.ppt/.pptx）。' },
      output_file: { type: 'string', required: true, description: '新的工作区内 .pdf 输出路径；已存在的同名文件会被替换。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePath, output_file: outputFile } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return readFailed([workspace.reason])
      try {
        const relative = officeFileRelative(filePath, 'file_path')
        // Both paths are proven before the engine is asked to read anything:
        // the source must exist as an in-workspace regular file, and the target
        // must be an in-workspace write the caller may create.
        await existingWorkspaceFile(workspace.root, relative, 'file_path')
        const target = await writableWorkspaceFile(workspace.root, pdfFileRelative(outputFile, 'output_file'), 'output_file')
        const service = ctx.get('officeToPdf')
        if (service === undefined) {
          throw new Error(officeComponentDeclared()
            ? '当前内核没有办公文档转换服务（内核未包含该组件）；请更新内核后重试'
            : '当前内核未声明办公组件（开发运行或旧内核），没有可用的转换服务；请在随包内核或已声明办公组件的内核里重试')
        }
        const sessionId = exec.agent?.session.header.id
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('当前会话没有会话标识，无法授权读取工作区文件')
        }
        // The provider reads and authorizes the source itself (the same path
        // the preview uses), so versioning, size ceilings, caching and the
        // conversion queue stay in one place.
        const rendered = await service.render(
          { sessionId, workspaceRoot: workspace.root }, relative, 'foreground', exec.signal,
        )
        // 0.1.7 hands back the converted document as BYTES (`RenderedDocumentBytes
        // extends WorkspaceFileBytes`), not the base64 string this call used to
        // decode — the workspace file interfaces were unified on `readBytes`.
        const bytes = rendered.data
        await mkdir(dirname(target), { recursive: true })
        const tmp = `${target}.${process.pid}.tmp`
        await writeFile(tmp, bytes)
        await rename(tmp, target)
        return {
          status: 'exported',
          outputPath: outputFile,
          filePath: relative,
          sizeBytes: bytes.byteLength,
          missingFonts: rendered.missingFonts,
          sha256: sha256Of(bytes),
        } as unknown as JsonValue
      } catch (cause) {
        return readFailed([officeFailureText(cause)])
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

  disposers.push(ctx.tools.register(defineTool({
    name: 'pdf_edit',
    description:
      'Edit the PAGES and metadata of an existing workspace PDF (*.pdf) — the operations a user means by "edit this '
      + 'PDF". Page indexes are zero-based. Use keep_pages to produce a document of exactly those pages (order as '
      + 'given), or remove_pages to delete pages; the two cannot be combined. rotate turns pages clockwise by 90/180/270 '
      + 'and accumulates onto any rotation the source already had. merge_ files appends other workspace PDFs after the '
      + 'edited original, in the order given. metadata sets title/author/subject/keywords and leaves every field it does '
      + 'not name untouched. The source file is never modified: the result is written to a NEW output_file. '
      + 'NOT supported: text rewriting inside a page, OCR, form filling, signing, redaction, encryption.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内相对路径的源 .pdf 文件（不会被修改）。' },
      output_file: { type: 'string', required: true, description: '新的工作区内 .pdf 输出路径；已存在的同名文件会被替换。' },
      keep_pages: { type: 'array', items: { type: 'number' }, description: '要保留的页码（从 0 开始），按给定顺序排列。与 remove_pages 互斥。' },
      remove_pages: { type: 'array', items: { type: 'number' }, description: '要删除的页码（从 0 开始）。与 keep_pages 互斥，且不能删光所有页。' },
      rotate_degrees: { type: 'number', description: '顺时针旋转度数，只能是 90 / 180 / 270；给出后对 rotate_pages 或全部页面生效。' },
      rotate_pages: { type: 'array', items: { type: 'number' }, description: '要旋转的页码，按编辑后的结果页序（从 0 开始）；省略则旋转全部页。' },
      merge_files: { type: 'array', items: { type: 'string' }, description: '要追加到末尾的其它工作区 .pdf 路径，按给定顺序。' },
      title: { type: 'string', description: '新的文档标题；省略则保留原值。' },
      author: { type: 'string', description: '新的作者；省略则保留原值。' },
      subject: { type: 'string', description: '新的主题；省略则保留原值。' },
      keywords: { type: 'array', items: { type: 'string' }, description: '新的关键词列表；省略则保留原值。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const record = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return readFailed([workspace.reason])
      try {
        const relative = pdfFileRelative(record.file_path, 'file_path')
        // An empty request is refused FIRST: parsing the other fields would
        // otherwise answer a confusing argument error for a call that simply
        // asked for nothing.
        if (record.keep_pages === undefined && record.remove_pages === undefined && record.rotate_degrees === undefined
          && (record.merge_files === undefined || (Array.isArray(record.merge_files) && record.merge_files.length === 0))
          && !hasMetadata(record)) {
          return readFailed(['没有给出任何编辑操作：请至少提供 keep_pages / remove_pages / rotate_degrees / merge_files / 一个元数据字段'])
        }
        const absolute = await existingWorkspaceFile(workspace.root, relative, 'file_path')
        const metadata = await lstat(absolute)
        if (metadata.size > MAX_SOURCE_BYTES) {
          throw new Error(`file_path：PDF 超过 ${MAX_SOURCE_BYTES / (1024 * 1024)} MB 上限（当前 ${(metadata.size / (1024 * 1024)).toFixed(1)} MB）`)
        }
        // Merge sources are resolved and proven BEFORE anything is edited, so a
        // bad path cannot leave a half-applied result behind. An absent list is
        // no merge, not a malformed one.
        const mergeLabels: string[] = []
        for (const [index, entry] of (record.merge_files === undefined ? [] : asList(record.merge_files, 'merge_files')).entries()) {
          const label = pdfFileRelative(entry, `merge_files[${index}]`)
          await existingWorkspaceFile(workspace.root, label, `merge_files[${index}]`)
          mergeLabels.push(label)
        }
        const request: PdfEditRequest = {
          ...(mergeLabels.length === 0 ? {} : { merge: mergeLabels.map(label => ({ label, bytes: new Uint8Array() })) }),
          ...(record.keep_pages === undefined ? {} : { keepPages: asNumbers(record.keep_pages, 'keep_pages') }),
          ...(record.remove_pages === undefined ? {} : { removePages: asNumbers(record.remove_pages, 'remove_pages') }),
          ...(record.rotate_degrees === undefined
            ? {}
            : {
                rotate: {
                  degrees: record.rotate_degrees as 90 | 180 | 270,
                  ...(record.rotate_pages === undefined ? {} : { pages: asNumbers(record.rotate_pages, 'rotate_pages') }),
                },
              }),
          ...(hasMetadata(record)
            ? {
                metadata: {
                  ...(record.title === undefined ? {} : { title: String(record.title) }),
                  ...(record.author === undefined ? {} : { author: String(record.author) }),
                  ...(record.subject === undefined ? {} : { subject: String(record.subject) }),
                  ...(record.keywords === undefined ? {} : { keywords: asStrings(record.keywords, 'keywords') }),
                },
              }
            : {}),
        }
        const sourceBytes = await readFile(absolute)
        const edited = await editPdf(sourceBytes, request, async (label) => {
          const mergedAbsolute = await existingWorkspaceFile(workspace.root, label, 'merge_files')
          return readFile(mergedAbsolute)
        })
        const target = await writableWorkspaceFile(workspace.root, pdfFileRelative(record.output_file, 'output_file'), 'output_file')
        await mkdir(dirname(target), { recursive: true })
        // tmp + rename so a failure never leaves half a PDF behind and a
        // symlink at the destination is replaced, not followed.
        const tmp = `${target}.${process.pid}.tmp`
        await writeFile(tmp, Buffer.from(edited.bytes))
        await rename(tmp, target)
        return {
          status: 'ok',
          filePath: relative,
          outputPath: record.output_file,
          sizeBytes: edited.bytes.byteLength,
          sha256: sha256Of(edited.bytes),
          ...edited.summary,
        } as unknown as JsonValue
      } catch (cause) {
        if (cause instanceof PdfEditRefusal) return readFailed([cause.message])
        return readFailed([messageOf(cause)])
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

  ctx.effect(() => registerPdfRoutes(ctx.connection.fetch, modeStore, activeFile), 'plugin-pdf: mode routes')

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
