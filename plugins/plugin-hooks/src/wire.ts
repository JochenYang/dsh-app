/**
 * Pure entry wiring for the hooks bridge plugin: validation, dialect→kernel
 * mapping, and the wire-config builder. Zero node builtins — the browser
 * bundle imports this module directly.
 *
 * Two dialects map to two kernel plugins:
 *   claude-code → @deepseek-ai/dsh-hooks-claude-code (configPath, pluginRoot, projectDir, ...)
 *   codex       → @deepseek-ai/dsh-hooks-codex       (configPath, model, ...)
 *
 * @module @dsh-app/plugin-hooks/wire
 */

/**
 * A user-visible message the host cannot localize — and deliberately does not
 * try to.
 *
 * The host is a long-lived child process: its language would be decided at
 * boot, so switching the UI language would require restarting the kernel. It
 * therefore never sends prose. It sends a stable code plus the values the
 * sentence interpolates, and the client — which owns the locale namespace —
 * renders it. `text` is an ENGLISH diagnostic used only for a code this client
 * does not know (an older UI beside a newer kernel); it is never a localized
 * sentence, because matching on one across a boundary is how the kernel-side
 * failure classifier once misread "tampered" as "network error".
 */
export interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  /** English developer-facing fallback; shown only for an unknown code. */
  readonly text?: string
}

/**
 * Validation failure of a settings-page write (routes map it to 400).
 *
 * Carries a code plus its params rather than a sentence: the client renders the
 * copy, and `super()` keeps an English developer-facing message for logs.
 */
export class HooksValidationError extends Error {
  /**
   * @param code - stable message code (see the `hooks.host.*` keys).
   * @param params - values the client's copy interpolates.
   */
  constructor(readonly code: string, readonly params?: Readonly<Record<string, string | number>>) {
    super(`hooks config rejected: ${code}`)
    this.name = 'HooksValidationError'
  }

  /** The coded message, in the shape every host route speaks. */
  hostText(): HostText {
    return this.params === undefined ? { code: this.code } : { code: this.code, params: this.params }
  }
}

/** The two compatibility dialects + the DSH-native format. */
export type BridgeDialect = 'native' | 'claude-code' | 'codex'

/** Kernel plugin name per dialect; 'native' never mounts a kernel plugin. */
export const KERNEL_PLUGIN: Readonly<Record<Exclude<BridgeDialect, 'native'>, string>> = {
  'claude-code': '@deepseek-ai/dsh-hooks-claude-code',
  'codex': '@deepseek-ai/dsh-hooks-codex',
}

/** One native-format rule — DSH APP's own hook format, simpler than CC's. */
export interface NativeRule {
  /** Human-readable rule name. */
  name: string
  /** Which interception point the rule fires at. */
  on: 'pre-tool-use' | 'post-tool-use' | 'prompt-submit' | 'session-start'
  /** Optional regex matched against the tool name (tool events only). */
  matcher?: string
  /** block = deny/feedback with message; context = inject message (prompt-submit/session-start). */
  action: 'block' | 'context'
  /** The block reason or injected context text. */
  message: string
}

/** Which action/event combinations the native runtime implements. */
const NATIVE_SUPPORTED: Readonly<Record<NativeRule['on'], readonly NativeRule['action'][]>> = {
  'pre-tool-use': ['block'],
  'post-tool-use': ['block'],
  'prompt-submit': ['context', 'block'],
  'session-start': ['context'],
}

/**
 * Parse and validate a native-format config body into rules. Throws
 * {@link HooksValidationError} with a code on any invalid rule.
 */
export function parseNativeRules(content: string): NativeRule[] {
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch (error) {
    throw new HooksValidationError('native.jsonParseFailed', {
      detail: error instanceof Error ? error.message : String(error),
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HooksValidationError('native.notObject')
  }
  const rawRules = (parsed as { rules?: unknown }).rules
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    throw new HooksValidationError('native.rulesRequired')
  }
  return rawRules.map((raw, index): NativeRule => {
    const label = `rules[${index}]`
    if (typeof raw !== 'object' || raw === null) throw new HooksValidationError('native.ruleNotObject', { label })
    const rule = raw as Record<string, unknown>
    const name = typeof rule.name === 'string' && rule.name.trim() !== '' ? rule.name.trim() : `${label}`
    const on = rule.on
    if (on !== 'pre-tool-use' && on !== 'post-tool-use' && on !== 'prompt-submit' && on !== 'session-start') {
      throw new HooksValidationError('native.onInvalid', { label, name })
    }
    const action = rule.action
    if (action !== 'block' && action !== 'context') {
      throw new HooksValidationError('native.actionInvalid', { label, name })
    }
    if (!(NATIVE_SUPPORTED[on] as readonly string[]).includes(action)) {
      throw new HooksValidationError('native.actionUnsupported', { label, name, on, action })
    }
    const message = typeof rule.message === 'string' && rule.message.trim() !== '' ? rule.message : ''
    if (message === '') throw new HooksValidationError('native.messageRequired', { label, name })
    let matcher: string | undefined
    if (rule.matcher !== undefined) {
      if (typeof rule.matcher !== 'string' || rule.matcher.trim() === '') {
        throw new HooksValidationError('native.matcherRequired', { label, name })
      }
      try { void new RegExp(rule.matcher) } catch {
        throw new HooksValidationError('native.matcherInvalid', { label, name, matcher: rule.matcher })
      }
      matcher = rule.matcher
    }
    return { name, on, matcher, action, message }
  })
}

/** One configured hooks entry. */
export interface HooksBridge {
  /** Stable CRUD id (`hook-<n>`). */
  readonly id: string
  /** Which dialect's hooks.json this entry reads. */
  readonly dialect: BridgeDialect
  /** Disabled entries stay persisted but never mount. */
  readonly enabled: boolean
  /** 'file' = point at an existing hooks.json; 'inline' = content authored in the UI, saved as a managed file. */
  readonly configSource: 'file' | 'inline'
  /** Absolute path to the hooks.json. For inline source, this is the managed file path. */
  readonly configPath: string
  /** For inline source: the hooks.json content (read from the managed file on load). */
  readonly configContent?: string
  // --- claude-code only ---
  /** Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings. */
  readonly pluginRoot?: string
  /** Replaces `${CLAUDE_PROJECT_DIR}` + exports the env var. */
  readonly projectDir?: string
  // --- codex only ---
  /** Model name stamped on every Codex payload. */
  readonly model?: string
  // --- shared ---
  readonly defaultTimeoutMs?: number
  readonly stderrSummaryMaxChars?: number
}

/** The persisted `config.json` shape. */
export interface HooksConfigFile {
  readonly version: 1
  readonly enabled: boolean
  readonly bridges: readonly HooksBridge[]
}

/**
 * Mount state (mirrors the mcp manager's vocabulary).
 */
export interface HooksMountStatus {
  readonly state: 'mounted' | 'starting' | 'disabled' | 'error' | 'unavailable'
  /**
   * Why the entry is not healthy, in the coded shape; see {@link HostText}.
   * Host-authored, so it never crosses as prose: the one message that is not a
   * sentence of ours — the loader's own failure text (`mount.failed`) — rides
   * as the English `text` of its code, because a third-party diagnostic has
   * nothing to translate.
   */
  readonly message?: HostText
}

type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Monotonic id: `hook-1`, `hook-2`, … */
export function nextBridgeId(bridges: readonly HooksBridge[]): string {
  let max = 0
  for (const b of bridges) {
    const m = /^hook-(\d+)$/.exec(b.id)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return `hook-${String(max + 1)}`
}

/**
 * Validate one raw bridge into a {@link HooksBridge}. Throws
 * {@link HooksValidationError} with a code.
 * @param existingIds - ids taken by OTHER entries.
 */
export function validateBridge(raw: unknown, existingIds: ReadonlySet<string>): HooksBridge {
  if (!isRecord(raw)) throw new HooksValidationError('bridge.notObject')
  const id = asString(raw.id)
  if (id === undefined || !/^hook-\d+$/.test(id) || existingIds.has(id)) {
    throw new HooksValidationError('bridge.badId')
  }
  const dialect = asString(raw.dialect)
  if (dialect !== 'native' && dialect !== 'claude-code' && dialect !== 'codex') {
    throw new HooksValidationError('dialect.invalid')
  }
  let configSource = asString(raw.configSource) ?? (dialect === 'native' ? 'inline' : 'file')
  if (dialect === 'native' && configSource === 'file') {
    throw new HooksValidationError('native.noExternalFile')
  }
  if (configSource !== 'file' && configSource !== 'inline') {
    throw new HooksValidationError('configSource.invalid')
  }
  let configPath = asString(raw.configPath)?.trim() ?? ''
  let configContent: string | undefined
  if (configSource === 'inline') {
    configContent = asString(raw.configContent)
    // configContent may be absent on load (it lives in the managed file);
    // the route/store layer enforces non-empty on create/update.
    if (configContent !== undefined && configContent.trim() === '') {
      throw new HooksValidationError('config.inlineEmpty')
    }
    // configPath is managed by the store; accept an empty value here.
  } else {
    if (configPath === '') throw new HooksValidationError('configPath.required')
  }
  const bridge: {
    id: string; dialect: BridgeDialect; enabled: boolean; configSource: 'file' | 'inline'
    configPath: string; configContent?: string
    pluginRoot?: string; projectDir?: string; model?: string
    defaultTimeoutMs?: number; stderrSummaryMaxChars?: number
  } = { id, dialect, enabled: raw.enabled !== false, configSource, configPath }
  if (dialect === 'claude-code') {
    const pluginRoot = asString(raw.pluginRoot)?.trim()
    if (pluginRoot !== undefined && pluginRoot !== '') bridge.pluginRoot = pluginRoot
    const projectDir = asString(raw.projectDir)?.trim()
    if (projectDir !== undefined && projectDir !== '') bridge.projectDir = projectDir
  }
  // model is a codex-only field: any other dialect carrying it is a caller
  // bug (e.g. a stale form), rejected here rather than silently dropped.
  if (dialect === 'codex') {
    const model = asString(raw.model)?.trim()
    if (model !== undefined && model !== '') bridge.model = model
  } else {
    const model = asString(raw.model)?.trim()
    if (model !== undefined && model !== '') throw new HooksValidationError('model.codexOnly')
  }
  for (const field of ['defaultTimeoutMs', 'stderrSummaryMaxChars'] as const) {
    const v = raw[field]
    if (v !== undefined) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new HooksValidationError('field.notPositive', { field })
      }
      bridge[field] = Math.floor(v)
    }
  }
  if (configContent !== undefined) bridge.configContent = configContent
  return bridge
}

/** Build the wire config for the kernel plugin (dialect-specific fields). */
export function toBridgeConfig(bridge: HooksBridge): Record<string, unknown> {
  const config: Record<string, unknown> = { configPath: bridge.configPath }
  if (bridge.dialect === 'claude-code') {
    if (bridge.pluginRoot !== undefined) config.pluginRoot = bridge.pluginRoot
    if (bridge.projectDir !== undefined) config.projectDir = bridge.projectDir
  } else if (bridge.dialect === 'codex') {
    if (bridge.model !== undefined) config.model = bridge.model
  }
  if (bridge.defaultTimeoutMs !== undefined) config.defaultTimeoutMs = bridge.defaultTimeoutMs
  if (bridge.stderrSummaryMaxChars !== undefined) config.stderrSummaryMaxChars = bridge.stderrSummaryMaxChars
  return config
}
