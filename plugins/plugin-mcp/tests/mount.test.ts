/**
 * Mount-status tests: every status the settings page renders crosses as a code
 * (never a sentence) — the kernel-without-loader case, the loader's own failure
 * text, and the `$ENV:` resolution warnings.
 *
 * @module plugin-mcp/tests/mount
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { McpMountManager } from '../src/mount.ts'
import type { McpServerEntry } from '../src/wire.ts'

/** A loader seam that either accepts every entry or fails it with `fail`. */
function fakeLoader(fail?: string): unknown {
  return {
    create: (): Promise<string> => fail === undefined ? Promise.resolve('entry-1') : Promise.reject(new Error(fail)),
    remove: (): Promise<void> => Promise.resolve(),
    update: (): Promise<unknown> => Promise.resolve(undefined),
  }
}

function entry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return { id: 'mcp-1', serverName: 'github', transport: 'stdio', enabled: true, command: 'npx', ...overrides }
}

describe('McpMountManager status', () => {
  it('reports a kernel without the loader seam as a coded unavailable status', () => {
    const manager = new McpMountManager(() => {}, undefined, undefined)
    const status = manager.statusFor(entry())
    assert.equal(status.state, 'unavailable')
    assert.deepEqual(status.message, { code: 'mount.unavailable' })
  })

  it('reports the loader failure text as the English diagnostic of its code', async () => {
    const manager = new McpMountManager(() => {}, fakeLoader('ENOENT: npx not found'), undefined)
    await manager.syncOne(entry())
    const status = manager.statusFor(entry())
    assert.equal(status.state, 'error')
    assert.deepEqual(status.message, { code: 'mount.failed', text: 'ENOENT: npx not found' })
  })

  it('reports $ENV: warnings as codes carrying the values they interpolate', async () => {
    process.env.DSH_MCP_TEST_SET = 'value'
    delete process.env.DSH_MCP_TEST_UNSET
    try {
      const manager = new McpMountManager(() => {}, fakeLoader(), undefined)
      const target = entry({
        env: {
          GOOD: '$ENV:DSH_MCP_TEST_SET',
          MISSING: '$ENV:DSH_MCP_TEST_UNSET',
          INLINE: 'Bearer $ENV:TOKEN',
        },
      })
      await manager.syncOne(target)
      const status = manager.statusFor(target)
      assert.equal(status.state, 'mounted')
      assert.deepEqual(status.warnings, [
        { code: 'env.missing', params: { name: 'DSH_MCP_TEST_UNSET' } },
        { code: 'env.inlineRef', params: { value: 'Bearer $ENV:TOKEN' } },
      ])
    } finally {
      delete process.env.DSH_MCP_TEST_SET
    }
  })
})
