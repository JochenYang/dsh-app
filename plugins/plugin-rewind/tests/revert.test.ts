/**
 * The host half end to end: mount `apply` the way the loader does, drive the real
 * `tools/pre-execute` gate, and run `/rewind` through its own command handler.
 *
 * Every other test in this suite drives one piece directly, and that is how the
 * defect this file exists for stayed green: the recorder was scoped by turn
 * number alone (another session's turn 2 won), a range with no snapshot reported
 * `{restored: 0, removed: 0, unrestorable: []}` — a clean success — over a tree a
 * shell command had just rewritten, and the merge/coverage logic had no test at
 * all. The pieces were each correct on their own; the wiring between them is what
 * a user experiences.
 *
 * No kernel runtime is needed: `apply` reaches the session and the filesystem
 * only through the objects it is handed, so a real `Session` plus a real cordis
 * `Context` for the two waterfalls is the whole world it can see.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, type Config } from '../src/index.ts'
import type { RewindParticipantRegistry } from '../src/participants.ts'

/** A workspace and a `$DSH_HOME`, both removed by the caller. */
function scratch(): { work: string, home: string } {
  // Canonicalized, because the snapshot stores its root that way and every path it
  // reports is built from it: on Windows the OS temp directory's short (8.3)
  // spelling is not what comes back out.
  return {
    work: realpathSync.native(mkdtempSync(join(tmpdir(), 'rewind-e2e-'))),
    home: realpathSync.native(mkdtempSync(join(tmpdir(), 'rewind-e2e-home-'))),
  }
}

/** The `apply` signature's config, at its defaults. */
function config(overrides: Partial<Config> = {}): Config {
  return {
    maxAnchors: 50,
    snapshotWorkspace: true,
    maxSnapshotFiles: 20_000,
    maxSnapshotBytes: 128 * 1024 * 1024,
    ...overrides,
  }
}

/**
 * Mount the host half on a stand-in context.
 *
 * The context exposes exactly what `apply` uses: the two waterfalls and the tool
 * gate through a real cordis Context, and inert stubs for the framework seams it
 * registers into. `connection` is deliberately absent — that is the documented
 * degradation (no management page, recall unaffected).
 *
 * `provide` records what the plugin publishes, so a test can drive the participant
 * seam the same way another suite plugin would; `warnings` collects the plugin's
 * own log lines, which is the only place a contained participant failure survives.
 */
function mount(cfg: Config = config()): {
  host: Context
  handler: (invocation: unknown) => Promise<{ kind: string, text: string }>
  provided: Map<string, unknown>
  warnings: string[]
} {
  const host = new Context('rewind-test')
  const state: { handler?: (invocation: unknown) => Promise<{ kind: string, text: string }> } = {}
  const provided = new Map<string, unknown>()
  const warnings: string[] = []
  const log = {
    warn: (message: string) => { warnings.push(message) },
    info: () => {},
    error: () => {},
  }
  const ctx = {
    logger: () => log,
    effect: (fn: () => unknown) => fn(),
    on: (name: string, listener: unknown, options: unknown) => host.on(name as never, listener as never, options as never),
    inject: (_deps: string[], cb: (scope: unknown) => void) => {
      cb({ get: () => undefined, effect: (fn: () => unknown) => fn() })
    },
    sessionProjections: { register: () => {} },
    commands: { register: (def: { handler: (invocation: unknown) => Promise<{ kind: string, text: string }> }) => { state.handler = def.handler } },
    // The published-service seat: cordis's `ctx.provide(name, value)` returns the
    // disposer that unregisters it, and the plugin hands it to `ctx.effect`.
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      return () => { provided.delete(name) }
    },
  }
  apply(ctx as never, cfg)
  return {
    host,
    provided,
    warnings,
    handler: (invocation) => {
      const handler = state.handler
      if (handler === undefined) throw new Error('the plugin did not register its command')
      return handler(invocation)
    },
  }
}

/**
 * The participant registry the plugin published.
 *
 * Read from the same `provided` map a consuming plugin's `ctx.get` would use, so a
 * broken `provide` fails here rather than in a real consumer.
 */
function registryOf(provided: Map<string, unknown>): RewindParticipantRegistry {
  const registry = provided.get('dsh-app-rewind-participants')
  assert.ok(registry !== undefined, 'apply must provide dsh-app-rewind-participants')
  return registry as RewindParticipantRegistry
}

/** A session whose header carries the workspace root the snapshot uses. */
function session(id: string, cwd: string): Session {
  return Session.create(id, undefined, {
    version: 4,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd,
  })
}

/** Open a turn with a user prompt, the way a real log does. */
function openTurn(target: Session, turn: number, prompt: string): void {
  target.append('turn/start', { turn })
  target.append('step/start', { turn, step: 1 })
  target.append('user/message', {
    id: `u${String(turn)}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
}

/** Close a turn. */
function closeTurn(target: Session, turn: number): void {
  target.append('assistant/message', {
    turn, step: 1,
    message: { id: `a${String(turn)}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
  }, { surfaceOp: 'append' })
  target.append('step/end', { turn, step: 1 })
  target.append('turn/end', { turn })
}

/** The gate every tool dispatch passes through, driven the way dsh-tools does. */
async function toolGate(host: Context, target: Session, name: string): Promise<void> {
  await host.waterfall('tools/pre-execute', { name, agent: { session: target } }, () => ({ kind: 'allow' }))
}

/** A `write` tool call: the waterfall fires, then the file lands. */
async function toolWrite(host: Context, target: Session, path: string, content: string): Promise<void> {
  const resolved = { targetKey: path, displayPath: path }
  await host.waterfall('fs/write-intent', resolved, { agent: { session: target } }, () => undefined)
  writeFileSync(path, content)
}

/** Record a `tool/call` event, which is what the coverage verdict reads. */
function toolCall(target: Session, turn: number, name: string): void {
  target.append('tool/call', { turn, step: 1, callId: `c${String(turn)}`, name, arguments: '{}' })
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
const report = (result: { text: string }): { files: Record<string, unknown> } => JSON.parse(result.text)

test('a file a shell command wrote is put back, byte for byte', async () => {
  const { work, home } = scratch()
  const before = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11])
  const after = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x99])
  writeFileSync(join(work, 'sprite.png'), before)
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const target = session('probe-shell', work)

  // Turn 1: a python script run through the shell. Nothing about these writes
  // passes through the plugin's waterfalls.
  openTurn(target, 1, 'regenerate the sprite sheet')
  await toolGate(host, target, 'pwsh')
  toolCall(target, 1, 'pwsh')
  writeFileSync(join(work, 'sprite.png'), after)
  writeFileSync(join(work, 'generated.txt'), 'GENERATED')
  writeFileSync(join(work, 'note.md'), 'SHELL EDIT')
  closeTurn(target, 1)

  // Turn 2: a `write` tool call, covered exactly by the waterfall.
  openTurn(target, 2, 'and tidy the code')
  await toolGate(host, target, 'write')
  toolCall(target, 2, 'write')
  await toolWrite(host, target, join(work, 'app.ts'), 'export const v = 2\n')
  closeTurn(target, 2)
  await settle()

  const result = await handler({ rawInput: '2', agent: { session: target, status: 'idle' } })
  const files = report(result).files as { restored: number, removed: number, coverage: string, unrestorable: unknown[] }
  assert.equal(result.kind, 'success')
  assert.ok(readFileSync(join(work, 'sprite.png')).equals(before), 'the binary is back byte for byte')
  assert.equal(readFileSync(join(work, 'note.md'), 'utf8'), 'ORIGINAL', 'and so is the text')
  assert.equal(existsSync(join(work, 'generated.txt')), false, 'a file the shell created is moved away')
  assert.equal(existsSync(join(work, 'app.ts')), false, 'and so is one the write tool created')
  assert.equal(files.coverage, 'full')
  assert.deepEqual(files.unrestorable, [])
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a range with no snapshot says so instead of reporting a clean success', async () => {
  // The shape that shipped as a silent success: a tool whose writes this plugin
  // cannot observe ran, and there is no snapshot for the range's first turn (a
  // restarted kernel child, or a turn from before the feature existed).
  const { work, home } = scratch()
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { handler } = mount()
  const target = session('probe-nosnap', work)
  openTurn(target, 1, 'run a script')
  toolCall(target, 1, 'pwsh')
  writeFileSync(join(work, 'note.md'), 'SHELL EDIT')
  closeTurn(target, 1)

  const result = await handler({ rawInput: '1', agent: { session: target, status: 'idle' } })
  const files = report(result).files as { coverage: string, coverageReason?: string, tools?: string[] }
  assert.equal(readFileSync(join(work, 'note.md'), 'utf8'), 'SHELL EDIT', 'nothing could capture this write')
  assert.equal(files.coverage, 'none', 'so the recall must not claim coverage')
  assert.equal(files.coverageReason, 'noSnapshot')
  assert.deepEqual(files.tools, ['pwsh'], 'and it must name the tool that caused it')
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('one session cannot restore another session\'s before-image', async () => {
  // Both sessions are in one process, as they are in the kernel. Keyed by turn
  // number alone, B's recall of its turn 2 matched A's turn 2 and put the file
  // back to A's before-image — a version this session never had.
  const { work, home } = scratch()
  writeFileSync(join(work, 'a.txt'), 'v0')
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const a = session('probe-a', work)
  const b = session('probe-b', work)

  openTurn(a, 1, 'A1'); closeTurn(a, 1)
  openTurn(a, 2, 'A2')
  await toolGate(host, a, 'write')
  toolCall(a, 2, 'write')
  await toolWrite(host, a, join(work, 'a.txt'), 'a2')
  closeTurn(a, 2)

  openTurn(b, 1, 'B1'); closeTurn(b, 1)
  openTurn(b, 2, 'B2')
  await toolGate(host, b, 'write')
  toolCall(b, 2, 'write')
  await toolWrite(host, b, join(work, 'a.txt'), 'b2')
  closeTurn(b, 2)
  await settle()

  const result = await handler({ rawInput: '2', agent: { session: b, status: 'idle' } })
  assert.equal(result.kind, 'success')
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'a2', 'session B\'s own before-image, not v0')
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('the preview lists what the recall will do, and changes nothing', async () => {
  const { work, home } = scratch()
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const target = session('probe-plan', work)
  openTurn(target, 1, 'edit it')
  await toolGate(host, target, 'pwsh')
  toolCall(target, 1, 'pwsh')
  writeFileSync(join(work, 'note.md'), 'SHELL EDIT')
  writeFileSync(join(work, 'created.txt'), 'NEW')
  closeTurn(target, 1)
  await settle()

  const planned = report(await handler({ rawInput: 'plan 1', agent: { session: target, status: 'idle' } })) as {
    ok: boolean
    restore?: readonly { path: string, next?: string }[]
    remove?: readonly { path: string }[]
    coverage?: string
  }
  assert.equal(planned.ok, true)
  assert.deepEqual(planned.restore?.map((row) => row.path), [join(work, 'note.md')])
  assert.equal(planned.restore?.[0].next, 'ORIGINAL', 'with the bytes it would write back')
  assert.deepEqual(planned.remove?.map((row) => row.path), [join(work, 'created.txt')])
  assert.equal(planned.coverage, 'full')
  assert.equal(readFileSync(join(work, 'note.md'), 'utf8'), 'SHELL EDIT', 'a preview must not change anything')
  assert.equal(existsSync(join(work, 'created.txt')), true)
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('with the snapshot turned off, a shell range is reported rather than covered', async () => {
  const { work, home } = scratch()
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { host, handler } = mount(config({ snapshotWorkspace: false }))
  const target = session('probe-off', work)
  openTurn(target, 1, 'run a script')
  await toolGate(host, target, 'pwsh')
  toolCall(target, 1, 'pwsh')
  writeFileSync(join(work, 'note.md'), 'SHELL EDIT')
  closeTurn(target, 1)

  const result = await handler({ rawInput: '1', agent: { session: target, status: 'idle' } })
  const files = report(result).files as { coverage: string }
  assert.equal(files.coverage, 'none', 'a shell range with snapshots off is not covered')
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

// --- The participant seam, driven end to end ---
//
// The file revert is no longer an inline step: it is the first participant on the
// registry this plugin publishes. These tests mount the plugin exactly as the
// loader does, take the registry a consuming plugin would `ctx.get`, and check the
// three promises the seam makes: the revert runs first inside `reconcileAll`, its
// report is byte-identical to the inline call's, and another participant's failure
// costs neither the recall nor the participants after it.

/** A turn whose only change is one `pwsh` write of `note.md`. */
async function shellTurn(host: Context, target: Session, work: string): Promise<void> {
  openTurn(target, 1, 'rewrite the note')
  await toolGate(host, target, 'pwsh')
  toolCall(target, 1, 'pwsh')
  writeFileSync(join(work, 'note.md'), 'SHELL EDIT')
  closeTurn(target, 1)
}

test('the file revert is the first participant, and its report is unchanged', async () => {
  const { work, home } = scratch()
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { host, handler, provided } = mount()
  const registry = registryOf(provided)
  assert.deepEqual(registry.list().map((entry) => entry.id), ['file-revert'])

  // A participant registered after the revert can see the tree it put back, which
  // pins the ORDER inside `reconcileAll` and that the participant is handed the
  // real cut. It does NOT prove the revert happens only through the seam — a
  // revert moved back inline before the surface write would look the same from
  // here. What pins membership is `list()` above.
  const seen: { readonly bytes: string, readonly sessionId: string, readonly startSeq: number }[] = []
  registry.register({
    id: 'observer',
    reconcileAfterRewind: (recall) => {
      seen.push({
        bytes: readFileSync(join(work, 'note.md'), 'utf8'),
        sessionId: recall.sessionId,
        startSeq: recall.plan.startSeq,
      })
      return { ok: true }
    },
  })

  const target = session('probe-participant', work)
  await shellTurn(host, target, work)
  await settle()

  const result = await handler({ rawInput: '1', agent: { session: target, status: 'idle' } })
  assert.equal(result.kind, 'success')
  const files = report(result).files as {
    restored: number
    removed: number
    unrestorable: readonly unknown[]
    coverage: string
    tools?: readonly string[]
  }
  // The SAME report the inline `revertFiles` call produced: one file put back, the
  // range created nothing, coverage is the snapshot's full, and the tool that made
  // the change is named.
  assert.equal(files.restored, 1)
  assert.equal(files.removed, 0)
  assert.deepEqual(files.unrestorable, [])
  assert.equal(files.coverage, 'full')
  assert.deepEqual(files.tools, ['pwsh'])
  assert.equal(readFileSync(join(work, 'note.md'), 'utf8'), 'ORIGINAL', 'the file is back')
  assert.deepEqual(
    seen,
    [{ bytes: 'ORIGINAL', sessionId: 'probe-participant', startSeq: 2 }],
    'the later participant ran once, after the revert, with the session id and the cut that was written',
  )
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a participant that throws does not fail the recall or the one after it', async () => {
  const { work, home } = scratch()
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { host, handler, provided, warnings } = mount()
  const registry = registryOf(provided)

  const calls: string[] = []
  registry.register({
    id: 'boom',
    reconcileAfterRewind: () => {
      calls.push('boom')
      throw new Error('boom refused')
    },
  })
  registry.register({ id: 'after', reconcileAfterRewind: () => { calls.push('after') } })

  const target = session('probe-isolation', work)
  await shellTurn(host, target, work)
  await settle()

  const result = await handler({ rawInput: '1', agent: { session: target, status: 'idle' } })
  assert.equal(result.kind, 'success', 'the transcript change already landed; a participant cannot undo it')
  assert.deepEqual(calls, ['boom', 'after'], 'the participant after the failure still ran')
  const files = report(result).files as { restored: number, coverage: string }
  assert.equal(files.restored, 1, 'the file revert — the participant BEFORE the failure — still reported')
  assert.equal(files.coverage, 'full')
  assert.equal(readFileSync(join(work, 'note.md'), 'utf8'), 'ORIGINAL')
  const logged = warnings.join('\n')
  assert.match(logged, /"boom"/u, 'the failed participant is named in the log')
  assert.match(logged, /boom refused/u, 'and its own message survives there')
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

/**
 * Replace the surface's leading nodes with one compaction checkpoint.
 *
 * The kernel's `/compact` keeps a priced tail; with `retainTokens = 0` that tail
 * is the LAST surface node alone, so the checkpoint consumes every prompt and the
 * surviving surface is `[checkpoint, that node]`. `keepTail` mirrors that: 1 is
 * the `/compact` shape, 0 replaces everything.
 *
 * The checkpoint is a `user/message` whose `source.kind` is
 * `compact-checkpoint` (`@deepseek-ai/dsh-compaction`'s own marker), which is
 * exactly what `compactionBoundary` looks for.
 */
function compactPrefix(target: Session, keepTail: number): void {
  const nodes = target.surface.nodes
  const shadowed = nodes.slice(0, nodes.length - keepTail)
  target.append('user/message', {
    id: 'cp1',
    role: 'user',
    content: [],
    source: { kind: 'compact-checkpoint', compactionId: 'c1' },
  } as never, {
    surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
    sourceEventSeqs: shadowed,
  } as never)
}

/** The stable code a command result carries (host halves never send prose). */
function codeOf(result: { text: string }): string {
  return (JSON.parse(result.text) as { code?: string }).code ?? ''
}

test('after /compact leaves no prompt, the answer names the boundary, not "nothing yet"', async () => {
  const { work, home } = scratch()
  process.env.DSH_HOME = home
  const { handler } = mount()
  const target = session('probe-compacted-all', work)
  openTurn(target, 1, 'first request')
  closeTurn(target, 1)
  openTurn(target, 2, 'second request')
  closeTurn(target, 2)
  compactPrefix(target, 1)

  // Zero recall points AND a checkpoint: "empty" would name the wrong cause, and
  // it is what a session looks like right after `/compact`.
  const listed = await handler({ rawInput: '', agent: { session: target, status: 'idle' } })
  assert.equal(listed.kind, 'error')
  assert.equal(codeOf(listed), 'rewind.host.compactedAll')

  const recalled = await handler({ rawInput: '1', agent: { session: target, status: 'idle' } })
  assert.equal(recalled.kind, 'error')
  assert.equal(codeOf(recalled), 'rewind.host.compactedAll', 'a zero-length list is not "out of range"')

  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a prompt after the checkpoint lists with the boundary and refuses past it by code', async () => {
  const { work, home } = scratch()
  process.env.DSH_HOME = home
  const { handler } = mount()
  const target = session('probe-compacted-tail', work)
  openTurn(target, 1, 'old request')
  closeTurn(target, 1)
  compactPrefix(target, 0)
  // One prompt survives the compaction, which is the `retainTokens > 0` shape.
  openTurn(target, 2, 'new request')
  closeTurn(target, 2)

  const listed = await handler({ rawInput: '', agent: { session: target, status: 'idle' } })
  assert.equal(listed.kind, 'success')
  assert.equal(codeOf(listed), 'rewind.host.listBoundary', 'the listing names the boundary')
  assert.equal((JSON.parse(listed.text) as { params?: { count?: number } }).params?.count, 1)

  const past = await handler({ rawInput: '2', agent: { session: target, status: 'idle' } })
  assert.equal(past.kind, 'error')
  assert.equal(codeOf(past), 'rewind.host.compactionBoundary')
  assert.deepEqual(
    (JSON.parse(past.text) as { params?: unknown }).params,
    { available: 1, requested: 2 },
    'the refusal carries both numbers the sentence interpolates',
  )

  const fine = await handler({ rawInput: '1', agent: { session: target, status: 'idle' } })
  assert.equal(fine.kind, 'success', 'the surviving prompt is still recallable')

  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a conversation-only recall cuts the messages and leaves the files alone', async () => {
  // The case this verb exists for: the file work was right, the message was
  // wrong. An ordinary recall would undo both, so the user's only option used to
  // be "recall, then put the files back by hand".
  const { work, home } = scratch()
  writeFileSync(join(work, 'app.ts'), 'export const v = 1\n')
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const target = session('probe-chat-only', work)
  openTurn(target, 1, 'rewrite the module')
  await toolGate(host, target, 'write')
  toolCall(target, 1, 'write')
  await toolWrite(host, target, join(work, 'app.ts'), 'export const v = 2\n')
  closeTurn(target, 1)

  const result = await handler({ rawInput: 'conversation 1', agent: { session: target, status: 'idle' } })
  const files = report(result).files as { restored: number, removed: number, coverage: string, skipped?: boolean }

  assert.equal(result.kind, 'success', 'the recall itself succeeds')
  assert.equal(readFileSync(join(work, 'app.ts'), 'utf8'), 'export const v = 2\n',
    'the write is still there — this verb must not touch files')
  assert.equal(files.skipped, true, 'and the report says it was skipped rather than failed')
  assert.equal(files.coverage, 'full', 'a skipped revert is not a coverage shortfall')
  assert.equal(files.restored, 0)
  assert.equal(files.removed, 0)
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a conversation-only recall keeps the before-image so a later recall can still use it', async () => {
  // Dropping the recorder's entry and the range's snapshot here would make the
  // files permanently unrestorable: the turn is off the surface, so nothing else
  // remembers what it changed. The data therefore survives the skip.
  const { work, home } = scratch()
  writeFileSync(join(work, 'app.ts'), 'export const v = 1\n')
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const target = session('probe-chat-keep', work)
  openTurn(target, 1, 'rewrite the module')
  await toolGate(host, target, 'write')
  toolCall(target, 1, 'write')
  await toolWrite(host, target, join(work, 'app.ts'), 'export const v = 2\n')
  closeTurn(target, 1)

  await handler({ rawInput: 'conversation 1', agent: { session: target, status: 'idle' } })
  assert.equal(readFileSync(join(work, 'app.ts'), 'utf8'), 'export const v = 2\n', 'files untouched')

  // The real proof that the data survived: the turn is off the surface now, so a
  // second recall cannot find it through the anchor list — but the before-image
  // is still there, and a file revert asked for the same path still has it. The
  // assertion is therefore on the STORE, not on a directory that other data would
  // keep alive anyway (an earlier version asserted `existsSync(storages)` and
  // passed even when the entry had been dropped — measured by mutation).
  const trees = join(home, 'storages', 'dsh-app-plugin-rewind', 'trees', 'probe-chat-keep')
  const manifests = existsSync(trees) ? readdirSync(trees) : []
  assert.ok(manifests.includes('1.json'),
    `turn 1's workspace snapshot was dropped by the conversation-only recall (found: ${JSON.stringify(manifests)})`)
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a conversation-only recall still reaches the other participants', async () => {
  // Skipping the file revert must not skip the seam: a consumer that mirrored the
  // turn has to learn the turn is gone, because the transcript changed either way.
  const { work, home } = scratch()
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { host, handler, provided } = mount()
  const seen: string[] = []
  registryOf(provided).register({
    id: 'board',
    reconcileAfterRewind: (recall) => { seen.push(`board:${String(recall.plan.turn)}`) },
  })
  const target = session('probe-chat-seam', work)
  openTurn(target, 1, 'hello')
  closeTurn(target, 1)

  const result = await handler({ rawInput: 'conversation 1', agent: { session: target, status: 'idle' } })

  assert.equal(result.kind, 'success')
  assert.deepEqual(seen, ['board:1'], 'the other participant reconciled against the cut')
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})


test('the snapshot is taken when the TURN opens, so a recall returns the tree as it was then', async () => {
  // What "recall this message" means: put the tree back to the state it had when
  // the message was SENT. The lazy tool gate alone cannot do that — it fires at
  // the turn's first writing tool, by which time the user may have edited files
  // by hand, and that edit would be captured as the turn's starting state.
  //
  // The shell write is what makes the difference observable: it never passes the
  // pre-write waterfalls, so the snapshot diff is the only way a recall can see
  // that the file changed at all.
  const { work, home } = scratch()
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const target = session('probe-boundary', work)

  openTurn(target, 1, 'look at this for me')
  // The boundary snapshot rides the event feed. A Session built in a test does
  // not publish to the mounted context, so the event is emitted explicitly;
  // without it the assertion below would pass on the lazy gate alone.
  host.emit('session/event', target, { type: 'turn/start', data: { turn: 1 } })
  // Fire-and-forget by design, so give the walk longer than the default settle.
  await settle(400)
  const manifest = join(home, 'storages', 'dsh-app-plugin-rewind', 'trees', 'probe-boundary', '1.json')
  assert.equal(existsSync(manifest), true,
    'no boundary snapshot was taken: turn 1 has no manifest before any tool fired')

  // The user edits AFTER the turn opened, then the model's shell command edits
  // the same file.
  writeFileSync(join(work, 'note.md'), 'USER EDITED THIS')
  await toolGate(host, target, 'pwsh')
  toolCall(target, 1, 'pwsh')
  writeFileSync(join(work, 'note.md'), 'MODEL EDITED THIS')
  closeTurn(target, 1)
  await settle()

  const result = await handler({ rawInput: '1', agent: { session: target, status: 'idle' } })
  assert.equal(result.kind, 'success')
  // The state when the message was sent — before either edit.
  assert.equal(readFileSync(join(work, 'note.md'), 'utf8'), 'ORIGINAL',
    'the recall did not return the tree to the state it had when the turn opened')
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('the messages-only PREVIEW answers the same ordinal as the ordinary one', async () => {
  // The regression this pins: the preview verbs were enumerated by hand when the
  // ordinal was extracted, and the messages-only variant was not in that list —
  // so `/rewind plan conversation 1` silently planned ordinal 0, which the cut
  // rejects as out of range. The dialog then reported "cannot recall" for a
  // message that was perfectly recallable.
  const { work, home } = scratch()
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { handler } = mount()
  const target = session('probe-plan-scope', work)
  openTurn(target, 1, 'a message worth recalling')
  closeTurn(target, 1)
  await settle()

  const ordinary = report(await handler({ rawInput: 'plan 1', agent: { session: target, status: 'idle' } })) as {
    ok?: boolean, prompt?: string, skipped?: boolean
  }
  const messagesOnly = report(await handler({ rawInput: 'plan conversation 1', agent: { session: target, status: 'idle' } })) as {
    ok?: boolean, prompt?: string, skipped?: boolean
  }

  assert.equal(ordinary.ok, true, 'the ordinary preview must still resolve')
  assert.equal(messagesOnly.ok, true, 'the messages-only preview resolved a different ordinal')
  assert.equal(messagesOnly.prompt, ordinary.prompt, 'the two previews describe different messages')
  assert.equal(messagesOnly.skipped, true, 'the messages-only preview does not say the files are left alone')
})

test('a messages-only preview reports NO file effect, so the dialog cannot overstate it', async () => {
  // The dialog renders whatever the preview says and then acts on confirmation.
  // A preview listing files while the recall touches none would be a dialog
  // describing an operation other than the one it runs.
  const { work, home } = scratch()
  writeFileSync(join(work, 'note.md'), 'ORIGINAL')
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const target = session('probe-plan-empty', work)
  openTurn(target, 1, 'change the file')
  await settle(150)
  await toolGate(host, target, 'write')
  toolCall(target, 1, 'write')
  await toolWrite(host, target, join(work, 'note.md'), 'CHANGED')
  closeTurn(target, 1)
  await settle()

  const ordinary = report(await handler({ rawInput: 'plan 1', agent: { session: target, status: 'idle' } })) as {
    restore?: unknown[], remove?: unknown[]
  }
  const messagesOnly = report(await handler({ rawInput: 'plan conversation 1', agent: { session: target, status: 'idle' } })) as {
    restore?: unknown[], remove?: unknown[], skipped?: boolean
  }

  assert.equal((ordinary.restore ?? []).length, 1, 'the ordinary preview should list the file')
  assert.deepEqual(messagesOnly.restore, [], 'the messages-only preview listed a file it will not touch')
  assert.deepEqual(messagesOnly.remove, [])
  assert.equal(messagesOnly.skipped, true)
})
