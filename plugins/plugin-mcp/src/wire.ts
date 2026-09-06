/**
 * Pure entry wiring shared by both plugin halves: validation, external
 * mcpServers JSON ingestion (the paste/import surface), and serialization.
 * Zero node builtins — the browser bundle imports this module directly.
 *
 * External shapes accepted (the de-facto MCP config formats users already
 * have from Claude Desktop / Cursor / VS Code):
 *
 *   {"mcpServers": {"name": {...}}}   full config file (wrapper stripped)
 *   {"name": {...}}                   bare server map
 *
 * One definition maps as:
 *   type "stdio" (or a command without a type)  → stdio  (command/args/env/cwd)
 *   type "http" | "streamable-http" (or a url)  → streamable-http (url/headers)
 *   type "sse"                                  → rejected (kernel bridge does not bridge SSE)
 *
 * Unknown fields are ignored (forward compatible).
 *
 * @module @dsh-app/plugin-mcp/wire
 */

/** Upstream mcp-client contract: server namespace shape and size. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Why the pattern exists — the name becomes the model-facing tool namespace
 * (`mcp__<serverName>__<tool>`). Used in every name-invalid rejection so the
 * error teaches the contract instead of just stating it.
 */
export function invalidServerNameReason(name: string): string {
  return `服务器名「${name}」不合法：它会成为工具名（mcp__服务器名__工具名）的命名空间，只能包含 1–32 位字母、数字、下划线、连字符（例如 "figma"）`
}

/**
 * Derive a valid serverName from an arbitrary display name, e.g.
 * "Framelink MCP for Figma" → "Framelink_MCP_for_Figma". Returns undefined
 * when no valid form exists (empty after stripping, or the 32-char cap
 * leaves a non-word tail).
 */
export function slugifyServerName(name: string): string | undefined {
  const slug = name
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+/, '')
    .slice(0, 32)
    .replace(/[_-]+$/, '')
  return slug !== '' && SERVER_NAME_PATTERN.test(slug) ? slug : undefined
}

/** Validation failure of a settings-page write (routes map it to 400). */
export class McpValidationError extends Error {}

/** Transport of one external MCP server (upstream mcp-client contract). */
export type McpTransport = 'stdio' | 'streamable-http'

/**
 * One configured MCP server. Field presence follows the transport: stdio
 * carries `command`/`args`/`env`/`cwd`, streamable-http carries `url`/
 * `headers`. `toolCallTimeoutMs` and `reconnect` knobs stay optional and
 * default upstream.
 */
export interface McpServerEntry {
  /** Stable CRUD id (`mcp-<n>`), independent of `serverName`. */
  readonly id: string
  /** Tool namespace, `[A-Za-z0-9_-]{1,32}`, unique among ENABLED servers. */
  readonly serverName: string
  readonly transport: McpTransport
  /** Disabled entries stay persisted but are never mounted. */
  readonly enabled: boolean
  // --- stdio ---
  readonly command?: string
  readonly args?: readonly string[]
  /** Values may reference environment variables as `$ENV:NAME`. */
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  // --- streamable-http ---
  readonly url?: string
  /** Values may reference environment variables as `$ENV:NAME`. */
  readonly headers?: Readonly<Record<string, string>>
  /** Per-tool-call timeout in ms; omitted uses the upstream default (60s). */
  readonly toolCallTimeoutMs?: number
}

/** The persisted `servers.json` shape. */
export interface McpServersFile {
  readonly version: 1
  /** Master switch: false mounts nothing and refuses writes from the UI. */
  readonly enabled: boolean
  readonly servers: readonly McpServerEntry[]
}

/** Mount state of one entry, computed by the mount manager. */
export interface McpMountStatus {
  /** mounted | starting | disabled | error | unavailable (no loader seam). */
  readonly state: 'mounted' | 'starting' | 'disabled' | 'error' | 'unavailable'
  /** Human-readable detail: mount error, or an `$ENV:` resolution warning. */
  readonly message?: string
  /** Live `mcp__<serverName>__*` tool count when the tools registry is readable. */
  readonly toolCount?: number
}

type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new McpValidationError(`${label} 必须是字符串键值对`)
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new McpValidationError(`${label}.${key} 必须是字符串`)
    out[key] = entry
  }
  return out
}

/** The id sequence is monotonic per file: `mcp-1`, `mcp-2`, … */
export function nextEntryId(servers: readonly McpServerEntry[]): string {
  let max = 0
  for (const entry of servers) {
    const match = /^mcp-(\d+)$/.exec(entry.id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return `mcp-${String(max + 1)}`
}

/**
 * Validate one raw entry object into a {@link McpServerEntry}. Throws
 * {@link McpValidationError} with a zh-CN reason — usable both for route
 * writes (400) and for load-time degradation (caught and logged).
 * @param existingIds - ids taken by OTHER entries (the entry keeps its own).
 */
export function validateEntry(raw: unknown, existingIds: ReadonlySet<string>): McpServerEntry {
  if (!isRecord(raw)) throw new McpValidationError('服务器配置必须是对象')
  const id = asString(raw.id)
  if (id === undefined || !/^mcp-\d+$/.test(id) || existingIds.has(id)) {
    throw new McpValidationError('服务器 id 缺失或不合法')
  }
  const serverName = asString(raw.serverName)
  if (serverName === undefined || !SERVER_NAME_PATTERN.test(serverName)) {
    throw new McpValidationError('serverName 只能包含字母、数字、下划线和连字符（1–32 位）')
  }
  const transport = asString(raw.transport)
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw new McpValidationError('transport 必须是 stdio 或 streamable-http')
  }
  const entry: {
    id: string
    serverName: string
    transport: McpTransport
    enabled: boolean
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    url?: string
    headers?: Record<string, string>
    toolCallTimeoutMs?: number
  } = { id, serverName, transport, enabled: raw.enabled !== false }

  if (transport === 'stdio') {
    const command = asString(raw.command)?.trim() ?? ''
    if (command === '') throw new McpValidationError('stdio 服务器必须填写启动命令（command）')
    entry.command = command
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some(arg => typeof arg !== 'string')) {
        throw new McpValidationError('args 必须是字符串数组')
      }
      entry.args = raw.args as string[]
    }
    if (raw.env !== undefined) {
      const env = asStringRecord(raw.env, 'env')
      if (env === undefined) throw new McpValidationError('env 必须是字符串键值对')
      entry.env = env
    }
    if (raw.cwd !== undefined) {
      const cwd = asString(raw.cwd)
      if (cwd === undefined || cwd.trim() === '') throw new McpValidationError('cwd 必须是非空字符串')
      entry.cwd = cwd.trim()
    }
  } else {
    const url = asString(raw.url)?.trim() ?? ''
    let parsed: URL | undefined
    try {
      parsed = url === '' ? undefined : new URL(url)
    } catch {
      parsed = undefined
    }
    if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new McpValidationError('streamable-http 服务器必须填写合法的 http(s) URL')
    }
    entry.url = url
    if (raw.headers !== undefined) {
      const headers = asStringRecord(raw.headers, 'headers')
      if (headers === undefined) throw new McpValidationError('headers 必须是字符串键值对')
      entry.headers = headers
    }
  }

  if (raw.toolCallTimeoutMs !== undefined) {
    const timeout = raw.toolCallTimeoutMs
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw new McpValidationError('toolCallTimeoutMs 必须是正数')
    }
    entry.toolCallTimeoutMs = Math.floor(timeout)
  }
  return entry
}

/** Enforce the upstream uniqueness contract: one live namespace per name. */
export function assertUniqueServerName(entry: McpServerEntry, servers: readonly McpServerEntry[]): void {
  if (!entry.enabled) return
  const clash = servers.some(other => other.id !== entry.id && other.enabled && other.serverName === entry.serverName)
  if (clash) throw new McpValidationError(`serverName "${entry.serverName}" 已被其他启用的服务器使用`)
}

// ---- external mcpServers JSON ------------------------------------------------

/** One parsed external server: its name key and raw definition object. */
export interface ParsedExternalServer {
  readonly name: string
  readonly def: Raw
}

/**
 * Parse pasted JSON into external server definitions. Accepts the
 * `{"mcpServers": {...}}` wrapper (Claude/Cursor config files) or a bare
 * name→definition map. Throws {@link McpValidationError} with a zh-CN reason.
 */
export function parseMcpServersJson(text: string): ParsedExternalServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new McpValidationError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) throw new McpValidationError('JSON 顶层必须是对象')
  const map = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
  const names = Object.keys(map)
  if (names.length === 0) throw new McpValidationError('没有找到任何服务器定义')
  return names.map(name => {
    const def = map[name]
    if (!isRecord(def)) throw new McpValidationError(`服务器「${name}」的定义必须是对象`)
    return { name, def }
  })
}

/** Normalize one external transport type; undefined when absent. */
function normalizeType(def: Raw): string | undefined {
  const type = asString(def.type)?.trim().toLowerCase()
  if (type === undefined || type === '') return undefined
  if (type === 'stdio') return 'stdio'
  if (type === 'http' || type === 'streamable-http' || type === 'streamable_http') return 'streamable-http'
  if (type === 'sse') {
    throw new McpValidationError('暂不支持 SSE 传输（内核桥仅支持 stdio 与 Streamable HTTP），请改用该服务器的 HTTP 端点')
  }
  throw new McpValidationError(`不认识的 type：「${type}」（支持 stdio / http）`)
}

/**
 * Map one external server definition onto the plugin's raw entry shape
 * (still unvalidated — the store validates on create). `name` becomes
 * `serverName` and must satisfy the upstream pattern.
 */
export function mapExternalServer(name: string, def: Raw): Raw {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new McpValidationError(invalidServerNameReason(name))
  }
  const type = normalizeType(def)
  const url = asString(def.url)?.trim()
  const hasCommand = asString(def.command)?.trim() !== '' && def.command !== undefined
  const transport = type ?? (url !== undefined && url !== '' ? 'streamable-http' : hasCommand ? 'stdio' : undefined)
  if (transport === undefined) {
    throw new McpValidationError(`服务器「${name}」缺少可识别的连接字段（需要 url 或 command）`)
  }

  const out: Raw = { serverName: name, transport }
  if (transport === 'stdio') {
    const command = asString(def.command)?.trim() ?? ''
    if (command === '') throw new McpValidationError(`服务器「${name}」是 stdio 但缺少 command`)
    out.command = command
    if (def.args !== undefined) {
      if (!Array.isArray(def.args) || def.args.some(arg => typeof arg !== 'string')) {
        throw new McpValidationError(`服务器「${name}」的 args 必须是字符串数组`)
      }
      out.args = def.args
    }
    const env = asStringRecord(def.env, `服务器「${name}」的 env`)
    if (env !== undefined) out.env = env
    const cwd = asString(def.cwd)?.trim()
    if (cwd !== undefined && cwd !== '') out.cwd = cwd
  } else {
    if (url === undefined || url === '') throw new McpValidationError(`服务器「${name}」缺少 url`)
    if (!/^https?:\/\//.test(url)) throw new McpValidationError(`服务器「${name}」的 url 必须是 http(s) 地址`)
    out.url = url
    const headers = asStringRecord(def.headers, `服务器「${name}」的 headers`)
    if (headers !== undefined) out.headers = headers
  }

  if (def.toolCallTimeoutMs !== undefined) {
    const timeout = def.toolCallTimeoutMs
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw new McpValidationError(`服务器「${name}」的 toolCallTimeoutMs 必须是正数`)
    }
    out.toolCallTimeoutMs = Math.floor(timeout)
  }
  return out
}

/** Serialize one entry into the external mcpServers fragment (JSON view). */
export function entryToExternal(entry: {
  serverName: string
  transport: string
  command?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  cwd?: string
  url?: string
  headers?: Readonly<Record<string, string>>
  toolCallTimeoutMs?: number
}): Raw {
  const def: Raw = entry.transport === 'stdio' ? { type: 'stdio' } : { type: 'http' }
  if (entry.transport === 'stdio') {
    if (entry.command !== undefined) def.command = entry.command
    if (entry.args !== undefined && entry.args.length > 0) def.args = [...entry.args]
    if (entry.env !== undefined && Object.keys(entry.env).length > 0) def.env = { ...entry.env }
    if (entry.cwd !== undefined && entry.cwd !== '') def.cwd = entry.cwd
  } else {
    if (entry.url !== undefined) def.url = entry.url
    if (entry.headers !== undefined && Object.keys(entry.headers).length > 0) def.headers = { ...entry.headers }
  }
  if (entry.toolCallTimeoutMs !== undefined) def.toolCallTimeoutMs = entry.toolCallTimeoutMs
  return { [entry.serverName]: def }
}
