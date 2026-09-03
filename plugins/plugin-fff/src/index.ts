/**
 * DSH APP fff plugin — host half.
 *
 * Registers three LLM tools (`fffind` / `ffgrep` / `fff-glob`) over the FFF
 * engine (`@ff-labs/fff-node`, an in-process C library). A PickerManager owns
 * one FileFinder instance per workspace, created lazily on first use, reaped
 * when idle — so persistent searches hit a warm in-memory index instead of
 * re-scanning the tree per query.
 *
 * Security posture: every tool resolves its root from the executing agent's
 * session workspace (`exec.agent.session.header.cwd`) and never accepts a
 * path from the model; FFF only returns paths relative to that root, so the
 * workspace fence is enforced by the engine itself.
 *
 * Databases (frecency + query history) live under
 * `$DSH_HOME/storages/dsh-app-plugin-fff`, keyed per workspace. No client
 * half, no settings page in the MVP — the exit valve is removing the patch
 * entry (or setting config values in the patch, see below).
 *
 * @module @dsh-app/plugin-fff
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the tools Context merge (ctx.tools) into scope.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the systemPrompt Context merge (ctx.systemPrompt) into scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: pulls the agent augmentation (exec.agent.session) into scope.
import type {} from '@deepseek-ai/dsh-agent'
import { PickerManager } from './picker.ts'
import { registerFffTools } from './tools.ts'

export const name = 'plugin-fff'
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration (tunables only; scope is always the session cwd). */
export interface Config {
  /** Absolute store directory; empty → $DSH_HOME/storages/dsh-app-plugin-fff. */
  storePath: string
  /** Persist per-workspace frecency + query history. */
  enableFrecency: boolean
  /** Idle lifetime of an unused finder before its index is destroyed. */
  idleTtlMs: number
  /** Max live finder instances before idle ones are LRU-reaped. */
  maxInstances: number
  /** Initial-scan wait budget per workspace (ms) before a call times out. */
  scanWaitMs: number
}

export const Config: z<Config> = z.object({
  storePath: z.string().default(''),
  enableFrecency: z.boolean().default(true),
  idleTtlMs: z.number().default(1_800_000),
  maxInstances: z.number().default(4),
  scanWaitMs: z.number().default(15_000),
})

/** Tool-guidance section order (upstream convention: 100–199; memory uses 118). */
const PROMPT_SECTION_ORDER = 117

/** Short, stable guidance injected on every prompt assembly. No template
 * tokens — double-brace sequences are interpolated by the prompt assembler. */
const FFF_PROMPT_TEXT = [
  'File search tools are available from the fff plugin: `fffind` (fuzzy file search), `ffgrep` (content search) and `fff-glob` (pattern filtering).',
  'Prefer them over reading files one by one when locating paths, identifiers, or references in the codebase.',
].join('\n')

/**
 * Host apply: mount the picker lifecycle and the three LLM tools.
 * @param ctx - the host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-fff')

  // The picker is lazy: no workspace is scanned until the first tool call.
  const picker = new PickerManager({
    storeDir: dir,
    enableFrecency: config.enableFrecency,
    maxInstances: config.maxInstances,
    log,
  })

  ctx.effect(() => {
    const disposeTools = registerFffTools(ctx, picker, config.scanWaitMs)
    const disposerReaper = picker.startReaper(config.idleTtlMs)
    return () => {
      disposeTools()
      disposerReaper()
      picker.destroyAll()
    }
  }, 'plugin-fff: tools + picker lifecycle')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:fff',
    order: PROMPT_SECTION_ORDER,
    text: () => FFF_PROMPT_TEXT,
  }), 'plugin-fff: system prompt section')

  log.info(`fff plugin: store ${dir}; frecency ${config.enableFrecency ? 'on' : 'off'}`)
}