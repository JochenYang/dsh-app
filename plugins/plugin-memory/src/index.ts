/**
 * DSH APP cross-session memory — host half.
 *
 * Mounts four things over one two-level root
 * (`$DSH_HOME/storages/dsh-app-plugin-memory`):
 *
 * 1. a system-prompt section whose text is a per-assembly provider —
 *    saving guidelines plus the LIVE global file and the current
 *    project's file (resolved from the assembling agent's session cwd;
 *    bounded, see prompt.ts), so a mid-session memory_save is visible to
 *    the next turn;
 * 2. two LLM tools, `memory_save` / `memory_recall` (model-driven proactive
 *    saving; project routing comes from the executing agent's session
 *    cwd, never from model input);
 * 3. the background distiller (see distiller.ts): after a session goes
 *    quiet, a read-only one-shot subagent reviews the conversation delta
 *    and proposes entries the host validates before writing — the
 *    code-guaranteed half of proactive memory. Mounted only when the
 *    subagent services are available (graceful on kernels without them);
 * 4. settings-page routes (status/toggle/clear) for the client half.
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
import { MemoryRoot } from './memory-store.ts'
import { MemoryDistiller } from './distiller.ts'
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
 * Host apply: mount prompt injection + tools + routes, unless disabled by
 * the user config file (the coexistence exit valve).
 * @param ctx - the host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-memory')
  const root = new MemoryRoot(dir)

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

  ctx.effect(() => registerMemoryTools(ctx, root), 'plugin-memory: llm tools')
  ctx.effect(() => registerMemoryRoutes(ctx.webServer, root), 'plugin-memory: settings routes')

  // The background distiller needs the subagent seam; on a kernel without
  // it (e.g. a rollback target) the plugin still mounts everything else —
  // only the async safety net is absent.
  ctx.inject(['agents', 'subagents'], distillCtx => {
    const distiller = new MemoryDistiller(distillCtx, root, log)
    distillCtx.effect(() => distiller.attach(), 'plugin-memory: background distiller')
  })

  log.info(`memory root: ${dir}`)
}
