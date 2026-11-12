/**
 * Status mapping: the kernel manager's states in the page's terms.
 *
 * The one direction that matters is the conservative one — an unrecognised
 * state must never read as `mounted`, because that is what tells the user their
 * tools are available.
 *
 * @module plugin-mcp/tests/status
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { McpFleetStatus, type ManagedServerView } from '../src/status.ts'
import type { McpServerEntry } from '../src/wire.ts'

const ENTRY: McpServerEntry = {
  id: 'github',
  serverName: 'github',
  transport: 'stdio',
  enabled: true,
  command: 'npx',
}

function fleetOf(status: unknown, name = 'github'): McpFleetStatus {
  const views: ManagedServerView[] = [{ name, configured: true, status }]
  return new McpFleetStatus(() => ({ list: () => views }))
}

describe('fleet status', () => {
  it('reports a connected server as mounted with its tool count', () => {
    assert.deepEqual(fleetOf({ state: 'connected', toolCount: 7, connectedAt: 1 }).statusFor(ENTRY), {
      state: 'mounted',
      toolCount: 7,
    })
  })

  it('reports a disabled entry as disabled without asking the manager', () => {
    const status = fleetOf({ state: 'connected', toolCount: 3 })
    assert.deepEqual(status.statusFor({ ...ENTRY, enabled: false }), { state: 'disabled' })
  })

  it('reports the manager own disabled state', () => {
    assert.deepEqual(fleetOf({ state: 'disabled' }).statusFor(ENTRY), { state: 'disabled' })
  })

  it('reports connecting and reconnecting as starting, not as mounted', () => {
    assert.deepEqual(fleetOf({ state: 'connecting', attempt: 0 }).statusFor(ENTRY), { state: 'starting' })
    assert.deepEqual(fleetOf({ state: 'reconnecting', attempt: 2, delayMs: 1000 }).statusFor(ENTRY), { state: 'starting' })
  })

  it('carries the credential state as a code the client can render', () => {
    const status = fleetOf({ state: 'waiting-credentials', lastError: 'no token' }).statusFor(ENTRY)
    assert.equal(status.state, 'error')
    assert.equal(status.message?.code, 'mount.needsCredentials')
    assert.equal(status.message?.text, 'no token')
  })

  it('carries a load failure with its manager diagnostic as the English text', () => {
    const status = fleetOf({ state: 'failed', reason: 'load', lastError: 'ENOENT npx' }).statusFor(ENTRY)
    assert.equal(status.state, 'error')
    assert.equal(status.message?.code, 'mount.failed')
    assert.equal(status.message?.params?.reason, 'load')
    assert.equal(status.message?.text, 'ENOENT npx')
  })

  it('reports a closed connection as an error', () => {
    const status = fleetOf({ state: 'closed', result: { reason: 'disposed' } }).statusFor(ENTRY)
    assert.equal(status.state, 'error')
    assert.equal(status.message?.code, 'mount.closed')
  })

  it('reads an unknown state as starting', () => {
    assert.deepEqual(fleetOf({ state: 'teleporting' }).statusFor(ENTRY), { state: 'starting' })
    assert.deepEqual(fleetOf(undefined).statusFor(ENTRY), { state: 'starting' })
  })

  it('reports a server the manager does not list as starting', () => {
    assert.deepEqual(fleetOf({ state: 'connected', toolCount: 1 }, 'other').statusFor(ENTRY), { state: 'starting' })
  })

  it('reports an entry it cannot parse as an error, never as disabled', () => {
    // The manager may well have mounted it; saying "disabled" would tell the
    // user their tools are off while they are live.
    const withInvalid = { ...ENTRY, enabled: false, invalid: { code: 'entry.invalid', text: 'bad shape' } }
    const status = fleetOf({ state: 'connected', toolCount: 2 }).statusFor(withInvalid)
    assert.equal(status.state, 'error')
    assert.equal(status.message?.code, 'entry.invalid')
  })

  it('warns about a value the manager will not resolve', () => {
    // `$ENV:` was this plugin's own syntax; the manager resolves
    // `${credential:NAME}`, so a stored `$ENV:` value is a literal now.
    const withLegacy = { ...ENTRY, env: { TOKEN: '$ENV:GITHUB_TOKEN', OK: '${credential:GH}' } }
    const status = fleetOf({ state: 'connected', toolCount: 1 }).statusFor(withLegacy)
    assert.equal(status.state, 'mounted')
    assert.equal(status.warnings?.length, 1)
    assert.equal(status.warnings?.[0]?.code, 'env.legacyRef')
    assert.equal(status.warnings?.[0]?.params?.field, 'env.TOKEN')
  })

  it('reports unavailable when the kernel mounts no manager', () => {
    const status = new McpFleetStatus(() => undefined)
    assert.equal(status.available, false)
    assert.deepEqual(status.statusFor(ENTRY), { state: 'unavailable' })
  })

  it('reports available when a manager is mounted', () => {
    assert.equal(fleetOf({ state: 'connected', toolCount: 0 }).available, true)
  })
})
