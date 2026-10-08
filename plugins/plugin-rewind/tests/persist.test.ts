/**
 * Regression gate: the recall placeholder must survive the kernel's PERSISTENCE
 * validator, not merely the in-memory `append`.
 *
 * This is the test whose absence shipped a data-corrupting bug. `session.append`
 * validates the surface only, so a `system/message` placeholder was accepted and
 * written — and then the session failed to load with
 *
 *   SessionFormatError: system/message does not match an open turn and step
 *
 * because a persisted system message must match the CURRENTLY OPEN turn and
 * step, and a recall runs while the agent is idle. The fix is a `user/message`
 * placeholder, which carries no such requirement.
 *
 * The validator lives in the kernel RUNTIME tree, which is not a dependency of
 * this package. When no runtime tree is present the test reports that it cannot
 * run rather than passing silently — the same convention
 * `test/plugin-kernel-imports.test.mjs` uses for an absent kernel.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { placeholderData, planCut } from '../src/cut.ts'

/**
 * Candidate runtime trees, nearest first.
 *
 * The test runs from the plugin's `.test-dist/` output, so the repo root is
 * three levels up (`.test-dist` → plugin → `plugins` → root).
 */
const CANDIDATES = [
  '../../../scratch/kernel-api-probe/rt-full/runtime/app/node_modules/@deepseek-ai',
  '../../../runtime-dist/work/runtime/app/node_modules/@deepseek-ai',
]

/** The first runtime tree that carries the format validator, or null. */
function findRuntime() {
  for (const candidate of CANDIDATES) {
    const url = new URL(`${candidate}/dsh-session-format-v3-to-v4/lib/index.js`, import.meta.url)
    if (existsSync(url)) return new URL(`${candidate}/`, import.meta.url)
  }
  return null
}

const runtime = findRuntime()

if (runtime === null) {
  test('persistence gate cannot run (no kernel runtime tree present)', () => {
    console.log('plugin-rewind persistence gate: SKIPPED — no runtime tree found.')
    console.log('Extract a runtime with: tar -xzf runtime-dist/dsh-runtime-*.tgz -C scratch/kernel-api-probe/rt-full')
  })
} else {
  // Import through file URLs directly: `pathname` on Windows yields a leading
  // slash (`/D:/...`) which then resolves as a bogus `D:\D:\...` path.
  const { Session, SessionSeq } = await import(new URL('dsh-session/lib/index.js', runtime).href)
  const {
    assertReleasedV4Relationships,
    RELEASED_V3_EVENT_TYPES,
  } = await import(new URL('dsh-session-format-v3-to-v4/lib/index.js', runtime).href)

  /**
   * A minimal VALID session: the system head is appended INSIDE the first turn
   * and step, which is the real ordering (measured from a live log with
   * `scratch/dump-session.mjs`). Two turns follow, and the log ends at a turn
   * boundary — the state a recall is possible in.
   */
  function buildSession() {
    const s = Session.create('gate-persist')
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('system/message', {
      turn: 1, step: 1,
      message: { id: 'sys-0', role: 'system', content: [{ type: 'text', text: 'SYSTEM' }], source: { kind: 'system-prompt' } },
    }, { surfaceOp: 'append' })
    s.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'KEEP' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'kept' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1 })
    s.append('turn/start', { turn: 2 })
    s.append('step/start', { turn: 2, step: 1 })
    s.append('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'RECALL ME' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', {
      turn: 2, step: 1,
      message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 2, step: 1 })
    s.append('turn/end', { turn: 2 })
    return s
  }

  /** Validate the log the way the persistence read path does. */
  function validate(session) {
    assertReleasedV4Relationships({
      events: session.ownEvents(),
      header: session.header,
      inheritedEventCount: 0,
    }, RELEASED_V3_EVENT_TYPES)
  }

  test('the baseline fixture is itself a valid artifact', () => {
    // A fixture that does not validate would make every assertion below vacuous.
    validate(buildSession())
  })

  test('a recall placeholder survives the persistence validator', () => {
    const session = buildSession()
    const plan = planCut(session, 1)
    assert.equal('reason' in plan, false)
    if ('reason' in plan) return
    session.append('user/message', placeholderData(), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(plan.startSeq), endSeq: SessionSeq(plan.endSeq) },
      sourceEventSeqs: plan.shadowedSeqs.map((seq) => SessionSeq(seq)),
    })
    validate(session)
  })

  test('the citation list is flat, dense, and made of real sequences', () => {
    // A nested pair ([start, end]) sitting where its two integers belong passes
    // any hand-written turn/step replay and is rejected only by the persistence
    // validator:
    //
    //   sourceEventSeqs must densely contain non-negative safe integers
    //
    // which is how one session on this machine became unloadable. Pin the shape
    // AND the density: every shadowed surface node must be cited, because a
    // partial citation is refused by the surface fold in its own message.
    const session = buildSession()
    const plan = planCut(session, 1)
    if ('reason' in plan) return assert.fail('expected a plan')

    for (const seq of plan.shadowedSeqs) {
      assert.equal(typeof seq, 'number', `cited sequence is not a number: ${JSON.stringify(seq)}`)
      assert.ok(
        Number.isSafeInteger(seq) && seq >= 0,
        `cited sequence is not a non-negative safe integer: ${JSON.stringify(seq)}`,
      )
    }
    // `SessionSeq` is the kernel's own guard and THROWS on anything else, so a
    // nested value cannot reach the log through the call path `index.ts` uses.
    assert.throws(() => SessionSeq(plan.shadowedSeqs), TypeError)

    const replacement = session.append('user/message', placeholderData(), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(plan.startSeq), endSeq: SessionSeq(plan.endSeq) },
      sourceEventSeqs: plan.shadowedSeqs.map((seq) => SessionSeq(seq)),
    })
    const written = session.eventAt(replacement.seq)?.sourceEventSeqs
    assert.deepEqual(written, [...plan.shadowedSeqs])
  })

  test('a system/message placeholder FAILS persistence — the bug this guards', () => {
    // Pins the mechanism, so the fix cannot be reverted by "simplifying" the
    // placeholder back to a system message.
    const session = buildSession()
    const plan = planCut(session, 1)
    if ('reason' in plan) return assert.fail('expected a plan')
    session.append('system/message', {
      turn: plan.turn ?? 0,
      step: 1,
      message: { id: 'ph', role: 'system', content: [], source: { kind: 'system-prompt' } },
    }, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(plan.startSeq), endSeq: SessionSeq(plan.endSeq) },
      sourceEventSeqs: plan.shadowedSeqs.map((seq) => SessionSeq(seq)),
    })
    assert.throws(() => validate(session), /does not match an open turn and step/)
  })
}

test('the placeholder is not itself recallable', () => {
  // It carries a producer-owned source kind, and the anchor rule accepts only
  // `kind: 'user'`, so a recalled range cannot offer the placeholder as a new
  // recall point.
  const placeholder = placeholderData()
  assert.equal(placeholder.source.kind, 'dsh-app-rewind')
  assert.equal(placeholder.content.length, 0)
})
