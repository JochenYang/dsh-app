/**
 * Installed-view tests: the projection of a profile manifest to the client
 * view (dependencies + per-package bundle-layer membership + suite/entry-id/
 * enabled state), including its degrade behavior on missing manifests, absent
 * node_modules, and unreadable patch layers.
 *
 * @module plugin-market/tests/installed
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { checkUpdateTarget, dependencySourceOf, installGateOf, readInstalled, withUpdateFacts } from '../src/routes.ts'
import type { InstalledPackageView } from '../src/routes.ts'

/** The real bundle-patch shape: an insert row whose id may differ from the package name. */
const INSERT_PATCH = `# usage bundle patch
- insert:
    - id: usage-heatmap
      name: dsh-usage-heatmap
      config:
        storePath: ""
`

describe('readInstalled', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-market-installed-'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('projects dependencies and marks bundle-layer membership', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: {
        'dsh-git-conventions': '^0.1.0',
        '@dsh-app/plugin-market': '0.1.0',
        'plain-lib': '1.0.0',
      },
      dsh: { profile: { bundles: ['dsh-git-conventions'] } },
    }), 'utf8')
    const view = readInstalled(dir, 'web')
    assert.equal(view.profile, 'web')
    assert.equal(view.manifestAvailable, true)
    // Without node_modules and a patch layer every package reads as enabled,
    // non-suite, registry-sourced, and falls back to the package name as its
    // entry id.
    assert.deepEqual(view.packages, [
      { name: 'dsh-git-conventions', version: '^0.1.0', bundled: true, suite: false, entryId: 'dsh-git-conventions', enabled: true, source: 'registry' },
      { name: '@dsh-app/plugin-market', version: '0.1.0', bundled: false, suite: true, entryId: '@dsh-app/plugin-market', enabled: true, source: 'registry' },
      { name: 'plain-lib', version: '1.0.0', bundled: false, suite: false, entryId: 'plain-lib', enabled: true, source: 'registry' },
    ])
  })

  it('classifies file/link and git dependency specs by their install source', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: {
        'dsh-pet': 'file:D:/work/dsh-pet/dsh-pet-0.2.0.tgz',
        'linked-dev': 'link:../dsh-remote',
        'dsh-remote': 'github:owner/dsh-remote',
        'git-https': 'git+https://github.com/owner/repo.git',
        'git-scp': 'git@github.com:owner/repo.git',
        'gitee-host': 'https://gitee.com/owner/repo.git',
        'plain-pkg': '^1.2.0',
      },
    }), 'utf8')
    const view = readInstalled(dir, 'web')
    const sourceOf = (name: string): string | undefined => view.packages.find(pkg => pkg.name === name)?.source
    assert.equal(sourceOf('dsh-pet'), 'local')
    assert.equal(sourceOf('linked-dev'), 'local')
    assert.equal(sourceOf('dsh-remote'), 'git')
    assert.equal(sourceOf('git-https'), 'git')
    assert.equal(sourceOf('git-scp'), 'git')
    assert.equal(sourceOf('gitee-host'), 'git')
    assert.equal(sourceOf('plain-pkg'), 'registry')
  })

  it('finds the entry id in an ORDERED patch list, not only in a single file', () => {
    // `dsh.bundle.patch` is one file or an ordered list of them on this kernel
    // line (`packages/boot/app-boot`, `bundlePatchPaths`). A list used to fall
    // through to `entryId: name`, which matches no composed row — so the panel's
    // disable wrote a row nothing named and showed "disabled" while the package
    // stayed loaded.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-usage-heatmap': '^0.1.1' },
    }), 'utf8')
    const pkgDir = join(dir, 'node_modules', 'dsh-usage-heatmap')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'dsh-usage-heatmap',
      dsh: { bundle: { patch: ['./first.patch.yml', './cordis.patch.yml'] } },
    }), 'utf8')
    // The FIRST file carries no insert row for this package; the second does —
    // declaration order is the order the kernel composes them in.
    writeFileSync(join(pkgDir, 'first.patch.yml'), '- id: unrelated\n  disabled: true\n', 'utf8')
    writeFileSync(join(pkgDir, 'cordis.patch.yml'), INSERT_PATCH, 'utf8')

    const view = readInstalled(dir, 'web')
    assert.equal(view.packages.find(pkg => pkg.name === 'dsh-usage-heatmap')?.entryId, 'usage-heatmap')
  })

  it('derives the entry id from the package bundle patch and the enabled state from the profile patch', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-usage-heatmap': '^0.1.1', 'dsh-better-edit': '^0.8.1' },
    }), 'utf8')
    const pkgDir = join(dir, 'node_modules', 'dsh-usage-heatmap')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'dsh-usage-heatmap',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }), 'utf8')
    writeFileSync(join(pkgDir, 'cordis.patch.yml'), INSERT_PATCH, 'utf8')
    // The profile layer disables the composed entry id, not the package name.
    writeFileSync(join(dir, 'cordis.patch.yml'), '# user notes\n- id: usage-heatmap\n  disabled: true\n', 'utf8')
    const view = readInstalled(dir, 'web')
    const heat = view.packages.find(pkg => pkg.name === 'dsh-usage-heatmap')
    const edit = view.packages.find(pkg => pkg.name === 'dsh-better-edit')
    assert.deepEqual(heat, {
      name: 'dsh-usage-heatmap', version: '^0.1.1', bundled: false, suite: false,
      entryId: 'usage-heatmap', enabled: false, source: 'registry',
    })
    assert.equal(edit?.entryId, 'dsh-better-edit')
    assert.equal(edit?.enabled, true)
  })

  it('ignores nested insert rows without a disabled flag and quoted names', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-usage-heatmap': '^0.1.1' },
    }), 'utf8')
    const pkgDir = join(dir, 'node_modules', 'dsh-usage-heatmap')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'dsh-usage-heatmap',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }), 'utf8')
    writeFileSync(join(pkgDir, 'cordis.patch.yml'), INSERT_PATCH, 'utf8')
    // The insert row names the package but disables nothing; a quoted id in a
    // disable row still counts.
    writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: usage-heatmap\n      name: 'dsh-usage-heatmap'\n- id: 'usage-heatmap'\n  disabled: true\n", 'utf8')
    const view = readInstalled(dir, 'web')
    assert.equal(view.packages[0]?.enabled, false)
  })

  it('tolerates a manifest without dependencies or bundles', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-x' }), 'utf8')
    const view = readInstalled(dir, 'web')
    assert.deepEqual(view.packages, [])
    assert.equal(view.manifestAvailable, true)
  })

  it('degrades a missing manifest to an empty view', () => {
    const view = readInstalled(join(dir, 'absent'), 'web')
    assert.deepEqual(view.packages, [])
    assert.equal(view.manifestAvailable, false)
  })

  it('ignores malformed dependency rows instead of throwing', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { good: '1.0.0', bad: null, worse: 3 },
      dsh: { profile: { bundles: 'not-an-array' } },
    }), 'utf8')
    const view = readInstalled(dir, 'web')
    assert.deepEqual(view.packages, [
      { name: 'good', version: '1.0.0', bundled: false, suite: false, entryId: 'good', enabled: true, source: 'registry' },
    ])
  })

  it('builds the route path from the resolved profile dir', () => {
    mkdirSync(join(dir, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(dir, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')
    const view = readInstalled(join(dir, 'profiles', 'web'), 'web')
    assert.equal(view.manifestAvailable, true)
  })

  it('projects the installed version from each package manifest and degrades to the spec alone', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '~2.0.0', 'pkg-c': '3.0.0' },
    }), 'utf8')
    for (const [name, version] of [['pkg-a', '1.2.0'], ['pkg-b', '']] as const) {
      const pkgDir = join(dir, 'node_modules', name)
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
    }
    const view = readInstalled(dir, 'web')
    assert.deepEqual(view.packages.map(pkg => pkg.installedVersion ?? null), ['1.2.0', null, null])
    // The dependency spec stays untouched on `version`.
    assert.deepEqual(view.packages.map(pkg => pkg.version), ['^1.0.0', '~2.0.0', '3.0.0'])
  })

  it('projects the normalized repo key from the package manifest for every install source', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': 'github:o/r-b', 'pkg-c': 'file:../pkg-c' },
    }), 'utf8')
    const writeManifest = (name: string, manifest: Record<string, unknown>): void => {
      const pkgDir = join(dir, 'node_modules', name)
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest), 'utf8')
    }
    writeManifest('pkg-a', {
      name: 'pkg-a', version: '1.0.0',
      repository: { url: 'git+https://github.com/Owner/Repo-A.git' },
    })
    writeManifest('pkg-b', { name: 'pkg-b', version: '0.2.0', repository: 'git+ssh://git@github.com/o/r-b.git' })
    writeManifest('pkg-c', { name: 'pkg-c', homepage: 'https://github.com/o/r-c' })
    const view = readInstalled(dir, 'web')
    const keyOf = (name: string): string | undefined => view.packages.find(pkg => pkg.name === name)?.repoKey
    // Registry, git, and local rows alike carry the key when a repo URL exists.
    assert.equal(keyOf('pkg-a'), 'github.com/owner/repo-a')
    assert.equal(keyOf('pkg-b'), 'github.com/o/r-b')
    assert.equal(keyOf('pkg-c'), 'github.com/o/r-c')
  })

  it('omits the repo key when the manifest carries no repo URL', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'pkg-a': '^1.0.0' },
    }), 'utf8')
    const pkgDir = join(dir, 'node_modules', 'pkg-a')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }), 'utf8')
    const view = readInstalled(dir, 'web')
    assert.equal(view.packages[0]?.repoKey, undefined)
  })
})

describe('withUpdateFacts', () => {
  const view = {
    profile: 'web',
    manifestAvailable: true,
    packages: [
      { name: 'pkg-outdated', version: '^1.0.0', bundled: false, suite: false, entryId: 'pkg-outdated', enabled: true, source: 'registry' as const, installedVersion: '1.0.0' },
      { name: 'pkg-current', version: '^2.0.0', bundled: false, suite: false, entryId: 'pkg-current', enabled: true, source: 'registry' as const, installedVersion: '2.5.0' },
      { name: 'pkg-prerelease', version: '^0.1.0', bundled: false, suite: false, entryId: 'pkg-prerelease', enabled: true, source: 'registry' as const, installedVersion: '0.1.0-rc.1' },
      { name: 'pkg-noversion', version: '^3.0.0', bundled: false, suite: false, entryId: 'pkg-noversion', enabled: true, source: 'registry' as const },
      { name: 'pkg-local', version: 'file:D:/dev/dsh-pet/dsh-pet.tgz', bundled: false, suite: false, entryId: 'pkg-local', enabled: true, source: 'local' as const, installedVersion: '0.2.0' },
      { name: 'pkg-git', version: 'github:owner/dsh-remote', bundled: false, suite: false, entryId: 'pkg-git', enabled: true, source: 'git' as const, installedVersion: '0.3.0' },
    ],
  }

  it('marks updateAvailable only when latest sorts above the installed version', () => {
    const result = withUpdateFacts(view, {
      'pkg-outdated': '1.4.0',
      'pkg-current': '2.5.0',
      'pkg-prerelease': '0.1.0-rc.2',
      'pkg-noversion': '3.1.0',
    })
    const byName = new Map(result.packages.map(pkg => [pkg.name, pkg]))
    assert.equal(byName.get('pkg-outdated')?.updateAvailable, true)
    assert.equal(byName.get('pkg-outdated')?.latest, '1.4.0')
    assert.equal(byName.get('pkg-current')?.updateAvailable, undefined)
    assert.equal(byName.get('pkg-current')?.latest, '2.5.0')
    // Prerelease ladder counts: rc.2 > rc.1.
    assert.equal(byName.get('pkg-prerelease')?.updateAvailable, true)
  })

  it('answers no update when the installed version is unknown or the probe failed', () => {
    const result = withUpdateFacts(view, { 'pkg-noversion': '9.0.0', 'pkg-outdated': undefined })
    const byName = new Map(result.packages.map(pkg => [pkg.name, pkg]))
    assert.equal(byName.get('pkg-noversion')?.updateAvailable, undefined)
    assert.equal(byName.get('pkg-outdated')?.latest, undefined)
    assert.equal(byName.get('pkg-outdated')?.updateAvailable, undefined)
  })

  it('never marks local/git installs as updatable, even with a newer registry version', () => {
    const result = withUpdateFacts(view, { 'pkg-local': '9.9.9', 'pkg-git': '9.9.9' })
    const byName = new Map(result.packages.map(pkg => [pkg.name, pkg]))
    // The probe result must not leak into the local/git rows: an update there
    // would overwrite the development version with the npm release.
    assert.equal(byName.get('pkg-local')?.latest, undefined)
    assert.equal(byName.get('pkg-local')?.updateAvailable, undefined)
    assert.equal(byName.get('pkg-git')?.latest, undefined)
    assert.equal(byName.get('pkg-git')?.updateAvailable, undefined)
  })
})

describe('dependencySourceOf', () => {
  it('reads file:/link: specs as local installs', () => {
    for (const spec of ['file:D:/dev/pkg/pkg-1.0.0.tgz', 'file:./local', 'link:../dsh-remote', 'file:/abs/path']) {
      assert.equal(dependencySourceOf(spec), 'local', spec)
    }
  })

  it('reads github:/git+ and git-host URLs as git installs', () => {
    for (const spec of [
      'github:owner/repo',
      'git+https://github.com/owner/repo.git',
      'git+ssh://git@github.com/owner/repo.git',
      'git://github.com/owner/repo.git',
      'git@github.com:owner/repo.git',
      'https://gitlab.com/owner/repo',
      'https://gitee.com/owner/repo.git',
    ]) {
      assert.equal(dependencySourceOf(spec), 'git', spec)
    }
  })

  it('reads version ranges and registry URLs as registry installs', () => {
    for (const spec of ['^1.2.0', '~0.1.0', '1.2.3', 'next', 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz']) {
      assert.equal(dependencySourceOf(spec), 'registry', spec)
    }
  })
})

describe('checkUpdateTarget (POST /update gate)', () => {
  const pkg = (overrides: Partial<InstalledPackageView> = {}): InstalledPackageView => ({
    name: 'pkg-a',
    version: '^1.0.0',
    bundled: false,
    suite: false,
    entryId: 'pkg-a',
    enabled: true,
    installedVersion: '1.0.0',
    source: 'registry',
    ...overrides,
  })

  it('answers the exact latest version when the package is installed and outdated', () => {
    assert.deepEqual(checkUpdateTarget(pkg(), '1.4.0'), { ok: true, version: '1.4.0' })
  })

  it('refuses packages that are not installed, suite-managed, unprobed, or already current', () => {
    assert.equal(checkUpdateTarget(undefined, '1.4.0').ok, false)
    assert.equal(checkUpdateTarget(pkg({ suite: true }), '1.4.0').ok, false)
    assert.equal(checkUpdateTarget(pkg(), undefined).ok, false)
    assert.equal(checkUpdateTarget(pkg({ installedVersion: undefined }), '1.4.0').ok, false)
    // Equal and older latest both count as current.
    assert.equal(checkUpdateTarget(pkg({ installedVersion: '1.4.0' }), '1.4.0').ok, false)
    assert.equal(checkUpdateTarget(pkg({ installedVersion: '2.0.0' }), '1.4.0').ok, false)
  })

  it('refuses local/git installs: npm has no authoritative version for them', () => {
    assert.equal(checkUpdateTarget(pkg({ source: 'local', version: 'file:D:/dev/pkg.tgz' }), '1.4.0').ok, false)
    assert.equal(checkUpdateTarget(pkg({ source: 'git', version: 'github:owner/repo' }), '1.4.0').ok, false)
  })
})

describe('installGateOf (POST /install force gate)', () => {
  const installed = (overrides: Partial<InstalledPackageView> = {}): InstalledPackageView => ({
    name: 'pkg-a',
    version: '^1.0.0',
    bundled: false,
    suite: false,
    entryId: 'pkg-a',
    enabled: true,
    source: 'registry',
    repoKey: 'github.com/o/pkg-a',
    ...overrides,
  })

  it('allows the install without a same-name collision', () => {
    assert.equal(installGateOf(undefined, 'github.com/o/pkg-a', false).action, 'allow')
  })

  it('allows a registry collision whose repo keys match', () => {
    assert.equal(installGateOf(installed(), 'github.com/o/pkg-a', false).action, 'allow')
  })

  it('refuses a cross-origin registry collision and names both repos', () => {
    const gate = installGateOf(installed(), 'github.com/x/pkg-a', false)
    assert.equal(gate.action, 'refuse')
    if (gate.action !== 'refuse') return
    // The refusal is a code plus the two repo keys: the sentence (and the
    // force: true instruction) is the panel dictionary's.
    assert.equal(gate.reason.code, 'install.confirmCrossOrigin')
    assert.equal(gate.reason.params?.installed, 'github.com/o/pkg-a')
    assert.equal(gate.reason.params?.incoming, 'github.com/x/pkg-a')
  })

  it('treats an unknown side as a different origin', () => {
    assert.equal(installGateOf(installed({ repoKey: undefined }), 'github.com/o/pkg-a', false).action, 'refuse')
    assert.equal(installGateOf(installed(), null, false).action, 'refuse')
  })

  it('refuses a local/git install without force and names both repos', () => {
    const gate = installGateOf(installed({ source: 'git', repoKey: 'github.com/o/pkg-a' }), null, false)
    assert.equal(gate.action, 'refuse')
    if (gate.action !== 'refuse') return
    assert.equal(gate.reason.code, 'install.confirmLocal')
    assert.equal(gate.reason.params?.installed, 'github.com/o/pkg-a')
    // An unprovable side is a nested code, never a Chinese word on the wire.
    assert.equal(gate.reason.params?.incoming, 'repo.unknown')
  })

  it('confirms under force with a log line naming both repos', () => {
    const gate = installGateOf(installed({ source: 'local' }), 'github.com/x/pkg-a', true)
    assert.equal(gate.action, 'confirm')
    if (gate.action !== 'confirm') return
    assert.ok(gate.log.includes('github.com/o/pkg-a'))
    assert.ok(gate.log.includes('github.com/x/pkg-a'))
  })
})
