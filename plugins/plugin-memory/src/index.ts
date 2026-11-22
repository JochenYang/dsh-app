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
 * 1b. two additions around that section, both background notes and both
 *    absent when they have nothing to say:
 *    - the memory index another coding assistant keeps for the same workspace
 *      (ZCode), read-only, inside the section (see external-index.ts);
 *    - the stored cards that bear on the CURRENT request (see relevance.ts),
 *      OUTSIDE the section: the section is the cached prompt prefix and must
 *      not change with every turn, so they ride as a runtime-context snapshot
 *      (`ctx.systemPrompt.context`, a user-role message the kernel appends
 *      only when its text changes);
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
 * 4. settings-page routes (status/toggle/pin/move/clear) for the client half.
 *
 * Every prompt assembly also feeds a bounded in-memory ledger
 * (`injection-metrics.ts`) of what the injection COST — guidelines, index and
 * card bodies in characters — served by `/status`, because the body budget can
 * only be shown to bind if the fixed costs beside it are measured too.
 *
 * What is deliberately NOT mounted any more: session-driven EXTRACTION. Its
 * pass read a quiet session's conversation and proposed cards, and a session
 * with no workspace had its cards written to the global scope — which was
 * then injected into every project's sessions. Measured in practice, that
 * put one workspace's research conclusions into all of them. Memory is now
 * what the model decides to keep through `memory_save`, into the memory of
 * the project it is working in.
 *
 * The ONE subscription that remains is `agent/inbox/claimed`, and it is not
 * the extractor come back: it only remembers, per agent, the text of the
 * message a person typed — the request the request-relevant cards are picked
 * for. No timer, no model call, no write, and nothing is done with any other
 * event.
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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the tools Context merge (ctx.tools) into scope.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the systemPrompt Context merge (ctx.systemPrompt) and the
// AssembleContext.agent augmentation into scope.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryRoot, projectSlug, type MemoryStore } from './memory-store.ts'
import { MemoryCurator } from './curator.ts'
import { lightSweep } from './light-sweep.ts'
import { assembleMemoryText } from './prompt.ts'
import { clipRequest } from './relevance.ts'
import { InjectionMetricsRing } from './injection-metrics.ts'
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

/** Order of the request-relevant cards among the runtime contexts. Upstream
 *  allocates its own up to 210 (`CONTEXT_ORDERS.WEB_SURFACE`); an outside
 *  contribution may take any finite number, so this sits after all of them. */
const RELEVANT_CONTEXT_ORDER = 300

/** The runtime-context contribution's name. */
const RELEVANT_CONTEXT_NAME = 'tool:memory-relevant'

/**
 * The text a person typed, or undefined for everything else that reaches the
 * model as a user-role message. The harness injects its own material through
 * the same inbox — runtime context, a skill catalog, a notice that a job
 * finished, a relay from another agent — each under its own producer `kind`;
 * only `kind: 'user'` is the request. An injected snapshot is no stand-in for
 * it: a skill catalog or a runtime-context snapshot shares technical
 * vocabulary with almost any card.
 *
 * What else arrives as `kind: 'user'`: a delegation prompt a swarm lead sends
 * a teammate (its text IS what that agent is to work on, so attaching for it
 * is right), and a few synthesized messages of the kernel's own, such as a
 * `/goal` attachment note. The last one claimed wins; a short synthesized
 * message after the request costs that step its attached cards and nothing
 * else.
 */
function requestTextOf(message: UserMessage): string | undefined {
  if (message.source.kind !== 'user') return undefined
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text') text += `${block.text}\n`
  }
  const request = clipRequest(text)
  return request === '' ? undefined : request
}

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
  // One ledger per mount: the provider writes it, /status reads it. In memory
  // only — this is written on EVERY assembly, and a file rewrite per turn on
  // the prompt path is a cost that outgrows the diagnostic it serves.
  const injectionMetrics = new InjectionMetricsRing()

  // Boot migrations, one entry point: any legacy memory.md timeline becomes
  // topic cards, and the retired global scope's cards move into a project
  // directory the user can see and delete (MemoryRoot.migrateAll owns the
  // order). Deterministic (no model), idempotent, and a failure leaves the
  // store untouched for the next boot.
  await root.migrateAll(log)
  // Index/card reconciliation (W2). The index is derived data that rides into
  // every session of its project, and nothing used to check it against the
  // cards: measured on a real store, 29 index lines beside 28 cards, the ghost
  // injected into that project's every prompt. Mount and `/status` are the two
  // moments a project's index is about to be read, so both reconcile.
  await root.reconcileIndexes(log)

  if (!root.global.isEnabled()) {
    log.info(`memory plugin: disabled by user config (${join(dir, 'config.json')})`)
    ctx.effect(() => registerMemoryRoutes(ctx.connection.fetch, root), 'plugin-memory: settings routes (disabled)')
    return
  }

  // The request each agent is answering, and the request-relevant block picked
  // for it at the last assembly. Keyed by the agent object, so an agent that
  // goes away takes its entries with it. Two providers share them, and the
  // order is the kernel's own: inside one `assemble()` the sections are
  // resolved before the contexts, so the block the section provider computes
  // here is what the context provider of the SAME assembly hands out — it can
  // never name a card that assembly did not leave out of the section.
  const requestOf = new WeakMap<Agent, string>()
  const relevantOf = new WeakMap<Agent, string>()

  // Provider evaluated on every assembly: guidelines + the live current-project
  // index/cards, honoring the toggle without a restart.
  //
  // `interpolate: false` is load-bearing, not a detail: this section carries the
  // USER'S OWN card text, and the kernel renders every section through a
  // `{{variable}}` pass that THROWS on a name it cannot parse. A card quoting any
  // template syntax — a WeChat mini-program `bindXXX="{{KEY}}"`, a Mustache
  // sample, an env template — took the whole prompt down, and with it every
  // session: `malformed prompt variable reference "{{KEY}}" in section
  // "tool:memory"`, model unusable, new session or resumed alike. Measured on a
  // real card (`mp-bare-ref-tap-dead`). This section references no kernel
  // variable of its own, so opting out of the pass costs nothing.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:memory',
    order: PROMPT_SECTION_ORDER,
    interpolate: false,
    text: context => {
      const agent = context.agent
      const cwd = agent?.session.header.cwd
      const request = agent === undefined ? undefined : requestOf.get(agent)
      const assembly = assembleMemoryText(root, cwd, request === undefined ? {} : { relevantTo: request })
      if (agent !== undefined) {
        if (assembly.relevant === undefined) relevantOf.delete(agent)
        else relevantOf.set(agent, assembly.relevant.text)
      }
      // Measured at the ONE point an assembly exists, so the numbers can never
      // disagree with the text the prompt actually received. A session without
      // a workspace assembles only the static guidelines, so there is nothing
      // project-scoped to record (and no project to record it against).
      if (assembly.metrics !== undefined && cwd !== undefined) {
        injectionMetrics.record(assembly.metrics, projectSlug(cwd))
      }
      return assembly.text
    },
  }), 'plugin-memory: system prompt section')

  // The request-relevant cards (Z3). The kernel claims the inbox right before
  // it assembles a step, so the listener below has the step's request by the
  // time the section provider above runs.
  //
  // Why a runtime context and not a part of the section: the section is the
  // prompt's cached prefix. A per-turn block inside it would invalidate that
  // prefix on every turn the request changes — which is every turn. A context
  // is a separate user-role snapshot the kernel appends ONLY when its text
  // changes and marks as superseding the earlier ones, so an unchanged
  // request (the steps of one turn) costs nothing and the prefix stays cached.
  // The text must therefore be STABLE for a given agent between assemblies
  // (it is re-read when the kernel refreshes contexts): it is the last
  // assembly's block, not a fresh ranking.
  //
  // `interpolate: false` for the same reason as the section: card text.
  ctx.inject(['agents'], agentCtx => {
    agentCtx.on('agent/inbox/claimed', ({ agent, message }) => {
      const request = requestTextOf(message)
      if (request !== undefined) requestOf.set(agent, request)
    })
    agentCtx.effect(() => agentCtx.systemPrompt.context({
      name: RELEVANT_CONTEXT_NAME,
      order: RELEVANT_CONTEXT_ORDER,
      interpolate: false,
      // '' contributes nothing: no request, nothing relevant, or a session
      // without a workspace.
      text: context => context.agent === undefined ? '' : relevantOf.get(context.agent) ?? '',
    }), 'plugin-memory: request-relevant cards context')
  })

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
  ctx.effect(() => registerMemoryRoutes(ctx.connection.fetch, root, {
    curateNow: hookCurateNow,
    injectionMetrics: () => injectionMetrics.summary(),
  }), 'plugin-memory: settings routes')

  // The background maintenance pass needs the agents + llm services; on a
  // kernel without them (e.g. a rollback target) the plugin still mounts
  // everything else — only the async safety net is absent. The curator only
  // CONSOLIDATES memory that a memory_save already wrote; it calls the model
  // directly on the route of the session whose save triggered it.
  //
  // The curator subscribes to nothing — extraction from a conversation is
  // retired for good. Its turn/end subscription was what armed a quiet-timer
  // model call, and a session without a workspace had its cards written to the
  // global scope — which was then injected into every project's sessions. The
  // model saves what it judges worth keeping, through memory_save, into the
  // memory of the project it is working in: no subscription, no timer, no
  // request. (The plugin's one remaining subscription is the request text
  // above, which triggers nothing.)
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
