/**
 * The provider template catalog: curated presets first, long tail second.
 *
 * Ported from dsh-provider-studio v1.3.1 (MIT); the directory data behind it is
 * models.dev (MIT). See `templates/types.ts` for the field contract.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/templates
 */

import { CURATED_TEMPLATES } from './curated.ts'
import { MORE_TEMPLATES } from './more.ts'
import type { ProviderTemplate } from './types.ts'

/** Every preset the picker can offer. */
export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = CURATED_TEMPLATES.concat(MORE_TEMPLATES)

/** The "custom provider" card: no preset, everything typed by hand. */
export const CUSTOM_TEMPLATE: ProviderTemplate = {
  id: 'custom',
  label: '',
  displayName: '',
  group: 'groupCommon',
  api: 'openai-completions',
  baseURL: '',
}
