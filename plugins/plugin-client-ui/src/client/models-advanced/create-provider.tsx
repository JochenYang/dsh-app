/**
 * The create-provider form: a preset's fields, prefilled and editable.
 *
 * Creation writes two things that must not be conflated: the provider profile
 * (settings namespace, through the same path ops as every other write on this
 * page) and the API key (the credential store, never the profile). The caller
 * performs both and reports a key-write failure separately, because the profile
 * has already landed by then.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/create-provider
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProviderMark } from './provider-mark.tsx'
import { templateDisplayName, templateLabel } from './templates/text.ts'
import type { ProviderTemplate } from './templates/types.ts'
import { IconArrowLeft } from './icons.tsx'
import { message, messageText } from './messages.ts'
import type { PageMessage, Translate } from './messages.ts'
import type { AdvancedModelsKey } from './locales.ts'

/** The three wire protocols `llm-pi-ai` speaks, in picker order. */
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/** One protocol id. */
export type Protocol = (typeof PROTOCOLS)[number]

/** What the form hands back; the caller writes it. */
export interface CreateProviderValues {
  readonly displayName: string
  readonly route: string
  /** Credential name derived from the route (uppercased, `_API_KEY`). */
  readonly apiKeyEnv: string
  readonly api: Protocol
  readonly baseURL: string
  readonly apiKey: string
  readonly modelId: string
}

/** Route-id grammar: safe as a settings key and as an environment-variable stem. */
const ROUTE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u

/**
 * Derive the credential name a new route reads its key from (`deepseek` →
 * `DEEPSEEK_API_KEY`), the same rule the official page uses.
 * @param route - the route id.
 * @returns the environment-variable name.
 */
export function credentialNameFor(route: string): string {
  const stem = route.replace(/[^A-Za-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').toUpperCase()
  return `${stem === '' ? 'PROVIDER' : stem}_API_KEY`
}

/** Props of {@link CreateProviderForm}. */
export interface CreateProviderFormProps {
  readonly t: Translate
  readonly preset: ProviderTemplate
  /** Route ids already declared, for the collision check. */
  readonly existingRoutes: ReadonlySet<string>
  /** Credential names already named by a profile, for the key-collision check. */
  readonly existingCredentials: ReadonlySet<string>
  readonly busy: boolean
  readonly onCancel: () => void
  /** Write the provider; a returned message is shown in the form. */
  readonly onSubmit: (values: CreateProviderValues) => Promise<PageMessage | undefined>
}

/**
 * Render the create-provider form.
 * @param props - see {@link CreateProviderFormProps}.
 * @returns the form page.
 */
export function CreateProviderForm(props: CreateProviderFormProps): ReactNode {
  const { t, preset, existingRoutes, existingCredentials, busy, onCancel, onSubmit } = props
  const custom = preset.id === 'custom'
  const heading = custom ? t('adv.tpl.custom') : templateDisplayName(preset, t) || templateLabel(preset, t)
  const [displayName, setDisplayName] = useState(custom ? '' : templateDisplayName(preset, t))
  const [route, setRoute] = useState(custom ? '' : preset.id)
  const [api, setApi] = useState<Protocol>(
    (PROTOCOLS as readonly string[]).includes(preset.api) ? preset.api as Protocol : 'openai-completions',
  )
  const [baseURL, setBaseURL] = useState(preset.baseURL)
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [failure, setFailure] = useState<PageMessage | undefined>(undefined)

  const submit = async (): Promise<void> => {
    const cleanRoute = route.trim()
    if (!ROUTE_PATTERN.test(cleanRoute)) {
      setFailure(message('adv.create.routeInvalid'))
      return
    }
    if (existingRoutes.has(cleanRoute)) {
      setFailure(message('adv.create.routeTaken', { route: cleanRoute }))
      return
    }
    const credentialName = credentialNameFor(cleanRoute)
    if (existingCredentials.has(credentialName)) {
      // Two routes sharing one credential name share a key, so a later clear on
      // either would silently unauthenticate the other.
      setFailure(message('adv.create.credentialTaken', { name: credentialName, route: cleanRoute }))
      return
    }
    if (!/^https?:\/\/\S+$/iu.test(baseURL.trim())) {
      setFailure(message('adv.create.needBaseURL'))
      return
    }
    if (modelId.trim() === '') {
      setFailure(message('adv.create.needModel'))
      return
    }
    setFailure(undefined)
    const outcome = await onSubmit({
      displayName: displayName.trim(),
      route: cleanRoute,
      apiKeyEnv: credentialNameFor(cleanRoute),      api,
      baseURL: baseURL.trim(),
      apiKey,
      modelId: modelId.trim(),
    })
    if (outcome !== undefined) setFailure(outcome)
  }

  const anthropicHint = api === 'anthropic-messages' && /\/v1\/?$/iu.test(baseURL.trim())

  return (
    <div className="dshAma-view">
      <button type="button" className="dshAma-backBtn" onClick={onCancel}>
        <IconArrowLeft />
        <span>{t('adv.create.back')}</span>
      </button>
      <header className="dshAma-pageHead">
        <h2 className="dshAma-pageTitle">
          <ProviderMark iconKey={preset.icon} label={heading} size={22} />
          {heading}
        </h2>
      </header>

      <section className="dshAma-card">
        <div className="dshAma-cardBody">
          <div className="dshAma-formGrid">
            <div className="dshAma-field">
              <label className="dshAma-fieldLabel" htmlFor="dshAma-create-name">{t('adv.create.displayName')}</label>
              <Input
                id="dshAma-create-name"
                className="dshAma-inputWrap"
                type="text"
                value={displayName}
                placeholder={route}
                disabled={busy}
                onChange={(event) => { setDisplayName(event.target.value) }}
              />
            </div>
            <div className="dshAma-field">
              <label className="dshAma-fieldLabel" htmlFor="dshAma-create-route">{t('adv.create.route')}</label>
              <Input
                id="dshAma-create-route"
                className="dshAma-inputWrap"
                type="text"
                value={route}
                placeholder="my-gateway"
                disabled={busy}
                spellCheck={false}
                onChange={(event) => { setRoute(event.target.value) }}
              />
              <span className="dshAma-fieldHint">{t('adv.create.routeHint')}</span>
            </div>
            <div className="dshAma-field">
              <label className="dshAma-fieldLabel" htmlFor="dshAma-create-api">{t('adv.create.api')}</label>
              <span className="dshAma-selectWrap">
                <select
                  id="dshAma-create-api"
                  className="dshAma-input dshAma-select"
                  value={api}
                  disabled={busy}
                  onChange={(event) => { setApi(event.target.value as Protocol) }}
                >
                  {PROTOCOLS.map(protocol => (
                    <option key={protocol} value={protocol}>
                      {t(`adv.proto.${protocol}` as AdvancedModelsKey)}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            <div className="dshAma-field">
              <label className="dshAma-fieldLabel" htmlFor="dshAma-create-base">{t('adv.create.baseURL')}</label>
              <Input
                id="dshAma-create-base"
                className="dshAma-inputWrap"
                type="text"
                value={baseURL}
                placeholder="https://api.example.com/v1"
                disabled={busy}
                spellCheck={false}
                onChange={(event) => { setBaseURL(event.target.value) }}
              />
              {anthropicHint ? <span className="dshAma-fieldHint">{t('adv.create.anthropicHint')}</span> : null}
            </div>
            <div className="dshAma-field">
              <label className="dshAma-fieldLabel" htmlFor="dshAma-create-model">{t('adv.create.modelId')}</label>
              <Input
                id="dshAma-create-model"
                className="dshAma-inputWrap"
                type="text"
                value={modelId}
                placeholder="model-id"
                disabled={busy}
                spellCheck={false}
                onChange={(event) => { setModelId(event.target.value) }}
              />
              <span className="dshAma-fieldHint">{t('adv.create.modelHint')}</span>
            </div>
            <div className="dshAma-field">
              <label className="dshAma-fieldLabel" htmlFor="dshAma-create-key">{t('adv.create.apiKey')}</label>
              <Input
                id="dshAma-create-key"
                className="dshAma-inputWrap"
                type="password"
                value={apiKey}
                placeholder={t('adv.key.placeholder')}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => { setApiKey(event.target.value) }}
              />
              <span className="dshAma-fieldHint">{t('adv.create.apiKeyHint')}</span>
            </div>
          </div>
          {failure === undefined
            ? null
            : <p className="dshAma-alert is-err" role="alert">{messageText(failure, t)}</p>}
        </div>
        <footer className="dshAma-cardFoot">
          <span className="dshAma-dirty" />
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {t('adv.common.cancel')}
          </Button>
          <Button type="button" variant="primary" size="sm" disabled={busy} onClick={() => { void submit() }}>
            {busy ? t('adv.create.busy') : t('adv.create.submit')}
          </Button>
        </footer>
      </section>
    </div>
  )
}
