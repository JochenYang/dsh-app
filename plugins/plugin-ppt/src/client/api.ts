/**
 * Typed client for the PPT-mode host routes. Same-origin fetch against the
 * Connection `/api` channel the window's own origin serves; the carrier's
 * trust fence and browser authentication run before the route handler.
 *
 * @module @dsh-app/plugin-ppt/client/api
 */

import type { OfficeActive } from '../office-active.ts'
import { OFFICE_ACTIVE_FORMAT } from '../office-format.ts'
import { notifyOfficeActiveChanged } from './office-active-event.ts'

/**
 * The plugin's route prefix on the shared `/api` channel (mirrors the host
 * half; the Connection registry admits no `@` in a path segment, so the npm
 * scope travels as `dsh-app`).
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-ppt'

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
 * (`null` = 常规主题, the neutral default), the colour source for the deck, and
 * when the entry was written.
 */
export interface ModeValue {
  readonly enabled: boolean
  readonly template: string | null
  /** Brand colour `#RRGGBB`, or null when the deck uses a colourway/template palette. */
  readonly brand?: string | null
  /** Colourway id from the catalog's `palettes`, or null. */
  readonly palette?: string | null
  readonly updatedAt: number | null
}

/**
 * POST /mode body: turn the mode on with a template (or none), or off.
 *
 * `brand` / `palette` are OPTIONAL on purpose: the template switcher sends
 * `template` alone and the host keeps whatever colour the session already had.
 * Sending `null` clears explicitly.
 */
export interface ModeUpdate {
  readonly enabled: boolean
  readonly template: string | null
  readonly brand?: string | null
  readonly palette?: string | null
}

/**
 * One colourway as the picker needs it (host `PALETTE_PRESETS` row).
 *
 * The panel renders the six colours as a swatch strip rather than a single dot: a
 * colourway is a relationship between paper, ink and accent, and one dot cannot
 * show that the ink is warm on a cold paper.
 */
export interface PalettePresetView {
  readonly id: string
  readonly name: string
  readonly nameEn: string
  readonly family: string
  readonly scheme: string
  readonly colors: Readonly<Record<string, string>>
  /** Accent against background. Below 3 means the accent is a block, not an ink. */
  readonly accentOnBackground: number
}

/** The PPT-mode API face. */
export const pptModeApi = {
  mode(sessionId: string): Promise<ModeValue> {
    return request<ModeValue>(`${ROUTE_PREFIX}/mode?sessionId=${encodeURIComponent(sessionId)}`)
  },
  /**
   * Toggle the mode. POST because the Connection exact-Fetch registry admits
   * GET/HEAD/POST only — a PUT would fall through to the shared channel's 404.
   */
  setMode(sessionId: string, update: ModeUpdate): Promise<ModeValue> {
    return request<ModeValue>(`${ROUTE_PREFIX}/mode`, {
      method: 'POST',
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
  templates(options?: { covers?: boolean }): Promise<{ templates: readonly TemplateView[], palettes: readonly PalettePresetView[] }> {
    const covers = options?.covers === false ? '?covers=0' : ''
    return request<{ templates: readonly TemplateView[], palettes: readonly PalettePresetView[] }>(`${ROUTE_PREFIX}/templates${covers}`)
  },
}
