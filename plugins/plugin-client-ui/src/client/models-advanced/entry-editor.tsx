/**
 * One model entry's advanced editor: capacities, input modalities, the
 * reasoning-effort tri-state, and compat switches — the four field groups the
 * official Models page deliberately leaves to `settings.yaml`.
 *
 * Rows are structurally open like upstream's editors: the draft carries every
 * stored key, this form edits the ones it knows, and anything else survives
 * untouched (a future schema field, a hand-written `chatTemplateKwargs`).
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  COMPAT_FIELDS, COMPAT_PRESETS, MODALITIES, REASONING_LEVELS,
  formatCapacity, parseCapacity, readReasoning,
} from './fields.ts'
import type { ModelDraft, ReasoningDraft } from './fields.ts'

/** Props of {@link ModelEntryEditor}. */
export interface ModelEntryEditorProps {
  /** The row as currently drafted (structurally open). */
  row: ModelDraft
  /** Replace the row with the next draft. */
  onChange: (next: ModelDraft) => void
  /** Lock the id input (override rows address a catalog id by key). */
  lockedId?: boolean
  /** Index for aria labels. */
  index: number
  /** Disable every control (read-only settings or a pending write). */
  disabled: boolean
}

/** Remove a key, immutably, when the value is undefined. */
function withoutUndefined(row: ModelDraft, key: string): ModelDraft {
  if (!(key in row)) return row
  const next = { ...row }
  delete next[key]
  return next
}

/** Chevron that rotates while its row is open. */
function IconChevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Trash glyph for row removal (rendered by the parent list). */
export function IconTrash(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** The reasoning-effort tri-state editor: inherit / disabled / level dict. */
function ReasoningEditor(props: {
  value: ReasoningDraft
  onChange: (next: ReasoningDraft) => void
  index: number
  disabled: boolean
}): ReactNode {
  const { value, onChange, index, disabled } = props
  const mode = value === undefined ? 'inherit' : value === false ? 'off' : 'custom'
  const setMode = (next: 'inherit' | 'off' | 'custom'): void => {
    // Switching into `custom` from either simple state starts from the
    // conventional spelling — the level name itself — which the user can then
    // per-row adjust; an empty custom dict would silently mean "no levels".
    onChange(next === 'inherit' ? undefined : next === 'off' ? false
      : Object.fromEntries(['low', 'medium', 'high'].map(level => [level, level])))
  }
  const dict = mode === 'custom' && typeof value === 'object' && value !== null ? value : {}
  const unusedLevels = REASONING_LEVELS.filter(level => !(level in dict))
  return (
    <div className="dshAma-field">
      <span className="dshAma-fieldLabel">推理等级</span>
      <div className="dshAma-inline">
        <select
          className="dshAma-input dshAma-select"
          value={mode}
          aria-label={`推理等级模式 ${index + 1}`}
          disabled={disabled}
          onChange={(event) => { setMode(event.target.value as 'inherit' | 'off' | 'custom') }}
        >
          <option value="inherit">继承目录（未声明）</option>
          <option value="off">禁用推理</option>
          <option value="custom">自定义级别</option>
        </select>
        {mode === 'custom'
          ? (
            <select
              className="dshAma-input dshAma-select"
              value=""
              aria-label={`添加推理级别 ${index + 1}`}
              disabled={disabled || unusedLevels.length === 0}
              onChange={(event) => {
                const level = event.target.value
                if (level === '') return
                onChange({ ...dict, [level]: level })
              }}
            >
              {unusedLevels.length === 0 ? <option value="">已全部添加</option> : <option value="">添加级别…</option>}
              {unusedLevels.map(level => <option key={level} value={level}>{level}</option>)}
            </select>
          )
          : null}
      </div>
      {mode === 'custom'
        ? (
          <div className="dshAma-hint">级别 → 发送给网关的拼写；拼写留空表示该级别不发参数（如 off）。</div>
        )
        : null}
      {Object.entries(dict).map(([level, spelling]) => (
        <div key={level} className="dshAma-kvRow">
          <span className="dshAma-kvKey">{level}</span>
          <input
            className="dshAma-input"
            type="text"
            value={spelling ?? ''}
            placeholder="（不发参数）"
            aria-label={`${level} 的 wire 拼写`}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...dict, [level]: event.target.value.trim() === '' ? null : event.target.value })
            }}
          />
          <button
            type="button"
            className="dshAma-iconButton"
            aria-label={`移除级别 ${level}`}
            disabled={disabled}
            onClick={() => {
              const next = { ...dict }
              delete next[level]
              onChange(Object.keys(next).length === 0 ? undefined : next)
            }}
          ><IconTrash /></button>
        </div>
      ))}
    </div>
  )
}

/** The compat-switch editor: family presets plus per-key overrides. */
function CompatEditor(props: {
  value: Record<string, unknown> | undefined
  onChange: (next: Record<string, unknown> | undefined) => void
  index: number
  disabled: boolean
}): ReactNode {
  const { value, onChange, index, disabled } = props
  const dict = value ?? {}
  const unusedKeys = COMPAT_FIELDS.filter(field => !(field.key in dict))
  const setKey = (key: string, next: unknown): void => {
    const rows = { ...dict, [key]: next }
    onChange(Object.keys(rows).length === 0 ? undefined : rows)
  }
  const removeKey = (key: string): void => {
    const next = { ...dict }
    delete next[key]
    onChange(Object.keys(next).length === 0 ? undefined : next)
  }
  const valueControl = (field: { key: string; kind: 'boolean' | { enum: readonly string[] } }, current: unknown) => {
    if (field.kind === 'boolean') {
      return (
        <select
          className="dshAma-input dshAma-select"
          value={current === true ? 'true' : 'false'}
          aria-label={field.key}
          disabled={disabled}
          onChange={(event) => { setKey(field.key, event.target.value === 'true') }}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      )
    }
    return (
      <select
        className="dshAma-input dshAma-select"
        value={typeof current === 'string' ? current : ''}
        aria-label={field.key}
        disabled={disabled}
        onChange={(event) => { setKey(field.key, event.target.value) }}
      >
        <option value="">（选择取值）</option>
        {field.kind.enum.map(choice => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    )
  }
  return (
    <div className="dshAma-field">
      <span className="dshAma-fieldLabel">兼容开关（compat）</span>
      <div className="dshAma-inline">
        <select
          className="dshAma-input dshAma-select"
          value=""
          aria-label={`应用兼容预设 ${index + 1}`}
          disabled={disabled}
          onChange={(event) => {
            const preset = COMPAT_PRESETS.find(candidate => candidate.id === event.target.value)
            if (preset === undefined) return
            // Preset application fills unset keys and leaves rows the user
            // already tuned alone — a preset is a starting point, not a reset.
            onChange({ ...preset.value, ...dict })
          }}
        >
          <option value="">应用家族预设…</option>
          {COMPAT_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
        <select
          className="dshAma-input dshAma-select"
          value=""
          aria-label={`添加兼容开关 ${index + 1}`}
          disabled={disabled || unusedKeys.length === 0}
          onChange={(event) => {
            const field = COMPAT_FIELDS.find(candidate => candidate.key === event.target.value)
            if (field === undefined) return
            setKey(field.key, field.kind === 'boolean' ? false : field.kind.enum[0])
          }}
        >
          {unusedKeys.length === 0 ? <option value="">已全部添加</option> : <option value="">添加开关…</option>}
          {unusedKeys.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
        </select>
      </div>
      <div className="dshAma-hint">models.dev 无法提供这些网关兼容信息；预设基于实测路由维护，未知键以手写 settings.yaml 为准。</div>
      {Object.entries(dict).map(([key, current]) => {
        const meta = COMPAT_FIELDS.find(field => field.key === key)
        return (
          <div key={key} className="dshAma-kvRow">
            <span className="dshAma-kvKey" title={key}>{meta?.label ?? key}</span>
            {meta === undefined
              ? <span className="dshAma-readonlyValue">{JSON.stringify(current)}</span>
              : valueControl(meta, current)}
            <button
              type="button"
              className="dshAma-iconButton"
              aria-label={`移除兼容开关 ${key}`}
              disabled={disabled}
              onClick={() => { removeKey(key) }}
            ><IconTrash /></button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Render one model entry's expanded editor.
 * @param props - the drafted row, its replacement callback, and chrome state.
 * @returns the entry editor.
 */
export function ModelEntryEditor(props: ModelEntryEditorProps): ReactNode {
  const { row, onChange, index, disabled } = props
  // Capacities are edited as text; the buffer lives here so keystrokes are
  // never rewritten by the K/M formatter mid-word. The component stays
  // mounted while its row does, so the buffer is displaced only by the user.
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
    // NaN is kept in the buffer so the refusal names a row the user can
    // still see; the section's save gate refuses the write.
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
  return (
    <div className="dshAma-entryBody">
      {props.lockedId === true
        ? null
        : (
          <label className="dshAma-field">
            <span className="dshAma-fieldLabel">模型 ID（wire 名称）</span>
            <input
              className="dshAma-input"
              type="text"
              value={stringAt('id')}
              placeholder="如 glm-5.2"
              aria-label={`模型 ID ${index + 1}`}
              disabled={disabled}
              onChange={(event) => { onChange({ ...row, id: event.target.value }) }}
            />
          </label>
        )}
      <label className="dshAma-field">
        <span className="dshAma-fieldLabel">显示名称</span>
        <input
          className="dshAma-input"
          type="text"
          value={stringAt('name')}
          placeholder="（默认同 ID）"
          aria-label={`显示名称 ${index + 1}`}
          disabled={disabled}
          onChange={(event) => { setString('name', event.target.value) }}
        />
      </label>
      <div className="dshAma-capacityRow">
        <label className="dshAma-field">
          <span className="dshAma-fieldLabel">上下文窗口</span>
          <input
            className="dshAma-input"
            type="text"
            inputMode="numeric"
            value={contextText}
            placeholder="如 1000000 或 1M"
            aria-label={`上下文窗口 ${index + 1}`}
            disabled={disabled}
            onChange={(event) => { editCapacity('contextWindow', event.target.value) }}
          />
        </label>
        <label className="dshAma-field">
          <span className="dshAma-fieldLabel">输出上限</span>
          <input
            className="dshAma-input"
            type="text"
            inputMode="numeric"
            value={maxTokensText}
            placeholder="如 131072 或 128K"
            aria-label={`输出上限 ${index + 1}`}
            disabled={disabled}
            onChange={(event) => { editCapacity('maxTokens', event.target.value) }}
          />
        </label>
      </div>
      <div className="dshAma-field">
        <span className="dshAma-fieldLabel">输入模态</span>
        <div className="dshAma-inline">
          {MODALITIES.map(modality => (
            <label key={modality} className="dshAma-check">
              <input
                type="checkbox"
                checked={input.includes(modality)}
                disabled={disabled}
                onChange={() => { toggleModality(modality) }}
              />
              <span>{modality === 'text' ? '文本' : '图片'}</span>
            </label>
          ))}
        </div>
        <div className="dshAma-hint">视觉模型必须显式勾选“图片”；全部不勾 = 继承路由/目录默认。</div>
      </div>
      <ReasoningEditor
        index={index}
        disabled={disabled}
        value={readReasoning(row.reasoningEfforts)}
        onChange={(next) => {
          onChange(next === undefined || next === false
            ? withoutUndefined({ ...row }, 'reasoningEfforts')
            : { ...row, reasoningEfforts: next })
        }}
      />
      <CompatEditor
        index={index}
        disabled={disabled}
        value={typeof row.compat === 'object' && row.compat !== null && !Array.isArray(row.compat)
          ? row.compat as Record<string, unknown>
          : undefined}
        onChange={(next) => {
          onChange(next === undefined ? withoutUndefined({ ...row }, 'compat') : { ...row, compat: next })
        }}
      />
    </div>
  )
}
