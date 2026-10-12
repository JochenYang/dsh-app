/**
 * Route-level (provider profile) fields this page owns.
 *
 * The official Models card already edits a profile's `apiKey`, `baseURL`,
 * `displayName` and `api`; everything here is what it does NOT touch — the
 * adapter parameters that otherwise live only in the profile patch file:
 * credentials reference, reasoning and thinking budgets, request timeouts,
 * retry policy, route capability defaults, cache/transport preference, image
 * budget and custom headers.
 *
 * Two rules make this module the single owner of that surface:
 *
 *   1. **Only keys in {@link MANAGED_ROUTE_KEYS} are ever written.** A profile
 *      carries fields no form expresses (`chatTemplateKwargs`, `piProvider`,
 *      hand-written escapes); a diff that wrote whatever it found would delete
 *      them.
 *   2. **Save is a diff of the touched keys.** Nothing is written for a field
 *      the user did not touch, so a save can never rewrite an unrelated key
 *      from a stale view.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/route-fields
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { getPath, parseCapacity, parseRetryPolicy, readRetryPolicy, type ModelDraft } from './fields.ts'
import type { PageMessage } from './messages.ts'

/** The profile keys the advanced area owns, in display order. */
export const MANAGED_ROUTE_KEYS = [
  'apiKeyEnv',
  'reasoning',
  'thinkingBudgets',
  'timeoutMs',
  'websocketConnectTimeoutMs',
  'streamIdleTimeoutMs',
  'retryPolicy',
  'defaultContextWindow',
  'defaultMaxTokens',
  'defaultInput',
  'cacheRetention',
  'transport',
  'maxRequestImageBytes',
  'requestImagePixelBudget',
  'requestImageMaxBytes',
  'headers',
] as const

/** Choices the schema accepts for `cacheRetention`. */
export const CACHE_RETENTION = ['none', 'short', 'long'] as const

/** Choices the schema accepts for `transport`. */
export const TRANSPORT_CHOICES = ['auto', 'sse', 'websocket', 'websocket-cached'] as const

/** Thinking levels `thinkingBudgets` carries a token budget for. */
export const THINKING_BUDGET_LEVELS = ['minimal', 'low', 'medium', 'high'] as const

/**
 * The credential reference grammar (`packages/credentials/credentials`): a bare
 * POSIX environment variable name. Deliberately NOT a `$ENV:`-style syntax —
 * the kernel has none, and a reference that does not match is refused by the
 * write.
 */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Parse a credential reference name. Empty means "inherit"; invalid is `null`. */
export function parseCredentialRef(text: string): string | undefined | null {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return CREDENTIAL_REF.test(trimmed) ? trimmed : null
}

/** Parse a plain positive integer (milliseconds). Empty = inherit, invalid = NaN. */
export function parseDurationMs(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (!/^\d+$/u.test(trimmed)) return Number.NaN
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN
}

/** Parse a non-negative integer (a retry count, where 0 is legal). Empty = inherit. */
export function parseRetryCount(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (!/^\d+$/u.test(trimmed)) return Number.NaN
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN
}

/** Parse a 0..1 ratio (retry jitter). Empty = inherit, invalid = NaN. */
export function parseRatio(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (!/^\d*\.?\d+$/u.test(trimmed)) return Number.NaN
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : Number.NaN
}

/** Parse a token/byte count, reusing the page's K/M vocabulary. */
export function parseCount(text: string): number | undefined {
  return parseCapacity(text)
}

/** Parse an enum field against its accepted values. Empty = inherit, invalid = null. */
export function parseEnumChoice(text: string, choices: readonly string[]): string | undefined | null {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return choices.includes(trimmed) ? trimmed : null
}

/** One path operation this area writes; structurally the settings path op. */
export type RoutePathOp =
  | { op: 'set', path: string[], value: JsonValue }
  | { op: 'unset', path: string[] }

/**
 * The `set`/`unset` operations one advanced-area save produces.
 *
 * @param profilePath - the profile's own settings path (`providers.<route>`),
 *   taken from the provider directory entry so no route-id assumption is baked
 *   in here.
 * @param draft - the working copy of the managed keys.
 * @param touched - keys the user changed or reset in this session.
 * @returns one operation per touched key; a key whose draft value is undefined
 *   becomes an `unset`, which is what restores the inherited value.
 */
export function routeOps(
  profilePath: readonly string[],
  draft: ModelDraft,
  touched: ReadonlySet<string>,
): RoutePathOp[] {
  const ops: RoutePathOp[] = []
  for (const key of MANAGED_ROUTE_KEYS) {
    if (!touched.has(key)) continue
    const path = [...profilePath, key]
    const value = draft[key]
    if (value === undefined) ops.push({ op: 'unset', path })
    // The draft's values all come out of a settings snapshot (or out of a control
    // that wrote one), so they are JSON by construction; this is the boundary that
    // states it rather than a supposition about the caller.
    else ops.push({ op: 'set', path, value: value as JsonValue })
  }
  return ops
}

/**
 * The managed keys a USER-LAYER profile carries, i.e. the ones this page has
 * overridden.
 *
 * @param userProfile - the route's profile object as the user layer holds it
 *   (`row.userProfile`), not the whole namespace.
 * @returns the overridden key names.
 */
export function overriddenKeys(userProfile: unknown): Set<string> {
  const keys = new Set<string>()
  if (typeof userProfile !== 'object' || userProfile === null || Array.isArray(userProfile)) return keys
  for (const key of MANAGED_ROUTE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(userProfile, key)) keys.add(key)
  }
  return keys
}

/** The managed keys of a resolved profile, as the working copy. */
export function managedSubset(profile: unknown): ModelDraft {
  const draft: ModelDraft = {}
  for (const key of MANAGED_ROUTE_KEYS) {
    const value = getPath(profile, [key])
    if (value !== undefined) draft[key] = value
  }
  return draft
}

/**
 * Bring one structured key of the draft into the shape the schema stores, or name
 * the rule it breaks.
 *
 * `retryPolicy` is the reason this exists: the form holds the policy as five
 * separate fields, while the stored object drops `maxRetries` in `always` mode and
 * may omit either backoff bound. Writing the draft as-is would persist a
 * combination the schema's own reader resolves differently, so the value that goes
 * on the wire is the one `parseRetryPolicy` builds — validated against the same
 * rules the old card used, including the cross-field one (the form can hold
 * "initial 30000" beside a blank max, which resolves to 10000).
 *
 * @param draft - the working copy of the managed keys.
 * @returns the normalized draft, or the first rule violation.
 */
export function normalizeManaged(draft: ModelDraft): { ok: true, draft: ModelDraft } | { ok: false, failure: PageMessage } {
  if (draft.retryPolicy === undefined) return { ok: true, draft }
  const policy = readRetryPolicy(draft.retryPolicy)
  if (policy === undefined) return { ok: true, draft }
  const parsed = parseRetryPolicy(policy)
  if (!parsed.ok) return { ok: false, failure: parsed.failure }
  const next = { ...draft }
  const value = parsed.value
  if (Object.keys(value).length === 0) delete next.retryPolicy
  else next.retryPolicy = value
  return { ok: true, draft: next }
}

/**
 * The retry group's own rule check, for showing the violation before a save.
 *
 * @param value - the draft's `retryPolicy`.
 * @returns the message, or undefined when the draft is writable.
 */
export function retryFailure(value: unknown): PageMessage | undefined {
  if (value === undefined) return undefined
  const policy = readRetryPolicy(value)
  if (policy === undefined) return undefined
  const parsed = parseRetryPolicy(policy)
  return parsed.ok ? undefined : parsed.failure
}
