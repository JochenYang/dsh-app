/**
 * A provider's logo, or its initial when the packaged set carries no mark.
 *
 * Theme handling follows the ported set's own measurements:
 *   - SVG marks drawn in the neutral grey render through a CSS mask, so they
 *     take the theme's secondary text colour instead of a fixed grey that goes
 *     dim on the dark panel.
 *   - Rasters measured as near-black or near-white get a contrast plate, and
 *     self-contained app icons a separating ring; every other brand mark stays
 *     on the bare surface.
 *   - A raster measured with too much padding is scaled up, so every mark lands
 *     at the same optical size without re-encoding the asset.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/provider-mark
 */

import type { ReactNode } from 'react'
import {
  PROVIDER_ICON_FRAMES,
  PROVIDER_ICON_MONO,
  PROVIDER_ICON_RULES,
  PROVIDER_ICON_TONES,
  PROVIDER_ICONS,
} from './provider-icons.ts'
import { PROVIDER_TEMPLATES } from './templates/index.ts'
import type { ProviderTemplate } from './templates/types.ts'

/** Lowercase, letters and digits only — how ids and names are compared. */
function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

/**
 * The catalog preset a saved provider came from, if it can be recognized.
 *
 * A saved route id is often NOT the preset id (a user renames `zai` to
 * `zai-coding-cn`, or keeps `agnes-ai` while the preset is `agnes`), so the
 * endpoint and the display name are checked too. This is the same recognition
 * the source design does before falling back to its keyword table.
 *
 * @param item - the row's route id, display name and base URL.
 * @returns the preset, or undefined when nothing matches.
 */
/**
 * Whether a saved endpoint belongs to a preset's endpoint: same host, and the
 * preset path is a path prefix (not a substring). A raw `startsWith` on the
 * string would accept `api.deepseek.com.evil.example` and `/v1` matching `/v10`;
 * the logo is cosmetic, but a wrong mark still misidentifies the vendor.
 */
function sameEndpoint(base: string, templateBase: string): boolean {
  try {
    const saved = new URL(base)
    const preset = new URL(templateBase)
    if (saved.host !== preset.host) return false
    const trim = (path: string): string => path.replace(/\/+$/u, '')
    const wanted = trim(preset.pathname)
    if (wanted === '') return true
    const actual = trim(saved.pathname)
    return actual === wanted || actual.startsWith(`${wanted}/`)
  } catch {
    return false
  }
}

function templateFor(item: { readonly route?: string; readonly displayName?: string; readonly baseURL?: string }): ProviderTemplate | undefined {
  const route = (item.route ?? '').toLowerCase()
  const name = (item.displayName ?? '').toLowerCase()
  const base = item.baseURL ?? ''
  if (route === '' && name === '' && base === '') return undefined
  for (const template of PROVIDER_TEMPLATES) {
    if (route !== '' && route === template.id.toLowerCase()) return template
    if (base !== '' && template.baseURL !== '' && sameEndpoint(base, template.baseURL)) return template
    if (name.length >= 4) {
      for (const label of [template.displayName, template.label]) {
        const text = label.toLowerCase()
        if (text.length >= 4 && (name === text || name.includes(text))) return template
      }
    }
  }
  return undefined
}

/**
 * Match a provider to a packaged logo.
 *
 * The haystack is what a user sees and what the profile carries — route id,
 * display name and endpoint — because a gateway is as likely to name itself in
 * one as in another (`opencode`, `OpenCode Zen`, `https://opencode.ai/zen/v1`).
 * Order: the catalog preset it came from, then an icon key the id or name
 * spells out, then the keyword aliases for vendors whose names differ.
 *
 * @param item - the row's route id, display name and base URL.
 * @returns the icon key, or undefined when the set has no mark for it.
 */
export function iconForProvider(item: {
  readonly route?: string
  readonly displayName?: string
  readonly baseURL?: string
} | undefined): string | undefined {
  if (item === undefined || item === null) return undefined
  const route = item.route ?? ''
  const name = item.displayName ?? ''
  const haystack = `${route} ${name} ${item.baseURL ?? ''}`.toLowerCase()
  if (haystack.trim() === '') return undefined

  const template = templateFor(item)
  if (template?.icon !== undefined && PROVIDER_ICONS[template.icon] !== undefined) return template.icon

  // The packaged keys are vendor names (`groq`, `cerebras`, `copilot`, `zai`), so
  // an id that spells one out wins before any alias table does.
  const routeKey = normalized(route)
  const nameKey = normalized(name)
  for (const key of Object.keys(PROVIDER_ICONS)) {
    const candidate = normalized(key)
    if (candidate.length < 3) continue
    if (routeKey === candidate || nameKey === candidate) return key
  }
  for (const key of Object.keys(PROVIDER_ICONS)) {
    const candidate = normalized(key)
    if (candidate.length < 4) continue
    if (routeKey.includes(candidate) || nameKey.includes(candidate)) return key
  }
  for (const [key, needles] of PROVIDER_ICON_RULES) {
    if (needles.some(needle => haystack.includes(needle))) return key
  }
  return undefined
}

/** First letter of a provider name, for rows the set has no logo for. */
function monogram(label: string): string {
  const match = label.trim().match(/[\p{L}\p{N}]/u)
  return match === null ? '' : match[0].toUpperCase()
}

/** Props of {@link ProviderMark}. */
export interface ProviderMarkProps {
  /** Logo key from {@link iconForProvider}. */
  readonly iconKey?: string
  /** The provider's display name, for the monogram fallback. */
  readonly label: string
  /** Square footprint in px (22 in a list row, 30 in a detail header). */
  readonly size?: number
}

/**
 * Render one provider mark.
 * @param props - see {@link ProviderMarkProps}.
 * @returns the mark.
 */
export function ProviderMark({ iconKey, label, size = 22 }: ProviderMarkProps): ReactNode {
  const src = iconKey === undefined ? undefined : PROVIDER_ICONS[iconKey]
  const box = { width: size, height: size }
  if (iconKey !== undefined && src !== undefined) {
    if (PROVIDER_ICON_MONO.has(iconKey)) {
      return (
        <span className="dshAma-mark" style={box} aria-hidden="true">
          <span
            className="dshAma-markMask"
            style={{ ...box, maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")` }}
          />
        </span>
      )
    }
    const tone = PROVIDER_ICON_TONES[iconKey]
    const plate = tone === 'onLight' ? ' is-onLight' : tone === 'onDark' ? ' is-onDark' : tone === 'solid' ? ' is-solid' : ''
    const frame = PROVIDER_ICON_FRAMES[iconKey]
    const transform = frame === undefined
      ? undefined
      : `scale(${frame.scale}) translate(${frame.x}%, ${frame.y}%)`
    return (
      <span className={`dshAma-mark${plate}`} style={box} aria-hidden="true">
        <img
          src={src} alt="" width={size} height={size}
          style={transform === undefined ? undefined : { transform }}
        />
      </span>
    )
  }
  const initial = monogram(label)
  return (
    <span className="dshAma-mark dshAma-markFallback" style={box} aria-hidden="true">
      <span className="dshAma-markInitial" style={{ fontSize: Math.max(10, Math.round(size * 0.46)) }}>
        {initial}
      </span>
    </span>
  )
}
