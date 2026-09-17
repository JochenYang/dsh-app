/**
 * DSH APP cross-session memory — host half (topic-card model).
 *
 * Mounts five things over one two-level root
 * (`$DSH_HOME/storages/dsh-app-plugin-memory`):
 *
 * 1. a system-prompt section whose text is a per-assembly provider —
 *    saving guidelines plus the LIVE global and current-project indexes
 *    and selected cards (resolved from the assembling agent's session cwd;
 *    bounded, see prompt.ts), so a mid-session memory_save is visible to
 *    the next turn;
 * 2. three LLM tools, `memory_save` / `memory_recall` / `memory_forget`
 *    (model-driven proactive saving with upsert semantics; project routing
 *    comes from the executing agent's session cwd, never from model input);
 * 3. the background distiller (see distiller.ts): after a session goes
 *    quiet, one direct LLM call reviews the conversation delta and proposes
 *    cards the host validates before writing — the code-guaranteed half of
 *    proactive memory;
 * 4. the maintenance pair: the LIGHT sweep (see light-sweep.ts) runs after
 *    every persisted write with no model call (exact-dup merge, similarity
 *    suspects, index parity), and the heavy CURATOR (see curator.ts) sweeps
 *    under cooldown/threshold gates to merge near-duplicate topics and prune
 *    stale cards. Both passes mount only when the agents + llm services are
 *    available (graceful on kernels without them);
 * 5. settings-page routes (status/toggle/pin/clear) for the client half.
 *
 * Boot migration: a store still holding the pre-card `memory.md` timeline is
 * converted to topic cards deterministically (see MemoryStore.migrateLegacy)
 * and the old file kept as `memory.legacy.md`.
 *
 * The user's exit valve is `<storeDir>/config.json` (`enabled: false`, the
 * same discipline as plugin-usage): a disabled plugin mounts nothing but
 * its status route, and the toggle set through the settings page takes
 * effect on the next prompt assembly — no restart. A second field
 * (`distill: false`) disables only the background passes.
 *
 * Stability discipline: zero global side effects; a kernel without the
 * consumed services never mounts anything.
 *
 * @module @dsh-app/plugin-memory
 */

import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the tools Context merge (ctx.tools) into scope.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the systemPrompt Context merge (ctx.systemPrompt) and the
// AssembleContext.agent augmentation into scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryRoot, type MemoryStore } from './memory-store.ts'
import { MemoryDistiller } from './distiller.ts'
import { MemoryCurator } from './curator.ts'
import { lightSweep } from './light-sweep.ts'
import { renderMemoryText } from './prompt.ts'
import { registerMemoryRoutes } from './routes.ts'
import { registerMemoryTools } from './tools.ts'

export const name = 'plugin-memory'

/**
 * The settings routes ride the Connection exact-Fetch registry
 * (`ctx.connection.fetch`). The web server is deliberately NOT injected: the
 * desktop host disables its `webserver` row, so a plugin that waits for it
 * never activates at all.
 */
export const inject = ['connection', 'tools', 'systemPrompt']

/** Config: storage location. */
export interface Config {
  /** Absolute store directory; empty → $DSH_HOME/storages/dsh-app-plugin-memory. */
  storePath: string
}

export const Config: z<Config> = z.object({
  storePath: z.string().default(''),
})

/** Tool-guidance section order (upstream convention: 100–199). */
const PROMPT_SECTION_ORDER = 118

/** The scope label the light sweep / curator logs and state key by. */
function scopeLabel(root: MemoryRoot, store: MemoryStore): string {
  return store.dir === root.dir ? 'global' : basename(store.dir)
}

/**
 * Host apply: mount prompt injection + tools + routes, unless disabled by
 * the user config file (the coexistence exit valve).
 * @param ctx - the host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-memory')
  const root = new MemoryRoot(dir)

  // Boot migration: convert any legacy memory.md timeline into topic cards.
  // Deterministic (no model), idempotent, and the legacy file is kept as
  // memory.legacy.md; a failure leaves the store untouched for the next boot.
  root.migrateAll(log)

  if (!root.global.isEnabled()) {
    log.info(`memory plugin: disabled by user config (${join(dir, 'config.json')})`)
    ctx.effect(() => registerMemoryRoutes(ctx.connection.fetch, root), 'plugin-memory: settings routes (disabled)')
    return
  }

  // Provider evaluated on every assembly: guidelines + the live global and
  // current-project indexes/cards, honoring the toggle without a restart.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:memory',
    order: PROMPT_SECTION_ORDER,
    text: context => renderMemoryText(root, context.agent?.session.header.cwd),
  }), 'plugin-memory: system prompt section')

  // The direct-save path's maintenance trigger. Tools mount regardless of the
  // agents/llm seam (below), so the curator half of the callback is a
  // late-bound holder: a kernel without those services still gets the free
  // light sweep, and memory_save keeps working.
  let requestCurate: ((parent: NonNullable<ReturnType<Context['agents']['get']>>, sessionId: SessionId) => void) | undefined
  const onSaved = (
    parent: NonNullable<ReturnType<Context['agents']['get']>>,
    sessionId: SessionId,
    store: MemoryStore,
  ): void => {
    // Free maintenance first (no model): exact-dup merge + suspects + index.
    lightSweep(root, scopeLabel(root, store), store, log)
    requestCurate?.(parent, sessionId)
  }
  ctx.effect(() => registerMemoryTools(ctx, root, onSaved), 'plugin-memory: llm tools')
  ctx.effect(() => registerMemoryRoutes(ctx.connection.fetch, root), 'plugin-memory: settings routes')

  // The background passes need the agents + llm services; on a kernel
  // without them (e.g. a rollback target) the plugin still mounts everything
  // else — only the async safety nets are absent. The distiller writes NEW
  // cards; a saved run hands the light sweep + curator the trigger (see
  // distiller.ts / curator.ts). Both call the model directly on the
  // triggering session's own route.
  ctx.inject(['agents', 'llm'], memCtx => {
    const curator = new MemoryCurator(memCtx, root, log)
    // The distill hands maintenance its save trigger with the session id and
    // the affected store: the light sweep runs inline; the heavy sweep runs
    // in the distill's own window, with further saves inside the cooldown
    // coalescing into one trailing sweep that re-resolves the session by id.
    const distiller = new MemoryDistiller(memCtx, root, log, (parent, sessionId, store) => {
      lightSweep(root, scopeLabel(root, store), store, log)
      return curator.runAfterDistill(parent, sessionId)
    })
    requestCurate = (parent, sessionId) => { void curator.runAfterDistill(parent, sessionId) }
    memCtx.effect(() => {
      const disposeDistiller = distiller.attach()
      const disposeCurator = curator.attach()
      return () => { disposeDistiller(); disposeCurator() }
    }, 'plugin-memory: background passes')
  })

  log.info(`memory root: ${dir}`)
}
