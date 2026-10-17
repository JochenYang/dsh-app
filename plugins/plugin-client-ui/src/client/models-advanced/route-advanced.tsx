/**
 * The advanced route parameters card.
 *
 * A fourth card beside 路由默认推理档 / 重试策略 / 自定义请求头, on the same page and
 * for the same route: it carries the profile fields those three do not — the
 * credential variable, thinking budgets, request timeouts, route capability
 * defaults, cache/transport preference and the image budgets — which until now had
 * no editing surface anywhere in the application.
 *
 * Shape of the surface, and why:
 *
 *   - **Groups, not one column of twenty inputs.** Grouped by the question they
 *     answer, a user finds the knob by intent instead of by scanning.
 *   - **One save, and only what the user touched.** The operations name just the
 *     changed keys (`route-fields.ts`), so a save can never rewrite an unrelated
 *     field from a stale view — and clearing a field writes an `unset`, which is
 *     what restores the inherited value.
 *   - **A conflict never discards the draft.** It reloads for a fresh revision and
 *     retries once; a second conflict asks, keeping the input until the user says
 *     otherwise.
 *
 * The seed is the USER layer, exactly like the three cards beside it: this page
 * edits the user's own overrides, and "（继承默认）" is the honest label for a field
 * the user has not set even when a lower layer carries a value.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/route-advanced
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { getPath, setPath, deletePath, REASONING_LEVELS, type ModelDraft } from './fields.ts'
import { message, messageText } from './messages.ts'
import type { PageMessage, Translate } from './messages.ts'
import type { AdvancedModelsRemote, AdvancedModelsStore, RouteRow } from './store.ts'
import { writeOps } from './store.ts'
import {
  CACHE_RETENTION, TRANSPORT_CHOICES,
  managedSubset, normalizeManaged, overriddenKeys, retryFailure, routeOps,
} from './route-fields.ts'
import type { RoutePathOp } from './route-fields.ts'
import { CheckField, FieldGroup, HeadersField, ScalarField } from './ui.tsx'
import type { AdvancedModelsKey } from './locales.ts'

/** Everything the card receives; the same shape its three siblings take. */
export interface RouteAdvancedCardProps {
  /** The route being edited (its settings path addresses every write). */
  readonly row: RouteRow
  /** Read-only surface, or a write in flight elsewhere on the page. */
  readonly disabled: boolean
  /** The page's Remote face. */
  readonly api: AdvancedModelsRemote
  /** The page's namespace-bound translate. */
  readonly t: Translate
  /** The route namespace's view (revision for the write fence). */
  readonly namespace: SettingsNamespaceView | undefined
  /** The page's store, for the reload after a conflict. */
  readonly controller: AdvancedModelsStore
}

/** One control's spec, so the groups stay declarative. */
interface FieldSpec {
  /** Profile key this control writes. */
  key: string
  /** Locale key of the label. */
  labelKey: AdvancedModelsKey
  /** Locale key of the hint under the control. */
  hintKey: AdvancedModelsKey
  /** Control kind. */
  kind: 'count' | 'duration' | 'retries' | 'ratio' | 'text' | 'credential' | 'enum'
  /** Accepted values for an enum. */
  choices?: readonly string[]
  /** Nested path inside the profile key (`thinkingBudgets`). */
  within?: readonly string[]
}

/** One group of fields. */
interface GroupSpec {
  /** Stable id, also the control id prefix. */
  id: string
  /** Locale key of the title. */
  titleKey: AdvancedModelsKey
  /** Locale key of the group description. */
  hintKey: AdvancedModelsKey
  /** Every profile key this group shows a value for, custom rows included. */
  keys: readonly string[]
  /** The scalar controls. */
  fields: readonly FieldSpec[]
}

/** The groups, in render order. */
const GROUPS: readonly GroupSpec[] = [
  {
    id: 'credential',
    titleKey: 'adv.pg.g.credential',
    hintKey: 'adv.pg.g.credential.hint',
    keys: ['apiKeyEnv'],
    fields: [
      { key: 'apiKeyEnv', labelKey: 'adv.pg.apiKeyEnv', hintKey: 'adv.pg.apiKeyEnv.hint', kind: 'credential' },
    ],
  },
  {
    id: 'reasoning',
    titleKey: 'adv.pg.g.reasoning',
    hintKey: 'adv.pg.g.reasoning.hint',
    keys: ['reasoning', 'thinkingBudgets'],
    fields: [
      { key: 'reasoning', labelKey: 'adv.reasoningCard.field', hintKey: 'adv.reasoningCard.hint', kind: 'enum', choices: REASONING_LEVELS },
      { key: 'thinkingBudgets', labelKey: 'adv.pg.budget.minimal', hintKey: 'adv.pg.budget.hint', kind: 'count', within: ['minimal'] },
      { key: 'thinkingBudgets', labelKey: 'adv.pg.budget.low', hintKey: 'adv.pg.budget.hint', kind: 'count', within: ['low'] },
      { key: 'thinkingBudgets', labelKey: 'adv.pg.budget.medium', hintKey: 'adv.pg.budget.hint', kind: 'count', within: ['medium'] },
      { key: 'thinkingBudgets', labelKey: 'adv.pg.budget.high', hintKey: 'adv.pg.budget.hint', kind: 'count', within: ['high'] },
    ],
  },
  {
    id: 'retry',
    titleKey: 'adv.pg.g.retry',
    hintKey: 'adv.retry.hint',
    keys: ['retryPolicy'],
    fields: [
      { key: 'retryPolicy', labelKey: 'adv.retry.mode', hintKey: 'adv.pg.retry.modeHint', kind: 'enum', choices: ['normal', 'always'], within: ['mode'] },
      { key: 'retryPolicy', labelKey: 'adv.retry.maxRetries', hintKey: 'adv.pg.retry.maxRetriesHint', kind: 'retries', within: ['maxRetries'] },
      { key: 'retryPolicy', labelKey: 'adv.retry.initialDelay', hintKey: 'adv.pg.retry.backoffHint', kind: 'duration', within: ['backoff', 'initialDelayMs'] },
      { key: 'retryPolicy', labelKey: 'adv.retry.maxDelay', hintKey: 'adv.pg.retry.backoffHint', kind: 'duration', within: ['backoff', 'maxDelayMs'] },
      { key: 'retryPolicy', labelKey: 'adv.retry.jitter', hintKey: 'adv.pg.retry.backoffHint', kind: 'ratio', within: ['backoff', 'jitterRatio'] },
    ],
  },
  {
    id: 'timeout',
    titleKey: 'adv.pg.g.timeout',
    hintKey: 'adv.pg.g.timeout.hint',
    keys: ['timeoutMs', 'websocketConnectTimeoutMs', 'streamIdleTimeoutMs'],
    fields: [
      { key: 'timeoutMs', labelKey: 'adv.pg.timeoutMs', hintKey: 'adv.pg.timeoutMs.hint', kind: 'duration' },
      { key: 'websocketConnectTimeoutMs', labelKey: 'adv.pg.wsTimeoutMs', hintKey: 'adv.pg.wsTimeoutMs.hint', kind: 'duration' },
      { key: 'streamIdleTimeoutMs', labelKey: 'adv.pg.idleTimeoutMs', hintKey: 'adv.pg.idleTimeoutMs.hint', kind: 'duration' },
    ],
  },
  {
    id: 'defaults',
    titleKey: 'adv.pg.g.defaults',
    hintKey: 'adv.pg.g.defaults.hint',
    keys: ['defaultContextWindow', 'defaultMaxTokens', 'defaultInput'],
    fields: [
      { key: 'defaultContextWindow', labelKey: 'adv.pg.defaultContextWindow', hintKey: 'adv.pg.defaultContextWindow.hint', kind: 'count' },
      { key: 'defaultMaxTokens', labelKey: 'adv.pg.defaultMaxTokens', hintKey: 'adv.pg.defaultMaxTokens.hint', kind: 'count' },
    ],
  },
  {
    id: 'request',
    titleKey: 'adv.pg.g.request',
    hintKey: 'adv.pg.g.request.hint',
    keys: ['cacheRetention', 'transport', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes'],
    fields: [
      { key: 'cacheRetention', labelKey: 'adv.pg.cacheRetention', hintKey: 'adv.pg.cacheRetention.hint', kind: 'enum', choices: CACHE_RETENTION },
      { key: 'transport', labelKey: 'adv.pg.transport', hintKey: 'adv.pg.transport.hint', kind: 'enum', choices: TRANSPORT_CHOICES },
      { key: 'maxRequestImageBytes', labelKey: 'adv.pg.maxImageBytes', hintKey: 'adv.pg.maxImageBytes.hint', kind: 'count' },
      { key: 'requestImagePixelBudget', labelKey: 'adv.pg.pixelBudget', hintKey: 'adv.pg.pixelBudget.hint', kind: 'count' },
      { key: 'requestImageMaxBytes', labelKey: 'adv.pg.imageMaxBytes', hintKey: 'adv.pg.imageMaxBytes.hint', kind: 'count' },
    ],
  },
  {
    id: 'headers',
    titleKey: 'adv.headers.title',
    hintKey: 'adv.headers.hint',
    keys: ['headers'],
    // The rows are a child component of the field itself, not scalar controls.
    fields: [],
  },
]

/**
 * The advanced parameters card.
 * @param props - the route, the page's face and the write fence.
 * @returns the card.
 */
export function RouteAdvancedCard(props: RouteAdvancedCardProps): ReactNode {
  const { row, disabled, api, t, namespace, controller } = props
  const [draft, setDraft] = useState<ModelDraft | null>(null)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<PageMessage | undefined>(undefined)
  const [notice, setNotice] = useState<PageMessage | undefined>(undefined)
  const [credentials, setCredentials] = useState<Record<string, { configured: boolean, source?: string }>>({})

  // The user layer is this card's baseline, the same way the three cards beside it
  // read their own key out of `row.userProfile`.
  const base = useMemo(() => managedSubset(row.userProfile), [row.userProfile])
  const overridden = useMemo(() => overriddenKeys(row.userProfile), [row.userProfile])
  const working = draft ?? base
  const fieldDisabled = disabled || busy

  const reference = typeof working.apiKeyEnv === 'string' && working.apiKeyEnv !== ''
    ? working.apiKeyEnv
    : undefined
  useEffect(() => {
    if (reference === undefined) return undefined
    let live = true
    void api.credentials.describe([reference]).then(
      (response) => {
        if (!live) return
        setCredentials(response.ok ? response.value : {})
      },
      () => { if (live) setCredentials({}) },
    )
    return () => { live = false }
  }, [api, reference])

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
    setNotice(undefined)
    setFailure(undefined)
  }, [base])

  const save = useCallback(async (): Promise<void> => {
    // The retry policy is validated as a whole before anything is written: the
    // form can hold a pair the schema resolves differently (initial 30000 beside a
    // blank max), and the value that goes on the wire is the one the schema's own
    // reader builds.
    const normalized = normalizeManaged(working)
    if (!normalized.ok) {
      setFailure(normalized.failure)
      return
    }
    const ops = routeOps(row.entry.settingsPath, normalized.draft, touched)
    if (ops.length === 0) return
    setBusy(true)
    setFailure(undefined)
    let outcome = await writeOps(api, ops as readonly SettingsPathOpView[], namespace?.revision)
    if (outcome.kind === 'conflict') {
      // Someone else wrote first. The operations name only the keys this user
      // touched, so reloading for a fresh revision and re-applying them is exactly
      // what was asked for — and it beats throwing the draft away. One automatic
      // retry; a second conflict means two surfaces are being edited at once.
      await controller.load()
      const fresh = controller.store.getSnapshot().namespaces.get(row.entry.settingsNs)?.revision
      outcome = await writeOps(api, ops as readonly SettingsPathOpView[], fresh)
    }
    setBusy(false)
    if (outcome.kind === 'ok') {
      setDraft(null)
      setTouched(new Set())
      setNotice(message('adv.pg.saved'))
      await controller.load()
      return
    }
    if (outcome.kind === 'conflict') {
      setFailure(message('adv.pg.conflict'))
      return
    }
    setFailure(outcome.message)
  }, [api, controller, namespace, row.entry.settingsNs, row.entry.settingsPath, touched, working])

  const configuredCount = GROUPS.reduce(
    (total, group) => total + group.keys.filter(key => working[key] !== undefined).length,
    0,
  )
  const dirty = touched.size
  const retryError = retryFailure(working.retryPolicy)
  const credentialState = reference === undefined ? undefined : credentials[reference]

  return (
    <details className="dshAma-card dshAma-retryCard">
      <summary className="dshAma-cardSummary">
        {t('adv.pg.title')}
        {configuredCount === 0
          ? t('adv.pg.summaryDefault')
          : t('adv.pg.summaryCount', { count: configuredCount })}
      </summary>
      <div className="dshAma-cardBody">
        <p className="dshAma-hint">{t('adv.pg.intro')}</p>
        {GROUPS.map(group => (
          <FieldGroup
            key={group.id}
            title={t(group.titleKey)}
            hint={t(group.hintKey)}
            summary={groupSummary(group, working, t)}
            forceOpen={group.fields.some(field => touched.has(field.key))
              || (group.id === 'headers' && touched.has('headers'))}
            error={group.id === 'retry' && retryError !== undefined ? messageText(retryError, t) : undefined}
          >
            {group.id === 'credential' ? (
              <p className="dshAma-hint">
                {credentialState === undefined
                  ? t('adv.pg.credential.unknown')
                  : credentialState.configured
                    ? t('adv.pg.credential.configured', { source: credentialState.source ?? '' })
                    : t('adv.pg.credential.missing')}
              </p>
            ) : null}
            {group.fields.map(field => (
              <ScalarField
                key={`${field.key}:${(field.within ?? []).join('.')}`}
                id={`dshAma-adv-${group.id}-${field.key}-${(field.within ?? []).join('-')}`}
                label={t(field.labelKey)}
                hint={t(field.hintKey)}
                value={field.within === undefined ? working[field.key] : getPath(working[field.key], field.within)}
                kind={field.kind}
                choices={field.choices}
                choiceLabel={field.key === 'retryPolicy' && field.within?.[0] === 'mode'
                  ? (choice) => (choice === 'always' ? t('adv.retry.modeAlways') : t('adv.retry.modeNormal'))
                  : undefined}
                disabled={fieldDisabled}
                invalidCopy={t('adv.pg.numberInvalid')}
                inheritLabel={t('adv.pg.inherit')}
                overridden={overridden.has(field.key)}
                overriddenLabel={t('adv.pg.overridden')}
                resetLabel={t('adv.pg.reset')}
                onCommit={(next) => { edit(field.key, field.within, next) }}
              />
            ))}
            {group.id === 'headers' ? (
              <HeadersField
                key={`headers:${row.entry.provider}:${String(touched.has('headers'))}`}
                t={t}
                value={working.headers}
                disabled={fieldDisabled}
                onChange={(next) => { edit('headers', undefined, next) }}
              />
            ) : null}
            {group.id === 'defaults' ? (
              <div className="dshAma-field">
                <span className="dshAma-fieldLabel">{t('adv.pg.defaultInput')}</span>
                <div className="dshAma-inline">
                  {(['text', 'image'] as const).map(modality => (
                    <CheckField
                      key={modality}
                      label={modality === 'text' ? t('adv.pg.modality.text') : t('adv.pg.modality.image')}
                      checked={Array.isArray(working.defaultInput)
                        && (working.defaultInput as readonly unknown[]).includes(modality)}
                      disabled={fieldDisabled}
                      onChange={(on) => {
                        const current = Array.isArray(working.defaultInput)
                          ? (working.defaultInput as readonly string[]).filter(value => value !== modality)
                          : []
                        const next = on ? [...current, modality] : current
                        edit('defaultInput', undefined, next.length === 0 ? undefined : next)
                      }}
                    />
                  ))}
                </div>
                <p className="dshAma-fieldHint">{t('adv.pg.defaultInput.hint')}</p>
              </div>
            ) : null}
          </FieldGroup>
        ))}

        {failure === undefined ? null : <p className="dshAma-error">{messageText(failure, t)}</p>}
        {notice === undefined ? null : <p className="dshAma-notice">{messageText(notice, t)}</p>}
        <div className="dshAma-footer">
          <Button
            type="button" variant="primary" size="sm"
            disabled={fieldDisabled || dirty === 0}
            onClick={() => { void save() }}
          >{busy ? t('adv.save.busy') : t('adv.pg.save')}</Button>
          <Button
            type="button" variant="outline" size="sm"
            disabled={fieldDisabled || dirty === 0}
            onClick={() => { setDraft(null); setTouched(new Set()); setNotice(undefined); setFailure(undefined) }}
          >{t('adv.pg.reset')}</Button>
          {dirty === 0 ? null : <span className="dshAma-hint">{t('adv.pg.dirty', { count: dirty })}</span>}
        </div>
      </div>
    </details>
  )
}

/**
 * The collapsed group's summary line.
 * @param group - the group definition.
 * @param working - the working draft.
 * @param t - translate.
 * @returns the summary copy.
 */
function groupSummary(group: GroupSpec, working: ModelDraft, t: Translate): string {
  const set = group.keys.filter((key) => {
    const value = working[key]
    return value !== undefined && !(typeof value === 'object' && value !== null && Object.keys(value).length === 0)
  })
  return set.length === 0 ? t('adv.pg.summaryDefault') : t('adv.pg.summaryCount', { count: set.length })
}

/** Re-exported so the page's own import list stays one line per module. */
export type { RoutePathOp }
