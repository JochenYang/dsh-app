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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, MAX_PREVIEW_SIDE_CHARS, type Config } from '../src/index.ts'
import type { RewindParticipantRegistry } from '../src/participants.ts'
import { readSnapshot } from '../src/trees.ts'

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
  // A small preview keeps the exact shape it had before the budgets: no marker
  // field on a row (which would render a needless label), no `omitted` count on
  // the plan (which would print "0 more files"), and the same key set the client
  // already reads.
  assert.deepEqual(
    Object.keys(planned.restore?.[0] ?? {}),
    ['path', 'action', 'current', 'next'],
    'a row that needed no cap must gain no field',
  )
  assert.deepEqual(
    Object.keys(planned as Record<string, unknown>),
    ['code', 'ok', 'n', 'prompt', 'stoppedAtCompaction', 'restore', 'remove', 'unrestorable', 'coverage', 'tools'],
    'a fully listed plan must gain no omitted count',
  )
  assert.equal('omitted' in (planned as Record<string, unknown>), false)
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a large file previews each side up to the cap and marks it truncated', async () => {
  // The dialog renders 24 diff lines at most, so whole-file text was pure payload
  // weight — and that payload is appended to the session log verbatim. This pins
  // the host's own wiring of the per-side cap, not just the pure helper.
  const { work, home } = scratch()
  const line = `${'x'.repeat(79)}\n`
  const big = line.repeat(1_400)
  writeFileSync(join(work, 'a.ts'), big)
  writeFileSync(join(work, 'b.ts'), big)
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const target = session('probe-plan-big', work)
  openTurn(target, 1, 'rewrite both files')
  await toolGate(host, target, 'pwsh')
  toolCall(target, 1, 'pwsh')
  writeFileSync(join(work, 'a.ts'), big.replaceAll('x', 'y'))
  writeFileSync(join(work, 'b.ts'), big.replaceAll('x', 'z'))
  closeTurn(target, 1)
  await settle()

  const planned = report(await handler({ rawInput: 'plan 1', agent: { session: target, status: 'idle' } })) as {
    restore?: readonly {
      path: string
      current?: string
      next?: string
      currentTruncated?: boolean
      nextTruncated?: boolean
    }[]
  }
  assert.equal(planned.restore?.length, 2)
  for (const row of planned.restore ?? []) {
    assert.ok(row.current !== undefined, `${row.path}: the current side is still shown`)
    assert.ok(row.next !== undefined, `${row.path}: the restored side is still shown`)
    assert.ok(row.current.length <= MAX_PREVIEW_SIDE_CHARS, `${row.path}: current is over the cap`)
    assert.ok(row.next.length <= MAX_PREVIEW_SIDE_CHARS, `${row.path}: next is over the cap`)
    assert.equal(row.currentTruncated, true)
    assert.equal(row.nextTruncated, true)
  }
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a binary file is marked as not previewable instead of silently showing a path', async () => {
  // Before the markers, a file whose text cannot be decoded produced a row with a
  // path and nothing else — which reads as "this file is unchanged", the opposite
  // of what the row means. The recall still restores it; only the diff is absent.
  const { work, home } = scratch()
  const before = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00, 0x11])
  const after = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00, 0x99])
  writeFileSync(join(work, 'sprite.png'), before)
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const target = session('probe-plan-binary', work)
  openTurn(target, 1, 'regenerate the sprite sheet')
  await toolGate(host, target, 'pwsh')
  toolCall(target, 1, 'pwsh')
  writeFileSync(join(work, 'sprite.png'), after)
  closeTurn(target, 1)
  await settle()

  const planned = report(await handler({ rawInput: 'plan 1', agent: { session: target, status: 'idle' } })) as {
    restore?: readonly {
      path: string
      current?: string
      next?: string
      currentOmitted?: boolean
      nextOmitted?: boolean
    }[]
  }
  const row = planned.restore?.find((candidate) => candidate.path === join(work, 'sprite.png'))
  assert.ok(row !== undefined, 'the binary file is still listed for restore')
  assert.equal(row.currentOmitted, true)
  assert.equal(row.nextOmitted, true)
  assert.equal(row.current, undefined)
  assert.equal(row.next, undefined)
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a file deleted in the range previews as empty -> old bytes, not as not-previewable', async () => {
  // A deletion inside the range is a change the recall undoes. Treated as "no
  // text could be produced", it lost its diff affordance and read as "not
  // previewed"; the right preview is the whole file shown as added.
  const { work, home } = scratch()
  writeFileSync(join(work, 'gone.md'), 'ORIGINAL CONTENT')
  process.env.DSH_HOME = home
  const { host, handler } = mount()
  const target = session('probe-plan-deleted', work)
  openTurn(target, 1, 'delete it')
  await toolGate(host, target, 'pwsh')
  toolCall(target, 1, 'pwsh')
  await rm(join(work, 'gone.md'), { force: true })
  closeTurn(target, 1)
  await settle()

  const planned = report(await handler({ rawInput: 'plan 1', agent: { session: target, status: 'idle' } })) as {
    restore?: readonly {
      path: string
      current?: string
      next?: string
      currentOmitted?: boolean
      nextOmitted?: boolean
      textOmitted?: boolean
    }[]
  }
  const row = planned.restore?.find((candidate) => candidate.path === join(work, 'gone.md'))
  assert.ok(row !== undefined, 'a deleted file is still listed for restore')
  assert.equal(row.current, '', 'the current side is empty, so the diff shows the whole file as added')
  assert.equal(row.next, 'ORIGINAL CONTENT')
  assert.equal(row.currentOmitted, undefined, 'a gone file is not an unreadable one')
  assert.equal(row.nextOmitted, undefined)
  assert.equal(row.textOmitted, undefined)
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

// --- The capture gate's turn rule. ---
//
// A snapshot only ever describes a turn's START. The claim is released when a
// walk comes back incomplete so the first tool gate can retry — and that release
// used to reopen the door for EVERY later tool gate, so the manifest was walked
// again after tools had already written, and `latestSnapshotBefore` then handed
// a mid-turn tree to a recall as the range's starting point. On a repository
// whose snapshot is never complete (this one: 61,788 files / 4.2 GB in scope,
// 499 of 1,013 manifests partial) it also paid a walk plus a copy at every tool
// call.

/** Drive the turn boundary the way the session's own event feed does. */
function turnStart(host: Context, target: Session, turn: number): void {
  host.emit('session/event' as never, target as never, { type: 'turn/start', data: { turn } } as never)
}

/** A workspace whose every capture is partial: the walk stops on `file-count`. */
function partialWork(): { work: string, home: string } {
  const { work, home } = scratch()
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(join(work, `f${String(i)}.ts`), `export const v = ${String(i)}\n`)
  }
  return { work, home }
}

test('a partial turn-start snapshot is retried by the FIRST tool gate', async () => {
  const { work, home } = partialWork()
  process.env.DSH_HOME = home
  const { host } = mount(config({ maxSnapshotFiles: 1 }))
  const target = session('probe-gate-retry', work)
  // The gate derives its turn from the session LOG (`turnAt`), so the turn has to
  // exist there; the emit is what drives the boundary listener itself.
  openTurn(target, 1, 'first')
  turnStart(host, target, 1)
  await settle()
  const first = await readSnapshot(home, 'probe-gate-retry', 1)
  assert.ok(first !== undefined, 'the turn boundary captured')
  assert.equal(first.complete, false, 'the cap must leave it partial for this case')

  // No tool has run yet, so a cold-disk partial walk is worth one more attempt:
  // that is the recovery path this gate exists for.
  await toolGate(host, target, 'write')
  const second = await readSnapshot(home, 'probe-gate-retry', 1)
  assert.ok(second !== undefined)
  assert.notEqual(second.at, first.at, 'the first tool gate retried the partial walk')
  assert.equal(second.complete, false, 'the retry is still partial — the cap did not move')
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('once a tool of the turn has run, a partial snapshot is never re-captured', async () => {
  const { work, home } = partialWork()
  process.env.DSH_HOME = home
  const { host } = mount(config({ maxSnapshotFiles: 1 }))
  const target = session('probe-gate-once', work)
  openTurn(target, 1, 'first')
  turnStart(host, target, 1)
  await settle()
  await toolGate(host, target, 'write')
  const settled = await readSnapshot(home, 'probe-gate-once', 1)
  assert.ok(settled !== undefined)
  assert.equal(settled.complete, false, 'the fixture must stay partial')

  // A tool of this turn has RUN. A new walk now records a mid-turn tree under
  // turn 1, which a recall of turn 1 would hand back as its starting state, so
  // the manifest must keep exactly what it has.
  await settle()
  await toolGate(host, target, 'pwsh')
  const after = await readSnapshot(home, 'probe-gate-once', 1)
  assert.ok(after !== undefined)
  assert.equal(after.at, settled.at, 'the capture was re-taken after a tool of the turn ran')
  assert.deepEqual(after.entries, settled.entries)
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a tool gate joins a capture already claimed instead of starting another', async () => {
  // The one case where the rule WAITS rather than skips: a claim exists (the turn
  // boundary's walk is still reading), so the tool must not write beside it. The
  // fixture's files are big enough that the walk outlives the gate's own return
  // by far when it is NOT joined, which is what the assertion below detects.
  const { work, home } = scratch()
  const outside = mkdtempSync(join(tmpdir(), 'rewind-gate-out-'))
  const payload = 'z'.repeat(3 * 1024 * 1024)
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(join(work, `b${String(i)}.bin`), `${String(i).padStart(2, '0')}${payload.slice(2)}`)
  }
  try {
    symlinkSync(outside, join(work, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    // A platform that will not let this process create a link: the partial
    // snapshot this case needs cannot be built here.
    await rm(work, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    return
  }
  process.env.DSH_HOME = home
  const { host } = mount()
  const target = session('probe-gate-join', work)
  openTurn(target, 1, 'first')

  turnStart(host, target, 1)
  await settle(600)
  await toolGate(host, target, 'write')
  const settled = await readSnapshot(home, 'probe-gate-join', 1)
  assert.ok(settled !== undefined)
  assert.equal(settled.complete, false, 'the link is what leaves the claim released')

  // A second turn boundary starts a slow walk and does not await it. A tool of
  // the turn has already run, so the gate must JOIN that walk: wait for it, and
  // not walk again. Both halves are observed here — the gate must still be
  // pending when the in-flight walk writes its manifest, and that exact manifest
  // must be the one on disk afterwards. A second walk would replace it with a
  // later `at`, which `joined.at !== settled.at` alone would have accepted.
  turnStart(host, target, 1)
  let gateResolved = false
  const gate = toolGate(host, target, 'pwsh').then(() => { gateResolved = true })
  let inflightAt: number | undefined
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const now = await readSnapshot(home, 'probe-gate-join', 1)
    if (now !== undefined && now.at !== settled.at) {
      inflightAt = now.at
      break
    }
    assert.equal(gateResolved, false, 'the gate resolved before the in-flight walk wrote: it skipped instead of joining')
    await settle(5)
  }
  await gate
  assert.ok(inflightAt !== undefined, 'the in-flight walk wrote its manifest while the gate was pending')
  const joined = await readSnapshot(home, 'probe-gate-join', 1)
  assert.ok(joined !== undefined)
  assert.equal(joined.at, inflightAt, 'no second walk replaced the manifest the gate joined')
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('a new turn is captured again', async () => {
  const { work, home } = scratch()
  writeFileSync(join(work, 'a.ts'), 'v0')
  process.env.DSH_HOME = home
  const { host } = mount()
  const target = session('probe-gate-turn', work)
  openTurn(target, 1, 'first')
  await toolGate(host, target, 'write')
  const turn1 = await readSnapshot(home, 'probe-gate-turn', 1)
  assert.ok(turn1 !== undefined)
  assert.equal(turn1.complete, true)
  await settle()
  await toolGate(host, target, 'write')
  assert.equal((await readSnapshot(home, 'probe-gate-turn', 1))?.at, turn1.at, 'the finished turn is not walked again')

  writeFileSync(join(work, 'a.ts'), 'v1')
  openTurn(target, 2, 'second')
  await toolGate(host, target, 'write')
  const turn2 = await readSnapshot(home, 'probe-gate-turn', 2)
  assert.ok(turn2 !== undefined, 'a new turn gets its own snapshot')
  assert.equal(turn2.complete, true)
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

test('a first attempt that throws is retried by the first tool gate', async () => {
  const { work, home } = scratch()
  writeFileSync(join(work, 'a.ts'), 'CONTENT')
  process.env.DSH_HOME = home
  // A file where the manifest directory has to be: the capture stores its blobs
  // and then fails to write, which is the failure the turn-start path logs.
  mkdirSync(join(home, 'storages', 'dsh-app-plugin-rewind'), { recursive: true })
  const blocker = join(home, 'storages', 'dsh-app-plugin-rewind', 'trees')
  writeFileSync(blocker, 'not a directory')
  const { host, warnings } = mount()
  const target = session('probe-gate-throw', work)
  openTurn(target, 1, 'first')

  turnStart(host, target, 1)
  await settle(150)
  assert.ok(
    warnings.some((line) => line.includes('turn-start snapshot failed')),
    'the turn-start attempt failed and said so',
  )
  assert.equal(await readSnapshot(home, 'probe-gate-throw', 1), undefined)

  await rm(blocker)
  // No tool has run yet, so the failure is the other case worth one retry.
  await toolGate(host, target, 'write')
  const snapshot = await readSnapshot(home, 'probe-gate-throw', 1)
  assert.ok(snapshot !== undefined, 'the first tool gate recovered the snapshot')
  assert.equal(snapshot.complete, true)
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})
