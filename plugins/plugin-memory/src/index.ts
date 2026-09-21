/**
 * DSH APP cross-session memory — host half (topic-card model).
 *
 * Mounts four things over one two-level root
 * (`$DSH_HOME/storages/dsh-app-plugin-memory`):
 *
 * 1. a system-prompt section whose text is a per-assembly provider —
 *    saving guidelines plus the LIVE current-project index and selected cards
 *    (resolved from the assembling agent's session cwd; bounded, see
 *    prompt.ts), so a mid-session memory_save is visible to the next turn.
 *    The retired root-level scope injects nothing;
 * 2. three LLM tools, `memory_save` / `memory_recall` / `memory_forget`
 *    (model-driven proactive saving with upsert semantics; the project comes
 *    from the executing agent's session cwd, never from model input, and a
 *    session without a workspace has no scope at all);
 * 3. the maintenance pair: the LIGHT sweep (see light-sweep.ts) runs after
 *    every persisted write with no model call (exact-dup merge, similarity
 *    suspects, index parity), and the heavy CURATOR (see curator.ts) sweeps
 *    under cooldown/threshold gates to merge near-duplicate topics and prune
 *    stale cards. Both are triggered by the WRITE path (a memory_save that
 *    actually changed something) and mount only when the agents + llm
 *    services are available (graceful on kernels without them);
 * 4. settings-page routes (status/toggle/pin/clear) for the client half.
 *
 * What is deliberately NOT mounted any more: session-driven EXTRACTION. Its
 * pass read a quiet session's conversation and proposed cards, and a session
 * with no workspace had its cards written to the global scope — which was
 * then injected into every project's sessions. Measured in practice, that
 * put one workspace's research conclusions into all of them. Memory is now
 * what the model decides to keep through `memory_save`, into the memory of
 * the project it is working in; nothing subscribes to the session event feed.
 *
 * Boot migrations, in order: a store still holding the pre-card `memory.md`
 * timeline is converted to topic cards deterministically (see
 * MemoryStore.migrateLegacy, kept as `memory.legacy.md`), and the cards of
 * the retired global scope are moved into `projects/legacy-global/` so the
 * user still sees and can delete them (MemoryRoot.migrateAll owns the order).
 *
 * The user's exit valve is `<storeDir>/config.json` (`enabled: false`, the
 * same discipline as plugin-usage): a disabled plugin mounts nothing but
 * its status route, and the toggle set through the settings page takes
 * effect on the next prompt assembly — no restart. A second field
 * (`distill: false`, named for the pass it used to gate) disables only the
 * background maintenance passes.
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
import { MemoryCurator } from './curator.ts'
import { lightSweep } from './light-sweep.ts'
import { renderMemoryText } from './prompt.ts'
import { registerMemoryRoutes } from './routes.ts'
import { registerMemoryTools } from './tools.ts'
import type { MemoryCurateResult } from './types.ts'

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
export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = ctx.logger(name)
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-memory')
  const root = new MemoryRoot(dir)

  // Boot migrations, one entry point: any legacy memory.md timeline becomes
  // topic cards, and the retired global scope's cards move into a project
  // directory the user can see and delete (MemoryRoot.migrateAll owns the
  // order). Deterministic (no model), idempotent, and a failure leaves the
  // store untouched for the next boot.
  await root.migrateAll(log)

  if (!root.global.isEnabled()) {
    log.info(`memory plugin: disabled by user config (${join(dir, 'config.json')})`)
    ctx.effect(() => registerMemoryRoutes(ctx.connection.fetch, root), 'plugin-memory: settings routes (disabled)')
    return
  }

  // Provider evaluated on every assembly: guidelines + the live current-project
  // index/cards, honoring the toggle without a restart.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:memory',
    order: PROMPT_SECTION_ORDER,
    text: context => renderMemoryText(root, context.agent?.session.header.cwd),
  }), 'plugin-memory: system prompt section')

  // The write path's maintenance trigger. Tools mount regardless of the
  // agents/llm seam (below), so the curator half of the callback is a
  // late-bound holder: a kernel without those services still gets the free
  // light sweep, and memory_save keeps working.
  let requestCurate: ((parent: NonNullable<ReturnType<Context['agents']['get']>>, sessionId: SessionId) => void) | undefined
  // The settings page's "curate now" button rides the same late-binding: these
  // routes mount before (and without) the agents/llm seam that owns the
  // curator, so until it exists the hook answers `unavailable` — a coded
  // sentence the page renders instead of a silent success.
  let curateNow: ((slug: string) => Promise<MemoryCurateResult>) | undefined
  const hookCurateNow = async (slug: string): Promise<MemoryCurateResult> => curateNow === undefined
    ? { status: 'unavailable', merged: 0, deleted: 0, rewritten: 0, refused: 0 }
    : await curateNow(slug)
  const onSaved = async (
    parent: NonNullable<ReturnType<Context['agents']['get']>>,
    sessionId: SessionId,
    store: MemoryStore,
  ): Promise<void> => {
    // Free maintenance first (no model): exact-dup merge + suspects + index.
    await lightSweep(root, scopeLabel(root, store), store, log)
    requestCurate?.(parent, sessionId)
  }
  ctx.effect(() => registerMemoryTools(ctx, root, onSaved), 'plugin-memory: llm tools')
  ctx.effect(() => registerMemoryRoutes(ctx.connection.fetch, root, { curateNow: hookCurateNow }), 'plugin-memory: settings routes')

  // The background maintenance pass needs the agents + llm services; on a
  // kernel without them (e.g. a rollback target) the plugin still mounts
  // everything else — only the async safety net is absent. The curator only
  // CONSOLIDATES memory that a memory_save already wrote; it calls the model
  // directly on the route of the session whose save triggered it.
  //
  // Nothing subscribes to the session event feed: extraction from a
  // conversation is retired for good. Its turn/end subscription was what
  // armed a quiet-timer model call, and a session without a workspace had its
  // cards written to the global scope — which was then injected into every
  // project's sessions. The model saves what it judges worth keeping, through
  // memory_save, into the memory of the project it is working in: no
  // subscription, no timer, no request.
  ctx.inject(['agents', 'llm'], memCtx => {
    const curator = new MemoryCurator(memCtx, root, log)
    // A save hands maintenance its trigger with the session id: the light
    // sweep already ran inline (see onSaved); the heavy sweep runs under the
    // curator's own cooldown, with further saves inside that window
    // coalescing into one trailing sweep that re-resolves the session by id.
    requestCurate = (parent, sessionId) => { void curator.runAfterSave(parent, sessionId) }
    // The manual trigger: the settings page's button, answered with what the
    // pass did (see MemoryCurateResult). Same curator instance, so the button
    // and the automatic path can never run at the same time.
    curateNow = slug => curator.curateNow(slug)
    memCtx.effect(() => curator.attach(), 'plugin-memory: background maintenance')
  })

  log.info(`memory root: ${dir}`)
}
