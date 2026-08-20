/**
 * DSH App brand client plugin (browser side).
 *
 * Loaded by the dsh web client composition through the `dsh.client` metadata
 * in package.json. Currently registers only the brand theme; the upstream
 * Models settings page (ui-settings-models) is left untouched.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime'

export const inject = ['theme']

export const BRAND_THEME_ID = 'dsh-app-brand'

/**
 * Brand theme: a dark-first variant built on the alias-token layer.
 * Every override must supply both light and dark values (ThemeTokenModes)
 * so the theme stays legible under either system scheme.
 */
const BRAND_TOKENS = {
  '--dsw-alias-brand-primary': {
    light: 'rgb(59, 130, 246)',
    dark: 'rgb(96, 165, 250)',
  },
  '--dsw-alias-bg-base': {
    light: 'rgb(248, 250, 252)',
    dark: 'rgb(13, 18, 32)',
  },
  '--dsw-alias-bg-layer-1': {
    light: 'rgb(255, 255, 255)',
    dark: 'rgb(22, 29, 47)',
  },
  '--dsw-alias-bg-layer-2': {
    light: 'rgb(241, 245, 249)',
    dark: 'rgb(30, 39, 61)',
  },
  '--dsw-alias-bg-overlay': {
    light: 'rgb(255, 255, 255)',
    dark: 'rgb(38, 48, 74)',
  },
  '--dsw-alias-border-l1': {
    light: 'rgba(15, 23, 42, 0.06)',
    dark: 'rgba(148, 163, 184, 0.14)',
  },
  '--dsw-alias-border-l2': {
    light: 'rgba(15, 23, 42, 0.1)',
    dark: 'rgba(148, 163, 184, 0.22)',
  },
  '--dsw-alias-label-primary': {
    light: 'rgb(15, 23, 42)',
    dark: 'rgb(230, 235, 245)',
  },
  '--dsw-alias-label-secondary': {
    light: 'rgb(71, 85, 105)',
    dark: 'rgb(139, 151, 176)',
  },
} as const

export function apply(ctx: ClientContext): void {
  // --- Brand theme (selectable in Settings → Appearance). ---
  ctx.theme.register({
    id: BRAND_THEME_ID,
    colorScheme: 'dark',
    tokens: Object.fromEntries(
      Object.entries(BRAND_TOKENS).map(([name, modes]) => [name, modes.dark]),
    ),
  })
  ctx.theme.register({
    id: `${BRAND_THEME_ID}-light`,
    colorScheme: 'light',
    tokens: Object.fromEntries(
      Object.entries(BRAND_TOKENS).map(([name, modes]) => [name, modes.light]),
    ),
  })
}
