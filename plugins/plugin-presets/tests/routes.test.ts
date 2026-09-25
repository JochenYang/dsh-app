// Route-level tests for the config-backup half of the presets plugin's API:
// the export route's answer shape and the warning header the client turns
// into the "this zip holds plaintext keys" notice. Run by the plugin's own
// scripts/test.mjs (esbuild-bundled, node --test).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { unzipSync } from 'fflate'

import { registerBackupRoutes } from '../src/routes.ts'
import type { HostConnectionFetch, ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { BACKUP_WARNINGS_HEADER, decodeBackupWarnings } from '../src/client/backup-warnings.ts'

const ROUTE = '/api/plugins/dsh-app/plugin-presets/config-export'

/** Minimal registry mock: keeps the routes the plugin registers. */
function registryMock(): { fetch: HostConnectionFetch, routes: Map<string, ConnectionFetchRoute> } {
  const routes = new Map<string, ConnectionFetchRoute>()
  const fetch: HostConnectionFetch = {
    register: (route) => {
      routes.set(route.path, route)
      return async () => { routes.delete(route.path) }
    },
  }
  return { fetch, routes }
}

function scratchHome(label: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-presets-routes-${label}-`))
}

async function exportAnswer(home: string): Promise<Response> {
  const { fetch, routes } = registryMock()
  await registerBackupRoutes(fetch, { home, profile: 'web' })
  const route = routes.get(ROUTE)
  assert.ok(route !== undefined, 'the config-export route is registered')
  return route.fetch(new Request(`http://127.0.0.1${ROUTE}`))
}

test('the export route answers the backup zip as an attachment', async () => {
  const home = scratchHome('basic')
  writeFileSync(join(home, 'settings.yaml'), 'limits:\n  tokenLimit: 4096\n', 'utf8')
  const response = await exportAnswer(home)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/zip/u)
  assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="dsh-config-backup\.zip"/u)
  const names = Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())))
  assert.ok(names.includes('settings.yaml'))
  assert.ok(names.includes('manifest.json'))
})

test('the credential store rides, and the warning header names it (base64 JSON)', async () => {
  const home = scratchHome('warned')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  KEY: sk-abcdefghijklmnopqrstuv\n', 'utf8')
  const response = await exportAnswer(home)
  assert.equal(response.status, 200)
  const header = response.headers.get(BACKUP_WARNINGS_HEADER)
  assert.ok(header !== null, 'the warning header is present when key material rides')
  assert.deepEqual(decodeBackupWarnings(header), [{ rel: 'home/credentials.yaml', rule: 'sk' }])
  // The header carries file and rule only — never the matched value.
  assert.ok(!header.includes('sk-abcdefghijklmnopqrstuv'))
  // And the archive really holds the store.
  const names = Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())))
  assert.ok(names.includes('home/credentials.yaml'))
})

test('a credential store whose content matches no rule is still reported', async () => {
  // The scan is regex-shaped; an opaque ref under a custom name matches
  // nothing. The notice must appear anyway — the keys ride either way.
  const home = scratchHome('opaque')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  GOOGLE: AIzaSyAxxxxxxxxxxxxxxxxxxxxxxxxxxx\n', 'utf8')
  const response = await exportAnswer(home)
  const header = response.headers.get(BACKUP_WARNINGS_HEADER)
  assert.ok(header !== null)
  assert.deepEqual(decodeBackupWarnings(header), [{ rel: 'home/credentials.yaml', rule: 'credential-store' }])
})

test('no warning header when nothing secret-shaped rides', async () => {
  const home = scratchHome('clean')
  writeFileSync(join(home, 'settings.yaml'), 'limits:\n  tokenLimit: 4096\n', 'utf8')
  const response = await exportAnswer(home)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get(BACKUP_WARNINGS_HEADER), null)
})

test('decodeBackupWarnings tolerates every malformed shape without throwing', () => {
  assert.deepEqual(decodeBackupWarnings(null), [])
  assert.deepEqual(decodeBackupWarnings(''), [])
  assert.deepEqual(decodeBackupWarnings('not-base64-json'), [])
  assert.deepEqual(decodeBackupWarnings(Buffer.from('{"not":"an array"}', 'utf8').toString('base64')), [])
  assert.deepEqual(decodeBackupWarnings(Buffer.from('[{"rel":1}]', 'utf8').toString('base64')), [])
  assert.deepEqual(decodeBackupWarnings(Buffer.from('[{"rel":"a","rule":"b"},{"junk":true}]', 'utf8').toString('base64')), [
    { rel: 'a', rule: 'b' },
  ])
})
