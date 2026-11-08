/**
 * The advanced route parameters of one provider.
 *
 * This is the provider's own half of the page: the credential reference,
 * reasoning default and thinking budgets, timeouts, retry policy, capability
 * defaults, cache/transport preference, image budgets and custom request
 * headers — the profile fields the official Models page has no editor for.
 *
 * Two pieces, split so the page can own one Save for the whole provider:
 *
 *   - {@link useRouteAdvancedDraft} holds the working copy, the touched set and
 *     the live credential status. Nothing is written here.
 *   - {@link RouteAdvancedFields} renders the sections, laid out in the source
 *     design's grammar: one section label, its hint, then a responsive grid of
 *     labelled fields. The page's footer saves every touched key as a path op
 *     (`route-fields.ts`), so a save can never rewrite an unrelated field from a
 *     stale view, and clearing a field writes an `unset`, which is what restores
 *     the inherited value.
 *
 * The seed is the USER layer: this page edits the user's own overrides, and an
 * empty control is the honest label for a field the user has not set even when a
 * lower layer carries a value.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/route-advanced
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { getPath, setPath, deletePath, REASONING_LEVELS, MODALITIES, type ModelDraft } from './fields.ts'
import { messageText } from './messages.ts'
import type { Translate } from './messages.ts'
import type { AdvancedModelsRemote, RouteRow } from './store.ts'
import {
  CACHE_RETENTION, TRANSPORT_CHOICES,
  managedSubset, overriddenKeys, retryFailure,
} from './route-fields.ts'
import { AdvancedField, Chip, HeadersField } from './ui.tsx'
import type { AdvancedModelsKey } from './locales.ts'

/** One control's spec, so the sections stay declarative. */
interface FieldSpec {
  /** Profile key this control writes. */
  key: string
  /** Locale key of the label. */
  labelKey: AdvancedModelsKey
  /** Control kind. */
  kind: 'count' | 'duration' | 'retries' | 'ratio' | 'text' | 'credential' | 'enum'
  /** Accepted values for an enum. */
  choices?: readonly string[]
  /** Nested path inside the profile key (`thinkingBudgets`). */
  within?: readonly string[]
}

/** One section of the advanced block. */
interface SectionSpec {
  /** Stable id, also the control id prefix. */
  id: string
  /** Locale key of the section label. */
  titleKey: AdvancedModelsKey
  /** Every profile key this section shows a value for, custom rows included. */
  keys: readonly string[]
  /** The scalar controls. */
  fields: readonly FieldSpec[]
}

/** The sections, in render order — the source design's section grammar: a
 *  quiet label, then a responsive grid of labelled fields, no prose. */
const SECTIONS: readonly SectionSpec[] = [
  {
    id: 'credential',
    titleKey: 'adv.pg.g.credential',
    keys: ['apiKeyEnv'],
    fields: [
      { key: 'apiKeyEnv', labelKey: 'adv.pg.apiKeyEnv', kind: 'credential' },
    ],
  },
  {
    id: 'reasoning',
    titleKey: 'adv.pg.g.reasoning',
    keys: ['reasoning', 'thinkingBudgets'],
    fields: [
      { key: 'reasoning', labelKey: 'adv.reasoningCard.field', kind: 'enum', choices: REASONING_LEVELS },
      { key: 'thinkingBudgets', labelKey: 'adv.pg.budget.minimal', kind: 'count', within: ['minimal'] },
      { key: 'thinkingBudgets', labelKey: 'adv.pg.budget.low', kind: 'count', within: ['low'] },
      { key: 'thinkingBudgets', labelKey: 'adv.pg.budget.medium', kind: 'count', within: ['medium'] },
      { key: 'thinkingBudgets', labelKey: 'adv.pg.budget.high', kind: 'count', within: ['high'] },
    ],
  },
  {
    id: 'retry',
    titleKey: 'adv.pg.g.retry',
    keys: ['retryPolicy'],
    fields: [
      { key: 'retryPolicy', labelKey: 'adv.retry.mode', kind: 'enum', choices: ['normal', 'always'], within: ['mode'] },
      { key: 'retryPolicy', labelKey: 'adv.retry.maxRetries', kind: 'retries', within: ['maxRetries'] },
      { key: 'retryPolicy', labelKey: 'adv.retry.initialDelay', kind: 'duration', within: ['backoff', 'initialDelayMs'] },
      { key: 'retryPolicy', labelKey: 'adv.retry.maxDelay', kind: 'duration', within: ['backoff', 'maxDelayMs'] },
      { key: 'retryPolicy', labelKey: 'adv.retry.jitter', kind: 'ratio', within: ['backoff', 'jitterRatio'] },
    ],
  },
  {
    id: 'timeout',
    titleKey: 'adv.pg.g.timeout',
    keys: ['timeoutMs', 'websocketConnectTimeoutMs', 'streamIdleTimeoutMs'],
    fields: [
      { key: 'timeoutMs', labelKey: 'adv.pg.timeoutMs', kind: 'duration' },
      { key: 'websocketConnectTimeoutMs', labelKey: 'adv.pg.wsTimeoutMs', kind: 'duration' },
      { key: 'streamIdleTimeoutMs', labelKey: 'adv.pg.idleTimeoutMs', kind: 'duration' },
    ],
  },
  {
    id: 'defaults',
    titleKey: 'adv.pg.g.defaults',
    keys: ['defaultContextWindow', 'defaultMaxTokens', 'defaultInput'],
    fields: [
      { key: 'defaultContextWindow', labelKey: 'adv.pg.defaultContextWindow', kind: 'count' },
      { key: 'defaultMaxTokens', labelKey: 'adv.pg.defaultMaxTokens', kind: 'count' },
    ],
  },
  {
    id: 'request',
    titleKey: 'adv.pg.g.request',
    keys: ['cacheRetention', 'transport', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes'],
    fields: [
      { key: 'cacheRetention', labelKey: 'adv.pg.cacheRetention', kind: 'enum', choices: CACHE_RETENTION },
      { key: 'transport', labelKey: 'adv.pg.transport', kind: 'enum', choices: TRANSPORT_CHOICES },
      { key: 'maxRequestImageBytes', labelKey: 'adv.pg.maxImageBytes', kind: 'count' },
      { key: 'requestImagePixelBudget', labelKey: 'adv.pg.pixelBudget', kind: 'count' },
      { key: 'requestImageMaxBytes', labelKey: 'adv.pg.imageMaxBytes', kind: 'count' },
    ],
  },
  {
    id: 'headers',
    titleKey: 'adv.headers.title',
    keys: ['headers'],
    // The rows are a child component of the section itself, not scalar controls.
    fields: [],
  },
]

/** The credential status of one reference, as `credentials.describe` answers. */
export interface CredentialState {
  readonly configured: boolean
  readonly source?: string
}

/** What the page needs from the provider's advanced draft. */
export interface RouteAdvancedDraft {
  /** The working copy of the managed keys (user layer, plus edits). */
  readonly working: ModelDraft
  /** Keys the user changed or reset in this session. */
  readonly touched: ReadonlySet<string>
  /** Bumped whenever the draft is dropped, to re-seed the header table. */
  readonly epoch: number
  /** The overridden keys of the stored user layer. */
  readonly overridden: ReadonlySet<string>
  /** Live credential status of `working.apiKeyEnv`, when it names one. */
  readonly credential: CredentialState | undefined
  /** Change one key (or one nested key) and mark it touched. */
  readonly edit: (key: string, within: readonly string[] | undefined, value: unknown) => void
  /** Drop the draft, the touched set and the header table. */
  readonly reset: () => void
}

/**
 * Hold the advanced draft of one provider.
 *
 * The baseline is the user layer, so `working` is what this page would write,
 * not what the composed profile currently resolves to. A selection change
 * unmounts the caller (the detail is keyed by route), which is what re-seeds it.
 *
 * @param row - the route being edited.
 * @param api - the page's Remote face, for the credential status.
 * @param fallbackRefs - the adapter's native-auth variables, used when the
 *   profile names none (a shipped route).
 * @returns the draft and its operations.
 */
export function useRouteAdvancedDraft(
  row: RouteRow,
  api: AdvancedModelsRemote,
  fallbackRefs: readonly string[] = [],
): RouteAdvancedDraft {
  const base = useMemo(() => managedSubset(row.userProfile), [row.userProfile])
  const overridden = useMemo(() => overriddenKeys(row.userProfile), [row.userProfile])
  const [draft, setDraft] = useState<ModelDraft | null>(null)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [epoch, setEpoch] = useState(0)
  const [credentials, setCredentials] = useState<Record<string, CredentialState>>({})
  const working = draft ?? base

  // The profile's own variable is exclusive: native auth applies only when the
  // profile names none. When it does name one, that single reference is all the
  // page may report.
  const candidates = typeof working.apiKeyEnv === 'string' && working.apiKeyEnv !== ''
    ? [working.apiKeyEnv]
    : fallbackRefs.filter(ref => ref !== '')
  const candidateKey = candidates.join('\u0000')
  useEffect(() => {
    if (candidateKey === '') return undefined
    let live = true
    void api.credentials.describe(candidateKey.split('\u0000')).then(
      (response) => {
        if (!live) return
        setCredentials(response.ok ? response.value : {})
      },
      () => { if (live) setCredentials({}) },
    )
    return () => { live = false }
  }, [api, candidateKey])

  const edit = useCallback((key: string, within: readonly string[] | undefined, value: unknown): void => {
    setDraft((current) => {
      const next = { ...(current ?? base) }
      if (within === undefined) {
        if (value === undefined) delete next[key]
        else next[key] = value
        return next
      }
      const existing = next[key]
      const nextRoot = value === undefined ? deletePath(existing, within) : setPath(existing, within, value)
      // An empty object is not a valid value for `thinkingBudgets`; dropping it is
      // what turns "cleared every budget" into an `unset`.
      const empty = typeof nextRoot === 'object' && nextRoot !== null && Object.keys(nextRoot).length === 0
      if (nextRoot === undefined || empty) delete next[key]
      else next[key] = nextRoot
      return next
    })
    setTouched((current) => new Set(current).add(key))
  }, [base])

  const reset = useCallback((): void => {
    setDraft(null)
    setTouched(new Set())
    setEpoch((value) => value + 1)
  }, [])

  return {
    working,
    touched,
    epoch,
    overridden,
    // The adapter reads the native list in order, so the first variable that
    // resolves is the one a request would actually carry.
    credential: candidates.map(ref => credentials[ref]).find(state => state?.configured === true)
      ?? (candidates.length === 0 ? undefined : credentials[candidates[0]]),
    edit,
    reset,
  }
}

/** Props of {@link RouteAdvancedFields}. */
export interface RouteAdvancedFieldsProps {
  /** The draft, from {@link useRouteAdvancedDraft}. */
  readonly draft: RouteAdvancedDraft
  /** Read-only surface, or a write in flight elsewhere on the page. */
  readonly disabled: boolean
  /** The page's namespace-bound translate. */
  readonly t: Translate
}

/**
 * Render the advanced sections of a provider.
 * @param props - see {@link RouteAdvancedFieldsProps}.
 * @returns the sections.
 */
export function RouteAdvancedFields({ draft, disabled, t }: RouteAdvancedFieldsProps): ReactNode {
  const { working, credential, edit, epoch } = draft
  const retryError = retryFailure(working.retryPolicy)
  const defaultInput = Array.isArray(working.defaultInput)
    ? working.defaultInput.filter((value): value is string => typeof value === 'string')
    : []

  return (
    <>
      {SECTIONS.map(section => (
        <section className="dshAma-advSection" key={section.id}>
          <span className="dshAma-advLabel">{t(section.titleKey)}</span>
          {section.id === 'credential' ? (
            <p className="dshAma-hint">
              {credential === undefined
                ? t('adv.pg.credential.unknown')
                : credential.configured
                  ? t('adv.pg.credential.configured', { source: credential.source ?? '' })
                  : t('adv.pg.credential.missing')}
            </p>
          ) : null}
          {section.fields.length === 0 ? null : (
            <div className="dshAma-formGrid">
              {section.fields.map(field => (
                <AdvancedField
                  key={`${field.key}:${(field.within ?? []).join('.')}`}
                  id={`dshAma-adv-${section.id}-${field.key}-${(field.within ?? []).join('-')}`}
                  label={t(field.labelKey)}
                  value={field.within === undefined ? working[field.key] : getPath(working[field.key], field.within)}
                  kind={field.kind}
                  choices={field.choices}
                  choiceLabel={field.key === 'retryPolicy' && field.within?.[0] === 'mode'
                    ? (choice) => (choice === 'always' ? t('adv.retry.modeAlways') : t('adv.retry.modeNormal'))
                    : undefined}
                  disabled={disabled}
                  invalidCopy={t('adv.pg.numberInvalid')}
                  inheritLabel={t('adv.pg.inherit')}
                  onCommit={(next) => { edit(field.key, field.within, next) }}
                />
              ))}
              {section.id === 'defaults' ? (
                <div className="dshAma-field">
                  <span className="dshAma-fieldLabel">{t('adv.pg.defaultInput')}</span>
                  <div className="dshAma-chipRow">
                    {MODALITIES.map(modality => (
                      <Chip
                        key={modality}
                        on={defaultInput.includes(modality)}
                        disabled={disabled}
                        onClick={() => {
                          const next = defaultInput.includes(modality)
                            ? defaultInput.filter(value => value !== modality)
                            : [...defaultInput, modality]
                          edit('defaultInput', undefined, next.length === 0 ? undefined : next)
                        }}
                      >{modality === 'text' ? t('adv.pg.modality.text') : t('adv.pg.modality.image')}</Chip>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
          {section.id === 'retry' && retryError !== undefined
            ? <span className="dshAma-rowError" role="status">{messageText(retryError, t)}</span>
            : null}
          {section.id === 'headers' ? (
            <HeadersField
              key={`headers:${String(epoch)}`}
              t={t}
              value={working.headers}
              disabled={disabled}
              onChange={(next) => { edit('headers', undefined, next) }}
            />
          ) : null}
        </section>
      ))}
    </>
  )
}

/**
 * How many of the sections' own keys carry a value, for the block header's
 * badge. Scoping it to the section keys (rather than the whole draft) is what
 * keeps the number honest — the draft also carries `api` and `baseURL` on a
 * written route.
 *
 * @param working - the working draft.
 * @returns the number of configured managed keys.
 */
export function configuredRouteCount(working: ModelDraft): number {
  let count = 0
  for (const section of SECTIONS) {
    for (const key of section.keys) {
      const value = working[key]
      if (value === undefined) continue
      if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) continue
      count += 1
    }
  }
  return count
}
