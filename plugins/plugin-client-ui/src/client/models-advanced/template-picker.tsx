/**
 * The provider template picker: the first step of adding a provider.
 *
 * Curated presets are grouped (common / China / global / gateways) and the long
 * tail sits behind 更多供应商; the search box filters every entry by name, label
 * or endpoint host. Picking one only pre-fills the create form — the catalog
 * says which endpoint a vendor uses, never that the account may call it.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/template-picker
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { CUSTOM_TEMPLATE, PROVIDER_TEMPLATES } from './templates/index.ts'
import type { ProviderTemplate } from './templates/types.ts'
import { templateField, templateLabel } from './templates/text.ts'
import { ProviderMark } from './provider-mark.tsx'
import { IconArrowLeft, IconPlus } from './icons.tsx'
import type { Translate } from './messages.ts'
import type { AdvancedModelsKey } from './locales.ts'

/** Group order in the picker; the long tail is last and starts collapsed. */
const GROUP_ORDER = ['groupCommon', 'groupCn', 'groupGlobal', 'groupGateway', 'groupMore'] as const

/** How many cards a group shows before 展开. */
const GROUP_PREVIEW = 12

/** Props of {@link TemplatePicker}. */
export interface TemplatePickerProps {
  readonly t: Translate
  /** Route ids already declared, so a preset that would collide is still shown
   *  (the create form reports it) but the picker can stay neutral. */
  readonly existingRoutes: ReadonlySet<string>
  readonly onPick: (template: ProviderTemplate) => void
  readonly onBack: () => void
}

/** The endpoint host a card shows, or its raw base URL when it does not parse. */
function hostOf(baseURL: string): string {
  if (baseURL === '') return ''
  try {
    return new URL(baseURL).host
  } catch {
    return baseURL
  }
}

/**
 * Render the template picker.
 * @param props - see {@link TemplatePickerProps}.
 * @returns the picker page.
 */
export function TemplatePicker({ t, onPick, onBack }: TemplatePickerProps): ReactNode {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = needle === ''
      ? PROVIDER_TEMPLATES
      : PROVIDER_TEMPLATES.filter((template) => {
        const label = templateLabel(template, t).toLowerCase()
        return `${template.id} ${label} ${template.displayName} ${template.baseURL}`.toLowerCase().includes(needle)
      })
    return GROUP_ORDER.map((group) => {
      const entries = matched.filter(template => template.group === group)
      return { group, entries, hidden: entries.length > GROUP_PREVIEW && !expanded.has(group) }
    }).filter(item => item.entries.length > 0)
  }, [query, expanded, t])

  const customLabel = t('adv.tpl.custom')

  return (
    <div className="dshAma-view">
      <button type="button" className="dshAma-backBtn" onClick={onBack}>
        <IconArrowLeft />
        <span>{t('adv.detail.back')}</span>
      </button>
      <header className="dshAma-pageHead">
        <h2 className="dshAma-pageTitle">{t('adv.tpl.title')}</h2>
      </header>

      <div className="dshAma-searchRow">
        <input
          className="dshAma-input dshAma-inputSearch"
          value={query}
          placeholder={t('adv.tpl.search')}
          aria-label={t('adv.tpl.search')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>

      {groups.length === 0 ? <p className="dshAma-emptyNote">{t('adv.tpl.noMatch')}</p> : null}

      {query.trim() === '' ? (
        <button type="button" className="dshAma-tplCard dshAma-tplCustom" onClick={() => { onPick(CUSTOM_TEMPLATE) }}>
          <span className="dshAma-mark dshAma-markFallback dshAma-markAdd" style={{ width: 24, height: 24 }}>
            <IconPlus />
          </span>
          <span className="dshAma-tplBody">
            <span className="dshAma-tplName">{customLabel}</span>
            <span className="dshAma-tplHost">{t('adv.tpl.customHint')}</span>
          </span>
        </button>
      ) : null}

      {groups.map(({ group, entries, hidden }) => (
        <section className="dshAma-tplGroup" key={group}>
          <h3 className="dshAma-tplGroupTitle">
            {t(`adv.tpl.${group}` as AdvancedModelsKey)}
            <span className="dshAma-tplCount">{entries.length}</span>
          </h3>
          <div className="dshAma-tplGrid">
            {(hidden ? entries.slice(0, GROUP_PREVIEW) : entries).map(template => (
              <button
                key={template.id}
                type="button"
                className="dshAma-tplCard"
                onClick={() => { onPick(template) }}
              >
                <ProviderMark
                  iconKey={template.icon}
                  label={templateLabel(template, t)}
                  size={24}
                />
                <span className="dshAma-tplBody">
                  <span className="dshAma-tplName">{templateLabel(template, t)}</span>
                  <span className="dshAma-tplHost">{hostOf(template.baseURL)}</span>
                  {templateField(template, 'note', t) === ''
                    ? null
                    : <span className="dshAma-tplHost">{templateField(template, 'note', t)}</span>}
                </span>
              </button>
            ))}
          </div>
          {entries.length > GROUP_PREVIEW ? (
            <button
              type="button"
              className="dshAma-linkBtn dshAma-tplMore"
              onClick={() => {
                setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(group)) next.delete(group)
                  else next.add(group)
                  return next
                })
              }}
            >{hidden ? t('adv.tpl.showMore') : t('adv.tpl.showLess')}</button>
          ) : null}
        </section>
      ))}
    </div>
  )
}
