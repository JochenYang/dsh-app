/**
 * The three LLM tools over the FFF engine:
 *   `fffind`   — fuzzy file/directory search over the workspace (whole
 *                workspace-relative path, typo-tolerant, frecency-ranked).
 *   `ffgrep`   — live content search (plain / regex / fuzzy; smart-case;
 *                context lines; definition classification).
 *   `fff-glob` — single-pass SIMD glob filtering (npm-glob compatible).
 *
 * Every tool is fenced to the EXECUTING agent's session workspace: the root
 * is resolved from `exec.agent.session.header.cwd`, never from model input,
 * and FFF only ever returns paths relative to that root — the workspace
 * fence is the engine itself. Failures return a stable, actionable zh-CN
 * `{ ok: false, reason }` (never thrown), so the model can relay them.
 *
 * All tools are read-only and safe to run concurrently (shared finder per
 * workspace; PickerManager guards instance ownership and reaping).
 *
 * @module @dsh-app/plugin-fff/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// Type-only: pulls the agent/session augmentation (exec.agent.session.header.cwd) into scope.
import type {} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { GrepMode } from '@ff-labs/fff-node'
import { PickerManager, type HeldFinder } from './picker.ts'

/** Ceiling for a single match line echoed back (context economy). */
const MAX_LINE_CHARS = 200
const MIN_PAGE = 1
const MAX_PAGE = 500

// --- result shapes (what the model sees; every path is workspace-relative) ---

interface FindItem {
  relativePath: string
  fileName: string
  isDir: boolean
  size?: number
  modified?: number
  gitStatus?: string
}

interface GrepItem {
  relativePath: string
  fileName: string
  lineNumber: number
  col: number
  lineContent: string
  isDefinition?: boolean
  contextBefore?: string[]
  contextAfter?: string[]
}

interface FindResult { ok: true; basePath: string; query: string; total: number; truncated: boolean; items: FindItem[] }
interface GrepResult { ok: true; basePath: string; query: string; total: number; more: boolean; filesSearched: number; items: GrepItem[] }
interface GlobResult { ok: true; basePath: string; pattern: string; total: number; truncated: boolean; items: { relativePath: string }[] }

// --- helpers -----------------------------------------------------------------

/**
 * The ONE place a tool result crosses into the kernel's `JsonValue` schema.
 *
 * Why the assertion cannot be dropped: `JsonValue` is a recursive mapped type
 * with an index signature, and TypeScript cannot prove a plain interface
 * (`FindItem` and its siblings) satisfies one — the standard limitation with
 * recursive index-signature types. Every producer in this file builds a
 * plain-JSON shape by construction (strings, numbers, booleans, arrays), so
 * the single reviewed boundary lives here instead of an `as unknown as` on
 * every return site; the read direction (the renderers below) narrows
 * field-by-field and needs no assertion at all.
 */
function asJson(value: object): JsonValue {
  return value as unknown as JsonValue
}

function fmtError(reason: string): JsonValue {
  return asJson({ ok: false, reason })
}

function execCwd(exec: ToolRunContext): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function boundPage(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(MAX_PAGE, Math.max(MIN_PAGE, Math.floor(n))) : fallback
}

/** Shorten a matched line without cutting a message the model can still act on. */
function clampLine(content: string): string {
  return content.length <= MAX_LINE_CHARS ? content : `${content.slice(0, MAX_LINE_CHARS)}…`
}

/**
 * Run `fn` against the workspace's finder. Missing/expected failures resolve
 * to a stable `{ ok: false, reason }`; implementation surprises throw.
 */
function withFinder(
  picker: PickerManager,
  scanWaitMs: number,
  exec: ToolRunContext,
  fn: (held: HeldFinder) => JsonValue | Promise<JsonValue>,
): Promise<JsonValue> {
  const cwd = execCwd(exec)
  if (cwd === undefined) {
    return Promise.resolve(fmtError('没有可搜索的工作区，请先在工作区中打开会话'))
  }
  return picker.acquire(cwd, scanWaitMs).then((res) => {
    if (!res.ok) return fmtError(res.error)
    const { held } = res
    try {
      return Promise.resolve(fn(held))
    } finally {
      held.done()
    }
  })
}

function errDetail(fallback: string, error: string | undefined): JsonValue {
  const detail = typeof error === 'string' && error !== '' ? `（${error.slice(0, 200)}）` : ''
  return fmtError(`${fallback}${detail}`)
}

// --- renderers (readable text over raw JSON: smaller, model-consumable) ------

/**
 * Field-by-field narrowing of the value back into its result shape. No
 * assertion survives here: a value the kernel (or a future line) hands the
 * renderer is either the shape a producer above built, or it is not a result
 * at all — and an unrecognized shape renders as "no match" instead of
 * throwing inside the client's render path.
 */
function asRecord(value: JsonValue): Record<string, JsonValue> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null
}

function findItemOf(value: JsonValue): FindItem | null {
  const record = asRecord(value)
  if (record === null) return null
  const relativePath = record.relativePath
  if (typeof relativePath !== 'string') return null
  const item: FindItem = { relativePath, fileName: '', isDir: record.isDir === true }
  if (typeof record.fileName === 'string') item.fileName = record.fileName
  if (typeof record.size === 'number') item.size = record.size
  if (typeof record.modified === 'number') item.modified = record.modified
  if (typeof record.gitStatus === 'string') item.gitStatus = record.gitStatus
  return item
}

function grepItemOf(value: JsonValue): GrepItem | null {
  const record = asRecord(value)
  if (record === null) return null
  const { relativePath, lineNumber, col, lineContent } = record
  if (typeof relativePath !== 'string' || typeof lineNumber !== 'number'
    || typeof col !== 'number' || typeof lineContent !== 'string') return null
  const item: GrepItem = { relativePath, lineNumber, col, lineContent }
  if (typeof record.isDefinition === 'boolean') item.isDefinition = record.isDefinition
  if (Array.isArray(record.contextBefore)) item.contextBefore = record.contextBefore.map(String)
  if (Array.isArray(record.contextAfter)) item.contextAfter = record.contextAfter.map(String)
  return item
}

function readFind(value: JsonValue): FindResult | null {
  const record = asRecord(value)
  const items = record?.items
  if (record === null || record.ok !== true || !Array.isArray(items)) return null
  const parsed = items.map(findItemOf).filter((item): item is FindItem => item !== null)
  return {
    ok: true,
    basePath: typeof record.basePath === 'string' ? record.basePath : '',
    query: typeof record.query === 'string' ? record.query : '',
    total: typeof record.total === 'number' ? record.total : parsed.length,
    truncated: record.truncated === true,
    items: parsed,
  }
}

function readGrep(value: JsonValue): GrepResult | null {
  const record = asRecord(value)
  const items = record?.items
  if (record === null || record.ok !== true || !Array.isArray(items)) return null
  const parsed = items.map(grepItemOf).filter((item): item is GrepItem => item !== null)
  return {
    ok: true,
    basePath: typeof record.basePath === 'string' ? record.basePath : '',
    query: typeof record.query === 'string' ? record.query : '',
    total: typeof record.total === 'number' ? record.total : parsed.length,
    more: record.more === true,
    filesSearched: typeof record.filesSearched === 'number' ? record.filesSearched : 0,
    items: parsed,
  }
}

function readGlob(value: JsonValue): GlobResult | null {
  const record = asRecord(value)
  const items = record?.items
  if (record === null || record.ok !== true || !Array.isArray(items)) return null
  const parsed = items
    .map((entry) => asRecord(entry)?.relativePath)
    .filter((relativePath): relativePath is string => typeof relativePath === 'string')
    .map((relativePath) => ({ relativePath }))
  return {
    ok: true,
    basePath: typeof record.basePath === 'string' ? record.basePath : '',
    pattern: typeof record.pattern === 'string' ? record.pattern : '',
    total: typeof record.total === 'number' ? record.total : parsed.length,
    truncated: record.truncated === true,
    items: parsed,
  }
}

function renderFind(value: JsonValue): string {
  const v = readFind(value)
  if (v === null) return '无匹配'
  const lines = v.items.map((it) => `[${it.isDir ? 'd' : 'f'}] ${it.relativePath}`)
  if (v.truncated && lines.length > 0) lines.push(`… 还有更多匹配（total ${String(v.total)}），可缩小查询或加前缀过滤`)
  return lines.length > 0 ? lines.join('\n') : '无匹配'
}

function renderGrep(value: JsonValue): string {
  const v = readGrep(value)
  if (v === null) return '无匹配'
  const blocks = v.items.map((it) => {
    const head = `${it.relativePath}:${String(it.lineNumber)}:${String(it.col)} ${clampLine(it.lineContent)}`
    const before = (it.contextBefore ?? []).map((l) => `      ${l}`)
    const after = (it.contextAfter ?? []).map((l) => `      ${l}`)
    return [head, ...before, ...after].join('\n')
  })
  if (v.more && blocks.length > 0) blocks.push(`… 还有更多匹配（total ${String(v.total)}），可缩小查询或加前缀过滤`)
  return blocks.length > 0 ? blocks.join('\n\n') : '无匹配'
}

function renderGlob(value: JsonValue): string {
  const v = readGlob(value)
  if (v === null) return '无匹配'
  const lines = v.items.map((it) => it.relativePath)
  if (v.truncated && lines.length > 0) lines.push(`… 还有更多匹配（total ${String(v.total)}），可缩窄 pattern`)
  return lines.length > 0 ? lines.join('\n') : '无匹配'
}

// --- registration ------------------------------------------------------------

/**
 * Register all three FFF tools on the context.
 * @param ctx - host plugin context (tools service).
 * @param picker - instance owner/resolver.
 * @param scanWaitMs - initial-scan wait budget per workspace, ms.
 * @returns disposer removing all registrations.
 */
export function registerFffTools(ctx: Context, picker: PickerManager, scanWaitMs: number): () => void {
  const disposeFind = ctx.tools.register(defineTool({
    name: 'fffind',
    description:
      'Fuzzy file/directory search over the current workspace. Matches the whole workspace-relative path '
      + '(not just the filename) and tolerates typos/substring order. Ranked by score then access '
      + 'frequency. Every result path is relative to the workspace root. Use it instead of reading files '
      + 'one by one when locating paths.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search term for file/directory paths (e.g. "quote store", "src util"). Directories may match too.',
      },
      pageSize: {
        type: 'number',
        description: 'Max results (default 20, up to 500).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderFind(value) }],
    },
    execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const query = String(args.query ?? '').trim()
      if (query === '') return Promise.resolve(fmtError('查询词不能为空'))
      const pageSize = boundPage(args.pageSize, 20)
      return withFinder(picker, scanWaitMs, exec, (held) => {
        const r = held.finder.mixedSearch(query, { pageSize })
        if (!r.ok) return errDetail('搜索失败', r.error)
        const items: FindItem[] = r.value.items.map((mixed) =>
          mixed.type === 'directory'
            ? { relativePath: mixed.item.relativePath, fileName: mixed.item.dirName.replace(/\/$/, ''), isDir: true }
            : {
                relativePath: mixed.item.relativePath,
                fileName: mixed.item.fileName,
                isDir: false,
                size: mixed.item.size,
                modified: mixed.item.modified,
                gitStatus: mixed.item.gitStatus,
              })
        return asJson({
          ok: true,
          basePath: held.key,
          query,
          total: r.value.totalMatched,
          truncated: r.value.totalMatched > items.length,
          items,
        })
      })
    },
  }))

  const disposeGrep = ctx.tools.register(defineTool({
    name: 'ffgrep',
    description:
      'Search file contents in the current workspace. Plain mode matches bare identifiers/words literally '
      + '(e.g. "RegisterFffTools"), NOT regex. Prefix the query with a file/glob constraint to restrict the '
      + 'search, e.g. "*.rs async" or "src/ index". Use mode=regex only when a literal term is not enough. '
      + 'Match lines are returned with path:line:col. Results are workspace-relative paths.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search term, optionally with a constraint prefix: "*.ts term" (glob) or "src/ term" (directory).',
      },
      mode: {
        type: 'string',
        enum: ['plain', 'regex', 'fuzzy'],
        description: 'plain (default): fast literal match; regex: regular expression; fuzzy: per-line fuzzy score.',
      },
      smartCase: {
        type: 'boolean',
        description: 'Case-insensitive when the query is all lowercase (default true).',
      },
      beforeContext: { type: 'number', description: 'Context lines before each match (default 0).' },
      afterContext: { type: 'number', description: 'Context lines after each match (default 0).' },
      pageSize: { type: 'number', description: 'Max matches (default 50, up to 500).' },
      timeBudgetMs: { type: 'number', description: 'Optional wall-clock budget in ms; returns partial results when exhausted (0 = unlimited).' },
      classifyDefinitions: { type: 'boolean', description: 'Tag match lines that look like code definitions (default false).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderGrep(value) }],
    },
    execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const query = String(args.query ?? '').trim()
      if (query === '') return Promise.resolve(fmtError('查询词不能为空'))
      const mode: GrepMode = args.mode === 'regex' || args.mode === 'fuzzy' ? args.mode : 'plain'
      const pageSize = boundPage(args.pageSize, 50)
      const timeBudget = Number(args.timeBudgetMs)
      return withFinder(picker, scanWaitMs, exec, (held) => {
        const r = held.finder.grep(query, {
          mode,
          smartCase: args.smartCase !== false,
          beforeContext: Math.max(0, Number(args.beforeContext) || 0),
          afterContext: Math.max(0, Number(args.afterContext) || 0),
          pageSize,
          classifyDefinitions: args.classifyDefinitions === true,
          ...(Number.isFinite(timeBudget) && timeBudget > 0 ? { timeBudgetMs: Math.floor(timeBudget) } : {}),
        })
        if (!r.ok) return errDetail('搜索失败', r.error)
        const items: GrepItem[] = r.value.items.map((m) => ({
          relativePath: m.relativePath,
          fileName: m.fileName,
          lineNumber: m.lineNumber,
          col: m.col,
          lineContent: m.lineContent,
          isDefinition: m.isDefinition,
          contextBefore: m.contextBefore,
          contextAfter: m.contextAfter,
        }))
        return asJson({
          ok: true,
          basePath: held.key,
          query,
          total: r.value.totalMatched,
          more: r.value.nextCursor !== null && r.value.nextCursor !== undefined,
          filesSearched: r.value.totalFilesSearched,
          items,
        })
      })
    },
  }))

  const disposeGlob = ctx.tools.register(defineTool({
    name: 'fff-glob',
    description:
      'Fast single-pass glob filtering over the current workspace index (same semantics as npm glob): '
      + 'e.g. "**/*.rs", "src/**/*.test.ts". No fuzzy matching; returns exact positional matches. '
      + 'Workspace-relative paths only. Useful to enumerate a file set precisely before reading.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern (npm-glob compatible), e.g. "**/*.md" or "plugins/*/package.json".',
      },
      pageSize: { type: 'number', description: 'Max results (default 100, up to 500).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderGlob(value) }],
    },
    execute(args, exec: ToolRunContext): Promise<JsonValue> {
      const pattern = String(args.pattern ?? '').trim()
      if (pattern === '') return Promise.resolve(fmtError('pattern 不能为空'))
      const pageSize = boundPage(args.pageSize, 100)
      return withFinder(picker, scanWaitMs, exec, (held) => {
        const r = held.finder.glob(pattern, { pageSize })
        if (!r.ok) return errDetail('glob 匹配失败（pattern 可能不合法）', r.error)
        return asJson({
          ok: true,
          basePath: held.key,
          pattern,
          total: r.value.totalMatched,
          truncated: r.value.totalMatched > r.value.items.length,
          items: r.value.items.map((it) => ({ relativePath: it.relativePath })),
        })
      })
    },
  }))

  return () => { disposeFind(); disposeGrep(); disposeGlob() }
}