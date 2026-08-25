/**
 * Field vocabulary and pure draft operations for the Advanced Models page.
 *
 * Everything here mirrors the `llm-pi-ai` settings schema (harness
 * packages/llm/llm-pi-ai/src/{config,catalog}.ts). The brand bundle cannot
 * import those packages — the loader module table only answers package
 * entrypoints — so the enumerations are mirrored as constants. A pi-ai
 * upgrade that drifts them is caught at write time: `settings.mutate` runs
 * the namespace validator and rejects an unknown level/field by name.
 */

/** Every request modality a profile may declare (pi-ai MODALITIES). */
export const MODALITIES = ['text', 'image'] as const
export type Modality = (typeof MODALITIES)[number]

/** Every reasoning level a profile may offer, in escalation order (pi-ai THINKING_LEVELS). */
export const REASONING_LEVELS = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/** The compat fields this page can edit, with the value shape each accepts. */
export interface CompatFieldMeta {
  /** Settings key inside a `compat` object. */
  key: string
  /** Human label (zh-CN product copy). */
  label: string
  /** Value shape: rendered and validated accordingly. */
  kind: 'boolean' | { enum: readonly string[] }
}

/**
 * Editable `compat` switches. `chatTemplateKwargs` is deliberately absent: it
 * takes structured `$var` objects this form cannot express, and hand-written
 * YAML stays the answer for it (unknown keys survive edits untouched).
 */
export const COMPAT_FIELDS: readonly CompatFieldMeta[] = [
  { key: 'supportsStore', label: '支持 store 字段', kind: 'boolean' },
  { key: 'supportsDeveloperRole', label: '支持 developer 角色', kind: 'boolean' },
  { key: 'supportsReasoningEffort', label: '支持 reasoning_effort 参数', kind: 'boolean' },
  { key: 'supportsUsageInStreaming', label: '流式返回用量', kind: 'boolean' },
  { key: 'maxTokensField', label: '输出上限字段名', kind: { enum: ['max_completion_tokens', 'max_tokens'] } },
  { key: 'requiresToolResultName', label: '工具结果需名称', kind: 'boolean' },
  { key: 'requiresAssistantAfterToolResult', label: '工具结果后需 assistant', kind: 'boolean' },
  { key: 'requiresThinkingAsText', label: '思考以文本输出', kind: 'boolean' },
  { key: 'requiresReasoningContentOnAssistantMessages', label: 'assistant 消息需 reasoning', kind: 'boolean' },
  { key: 'thinkingFormat', label: '思考分发格式', kind: { enum: [
    'openai', 'deepseek', 'openrouter', 'together', 'zai', 'qwen',
    'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
  ] } },
  { key: 'supportsStrictMode', label: '支持 strict 模式', kind: 'boolean' },
  { key: 'cacheControlFormat', label: '缓存标记格式', kind: { enum: ['anthropic'] } },
  { key: 'supportsLongCacheRetention', label: '支持长缓存保留', kind: 'boolean' },
  { key: 'supportsEagerToolInputStreaming', label: '工具输入急速流式', kind: 'boolean' },
  { key: 'supportsCacheControlOnTools', label: '工具支持缓存标记', kind: 'boolean' },
  { key: 'supportsTemperature', label: '支持 temperature', kind: 'boolean' },
  { key: 'forceAdaptiveThinking', label: '强制自适应思考', kind: 'boolean' },
  { key: 'allowEmptySignature', label: '允许空签名', kind: 'boolean' },
  { key: 'supportsStrictTools', label: '支持 strict 工具', kind: 'boolean' },
]

/** The compat fields a settings value may carry, keyed for lookup. */
const COMPAT_BY_KEY = new Map(COMPAT_FIELDS.map(field => [field.key, field]))

/**
 * Family presets for the wire-compatibility switches models.dev cannot
 * supply. The DeepSeek-gateway set is field-verified against a live route
 * (`opencode-go-vision` in settings.yaml, 2026-08); others stay hand-written
 * until equally verified, which is why the list is short.
 */
export const COMPAT_PRESETS: readonly { id: string; label: string; value: Record<string, unknown> }[] = [
  {
    id: 'deepseek-gateway',
    label: 'DeepSeek 网关家族',
    value: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
  },
]

/**
 * Spell a token count the way the upstream editors do (K = 1_000, M = 1_000_000),
 * so both surfaces read and write one vocabulary.
 */
export function formatCapacity(value: number | undefined): string {
  if (value === undefined) return ''
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

/**
 * Parse a capacity field. Empty (or whitespace) means unset; a trailing
 * K/M scales by 1_000 / 1_000_000; anything unparsable is `NaN` so the form
 * can refuse the write naming the row.
 */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^(\d+(?:\.\d+)?)([KkMm]?)$/.exec(trimmed)
  if (match === null) return Number.NaN
  const scale = match[2] === '' ? 1 : match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000
  const parsed = Number(match[1]) * scale
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN
}

/** Read a nested value off a JSON-shaped draft; missing parents read undefined. */
export function getPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Immutable set of a nested value, cloning only the spine it writes through. */
export function setPath<T>(root: T, path: readonly string[], value: unknown): T {
  if (path.length === 0) return value as T
  const [head, ...rest] = path
  const record = typeof root === 'object' && root !== null && !Array.isArray(root)
    ? root as Record<string, unknown>
    : {}
  return { ...record, [head]: setPath(record[head], rest, value) } as T
}

/** Immutable delete of a nested key; absent paths return the draft unchanged. */
export function deletePath<T>(root: T, path: readonly string[]): T {
  if (path.length === 0) return root
  if (path.length === 1) {
    if (typeof root !== 'object' || root === null || Array.isArray(root)) return root
    const [head] = path
    if (!(head in root)) return root
    const next = { ...root as Record<string, unknown> }
    delete next[head]
    return next as T
  }
  const [head, ...rest] = path
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return root
  const child = (root as Record<string, unknown>)[head]
  const nextChild = deletePath(child, rest)
  if (nextChild === child) return root
  return { ...(root as Record<string, unknown>), [head]: nextChild } as T
}

/** A plain-object draft row this page edits (structurally open like upstream's). */
export type ModelDraft = Record<string, unknown>

/** Reasoning-effort tri-state as the form holds it. */
export type ReasoningDraft = undefined | false | Record<string, string | null>

/**
 * Normalize a stored `reasoningEfforts` value into the form's tri-state.
 * Anything that is not `false` or a plain object reads as "inherit".
 */
export function readReasoning(value: unknown): ReasoningDraft {
  if (value === false) return false
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const draft: Record<string, string | null> = {}
  for (const [level, spelling] of Object.entries(value as Record<string, unknown>)) {
    draft[level] = typeof spelling === 'string' && spelling.length > 0 ? spelling : null
  }
  return draft
}

/** Deep-clone helper over the JSON-shaped drafts this page edits. */
export function cloneDraft<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Validate one compat object against the mirrored field metadata. Returns the
 * first offending key, or undefined when every present key is well-formed.
 * Keys outside the mirrored set are left alone (hand-written escape hatch).
 */
export function compatFailure(compat: unknown): string | undefined {
  if (compat === undefined) return undefined
  if (typeof compat !== 'object' || compat === null || Array.isArray(compat)) return 'compat'
  for (const [key, value] of Object.entries(compat as Record<string, unknown>)) {
    const meta = COMPAT_BY_KEY.get(key)
    if (meta === undefined) continue
    if (meta.kind === 'boolean') {
      if (typeof value !== 'boolean') return key
    } else if (typeof value !== 'string' || !meta.kind.enum.includes(value)) {
      return key
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Retry policy (provider-level `retryPolicy`, mirrored from harness
// packages/llm/llm/src/retry-policy.ts). The defaults and bounds below are
// the schema's own; the namespace validator still backs the write.
// ---------------------------------------------------------------------------

/** Schema defaults, shown as the blank-field semantics and in the card summary. */
export const RETRY_POLICY_DEFAULTS = {
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
} as const

/** The timer ceiling the schema enforces (Node's largest safe setTimeout delay). */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** The retry-policy form draft: strings so a blank field means "use default". */
export interface RetryPolicyDraft {
  mode: 'normal' | 'always'
  maxRetries: string
  initialDelayMs: string
  maxDelayMs: string
  jitterRatio: string
}

/**
 * Normalize a stored `retryPolicy` value into the form draft. An absent or
 * malformed value reads as undefined ("not customized on this route").
 */
export function readRetryPolicy(value: unknown): RetryPolicyDraft | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const backoff = typeof record.backoff === 'object' && record.backoff !== null && !Array.isArray(record.backoff)
    ? record.backoff as Record<string, unknown>
    : {}
  return {
    mode: record.mode === 'always' ? 'always' : 'normal',
    maxRetries: typeof record.maxRetries === 'number' ? String(record.maxRetries) : '',
    initialDelayMs: typeof backoff.initialDelayMs === 'number' ? String(backoff.initialDelayMs) : '',
    maxDelayMs: typeof backoff.maxDelayMs === 'number' ? String(backoff.maxDelayMs) : '',
    jitterRatio: typeof backoff.jitterRatio === 'number' ? String(backoff.jitterRatio) : '',
  }
}

/** Outcome of parsing a retry-policy draft into its settings value. */
export type RetryPolicyParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

/** Parse one draft field into a finite number, or undefined when blank. */
function parsePositiveFinite(text: string): number | undefined | 'bad' {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 'bad'
}

/**
 * Validate a draft and build the value this page would write: `mode` always,
 * `maxRetries` only under normal mode, and `backoff` only when some field is
 * set. Blank fields are omitted so the schema defaults fill them.
 * @returns the settings value, or the first rule violation (zh-CN).
 */
export function parseRetryPolicy(draft: RetryPolicyDraft): RetryPolicyParse {
  const maxRetries = draft.maxRetries.trim()
  if (draft.mode === 'normal' && maxRetries !== '') {
    const parsed = Number(maxRetries)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { ok: false, error: '最大重试次数必须是非负整数' }
    }
  }
  const initialDelayMs = parsePositiveFinite(draft.initialDelayMs)
  if (initialDelayMs === 'bad') return { ok: false, error: '首次延迟必须是正数（毫秒）' }
  const maxDelayMs = parsePositiveFinite(draft.maxDelayMs)
  if (maxDelayMs === 'bad') return { ok: false, error: '延迟上限必须是正数（毫秒）' }
  const jitterRatio = (() => {
    const trimmed = draft.jitterRatio.trim()
    if (trimmed === '') return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : 'bad'
  })()
  if (jitterRatio === 'bad') return { ok: false, error: '抖动比例必须是 0 到 1 之间的数字' }
  if (jitterRatio !== undefined && (jitterRatio < 0 || jitterRatio > 1)) {
    return { ok: false, error: '抖动比例必须在 0 到 1 之间' }
  }
  for (const [name, value] of [['首次延迟', initialDelayMs], ['延迟上限', maxDelayMs]] as const) {
    if (typeof value === 'number' && value > MAX_TIMER_DELAY_MS) {
      return { ok: false, error: `${name}不能超过 ${String(MAX_TIMER_DELAY_MS)} 毫秒` }
    }
  }
  // Cross-check against effective values (a blank field falls back to the
  // default, so 30000 initial vs blank max would resolve to an invalid pair).
  const effectiveInitial = initialDelayMs ?? RETRY_POLICY_DEFAULTS.initialDelayMs
  const effectiveMax = maxDelayMs ?? RETRY_POLICY_DEFAULTS.maxDelayMs
  if (effectiveInitial > effectiveMax) {
    return { ok: false, error: '首次延迟不能大于延迟上限（留空时按默认 500 / 10000 计算）' }
  }
  const backoff: Record<string, number> = {}
  if (initialDelayMs !== undefined) backoff.initialDelayMs = initialDelayMs
  if (maxDelayMs !== undefined) backoff.maxDelayMs = maxDelayMs
  if (jitterRatio !== undefined) backoff.jitterRatio = jitterRatio
  const value: Record<string, unknown> = { mode: draft.mode }
  if (draft.mode === 'normal' && maxRetries !== '') value.maxRetries = Number(maxRetries)
  if (Object.keys(backoff).length > 0) value.backoff = backoff
  return { ok: true, value }
}

/**
 * Validate one model row the way the page refuses it: a non-empty id unique
 * in the list, well-formed capacities, a level-keyed reasoning dict with
 * string-or-null spellings, and compat values the mirrored metadata accepts.
 * @returns the failure text (zh-CN), or undefined when the row is writable.
 */
export function modelRowFailure(row: ModelDraft, knownIds: ReadonlySet<string>): string | undefined {
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (id === '') return '模型 ID 不能为空'
  if (knownIds.has(id)) return `模型 ID 重复：${id}`
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    const value = row[field]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      return `${id} 的 ${field === 'contextWindow' ? '上下文窗口' : '输出上限'}必须是正整数`
    }
  }
  const reasoning = row.reasoningEfforts
  if (reasoning !== undefined && reasoning !== false) {
    if (typeof reasoning !== 'object' || reasoning === null || Array.isArray(reasoning)) {
      return `${id} 的推理等级格式不正确`
    }
    const levels = Object.keys(reasoning as Record<string, unknown>)
    for (const level of levels) {
      if (!(REASONING_LEVELS as readonly string[]).includes(level)) {
        return `${id} 的推理级别未知：${level}`
      }
    }
    // The adapter refuses a dict that offers no level beyond `off` — mirror
    // that rule here so the refusal lands in this form, not in a rejected
    // write after the fact.
    if (levels.every(level => level === 'off')) {
      return `${id} 的推理等级只声明了 off：声明支持推理的模型至少要有一个实际档位（如 low/high），或改为“禁用推理”`
    }
  }
  const input = row.input
  if (input !== undefined) {
    if (!Array.isArray(input) || input.some(m => !(MODALITIES as readonly string[]).includes(m as string))) {
      return `${id} 的输入模态不正确`
    }
  }
  const failingCompat = compatFailure(row.compat)
  if (failingCompat !== undefined) return `${id} 的兼容开关 ${failingCompat} 取值不合法`
  return undefined
}
