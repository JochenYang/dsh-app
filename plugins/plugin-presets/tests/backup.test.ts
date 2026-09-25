/**
 * Config-backup tests: the export whitelist (whitelisted store files and the
 * host settings file ride along; credential-named files, a settings.yaml
 * planted inside a plugin store, and unknown names can never enter the
 * archive), rejection of hostile archives (path traversal, unknown layout,
 * wrong manifest) BEFORE anything is restored, the conflict / overwrite
 * contract on differing targets, and the automatic pre-overwrite copies of
 * the profile patch layer and the host settings file.
 *
 * @module plugin-presets/tests/backup
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { backupLayoutProblem, isSensitiveFileName, packConfigBackup, restoreConfigBackup, unpackConfigBackup } from '../src/backup.ts'
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

/**
 * The host settings file as a real one looks: providers that carry the
 * credential ENV VAR NAME (never the key) plus the gateway header a route may
 * demand. Neither shape may trip the content scan — this fixture proves it.
 */
const HOME_SETTINGS = [
  'llm-pi-ai:',
  '  providers:',
  '    gateway:',
  '      apiKeyEnv: GATEWAY_API_KEY',
  '      baseURL: https://gateway.example/v1',
  '      headers:',
  '        x-gateway-session: route-a',
  '      models:',
  '        - id: example-model',
  '          maxTokens: 32000',
  '          compat:',
  '            maxTokensField: max_tokens',
  'agent-default-model: gateway/example-model',
  '',
].join('\n')

/** A populated fake home: settings, hooks, profile layer, market sources, two stores. */
function writeHome(home: string): void {
  writeFileSync(join(home, 'settings.yaml'), HOME_SETTINGS, 'utf8')
  writeFileSync(join(home, 'AGENTS.md'), '# House rules\n\nKeep answers short.\n', 'utf8')
  // The home's own patch layer and dsh's credential store ride as exact-path
  // members — the two files a machine migration cannot reconstruct.
  writeFileSync(join(home, 'cordis.patch.yml'), 'rows:\n  - id: home-row\n', 'utf8')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  OPENAI_API_KEY: sk-abcdefghijklmnopqrstuv\n', 'utf8')
  mkdirSync(join(home, 'hooks'), { recursive: true })
  writeFileSync(join(home, 'hooks', 'hooks.json'), '{"hooks":{}}\n', 'utf8')
  writeFileSync(join(home, 'hooks', 'after-edit.mjs'), 'export default {}\n', 'utf8')
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
  // A store-level settings.yaml is still refused — by the store whitelist, not
  // by the name tripwire the host-level file is now exempt from.
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'settings.yaml'), 'tokens: hidden\n', 'utf8')
  writeFileSync(join(home, 'hooks', 'credentials.json'), '{"key":"x"}\n', 'utf8')
  writeFileSync(join(home, 'hooks', '.env'), 'FOO=bar\n', 'utf8')
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'other.json'), '{}\n', 'utf8')
  mkdirSync(join(home, 'storages', 'dsh-app-plugin-bar'), { recursive: true })
  writeFileSync(join(home, 'storages', 'dsh-app-plugin-bar', 'sources.json'), '{"sources":[]}\n', 'utf8')
}

describe('packConfigBackup (export whitelist)', () => {
  it('packs whitelisted files only and never credential-named ones', async () => {
    const home = scratchHome('export-home')
    writeHome(home)
    const { bytes, warnings } = await packConfigBackup(home, 'web')
    const zipped = unzipSync(bytes)
    const names = Object.keys(zipped).sort()
    assert.deepEqual(names, [
      'AGENTS.md',
      'cordis.patch.yml',
      'credentials.yaml',
      'hooks/after-edit.mjs',
      'hooks/hooks.json',
      'manifest.json',
      'market/sources.json',
      'plugins/dsh-app-plugin-bar/sources.json',
      'plugins/dsh-app-plugin-foo/config.json',
      'plugins/dsh-app-plugin-foo/servers.json',
      'profile/cordis.patch.yml',
      'profile/package.json',
      'settings.yaml',
    ])
    // The credential store rides byte-for-byte — it is the one credential file
    // the backup carries on purpose, admitted by exact path.
    assert.match(Buffer.from(zipped['credentials.yaml']!).toString('utf8'), /OPENAI_API_KEY/u)
    // Its key material is REPORTED, never hidden: the warning names the file
    // and the rule, and the export succeeds regardless.
    assert.deepEqual(warnings, [{ rel: 'credentials.yaml', rule: 'sk' }])
    // Payload bytes survive the round trip.
    assert.equal(Buffer.from(zipped['plugins/dsh-app-plugin-foo/config.json']!).toString('utf8'), '{"enabled":true}\n')
  })

  it('carries the settings file even after the kernel line renamed it', async () => {
    // 0.1.7 keeps user settings in the profile patch and renames `settings.yaml`
    // to `settings.yaml.imported` once it has imported it — so a home that has
    // been through that import has no `settings.yaml` at all. This is precisely
    // the home a migration backup is taken from, and looking only for the old
    // name dropped the one file the user cannot reconstruct.
    const home = mkdtempSync(join(scratchRoot, 'imported-'))
    writeHome(home)
    renameSync(join(home, 'settings.yaml'), join(home, 'settings.yaml.imported'))

    const zipped = unzipSync((await packConfigBackup(home, 'web')).bytes)
    assert.equal(Buffer.from(zipped['settings.yaml']!).toString('utf8'), HOME_SETTINGS)
    // The archive names the CONTENT, not the file it was read from: one path,
    // whatever this machine happens to call it.
    assert.equal(zipped['settings.yaml.imported'], undefined)
  })

  it('carries the settings file byte-for-byte, providers and all', async () => {
    const home = scratchHome('settings-home')
    writeHome(home)
    const zipped = unzipSync((await packConfigBackup(home, 'web')).bytes)
    assert.equal(Buffer.from(zipped['settings.yaml']!).toString('utf8'), HOME_SETTINGS)
    // Its namesake inside a plugin store never rides along, and the store
    // whitelist is the gate that refuses it — the same gate a hostile archive
    // meets on import.
    assert.equal(backupLayoutProblem('plugins/dsh-app-plugin-foo/settings.yaml')?.code, 'backup.storeFileNotAllowed')
    assert.equal(backupLayoutProblem('settings.yaml'), undefined)
    // The order of those two gates is the contract, not an accident: the name
    // tripwire still fires for a credential-named file, and the host settings
    // file is exempt from it because the whitelist already decides the store
    // block. Pinning the pair keeps a future reorder from going unnoticed.
    assert.equal(isSensitiveFileName('settings.yaml'), false)
    assert.equal(isSensitiveFileName('credentials.json'), true)
    assert.equal(backupLayoutProblem('plugins/dsh-app-plugin-foo/credentials.json')?.code, 'backup.storeFileNotAllowed')
    // AGENTS.md is user content with no other copy anywhere, so it rides in
    // the same root block as the settings file.
    assert.equal(backupLayoutProblem('AGENTS.md'), undefined)
    assert.equal(Buffer.from(zipped['AGENTS.md']!).toString('utf8'), '# House rules\n\nKeep answers short.\n')
  })

  it('carries top-level hook files and nothing else from the hooks directory', async () => {
    const home = scratchHome('hooks-home')
    writeHome(home)
    const zipped = unzipSync((await packConfigBackup(home, 'web')).bytes)
    assert.equal(Buffer.from(zipped['hooks/hooks.json']!).toString('utf8'), '{"hooks":{}}\n')
    assert.equal(Buffer.from(zipped['hooks/after-edit.mjs']!).toString('utf8'), 'export default {}\n')
    // These files are code the kernel will run, so the block admits one narrow
    // name shape at the top level only — and the layout gate, the same one a
    // hand-made archive meets, is what says so.
    assert.equal(backupLayoutProblem('hooks/.env')?.code, 'backup.hookFileInvalid')
    assert.equal(backupLayoutProblem('hooks/nested/deep.mjs')?.code, 'backup.hookFileInvalid')
    assert.equal(backupLayoutProblem('hooks/a:b.mjs')?.code, 'backup.hookFileInvalid')
    assert.equal(backupLayoutProblem('hooks/credentials.json')?.code, 'backup.hookFileSensitive')
    assert.equal(backupLayoutProblem('hooks/after-edit.mjs'), undefined)
  })

  it('carries the config-backup manifest shape', async () => {
    const home = scratchHome('manifest-home')
    writeHome(home)
    const { bytes } = await packConfigBackup(home, 'web')
    const manifest = JSON.parse(Buffer.from(unzipSync(bytes)['manifest.json']!).toString('utf8')) as Record<string, unknown>
    assert.equal(manifest.kind, 'dsh-config-backup')
    assert.equal(manifest.formatVersion, 1)
    assert.equal(manifest.app, 'dsh-app')
    assert.equal(typeof manifest.exportedAt, 'string')
  })

  it('tolerates a bare home (no profile layer, no storages yet)', async () => {
    const home = scratchHome('bare-home')
    const { bytes } = await packConfigBackup(home, 'web')
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
    const { bytes } = await packConfigBackup(home, 'web')
    const names = Object.keys(unzipSync(bytes))
    assert.ok(names.includes('plugins/dsh-app-plugin-foo/servers.json'))
    assert.ok(!names.includes('plugins/dsh-app-plugin-foo/config.json'))
  })
})

describe('packConfigBackup (content-level secret scan)', () => {
  it('reports a whitelisted store file that carries credential content — and packs it', async () => {
    const home = scratchHome('scan-authorization')
    mkdirSync(join(home, 'storages', 'dsh-app-plugin-mcp'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-app-plugin-mcp', 'servers.json'),
      '{"mcp":{"url":"https://mcp.example","headers":{"Authorization":"Bearer abcdefghijklmn"}}}\n', 'utf8')
    const { bytes, warnings } = await packConfigBackup(home, 'web')
    // The export SUCCEEDS: key material rides by design, and the warning names
    // the file and the rule (never the matched content) so the user is told.
    assert.deepEqual(warnings, [{ rel: 'plugins/dsh-app-plugin-mcp/servers.json', rule: 'authorization' }])
    assert.ok(Object.keys(unzipSync(bytes)).includes('plugins/dsh-app-plugin-mcp/servers.json'))
    assert.ok(!JSON.stringify(warnings).includes('abcdefghijklmn'))
  })

  it('reports the matched rule when the patch layer carries an api key shape', async () => {
    const home = scratchHome('scan-api-key')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'provider:\n  api_key = "0123456789abcd"\n', 'utf8')
    const { warnings } = await packConfigBackup(home, 'web')
    assert.deepEqual(warnings, [{ rel: 'profile/cordis.patch.yml', rule: 'api-key' }])
  })

  it('reports a real key pasted into a settings header — and packs it with the warning', async () => {
    const home = scratchHome('scan-settings')
    writeFileSync(join(home, 'settings.yaml'),
      'llm-pi-ai:\n  providers:\n    gateway:\n      headers:\n        x-api-key: 0123456789abcdef\n', 'utf8')
    const { bytes, warnings } = await packConfigBackup(home, 'web')
    assert.deepEqual(warnings, [{ rel: 'settings.yaml', rule: 'api-key' }])
    assert.ok(Object.keys(unzipSync(bytes)).includes('settings.yaml'))
    // The warning names file and rule only, never the matched value.
    assert.ok(!JSON.stringify(warnings).includes('0123456789abcdef'))
  })

  it('lets credential-free content through (names, numbers, references)', async () => {
    const home = scratchHome('scan-clean')
    mkdirSync(join(home, 'storages', 'dsh-app-plugin-foo'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), '{"token":false,"note":"rotate stale token material"}\n', 'utf8')
    // Numbers, suffixes, a word that merely ends in "sk", and an environment
    // reference are all settings, not secrets: a rule that refused any of them
    // would refuse the host settings file of every ordinary install.
    writeFileSync(join(home, 'settings.yaml'), [
      'limits:',
      '  tokenLimit: 4096',
      '  maxTokens: 32000',
      '  token: 4096',
      '  passwordPolicy: strict',
      'notes:',
      '  risk: risk-based approach',
      '  hotkey: ctrl-shift-p',
      '  ref: ${TOKEN}',
      '',
    ].join('\n'), 'utf8')
    const { bytes } = await packConfigBackup(home, 'web')
    const names = Object.keys(unzipSync(bytes))
    assert.ok(names.includes('plugins/dsh-app-plugin-foo/config.json'))
    assert.ok(names.includes('settings.yaml'))
  })

  it('reports bare and quoted credential shapes under credential-named keys', async () => {
    // The store files are JSON and quote their values; the host settings file
    // is YAML and may write them bare or single-quoted. Every shape trips the
    // same scan, and each case names the rule that must be reported — the
    // export itself now always succeeds.
    const cases = [
      ['token', 'token: abc123def4567890\n'],
      ['token', '"token": "abcd1234ef"\n'],
      ['secret', 'client_secret: abcdef1234567890\n'],
      ['secret', 'secretKey: abcdefghijkl\n'],
      ['password', "password: 'hunter2hunter2'\n"],
      ['sk', 'x-provider-key: sk-ant-api03-abcdefghijklmnopqrst\n'],
      ['github', 'tokenless: ghp_abcdefghijklmnopqrst\n'],
      ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n'],
    ] as const
    for (const [rule, body] of cases) {
      const home = scratchHome(`scan-shape-${rule}-${String(body.length)}`)
      writeFileSync(join(home, 'settings.yaml'), body, 'utf8')
      const { warnings } = await packConfigBackup(home, 'web')
      assert.deepEqual(warnings, [{ rel: 'settings.yaml', rule }],
        `the shape ${JSON.stringify(body)} must be reported under rule ${rule}`)
    }
  })

  it('reports the credential store as a warning, never as a refusal', async () => {
    // The one credential file that rides on purpose: its content hits the scan
    // by design, and that hit is the user's notice that the archive carries
    // plaintext keys — not a reason to fail the export.
    const home = scratchHome('scan-credentials')
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  KEY: sk-abcdefghijklmnopqrstuv\n', 'utf8')
    const { bytes, warnings } = await packConfigBackup(home, 'web')
    assert.deepEqual(warnings, [{ rel: 'credentials.yaml', rule: 'sk' }])
    assert.ok(Object.keys(unzipSync(bytes)).includes('credentials.yaml'))
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
  it('restores into a fresh home and reports every written member', async () => {
    const source = scratchHome('restore-src')
    writeHome(source)
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows:\n  - id: keep\n'),
      'market/sources.json': strToU8('{"sources":[]}\n'),
      'plugins/dsh-app-plugin-foo/config.json': strToU8('{"enabled":true}\n'),
      'settings.yaml': strToU8('agent-default-model: gateway/example-model\n'),
      'AGENTS.md': strToU8('# House rules\n'),
      'hooks/hooks.json': strToU8('{"hooks":{}}\n'),
    }))
    const home = scratchHome('restore-target')
    const outcome = await restoreConfigBackup(home, 'web', files, false)
    assert.equal(outcome.written, 6)
    assert.equal(outcome.unchanged, 0)
    // A fresh home has nothing to sidecar: every member here is new.
    assert.deepEqual(outcome.backups, [])
    assert.equal(readFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), 'utf8'), '{"enabled":true}\n')
    assert.ok(existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml')))
    assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'agent-default-model: gateway/example-model\n')
    assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '# House rules\n')
    assert.equal(readFileSync(join(home, 'hooks', 'hooks.json'), 'utf8'), '{"hooks":{}}\n')
  })

  it('sidecars the previous host settings file before replacing it', async () => {
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'settings.yaml': strToU8('agent-default-model: gateway/example-model\n'),
    }))
    const home = scratchHome('settings-overwrite-target')
    writeFileSync(join(home, 'settings.yaml'), 'agent-default-model: local/other-model\n', 'utf8')
    const outcome = await restoreConfigBackup(home, 'web', files, true, () => new Date('2026-09-13T08:09:07.000Z'))
    assert.equal(outcome.written, 1)
    assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'agent-default-model: gateway/example-model\n')
    assert.deepEqual(outcome.backups, ['settings.yaml.bak-import-2026-09-13T08-09-07-000Z'])
    assert.equal(
      readFileSync(join(home, 'settings.yaml.bak-import-2026-09-13T08-09-07-000Z'), 'utf8'),
      'agent-default-model: local/other-model\n',
    )
  })

  it('restores the home patch layer and the credential store to their own targets', async () => {
    // The two members a machine migration cannot reconstruct: hand-written
    // rows and the API keys. The round trip is pack -> unpack -> restore, the
    // same path a user's exported backup takes.
    const source = scratchHome('new-members-src')
    writeHome(source)
    const { bytes } = await packConfigBackup(source, 'web')
    const files = unpackConfigBackup(bytes)
    const home = scratchHome('new-members-target')
    const outcome = await restoreConfigBackup(home, 'web', files, false)
    assert.ok(outcome.written >= 2)
    assert.equal(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'), 'rows:\n  - id: home-row\n')
    assert.match(readFileSync(join(home, '.credentials.yaml'), 'utf8'), /OPENAI_API_KEY/u)
    // Layout: both paths are first-class members, and a store-shaped guess at
    // them is refused.
    assert.equal(backupLayoutProblem('cordis.patch.yml'), undefined)
    assert.equal(backupLayoutProblem('credentials.yaml'), undefined)
    // Negative: the home block admits exactly those two paths beside the
    // settings file and AGENTS.md. A future widening must not silently start
    // packing other root-level files — this pair is the invariant that
    // answers "what else can carry keys".
    assert.equal(backupLayoutProblem('other.yml')?.code, 'backup.unknownBlock')
    assert.equal(backupLayoutProblem('nested/deep.yml')?.code, 'backup.unknownBlock')
    assert.equal(backupLayoutProblem('.credentials.yaml')?.code, 'backup.unknownBlock')
    assert.equal(backupLayoutProblem('plugins/dsh-app-plugin-foo/.credentials.yaml')?.code, 'backup.storeFileNotAllowed')
  })

  it('restores the transitional home/ archive shape to the same targets', async () => {
    // The intermediate (never released) build wrote the two home members
    // under home/; an archive exported by it must still restore.
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'home/cordis.patch.yml': strToU8('rows:\n  - id: legacy-home\n'),
      'home/credentials.yaml': strToU8('version: 1\nrefs:\n  KEY: sk-abcdefghijklmnopqrstuv\n'),
    }))
    const home = scratchHome('legacy-home-target')
    const outcome = await restoreConfigBackup(home, 'web', files, false)
    assert.equal(outcome.written, 2)
    assert.equal(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'), 'rows:\n  - id: legacy-home\n')
    assert.match(readFileSync(join(home, '.credentials.yaml'), 'utf8'), /sk-abcdefghijklmnopqrstuv/u)
    // And the layout gate still refuses anything else under that prefix.
    assert.equal(backupLayoutProblem('home/other.yml')?.code, 'backup.unknownBlock')
  })

  it('sidecars the previous credential store before replacing it', async () => {
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'credentials.yaml': strToU8('version: 1\nrefs:\n  KEY: sk-abcdefghijklmnopqrstuv\n'),
    }))
    const home = scratchHome('credentials-overwrite-target')
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  KEY: sk-oldoldoldoldoldoldoldold\n', 'utf8')
    const outcome = await restoreConfigBackup(home, 'web', files, true, () => new Date('2026-09-13T08:09:07.000Z'))
    assert.equal(outcome.written, 1)
    assert.match(readFileSync(join(home, '.credentials.yaml'), 'utf8'), /sk-abcdefghijklmnopqrstuv/u)
    assert.deepEqual(outcome.backups, ['credentials.yaml.bak-import-2026-09-13T08-09-07-000Z'])
  })

  it('skips members whose target already has identical content', async () => {
    const source = scratchHome('unchanged-src')
    writeHome(source)
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'market/sources.json': strToU8('{"sources":[]}\n'),
    }))
    const home = scratchHome('unchanged-target')
    mkdirSync(join(home, 'storages', 'dsh-app-plugin-market'), { recursive: true })
    writeFileSync(join(home, 'storages', 'dsh-app-plugin-market', 'sources.json'), '{"sources":[]}\n', 'utf8')
    const outcome = await restoreConfigBackup(home, 'web', files, false)
    assert.equal(outcome.written, 0)
    assert.equal(outcome.unchanged, 1)
  })

  it('refuses differing targets without overwrite, naming every conflict', async () => {
    const source = scratchHome('conflict-src')
    writeHome(source)
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'market/sources.json': strToU8('{"sources":["https://a.example"]}\n'),
      'plugins/dsh-app-plugin-foo/config.json': strToU8('{"enabled":false}\n'),
    }))
    const home = scratchHome('conflict-target')
    writeHome(home) // same shapes, different content
    await assert.rejects(
      async () => restoreConfigBackup(home, 'web', files, false),
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

  it('overwrites differing targets with overwrite=true and backs up the patch layer', async () => {
    const source = scratchHome('overwrite-src')
    writeHome(source)
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows:\n  - id: restored\n'),
      'plugins/dsh-app-plugin-foo/config.json': strToU8('{"enabled":false}\n'),
    }))
    const home = scratchHome('overwrite-target')
    writeHome(home)
    const outcome = await restoreConfigBackup(home, 'web', files, true, () => new Date('2026-09-13T08:09:07.000Z'))
    assert.equal(outcome.written, 2)
    assert.equal(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), 'rows:\n  - id: restored\n')
    assert.equal(readFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), 'utf8'), '{"enabled":false}\n')
    // The pre-overwrite sidecar keeps the previous patch layer recoverable.
    assert.deepEqual(outcome.backups, ['profile/cordis.patch.yml.bak-import-2026-09-13T08-09-07-000Z'])
    const sidecars = readdirSync(join(home, 'profiles', 'web')).filter(name => name.includes('.bak-import-'))
    assert.equal(sidecars.length, 1)
    assert.equal(readFileSync(join(home, 'profiles', 'web', sidecars[0]!), 'utf8'), 'rows:\n  - id: keep\n')
  })

  it('does not create a patch sidecar when the patch layer is new', async () => {
    const source = scratchHome('freshpatch-src')
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows: []\n'),
    }))
    const home = scratchHome('freshpatch-target')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const outcome = await restoreConfigBackup(home, 'web', files, true)
    assert.equal(outcome.written, 1)
    assert.deepEqual(outcome.backups, [])
  })

  it('leaves no staging directory behind after a successful restore', async () => {
    const files = unpackConfigBackup(zipSync({
      'manifest.json': VALID_MANIFEST,
      'profile/cordis.patch.yml': strToU8('rows: []\n'),
    }))
    const home = scratchHome('stage-cleanup-target')
    const outcome = await restoreConfigBackup(home, 'web', files, true)
    assert.equal(outcome.written, 1)
    assert.deepEqual(readdirSync(home).filter(name => name.startsWith('.config-import-stage-')), [])
  })

  it('rolls the swap back when a later member cannot be restored', async () => {
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
    await assert.rejects(
      async () => restoreConfigBackup(home, 'web', files, true),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'io'
        && error.host.code === 'backup.writeFailedRestored',
    )
    // The replaced member came back; the failed member left nothing behind.
    assert.equal(readFileSync(join(home, 'storages', 'dsh-app-plugin-foo', 'config.json'), 'utf8'), '{"enabled":true}\n')
    assert.ok(!existsSync(join(home, 'storages', 'dsh-app-plugin-baz', 'config.json')))
    assert.deepEqual(readdirSync(home).filter(name => name.startsWith('.config-import-stage-')), [])
  })

  it('refuses a member outside the layout before it writes anything', async () => {
    const home = scratchHome('layout-guard-target')
    // The layout guard inside restoreConfigBackup is the second line of
    // defence: a caller that never went through unpackConfigBackup still
    // cannot write, and nothing — not even a stage directory — is created.
    await assert.rejects(
      () => restoreConfigBackup(home, 'web', [{ rel: 'random/file.json', data: strToU8('{}') }], true),
      (error: unknown) => error instanceof PresetPackageError && error.code === 'illegal-path'
        && error.host.code === 'backup.illegalPath',
    )
    assert.deepEqual(readdirSync(home), [])
  })
})
