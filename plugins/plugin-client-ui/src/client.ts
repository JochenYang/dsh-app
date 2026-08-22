/**
 * DSH APP brand client plugin (browser side).
 *
 * Loaded by the dsh web client composition through the `dsh.client` metadata
 * in package.json. Registers the brand theme, the conversation minimap, and
 * the Advanced Models settings page (model-level fields the official Models
 * page leaves to settings.yaml); the upstream Models page stays untouched.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: loads the theme plugin's Context merge (ctx.theme) and the
// slot utility prop faces (ctx.slots) into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) and the settingsScope/settingsSchema Context merges.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { MinimapUtility } from './client/minimap.tsx'
import { AdvancedModelsSection } from './client/models-advanced/section.tsx'
import type { AdvancedModelsInjected } from './client/models-advanced/section.tsx'
import { AdvancedModelsStore } from './client/models-advanced/store.ts'
import type { AdvancedModelsState } from './client/models-advanced/store.ts'
import type { SettingsDescribeFace, SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/client'

export const inject = ['theme', 'slots', 'connection', 'remote', 'settingsScope', 'settingsSchema']

export const BRAND_THEME_ID = 'dsh-app-brand'

/** Nav identity of the Advanced Models page. */
const ADVANCED_SECTION_ID = 'model-advanced'
const ADVANCED_SECTION_LABEL = '模型高级设置'

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

/**
 * A wireframe isometric cube for the settings nav (the shell maps unknown
 * section ids to its generic gear; this overlay swaps ours in by label
 * match). Hexagonal silhouette + three inner edges on the same 16-grid the
 * shell's icon set uses (their glyphs fill ~86% of it; ours ~82% — visually
 * matched); rendered as a CSS mask over currentColor so it follows the
 * nav's active state.
 */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<path d="M8 1.8 2.2 5.2v6.8L8 15.4l5.8-3.4V5.2L8 1.8zM2.2 5.2 8 8.6l5.8-3.4M8 8.6v6.8"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')

/**
 * Tag the Advanced Models nav cell and paint the brand glyph. The nav has no
 * per-id DOM hook (CSS-module class names are stable in name only), so the
 * cell is found by its label text — the same stable-copy contract the shell
 * itself renders — and tagged with a plain class the style rule targets.
 */
function mountNavIconPatch(): () => void {
  const style = document.createElement('style')
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(NAV_ICON_SVG)}")`
  style.textContent = [
    'button.dshAmaAdvNav > svg:first-child { display: none; }',
    'button.dshAmaAdvNav::before {',
    '  content: ""; width: 16px; height: 16px; flex: none;',
    `  background-color: currentColor; -webkit-mask-image: ${maskUrl}; mask-image: ${maskUrl};`,
    '  mask-size: contain; mask-repeat: no-repeat; mask-position: center;',
    '}',
  ].join('\n')
  document.head.append(style)
  const patch = (): void => {
    // Cheap gate first: without a settings nav in the DOM there is nothing
    // to tag, and chat-view mutations must not pay for a label scan.
    if (document.querySelector('[class*="navList"]') === null) return
    for (const label of document.querySelectorAll('span[class*="navLabel"]')) {
      if (label.textContent !== ADVANCED_SECTION_LABEL) continue
      const cell = label.closest('button')
      if (cell !== null) cell.classList.add('dshAmaAdvNav')
    }
  }
  patch()
  const observer = new MutationObserver(patch)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    style.remove()
    for (const cell of document.querySelectorAll('button.dshAmaAdvNav')) {
      cell.classList.remove('dshAmaAdvNav')
    }
  }
}

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

  // --- Conversation minimap: hover to preview, click to jump to a past
  // user message. Session-scoped, so it follows session switches; renders
  // nothing while the chat view has fewer than two messages. ---
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-app-minimap',
    order: 100,
  }, MinimapUtility))

  // --- Advanced Models settings page: model-level fields (reasoning
  // efforts, input modalities, compat switches) the official page leaves to
  // settings.yaml, plus a guarded create flow for out-of-catalog models. ---
  const connection = ctx.get('connection') as ConnectionHandle
  const schemaService = ctx.settingsSchema as SettingsSchemaService
  // Bound method references keep the service's own signatures (the store's
  // SchemaOps type is a Pick of the service); hand-written wrappers would
  // widen parameters the schema types refuse.
  const schema = {
    rehydrate: schemaService.rehydrate.bind(schemaService),
    validate: schemaService.validate.bind(schemaService),
    nodeAtPath: schemaService.nodeAtPath.bind(schemaService),
    getPath: schemaService.getPath.bind(schemaService),
    hasPath: schemaService.hasPath.bind(schemaService),
    setPath: schemaService.setPath.bind(schemaService),
    deletePath: schemaService.deletePath.bind(schemaService),
  }
  const controller = new AdvancedModelsStore(
    connection.api,
    schema,
    ctx.settingsScope.describe() as SettingsDescribeFace,
  )
  const injected = (): AdvancedModelsInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    api: connection.api,
    schema,
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: ADVANCED_SECTION_ID,
    // 11 = directly after the official Models page (10); the Plugins page
    // owns 15 and agent-presets 20.
    order: 11,
    label: () => ADVANCED_SECTION_LABEL,
    inject: injected,
  }, AdvancedModelsSection))

  // Pushed invalidations keep an OPEN page fresh without polling; an unopened
  // one stays idle (the section loads itself on first mount). Credential
  // changes surface here only through the settings/adapter events they cause.
  ctx.effect(() => {
    const refresh = (): void => {
      const snapshot = controller.store.getSnapshot() as AdvancedModelsState
      if (snapshot.status === 'idle') return
      void controller.load()
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    const disposeIcon = mountNavIconPatch()
    return () => {
      disposeIcon()
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-app plugin-client-ui: advanced models invalidations + nav icon')
}
