/**
 * Typed client for the spreadsheet-mode host routes. Same-origin fetch against
 * the Connection `/api` channel the window's own origin serves; the carrier's
 * trust fence and browser authentication run before the route handler.
 *
 * @module @dsh-app/plugin-sheet/client/api
 */

import type { OfficeActive } from '../office-active.ts'
import { OFFICE_ACTIVE_FORMAT } from '../office-format.ts'
import { notifyOfficeActiveChanged } from './office-active-event.ts'

/**
 * The plugin's route prefix on the shared `/api` channel (mirrors the host
 * half; the Connection registry admits no `@` in a path segment, so the npm
 * scope travels as `dsh-app`).
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-sheet'

/** One mode-API failure. */
export class SheetApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Envelope of every mode answer. */
interface ModeEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string, message: string }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = await response.json() as ModeEnvelope<T>
  if (!body.ok || body.value === undefined) {
    throw new SheetApiError(body.error?.code ?? 'unknown', body.error?.message ?? `HTTP ${String(response.status)}`)
  }
  return body.value
}

/** GET /mode payload: the session's spreadsheet-mode state and its write time. */
export interface ModeValue {
  readonly enabled: boolean
  readonly updatedAt: number | null
}

/** The spreadsheet-mode API face. */
export const sheetModeApi = {
  mode(sessionId: string): Promise<ModeValue> {
    return request<ModeValue>(`${ROUTE_PREFIX}/mode?sessionId=${encodeURIComponent(sessionId)}`)
  },
  /**
   * Toggle the session's spreadsheet mode. POST because the Connection
   * exact-Fetch registry admits GET/HEAD/POST only — a PUT would fall through
   * to the shared channel's 404.
   */
  setMode(sessionId: string, enabled: boolean): Promise<ModeValue> {
    return request<ModeValue>(`${ROUTE_PREFIX}/mode`, {
      method: 'POST',
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
