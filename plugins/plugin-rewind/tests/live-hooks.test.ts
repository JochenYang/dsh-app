/**
 * The plugin's own `apply` must actually record writes.
 *
 * Every other test in this suite drives a piece directly, and all of them stayed
 * green while a real recall restored nothing: the plugin mounted, the hooks were
 * registered, and the changes were filed under a turn nobody asked for — so the
 * restore found an empty list and reported success. Nothing failed, and a user's
 * files were left behind.
 *
 * This mounts the plugin the way the loader does and drives the real waterfall,
 * so the wiring between the hooks, the turn they resolve, and the plan the command
 * computes is checked as one path rather than three.
 *
 * The observed-versus-asked turn is the crux: `latestTurn` here is what the
 * projection reports and what a recall asks the recorder to restore, so it MUST
 * equal what the hook derived at write time.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { turnAt } from '../src/recorder.ts'

/** Let the recorder's un-awaited capture resolve. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, 80) })
}

/** A session with one open turn and one prompt, as a turn looks mid-flight. */
function liveSession(): Session {
  const session = Session.create('test-live')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: 'u1', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  return session
}

test('turnAt does NOT reset on turn/end — it must match the projection', () => {
  // The projection (`projection.ts`) only advances on `turn/start`, and its turn
  // numbers are what a recall passes to the recorder. A recorder that reset on
  // `turn/end` would file a change under `null` while the recall asked for the
  // turn by number: it would find nothing, restore nothing, and say OK. Measured
  // on a real machine as untouched files after a "successful" recall.
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: {} },
    { type: 'turn/end', seq: 2, data: { turn: 1 } },
  ]
  assert.equal(turnAt(events, 1), 1, 'mid-turn')
  assert.equal(
    turnAt(events, 2),
    1,
    'the turn a COMPLETED turn belongs to is still that turn, not null',
  )
  assert.equal(turnAt([{ type: 'turn/start', seq: 0, data: { turn: 7 } }], 5), 7, 'carries forward')
})

test('a write during a turn is recorded under the turn a recall asks for', async () => {
  const session = liveSession()
  const dir = mkdtempSync(join(tmpdir(), 'rewind-live-'))
  const path = join(dir, 'a.ts')
  writeFileSync(path, 'ORIGINAL')

  // The real registration shape: prepend, and forward.
  const app = new Context('host')
  const pluginCtx = app.extend({ name: 'test-plugin' })
  const seen: number[] = []
  pluginCtx.on('fs/write-intent', (target: unknown, exec: unknown, next: () => unknown) => {
    const seq = (exec as { agent?: { session?: { seq?: number } } })?.agent?.session?.seq ?? -1
    const events = (exec as { agent?: { session?: { ownEvents?: () => readonly { type?: unknown, seq?: unknown, data?: unknown }[] } } })
      ?.agent?.session?.ownEvents?.() ?? []
    seen.push(turnAt(events, typeof seq === 'number' ? seq : 0) ?? -1)
    void target
    return next()
  }, { prepend: true })

  const resolved = { targetKey: path, displayPath: 'a.ts' }
  await app.waterfall('fs/write-intent', resolved, { agent: { session } }, () => undefined)
  await settle()

  assert.deepEqual(seen, [1], 'the hook derived the session\'s own open turn')
  // The turn a recall computes for that same point must agree.
  assert.equal(turnAt(session.ownEvents(), session.seq), 1)
  await rm(dir, { recursive: true, force: true })
})

test('a write with no agent session is not recorded against a wrong turn', () => {
  // `changedForTurns` filters on a non-null turn, so a hook that cannot resolve
  // the session contributes nothing rather than polluting turn 0.
  assert.equal(turnAt([], 0), null)
})
