/**
 * DSH APP PPT suite — host half.
 *
 * Runs the direct PPTD authoring loop: the model reads bundled template
 * layouts, writes a `.pptd` manifest plus `.page` YAML files into a
 * workspace project directory, iterates against the read-only checker, and
 * exports an editable .pptx once the check passes:
 *
 *   1. `ppt_list_templates`         — bundled template catalog.
 *   2. `ppt_get_template_reference` — one template's design document.
 *   3. `ppt_get_template_pages`     — per-layout structure + textCapacity.
 *   4. `pptd_write_file`            — create/replace one manifest/page file.
 *   5. `pptd_list_files`            — project file inventory.
 *   6. `pptd_read_file`             — one file's content + revision SHA.
 *   7. `pptd_check`                 — full validation, never publishes.
 *   8. `pptd_render`                — check + export to .pptx.
 *
 * Layout, wrapping and overflow protection are enforced by the bundled PPTD
 * engine (src/pptd/): elements are placed by explicit point bounds into
 * native PowerPoint text boxes and tables, and the checker refuses
 * overflow/occlusion before any export — replacing the previous free-form
 * JSON deck format whose implicit stacking produced overlapping copy.
 *
 * Beyond the tools, the plugin mounts a session-level PPT mode: the client
 * half's capsule toggles it per session (mode + template routes), and
 * while it is on, a system-prompt section pins every turn to the
 * templates → pptd_write_file → pptd_check → pptd_render workflow with the
 * chosen template. State lives in
 * `<DSH_HOME>/storages/dsh-app-plugin-ppt/mode.json` (see mode-store.ts).
 *
 * The skill half installs the `dsh-ppt` SKILL.md under the harness home
 * (see skill.ts).
 *
 * @module @dsh-app/plugin-ppt
 */

import { createHash } from 'node:crypto'
import { mkdir, lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path, { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
// Type-only: pulls the tools Context merge (ctx.tools) into scope.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the systemPrompt Context merge (ctx.systemPrompt) and the
// AssembleContext.agent augmentation into scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { checkPptdProject } from './pptd/check.ts'
import { loadPptdProject, resolvePptdEntry } from './pptd/load.ts'
import { validationReport, formatValidation } from './pptd/report.ts'
import { applyFallbackTheme, renderPptdProject } from './pptd/render.ts'
import { PptModeStore } from './mode-store.ts'
import { officeActiveFilePath } from './office-active-store.ts'
import { pptDefaultSectionText, pptModeSectionText } from './prompt.ts'
import {
  existingProjectFile,
  existingWorkspaceEntry,
  MAX_PROJECT_TEXT_BYTES,
  projectFileRelative,
  writableProjectDirectory,
  writableProjectFile,
  PROJECT_TEXT_EXTENSIONS,
} from './pptd-paths.ts'
import { registerPptRoutes } from './routes.ts'
import { installSkill, SKILL_NAME } from './skill.ts'
import {
  allTemplates,
  PAPER_THEME,
  PPTD_CANVAS,
  pptdZone,
  templateById,
  templateDesignDocument,
  templatePageSourcePath,
  templatePptdTheme,
} from './templates.ts'
import { resolveInWorkspace, workspaceRootOf } from './workspace.ts'

export const name = 'plugin-ppt'
export const inject = ['tools', 'webServer', 'systemPrompt']

/** PPT-mode system-prompt section order (upstream convention: 100–199). */
const PROMPT_SECTION_ORDER = 119
/** The unconditional natural-language entry rule sits right before it. */
const PROMPT_ENTRY_SECTION_ORDER = PROMPT_SECTION_ORDER - 1

/** Maximum layouts one ppt_get_template_pages call may return. */
const MAX_TEMPLATE_PAGES_PER_CALL = 12

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
  return { status: 'needs_revision', errorCount: errors.length, warningCount: 0, issues: errors.map(message => ({ severity: 'error', message })) } as unknown as JsonValue
}

function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Register the PPT tools; returns the exact disposer.
 * @param ctx - host plugin context (tools service).
 * @param modeStore - session PPT-mode state, read for the render-time theme
 *   fallback (the session's chosen template colors documents without one).
 */
function registerPptTools(ctx: Context, modeStore: PptModeStore): () => void {
  const disposers: (() => void)[] = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'ppt_list_templates',
    description:
      'List the bundled PPT templates (all colorways per category) with their layout families and counts. '
      + 'Follow with ppt_get_template_reference and ppt_get_template_pages for the chosen template.',
    parameters: {},
    output: OUTCOME_OUTPUT,
    async execute(): Promise<JsonValue> {
      const entries = await allTemplates()
      return {
        templates: entries.map(({ meta }) => ({
          id: meta.id,
          name: meta.name,
          category: meta.category,
          description: meta.description,
          pageCount: meta.pages.length,
          layoutFamilies: meta.layoutFamilies,
          palette: meta.palette,
          fonts: meta.fonts,
        })),
      } as unknown as JsonValue
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ppt_get_template_reference',
    description:
      'Read one template\'s design document: layout grammar, palette, typography (with per-OS CJK fallbacks), '
      + 'composition rules, and the page index. Read this before authoring against the template.',
    parameters: {
      template_id: { type: 'string', required: true, description: '模板 id，来自 ppt_list_templates。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args): Promise<JsonValue> {
      const templateId = (args as { template_id?: unknown }).template_id
      if (typeof templateId !== 'string' || templateId === '') return failed(['template_id：必须是非空字符串'])
      const entry = await templateById(templateId)
      if (entry === undefined) return failed([`template_id：未知模板 ${String(templateId)}；请先调用 ppt_list_templates`])
      const design = await templateDesignDocument(entry)
      const canvas = { width: PPTD_CANVAS.width, height: PPTD_CANVAS.height, unit: 'pt' }
      return {
        templateId: entry.meta.id,
        name: entry.meta.name,
        category: entry.meta.category,
        palette: entry.meta.palette,
        fonts: entry.meta.fonts,
        designDocument: design ?? entry.meta.designSummary,
        canvas,
        pages: entry.meta.pages.map((page) => ({
          slideNumber: page.slideNumber,
          sourceTitle: page.sourceTitle,
          family: page.family,
          density: page.density,
          structureSummary: page.structureSummary,
        })),
      } as unknown as JsonValue
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ppt_get_template_pages',
    description:
      'Read the structure index of one template\'s layouts: per page the preview image path, structure summary, '
      + 'and every zone converted to PPTD points with its textCapacity (maximum suggested characters). At most 12 '
      + 'pages per call; pass slide_numbers to pick pages, omit for the first 12.',
    parameters: {
      template_id: { type: 'string', required: true, description: '模板 id，来自 ppt_list_templates。' },
      slide_numbers: {
        type: 'array',
        description: '要读取的版式页码（1 起）；单次最多 12 页。省略时返回前 12 页。',
        items: { type: 'integer' },
      },
    },
    output: OUTCOME_OUTPUT,
    async execute(args): Promise<JsonValue> {
      const { template_id: templateId, slide_numbers: slideNumbers } = args as { template_id?: unknown, slide_numbers?: unknown }
      if (typeof templateId !== 'string' || templateId === '') return failed(['template_id：必须是非空字符串'])
      const entry = await templateById(templateId)
      if (entry === undefined) return failed([`template_id：未知模板 ${String(templateId)}；请先调用 ppt_list_templates`])
      const available = new Set(entry.meta.pages.map((page) => page.slideNumber))
      let requested: number[]
      if (slideNumbers === undefined || slideNumbers === null) {
        requested = entry.meta.pages.slice(0, MAX_TEMPLATE_PAGES_PER_CALL).map((page) => page.slideNumber)
      } else {
        if (!Array.isArray(slideNumbers) || slideNumbers.some((value) => !Number.isInteger(value))) {
          return failed(['slide_numbers：必须是整数数组'])
        }
        requested = [...new Set(slideNumbers as number[])].filter((value) => available.has(value)).slice(0, MAX_TEMPLATE_PAGES_PER_CALL)
      }
      return {
        templateId: entry.meta.id,
        canvas: { width: PPTD_CANVAS.width, height: PPTD_CANVAS.height, unit: 'pt' },
        pages: entry.meta.pages
          .filter((page) => requested.includes(page.slideNumber))
          .map((page) => ({
            slideNumber: page.slideNumber,
            sourceTitle: page.sourceTitle,
            family: page.family,
            density: page.density,
            structureSummary: page.structureSummary,
            previewPath: path.join(entry.dir, 'pages', `${String(page.slideNumber).padStart(2, '0')}.jpg`),
            layoutSourcePath: templatePageSourcePath(entry, page.slideNumber),
            zones: page.zones.map((zone) => pptdZone(zone)),
          })),
      } as unknown as JsonValue
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'pptd_write_file',
    description:
      'Create or replace one .pptd manifest or .page YAML file inside a workspace PPTD project. Replacing an '
      + 'existing file requires the SHA-256 returned by pptd_read_file. Follow the ' + SKILL_NAME + ' skill for '
      + 'the format and the authoring workflow.',
    parameters: {
      project_path: { type: 'string', required: true, description: '工作区内 PPTD 工程目录；不存在时自动创建。' },
      file_path: { type: 'string', required: true, description: '工程内相对路径，.pptd 或 .page 结尾。' },
      content: { type: 'string', required: true, description: '完整的 UTF-8 YAML 文件内容。' },
      expected_sha256: { type: 'string', description: '替换已存在文件时必填：当前内容的 SHA-256（来自 pptd_read_file）；新建文件时省略。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { project_path: projectPath, file_path: filePath, content, expected_sha256: expectedSha256 } =
        args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      if (typeof projectPath !== 'string' || projectPath.trim() === '') return failed(['project_path：必须是非空的工作区相对路径'])
      if (typeof content !== 'string') return failed(['content：必须是字符串（完整 YAML 内容）'])
      if (Buffer.byteLength(content, 'utf8') > MAX_PROJECT_TEXT_BYTES) {
        return failed([`content：超过单文件上限 ${MAX_PROJECT_TEXT_BYTES} 字节`])
      }
      try {
        const fileRelative = projectFileRelative(filePath, 'file_path', PROJECT_TEXT_EXTENSIONS)
        const directory = await writableProjectDirectory(workspace.root, projectPath)
        const target = await writableProjectFile(directory, fileRelative, 'file_path')
        let exists = false
        const metadata = await lstat(target).catch(() => undefined)
        if (metadata !== undefined) {
          if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('file_path：目标不是普通文件')
          exists = true
        }
        if (exists) {
          if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
            throw new Error('expected_sha256：替换已存在文件时必须提供 pptd_read_file 返回的 SHA-256')
          }
          const current = await readFile(target)
          if (sha256Of(current) !== expectedSha256) {
            throw new Error('expected_sha256：文件在读取后已被修改；请重新 pptd_read_file 后再替换')
          }
        } else if (typeof expectedSha256 === 'string' && expectedSha256 !== '') {
          throw new Error('expected_sha256：仅替换已存在文件时使用；新建文件请省略或传空字符串')
        }
        // Direct write after the containment fence proved the target; the
        // parent directory is created on demand (page files nest under pages/).
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(content, 'utf8'), { mode: 0o644 })
        return {
          operation: exists ? 'replace' : 'create',
          projectPath,
          filePath: fileRelative,
          sha256: sha256Of(Buffer.from(content, 'utf8')),
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        } as unknown as JsonValue
      } catch (cause) {
        return failed([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'pptd_list_files',
    description:
      'List the regular files inside one workspace PPTD project. This bounded project tool replaces generic '
      + 'filesystem discovery for PPT mode and rejects symbolic links.',
    parameters: {
      project_path: { type: 'string', required: true, description: '工作区内 PPTD 工程目录。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { project_path: projectPath } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      if (typeof projectPath !== 'string' || projectPath.trim() === '') return failed(['project_path：必须是非空的工作区相对路径'])
      try {
        const lexical = await writableProjectDirectory(workspace.root, projectPath)
        const files: { path: string, kind: string, sizeBytes: number }[] = []
        const visit = async (current: string, prefix: string): Promise<void> => {
          for (const entry of await readdir(current, { withFileTypes: true })) {
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
            const target = path.join(current, entry.name)
            if (entry.isSymbolicLink()) throw new Error(`PPTD 工程不能包含符号链接：${relative}`)
            if (entry.isDirectory()) {
              await visit(target, relative)
              continue
            }
            if (!entry.isFile()) throw new Error(`PPTD 工程包含不支持的文件系统条目：${relative}`)
            const metadata = await lstat(target)
            const extension = path.posix.extname(relative).toLowerCase()
            const kind = extension === '.pptd' ? 'manifest' : extension === '.page' ? 'page' : 'asset'
            files.push({ path: relative, kind, sizeBytes: metadata.size })
          }
        }
        await visit(lexical, '')
        files.sort((left, right) => left.path.localeCompare(right.path))
        return { projectPath, files } as unknown as JsonValue
      } catch (cause) {
        return failed([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'pptd_read_file',
    description:
      'Read one .pptd manifest or .page YAML file from a workspace PPTD project. The result includes a SHA-256 '
      + 'revision required when replacing that file.',
    parameters: {
      project_path: { type: 'string', required: true, description: '工作区内 PPTD 工程目录。' },
      file_path: { type: 'string', required: true, description: '工程内相对路径，.pptd 或 .page 结尾。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { project_path: projectPath, file_path: filePath } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      if (typeof projectPath !== 'string' || projectPath.trim() === '') return failed(['project_path：必须是非空的工作区相对路径'])
      try {
        const fileRelative = projectFileRelative(filePath, 'file_path', PROJECT_TEXT_EXTENSIONS)
        const directory = await writableProjectDirectory(workspace.root, projectPath)
        const target = await existingProjectFile(directory, fileRelative, 'file_path')
        const metadata = await lstat(target)
        if (metadata.size > MAX_PROJECT_TEXT_BYTES) throw new Error(`file_path：文件超过 ${MAX_PROJECT_TEXT_BYTES} 字节上限`)
        const bytes = await readFile(target)
        return {
          projectPath,
          filePath: fileRelative,
          content: bytes.toString('utf8'),
          sha256: sha256Of(bytes),
          sizeBytes: bytes.byteLength,
        } as unknown as JsonValue
      } catch (cause) {
        return failed([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'pptd_check',
    description:
      'Read-only validation of a workspace PPTD project: structure, text overflow, element occlusion, bounds and '
      + 'renderability. Returns every issue with its file, page and elementId. needs_revision is a normal '
      + 'authoring result; fix the listed files and check again. Does not publish anything.',
    parameters: {
      project_path: { type: 'string', required: true, description: '工作区内 PPTD 工程目录或 .pptd 清单路径。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { project_path: projectPath } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      if (typeof projectPath !== 'string' || projectPath.trim() === '') return failed(['project_path：必须是非空的工作区相对路径'])
      try {
        const entry = await existingWorkspaceEntry(workspace.root, projectPath, 'project_path')
        const manifest = await resolvePptdEntry(entry)
        const project = await loadPptdProject(manifest)
        const report = validationReport(checkPptdProject(project), {
          projectDirectory: path.dirname(manifest),
          projectPath,
        })
        return {
          status: report.status === 'needs_revision' ? 'needs_revision' : 'ok',
          errorCount: report.errorCount,
          warningCount: report.warningCount,
          pageCount: report.pageCount,
          nativeObjectCount: report.nativeObjectCount,
          issues: report.issues,
        } as unknown as JsonValue
      } catch (cause) {
        return failed([messageOf(cause)])
      }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'pptd_render',
    description:
      'Convert the current workspace PPTD project into one editable PPTX. The project is validated again inside '
      + 'this operation: needs_revision means nothing was exported and the formatted issue list names every '
      + 'file/page/elementId to fix. A document without a theme is rendered with the session\'s chosen template '
      + 'theme, or the paper default theme when the session has no template. Only status exported is a delivery; '
      + 'report the returned PPTX path and keep the PPTD project for later edits.',
    parameters: {
      project_path: { type: 'string', required: true, description: '工作区内 PPTD 工程目录或 .pptd 清单路径。' },
      output_file: { type: 'string', required: true, description: '新的工作区内 .pptx 输出路径。' },
    },
    output: OUTCOME_OUTPUT,
    async execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const { project_path: projectPath, output_file: outputFile } = args as Record<string, unknown>
      const workspace = workspaceRootOf(exec)
      if ('reason' in workspace) return failed([workspace.reason])
      if (typeof projectPath !== 'string' || projectPath.trim() === '') return failed(['project_path：必须是非空的工作区相对路径'])
      if (typeof outputFile !== 'string' || !outputFile.toLowerCase().endsWith('.pptx')) {
        return failed(['output_file：必须是 .pptx 结尾的工作区相对路径'])
      }
      try {
        const entry = await existingWorkspaceEntry(workspace.root, projectPath, 'project_path')
        const manifest = await resolvePptdEntry(entry)
        const loaded = await loadPptdProject(manifest)
        // Theme fallback: a document that never wrote a theme is rendered with
        // the template this session picked, so the user's template choice
        // always steers the output. Without a template choice (natural-language
        // PPT request) the paper default keeps the deck styled. Documents with
        // their own theme keep it either way.
        const sessionId = exec.agent?.session.header.id
        const templateId = typeof sessionId === 'string' && sessionId !== '' ? modeStore.templateOf(sessionId) : null
        const templateEntry = templateId === null ? undefined : await templateById(templateId)
        const fallbackTheme = templateEntry === undefined ? PAPER_THEME : templatePptdTheme(templateEntry.meta)
        const project = applyFallbackTheme(loaded, fallbackTheme)
        const report = validationReport(checkPptdProject(project), {
          projectDirectory: path.dirname(manifest),
          projectPath,
        })
        if (report.status === 'needs_revision') {
          return { status: 'needs_revision', check: report, issuesText: formatValidation(report) } as unknown as JsonValue
        }
        const rendered = await renderPptdProject(project, { fallbackTheme })
        // Same link-planted-inside-project fence as every other writing tool,
        // plus tmp+rename so a symlink at the destination gets replaced (not
        // followed) and a failed write never leaves half a deck behind.
        const outAbs = await writableProjectFile(workspace.root, outputFile, 'output_file')
        const outTmp = `${outAbs}.${process.pid}.tmp`
        await writeFile(outTmp, Buffer.from(rendered.bytes))
        await rename(outTmp, outAbs)
        const sizeBytes = rendered.bytes.byteLength
        return {
          status: 'exported',
          outputPath: outputFile,
          projectPath,
          pageCount: project.pages.length,
          nativeObjectCount: rendered.nativeObjectCount,
          sizeBytes,
          sha256: sha256Of(rendered.bytes),
          check: {
            errorCount: report.errorCount,
            warningCount: report.warningCount,
            issues: report.issues,
          },
        } as unknown as JsonValue
      } catch (cause) {
        return failed([`渲染失败：${messageOf(cause)}；请先运行 pptd_check 并逐条修复`])
      }
    },
  })))

  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Host apply: register the tools, mount the session-level PPT mode (prompt
 * section + mode/template routes), and install the skill file.
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  const log = ctx.logger(name)

  // Session-level PPT mode: the store is the shared state between the mode
  // routes (writer), the prompt section (reader) and the render tool's theme
  // fallback. The in-memory map is loaded once; the disk copy persists
  // toggles across restarts. Legacy theme entries are migrated to the
  // closest bundled template at load.
  const modeStore = new PptModeStore(join(resolveDshHome(), 'storages', 'dsh-app-plugin-ppt', 'mode.json'), log)
  modeStore.load()
  // The suite-wide active-format claim: the mode routes write it, the client
  // polls it through /office-active to stand down when another format wins.
  const activeFile = officeActiveFilePath(resolveDshHome())
  if (modeStore.migratedCount > 0) log.info(`ppt mode: migrated ${String(modeStore.migratedCount)} legacy theme entries`)
  // Residual entries are harmless, but 30-day-old ones only indicate dead
  // sessions — prune them once per boot.
  const pruned = modeStore.prune()
  if (pruned > 0) log.info(`ppt mode: pruned ${String(pruned)} stale session entries`)

  ctx.effect(() => registerPptTools(ctx, modeStore), 'plugin-ppt: llm tools')

  // The prompt section is synchronous; prewarm the (static) template catalog
  // once and serve names from the snapshot.
  const templateNames = new Map<string, string>()
  ctx.effect(() => {
    void allTemplates().then((entries) => {
      for (const { meta } of entries) templateNames.set(meta.id, meta.name)
    }, (cause: unknown) => {
      log.warn(`template catalog prewarm failed: ${messageOf(cause)}`)
    })
    return () => undefined
  }, 'plugin-ppt: template catalog prewarm')

  // The unconditional entry rule reaches every assembly: a PPT request in a
  // session that never touched the mode toggle still lands in the pptd
  // workflow (paper theme) instead of degrading to prose.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:ppt-entry',
    order: PROMPT_ENTRY_SECTION_ORDER,
    text: pptDefaultSectionText(),
  }), 'plugin-ppt: ppt-entry prompt section')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:ppt-mode',
    order: PROMPT_SECTION_ORDER,
    // Per-assembly provider: '' (dropped by the renderer) unless the
    // assembling session has PPT mode on.
    text: (context) => pptModeSectionText(
      sessionId => ({ enabled: modeStore.isEnabled(sessionId), template: modeStore.templateOf(sessionId) }),
      id => templateNames.get(id),
      context,
    ),
  }), 'plugin-ppt: ppt-mode prompt section')

  ctx.effect(() => registerPptRoutes(ctx.webServer, modeStore, activeFile), 'plugin-ppt: mode routes')

  ctx.effect(() => {
    // Fire-and-forget: the skill file outlives this fiber, so the effect owns
    // no unmount work — only the boot log entry.
    void installSkill(resolveDshHome()).then(
      (result) => {
        if (result === 'installed') log.info(`ppt skill installed: ${SKILL_NAME}`)
      },
      (cause: unknown) => {
        log.warn(`ppt skill install failed: ${messageOf(cause)}`)
      },
    )
    return () => undefined
  }, 'plugin-ppt: skill install')
}
