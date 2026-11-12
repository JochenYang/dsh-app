/**
 * The one-time import of the retired `servers.json`.
 *
 * This is an irreversible step (the file is renamed aside once the write lands),
 * so each case here pins one way it could destroy a user's fleet or resurrect a
 * switch they had turned off.
 *
 * @module plugin-mcp/tests/legacy
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { importLegacyServers, readLegacyServers } from '../src/legacy.ts'
import { MANAGER_ROW_ID, McpStore, type ConfigEditorLike, type ConfigRow } from '../src/store.ts'

/** A config document in memory, shaped the way the kernel's editor reports it. */
function fakeEditor(): { editor: ConfigEditorLike, document: Record<string, unknown>, writes: () => number } {
  const document: Record<string, unknown> = { servers: {} }
  const row: ConfigRow = { options: { id: MANAGER_ROW_ID } }
  let writes = 0
  const editor: ConfigEditorLike = {
    entries: () => [row],
    configuration: () => [{ entry: row, inherited: {}, override: document }],
    edit: async (_entry, change) => {
      writes += 1
      const next = change({ ...document }, {})
      for (const key of Object.keys(document)) Reflect.deleteProperty(document, key)
      Object.assign(document, next)
    },
  }
  return { editor, document, writes: () => writes }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-mcp-legacy-'))
}

const LEGACY = JSON.stringify({
  version: 1,
  enabled: true,
  servers: [
    { id: 'mcp-1', serverName: 'github', transport: 'stdio', enabled: true, command: 'npx', env: { TOKEN: '$ENV:GH_TOKEN', LITERAL: 'plain' } },
    { id: 'mcp-2', serverName: 'web', transport: 'streamable-http', enabled: false, url: 'https://x/mcp', headers: { Authorization: '$ENV:MCP_TOKEN' } },
  ],
}, null, 2)

function logs(): { lines: string[], log: (message: string) => void } {
  const lines: string[] = []
  return { lines, log: (message) => lines.push(message) }
}

describe('reading the retired file', () => {
  it('converts $ENV references into credential templates and keeps literals', () => {
    const dir = scratch()
    try {
      const file = join(dir, 'servers.json')
      writeFileSync(file, LEGACY)
      const result = readLegacyServers(file, () => {})
      assert.equal(result.entries.length, 2)
      assert.deepEqual(result.entries[0]?.env, { TOKEN: '${credential:GH_TOKEN}', LITERAL: 'plain' })
      assert.deepEqual(result.entries[1]?.headers, { Authorization: '${credential:MCP_TOKEN}' })
      // The key is the identity, so it is the entry's id too.
      assert.equal(result.entries[0]?.id, 'github')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips one bad entry instead of losing the whole fleet', () => {
    const dir = scratch()
    try {
      const file = join(dir, 'servers.json')
      writeFileSync(file, JSON.stringify({ version: 1, enabled: true, servers: [
        { serverName: 'good', transport: 'stdio', command: 'npx' },
        { serverName: 'bad name', transport: 'stdio', command: 'npx' },
      ] }))
      const { lines, log } = logs()
      const result = readLegacyServers(file, log)
      assert.deepEqual(result.entries.map((entry) => entry.serverName), ['good'])
      assert.equal(result.skipped, 1)
      assert.match(lines.join('\n'), /skipped one entry/u)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports the retired global switch instead of ignoring it', () => {
    const dir = scratch()
    try {
      const file = join(dir, 'servers.json')
      writeFileSync(file, LEGACY.replace('"enabled": true', '"enabled": false'))
      assert.equal(readLegacyServers(file, () => {}).disabledGlobally, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('importing', () => {
  it('writes the fleet into the row and renames the file aside', async () => {
    const dir = scratch()
    try {
      const file = join(dir, 'servers.json')
      writeFileSync(file, LEGACY)
      const fake = fakeEditor()
      const store = new McpStore(fake.editor, true, () => {})
      await importLegacyServers(store, file, () => {})
      const stored = fake.document.servers as Record<string, Record<string, unknown>>
      assert.deepEqual(Object.keys(stored).sort(), ['github', 'web'])
      assert.equal(stored.github?.enabled, true)
      assert.equal(stored.web?.enabled, false)
      assert.equal(existsSync(file), false, 'the source file was renamed')
      assert.equal(existsSync(`${file}.migrated`), true, 'it is kept aside, not deleted')
      assert.equal(JSON.parse(readFileSync(`${file}.migrated`, 'utf8')).servers.length, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('imports everything DISABLED when the retired file had its global switch off', async () => {
    const dir = scratch()
    try {
      const file = join(dir, 'servers.json')
      writeFileSync(file, LEGACY.replace('"enabled": true', '"enabled": false'))
      const fake = fakeEditor()
      const store = new McpStore(fake.editor, true, () => {})
      const { lines, log } = logs()
      await importLegacyServers(store, file, log)
      const stored = fake.document.servers as Record<string, Record<string, unknown>>
      // The old switch meant "mount nothing"; carrying the fleet in enabled
      // would start every one of those servers on upgrade.
      assert.deepEqual(Object.values(stored).map((entry) => entry.enabled), [false, false])
      assert.match(lines.join('\n'), /as disabled/u)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves the file in place when the row already holds every key', async () => {
    const dir = scratch()
    try {
      const file = join(dir, 'servers.json')
      writeFileSync(file, LEGACY)
      const fake = fakeEditor()
      const store = new McpStore(fake.editor, true, () => {})
      await store.importAll([{ id: 'github', serverName: 'github', transport: 'stdio', enabled: true, command: 'npx' },
        { id: 'web', serverName: 'web', transport: 'streamable-http', enabled: false, url: 'https://x/mcp' }])
      const before = fake.writes()
      await importLegacyServers(store, file, () => {})
      assert.equal(fake.writes(), before, 'no write when nothing is missing')
      assert.equal(existsSync(file), true, 'the source is left for the next version to inspect')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op when the retired file is absent', async () => {
    const dir = scratch()
    try {
      const fake = fakeEditor()
      const store = new McpStore(fake.editor, true, () => {})
      await importLegacyServers(store, join(dir, 'absent.json'), () => {})
      assert.equal(fake.writes(), 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
