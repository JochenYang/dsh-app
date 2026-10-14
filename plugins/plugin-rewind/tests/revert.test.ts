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
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, type Config } from '../src/index.ts'

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
 */
function mount(): {
  host: Context
  handler: (invocation: unknown) => Promise<{ kind: string, text: string }>
} {
  const host = new Context('rewind-test')
  const state: { handler?: (invocation: unknown) => Promise<{ kind: string, text: string }> } = {}
  const ctx = {
    logger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
    effect: (fn: () => unknown) => fn(),
    on: (name: string, listener: unknown, options: unknown) => host.on(name as never, listener as never, options as never),
    inject: (_deps: string[], cb: (scope: unknown) => void) => {
      cb({ get: () => undefined, effect: (fn: () => unknown) => fn() })
    },
    sessionProjections: { register: () => {} },
    commands: { register: (def: { handler: (invocation: unknown) => Promise<{ kind: string, text: string }> }) => { state.handler = def.handler } },
  }
  apply(ctx as never, config())
  return {
    host,
    handler: (invocation) => {
      const handler = state.handler
      if (handler === undefined) throw new Error('the plugin did not register its command')
      return handler(invocation)
    },
  }
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
  const host = new Context('rewind-test-off')
  const state: { handler?: (invocation: unknown) => Promise<{ kind: string, text: string }> } = {}
  const ctx = {
    logger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
    effect: (fn: () => unknown) => fn(),
    on: (name: string, listener: unknown, options: unknown) => host.on(name as never, listener as never, options as never),
    inject: (_deps: string[], cb: (scope: unknown) => void) => {
      cb({ get: () => undefined, effect: (fn: () => unknown) => fn() })
    },
    sessionProjections: { register: () => {} },
    commands: { register: (def: { handler: (invocation: unknown) => Promise<{ kind: string, text: string }> }) => { state.handler = def.handler } },
  }
  apply(ctx as never, config({ snapshotWorkspace: false }))
  const target = session('probe-off', work)
  openTurn(target, 1, 'run a script')
  await toolGate(host, target, 'pwsh')
  toolCall(target, 1, 'pwsh')
  writeFileSync(join(work, 'note.md'), 'SHELL EDIT')
  closeTurn(target, 1)

  const result = await (state.handler as (invocation: unknown) => Promise<{ kind: string, text: string }>)({
    rawInput: '1', agent: { session: target, status: 'idle' },
  })
  const files = report(result).files as { coverage: string }
  assert.equal(files.coverage, 'none', 'a shell range with snapshots off is not covered')
  await rm(work, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})
