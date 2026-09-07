/**
 * DSH APP hooks bridge — client half.
 * Registers the "Hooks" settings section (order 13) + nav icon.
 * @module @dsh-app/plugin-hooks/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { HooksSection } from './client/hooks-section.tsx'
import { mountNavIconPatch } from './client/nav-icon.ts'
import { adoptStyles } from './client/styles.ts'

export const inject = ['slots']
const SECTION_ID = 'dsh-app-hooks'
const SECTION_LABEL = 'Hooks'

export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => mountNavIconPatch(), 'dsh-app plugin-hooks: nav icon patch')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 13,
    label: () => SECTION_LABEL,
  }, HooksSection))
}
