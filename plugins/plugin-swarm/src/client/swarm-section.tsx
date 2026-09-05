/**
 * The swarm settings section: enable toggle (restart-applied), adaptive
 * toggle, and the numeric scheduling knobs. Reads and writes the user config
 * file through the host half's routes; scheduling edits apply to the next
 * swarm call without a restart.
 *
 * @module @dsh-app/plugin-swarm/client/swarm-section
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

const ROUTE = '/plugins/@dsh-app/plugin-swarm/api'

/** One numeric field's presentation metadata. */
interface FieldSpec {
  readonly key: string
  readonly label: string
  readonly hint: string
}

const NUMERIC_FIELDS: readonly FieldSpec[] = [
  { key: 'defaultConcurrency', label: '起始并发', hint: '批次开始时的并行子代理数' },
  { key: 'maxConcurrency', label: '并发上限', hint: '自适应恢复的稳态上限；未指定并发时池子还会向上探测（最高 64）' },
  { key: 'maxItems', label: '单批任务上限', hint: '一次 swarm 调用最多拆分的子任务数' },
  { key: 'startStaggerMs', label: '启动间隔 (ms)', hint: '相邻子代理的启动间隔，平滑网关压力' },
  { key: 'itemMaxRetries', label: '失败重试次数', hint: '子任务遇到限流/断流等瞬时错误时的自动重试次数' },
  { key: 'itemRetryDelayMs', label: '重试退避 (ms)', hint: '首次重试的等待时间，每次翻倍' },
  { key: 'perItemOutputLimit', label: '单任务结果截断', hint: '每个子任务回传结果的最大字符数' },
  { key: 'tokenBudget', label: '批次 token 预算', hint: '0 为不限制；达到预算后停止启动新子任务' },
]

/** The host route's config payload (mirror of SwarmConfigResponse). */
interface ConfigResponse {
  readonly defaults: Record<string, number | boolean>
  readonly overrides: Record<string, number | boolean>
  readonly effective: Record<string, number | boolean>
  readonly filePath: string
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string } }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

export function SwarmSection(): ReactNode {
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<ConfigResponse>(`${ROUTE}/config`)
      setConfig(data)
      const nextDraft: Record<string, string> = {}
      for (const field of NUMERIC_FIELDS) {
        nextDraft[field.key] = String(data.effective[field.key] ?? '')
      }
      setDraft(nextDraft)
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Fields whose draft differs from the current effective value. */
  const dirtyFields = useMemo(() => {
    if (config === null) return []
    return NUMERIC_FIELDS.filter(field => {
      const value = draft[field.key]
      return value !== undefined && value !== String(config.effective[field.key] ?? '')
    })
  }, [config, draft])

  const post = useCallback(async (patch: Record<string, number | boolean | null>) => {
    setBusy(true)
    setNotice(undefined)
    try {
      await fetchJson<ConfigResponse>(`${ROUTE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      throw failure
    } finally {
      setBusy(false)
    }
  }, [load])

  const onSave = useCallback(async () => {
    if (config === null || dirtyFields.length === 0) return
    const patch: Record<string, number | null> = {}
    for (const field of dirtyFields) {
      const raw = draft[field.key] ?? ''
      if (raw.trim() === '') {
        // Cleared input = clear the override (fall back to the overlay value).
        patch[field.key] = null
        continue
      }
      const value = Number(raw)
      if (!Number.isFinite(value)) {
        setError(`「${field.label}」不是有效数字`)
        return
      }
      patch[field.key] = value
    }
    try {
      await post(patch)
      setNotice('已保存，下一次并行任务调用即生效')
    } catch {
      // post() already surfaced the error banner.
    }
  }, [config, dirtyFields, draft, post])

  const onResetAll = useCallback(async () => {
    if (config === null) return
    const patch: Record<string, null> = {}
    for (const key of Object.keys(config.overrides)) patch[key] = null
    if (Object.keys(patch).length === 0) {
      setNotice('当前没有自定义项，全部为默认值')
      return
    }
    try {
      await post(patch)
      setNotice('已恢复默认值')
    } catch {
      // post() already surfaced the error banner.
    }
  }, [config, post])

  const onToggleEnabled = useCallback(async () => {
    if (config === null) return
    const next = !(config.effective.enabled !== false)
    try {
      await post({ enabled: next })
      setNotice(next ? '已设为启用，重启应用后生效' : '已设为禁用，重启应用后生效')
    } catch {
      // post() already surfaced the error banner.
    }
  }, [config, post])

  const onToggleAdaptive = useCallback(async () => {
    if (config === null) return
    const next = !(config.effective.adaptive !== false)
    try {
      await post({ adaptive: next })
      setNotice(next ? '已开启自适应调度，下一次调用即生效' : '已关闭自适应调度：并发将固定为起始值，下一次调用即生效')
    } catch {
      // post() already surfaced the error banner.
    }
  }, [config, post])

  const enabled = config !== null && config.effective.enabled !== false
  const adaptive = config !== null && config.effective.adaptive !== false

  return (
    <div className="dshs_section">
      <p className="dshs_title">并行子代理（Swarm）</p>
      <p className="dshs_hint">
        将可并行的任务拆分为多个子代理同时执行。调度参数保存后对下一次调用即时生效；启用/禁用需重启应用。
        自适应调度开启时，遇到限流会自动降速、恢复后缓慢爬升，并可能在稳定时向上探测网关余量（最高 64）。
      </p>

      {error !== undefined ? <div className="dshs_banner" role="alert">{error}</div> : null}
      {notice !== undefined ? <div className="dshs_noticeOk">{notice}</div> : null}

      <div className="dshs_toggleRow">
        <span className="dshs_toggleLabel">
          启用并行子代理（{config === null ? '…' : enabled ? '已启用' : '已禁用'}）
          <span className="dshs_toggleHint">禁用后 swarm 工具与 /swarm 命令不再注册，重启应用后生效</span>
        </span>
        <button
          type="button"
          className="dshs_toggle"
          role="switch"
          aria-checked={enabled}
          aria-label="启用并行子代理"
          disabled={busy || config === null}
          onClick={() => { void onToggleEnabled() }}
        />
      </div>

      <div className="dshs_toggleRow">
        <span className="dshs_toggleLabel">
          自适应调度（{config === null ? '…' : adaptive ? '已开启' : '已关闭'}）
          <span className="dshs_toggleHint">失败后并发自动减半、恢复后逐步爬升；关闭后并发固定为起始值</span>
        </span>
        <button
          type="button"
          className="dshs_toggle"
          role="switch"
          aria-checked={adaptive}
          aria-label="自适应调度"
          disabled={busy || config === null}
          onClick={() => { void onToggleAdaptive() }}
        />
      </div>

      <div className="dshs_grid">
        {NUMERIC_FIELDS.map((field) => {
          const overridden = config !== null && config.overrides[field.key] !== undefined
          const dirty = dirtyFields.some(dirtyField => dirtyField.key === field.key)
          return (
            <div key={field.key} className="dshs_field">
              <span className="dshs_fieldLabel">
                {field.label}
                <span className={overridden ? 'dshs_fieldBadge dshs_fieldBadgeCustom' : 'dshs_fieldBadge'}>
                  {overridden ? '自定义' : `默认 ${String(config?.defaults[field.key] ?? '…')}`}
                </span>
              </span>
              <input
                className="dshs_fieldInput"
                type="number"
                min={0}
                value={draft[field.key] ?? ''}
                disabled={busy || config === null}
                aria-label={field.label}
                onChange={(event) => {
                  const { value } = event.target
                  setDraft(previous => ({ ...previous, [field.key]: value }))
                }}
              />
              <span className="dshs_fieldHint">{field.hint}{dirty ? '（未保存）' : ''}</span>
            </div>
          )
        })}
      </div>

      <div className="dshs_actions">
        <button
          type="button"
          className="dshs_button dshs_buttonPrimary"
          disabled={busy || config === null || dirtyFields.length === 0}
          onClick={() => { void onSave() }}
        >保存修改{dirtyFields.length > 0 ? `（${String(dirtyFields.length)} 项）` : ''}</button>
        <button
          type="button"
          className="dshs_button"
          disabled={busy || config === null || Object.keys(config.overrides).length === 0}
          onClick={() => { void onResetAll() }}
        >全部恢复默认</button>
      </div>

      {config !== null
        ? <p className="dshs_path" title={config.filePath}>配置文件：{config.filePath}</p>
        : null}
    </div>
  )
}
