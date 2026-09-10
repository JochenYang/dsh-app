/**
 * DSH APP cross-session memory — host half.
 *
 * Mounts five things over one two-level root
 * (`$DSH_HOME/storages/dsh-app-plugin-memory`):
 *
 * 1. a system-prompt section whose text is a per-assembly provider —
 *    saving guidelines plus the LIVE global file and the current
 *    project's file (resolved from the assembling agent's session cwd;
 *    bounded, see prompt.ts), so a mid-session memory_save is visible to
 *    the next turn;
 * 2. three LLM tools, `memory_save` / `memory_recall` / `memory_forget`
 *    (model-driven proactive saving; project routing comes from the
 *    executing agent's session cwd, never from model input);
 * 3. the background distiller (see distiller.ts): after a session goes
 *    quiet, one direct LLM call reviews the conversation delta and proposes
 *    entries the host validates before writing — the code-guaranteed half of
 *    proactive memory;
 * 4. the background curator (see curator.ts): when a distill saved entries,
 *    a deferred direct call merges near-duplicates, prunes stale ones, and
 *    re-categorizes, so the file stays lean instead of growing forever.
 *    Both passes mount only when the agents + llm services are available
 *    (graceful on kernels without them);
 * 5. settings-page routes (status/toggle/pin/clear) for the client half.
 *
 * The user's exit valve is `<storeDir>/config.json` (`enabled: false`, the
 * same discipline as plugin-usage): a disabled plugin mounts nothing but
 * its status route, and the toggle set through the settings page takes
 * effect on the next prompt assembly — no restart. A second field
 * (`distill: false`) disables only the background pass.
 *
 * Stability discipline: zero global side effects; a kernel without the
 * consumed services never mounts anything.
 *
 * @module @dsh-app/plugin-memory
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the tools Context merge (ctx.tools) into scope.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the systemPrompt Context merge (ctx.systemPrompt) and the
// AssembleContext.agent augmentation into scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryRoot, listProjects, repairDoublePrefix } from './memory-store.ts'
import { MemoryDistiller } from './distiller.ts'
import { MemoryCurator } from './curator.ts'
import { renderMemoryText } from './prompt.ts'
import { registerMemoryRoutes } from './routes.ts'
import { registerMemoryTools } from './tools.ts'

export const name = 'plugin-memory'
export const inject = ['webServer', 'tools', 'systemPrompt']

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

/**
 * Collapse legacy double-prefixed lines in every memory file (global + all
 * projects). Runs on every boot; idempotent and byte-identical on clean
 * files, so there is nothing to migrate or version.
 */
function repairLegacyDoublePrefixes(root: MemoryRoot): void {
  try {
    const stores = [root.global]
    for (const project of listProjects(root.dir)) {
      if (project.cwd !== '') stores.push(root.projectFor(project.cwd))
    }
    let fixed = 0
    for (const store of stores) {
      const text = store.read()
      if (text === '') continue
      const { fixed: repaired, count } = repairDoublePrefix(text)
      if (count > 0) {
        store.replace(repaired)
        fixed += count
      }
    }
  } catch {
    // Repair is best-effort: a failure must never block the plugin mount.
  }
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

  // One-shot repair of double-prefixed lines written before prefix
  // stripping (`- [a] date - [b] date …`): idempotent, clean files are left
  // byte-identical, so this is safe to run on every boot.
  repairLegacyDoublePrefixes(root)

  if (!root.global.isEnabled()) {
    log.info(`memory plugin: disabled by user config (${join(dir, 'config.json')})`)
    ctx.effect(() => registerMemoryRoutes(ctx.webServer, root), 'plugin-memory: settings routes (disabled)')
    return
  }

  // Provider evaluated on every assembly: guidelines + the live global and
  // current-project files, honoring the toggle without a restart.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:memory',
    order: PROMPT_SECTION_ORDER,
    text: context => renderMemoryText(root, context.agent?.session.header.cwd),
  }), 'plugin-memory: system prompt section')

  // The direct-save path's curator trigger. Tools mount regardless of the
  // agents/llm seam (below), so the callback is a late-bound holder: a kernel
  // without those services leaves it unset and memory_save still works.
  let requestCurate: ((parent: NonNullable<ReturnType<Context['agents']['get']>>, sessionId: SessionId) => void) | undefined
  ctx.effect(() => registerMemoryTools(ctx, root, (parent, sessionId) => { requestCurate?.(parent, sessionId) }), 'plugin-memory: llm tools')
  ctx.effect(() => registerMemoryRoutes(ctx.webServer, root), 'plugin-memory: settings routes')

  // The background passes need the agents + llm services; on a kernel
  // without them (e.g. a rollback target) the plugin still mounts everything
  // else — only the async safety nets are absent. The distiller appends NEW
  // entries; a saved run hands the curator the trigger, and the curator then
  // merges/prunes the file (see distiller.ts / curator.ts). Both call the
  // model directly on the triggering session's own route.
  ctx.inject(['agents', 'llm'], memCtx => {
    const curator = new MemoryCurator(memCtx, root, log)
    // The distill hands the curator its save trigger with the session id:
    // the first sweep runs in the distill's own window, further saves inside
    // the cooldown coalesce into one trailing sweep that re-resolves the
    // session by id at fire time.
    const distiller = new MemoryDistiller(memCtx, root, log, (parent, sessionId) => curator.runAfterDistill(parent, sessionId))
    // Both save paths must be able to consolidate: the distill's own trigger
    // above, and memory_save's direct path through this holder (both remain
    // gated by the same 后台自动提炼 toggle, inside the curator).
    requestCurate = (parent, sessionId) => { void curator.runAfterDistill(parent, sessionId) }
    memCtx.effect(() => {
      const disposeDistiller = distiller.attach()
      const disposeCurator = curator.attach()
      return () => { disposeDistiller(); disposeCurator() }
    }, 'plugin-memory: background passes')
  })

  log.info(`memory root: ${dir}`)
}
