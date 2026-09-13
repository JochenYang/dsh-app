/**
 * DSH APP Word suite — host half.
 *
 * Runs the direct DOC authoring loop: the model writes one structured JSON
 * document project (`*.doc.json`) into the workspace, iterates against the
 * read-only checker, and exports a native editable .docx once the check
 * passes:
 *
 *   1. `doc_write`  — validate a *.doc.json project, then create/replace it.
 *   2. `doc_check`  — full validation, never writes anything.
 *   3. `doc_render` — validate again (errors refuse the export), then produce
 *                     the .docx via the docx library.
 *
 * The document model is deliberately small — headings 1–3, paragraphs, bullet
 * lists, tables and images — so every construct maps onto a native Word object
 * the user can keep editing; the checker refuses unknown fields, malformed
 * tables, over-long cells and heading-level jumps before a file is rendered.
 *
 * Beyond the tools, the plugin mounts a session-level Word mode: the client
 * half's capsule toggles it per session (mode route), and while it is on a
 * system-prompt section pins every turn to the doc_write → doc_check →
 * doc_render workflow. State lives in
 * `<DSH_HOME>/storages/dsh-app-plugin-doc/mode.json` (see mode-store.ts).
 *
 * The skill half installs the `dsh-word` SKILL.md under the harness home
 * (see skill.ts).
 *
 * @module @dsh-app/plugin-doc
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
import { checkDocDocument, loadDocDocument } from './docd/check.ts'
import { renderDocProject } from './docd/render.ts'
import { formatValidation, validationReport } from './docd/report.ts'
import type { ValidationReport } from './docd/report.ts'
import {
  docFileRelative,
  docxFileRelative,
  existingWorkspaceFile,
  MAX_DOC_TEXT_BYTES,
  writableWorkspaceFile,
} from './doc-paths.ts'
import { DocModeStore } from './mode-store.ts'
import { officeActiveFilePath } from './office-active-store.ts'
import { docDefaultSectionText, docModeSectionText } from './prompt.ts'
import { registerDocRoutes } from './routes.ts'
import { installSkill, SKILL_NAME } from './skill.ts'
import { workspaceRootOf } from './workspace.ts'

export const name = 'plugin-doc'
export const inject = ['tools', 'webServer', 'systemPrompt']

/** Word-mode system-prompt section order (upstream convention: 100–199). */
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
    issues: report.issues,
  }
}

/**
 * Read and parse one workspace document, then validate it. Both doc_check and
 * doc_render go through here, so the render gate validates exactly the bytes it
 * is about to render.
 */
async function loadWorkspaceDoc(
  workspaceRoot: string,
  filePath: unknown,
): Promise<{ relative: string, raw: string, check: ReturnType<typeof checkDocDocument>, parsed: unknown }> {
  const relative = docFileRelative(filePath, 'file_path')
  const absolute = await existingWorkspaceFile(workspaceRoot, relative, 'file_path')
  const metadata = await lstat(absolute)
  if (metadata.size > MAX_DOC_TEXT_BYTES) {
    throw new Error(`file_path：文件超过 ${MAX_DOC_TEXT_BYTES} 字节上限`)
  }
  const raw = await readFile(absolute, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('file_path：文件不是合法 JSON；请用 doc_write 重写整份工程')
  }
  return { relative, raw, check: checkDocDocument(parsed), parsed }
}

/**
 * Register the DOC tools; returns the exact disposer.
 * @param ctx - host plugin context (tools service).
 */
function registerDocTools(ctx: Context): () => void {
  const disposers: (() => void)[] = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'doc_write',
    description:
      'Create or replace one structured JSON Word document project (*.doc.json) inside the workspace. The content is '
      + 'validated first: errors are returned as a block-indexed fix list and nothing is written. Replacing an '
      + 'existing file requires the SHA-256 returned by the previous doc_write. Follow the ' + SKILL_NAME + ' skill for '
      + 'the format and the authoring workflow.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内相对路径，.doc.json 结尾，例如 docs/report.doc.json。' },
      content: { type: 'string', required: true, description: '完整的 UTF-8 JSON 文档内容（{ title, author?, sections }）。' },
      expected_sha256: { type: 'string', description: '替换已存在文件时必填：当前内容的 SHA-256（来自上一次 doc_write）；新建时省略。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePath, content, expected_sha256: expectedSha256 } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      if (typeof content !== 'string' || content.trim() === '') {
        return failed(['content：必须是非空的 JSON 字符串'])
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_DOC_TEXT_BYTES) {
        return failed([`content：超过单文件上限 ${MAX_DOC_TEXT_BYTES} 字节`])
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (cause) {
        return failed([`content：不是合法 JSON（${messageOf(cause)}）；请提交完整 JSON 文本`])
      }
      // Validate before touching the filesystem: an error is an authoring
      // result, and writing a broken project would only move the failure to
      // doc_render with less context.
      const check = checkDocDocument(parsed)
      if (check.errorCount > 0) {
        const report = validationReport(check, { file: typeof filePath === 'string' ? filePath : '' })
        return { status: 'needs_revision', ...checkValue(report), issuesText: formatValidation(report) } as unknown as JsonValue
      }
      try {
        const relative = docFileRelative(filePath, 'file_path')
        const target = await writableWorkspaceFile(workspace.root, relative, 'file_path')
        const metadata = await lstat(target).catch(() => undefined)
        let exists = false
        if (metadata !== undefined) {
          if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('file_path：目标不是普通文件')
          exists = true
        }
        if (exists) {
          if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
            throw new Error('expected_sha256：替换已存在文件时必须提供上一次 doc_write 返回的 SHA-256')
          }
          const current = await readFile(target)
          if (sha256Of(current) !== expectedSha256) {
            throw new Error('expected_sha256：文件在读取后已被修改；请重新 doc_check 后再覆盖')
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
        return failed([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'doc_check',
    description:
      'Read-only validation of one workspace *.doc.json document project: document structure, unknown fields, heading '
      + 'levels, bullet lists, table row/column shape, cell and block limits. Returns every issue with its 1-based '
      + 'block index, field and fix hint. needs_revision is a normal authoring result; fix the blocks and check again. '
      + 'Writes nothing.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内相对路径的 .doc.json 文件。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePath } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      try {
        const { relative, check } = await loadWorkspaceDoc(workspace.root, filePath)
        const report = validationReport(check, { file: relative })
        return {
          status: report.status === 'needs_revision' ? 'needs_revision' : 'ok',
          ...checkValue(report),
          issuesText: formatValidation(report),
        } as unknown as JsonValue
      } catch (cause) {
        return failed([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'doc_render',
    description:
      'Convert one workspace *.doc.json document project into one native editable .docx. The project is validated '
      + 'again inside this operation: needs_revision means nothing was exported and the formatted issue list names '
      + 'every block and field to fix. Only status exported is a delivery; report the returned .docx path and keep the '
      + 'JSON project for later edits.',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区内相对路径的 .doc.json 文件。' },
      output_file: { type: 'string', required: true, description: '新的工作区内 .docx 输出路径。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { file_path: filePath, output_file: outputFile } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      try {
        const { relative, parsed, check } = await loadWorkspaceDoc(workspace.root, filePath)
        const report = validationReport(check, { file: relative })
        if (report.status === 'needs_revision') {
          return { status: 'needs_revision', ...checkValue(report), issuesText: formatValidation(report) } as unknown as JsonValue
        }
        // The gate holds: only an error-free parse reaches the renderer, and
        // the normalized project it renders is the one the checker approved.
        const { project } = loadDocDocument(parsed)
        const bytes = await renderDocProject(project, { workspaceRoot: workspace.root })
        const target = await writableWorkspaceFile(workspace.root, docxFileRelative(outputFile, 'output_file'), 'output_file')
        await mkdir(dirname(target), { recursive: true })
        // tmp + rename so a failure never leaves half a document behind and a
        // symlink at the destination is replaced, not followed.
        const tmp = `${target}.${process.pid}.tmp`
        await writeFile(tmp, Buffer.from(bytes))
        await rename(tmp, target)
        return {
          status: 'exported',
          outputPath: outputFile,
          filePath: relative,
          blockCount: project.sections.length,
          sizeBytes: bytes.byteLength,
          sha256: sha256Of(bytes),
          check: checkValue(report),
        } as unknown as JsonValue
      } catch (cause) {
        return failed([`渲染失败：${messageOf(cause)}；请先运行 doc_check 并逐条修复`])
      }
    },
  })))

  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Host apply: register the tools, mount the session-level Word mode (prompt
 * sections + mode route), and install the skill file.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  const log = ctx.logger(name)

  // Session-level Word mode: the store is the shared state between the mode
  // route (writer) and the prompt section (reader). The in-memory map is
  // loaded once; the disk copy persists toggles across restarts.
  const modeStore = new DocModeStore(join(resolveDshHome(), 'storages', 'dsh-app-plugin-doc', 'mode.json'), log)
  modeStore.load()
  // The suite-wide active-format claim: the mode routes write it, the client
  // polls it through /office-active to stand down when another format wins.
  const activeFile = officeActiveFilePath(resolveDshHome())
  // Residual entries are harmless, but 30-day-old ones only indicate dead
  // sessions — prune them once per boot.
  const pruned = modeStore.prune()
  if (pruned > 0) log.info(`word mode: pruned ${String(pruned)} stale session entries`)

  ctx.effect(() => registerDocTools(ctx), 'plugin-doc: llm tools')

  // The unconditional entry rule reaches every assembly: an explicit
  // Word/.docx request in a session that never touched the capsule still lands
  // in the DOC workflow instead of degrading to prose.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:doc-entry',
    order: PROMPT_ENTRY_SECTION_ORDER,
    text: docDefaultSectionText(),
  }), 'plugin-doc: doc-entry prompt section')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:doc-mode',
    order: PROMPT_SECTION_ORDER,
    // Per-assembly provider: '' (dropped by the renderer) unless the
    // assembling session has Word mode on.
    text: context => docModeSectionText(sessionId => modeStore.isEnabled(sessionId), context),
  }), 'plugin-doc: doc-mode prompt section')

  ctx.effect(() => registerDocRoutes(ctx.webServer, modeStore, activeFile), 'plugin-doc: mode routes')

  ctx.effect(() => {
    // Fire-and-forget: the skill file outlives this fiber, so the effect owns
    // no unmount work — only the boot log entry.
    void installSkill(resolveDshHome()).then(
      (result) => {
        if (result === 'installed') log.info(`word skill installed: ${SKILL_NAME}`)
      },
      (cause: unknown) => {
        log.warn(`word skill install failed: ${messageOf(cause)}`)
      },
    )
    return () => undefined
  }, 'plugin-doc: skill install')
}
