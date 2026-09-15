/**
 * Config-backup tests: the export whitelist (whitelisted store files ride
 * along; credential-named files, settings.yaml and unknown names can never
 * enter the archive), rejection of hostile archives (path traversal, unknown
 * layout, wrong manifest) BEFORE anything is restored, the conflict /
 * overwrite contract on differing targets, and the automatic pre-overwrite
 * copy of the profile patch layer.
 *
 * @module plugin-presets/tests/backup
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { packConfigBackup, restoreConfigBackup, unpackConfigBackup } from '../src/backup.ts'
import { PresetPackageError } from '../src/wire.ts'
import { patchCentralOriginalSize, setDataDescriptorFlag, zipWithDuplicatedCentralEntry } from './zip-craft.ts'

// One scratch root per test file; each test gets its own home directory.
const scratchRoot = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-presets-backup-'))
after(() => { rmSync(scratchRoot, { recursive: true, force: true }) })

function scratchHome(name: string): string {
  const dir = join(scratchRoot, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

const VALID_MANIFEST = strToU8(JSON.stringify({
  formatVersion: 1,
  kind: 'dsh-config-backup',
  exportedAt: '2026-09-13T00:00:00.000Z',
  app: 'dsh-app',
}))

/** A populated fake home: profile layer, market sources, two plugin stores. */
function writeHome(home: string): void {
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'rows:\n  - id: keep\n', 'utf8')
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{"dependencies":{}}\n', 'utf8')
  mkdirSync(join(home, 'storages', 'dsh-app-plugin-market'), { recursive: true })
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-market', 'sources.json'), '{"sources":[]}\n', 'utf8')
  mkdirSync(join(home, 'storages', 'dsh-app-plugin-foo'), { recursive: true })
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), '{"enabled":true}\n', 'utf8')
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'servers.json'), '{}\n', 'utf8')
  // Everything that must stay OUT of the archive:
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'credentials.json'), '{"key":"top-secret"}\n', 'utf8')
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'api-key.json'), '{"k":"x"}\n', 'utf8')
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'settings.yaml'), 'tokens: hidden\n', 'utf8')
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'other.json'), '{}\n', 'utf8')
  mkdirSync(join(home, 'storages', 'dsh-app-plugin-bar'), { recursive: true })
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-bar', 'sources.json'), '{"sources":[]}\n', 'utf8')
}

describe('packConfigBackup (export whitelist)', () => {
  it('packs whitelisted files only and never credential-named ones', async () => {
    const home = scratchHome('export-home')
    writeHome(home)
    const bytes = await packConfigBackup(home, 'web')
    const zipped = unzipSync(bytes)
    const names = Object.keys(zipped).sort()
    assert.deepEqual(names, [
      'manifest.json',
      'market/sources.json',
      'plugins/dsh-app-plugin-bar/sources.json',
      'plugins/dsh-app-plugin-foo/config.json',
      'plugins/dsh-app-plugin-foo/servers.json',
      'profile/cordis.patch.yml',
      'profile/package.json',
    ])
    // Payload bytes survive the round trip.
    assert.equal(Buffer.from(zipped['plugins/dsh-app-plugin-foo/config.json']!).toString('utf8'), '{"enabled":true}\n')
  })

  it('carries the config-backup manifest shape', async () => {
    const home = scratchHome('manifest-home')
    writeHome(home)
    const bytes = await packConfigBackup(home, 'web')
    const manifest = JSON.parse(Buffer.from(unzipSync(bytes)['manifest.json']!).toString('utf8')) as Record<string, unknown>
    assert.equal(manifest.kind, 'dsh-config-backup')
    assert.equal(manifest.formatVersion, 1)
    assert.equal(manifest.app, 'dsh-app')
    assert.equal(typeof manifest.exportedAt, 'string')
  })

  it('tolerates a bare home (no profile layer, no storages yet)', async () => {
    const home = scratchHome('bare-home')
    const bytes = await packConfigBackup(home, 'web')
    const names = Object.keys(unzipSync(bytes))
    assert.deepEqual(names, ['manifest.json'])
  })

  it('skips a symbolic link named like a whitelisted file', async () => {
    const home = scratchHome('symlink-home')
    mkdirSync(join(home, 'storages', 'dsh-app-plugin-foo'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'servers.json'), '{}\n', 'utf8')
    const outside = join(scratchRoot, 'symlink-target-outside.txt')
    writeFileSync(outside, 'content from outside the store', 'utf8')
    try {
      symlinkSync(outside, join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), 'file')
    } catch {
      return // environment without symlink privilege: the fence is unverifiable here
    }
    const bytes = await packConfigBackup(home, 'web')
    const names = Object.keys(unzipSync(bytes))
    assert.ok(names.includes('plugins/dsh-app-plugin-foo/servers.json'))
    assert.ok(!names.includes('plugins/dsh-app-plugin-foo/config.json'))
  })
})

describe('packConfigBackup (content-level secret scan)', () => {
  it('refuses export when a whitelisted store file carries credential content', async () => {
    const home = scratchHome('scan-authorization')
    mkdirSync(join(home, 'storages', 'dsh-app-plugin-mcp'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-app-plugin-mcp', 'servers.json'),
      '{"mcp":{"url":"https://mcp.example","headers":{"Authorization":"Bearer abcdefghijklmn"}}}\n', 'utf8')
    await assert.rejects(
      () => packConfigBackup(home, 'web'),
      (error: unknown) => {
        if (!(error instanceof PresetPackageError) || error.code !== 'sensitive-content') return false
        // The refusal names the file and the rule (as a stable code plus those
        // two values), never the matched content.
        return error.host.code === 'backup.secretContent'
          && error.host.params?.rel === 'plugins/dsh-app-plugin-mcp/servers.json'
          && error.host.params?.rule === 'authorization'
          && !JSON.stringify(error.host).includes('abcdefghijklmn')
      },
    )
  })

  it('reports the matched rule when the patch layer carries an api key shape', async () => {
    const home = scratchHome('scan-api-key')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'provider:\n  api_key = "0123456789abcd"\n', 'utf8')
    await assert.rejects(
      () => packConfigBackup(home, 'web'),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'sensitive-content'
        && error.host.code === 'backup.secretContent'
        && error.host.params?.rel === 'profile/cordis.patch.yml' && error.host.params?.rule === 'api-key',
    )
  })

  it('lets credential-free content through (a token word without an assigned value)', async () => {
    const home = scratchHome('scan-clean')
    mkdirSync(join(home, 'storages', 'dsh-app-plugin-foo'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), '{"token":false,"note":"rotate stale token material"}\n', 'utf8')
    const bytes = await packConfigBackup(home, 'web')
    const names = Object.keys(unzipSync(bytes))
    assert.ok(names.includes('plugins/dsh-app-plugin-foo/config.json'))
  })
})

describe('unpackConfigBackup (hostile archives)', () => {
  it('rejects path traversal before inflating anything', () => {
    const bytes = zipSync({ 'manifest.json': VALID_MANIFEST, 'profile/../evil.txt': strToU8('x') })
    assert.throws(
      () => unpackConfigBackup(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'illegal-path',
    )
  })

  it('rejects traversal smuggled through the plugins block', () => {
    const bytes = zipSync({
      'manifest.json': VALID_MANIFEST,
      'plugins/dsh-app-plugin-foo/../../profiles/web/cordis.patch.yml': strToU8('evil'),
    })
    assert.throws(
      () => unpackConfigBackup(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'illegal-path',
    )
  })

  it('rejects members outside the known layout and non-whitelisted store files', () => {
    const foreign = zipSync({ 'manifest.json': VALID_MANIFEST, 'random/file.json': strToU8('{}') })
    assert.throws(
      () => unpackConfigBackup(foreign),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'illegal-path',
    )
    const notWhitelisted = zipSync({
      'manifest.json': VALID_MANIFEST,
      'plugins/dsh-app-plugin-foo/other.json': strToU8('{}'),
    })
    assert.throws(
      () => unpackConfigBackup(notWhitelisted),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'illegal-path',
    )
    // The tripwire holds even for a hand-crafted credential-named member.
    const credential = zipSync({
      'manifest.json': VALID_MANIFEST,
      'plugins/dsh-app-plugin-foo/api-key.json': strToU8('{"k":"x"}'),
    })
    assert.throws(
      () => unpackConfigBackup(credential),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'illegal-path',
    )
  })

  it('rejects a wrong kind or formatVersion', () => {
    const wrongKind = zipSync({
      'manifest.json': strToU8(JSON.stringify({ formatVersion: 1, kind: 'dsh-preset', exportedAt: 'x' })),
      'profile/cordis.patch.yml': strToU8('rows: []'),
    })
    assert.throws(
      () => unpackConfigBackup(wrongKind),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
    const wrongVersion = zipSync({
      'manifest.json': strToU8(JSON.stringify({ formatVersion: 99, kind: 'dsh-config-backup', exportedAt: 'x' })),
      'profile/cordis.patch.yml': strToU8('rows: []'),
    })
    assert.throws(
      () => unpackConfigBackup(wrongVersion),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
  })

  it('rejects an archive without a manifest', () => {
    const bytes = zipSync({ 'profile/cordis.patch.yml': strToU8('rows: []') })
    assert.throws(
      () => unpackConfigBackup(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package',
    )
  })

  it('rejects a member whose real content exceeds its declared size', () => {
    // The declared size slips past the census cap; the bounded inflate counts
    // the real bytes and aborts before the payload is ever trusted.
    const bytes = patchCentralOriginalSize(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('x'.repeat(2 * 1024 * 1024)),
    }), 'profile/cordis.patch.yml', 100)
    assert.throws(
      () => unpackConfigBackup(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package'
        && error.host.code === 'zip.sizeMismatch'
        && error.host.params?.subject === 'subject.backup'
        && error.host.params?.name === 'profile/cordis.patch.yml',
    )
  })

  it('rejects a member whose real content falls short of its declared size', () => {
    const bytes = patchCentralOriginalSize(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows: []\n'),
    }), 'profile/cordis.patch.yml', 5 * 1024 * 1024)
    assert.throws(
      () => unpackConfigBackup(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package'
        && error.host.code === 'zip.sizeMismatch'
        && error.host.params?.subject === 'subject.backup'
        && error.host.params?.name === 'profile/cordis.patch.yml',
    )
  })

  it('rejects duplicate member names at the census', () => {
    const bytes = zipWithDuplicatedCentralEntry(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows: []\n'),
    }), 'profile/cordis.patch.yml')
    assert.throws(
      () => unpackConfigBackup(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package'
        && error.host.code === 'backup.duplicateMember'
        && error.host.params?.name === 'profile/cordis.patch.yml',
    )
  })

  it('rejects data-descriptor members whose compressed size is not declared up front', () => {
    const bytes = setDataDescriptorFlag(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows: []\n'),
    }), 'profile/cordis.patch.yml')
    assert.throws(
      () => unpackConfigBackup(bytes),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'bad-package'
        && error.host.code === 'zip.dataDescriptor'
        && error.host.params?.subject === 'subject.backup'
        && error.host.params?.name === 'profile/cordis.patch.yml',
    )
  })
})

describe('restoreConfigBackup (conflicts, overwrite, patch backup)', () => {
  it('restores into a fresh home and reports every written member', () => {
    const source = scratchHome('restore-src')
    writeHome(source)
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows:\n  - id: keep\n'),
      'market/sources.json': strToU8('{"sources":[]}\n'),
      'plugins/dsh-app-plugin-foo/config.json': strToU8('{"enabled":true}\n'),
    }))
    const home = scratchHome('restore-target')
    const outcome = restoreConfigBackup(home, 'web', files, false)
    assert.equal(outcome.written, 3)
    assert.equal(outcome.unchanged, 0)
    assert.deepEqual(outcome.backups, [])
    assert.equal(readFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), 'utf8'), '{"enabled":true}\n')
    assert.ok(existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml')))
  })

  it('skips members whose target already has identical content', () => {
    const source = scratchHome('unchanged-src')
    writeHome(source)
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'market/sources.json': strToU8('{"sources":[]}\n'),
    }))
    const home = scratchHome('unchanged-target')
    mkdirSync(join(home, 'storages', 'dsh-app-plugin-market'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-app-plugin-market', 'sources.json'), '{"sources":[]}\n', 'utf8')
    const outcome = restoreConfigBackup(home, 'web', files, false)
    assert.equal(outcome.written, 0)
    assert.equal(outcome.unchanged, 1)
  })

  it('refuses differing targets without overwrite, naming every conflict', () => {
    const source = scratchHome('conflict-src')
    writeHome(source)
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'market/sources.json': strToU8('{"sources":["https://a.example"]}\n'),
      'plugins/dsh-app-plugin-foo/config.json': strToU8('{"enabled":false}\n'),
    }))
    const home = scratchHome('conflict-target')
    writeHome(home) // same shapes, different content
    assert.throws(
      () => restoreConfigBackup(home, 'web', files, false),
      (error: unknown) => {
        if (!(error instanceof PresetPackageError) || error.code !== 'conflict') return false
        const files = error.details.files as readonly string[]
        return Array.isArray(files) && files.length === 2
          && files.includes('market/sources.json')
          && files.includes('plugins/dsh-app-plugin-foo/config.json')
      },
    )
    // All-or-nothing: nothing was written by the refused restore.
    assert.equal(readFileSync(join(home, 'storages', 'dsh-app-plugin-market', 'sources.json'), 'utf8'), '{"sources":[]}\n')
  })

  it('overwrites differing targets with overwrite=true and backs up the patch layer', () => {
    const source = scratchHome('overwrite-src')
    writeHome(source)
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows:\n  - id: restored\n'),
      'plugins/dsh-app-plugin-foo/config.json': strToU8('{"enabled":false}\n'),
    }))
    const home = scratchHome('overwrite-target')
    writeHome(home)
    const outcome = restoreConfigBackup(home, 'web', files, true, () => new Date('2026-09-13T08:09:07.000Z'))
    assert.equal(outcome.written, 2)
    assert.equal(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), 'rows:\n  - id: restored\n')
    assert.equal(readFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), 'utf8'), '{"enabled":false}\n')
    // The pre-overwrite sidecar keeps the previous patch layer recoverable.
    assert.deepEqual(outcome.backups, ['profile/cordis.patch.yml.bak-import-2026-09-13T08-09-07-000Z'])
    const sidecars = readdirSync(join(home, 'profiles', 'web')).filter(name => name.includes('.bak-import-'))
    assert.equal(sidecars.length, 1)
    assert.equal(readFileSync(join(home, 'profiles', 'web', sidecars[0]!), 'utf8'), 'rows:\n  - id: keep\n')
  })

  it('does not create a patch sidecar when the patch layer is new', () => {
    const source = scratchHome('freshpatch-src')
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows: []\n'),
    }))
    const home = scratchHome('freshpatch-target')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const outcome = restoreConfigBackup(home, 'web', files, true)
    assert.equal(outcome.written, 1)
    assert.deepEqual(outcome.backups, [])
  })

  it('leaves no staging directory behind after a successful restore', () => {
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows: []\n'),
    }))
    const home = scratchHome('stage-cleanup-target')
    const outcome = restoreConfigBackup(home, 'web', files, true)
    assert.equal(outcome.written, 1)
    assert.deepEqual(readdirSync(home).filter(name => name.startsWith('.config-import-stage-')), [])
  })

  it('rolls the swap back when a later member cannot be restored', () => {
    const home = scratchHome('rollback-target')
    mkdirSync(join(home, 'storages', 'dsh-app-plugin-foo'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), '{"enabled":true}\n', 'utf8')
    // A regular file occupies the second member's target directory path, so
    // the swap fails there after the first member is already in place.
    writeFileSync(join(home, 'storages', 'dsh-app-plugin-baz'), 'not a directory', 'utf8')
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'plugins/dsh-app-plugin-foo/config.json': strToU8('{"enabled":false}\n'),
      'plugins/dsh-app-plugin-baz/config.json': strToU8('{}\n'),
    }))
    assert.throws(
      () => restoreConfigBackup(home, 'web', files, true),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'io'
        && error.host.code === 'backup.writeFailedRestored',
    )
    // The replaced member came back; the failed member left nothing behind.
    assert.equal(readFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), 'utf8'), '{"enabled":true}\n')
    assert.ok(!existsSync(join(home, 'storages', 'dsh-app-plugin-baz', 'config.json')))
    assert.deepEqual(readdirSync(home).filter(name => name.startsWith('.config-import-stage-')), [])
  })
})
