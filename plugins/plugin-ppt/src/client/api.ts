/**
 * Typed client for the PPT-mode host routes. Same-origin fetch against the
 * dsh web server; the host fence admits loopback-Host requests, which every
 * same-origin browser request is.
 *
 * @module @dsh-app/plugin-ppt/client/api
 */

import type { OfficeActive } from '../office-active.ts'
import { OFFICE_ACTIVE_FORMAT } from '../office-format.ts'
import { notifyOfficeActiveChanged } from './office-active-event.ts'

/**
 * The plugin's route prefix on the dsh web server (mirrors the host half;
 * the /api segment keeps clear of the loader-owned client.js bundle route).
 */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-ppt/api'

/** One PPT-mode API failure. */
export class PptApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Envelope of every PPT-mode answer. */
interface ModeEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string, message: string }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = await response.json() as ModeEnvelope<T>
  if (!body.ok || body.value === undefined) {
    throw new PptApiError(body.error?.code ?? 'unknown', body.error?.message ?? `HTTP ${String(response.status)}`)
  }
  return body.value
}

/** One template as the picker panel needs it (host TemplateView). */
export interface TemplateView {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly description: string
  /** Cover preview as a data URL; absent when the asset is unavailable. */
  readonly cover?: string
  readonly pageCount: number
}

/**
 * GET /mode payload: whether the session's PPT mode is on, the chosen template
 * (`null` = 常规主题, the neutral default), and when the entry was written.
 */
export interface ModeValue {
  readonly enabled: boolean
  readonly template: string | null
  readonly updatedAt: number | null
}

/** PUT /mode body: turn the mode on with a template (or none), or off. */
export interface ModeUpdate {
  readonly enabled: boolean
  readonly template: string | null
}

/** The PPT-mode API face. */
export const pptModeApi = {
  mode(sessionId: string): Promise<ModeValue> {
    return request<ModeValue>(`${ROUTE_PREFIX}/mode?sessionId=${encodeURIComponent(sessionId)}`)
  },
  setMode(sessionId: string, update: ModeUpdate): Promise<ModeValue> {
    return request<ModeValue>(`${ROUTE_PREFIX}/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...update }),
    }).then((value) => {
      // The claim moved with this write; every other capsule in this window
      // hears it here and can stand down without waiting for its poll.
      notifyOfficeActiveChanged(OFFICE_ACTIVE_FORMAT, value.updatedAt ?? Date.now())
      return value
    })
  },
  /** The suite-wide active claim, for the mutual-exclusion stand-down check. */
  officeActive(): Promise<OfficeActive | null> {
    return request<{ active: OfficeActive | null }>(`${ROUTE_PREFIX}/office-active`)
      .then(value => value.active)
  },
  templates(options?: { covers?: boolean }): Promise<{ templates: readonly TemplateView[] }> {
    const covers = options?.covers === false ? '?covers=0' : ''
    return request<{ templates: readonly TemplateView[] }>(`${ROUTE_PREFIX}/templates${covers}`)
  },
}
