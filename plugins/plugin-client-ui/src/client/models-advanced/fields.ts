/**
 * Field vocabulary and pure draft operations for the Advanced Models page.
 *
 * Everything here mirrors the `llm-pi-ai` settings schema (harness
 * packages/llm/llm-pi-ai/src/{config,catalog}.ts). The brand bundle cannot
 * import those packages — the loader module table only answers package
 * entrypoints — so the enumerations are mirrored as constants. A pi-ai
 * upgrade that drifts them is caught at write time: `settings.mutate` runs
 * the namespace validator and rejects an unknown level/field by name.
 *
 * Nothing here composes a sentence: labels are dictionary keys of the page's
 * namespace and every refusal is a {@link PageMessage}, rendered by the
 * component with its `t` seat (see `messages.ts`).
 */

import { message } from './messages.ts'
import type { PageMessage } from './messages.ts'
import type { AdvancedModelsKey } from './locales.ts'

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
  /** Locale key of the human label (the page dictionary owns the copy). */
  labelKey: AdvancedModelsKey
  /** Value shape: rendered and validated accordingly. */
  kind: 'boolean' | { enum: readonly string[] }
}

/**
 * Editable `compat` switches. `chatTemplateKwargs` is deliberately absent: it
 * takes structured `$var` objects this form cannot express, and hand-written
 * YAML stays the answer for it (unknown keys survive edits untouched).
 */
export const COMPAT_FIELDS: readonly CompatFieldMeta[] = [
  { key: 'supportsStore', labelKey: 'adv.compatField.supportsStore', kind: 'boolean' },
  { key: 'supportsDeveloperRole', labelKey: 'adv.compatField.supportsDeveloperRole', kind: 'boolean' },
  { key: 'supportsReasoningEffort', labelKey: 'adv.compatField.supportsReasoningEffort', kind: 'boolean' },
  { key: 'supportsUsageInStreaming', labelKey: 'adv.compatField.supportsUsageInStreaming', kind: 'boolean' },
  { key: 'maxTokensField', labelKey: 'adv.compatField.maxTokensField', kind: { enum: ['max_completion_tokens', 'max_tokens'] } },
  { key: 'requiresToolResultName', labelKey: 'adv.compatField.requiresToolResultName', kind: 'boolean' },
  { key: 'requiresAssistantAfterToolResult', labelKey: 'adv.compatField.requiresAssistantAfterToolResult', kind: 'boolean' },
  { key: 'requiresThinkingAsText', labelKey: 'adv.compatField.requiresThinkingAsText', kind: 'boolean' },
  { key: 'requiresReasoningContentOnAssistantMessages', labelKey: 'adv.compatField.requiresReasoningContentOnAssistantMessages', kind: 'boolean' },
  { key: 'thinkingFormat', labelKey: 'adv.compatField.thinkingFormat', kind: { enum: [
    'openai', 'deepseek', 'openrouter', 'together', 'zai', 'qwen',
    'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
  ] } },
  { key: 'supportsStrictMode', labelKey: 'adv.compatField.supportsStrictMode', kind: 'boolean' },
  { key: 'cacheControlFormat', labelKey: 'adv.compatField.cacheControlFormat', kind: { enum: ['anthropic'] } },
  { key: 'supportsLongCacheRetention', labelKey: 'adv.compatField.supportsLongCacheRetention', kind: 'boolean' },
  { key: 'supportsEagerToolInputStreaming', labelKey: 'adv.compatField.supportsEagerToolInputStreaming', kind: 'boolean' },
  { key: 'supportsCacheControlOnTools', labelKey: 'adv.compatField.supportsCacheControlOnTools', kind: 'boolean' },
  { key: 'supportsTemperature', labelKey: 'adv.compatField.supportsTemperature', kind: 'boolean' },
  { key: 'forceAdaptiveThinking', labelKey: 'adv.compatField.forceAdaptiveThinking', kind: 'boolean' },
  { key: 'allowEmptySignature', labelKey: 'adv.compatField.allowEmptySignature', kind: 'boolean' },
  { key: 'supportsStrictTools', labelKey: 'adv.compatField.supportsStrictTools', kind: 'boolean' },
]

/** The compat fields a settings value may carry, keyed for lookup. */
const COMPAT_BY_KEY = new Map(COMPAT_FIELDS.map(field => [field.key, field]))

/**
 * Wire protocols a hand-declared route may name, plus the Responses family
 * aliases pi-ai shares a compat gate with. Mirrors harness
 * `packages/llm/llm-pi-ai/src/{provider,catalog}.ts`.
 */
export const HAND_PROTOCOLS = [
  'openai-completions', 'openai-responses', 'anthropic-messages',
] as const

/**
 * Compat switches each protocol offers (mirrors harness COMPAT_GATES 'offer').
 *
 * Coverage note: the 'offer' lists below deliberately name more keys than
 * {@link COMPAT_FIELDS} renders (`supportsFinishReason`,
 * `supportsThinkingTokenBudget`, `thinkingTokenBudgetField`, `vllmPriority`,
 * `supportsMaxOutputTokens`). Those stay hand-written YAML: `compatFailure`
 * and `modelRowFailure` skip unknown keys, so an unrendered switch still
 * writes and reads untouched instead of failing the save. Promote a key into
 * `COMPAT_FIELDS` (with its value shape) only once its rendering is verified.
 */
const PROTOCOL_COMPAT: Readonly<Record<string, readonly string[]>> = {
  'openai-completions': [
    'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort',
    'supportsUsageInStreaming', 'supportsFinishReason', 'maxTokensField',
    'requiresToolResultName', 'requiresAssistantAfterToolResult',
    'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages',
    'thinkingFormat', 'supportsThinkingTokenBudget', 'thinkingTokenBudgetField',
    'vllmPriority', 'supportsStrictMode', 'cacheControlFormat',
    'supportsLongCacheRetention',
  ],
  // azure/codex-responses share this gate with openai-responses.
  'openai-responses': [
    'supportsDeveloperRole', 'supportsMaxOutputTokens', 'supportsStrictMode',
    'supportsLongCacheRetention',
  ],
  'anthropic-messages': [
    'supportsEagerToolInputStreaming', 'supportsLongCacheRetention',
    'supportsCacheControlOnTools', 'supportsTemperature',
    'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools',
  ],
  'bedrock-converse-stream': ['supportsStrictMode'],
}

/**
 * Compat fields valid for one resolved protocol. An unknown protocol returns
 * the union of hand-declared protocols so an undeclared catalog route still
 * offers every switch a configured route can name — with a UI warning.
 */
export function compatFieldsForApi(api: string | undefined): readonly CompatFieldMeta[] {
  if (api !== undefined && api !== '') {
    const offered = PROTOCOL_COMPAT[api]
    if (offered !== undefined) {
      return COMPAT_FIELDS.filter(field => offered.includes(field.key))
    }
  }
  const allowed = new Set<string>()
  for (const list of Object.values(PROTOCOL_COMPAT)) {
    for (const key of list) allowed.add(key)
  }
  return COMPAT_FIELDS.filter(field => allowed.has(field.key))
}

/**
 * Auto-fill for a freshly declared reasoning dict on a private gateway.
 * OpenAI-compatible completions gateways mis-detect as OpenAI and flip the
 * system prompt to `developer`; responses only takes `supportsDeveloperRole`.
 * Anthropic takes neither — leave the row alone.
 */
export function reasoningCompatFill(api: string | undefined): Record<string, unknown> {
  if (api === 'openai-completions') {
    return { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
  }
  if (api === 'openai-responses') {
    return { supportsDeveloperRole: false }
  }
  return {}
}

/**
 * Family presets for the wire-compatibility switches models.dev cannot
 * supply. The DeepSeek-gateway set is field-verified against a live route
 * (`opencode-go-vision` in settings.yaml, 2026-08); others stay hand-written
 * until equally verified, which is why the list is short.
 */
export const COMPAT_PRESETS: readonly { id: string; labelKey: AdvancedModelsKey; value: Record<string, unknown> }[] = [
  {
    id: 'deepseek-gateway',
    labelKey: 'adv.compatPreset.deepseekGateway',
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
 * Default reasoning efforts for a hand-declared model: a conventional trio
 * with identity wire spellings. Private OpenAI-compatible gateways almost
 * always accept these; models.dev enrichment can replace them with the
 * model's real set (including xhigh/max) when the feed knows the id.
 */
export function defaultReasoningEfforts(): Record<string, string> {
  return { low: 'low', medium: 'medium', high: 'high' }
}

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
  | { ok: false; failure: PageMessage }

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
 * @returns the settings value, or the first rule violation as a dictionary
 * message (the card renders it through its `t` seat).
 */
export function parseRetryPolicy(draft: RetryPolicyDraft): RetryPolicyParse {
  const maxRetries = draft.maxRetries.trim()
  if (draft.mode === 'normal' && maxRetries !== '') {
    const parsed = Number(maxRetries)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { ok: false, failure: message('adv.retry.failure.maxRetries') }
    }
  }
  const initialDelayMs = parsePositiveFinite(draft.initialDelayMs)
  if (initialDelayMs === 'bad') return { ok: false, failure: message('adv.retry.failure.initialPositive') }
  const maxDelayMs = parsePositiveFinite(draft.maxDelayMs)
  if (maxDelayMs === 'bad') return { ok: false, failure: message('adv.retry.failure.maxDelayPositive') }
  const jitterRatio = (() => {
    const trimmed = draft.jitterRatio.trim()
    if (trimmed === '') return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : 'bad'
  })()
  if (jitterRatio === 'bad') return { ok: false, failure: message('adv.retry.failure.jitterNumber') }
  if (jitterRatio !== undefined && (jitterRatio < 0 || jitterRatio > 1)) {
    return { ok: false, failure: message('adv.retry.failure.jitterRange') }
  }
  const ceilings = [
    ['adv.retry.failure.initialTooLarge', initialDelayMs],
    ['adv.retry.failure.maxDelayTooLarge', maxDelayMs],
  ] as const
  for (const [key, value] of ceilings) {
    if (typeof value === 'number' && value > MAX_TIMER_DELAY_MS) {
      return { ok: false, failure: message(key, { max: MAX_TIMER_DELAY_MS }) }
    }
  }
  // Cross-check against effective values (a blank field falls back to the
  // default, so 30000 initial vs blank max would resolve to an invalid pair).
  const effectiveInitial = initialDelayMs ?? RETRY_POLICY_DEFAULTS.initialDelayMs
  const effectiveMax = maxDelayMs ?? RETRY_POLICY_DEFAULTS.maxDelayMs
  if (effectiveInitial > effectiveMax) {
    return { ok: false, failure: message('adv.retry.failure.order') }
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
 * When `api` is named, model-level compat switches that protocol does not
 * take are refused here so the write never reaches the adapter's English
 * resolve-time error.
 * @param row - the drafted row.
 * @param knownIds - ids already taken in the list being edited.
 * @param api - the row's resolved wire protocol, when it has one.
 * @param addressing - which list is refusing the row. The capacity rule is
 * worded per list in the pre-i18n copy (`{id} 的 …` in the model list,
 * `覆盖 {id}：…` in the override list), while every other refusal reads the
 * same in both — so only that rule takes the parameter.
 * @returns the refusal as a dictionary message, or undefined when the row is
 * writable.
 */
export function modelRowFailure(
  row: ModelDraft,
  knownIds: ReadonlySet<string>,
  api?: string,
  addressing: 'model' | 'override' = 'model',
): PageMessage | undefined {
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (id === '') return message('adv.failure.modelIdEmpty')
  if (knownIds.has(id)) return message('adv.failure.modelIdDuplicate', { id })
  const capacityKeys = addressing === 'override'
    ? { contextWindow: 'adv.failure.overrideContextWindow', maxTokens: 'adv.failure.overrideMaxTokens' } as const
    : { contextWindow: 'adv.failure.modelContextWindow', maxTokens: 'adv.failure.modelMaxTokens' } as const
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    const value = row[field]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      return message(capacityKeys[field], { id })
    }
  }
  const reasoning = row.reasoningEfforts
  if (reasoning !== undefined && reasoning !== false) {
    if (typeof reasoning !== 'object' || reasoning === null || Array.isArray(reasoning)) {
      return message('adv.failure.reasoningShape', { id })
    }
    const levels = Object.keys(reasoning as Record<string, unknown>)
    if (levels.length === 0) {
      return message('adv.failure.reasoningEmpty', { id })
    }
    for (const level of levels) {
      if (!(REASONING_LEVELS as readonly string[]).includes(level)) {
        return message('adv.failure.reasoningUnknown', { id, level })
      }
    }
    // The adapter refuses a dict that offers no level beyond `off` — mirror
    // that rule here so the refusal lands in this form, not in a rejected
    // write after the fact.
    if (levels.every(level => level === 'off')) {
      return message('adv.failure.reasoningOffOnly', { id })
    }
  }
  const input = row.input
  if (input !== undefined) {
    if (!Array.isArray(input) || input.some(m => !(MODALITIES as readonly string[]).includes(m as string))) {
      return message('adv.failure.inputShape', { id })
    }
  }
  const failingCompat = compatFailure(row.compat)
  if (failingCompat !== undefined) return message('adv.failure.compatValue', { id, key: failingCompat })
  if (api !== undefined && api !== '' && typeof row.compat === 'object'
    && row.compat !== null && !Array.isArray(row.compat)) {
    const offered = new Set(compatFieldsForApi(api).map(field => field.key))
    // Unknown keys stay a hand-written escape hatch (the adapter still gates
    // them), but keys this page knows and the protocol does not take are a
    // write the adapter would refuse — catch them here.
    for (const key of Object.keys(row.compat as Record<string, unknown>)) {
      if (COMPAT_BY_KEY.has(key) && !offered.has(key)) {
        return message('adv.failure.compatUnsupported', { id, key, api })
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Provider request headers (provider-level `headers`, mirrored from harness
// packages/llm/llm-pi-ai/src/config.ts). Profile resolution validates each
// pair with `new Headers([[name, value]])`; harness attribution names win
// over same-named entries at request time.
// ---------------------------------------------------------------------------

/** One form row: header name + value, both strings so a blank means "unset". */
export interface HeaderRow {
  name: string
  value: string
}

/**
 * Normalize a stored `headers` value into form rows. An absent or malformed
 * value reads as empty ("not customized on this route").
 */
export function readHeaders(value: unknown): HeaderRow[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>)
    .filter(([, raw]) => typeof raw === 'string')
    .map(([name, raw]) => ({ name, value: raw as string }))
}

/** Outcome of parsing header rows into a settings value. */
export type HeadersParse =
  | { ok: true; value: Record<string, string> }
  | { ok: false; failure: PageMessage }

/**
 * Validate draft rows and build the `headers` value this page would write.
 * Blank names are ignored; a non-blank name needs a value (empty string is
 * allowed). Names must be Fetch-representable single-line HTTP field names.
 * @returns the settings value, or the first rule violation as a dictionary
 * message (the card renders it through its `t` seat).
 */
export function parseHeaders(rows: readonly HeaderRow[]): HeadersParse {
  const value: Record<string, string> = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (name === '') continue
    const lower = name.toLowerCase()
    if (seen.has(lower)) return { ok: false, failure: message('adv.headers.failure.duplicate', { name }) }
    seen.add(lower)
    if (/[\r\n\0]/.test(row.value)) {
      return { ok: false, failure: message('adv.headers.failure.newline', { name }) }
    }
    try {
      // Same gate the adapter's profile resolver uses.
      new Headers([[name, row.value]])
    } catch {
      return { ok: false, failure: message('adv.headers.failure.invalid', { name }) }
    }
    value[name] = row.value
  }
  return { ok: true, value }
}
