/**
 * One model entry's editor: the identity and capacity fields, the input-modality
 * chips, and the advanced half (reasoning levels, compat switches) — the field
 * groups the official Models page has no editor for.
 *
 * The layout is the source design's model dialog: a responsive grid of labelled
 * fields, chips for modalities, and one disclosure for the advanced half. An
 * override row (one catalog model corrected by id) additionally edits its
 * capacities and input modalities. A declared route's rows edit the same fields:
 * this page creates such routes, so it owns their capacities and modalities too
 * — only the identifier itself is locked for an override.
 *
 * Rows are structurally open like upstream's editors: the draft carries every
 * stored key, this form edits the ones it knows, and anything else survives
 * untouched (a future schema field, a hand-written `chatTemplateKwargs`).
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/entry-editor
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  COMPAT_PRESETS, MODALITIES, REASONING_LEVELS,
  compatFieldsForApi, formatCapacity, parseCapacity, readReasoning, reasoningCompatFill,
} from './fields.ts'
import type { ModelDraft, ReasoningDraft } from './fields.ts'
import { BoolToggle, Chip } from './ui.tsx'
import { IconChevron, IconPlus, IconTrash } from './icons.tsx'
import type { Translate } from './messages.ts'
import type { AdvancedModelsKey } from './locales.ts'

/** Props of {@link ModelEntryEditor}. */
export interface ModelEntryEditorProps {
  /** The row as currently drafted (structurally open). */
  row: ModelDraft
  /** Replace the row with the next draft. */
  onChange: (next: ModelDraft) => void
  /** Lock the id input (override rows address a catalog id by key). */
  lockedId?: boolean
  /**
   * Resolved wire protocol for this row (model.api ?? route.api). Gates the
   * compat editor and the reasoning auto-fill. Unknown → union of hand
   * protocols plus a warning.
   */
  api?: string
  /**
   * True when the owning route is hand-declared (no catalog base). The reasoning
   * editor warns that nothing is inherited then; capacities and modalities are
   * edited here either way.
   */
  handDeclared?: boolean
  /** Index for aria labels (0 where the dialog has no list position). */
  index: number
  /** Disable every control (read-only settings or a pending write). */
  disabled: boolean
  /** The page's namespace-bound translate seat (every label here is its key). */
  t: Translate
}

/** Remove a key, immutably, when the value is undefined. */
function withoutUndefined(row: ModelDraft, key: string): ModelDraft {
  if (!(key in row)) return row
  const next = { ...row }
  delete next[key]
  return next
}

/**
 * Reasoning-mode change with a protocol-aware compat auto-fill. Once a row
 * starts declaring reasoning levels, private OpenAI-compatible gateways may
 * mis-detect as OpenAI and flip the system prompt to `developer`. Fill only
 * switches the row's protocol actually takes; never overwrite user-set keys.
 */
function reasoningChange(
  row: ModelDraft,
  onChange: (next: ModelDraft) => void,
  next: ReasoningDraft,
  api: string | undefined,
): void {
  const compatDict = typeof row.compat === 'object' && row.compat !== null && !Array.isArray(row.compat)
    ? row.compat as Record<string, unknown>
    : {}
  if (next !== undefined && next !== false && compatDict.supportsDeveloperRole === undefined) {
    const fill = reasoningCompatFill(api)
    if (Object.keys(fill).length === 0) {
      onChange({ ...row, reasoningEfforts: next })
      return
    }
    const merged: Record<string, unknown> = { ...compatDict }
    for (const [key, value] of Object.entries(fill)) {
      if (merged[key] === undefined) merged[key] = value
    }
    onChange({ ...row, reasoningEfforts: next, compat: merged })
    return
  }
  onChange(next === undefined
    ? withoutUndefined({ ...row }, 'reasoningEfforts')
    : { ...row, reasoningEfforts: next })
}

/**
 * Reasoning-effort editor: inherit / disabled / explicit level set.
 *
 * Inherit means different things by route kind — catalog routes can ride a
 * same-id installed model; hand-declared routes have no catalog base, so
 * omitting `reasoningEfforts` is literally "non-reasoning" and the chat model
 * picker will not offer an effort control. That trap is the main reason this
 * page exists for private gateways.
 */
function ReasoningEditor(props: {
  value: ReasoningDraft
  onChange: (next: ReasoningDraft) => void
  /** True when the route is hand-declared (no installed catalog base). */
  handDeclared: boolean
  index: number
  disabled: boolean
  t: Translate
}): ReactNode {
  const { value, onChange, handDeclared, index, disabled, t } = props
  const mode = value === undefined ? 'inherit' : value === false ? 'off' : 'custom'
  const dict = mode === 'custom' && typeof value === 'object' && value !== null ? value : {}
  const rows = Object.entries(dict)
  const used = new Set(rows.map(([level]) => level))

  const setMode = (next: string): void => {
    if (next === 'inherit') {
      onChange(undefined)
      return
    }
    if (next === 'off') {
      onChange(false)
      return
    }
    onChange(Object.fromEntries(['low', 'medium', 'high'].map(level => [level, level])))
  }

  const toggleLevel = (level: string, on: boolean): void => {
    if (!on) {
      const next = { ...dict }
      delete next[level]
      // Empty dict is illegal; drop back to inherit rather than a broken value.
      onChange(Object.keys(next).length === 0 ? undefined : next)
      return
    }
    onChange({ ...dict, [level]: level })
  }

  const available = REASONING_LEVELS.filter(level => !used.has(level))
  const addLevel = (): void => {
    if (available.length === 0) return
    // Offer the next escalation step after the highest declared level, so a
    // model that already speaks low/high gains "max" rather than "off".
    const highest = rows.reduce((top, [level]) => Math.max(top, REASONING_LEVELS.findIndex(candidate => candidate === level)), -1)
    const nextLevel = REASONING_LEVELS.find((level, position) => position > highest && !used.has(level))
      ?? available[0]
    onChange({ ...dict, [nextLevel]: nextLevel === 'off' ? null : nextLevel })
  }

  return (
    <div className="dshAma-thinking">
      <span className="dshAma-selectWrap">
        <select
          className="dshAma-input dshAma-select"
          value={mode}
          aria-label={t('adv.entry.reasoningModeAria', { index: index + 1 })}
          disabled={disabled}
          onChange={(event) => { setMode(event.target.value) }}
        >
          <option value="inherit">
            {handDeclared ? t('adv.entry.reasoningInheritDeclared') : t('adv.entry.reasoningInherit')}
          </option>
          <option value="off">{t('adv.entry.reasoningOff')}</option>
          <option value="custom">{t('adv.entry.reasoningCustom')}</option>
        </select>
      </span>
      {mode === 'inherit'
        ? (
          handDeclared
            ? (
              <span className="dshAma-rowError">
                {t('adv.entry.handDeclaredWarning')}<b>{t('adv.entry.noTiers')}</b>{t('adv.entry.handDeclaredWarningTail')}
              </span>
            )
            : <span className="dshAma-fieldHint">{t('adv.entry.inheritHint')}</span>
        )
        : null}
      {mode === 'off' ? <span className="dshAma-fieldHint">{t('adv.entry.offHint')}</span> : null}
      {mode === 'custom' ? (
        <>
          <div className="dshAma-effList" role="group" aria-label={t('adv.entry.levelGroupAria', { index: index + 1 })}>
            {rows.map(([level, spelling]) => (
              <div className="dshAma-kvRow" key={level}>
                <span className="dshAma-selectWrap dshAma-effLevel">
                  <select
                    className="dshAma-input dshAma-select"
                    value={level}
                    aria-label={t('adv.entry.levelSelectAria')}
                    disabled={disabled}
                    onChange={(event) => {
                      const nextLevel = event.target.value
                      if (nextLevel === level) return
                      // The wire spelling belongs to the OLD level: a renamed row keeps
                      // its custom spelling only between real levels, and an `off` row
                      // must send no parameter rather than the previous level's value.
                      const nextWire = nextLevel === 'off' ? null : level === 'off' ? nextLevel : spelling
                      const next: Record<string, string | null> = {}
                      for (const [key, wire] of rows) next[key === level ? nextLevel : key] = wire
                      next[nextLevel] = nextWire
                      onChange(next)
                    }}
                  >
                    {REASONING_LEVELS
                      .filter(candidate => candidate === level || !used.has(candidate))
                      .map(candidate => <option key={candidate} value={candidate}>{candidate}</option>)}
                  </select>
                </span>
                <Input
                  className="dshAma-inputWrap"
                  type="text"
                  value={spelling ?? ''}
                  placeholder={level === 'off' ? t('adv.entry.spellingPlaceholder') : level}
                  aria-label={t('adv.entry.spellingAria', { level })}
                  disabled={disabled}
                  onChange={(event) => {
                    const raw = event.target.value.trim()
                    onChange({ ...dict, [level]: raw === '' ? null : raw })
                  }}
                />
                <Button
                  type="button" variant="ghost" size="sm" icon={<IconTrash />}
                  className="dshAma-iconAction dshAma-iconDanger"
                  aria-label={t('adv.entry.removeLevelAria', { level })}
                  disabled={disabled}
                  onClick={() => { toggleLevel(level, false) }}
                />
              </div>
            ))}
          </div>
          {available.length === 0 ? null : (
            <button type="button" className="dshAma-addRow is-compact" disabled={disabled} onClick={addLevel}>
              <span className="dshAma-addRowIcon" aria-hidden="true"><IconPlus /></span>
              {t('adv.entry.addLevel')}
            </button>
          )}
          <span className="dshAma-fieldHint">{t('adv.entry.customHint')}</span>
        </>
      ) : null}
    </div>
  )
}

/**
 * Compat-switch editor, filtered to switches the resolved protocol offers.
 * Unknown protocol shows the union of hand-declared protocols plus a warning.
 */
function CompatEditor(props: {
  value: Record<string, unknown> | undefined
  onChange: (next: Record<string, unknown> | undefined) => void
  api: string | undefined
  index: number
  disabled: boolean
  t: Translate
}): ReactNode {
  const { value, onChange, api, index, disabled, t } = props
  const dict = value ?? {}
  const fields = compatFieldsForApi(api)
  const knownKeys = new Set(fields.map(field => field.key))
  const unusedKeys = fields.filter(field => !(field.key in dict))
  // Stored keys this protocol does not take: show them read-only so the user
  // can remove the invalid ones instead of losing them in a silent overwrite.
  const invalidKeys = Object.keys(dict).filter(key => !knownKeys.has(key)
    && !['chatTemplateKwargs', 'chatTemplateArgs'].includes(key))

  const setKey = (key: string, next: unknown): void => {
    const rows = { ...dict, [key]: next }
    onChange(Object.keys(rows).length === 0 ? undefined : rows)
  }
  const removeKey = (key: string): void => {
    const next = { ...dict }
    delete next[key]
    onChange(Object.keys(next).length === 0 ? undefined : next)
  }
  const valueControl = (field: { key: string; labelKey: AdvancedModelsKey; kind: 'boolean' | { enum: readonly string[] } }, current: unknown) => {
    if (field.kind === 'boolean') {
      return (
        <BoolToggle
          label={t(field.labelKey)}
          value={current === true}
          onLabel={t('adv.common.enabled')}
          offLabel={t('adv.common.disabled')}
          disabled={disabled}
          onChange={(next) => { setKey(field.key, next) }}
        />
      )
    }
    return (
      <span className="dshAma-selectWrap">
        <select
          className="dshAma-input dshAma-select"
          value={typeof current === 'string' ? current : ''}
          aria-label={field.key}
          disabled={disabled}
          onChange={(event) => { setKey(field.key, event.target.value) }}
        >
          <option value="">{t('adv.compat.selectValue')}</option>
          {field.kind.enum.map(choice => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </span>
    )
  }

  // Presets only apply keys this protocol accepts.
  const applyPreset = (presetId: string): void => {
    const preset = COMPAT_PRESETS.find(candidate => candidate.id === presetId)
    if (preset === undefined) return
    const filtered: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(preset.value)) {
      if (knownKeys.has(key) && dict[key] === undefined) filtered[key] = val
    }
    onChange({ ...filtered, ...dict })
  }

  return (
    <>
      <div className="dshAma-kvList">
        {invalidKeys.map(key => (
          <div className="dshAma-kvRow" key={key}>
            <span className="dshAma-kvLabel dshAma-invalid">{key}</span>
            <span className="dshAma-kvValue dshAma-muted">
              {t('adv.compat.notApplicable', { api: api ?? t('adv.compat.currentProtocol') })}
            </span>
            <Button
              type="button" variant="ghost" size="sm" icon={<IconTrash />}
              className="dshAma-iconAction dshAma-iconDanger"
              aria-label={t('adv.compat.removeInvalidAria', { key })}
              disabled={disabled}
              onClick={() => { removeKey(key) }}
            />
          </div>
        ))}
        {Object.entries(dict).map(([key, current]) => {
          if (!knownKeys.has(key)) return null
          const meta = fields.find(field => field.key === key)
          if (meta === undefined) return null
          return (
            <div className="dshAma-kvRow" key={key}>
              <span className="dshAma-kvLabel">{t(meta.labelKey)}</span>
              <div className="dshAma-kvValue">{valueControl(meta, current)}</div>
              <Button
                type="button" variant="ghost" size="sm" icon={<IconTrash />}
                className="dshAma-iconAction dshAma-iconDanger"
                aria-label={t('adv.compat.removeAria', { key })}
                disabled={disabled}
                onClick={() => { removeKey(key) }}
              />
            </div>
          )
        })}
      </div>
      <div className="dshAma-inline">
        <span className="dshAma-selectWrap" style={{ flex: '1 1 160px' }}>
          <select
            className="dshAma-input dshAma-select"
            value=""
            aria-label={t('adv.compat.applyPresetAria', { index: index + 1 })}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value !== '') applyPreset(event.target.value)
            }}
          >
            <option value="">{t('adv.compat.applyPreset')}</option>
            {COMPAT_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{t(preset.labelKey)}</option>)}
          </select>
        </span>
        <span className="dshAma-selectWrap" style={{ flex: '1 1 160px' }}>
          <select
            className="dshAma-input dshAma-select"
            value=""
            aria-label={t('adv.compat.addSwitchAria', { index: index + 1 })}
            disabled={disabled || unusedKeys.length === 0}
            onChange={(event) => {
              const field = fields.find(candidate => candidate.key === event.target.value)
              if (field === undefined) return
              setKey(field.key, field.kind === 'boolean' ? false : field.kind.enum[0])
            }}
          >
            {unusedKeys.length === 0
              ? <option value="">{t('adv.compat.allAdded')}</option>
              : <option value="">{t('adv.compat.addSwitch')}</option>}
            {unusedKeys.map(field => <option key={field.key} value={field.key}>{t(field.labelKey)}</option>)}
          </select>
        </span>
      </div>
      <span className="dshAma-fieldHint">
        {api === undefined || api === ''
          ? t('adv.compat.hintUnknownProtocol')
          : t('adv.compat.hintFiltered', { api })}
        {' '}{t('adv.compat.hintTail')}
      </span>
    </>
  )
}

/**
 * The disclosure the advanced half lives in: a quiet toggle with the configured
 * count, opening the reasoning and compat editors. Open by default when the row
 * already declares either, so an existing configuration is never hidden.
 */
function AdvancedPanel(props: {
  t: Translate
  initiallyOpen: boolean
  count: number
  children: ReactNode
}): ReactNode {
  const { t, count } = props
  const [open, setOpen] = useState(props.initiallyOpen)
  return (
    <div className="dshAma-thinking">
      <button
        type="button"
        className="dshAma-advToggle"
        aria-expanded={open}
        onClick={() => { setOpen((was) => !was) }}
      >
        <IconChevron open={open} />
        {t('adv.models.advanced')}
        {count === 0 ? null : <span className="dshAma-badge">{count}</span>}
      </button>
      {open ? <div className="dshAma-advPanel">{props.children}</div> : null}
    </div>
  )
}

/**
 * Render one model entry's editor.
 * @param props - the drafted row, its replacement callback, and chrome state.
 * @returns the editor.
 */
export function ModelEntryEditor(props: ModelEntryEditorProps): ReactNode {
  const { row, onChange, api, handDeclared, index, disabled, t } = props
  // Capacities are edited as text; the buffer lives here so keystrokes are
  // never rewritten by the K/M formatter mid-word. The dialog stays mounted
  // while it is open, so the buffer is displaced only by the user.
  const [contextText, setContextText] = useState(() => formatCapacity(
    typeof row.contextWindow === 'number' ? row.contextWindow : undefined,
  ))
  const [maxTokensText, setMaxTokensText] = useState(() => formatCapacity(
    typeof row.maxTokens === 'number' ? row.maxTokens : undefined,
  ))
  const stringAt = (key: string): string => typeof row[key] === 'string' ? row[key] as string : ''
  const setString = (key: string, next: string): void => {
    const clean = next.trim()
    onChange(clean === '' ? withoutUndefined({ ...row }, key) : { ...row, [key]: clean })
  }
  const editCapacity = (key: 'contextWindow' | 'maxTokens', text: string): void => {
    if (key === 'contextWindow') setContextText(text)
    else setMaxTokensText(text)
    const parsed = parseCapacity(text)
    // NaN is kept in the buffer so the refusal names a model the user can
    // still see; the page's save gate refuses the write.
    onChange(parsed === undefined
      ? withoutUndefined({ ...row }, key)
      : { ...row, [key]: parsed })
  }
  const input = Array.isArray(row.input)
    ? row.input.filter((m): m is string => typeof m === 'string')
    : []
  const toggleModality = (modality: string): void => {
    const next = input.includes(modality)
      ? input.filter(m => m !== modality)
      : [...input, modality]
    // An empty list is stored as absent: the schema materializes [] for a
    // missing array anyway, and absence keeps "inherit the catalog" legible.
    onChange(next.length === 0 ? withoutUndefined({ ...row }, 'input') : { ...row, input: next })
  }
  const advancedCount = (row.reasoningEfforts === undefined ? 0 : 1) + (row.compat === undefined ? 0 : 1)
  return (
    <div className="dshAma-modelForm">
      <div className="dshAma-formGrid">
        {props.lockedId === true
          ? (
            <div className="dshAma-field is-wide">
              <span className="dshAma-fieldLabel">{t('adv.entry.modelId')}</span>
              <div className="dshAma-readonly">{stringAt('id')}</div>
            </div>
          )
          : (
            <div className="dshAma-field is-wide">
              <label className="dshAma-fieldLabel" htmlFor={`dshAma-model-id-${String(index)}`}>
                {t('adv.entry.modelId')}
              </label>
              <Input
                id={`dshAma-model-id-${String(index)}`}
                className="dshAma-inputWrap"
                type="text"
                value={stringAt('id')}
                placeholder={t('adv.entry.modelIdPlaceholder')}
                aria-label={t('adv.entry.modelIdAria', { index: index + 1 })}
                disabled={disabled}
                data-modal-autofocus
                onChange={(event) => { onChange({ ...row, id: event.target.value }) }}
              />
            </div>
          )}
        <div className="dshAma-field is-wide">
          <label className="dshAma-fieldLabel" htmlFor={`dshAma-model-name-${String(index)}`}>
            {t('adv.entry.name')}
          </label>
          <Input
            id={`dshAma-model-name-${String(index)}`}
            className="dshAma-inputWrap"
            type="text"
            value={stringAt('name')}
            placeholder={t('adv.entry.namePlaceholder')}
            aria-label={t('adv.entry.nameAria', { index: index + 1 })}
            disabled={disabled}
            onChange={(event) => { setString('name', event.target.value) }}
          />
        </div>
        <div className="dshAma-field">
          <label className="dshAma-fieldLabel" htmlFor={`dshAma-model-context-${String(index)}`}>
            {t('adv.field.contextWindow')}
          </label>
          <Input
            id={`dshAma-model-context-${String(index)}`}
            className="dshAma-inputWrap"
            type="text"
            inputMode="numeric"
            value={contextText}
            placeholder={t('adv.entry.contextPlaceholder')}
            aria-label={t('adv.entry.contextAria', { index: index + 1 })}
            disabled={disabled}
            onChange={(event) => { editCapacity('contextWindow', event.target.value) }}
          />
        </div>
        <div className="dshAma-field">
          <label className="dshAma-fieldLabel" htmlFor={`dshAma-model-max-${String(index)}`}>
            {t('adv.field.maxTokens')}
          </label>
          <Input
            id={`dshAma-model-max-${String(index)}`}
            className="dshAma-inputWrap"
            type="text"
            inputMode="numeric"
            value={maxTokensText}
            placeholder={t('adv.entry.maxTokensPlaceholder')}
            aria-label={t('adv.entry.maxTokensAria', { index: index + 1 })}
            disabled={disabled}
            onChange={(event) => { editCapacity('maxTokens', event.target.value) }}
          />
        </div>
      </div>
      <div className="dshAma-field">
        <span className="dshAma-fieldLabel">{t('adv.entry.input')}</span>
        <div className="dshAma-chipRow">
          {MODALITIES.map(modality => (
            <Chip
              key={modality}
              on={input.includes(modality)}
              disabled={disabled}
              onClick={() => { toggleModality(modality) }}
            >{modality === 'text' ? t('adv.entry.inputText') : t('adv.entry.inputImage')}</Chip>
          ))}
        </div>
        <span className="dshAma-fieldHint">{t('adv.entry.inputHint')}</span>
      </div>
      <AdvancedPanel t={t} initiallyOpen={advancedCount > 0} count={advancedCount}>
        <div className="dshAma-field">
          <span className="dshAma-fieldLabel">{t('adv.entry.reasoningTitle')}</span>
          <ReasoningEditor
            t={t}
            index={index}
            disabled={disabled}
            handDeclared={handDeclared === true}
            value={readReasoning(row.reasoningEfforts)}
            onChange={(next) => reasoningChange(row, onChange, next, api)}
          />
        </div>
        <div className="dshAma-field">
          <span className="dshAma-fieldLabel">{t('adv.compat.title')}</span>
          <CompatEditor
            t={t}
            index={index}
            disabled={disabled}
            api={api}
            value={typeof row.compat === 'object' && row.compat !== null && !Array.isArray(row.compat)
              ? row.compat as Record<string, unknown>
              : undefined}
            onChange={(next) => {
              onChange(next === undefined ? withoutUndefined({ ...row }, 'compat') : { ...row, compat: next })
            }}
          />
        </div>
      </AdvancedPanel>
    </div>
  )
}
