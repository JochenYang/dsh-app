/**
 * DSH APP brand client plugin (browser side).
 *
 * Loaded by the dsh web client composition through the `dsh.client` metadata
 * in package.json. Registers the brand theme and the Advanced Models settings
 * page (model-level fields the official Models page leaves to settings.yaml);
 * the upstream Models page stays untouched. The conversation minimap was
 * retired: the upstream turn rail (ui-chat TurnNavigator) covers the same
 * right-edge turn navigation with full-history paging.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: loads the theme plugin's Context merge (ctx.theme), the slots
// service face (ctx.slots), and the slot utility prop faces into this
// compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls the connection Events merge ('connection/reset') into scope.
import type {} from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) and the settingsScope/settingsSchema Context merges.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AdvancedModelsSection } from './client/models-advanced/section.tsx'
import type { AdvancedModelsInjected } from './client/models-advanced/section.tsx'
import { AdvancedModelsStore } from './client/models-advanced/store.ts'
import type { AdvancedModelsState } from './client/models-advanced/store.ts'
import { DiagnosticsSection } from './client/diagnostics/section.tsx'
import { en as diagnosticsEn, zh as diagnosticsZh } from './client/diagnostics/locales.ts'
import type { DiagnosticsKey } from './client/diagnostics/locales.ts'
import { en as advancedEn, zh as advancedZh } from './client/models-advanced/locales.ts'
import type { AdvancedModelsKey } from './client/models-advanced/locales.ts'
import { NS } from './client/namespace.ts'
import { mountSettingsNav } from './client/settings-nav.ts'
import { installWorkspaceLaunch } from './client/workspace-launch.ts'
import { mountWhaleBackground } from './client/whale-background.ts'
import type { SettingsDescribeFace, SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/client'

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// any dictionary of the pair fails this package's typecheck, and the same
// union constrains each page's `t` seat. One namespace carries both page
// dictionaries; their `diag.` / `adv.` key prefixes keep them apart.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Brand client-plugin copy: the diagnostics page and the Advanced Models page. */
    [NS]: DiagnosticsKey | AdvancedModelsKey
  }
}

// The Advanced Models store talks to the `llm` and `settings` Remote domains
// directly (provider directory + discovery, settings.mutate), so those nested
// namespace services must be declared here — Cordis refuses `remote.*` access
// that is not in this plugin's `inject`.
export const inject = [
  'theme', 'slots', 'locale', 'remote', 'remote.llm', 'remote.settings', 'settingsScope', 'settingsSchema',
]

export const BRAND_THEME_ID = 'dsh-app-brand'

/** Nav identity of the Advanced Models page (its label is the `adv.nav` key). */
const ADVANCED_SECTION_ID = 'model-advanced'

/** Nav identity of the diagnostics page (its label is the `diag.nav` key). */
const DIAGNOSTICS_SECTION_ID = 'dsh-app-diagnostics'

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
 * A wireframe isometric cube for the Advanced Models row (upstream maps its own
 * section ids to icons and falls back to a generic gear for everything else).
 * Hexagonal silhouette + three inner edges on the same 16-grid the shell's icon
 * set uses (their glyphs fill ~86% of it; ours ~82% — visually matched).
 */
const NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<path d="M8 1.8 2.2 5.2v6.8L8 15.4l5.8-3.4V5.2L8 1.8zM2.2 5.2 8 8.6l5.8-3.4M8 8.6v6.8"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')

/**
 * A heartbeat line for the Diagnostics row: the same 16-grid and 1.4 stroke as
 * the rest of the set, and one recognizable gesture at 16 px — the page it
 * opens is a status readout plus a log tail, which a monitor/wrench glyph
 * would only muddy at this size.
 */
const NAV_ICON_DIAGNOSTICS_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  '<path d="M1.6 8.6h3.1l1.5-4.4 2.2 7.6 1.6-3.2h4.4"',
  ' fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')

export function apply(ctx: ClientContext): void {
  // --- Dictionaries first: every seat below resolves through this namespace,
  // and the effect disposes the pair with this plugin's fiber. Both page
  // dictionaries register in one call — one namespace per plugin, one pair
  // per namespace. ---
  ctx.effect(
    () => ctx.locale.register(NS, {
      zh: { ...diagnosticsZh, ...advancedZh },
      en: { ...diagnosticsEn, ...advancedEn },
    }),
    'dsh-app plugin-client-ui: dictionaries',
  )
  // Nav rows are read per render and the settings shell keys its row cache on
  // the locale revision, so a thunk over this binding follows a language
  // switch without re-registration — the same contract as the `t` seat.
  const t = ctx.locale.bind(NS)

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

  // --- Advanced Models settings page: model-level fields (reasoning
  // efforts, input modalities, compat switches) the official page leaves to
  // settings.yaml, plus a guarded create flow for out-of-catalog models. ---
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
  // The page talks through the Remote domains directly (the client `api`
  // connection face was removed upstream in dsh 0.1.2): `ctx.remote`
  // satisfies the store's advanced-models remote shape structurally, and the
  // injected `api` field carries the same face so editors can call it.
  const controller = new AdvancedModelsStore(
    ctx.remote,
    schema,
    ctx.settingsScope.describe() as SettingsDescribeFace,
  )
  const injected = (): AdvancedModelsInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    api: ctx.remote,
    schema,
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: ADVANCED_SECTION_ID,
    // 11 = directly after the official Models page (10); the Plugins page
    // owns 15 and agent-presets 20.
    order: 11,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: NS,
    label: () => t('adv.nav'),
    inject: injected,
  }, AdvancedModelsSection))

  // --- Diagnostics page: desktop-bridge status, the shell's log directory and
  // the kernel log tail. Two host routes of plugin-brand, no new transport. ---
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: DIAGNOSTICS_SECTION_ID,
    // 22 = after the agent band (19-21), before the session-data trio
    // (23 = memory, 24 = archives, 25 = upstream's archived sessions): the
    // system-level page belongs at the tail. NOT 14: plugin-websearch already
    // holds 14, and a tie is only "harmless" while the loader keeps
    // registration order — a placement hint should not double as an identity.
    order: 22,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: NS,
    label: () => t('diag.nav'),
  }, DiagnosticsSection))

  // --- Launch folder: the shell may be started with a directory (open-with, a
  // folder dropped on the app icon, a path argument). It cannot register a
  // workspace itself, so it calls the global this installs — the only seam
  // available between a preload-less renderer and the shell. ---
  ctx.effect(() => installWorkspaceLaunch(ctx), 'dsh-app plugin-client-ui: launch folder')

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
    // Settings rail: the scroll rule the suite's extra rows need, plus real
    // glyphs for our two pages (upstream would give both the generic gear).
    const disposeNav = mountSettingsNav([
      { label: () => t('adv.nav'), cls: 'dshAmaAdvNav', svg: NAV_ICON_SVG },
      { label: () => t('diag.nav'), cls: 'dshDiagNav', svg: NAV_ICON_DIAGNOSTICS_SVG },
    ])
    // Brand whale background: Canvas 2D port of the DeepSeek hero digitile
    // whale (assembles on load, swims idly, scatters from the pointer),
    // theme-aware through the live --dsw-alias-* tokens.
    const disposeWhale = mountWhaleBackground()
    return () => {
      disposeNav()
      disposeWhale()
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-app plugin-client-ui: advanced models invalidations + nav icon + whale background')
}
