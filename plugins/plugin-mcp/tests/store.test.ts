/**
 * Store behavior tests: entry validation, id allocation, CRUD round trips,
 * the enabled-serverName uniqueness contract, and the invalid-entry
 * preservation guarantee (a hand-edited broken entry must survive saves).
 *
 * @module plugin-mcp/tests/store
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { McpStore, McpValidationError, nextEntryId, validateEntry } from '../src/store.ts'
import type { McpServerEntry } from '../src/wire.ts'

const VALID_STDIO = {
  serverName: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: '$ENV:GITHUB_TOKEN' },
}

function makeStore(): { store: McpStore, dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-test-'))
  return { store: new McpStore(dir, () => {}), dir }
}

describe('validateEntry', () => {
  it('rejects a serverName outside the upstream pattern', () => {
    assert.throws(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', serverName: 'has 空格' }, new Set()), McpValidationError)
    assert.throws(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', serverName: '' }, new Set()), McpValidationError)
    assert.throws(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', serverName: 'x'.repeat(33) }, new Set()), McpValidationError)
  })

  it('rejects a stdio entry without a command', () => {
    assert.throws(() => validateEntry({ id: 'mcp-1', serverName: 'a', transport: 'stdio' }, new Set()), McpValidationError)
  })

  it('rejects a streamable-http entry with a non-http URL', () => {
    assert.throws(() => validateEntry({ id: 'mcp-1', serverName: 'a', transport: 'streamable-http', url: 'ftp://x' }, new Set()), McpValidationError)
    assert.throws(() => validateEntry({ id: 'mcp-1', serverName: 'a', transport: 'streamable-http', url: 'not-a-url' }, new Set()), McpValidationError)
  })

  it('rejects an id that is absent, malformed, or already used', () => {
    assert.throws(() => validateEntry(VALID_STDIO, new Set()), McpValidationError)
    assert.throws(() => validateEntry({ ...VALID_STDIO, id: 'nope' }, new Set()), McpValidationError)
    assert.throws(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1' }, new Set(['mcp-1'])), McpValidationError)
  })

  it('accepts a valid stdio entry and normalizes enabled to true by default', () => {
    const entry = validateEntry({ ...VALID_STDIO, id: 'mcp-1' }, new Set())
    assert.equal(entry.enabled, true)
    assert.equal(entry.serverName, 'github')
  })
})

describe('nextEntryId', () => {
  it('continues the monotonic sequence past the highest existing id', () => {
    const servers = [{ id: 'mcp-3' }, { id: 'mcp-1' }] as unknown as McpServerEntry[]
    assert.equal(nextEntryId(servers), 'mcp-4')
    assert.equal(nextEntryId([]), 'mcp-1')
  })
})

describe('McpStore CRUD', () => {
  let handle: { store: McpStore, dir: string }
  beforeEach(() => { handle = makeStore() })
  afterEach(() => { rmSync(handle.dir, { recursive: true, force: true }) })

  it('create persists a validated entry that load() returns', () => {
    const { store } = handle
    const entry = store.create(VALID_STDIO)
    assert.equal(entry.id, 'mcp-1')
    assert.equal(store.load().servers.length, 1)
    assert.equal(store.load().servers[0]?.serverName, 'github')
  })

  it('update replaces the entry by id and keeps others', () => {
    const { store } = handle
    const first = store.create(VALID_STDIO)
    const second = store.create({ serverName: 'web', transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' })
    store.update(second.id, { serverName: 'web2', transport: 'streamable-http', url: 'http://127.0.0.1:3001/mcp' })
    const servers = store.load().servers
    assert.equal(servers.length, 2)
    assert.equal(servers.find(entry => entry.id === first.id)?.serverName, 'github')
    assert.equal(servers.find(entry => entry.id === second.id)?.serverName, 'web2')
  })

  it('update rejects an unknown id', () => {
    const { store } = handle
    assert.throws(() => store.update('mcp-9', VALID_STDIO), McpValidationError)
  })

  it('create rejects a second ENABLED server with the same serverName but allows a disabled one', () => {
    const { store } = handle
    store.create(VALID_STDIO)
    assert.throws(() => store.create({ ...VALID_STDIO, command: 'node' }), McpValidationError)
    // Disabled twins are fine: they mount nothing, so no live namespace clash.
    store.create({ ...VALID_STDIO, command: 'node', enabled: false })
    assert.equal(store.load().servers.length, 2)
  })

  it('remove deletes exactly the targeted entry', () => {
    const { store } = handle
    const entry = store.create(VALID_STDIO)
    store.remove(entry.id)
    assert.equal(store.load().servers.length, 0)
  })
})

describe('McpStore invalid-entry preservation', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('keeps a hand-edited broken entry on disk through later saves', () => {
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'servers.json')
    const broken = { id: 'mcp-9', serverName: 'broken-服务器', transport: 'stdio' }
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      enabled: true,
      servers: [broken, { ...VALID_STDIO, id: 'mcp-1' }],
    }), 'utf8')
    const store = new McpStore(dir, () => {})
    // The broken entry is invisible to the mounted set...
    assert.equal(store.load().servers.length, 1)
    // ...but a create (which rewrites the whole file) must not silently drop it.
    store.create({ serverName: 'extra', transport: 'stdio', command: 'node' })
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { servers: Array<{ id?: string, serverName?: string }> }
    assert.equal(onDisk.servers.some(entry => entry.id === 'mcp-9' && entry.serverName === 'broken-服务器'), true)
    assert.equal(onDisk.servers.length, 3)
  })
})

describe('McpStore master switch', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('persists enabled:false and reports it through load()', () => {
    const store = new McpStore(dir, () => {})
    store.create(VALID_STDIO)
    const file = store.load()
    store.save({ ...file, enabled: false })
    assert.equal(store.load().enabled, false)
  })

  it('defaults to enabled when the file does not exist', () => {
    const store = new McpStore(dir, () => {})
    assert.equal(store.load().enabled, true)
    assert.equal(store.load().servers.length, 0)
  })
})
