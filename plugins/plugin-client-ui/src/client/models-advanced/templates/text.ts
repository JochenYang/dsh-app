/** Locale-aware access to the template catalog's text fields.
 *
 * The catalog keeps English as its source text so the data stays readable and
 * comparable; entries whose Chinese copy differs carry an `i18n` map of
 * dictionary keys (`tpl.<id>.<field>`) that this module resolves through the
 * caller's `t`.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/templates/text
 */

import type { AdvancedModelsKey } from '../locales.ts'
import type { Translate } from '../messages.ts'
import type { ProviderTemplate } from './types.ts'

/** The template fields the catalog can localize. */
type TextField = 'label' | 'displayName' | 'note'

/**
 * Resolve one catalog text field for the active language.
 * @param template - the preset.
 * @param field - which text field.
 * @param t - the page's translate seat.
 * @returns the localized text, or the catalog's own English source.
 */
export function templateField(
  template: ProviderTemplate | null | undefined,
  field: TextField,
  t: Translate,
): string {
  if (template === null || template === undefined) return ''
  const key = template.i18n?.[field]
  if (typeof key === 'string') {
    const text = t(key as AdvancedModelsKey)
    if (text !== key) return text
  }
  return template[field] ?? ''
}

/** The preset's picker text. */
export function templateLabel(template: ProviderTemplate, t: Translate): string {
  return templateField(template, 'label', t)
}

/** The provider display name the preset creates. */
export function templateDisplayName(template: ProviderTemplate, t: Translate): string {
  return templateField(template, 'displayName', t)
}
