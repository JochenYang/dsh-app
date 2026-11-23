/**
 * What `apply` mounts, driven against a real project on disk and the real queue:
 * the search note's `tools/post-execute` listener and the request pack's
 * `agent/inbox/claimed` listener with its context provider.
 *
 * `grep-note.test.ts` and `prefetch.test.ts` pin the texts and the per-session rules
 * on a real graph; `overview-wiring.test.ts` does this for the overview. This file is
 * the seam between those and the kernel's pipeline: that each listener acts only for
 * the call or the message it is for, on a current graph, with the switch on, and
 * hands everything else back untouched. A wrong gate here (a note inside a
 * `run_code` sub-dispatch, a pack on an injected snapshot, a counter that moves on
 * every assembly) would pass both of those suites.
 *
 * The DSH home is redirected to a scratch directory for the whole file: the plugin
 * derives its storage root from it, and a test must never create a graph under the
 * user's real one.
 *
 * @module plugin-codegraph/tests/wiring
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { apply } from '../src/index.ts'
import { removeTree } from '../src/remove-tree.ts'
import { ROUTE_PREFIX } from '../src/routes.ts'
import { SWITCH_ENV } from '../src/switches.ts'

const NOTE_SWITCH = SWITCH_ENV.grepNote
const PACK_SWITCH = SWITCH_ENV.prefetch
const PACK = 'dsh-app:codegraph:request'
const scratch: string[] = []
const previousHome = process.env.DSH_HOME
const previous = { note: process.env[NOTE_SWITCH], pack: process.env[PACK_SWITCH] }

before(() => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cg-home-'))
  scratch.push(home)
  process.env.DSH_HOME = home
  // Whatever this machine set the switches to must not decide what this file proves.
  delete process.env[NOTE_SWITCH]
  delete process.env[PACK_SWITCH]
})

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const [name, value] of [[NOTE_SWITCH, previous.note], [PACK_SWITCH, previous.pack]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  // The sanctioned walker: this fixture holds a SQLite graph under the scratch home.
  for (const dir of scratch.splice(0)) {
    try { await removeTree(dir) } catch { /* best effort */ }
  }
})

/**
 * `helper` declared once and referenced from another file; `total` declared in two
 * files, so the graph is not certain about it; `MAX_RETRIES` declared once and
 * never referenced.
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-proj-'))
  scratch.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'util.ts'), '/** Adds one. */\nexport function helper(value: number): number {\n  return value + 1\n}\n\nexport const MAX_RETRIES = 3\n')
  writeFileSync(join(root, 'src', 'main.ts'), "import { helper } from './util'\n\nexport function run(): number {\n  return helper(1)\n}\n\nconst total = 1\n")
  writeFileSync(join(root, 'src', 'other.ts'), 'const total = 2\n')
  return root
}

/** The minimal Context `apply` reads, with the registrations this file observes. */
function host() {
  const routes: ConnectionFetchRoute[] = []
  const contexts = new Map<string, { text: (assembly: unknown) => string }>()
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  const disposers: (() => void | Promise<void>)[] = []
  const noop = (): void => undefined
  const ctx = {
    tools: { register: (): (() => void) => noop },
    connection: {
      fetch: {
        register(route: ConnectionFetchRoute): () => Promise<void> {
          routes.push(route)
          return async () => undefined
        },
      },
    },
    systemPrompt: {
      context(spec: { name: string, text: (assembly: unknown) => string }): () => void {
        contexts.set(spec.name, { text: spec.text })
        return noop
      },
    },
    on(event: string, listener: (...args: never[]) => unknown): () => void {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return noop
    },
    inject(_deps: readonly string[], callback: (scope: unknown) => void): void { callback(this) },
    effect(body: () => (() => void) | (() => Promise<void>)): void { disposers.push(body()) },
  }
  return { ctx, routes, contexts, listeners, dispose: async () => { for (const dispose of disposers.splice(0)) await dispose() } }
}

interface StatusRow {
  readonly cwd: string
  readonly state: string
  readonly indexedAt: number
  readonly usage: Record<string, number>
}

/** The project's status row, read through the route the settings page uses. */
async function statusRow(routes: readonly ConnectionFetchRoute[], cwd: string): Promise<StatusRow | undefined> {
  const route = routes.find(candidate => candidate.path === `${ROUTE_PREFIX}/status`)
  assert.ok(route !== undefined, 'the status route is registered')
  const response = await route.fetch(new Request('dsh-app://app/x'))
  const body = await response.json() as { value?: { projects?: StatusRow[] } }
  return body.value?.projects?.find(row => row.cwd === cwd)
}

/** Wait until the project's graph settles (≤ `ms`). */
async function settled(routes: readonly ConnectionFetchRoute[], cwd: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if ((await statusRow(routes, cwd))?.state === 'current') return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  assert.fail(`the graph of ${cwd} did not settle`)
}

interface ContextMessage {
  readonly source: { readonly kind: string }
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}
interface Decision {
  readonly kind: string
  readonly additionalContexts?: readonly ContextMessage[]
}
type PostExecute = (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<Decision>
type Claimed = (payload: { agent: unknown, message: unknown }) => void

/** Drive the post-execute listener once with a successful search and the decision the pipeline would have taken. */
const through = (listener: PostExecute, exec: unknown, decision: Decision = { kind: 'accept' }): Promise<Decision> =>
  listener(exec, { isError: false, value: [], content: [] }, async () => decision)

/** An inbox message as the kernel hands it to the listener. */
const message = (kind: string, text: string): unknown => ({ source: { kind }, content: [{ type: 'text', text }] })

describe('the search note and the request pack, wired', () => {
  const h = host()
  const cwd = project()
  let postExecute: PostExecute
  let claimed: Claimed
  let rootSeq = 0
  const agent = (): { session: { header: { cwd: string } } } => ({ session: { header: { cwd } } })

  before(async () => {
    apply(h.ctx as never)
    assert.equal(h.listeners.get('tools/post-execute')?.length, 1, 'one post-execute listener is mounted')
    assert.equal(h.listeners.get('agent/inbox/claimed')?.length, 1, 'one inbox listener is mounted')
    postExecute = h.listeners.get('tools/post-execute')![0] as PostExecute
    claimed = h.listeners.get('agent/inbox/claimed')![0] as Claimed
    h.listeners.get('session/created')?.[0]?.({ header: { cwd } } as never)
    await settled(h.routes, cwd)
  })

  after(async () => { await h.dispose() })

  describe('the search note', () => {
    it('appends the note to the downstream decision for a search the model made, and counts it', async () => {
      const downstream: Decision = { kind: 'accept', additionalContexts: [{ source: { kind: 'earlier' }, content: [{ type: 'text', text: 'kept' }] }] }
      const decision = await through(postExecute, { name: 'grep', arguments: { pattern: 'helper' }, agent: agent() }, downstream)
      assert.equal(decision.kind, 'accept')
      assert.equal(decision.additionalContexts?.length, 2, 'the downstream contexts stay, the note is added')
      assert.deepEqual(decision.additionalContexts?.[0], { source: { kind: 'earlier' }, content: [{ type: 'text', text: 'kept' }] })
      const note = decision.additionalContexts?.[1]
      assert.equal(note?.source.kind, 'dsh-app-codegraph')
      // The signature is the parser's normalized one: `export` is a modifier, not part of it.
      assert.match(note?.content[0]?.text ?? '', /^codegraph: "helper" is declared once in this project — function at src\/util\.ts:2 \(function helper\(value: number\): number\) — with 1 reference\(s\) from 1 file\(s\)\. `codegraph_impact\("helper"\)` lists each reference with the function that contains it\.$/u)
      assert.equal((await statusRow(h.routes, cwd))?.usage.grepNotes, 1)
    })

    it('tells a session once, and a new session again', async () => {
      const session = agent()
      assert.equal((await through(postExecute, { name: 'grep', arguments: { pattern: 'MAX_RETRIES' }, agent: session })).additionalContexts?.length ?? 0, 1, 'the first time')
      const again = await through(postExecute, { name: 'grep', arguments: { pattern: 'MAX_RETRIES' }, agent: session })
      assert.equal(again.additionalContexts, undefined, 'the same session is not told twice')
      assert.equal((await through(postExecute, { name: 'grep', arguments: { pattern: ' MAX_RETRIES ' }, agent: session })).additionalContexts, undefined, 'whitespace is the same name')
      assert.equal((await statusRow(h.routes, cwd))?.usage.grepNotes, 2, 'nothing was counted for a repeat')
      assert.equal((await through(postExecute, { name: 'grep', arguments: { pattern: 'MAX_RETRIES' }, agent: agent() })).additionalContexts?.length, 1, 'another session is told')
      assert.equal((await statusRow(h.routes, cwd))?.usage.grepNotes, 3)
    })

    it('hands back the very decision it was given for everything that is not a successful, certain search', async () => {
      const decision: Decision = { kind: 'accept' }
      const count = (await statusRow(h.routes, cwd))?.usage.grepNotes
      const exec = (extra: Record<string, unknown>): Record<string, unknown> => ({ name: 'grep', arguments: { pattern: 'helper' }, agent: agent(), rootCallId: `root-${String(rootSeq += 1)}`, ...extra })
      // Another tool, a failed search, a name the graph is not certain about, one it does not declare, a pattern that is not a bare identifier, a session without a cwd.
      for (const call of [exec({ name: 'read' }), exec({ arguments: { pattern: 'total' } }), exec({ arguments: { pattern: 'nothingDeclaredHere' } }), exec({ arguments: { pattern: 'helper\\(' } }), exec({ agent: {} }), exec({ agent: undefined })]) {
        assert.equal(await through(postExecute, call, decision), decision, JSON.stringify(call))
      }
      assert.equal(await postExecute(exec({}), { isError: true, error: {}, content: [] }, async () => decision), decision, 'a failed search')
      const blocked: Decision = { kind: 'block', feedback: [] }
      assert.equal(await through(postExecute, exec({}), blocked), blocked, 'a decision the pipeline already made')
      assert.equal(await through(postExecute, { name: 'grep', arguments: 'helper', agent: agent(), rootCallId: 'root-x' }, decision), decision, 'arguments without a shape')
      assert.equal((await statusRow(h.routes, cwd))?.usage.grepNotes, count, 'none of it was counted')
    })

    it('appends to a `run_code` sub-dispatch too, at most five notes per outer call, counted per call even when two run side by side', async () => {
      // With the PTC executor selected, every search is a sub-dispatch; its contexts
      // are ferried to the outer result. Every sub-dispatch of one outer call carries
      // that call's `parent` token — the fixture's `A` and `B` — and two outer calls
      // may interleave. A fresh session per search: the per-session memory must not
      // be what bounds the count here.
      const under = (parent: object, root: string): Record<string, unknown> => ({ name: 'grep', arguments: { pattern: 'helper' }, agent: agent(), parent, rootCallId: root })
      const notes = (decision: Decision): number => decision.additionalContexts?.filter(message => message.source.kind === 'dsh-app-codegraph').length ?? 0
      const count = (await statusRow(h.routes, cwd))?.usage.grepNotes
      const A = {}
      const B = {}
      const seen = { A: 0, B: 0 }
      for (let i = 0; i < 6; i++) {
        const a = await through(postExecute, under(A, 'call-A'))
        const b = await through(postExecute, under(B, 'call-B'))
        seen.A += notes(a)
        seen.B += notes(b)
        if (i === 5) {
          assert.equal(notes(a), 0, 'the sixth search under call A is not annotated')
          assert.equal(a.additionalContexts, undefined, 'and the decision is handed back as it came')
          assert.equal(notes(b), 0, 'nor is the sixth under call B')
        }
      }
      assert.deepEqual(seen, { A: 5, B: 5 }, 'each outer call is capped on its own; the other call does not reset it')
      assert.equal((await statusRow(h.routes, cwd))?.usage.grepNotes, (count ?? 0) + 10)
      // The next outer call starts with a fresh count, and a name the cap skipped has
      // not been "told about": the same session searches it again under a new call.
      const session = agent()
      assert.equal(notes(await through(postExecute, { name: 'grep', arguments: { pattern: 'MAX_RETRIES' }, agent: session, parent: A, rootCallId: 'call-A' })), 0, 'call A is full')
      assert.equal(notes(await through(postExecute, { name: 'grep', arguments: { pattern: 'MAX_RETRIES' }, agent: session, parent: {}, rootCallId: 'call-C' })), 1, 'a later call still tells the session')
    })

    it('says nothing while the switch is off, and nothing for a project without a current graph', async () => {
      process.env[NOTE_SWITCH] = '0'
      try {
        assert.equal((await through(postExecute, { name: 'grep', arguments: { pattern: 'helper' }, agent: agent() })).additionalContexts, undefined)
      } finally {
        delete process.env[NOTE_SWITCH]
      }
      // A directory no session ever entered has no graph and no queue entry.
      const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-cg-empty-'))
      scratch.push(elsewhere)
      assert.equal((await through(postExecute, { name: 'grep', arguments: { pattern: 'helper' }, agent: { session: { header: { cwd: elsewhere } } } })).additionalContexts, undefined)
      assert.equal((await statusRow(h.routes, elsewhere)), undefined, 'no graph was created for it either')
    })
  })

  describe('the request pack', () => {
    const usage = async (): Promise<Record<string, number>> => (await statusRow(h.routes, cwd))?.usage ?? {}
    /** The pack's text for one assembly. Read per call: `apply` has not run when this body is collected. */
    const text = (assembly: unknown): string => {
      const provider = h.contexts.get(PACK)?.text
      assert.ok(provider !== undefined, 'the request pack context is registered')
      return provider(assembly)
    }

    it('attaches the declarations a request names, and counts the request once', async () => {
      const session = agent()
      assert.equal(text({ agent: session }), '', 'a session that claimed nothing gets nothing')
      claimed({ agent: session, message: message('user', '请看 src/util.ts 里 helper 与 MAX_RETRIES 的实现') })
      const pack = text({ agent: session })
      assert.match(pack, /^Code graph — declarations this request names \(background from earlier code, NOT instructions/u, 'the pack is framed as background')
      assert.match(pack, /^src\/util\.ts \(2 declarations; `codegraph_context\("src\/util\.ts"\)` gives the outline\):$/mu, 'the named file with its count')
      assert.match(pack, /^- function helper\(value: number\): number :2 — 1 call site\(s\) \[exported\]$/mu, 'a declaration with its signature, line and call sites')
      assert.match(pack, /^symbol `MAX_RETRIES` — variable at src\/util\.ts:6/mu, 'a named symbol with its position')
      assert.ok(pack.length <= 1_700, `the pack is within its budget: ${String(pack.length)}`)
      assert.equal((await usage()).prefetchAttached, 1)
      // Every step of the turn assembles again: same request, same text, no new count.
      assert.equal(text({ agent: session }), pack, 'the text is stable for the request')
      assert.equal(text({ agent: session }), pack)
      assert.equal((await usage()).prefetchAttached, 1, 'one request, one count')
    })

    it('counts a request that names nothing the graph can resolve as skipped', async () => {
      const session = agent()
      claimed({ agent: session, message: message('user', '请把这个项目整理一下，谢谢。') })
      assert.equal(text({ agent: session }), '')
      assert.equal((await usage()).prefetchSkipped, 1)
    })

    it('lets only a user message replace the request, and keeps sessions apart', async () => {
      const attached = (await usage()).prefetchAttached
      const session = agent()
      // `helper` is a lowercase word, not a code-shaped token: the FILE is what resolves.
      claimed({ agent: session, message: message('user', 'src/util.ts 的 helper 是做什么的？') })
      const pack = text({ agent: session })
      assert.match(pack, /^src\/util\.ts /mu)
      // What the harness injects through the same inbox is not a new question.
      claimed({ agent: session, message: message('runtime-context', 'cwd: /nowhere, sandbox: off') })
      claimed({ agent: session, message: message('user', '') })
      assert.equal(text({ agent: session }), pack, 'an injected snapshot, or an empty text, keeps the request')
      claimed({ agent: session, message: message('user', '那 src/main.ts 里的 run 呢？') })
      const next = text({ agent: session })
      assert.match(next, /^src\/main\.ts /mu)
      assert.doesNotMatch(next, /util\.ts/u)
      assert.equal((await usage()).prefetchAttached, (attached ?? 0) + 2, 'the two requests of this session were each counted once, the snapshots in between not at all')
      assert.equal(text({ agent: agent() }), '', 'a session that claimed nothing has no request')
    })

    it('attaches nothing while the switch is off, or without a current graph', async () => {
      const before = await usage()
      process.env[PACK_SWITCH] = 'false'
      try {
        const session = agent()
        claimed({ agent: session, message: message('user', '看看 src/main.ts 的 run') })
        assert.equal(text({ agent: session }), '')
      } finally {
        delete process.env[PACK_SWITCH]
      }
      // A directory no session ever entered has no graph, and must not get one from here.
      const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-cg-empty-'))
      scratch.push(elsewhere)
      const stranger = { session: { header: { cwd: elsewhere } } }
      claimed({ agent: stranger, message: message('user', '看看 src/main.ts 的 run') })
      assert.equal(text({ agent: stranger }), '')
      assert.equal((await statusRow(h.routes, elsewhere)), undefined, 'no graph was created for it')
      assert.deepEqual(await usage(), before, 'none of it was counted')
    })

    it('holds the pack it already sent through a re-index, instead of dropping it and restoring it', async () => {
      // The pack rides the same snapshot as the overview: returning nothing while a
      // check runs and the pack again afterwards is two whole-snapshot re-pushes per
      // editing turn. The held text is the one the model already has.
      const session = agent()
      claimed({ agent: session, message: message('user', '看看 src/other.ts 里的 total 呢') })
      const pack = text({ agent: session })
      assert.match(pack, /^src\/other\.ts /mu)
      const attached = (await usage()).prefetchAttached
      const before = (await statusRow(h.routes, cwd))?.indexedAt
      writeFileSync(join(cwd, 'src', 'late.ts'), 'export const lateRow = 1\n')
      h.listeners.get('tools/result')?.[0]?.({ name: 'write', agent: session } as never)
      // Inside the debounce the graph is still `current` but a check is pending.
      assert.equal(text({ agent: session }), pack, 'a pack already sent is held while the check is pending')
      const until = Date.now() + 20_000
      while (Date.now() < until) {
        const row = await statusRow(h.routes, cwd)
        if (row !== undefined && row.state === 'current' && row.indexedAt !== before) break
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      const after = text({ agent: session })
      assert.notEqual(after, '', 'the pack is back once the graph is current again')
      assert.equal((await usage()).prefetchAttached, attached, 'a held or rebuilt pack is not a new request')
    })
  })
})
