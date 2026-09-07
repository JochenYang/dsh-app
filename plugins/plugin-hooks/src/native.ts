/**
 * Native DSH hook runtime — the "DSH 原生" format, no CC/Codex compatibility
 * layer. Instead of mounting a kernel bridge, this runtime registers typed
 * interception handlers DIRECTLY on the plugin's context (host level; host
 * listeners receive agent-scoped events — verified end-to-end by the CC
 * bridge working at this level) and dispatches against a live rule set that
 * `sync()` refreshes whenever native entries change.
 *
 * Native rule format (see parseNativeRules in wire.ts):
 *   { "rules": [{ "name", "on", "matcher?", "action", "message" }] }
 *
 * Supported events × actions: pre-tool-use(block), post-tool-use(block),
 * prompt-submit(context|block), session-start(context).
 *
 * Handler return shapes mirror @deepseek-ai/dsh-hooks-claude-code exactly
 * (deny/kind contracts from the kernel's typed decision surfaces).
 *
 * @module @dsh-app/plugin-hooks/native
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { NativeRule } from './wire.ts'
import { parseNativeRules } from './wire.ts'
import type { HooksMountStatus } from './wire.ts'

/** Source stamped on every context message this runtime injects. */
const NATIVE_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-app-native-hooks' }

/**
 * Structural slice of the cordis Context's `on` method for the four
 * interception events we register. The Events augmentation from dsh-tools /
 * dsh-agent is not visible in this plugin's flat-npm tsconfig context (it
 * resolves in the harness workspace but not here); this cast captures the
 * handler signatures we rely on (verified at runtime by the CC bridge
 * working at the host level) without depending on the merge.
 */
type Hookable = {
  on(event: 'tools/pre-execute', handler: (exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>): () => void
  on(event: 'tools/post-execute', handler: (exec: { name: string }, _result: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
  on(event: 'agent/pre-step', handler: (data: { agent: { inject: (msg: unknown) => void }; messages: unknown[] }, next: () => Promise<unknown>) => Promise<unknown>): () => void
  on(event: 'agent/session-start', handler: (data: { agent: { inject: (msg: unknown) => void } }) => void): () => void
}

export class NativeHookRuntime {
  private rules: NativeRule[] = []
  private readonly statuses = new Map<string, HooksMountStatus>()

  constructor(private readonly log: (message: string) => void) {}

  /**
   * Refresh the live rule set from all native entries. Called on every
   * sync — handlers stay registered and read the refreshed rules.
   */
  sync(entries: ReadonlyArray<{ id: string; configContent?: string }>): void {
    const rules: NativeRule[] = []
    const statuses = new Map<string, HooksMountStatus>()
    for (const entry of entries) {
      try {
        const parsed = parseNativeRules(entry.configContent ?? '')
        rules.push(...parsed)
        statuses.set(entry.id, { state: 'mounted' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        statuses.set(entry.id, { state: 'error', message })
        this.log(`native hooks: entry ${entry.id} invalid: ${message}`)
      }
    }
    this.rules = rules
    this.statuses.clear()
    for (const [id, status] of statuses) this.statuses.set(id, status)
  }

  /** Mount status of one native entry (undefined → not a native entry). */
  statusFor(id: string): HooksMountStatus | undefined {
    return this.statuses.get(id)
  }

  /** Whether any native entry currently contributes rules. */
  get active(): boolean {
    return this.rules.length > 0
  }

  /** Rules matching one tool event (block action only). */
  private toolRules(on: NativeRule['on'], toolName: string): NativeRule[] {
    return this.rules.filter((rule) => {
      if (rule.on !== on || rule.action !== 'block') return false
      if (rule.matcher === undefined) return true
      try { return new RegExp(rule.matcher).test(toolName) } catch { return false }
    })
  }

  /**
   * Register all typed interception handlers ONCE (in apply). Handlers
   * dispatch against the live rule set; no re-registration on config change.
   * @returns disposer removing every handler.
   */
  register(ctx: Context): () => void {
    const hookable = ctx as unknown as Hookable
    const disposers = [
      hookable.on('tools/pre-execute', async (exec, next) => {
        for (const rule of this.toolRules('pre-tool-use', exec.name)) {
          return { kind: 'deny', reason: rule.message }
        }
        return next()
      }),
      hookable.on('tools/post-execute', async (exec, _result, next) => {
        for (const rule of this.toolRules('post-tool-use', exec.name)) {
          return { kind: 'block', feedback: [{ type: 'text' as const, text: rule.message }] }
        }
        return next()
      }),
      hookable.on('agent/pre-step', async (data, next) => {
        if (data.messages.length === 0) return next()
        const applicable = this.rules.filter(rule => rule.on === 'prompt-submit')
        if (applicable.some(rule => rule.action === 'block')) return { kind: 'reject' }
        const contexts = applicable.filter(rule => rule.action === 'context')
        if (contexts.length === 0) return next()
        const downstream = (await next()) as { kind: string; messages?: unknown[] }
        if (downstream.kind !== 'enter') return downstream
        const content: ContentBlock[] = contexts.map(rule => ({ type: 'text' as const, text: rule.message }))
        const ours = createUserMessage({ content, source: NATIVE_SOURCE })
        return { ...downstream, messages: [...(downstream.messages ?? []), ours] }
      }),
      hookable.on('agent/session-start', ({ agent }) => {
        const contexts = this.rules.filter(rule => rule.on === 'session-start' && rule.action === 'context')
        if (contexts.length === 0) return
        const content: ContentBlock[] = contexts.map(rule => ({ type: 'text' as const, text: rule.message }))
        agent.inject(createUserMessage({ content, source: NATIVE_SOURCE }))
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }
}
