/**
 * The session-mode entry seam.
 *
 * Every branch here is one a card's press can reach, and none of them may throw:
 * the caller is a React event handler, where a rejection is an unhandled
 * rejection and no copy at all. So the cases are the contract — the services
 * missing (a kernel that does not provide them), a reshaped cycle, the two
 * shapes a Remote rejection arrives in, and a card that passes no directory.
 *
 * The `pending` case is asserted by resolving nothing at all rather than by a
 * flag: `ctx.get` on a context with no services answers undefined, which is
 * exactly the state a card would meet on a kernel without the workspace line.
 *
 * @module plugin-workbench/tests/entry
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createWorkspaceEntry } from '../src/client/entry.ts'

/** One recorded service call. */
interface Calls {
  readonly created: string[]
  readonly opened: string[]
}

/**
 * A context exposing the two services, in the shape the seam reads them.
 *
 * @param workspaces - the `create` face, or undefined to model a kernel without it.
 * @param navigation - the `openWorkspace` face, or undefined likewise.
 * @returns the context, plus the call log both faces append to.
 */
function contextWith(
  workspaces?: { create(input: { path: string }): Promise<{ workspaceId: string }> },
  navigation?: { openWorkspace(workspaceId: string): Promise<void> },
): { ctx: ClientContext; calls: Calls } {
  const created: string[] = []
  const opened: string[] = []
  const services: Record<string, unknown> = {}
  if (workspaces !== undefined) {
    services.workspaces = {
      create: async (input: { path: string }) => {
        created.push(input.path)
        return workspaces.create(input)
      },
    }
  }
  if (navigation !== undefined) {
    services.uiWorkspace = {
      openWorkspace: async (workspaceId: string) => {
        opened.push(workspaceId)
        await navigation.openWorkspace(workspaceId)
      },
    }
  }
  const ctx = { get: (name: string) => services[name] } as unknown as ClientContext
  return { ctx, calls: { created, opened } }
}

/** The ordinary happy path. */
function workingServices(id = 'ws-1'): {
  workspaces: { create(input: { path: string }): Promise<{ workspaceId: string }> }
  navigation: { openWorkspace(workspaceId: string): Promise<void> }
} {
  return {
    workspaces: { create: async () => ({ workspaceId: id }) },
    navigation: { openWorkspace: async () => {} },
  }
}

describe('workbench workspace entry', () => {
  it('creates the workspace, then opens it, and answers ok', async () => {
    const services = workingServices('ws-42')
    const { ctx, calls } = contextWith(services.workspaces, services.navigation)
    assert.equal(await createWorkspaceEntry(ctx)('D:/projects/novel'), 'ok')
    assert.deepEqual(calls.created, ['D:/projects/novel'])
    assert.deepEqual(calls.opened, ['ws-42'])
  })

  it('answers pending while the services are absent, instead of throwing', async () => {
    const { ctx, calls } = contextWith()
    assert.equal(await createWorkspaceEntry(ctx)('D:/projects/novel'), 'pending')
    assert.deepEqual(calls.created, [])
  })

  it('answers pending when only half the cycle is there', async () => {
    const services = workingServices()
    assert.equal(await createWorkspaceEntry(contextWith(undefined, services.navigation).ctx)('D:/x'), 'pending')
    assert.equal(await createWorkspaceEntry(contextWith(services.workspaces, undefined).ctx)('D:/x'), 'pending')
  })

  it('answers pending when a face is present but not callable', async () => {
    // A seam that changed shape answers pending rather than calling undefined.
    const ctx = { get: (name: string) => (name === 'workspaces' ? { create: 'nope' } : { openWorkspace: () => {} }) } as unknown as ClientContext
    assert.equal(await createWorkspaceEntry(ctx)('D:/x'), 'pending')
  })

  it('carries the host code through, in both shapes a Remote call rejects with', async () => {
    const direct = {
      workspaces: { create: async () => { throw Object.assign(new Error('refused'), { code: 'path-not-found' }) } },
      navigation: { openWorkspace: async () => {} },
    }
    assert.equal(await createWorkspaceEntry(contextWith(direct.workspaces, direct.navigation).ctx)('D:/x'), 'error:path-not-found')

    const wrapped = {
      workspaces: { create: async () => { throw { rpcError: { code: 'workspace-exists' } } } },
      navigation: { openWorkspace: async () => {} },
    }
    assert.equal(await createWorkspaceEntry(contextWith(wrapped.workspaces, wrapped.navigation).ctx)('D:/x'), 'error:workspace-exists')
  })

  it('answers unexpected for a rejection carrying no code', async () => {
    const services = {
      workspaces: { create: async () => { throw new Error('boom') } },
      navigation: { openWorkspace: async () => {} },
    }
    assert.equal(await createWorkspaceEntry(contextWith(services.workspaces, services.navigation).ctx)('D:/x'), 'error:unexpected')
  })

  it('refuses an empty directory without calling anything', async () => {
    const services = workingServices()
    const { ctx, calls } = contextWith(services.workspaces, services.navigation)
    const entry = createWorkspaceEntry(ctx)
    assert.equal(await entry(''), 'error:invalid-argument')
    assert.deepEqual(calls.created, [])
    assert.deepEqual(calls.opened, [])
  })

  it('carries a failure from the OPEN step too, not only from create', async () => {
    // The natural "create is the dangerous one, wrap only that" refactor leaves
    // every other case in this file green while an open failure becomes an
    // unhandled rejection inside a click handler — which is the single thing this
    // module exists to prevent. The open step is also the one that really throws
    // in the running app: the frame's own `openWorkspace` rejects after a failed
    // connect.
    const services = {
      workspaces: { create: async () => ({ workspaceId: 'ws-1' }) },
      navigation: { openWorkspace: async () => { throw { rpcError: { code: 'session/create-failed' } } } },
    }
    const { ctx, calls } = contextWith(services.workspaces, services.navigation)
    assert.equal(await createWorkspaceEntry(ctx)('D:/projects/novel'), 'error:session/create-failed')
    assert.deepEqual(calls.opened, ['ws-1'])
  })

  it('opens the workspace the host actually answered, not the one it was asked for', async () => {
    // The two ids differ on purpose: an entry that echoed its input would pass a
    // test where create returns the same string it was handed.
    const services = {
      workspaces: { create: async () => ({ workspaceId: 'canonical' }) },
      navigation: { openWorkspace: async () => {} },
    }
    const { ctx, calls } = contextWith(services.workspaces, services.navigation)
    assert.equal(await createWorkspaceEntry(ctx)('d:/projects/../projects/novel'), 'ok')
    assert.deepEqual(calls.opened, ['canonical'])
  })
})
