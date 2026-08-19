/**
 * DSH App brand client plugin (browser side).
 *
 * Loaded by the dsh web client composition through the `dsh.client` metadata
 * in package.json. Pattern verified against @deepseek-ai/dsh-client-ui-theme
 * and @deepseek-ai/dsh-client-ui-workspace:
 *
 *   - `inject` lists the service names this plugin needs on ctx;
 *   - `apply(ctx)` registers slots / theme / locale entries.
 *
 * The theme registration below is REAL and follows the ui-theme API
 * (ThemeDefinition: id + colorScheme + --dsw-alias-* token overrides).
 * The slot registrations are scaffolds with the exact slot names from the
 * upstream READMEs; each needs its component/store finished in the dev loop
 * (see README.md for the mapping table).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { BrandModelsStore } from './client/models-store.ts'
import { BrandModelsSection, type BrandModelsSectionInjected } from './client/ModelsSection.tsx'

export const inject = ['theme', 'slots', 'connection', 'remote']

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

  // --- Brand Models page: replaces the upstream `models` settings section.
  //     The shell's loader overlay disables the upstream ui-settings-models
  //     entry and inserts this plugin, so the `models` id is registered
  //     exactly once (a priority shadow would duplicate the nav row: the
  //     settings nav rail projects the raw slot ledger, not the shadowed
  //     render view). ---
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new BrandModelsStore(connection.api)
  const useSnapshot = bindSnapshotSelector(controller.store)
  const injected = (): BrandModelsSectionInjected => ({
    controller,
    useSnapshot,
    api: connection.api,
  })
  ctx.effect(() => {
    const refresh = (): void => {
      if (controller.store.getSnapshot().status === 'idle') return
      void controller.load()
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.remote.$on('credentials/updated', refresh),
      ctx.remote.$on('llm/adapters-updated', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-app-client-ui: models invalidations')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => '模型',
    inject: injected,
  }, BrandModelsSection))

  // ------------------------------------------------------------------
  // Enhancement scaffolds — each TODO needs its component + store wired in
  // the dev loop against the running web UI. Slot names below come from the
  // upstream READMEs (ui-workspace: `sidebar.workspaces`,
  // session-log-export: `conversation.session.header.utilities`); verify
  // chain/keyed semantics at runtime before finalizing.
  // ------------------------------------------------------------------

  // 1. Workspace file panel (right sidebar): file tree, file count, git
  //    branch summary, @path insertion. Requires git info from the host
  //    bridge (see plugin-brand) + ui-workspace slot analysis.
  // ctx.slots.register({
  //   name: 'sidebar.workspaces',
  //   id: 'dsh-app-file-panel',
  //   order: 100,
  // }, WorkspaceFilePanel)

  // 2. Reminder summary in Session hover: active reminder count + most
  //    recent time, from the schedule service (packages/schedule).
  // ctx.slots.register({
  //   name: 'conversation.session.hover.detail', // verify exact slot id
  //   id: 'dsh-app-reminder-summary',
  //   order: 50,
  // }, ReminderSummary)

  // 3. Trajectory toolbar export: reuse the /export ZIP endpoint
  //    (dsh-session-log-export) from the trajectory toolbar.
  // ctx.slots.register({
  //   name: 'trajectory.toolbar', // verify exact slot id
  //   id: 'dsh-app-export-zip',
  //   order: 10,
  // }, TrajectoryExportButton)

  // 4. Model catalog badges: multimodal / capability markers on provider
  //    rows and the model selector (ui-settings-models + ui-model-selection).
  // ctx.slots.register({
  //   name: 'settings.models.row', // verify exact slot id
  //   id: 'dsh-app-model-capabilities',
  //   order: 10,
  // }, ModelCapabilityBadges)
}
