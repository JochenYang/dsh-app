/**
 * Status tests: every status the settings page renders crosses as a code
 * (never a sentence) — a kernel without the loader seam, the loader's own
 * failure text, and the native runtime's rule rejections.
 *
 * @module plugin-hooks/tests/status
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HooksMountManager } from '../src/mount.ts'
import { NativeHookRuntime } from '../src/native.ts'
import type { HooksBridge } from '../src/wire.ts'

/** A loader seam that either accepts every bridge or fails it with `fail`. */
function fakeLoader(fail?: string): unknown {
  return {
    create: (): Promise<string> => fail === undefined ? Promise.resolve('entry-1') : Promise.reject(new Error(fail)),
    remove: (): Promise<void> => Promise.resolve(),
  }
}

const BRIDGE: HooksBridge = {
  id: 'hook-1',
  dialect: 'claude-code',
  enabled: true,
  configSource: 'file',
  configPath: 'D:/proj/.claude/hooks.json',
}

/** Native rule config, valid by default. */
function rules(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ rules: [{ on: 'pre-tool-use', action: 'block', message: 'x', ...overrides }] })
}

describe('HooksMountManager status', () => {
  it('reports a kernel without the loader seam as a coded unavailable status', () => {
    const manager = new HooksMountManager(() => {}, undefined)
    const status = manager.statusFor(BRIDGE)
    assert.equal(status.state, 'unavailable')
    assert.deepEqual(status.message, { code: 'mount.unavailable' })
  })

  it('reports the loader failure text as the English diagnostic of its code', async () => {
    const manager = new HooksMountManager(() => {}, fakeLoader('ENOENT: D:/proj/.claude/hooks.json'))
    await manager.syncOne(BRIDGE)
    const status = manager.statusFor(BRIDGE)
    assert.equal(status.state, 'error')
    assert.deepEqual(status.message, { code: 'mount.failed', text: 'ENOENT: D:/proj/.claude/hooks.json' })
  })
})

describe('NativeHookRuntime status', () => {
  it('reports a rejected rule as the code its copy lives under', () => {
    const runtime = new NativeHookRuntime(() => {})
    runtime.sync([{ id: 'hook-1', configContent: '{"rules":[{"on":"pre-tool-use","action":"block"}]}' }])
    const status = runtime.statusFor('hook-1')
    assert.equal(status?.state, 'error')
    assert.equal(status?.message?.code, 'native.messageRequired')
  })

  it('reports an overlong matcher as a coded message with the lengths interpolated', () => {
    const runtime = new NativeHookRuntime(() => {})
    runtime.sync([{ id: 'hook-1', configContent: rules({ name: 'wide', matcher: 'a'.repeat(501) }) }])
    const status = runtime.statusFor('hook-1')
    assert.equal(status?.state, 'error')
    assert.equal(status?.message?.code, 'native.matcherTooLong')
    assert.equal(status?.message?.params?.length, 501)
    assert.equal(status?.message?.params?.max, 500)
    assert.equal(status?.message?.params?.name, 'wide')
  })

  it('reports a mounted entry with no message of its own', () => {
    const runtime = new NativeHookRuntime(() => {})
    runtime.sync([{ id: 'hook-1', configContent: rules() }])
    assert.equal(runtime.statusFor('hook-1')?.state, 'mounted')
    assert.equal(runtime.statusFor('hook-1')?.message, undefined)
  })
})
