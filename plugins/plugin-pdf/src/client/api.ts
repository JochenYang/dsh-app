/**
 * Typed client for the PDF-mode host routes. Same-origin fetch against the
 * dsh web server; the host fence admits loopback-Host requests, which every
 * same-origin browser request is.
 *
 * @module @dsh-app/plugin-pdf/client/api
 */

import type { OfficeActive } from '../office-active.ts'
import { OFFICE_ACTIVE_FORMAT } from '../office-format.ts'
import { notifyOfficeActiveChanged } from './office-active-event.ts'

/**
 * The plugin's route prefix on the dsh web server (mirrors the host half; the
 * /api segment keeps clear of the loader-owned client.js bundle route).
 */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-pdf/api'

/** One PDF-mode API failure. */
export class PdfApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Envelope of every PDF-mode answer. */
interface ModeEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string, message: string }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = await response.json() as ModeEnvelope<T>
  if (!body.ok || body.value === undefined) {
    throw new PdfApiError(body.error?.code ?? 'unknown', body.error?.message ?? `HTTP ${String(response.status)}`)
  }
  return body.value
}

/** GET /mode payload: the session's PDF-mode state and its write time. */
export interface ModeValue {
  readonly enabled: boolean
  readonly updatedAt: number | null
}

/** The PDF-mode API face. */
export const pdfModeApi = {
  mode(sessionId: string): Promise<ModeValue> {
    return request<ModeValue>(`${ROUTE_PREFIX}/mode?sessionId=${encodeURIComponent(sessionId)}`)
  },
  setMode(sessionId: string, enabled: boolean): Promise<ModeValue> {
    return request<ModeValue>(`${ROUTE_PREFIX}/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, enabled }),
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
}
