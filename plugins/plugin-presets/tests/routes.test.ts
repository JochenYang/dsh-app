// Route-level tests for the config-backup half of the presets plugin's API:
// the export route's answer shape and the warning header the client turns
// into the "this zip holds plaintext keys" notice. Run by the plugin's own
// scripts/test.mjs (esbuild-bundled, node --test).
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { scratchDir } from './scratch.ts'

import { registerBackupRoutes } from '../src/routes.ts'
import type { HostConnectionFetch, ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { BACKUP_NO_CREDENTIALS_HEADER, BACKUP_WARNINGS_HEADER, backupCredentialsAbsent, decodeBackupWarnings } from '../src/client/backup-warnings.ts'
import { packConfigBackup } from '../src/backup.ts'

const ROUTE = '/api/plugins/dsh-app/plugin-presets/config-export'
const IMPORT_ROUTE = '/api/plugins/dsh-app/plugin-presets/config-import'

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
  return scratchDir(`dsh-presets-routes-${label}-`)
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
  assert.deepEqual(decodeBackupWarnings(header), [{ rel: 'credentials.yaml', rule: 'sk' }])
  // The header carries file and rule only — never the matched value.
  assert.ok(!header.includes('sk-abcdefghijklmnopqrstuv'))
  // And the archive really holds the store.
  const names = Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())))
  assert.ok(names.includes('credentials.yaml'))
})

test('a credential store whose content matches no rule is still reported', async () => {
  // The scan is regex-shaped; an opaque ref under a custom name matches
  // nothing. The notice must appear anyway — the keys ride either way.
  const home = scratchHome('opaque')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  GOOGLE: AIzaSyAxxxxxxxxxxxxxxxxxxxxxxxxxxx\n', 'utf8')
  const response = await exportAnswer(home)
  const header = response.headers.get(BACKUP_WARNINGS_HEADER)
  assert.ok(header !== null)
  assert.deepEqual(decodeBackupWarnings(header), [{ rel: 'credentials.yaml', rule: 'credential-store' }])
})

test('no warning header when nothing secret-shaped rides', async () => {
  const home = scratchHome('clean')
  writeFileSync(join(home, 'settings.yaml'), 'limits:\n  tokenLimit: 4096\n', 'utf8')
  const response = await exportAnswer(home)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get(BACKUP_WARNINGS_HEADER), null)
})

test('a machine with no credential store says so on the export answer', async () => {
  // Measured: this export succeeded with no notice at all, and the archive it
  // wrote restored on a fresh machine as provider settings and no keys — found
  // out at the first failed request, not at the import that caused it.
  const home = scratchHome('nokeys')
  writeFileSync(join(home, 'settings.yaml'), 'limits:\n  tokenLimit: 4096\n', 'utf8')
  const response = await exportAnswer(home)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get(BACKUP_NO_CREDENTIALS_HEADER), '1')
  assert.ok(!Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer()))).includes('credentials.yaml'))
})

test('the absent-credentials header is absent when the store rides', async () => {
  const home = scratchHome('haskeys')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  KEY: sk-abcdefghijklmnopqrstuv\n', 'utf8')
  const response = await exportAnswer(home)
  assert.equal(response.headers.get(BACKUP_NO_CREDENTIALS_HEADER), null)
})

test('backupCredentialsAbsent reads only the host\u2019s own 1', () => {
  assert.equal(backupCredentialsAbsent('1'), true)
  assert.equal(backupCredentialsAbsent(null), false)
  assert.equal(backupCredentialsAbsent(''), false)
  assert.equal(backupCredentialsAbsent('0'), false)
  assert.equal(backupCredentialsAbsent('true'), false)
})

test('the import answer says when the archive carried no credential store, and leaves the machine\u2019s own', async () => {
  const exporter = scratchHome('import-exporter')
  writeFileSync(join(exporter, 'settings.yaml'), 'agent-default-model: gateway/example-model\n', 'utf8')
  const { bytes } = await packConfigBackup(exporter, 'web')
  const home = scratchHome('import-target')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  KEY: sk-LOCAL-KEY-0123456789abcdef\n', 'utf8')
  const { fetch, routes } = registryMock()
  await registerBackupRoutes(fetch, { home, profile: 'web' })
  const route = routes.get(IMPORT_ROUTE)
  assert.ok(route !== undefined)
  const response = await route.fetch(new Request(`http://127.0.0.1${IMPORT_ROUTE}?overwrite=1`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(bytes),
  }))
  assert.equal(response.status, 200)
  const body = await response.json() as { ok: boolean, value?: { credentialsAbsent?: boolean } }
  assert.equal(body.value?.credentialsAbsent, true)
  assert.equal(readFileSync(join(home, '.credentials.yaml'), 'utf8'), 'version: 1\nrefs:\n  KEY: sk-LOCAL-KEY-0123456789abcdef\n',
    'a member that is not in the archive never writes its target')
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
