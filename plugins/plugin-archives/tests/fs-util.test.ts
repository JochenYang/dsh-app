/**
 * Behavioral tests for the Windows removal retry.
 *
 * What is load-bearing here:
 *   - a read-only file (the attribute an editor or an installer leaves behind) is
 *     removed: the retry clears it instead of reporting EPERM;
 *   - a failure a later attempt can outlast is retried and then succeeds;
 *   - a failure that never clears gives up inside its budget and reports ONE
 *     stable code — the two bounds are what keep a delete from hanging;
 *   - a non-retryable failure (a path that is not there as a tree, a permission
 *     error a retry cannot change) is not retried at all.
 *
 * ## Why the fault injection looks like this
 *
 * The module calls `fs/promises` through one namespace object, so substituting a
 * property of that object replaces `rm` for this module and nothing else (the
 * same idiom `tests/trash.test.ts` uses, and the reason both modules import the
 * namespace rather than named bindings). Every substitution is restored in a
 * `finally`. `sleep` is injected everywhere, so no test spends real time on a
 * backoff.
 *
 * @module @dsh-app/plugin-archives/tests/fs-util
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeleteError, deleteErrorCode, isRetryableDeleteError, rmWithRetry } from '../src/fs-util.ts'

/** Scratch roots this run created, removed when it finishes. */
const created: string[] = []

after(async () => {
  for (const dir of created.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

/** The `fs/promises` exports object the module under test calls through. */
const fsSurface = createRequire(import.meta.url)('node:fs/promises') as Record<string, unknown>

/** The real `rm`, captured before any test substitutes one. */
const originalRm = fsp.rm

/** Run `body` with `rm` substituted, restoring it afterwards. */
async function withRm(substitute: unknown, body: () => Promise<void>): Promise<void> {
  const original = fsSurface.rm
  fsSurface.rm = substitute
  try {
    await body()
  } finally {
    fsSurface.rm = original
  }
}

/** A lock failure of the kind an indexer or an antivirus produces. */
function busy(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EBUSY: resource busy or locked, rm '${path}'`), { code: 'EBUSY' })
}

/** A directory holding one file, inside a fresh temporary root. */
async function fixture(): Promise<{ root: string; tree: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dshar-rm-'))
  created.push(root)
  const tree = join(root, 'tree')
  await mkdir(join(tree, 'nested'), { recursive: true })
  const file = join(tree, 'nested', 'session.jsonl')
  await writeFile(file, 'x')
  await writeFile(join(tree, 'top.jsonl'), 'x')
  return { root, tree, file }
}

/** A sleep that spends no time but records every delay. */
function fakeSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => { delays.push(ms) },
  }
}

test('a read-only file inside the tree is removed', async () => {
  const { tree, file } = await fixture()
  await chmod(file, 0o444)

  await rmWithRetry(tree)

  assert.equal(existsSync(tree), false, 'the tree is gone, read-only attribute and all')
})

test('a busy tree is retried and then succeeds', async () => {
  const { tree } = await fixture()
  const { delays, sleep } = fakeSleep()
  let calls = 0

  await withRm(async (path: string, options?: unknown) => {
    calls += 1
    if (calls === 1) throw busy(path)
    return (originalRm as unknown as (p: string, o?: unknown) => Promise<void>)(path, options)
  }, async () => {
    await rmWithRetry(tree, { sleep })
  })

  assert.equal(calls, 2, 'one retry was enough')
  assert.deepEqual(delays, [20], 'and it waited the first backoff step, not a fixed one')
  assert.equal(existsSync(tree), false)
})

test('a failure that never clears gives up inside its budget', async () => {
  const { tree } = await fixture()
  const { delays, sleep } = fakeSleep()
  let calls = 0

  let thrown: unknown
  await withRm(async (path: string) => {
    calls += 1
    throw busy(path)
  }, async () => {
    try {
      await rmWithRetry(tree, { attempts: 4, baseDelayMs: 10, sleep })
    } catch (error) {
      thrown = error
    }
  })

  assert.equal(deleteErrorCode(thrown), 'fs-rm-failed', 'one stable code, not the raw errno')
  assert.ok(thrown instanceof DeleteError)
  assert.equal(thrown.attempts, 4, 'the error says how many attempts were made')
  assert.equal(calls, 4, 'and no more than the budget were made')
  assert.deepEqual(delays, [10, 20, 40], 'the backoff doubles up to the attempt budget')
  assert.equal(thrown.path, tree, 'the error names the path, so a caller can report residue')
  assert.equal((thrown.cause as { code?: string }).code, 'EBUSY', 'and keeps the last errno as its cause')
  assert.equal(isRetryableDeleteError(thrown.cause), true)
  assert.equal(existsSync(tree), true, 'a failed removal leaves the bytes where they were')
})

test('a failure a retry cannot change is not retried', async () => {
  const { tree } = await fixture()
  const { delays, sleep } = fakeSleep()
  let calls = 0

  let thrown: unknown
  await withRm(async () => {
    calls += 1
    throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' })
  }, async () => {
    try {
      await rmWithRetry(tree, { sleep })
    } catch (error) {
      thrown = error
    }
  })

  assert.equal(calls, 1, 'a deterministic failure is reported on the first attempt')
  assert.deepEqual(delays, [], 'with no waiting at all')
  assert.equal(deleteErrorCode(thrown), 'fs-rm-failed')
})

test('a removal whose target is already gone is a success', async () => {
  const { root } = await fixture()
  const missing = join(root, 'never-existed')
  await rmWithRetry(missing)
  const dir = join(root, 'empty')
  await mkdir(dir)
  await rmWithRetry(dir)
  await rmWithRetry(dir)
  assert.equal(existsSync(missing), false)
  assert.equal(existsSync(dir), false, 'and a second removal of the same path is a no-op')
})
