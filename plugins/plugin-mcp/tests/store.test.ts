/**
 * The fleet store: CRUD over the `mcp-manager` row's `config.servers`.
 *
 * What these pin, and why each one matters:
 *
 * - a write MERGES into the raw map, so an entry this version cannot validate is
 *   never dropped from the user's document by an edit made here;
 * - the key is the identity (`serverName`), because the manager derives the tool
 *   namespace from it — a rename is refused rather than silently moving tools;
 * - the effective map is `override.servers ?? inherited.servers`, so a profile
 *   layer that pins servers still shows up, and the first write retains them.
 *
 * @module plugin-mcp/tests/store
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { MANAGER_ROW_ID, McpStore, type ConfigEditorLike, type ConfigRow } from '../src/store.ts'
import { McpValidationError } from '../src/wire.ts'

interface FakeEditor {
  readonly editor: ConfigEditorLike
  readonly document: Record<string, unknown>
  readonly writes: number
}

/**
 * A config document in memory, shaped the way the kernel's editor reports it.
 * @param initial - the `servers` map the row starts with.
 * @param inherited - a composed layer the row inherits from, when testing that.
 */
function fakeEditor(
  initial: Record<string, unknown> = {},
  inherited?: Record<string, unknown>,
  /** True when the row itself declares no `servers` key (the inherited case). */
  rowHasNoServers = false,
): FakeEditor {
  const document: Record<string, unknown> = rowHasNoServers ? {} : { servers: initial }
  const row: ConfigRow = { options: { id: MANAGER_ROW_ID } }
  const state = { writes: 0 }
  const editor: ConfigEditorLike = {
    entries: () => [row],
    configuration: () => [{ entry: row, inherited: inherited ?? {}, override: document }],
    edit: async (_entry, change) => {
      state.writes += 1
      const next = change({ ...document }, inherited ?? {})
      for (const key of Object.keys(document)) Reflect.deleteProperty(document, key)
      Object.assign(document, next)
    },
  }
  return {
    editor,
    document,
    get writes() { return state.writes },
  }
}

describe('reading', () => {
  it('projects every configured key onto an entry, keyed by its name', () => {
    const fake = fakeEditor({ github: { transport: 'stdio', command: 'npx', args: ['-y', 'x'], enabled: true } })
    const store = new McpStore(fake.editor, true, () => {})
    const file = store.load()
    assert.equal(file.servers.length, 1)
    assert.equal(file.servers[0]?.id, 'github')
    assert.equal(file.servers[0]?.serverName, 'github')
    assert.equal(file.servers[0]?.command, 'npx')
    assert.deepEqual(file.servers[0]?.args, ['-y', 'x'])
  })

  it('reports this plugin master switch, not a stored one', () => {
    const fake = fakeEditor({})
    assert.equal(new McpStore(fake.editor, true, () => {}).load().enabled, true)
    assert.equal(new McpStore(fake.editor, false, () => {}).load().enabled, false)
  })

  it('falls back to the inherited layer when the profile row has no servers', () => {
    const fake = fakeEditor({}, { servers: { pinned: { transport: 'stdio', command: 'pinned' } } }, true)
    const store = new McpStore(fake.editor, true, () => {})
    assert.deepEqual(store.load().servers.map((entry) => entry.serverName), ['pinned'])
  })

  it('SHOWS an entry it cannot validate, marked invalid, instead of hiding it', () => {
    const fake = fakeEditor({ broken: { transport: 'stdio' }, good: { transport: 'stdio', command: 'npx' } })
    const store = new McpStore(fake.editor, true, () => {})
    const names = store.load().servers.map((entry) => entry.serverName).sort()
    // The manager may have mounted `broken` and its tools are live: dropping the
    // row would make the page under-report a running fleet with no way to act.
    assert.deepEqual(names, ['broken', 'good'])
    const broken = store.load().servers.find((entry) => entry.serverName === 'broken')
    // The marker carries the validator's own code, so the client's existing copy
    // renders it instead of an English diagnostic.
    assert.equal(broken?.invalid?.code, 'stdio.commandRequired')
    // And the whole raw entry is projected, so the form can show what is wrong.
    assert.deepEqual((broken as unknown as { env?: unknown }).env, undefined)
  })

  it('is unavailable rather than throwing when the kernel mounts no editor', () => {
    const store = new McpStore(undefined, true, () => {})
    assert.equal(store.available, false)
    assert.deepEqual(store.load().servers, [])
  })
})

describe('writing', () => {
  it('applies the change to the document as it is at write time, not to an earlier read', async () => {
    const fake = fakeEditor({ a: { transport: 'stdio', command: 'a' } })
    // A second writer lands between our read and our write — the kernel's own
    // page edits this same row, so this is the ordinary case, not a race.
    const original = fake.editor.edit
    fake.editor.edit = async (entry, change) => {
      ;(fake.document.servers as Record<string, unknown>).b = { transport: 'stdio', command: 'b' }
      return original(entry, change)
    }
    const store = new McpStore(fake.editor, true, () => {})
    await store.create({ serverName: 'c', transport: 'stdio', command: 'c' })
    assert.deepEqual(Object.keys(fake.document.servers as object).sort(), ['a', 'b', 'c'])
  })

  it('removes a modelled field the user cleared instead of keeping the old value', async () => {
    const fake = fakeEditor({ gh: { transport: 'stdio', command: 'npx', env: { TOKEN: 'secret' }, args: ['-y'] } })
    const store = new McpStore(fake.editor, true, () => {})
    // The form sends no `env`/`args` when the user emptied them.
    await store.update('gh', { serverName: 'gh', transport: 'stdio', command: 'npx' })
    const stored = fake.document.servers as Record<string, Record<string, unknown>>
    assert.equal(stored.gh?.env, undefined, 'a cleared credential must stop being passed to the child')
    assert.equal(stored.gh?.args, undefined)
  })

  it('resolves a callback against the entry as it is at write time', async () => {
    const fake = fakeEditor({ gh: { transport: 'stdio', command: 'npx', env: { TOKEN: 'old' } } })
    const original = fake.editor.edit
    fake.editor.edit = async (entry, change) => {
      ;((fake.document.servers as Record<string, Record<string, unknown>>).gh!.env as Record<string, string>).TOKEN = 'rotated'
      return original(entry, change)
    }
    const store = new McpStore(fake.editor, true, () => {})
    let sawToken: unknown
    await store.update('gh', { serverName: 'gh', transport: 'stdio', command: 'npx' }, (live) => {
      sawToken = (live?.env as Record<string, string> | undefined)?.TOKEN
      return { serverName: 'gh', transport: 'stdio', command: 'npx' }
    })
    // The route's mask resolution runs through this hook, so this is what stops
    // a stale page from writing the older secret back over a rotated one.
    assert.equal(sawToken, 'rotated')
  })

  it('refuses to read a row whose configuration cannot be read, instead of reporting an empty fleet', async () => {
    const fake = fakeEditor({ a: { transport: 'stdio', command: 'a' } })
    const blind = { ...fake.editor, configuration: undefined }
    const store = new McpStore(blind as never, true, () => {})
    assert.throws(() => store.load(), (error: unknown) => error instanceof McpValidationError && error.code === 'store.unreadable')
    await assert.rejects(() => store.remove('a'), (error: unknown) => error instanceof McpValidationError && error.code === 'store.unreadable')
  })

  it('keeps fields this version does not model when an entry is edited', async () => {
    const fake = fakeEditor({
      gh: { transport: 'stdio', command: 'npx', enabled: true, reconnect: { maxAttempts: 5 }, futureKnob: 'keep' },
    })
    const store = new McpStore(fake.editor, true, () => {})
    await store.update('gh', { serverName: 'gh', transport: 'stdio', command: 'npx', enabled: false })
    const stored = fake.document.servers as Record<string, Record<string, unknown>>
    assert.deepEqual(stored.gh?.reconnect, { maxAttempts: 5 }, 'a knob this version does not model survives')
    assert.equal(stored.gh?.futureKnob, 'keep')
    assert.equal(stored.gh?.enabled, false)
  })

  it('drops the other transport fields when the transport changes', async () => {
    const fake = fakeEditor({ gh: { transport: 'stdio', command: 'npx', args: ['-y'], enabled: true } })
    const store = new McpStore(fake.editor, true, () => {})
    await store.update('gh', { serverName: 'gh', transport: 'streamable-http', url: 'https://x/mcp', enabled: true })
    const stored = fake.document.servers as Record<string, Record<string, unknown>>
    assert.equal(stored.gh?.url, 'https://x/mcp')
    assert.equal(stored.gh?.command, undefined, 'a cross-transport entry is refused by the manager')
    assert.equal(stored.gh?.args, undefined)
  })

  it('creates an entry under its server name and keeps the rest of the map', () => {
    const fake = fakeEditor({ kept: { transport: 'stdio', command: 'kept' }, broken: { transport: 'stdio' } })
    const store = new McpStore(fake.editor, true, () => {})
    return store.create({ serverName: 'github', transport: 'stdio', command: 'npx' }).then((entry) => {
      assert.equal(entry.id, 'github')
      const servers = fake.document.servers as Record<string, unknown>
      assert.deepEqual(Object.keys(servers).sort(), ['broken', 'github', 'kept'])
      // The entry this version cannot validate survived the write verbatim.
      assert.deepEqual(servers.broken, { transport: 'stdio' })
    })
  })

  it('refuses a duplicate server name', async () => {
    const fake = fakeEditor({ github: { transport: 'stdio', command: 'npx' } })
    const store = new McpStore(fake.editor, true, () => {})
    await assert.rejects(
      () => store.create({ serverName: 'github', transport: 'stdio', command: 'other' }),
      (error: unknown) => error instanceof McpValidationError && error.code === 'serverName.taken',
    )
  })

  it('replaces an entry in place and keeps its key', async () => {
    const fake = fakeEditor({ github: { transport: 'stdio', command: 'npx' } })
    const store = new McpStore(fake.editor, true, () => {})
    await store.update('github', { serverName: 'github', transport: 'stdio', command: 'npx', enabled: false })
    const servers = fake.document.servers as Record<string, { enabled?: boolean }>
    assert.equal(servers.github?.enabled, false)
    assert.equal(Object.keys(servers).length, 1)
  })

  it('refuses to rename an entry: the key is the tool namespace', async () => {
    const fake = fakeEditor({ github: { transport: 'stdio', command: 'npx' } })
    const store = new McpStore(fake.editor, true, () => {})
    await assert.rejects(
      () => store.update('github', { serverName: 'gitlab', transport: 'stdio', command: 'npx' }),
      (error: unknown) => error instanceof McpValidationError && error.code === 'serverName.immutable',
    )
  })

  it('answers not-found for a key the document does not hold', async () => {
    const store = new McpStore(fakeEditor({}).editor, true, () => {})
    await assert.rejects(
      () => store.update('ghost', { serverName: 'ghost', transport: 'stdio', command: 'npx' }),
      (error: unknown) => error instanceof McpValidationError && error.code === 'server.notFound',
    )
  })

  it('removes one key and leaves the others', async () => {
    const fake = fakeEditor({ a: { transport: 'stdio', command: 'a' }, b: { transport: 'stdio', command: 'b' } })
    const store = new McpStore(fake.editor, true, () => {})
    await store.remove('a')
    assert.deepEqual(Object.keys(fake.document.servers as Record<string, unknown>), ['b'])
  })

  it('treats a missing key on remove as a no-op and writes nothing', async () => {
    const fake = fakeEditor({})
    const store = new McpStore(fake.editor, true, () => {})
    await store.remove('ghost')
    assert.equal(fake.writes, 0)
  })

  it('refuses every write when the kernel mounts no editor', async () => {
    const store = new McpStore(undefined, true, () => {})
    await assert.rejects(
      () => store.create({ serverName: 'github', transport: 'stdio', command: 'npx' }),
      (error: unknown) => error instanceof McpValidationError && error.code === 'store.unavailable',
    )
  })
})

describe('batch import', () => {
  it('writes the whole batch in one edit and skips keys already configured', async () => {
    const fake = fakeEditor({ kept: { transport: 'stdio', command: 'kept' } })
    const store = new McpStore(fake.editor, true, () => {})
    const written = await store.importAll([
      { id: 'kept', serverName: 'kept', transport: 'stdio', enabled: true, command: 'other' },
      { id: 'fresh', serverName: 'fresh', transport: 'stdio', enabled: true, command: 'fresh' },
    ])
    assert.equal(written, 1)
    assert.equal(fake.writes, 1, 'one write for the batch, not one per entry')
    const servers = fake.document.servers as Record<string, { command?: string }>
    assert.equal(servers.kept?.command, 'kept', 'the configured entry was not overwritten')
    assert.equal(servers.fresh?.command, 'fresh')
  })

  it('writes nothing when every key is already there', async () => {
    const fake = fakeEditor({ kept: { transport: 'stdio', command: 'kept' } })
    const store = new McpStore(fake.editor, true, () => {})
    assert.equal(await store.importAll([{ id: 'kept', serverName: 'kept', transport: 'stdio', enabled: true, command: 'kept' }]), 0)
    assert.equal(fake.writes, 0)
  })
})
