// The profile as an installed tree: what the shell puts inside a profile for a
// host line that anchors the kernel packages on the profile itself (0.1.5 and
// earlier, see `hostProfileAnchor`), and — the property this shape was chosen
// for — what a recursive delete inside the profile may NOT reach.
//
// The failure that shape avoids was measured on this machine: `fs.rmSync(dir,
// { recursive: true })` on a directory holding junctions into a runtime tree
// emptied that runtime's own package directories (Electron 44.4.1 / Node
// 24.21). A profile is a directory users and package managers delete, so the
// mirror is made of hardlinks and links inside it are never followed. The
// junction case below is that regression, kept as a test.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  PROFILE_KERNEL_MARKER,
  dropRuntimeMirror,
  lockfileOwnedNames,
  mirrorRuntimeIntoProfile,
} = require('../dist/main/suite-profile.js')

/** A runtime tree with the two shapes that matter: a scoped kernel package and a vendor package. */
function fakeRuntime() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-runtime-'))
  const scoped = path.join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(path.join(scoped, 'lib'), { recursive: true })
  writeFileSync(path.join(scoped, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.2"}\n')
  writeFileSync(path.join(scoped, 'lib', 'index.js'), 'module.exports = 1\n')
  const vendor = path.join(root, 'node_modules', 'yaml')
  mkdirSync(vendor, { recursive: true })
  writeFileSync(path.join(vendor, 'package.json'), '{"name":"yaml"}\n')
  return root
}

/** A seeded suite profile: the manifest plus whatever node_modules it already has. */
function fakeProfile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-profile-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), '{"name":"dsh-profile-dsh-app","private":true}\n')
  return dir
}

test('the mirror gives the profile the runtime tree, and a second start writes nothing', async () => {
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  const first = await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(first.status, 'mirrored')
  assert.equal(first.entries, 2)
  assert.equal(first.files, 3)
  assert.equal(
    readFileSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'index.js'), 'utf8'),
    'module.exports = 1\n',
  )
  assert.ok(existsSync(path.join(profile, PROFILE_KERNEL_MARKER)))

  const second = await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(second.status, 'already')
  assert.equal(second.entries, 2)
  assert.equal(second.files, first.files)

  // A package the runtime does not carry — the market's own install, pnpm's
  // state — is not the mirror's to touch.
  const foreign = path.join(profile, 'node_modules', 'dsh-deja', 'package.json')
  mkdirSync(path.dirname(foreign), { recursive: true })
  writeFileSync(foreign, '{"name":"dsh-deja"}\n')
  await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(readFileSync(foreign, 'utf8'), '{"name":"dsh-deja"}\n')
})

test('dropping the mirror leaves the suite scope alone: the shell links it every start', async () => {
  const runtime = fakeRuntime()
  // The shipping runtime CARRIES the suite's own packages, so a mirror of it
  // records them — and the drop must not take back what the link step has just
  // put there: 17 entries stop activating when it does.
  const suite = path.join(runtime, 'node_modules', '@dsh-app', 'plugin-brand')
  mkdirSync(suite, { recursive: true })
  writeFileSync(path.join(suite, 'package.json'), '{"name":"@dsh-app/plugin-brand"}\n')
  const profile = fakeProfile()
  await mirrorRuntimeIntoProfile(runtime, profile)
  const linked = path.join(profile, 'node_modules', '@dsh-app', 'plugin-brand')
  assert.ok(existsSync(linked))

  const dropped = await dropRuntimeMirror(profile, runtime)
  assert.equal(dropped.status, 'removed')
  assert.ok(existsSync(linked), 'the suite scope survives a drop')
  // Everything else the mirror wrote still goes.
  assert.equal(existsSync(path.join(profile, 'node_modules', 'yaml')), false)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh')), false)
})

test('dropping the mirror removes the profile copy without following links inside it', async () => {
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  await mirrorRuntimeIntoProfile(runtime, profile)

  // A link of exactly the kind a package manager or an earlier shell leaves
  // behind. `fs.rm(recursive)` would walk through it and take the runtime's
  // files with it; the mirror's own remover must not.
  symlinkSync(
    path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib'),
    path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-desktop-host'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const dropped = await dropRuntimeMirror(profile)
  assert.equal(dropped.status, 'removed')
  assert.equal(dropped.entries, 2)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh')), false)
  assert.equal(existsSync(path.join(profile, 'node_modules', 'yaml')), false)
  assert.equal(existsSync(path.join(profile, PROFILE_KERNEL_MARKER)), false)
  // The scope directory itself survives, holding that unowned link: a scope is
  // shared ground, so only a package the mirror wrote may leave it.
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')), true)
  // The runtime is exactly as it was.
  assert.equal(readFileSync(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'index.js'), 'utf8'), 'module.exports = 1\n')
  assert.equal(readFileSync(path.join(runtime, 'node_modules', 'yaml', 'package.json'), 'utf8'), '{"name":"yaml"}\n')
})

test('the market keeps its packages inside a kernel scope, on a drop and on a re-mirror', async () => {
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  // `@deepseek-ai/dsh-toolkit` is a real package laid out exactly like this: the
  // market installs it into the same scope the kernel ships `@deepseek-ai/dsh`
  // in, and the profile manifest declares it as a bundle. A drop that takes the
  // scope wholesale leaves a manifest naming a bundle that cannot resolve, and
  // the host refuses to boot it.
  const market = path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-toolkit')
  mkdirSync(market, { recursive: true })
  writeFileSync(path.join(market, 'package.json'), '{"name":"@deepseek-ai/dsh-toolkit"}\n')
  await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(readFileSync(path.join(market, 'package.json'), 'utf8'), '{"name":"@deepseek-ai/dsh-toolkit"}\n')

  // A marker an older shell wrote records the SCOPE rather than the packages in
  // it; the drop narrows such a name to what the MIRRORED tree carries there.
  const legacy = (names, from = realpathSync(runtime)) => writeFileSync(
    path.join(profile, PROFILE_KERNEL_MARKER),
    `${JSON.stringify({ runtime: from, names, files: 3, at: new Date().toISOString() })}\n`,
  )
  legacy(['@deepseek-ai', 'yaml'])
  const dropped = await dropRuntimeMirror(profile, runtime)
  assert.equal(dropped.status, 'removed')
  assert.equal(dropped.entries, 2)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh')), false)
  assert.equal(existsSync(path.join(profile, 'node_modules', 'yaml')), false)
  assert.equal(readFileSync(path.join(market, 'package.json'), 'utf8'), '{"name":"@deepseek-ai/dsh-toolkit"}\n')

  // A marker whose kernel has been cleaned up cannot be narrowed at all: the
  // scope stays (a stale kernel copy is recoverable, a user package is not).
  await mirrorRuntimeIntoProfile(runtime, profile)
  const gone = path.join(os.tmpdir(), 'dsh-kernel-cleaned-up', String(Date.now()))
  legacy(['@deepseek-ai'], gone)
  const blind = await dropRuntimeMirror(profile)
  assert.equal(blind.status, 'removed')
  assert.equal(blind.entries, 0)
  assert.deepEqual(blind.kept.map((entry) => entry.name), ['@deepseek-ai'])
  assert.equal(readFileSync(path.join(market, 'package.json'), 'utf8'), '{"name":"@deepseek-ai/dsh-toolkit"}\n')
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh')), true)

  // And a re-mirror over that legacy marker must not prune the package it just
  // wrote back into the scope.
  await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(readFileSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'), '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.2"}\n')
  assert.equal(readFileSync(path.join(market, 'package.json'), 'utf8'), '{"name":"@deepseek-ai/dsh-toolkit"}\n')
})

test('a legacy marker is narrowed against the tree it mirrored, not the one running now', async () => {
  // The old line carried a package this one does not. Narrowing against the
  // tree running NOW (the old behaviour) leaves that copy behind, and a
  // leftover kernel package shadows this line's own — measured on the rc-to-
  // 0.1.6 move, where the host composed the rc `dsh-typert-loader` out of the
  // profile and the terminal plugins failed to activate.
  const old = fakeRuntime()
  mkdirSync(path.join(old, 'node_modules', '@deepseek-ai', 'dsh-old'), { recursive: true })
  writeFileSync(path.join(old, 'node_modules', '@deepseek-ai', 'dsh-old', 'package.json'), '{"name":"@deepseek-ai/dsh-old"}\n')
  const now = fakeRuntime()
  const profile = fakeProfile()
  const market = path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-toolkit')
  mkdirSync(market, { recursive: true })
  writeFileSync(path.join(market, 'package.json'), '{"name":"@deepseek-ai/dsh-toolkit"}\n')
  await mirrorRuntimeIntoProfile(old, profile)
  writeFileSync(
    path.join(profile, PROFILE_KERNEL_MARKER),
    `${JSON.stringify({ runtime: realpathSync(old), names: ['@deepseek-ai', 'yaml'], files: 4, at: '' })}\n`,
  )

  const dropped = await dropRuntimeMirror(profile, now)
  assert.equal(dropped.status, 'removed')
  assert.equal(dropped.entries, 3)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh')), false)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-old')), false)
  assert.equal(existsSync(path.join(profile, 'node_modules', 'yaml')), false)
  // Nothing of the market's went with it, and the scope it lives in survives.
  assert.equal(readFileSync(path.join(market, 'package.json'), 'utf8'), '{"name":"@deepseek-ai/dsh-toolkit"}\n')
})

test('a marker naming a package the recorded runtime does not carry leaves it alone', async () => {
  // The marker is a claim about what a mirror wrote; the tree it names is the
  // only witness of whether that is true. A package the recorded runtime does
  // not carry was never written by that mirror, so removing the profile's copy
  // would take whatever put it there — the market's install, or the user's own.
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  await mirrorRuntimeIntoProfile(runtime, profile)
  const user = path.join(profile, 'node_modules', 'dsh-toolkit')
  mkdirSync(user, { recursive: true })
  writeFileSync(path.join(user, 'package.json'), '{"name":"dsh-toolkit","origin":"profile"}\n')
  writeFileSync(
    path.join(profile, PROFILE_KERNEL_MARKER),
    `${JSON.stringify({ runtime: realpathSync(runtime), names: ['dsh-toolkit', 'yaml'], files: 3, at: '' })}\n`,
  )

  const dropped = await dropRuntimeMirror(profile, runtime)
  assert.equal(dropped.status, 'removed')
  // `yaml` is witnessed by the recorded runtime and goes; `dsh-toolkit` is not.
  assert.equal(dropped.entries, 1)
  assert.deepEqual(dropped.kept.map((entry) => entry.name), ['dsh-toolkit'])
  assert.match(dropped.kept[0].reason, /does not carry it/u)
  assert.equal(readFileSync(path.join(user, 'package.json'), 'utf8'), '{"name":"dsh-toolkit","origin":"profile"}\n')
  assert.equal(existsSync(path.join(profile, 'node_modules', 'yaml')), false)
  assert.equal(existsSync(path.join(profile, PROFILE_KERNEL_MARKER)), false)
})

test('a marker whose recorded runtime is gone removes nothing and does not throw', async () => {
  // The measured shape of the 0.12.1 loss: the kernel a profile mirrored was
  // cleaned up, and the marker left behind names packages that no longer have a
  // witness anywhere. Every name is kept — a leftover kernel copy is
  // recoverable, and nothing else in the profile is.
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  await mirrorRuntimeIntoProfile(runtime, profile)
  const gone = path.join(os.tmpdir(), 'dsh-kernel-cleaned-up', String(Date.now()))
  writeFileSync(
    path.join(profile, PROFILE_KERNEL_MARKER),
    `${JSON.stringify({ runtime: gone, names: ['@deepseek-ai/dsh', 'yaml'], files: 3, at: '' })}\n`,
  )

  const dropped = await dropRuntimeMirror(profile)
  assert.equal(dropped.status, 'removed')
  assert.equal(dropped.entries, 0)
  assert.deepEqual(dropped.kept.map((entry) => entry.name).sort(), ['@deepseek-ai/dsh', 'yaml'])
  assert.match(dropped.kept[0].reason, /is gone/u)
  assert.equal(existsSync(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh')), true)
  assert.equal(existsSync(path.join(profile, 'node_modules', 'yaml')), true)
  // The marker still goes: it describes a mirror this shell can no longer act
  // on, and keeping it would only repeat the same blind drop next start.
  assert.equal(existsSync(path.join(profile, PROFILE_KERNEL_MARKER)), false)
})

test('a re-mirror leaves a stale marker entry its own tree cannot witness', async () => {
  // Same rule on the mirror path: the prune of entries an earlier mirror owned
  // is where a name the CURRENT runtime does not carry is decided, and a name
  // the RECORDED one does not carry either is not this shell's to take.
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  const user = path.join(profile, 'node_modules', 'dsh-toolkit')
  mkdirSync(user, { recursive: true })
  writeFileSync(path.join(user, 'package.json'), '{"name":"dsh-toolkit","origin":"profile"}\n')
  writeFileSync(
    path.join(profile, PROFILE_KERNEL_MARKER),
    `${JSON.stringify({ runtime: realpathSync(runtime), names: ['dsh-toolkit'], files: 0, at: '' })}\n`,
  )
  const mirrored = await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(mirrored.status, 'mirrored')
  assert.deepEqual(mirrored.kept.map((entry) => entry.name), ['dsh-toolkit'])
  assert.equal(readFileSync(path.join(user, 'package.json'), 'utf8'), '{"name":"dsh-toolkit","origin":"profile"}\n')
  // And the marker no longer claims it, so nothing later takes it either.
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(profile, PROFILE_KERNEL_MARKER), 'utf8')).names.includes('dsh-toolkit'),
    false,
  )
})

test('the lockfile fence still wins over a witnessed marker name', async () => {
  // Both fences in one shape: the runtime the marker records really does carry
  // `iconv-lite`, so the witness check passes — and the profile's own lockfile
  // says pnpm installed it there, which is the stronger claim. It stays, and
  // `kept` stays empty: it was the lockfile that saved it, not the witness.
  const runtime = runtimeOverMarketInstall()
  const profile = profileWithMarketInstall()
  const mirrored = await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(mirrored.status, 'mirrored')
  writeFileSync(
    path.join(profile, PROFILE_KERNEL_MARKER),
    `${JSON.stringify({ runtime: realpathSync(runtime), names: ['yaml', 'iconv-lite'], files: 2, at: '' })}\n`,
  )
  const dropped = await dropRuntimeMirror(profile, runtime)
  assert.equal(dropped.status, 'removed')
  assert.equal(dropped.entries, 1)
  assert.deepEqual(dropped.kept, [])
  assert.equal(existsSync(path.join(profile, 'node_modules', 'yaml')), false)
  assert.equal(existsSync(path.join(profile, 'node_modules', 'iconv-lite')), true)
  assert.equal(
    readFileSync(path.join(profile, 'node_modules', 'iconv-lite', 'package.json'), 'utf8'),
    '{"name":"iconv-lite","origin":"profile"}\n',
  )
})

test('a delete of the profile directory leaves the runtime intact', async () => {
  const runtime = fakeRuntime()
  const profile = fakeProfile()
  await mirrorRuntimeIntoProfile(runtime, profile)
  // The hardlink claim: the profile's name for each file can go away and the
  // runtime's name still resolves to the same bytes.
  const { rmSync } = await import('node:fs')
  rmSync(path.join(profile, 'node_modules'), { recursive: true, force: true })
  assert.equal(readFileSync(path.join(runtime, 'node_modules', 'yaml', 'package.json'), 'utf8'), '{"name":"yaml"}\n')
  assert.equal(readFileSync(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'), '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.2"}\n')
  // And the next start rebuilds what the delete took.
  const rebuilt = await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(rebuilt.status, 'mirrored')
  assert.equal(rebuilt.files, 3)
})

test('dropping a mirror that was never made is a no-op', async () => {
  const profile = fakeProfile()
  assert.equal((await dropRuntimeMirror(profile)).status, 'already')
})

/** A profile that pnpm has already installed into, with the lockfile to prove it. */
function profileWithMarketInstall() {
  const dir = fakeProfile()
  const write = (rel, body) => {
    const file = path.join(dir, 'node_modules', ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  // The measured case: the runtime carries iconv-lite, and so does this
  // profile — because `dsh-better-edit`, which pnpm installed here, needs it.
  write('iconv-lite/package.json', '{"name":"iconv-lite","origin":"profile"}\n')
  write('@deepseek-ai/dsh-toolkit/package.json', '{"name":"@deepseek-ai/dsh-toolkit","origin":"profile"}\n')
  writeFileSync(path.join(dir, 'pnpm-lock.yaml'), MARKET_LOCKFILE)
  return dir
}

/** A lockfile in the shape pnpm 9/10 writes for a hoisted profile. */
const MARKET_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      dsh-better-edit:
        specifier: ^1.0.0
        version: 1.0.3
      zod:
        specifier: ^3.23.8
        version: 3.23.8

packages:

  '@deepseek-ai/dsh-toolkit@0.2.1':
    resolution: {integrity: sha512-aaa}

  dsh-better-edit@1.0.3:
    resolution: {integrity: sha512-bbb}

  iconv-lite@0.6.3:
    resolution: {integrity: sha512-ccc}

  zod@3.23.8:
    resolution: {integrity: sha512-ddd}

snapshots:

  '@deepseek-ai/dsh-toolkit@0.2.1':
    dependencies:
      zod: 3.23.8

  dsh-better-edit@1.0.3:
    dependencies:
      iconv-lite: 0.6.3

  iconv-lite@0.6.3: {}

  zod@3.23.8: {}
`

/**
 * Verbatim from a profile the in-app market really installed into
 * (`scratch/ra-repro/homes/market-roundtrip/profiles/dsh-app/pnpm-lock.yaml`,
 * 45 lines): peer-dependency names six spaces deep, and snapshot entries pnpm
 * wrote as `{}` inline. The hand-written fixture above cannot drift into being
 * easier than pnpm's own output; this one keeps the parser honest about it.
 */
const REAL_MARKET_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      dsh-plugin-wallpaper-engine:
        specifier: 0.7.3
        version: 0.7.3

packages:

  '@shaderfrog/glsl-parser@7.0.1':
    resolution: {integrity: sha512-8mpfsoPeRhesY3pOrzNZBL8uG6N5GVX1EHLBYbd4gzKs+c7vaEIqpTNK5VrffU33qQN4cwpP2v3u4aPPBU32sw==}
    engines: {node: '>=16'}

  dsh-plugin-wallpaper-engine@0.7.3:
    resolution: {integrity: sha512-uLCm5S82nZcwjTLyta311c248MBvYkE2COGf0uyGJgUzemwNxzsuGFpgzFRGKyCSMggbgKSfg1+B0nBKLJsk2w==}
    peerDependencies:
      '@deepseek-ai/cordis': ^4.0.1
      '@deepseek-ai/dsh-client-runtime': '>=0.1.0-rc.6'
      react: ^18.2.0
    peerDependenciesMeta:
      '@deepseek-ai/dsh-host-webserver':
        optional: true

  jpeg-js@0.4.4:
    resolution: {integrity: sha512-WZzeDOEtTOBK4Mdsar0IqEU5sMr3vSV2RqkAIzUEV2BHnUfKGyswWFPFwK5EeDo93K3FohSHbLAjj0s1Wzd+dg==}

snapshots:

  '@shaderfrog/glsl-parser@7.0.1': {}

  dsh-plugin-wallpaper-engine@0.7.3:
    dependencies:
      '@shaderfrog/glsl-parser': 7.0.1
      jpeg-js: 0.4.4

  jpeg-js@0.4.4: {}
`

/** A runtime carrying the two packages the market also installed, plus one it does not. */
function runtimeOverMarketInstall() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-runtime-'))
  const write = (rel, body) => {
    const file = path.join(root, 'node_modules', ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  write('yaml/package.json', '{"name":"yaml","origin":"runtime"}\n')
  write('iconv-lite/package.json', '{"name":"iconv-lite","origin":"runtime"}\n')
  write('@deepseek-ai/dsh-toolkit/package.json', '{"name":"@deepseek-ai/dsh-toolkit","origin":"runtime"}\n')
  return root
}

test('the lockfile parser reads package keys out of packages: and snapshots: only', () => {
  assert.deepEqual(
    [...lockfileOwnedNames(MARKET_LOCKFILE)].sort(),
    ['@deepseek-ai/dsh-toolkit', 'dsh-better-edit', 'iconv-lite', 'zod'],
  )
  // Verbatim from a profile the market really installed into (scratch probe).
  // The peer-dependency names live six spaces deep and must NOT come out: they
  // are dependencies of a package, not names this profile owns.
  assert.deepEqual(
    [...lockfileOwnedNames(REAL_MARKET_LOCKFILE)].sort(),
    ['@shaderfrog/glsl-parser', 'dsh-plugin-wallpaper-engine', 'jpeg-js'],
  )
  // A key without a version, a quoted non-version key and an unrelated file
  // account for nothing — the fence must never invent a package name.
  assert.deepEqual([...lockfileOwnedNames('')], [])
  assert.deepEqual([...lockfileOwnedNames('not a lockfile at all\n')], [])
  assert.deepEqual([...lockfileOwnedNames('packages:\n\n  naked-name:\n')], [])
  assert.deepEqual([...lockfileOwnedNames("packages:\n\n  'naked-name':\n")], [])
  // A peer suffix, an alias and a tarball spec name the directory the package
  // occupies, not the string after their last `@`; and pnpm writes a leaf entry
  // as `{}` inline — measured in a real profile lockfile, whose
  // `snapshots:` holds `  jpeg-js@0.4.4: {}` beside the block-form entries, so a
  // parse that insisted on a bare colon would miss exactly the leaf packages.
  assert.deepEqual(
    [...lockfileOwnedNames(
      'snapshots:\n\n  zod@3.23.8(react@19.0.0): {}\n  foo@npm:bar@1.2.3: {}\n'
      + "  '@scope/leaf@1.0.0': {}\n  bare@https://example.test/bare-1.0.0.tgz: {}\n",
    )].sort(),
    ['@scope/leaf', 'bare', 'foo', 'zod'],
  )
})

test('a name the profile lockfile accounts for is neither mirrored nor dropped', async () => {
  const runtime = runtimeOverMarketInstall()
  const profile = profileWithMarketInstall()
  const profileCopy = (rel) => readFileSync(path.join(profile, 'node_modules', ...rel.split('/')), 'utf8')

  const mirrored = await mirrorRuntimeIntoProfile(runtime, profile)
  assert.equal(mirrored.status, 'mirrored')
  // Only the name the lockfile does not record crosses over.
  assert.equal(mirrored.entries, 1)
  assert.equal(mirrored.files, 1)
  assert.equal(profileCopy('iconv-lite/package.json'), '{"name":"iconv-lite","origin":"profile"}\n')
  assert.equal(profileCopy('@deepseek-ai/dsh-toolkit/package.json'), '{"name":"@deepseek-ai/dsh-toolkit","origin":"profile"}\n')
  assert.equal(profileCopy('yaml/package.json'), '{"name":"yaml","origin":"runtime"}\n')
  const marker = JSON.parse(readFileSync(path.join(profile, PROFILE_KERNEL_MARKER), 'utf8'))
  assert.deepEqual(marker.names, ['yaml'])

  const dropped = await dropRuntimeMirror(profile, runtime)
  assert.equal(dropped.status, 'removed')
  assert.equal(dropped.entries, 1)
  assert.equal(existsSync(path.join(profile, 'node_modules', 'yaml')), false)
  assert.equal(existsSync(path.join(profile, PROFILE_KERNEL_MARKER)), false)
  assert.equal(profileCopy('iconv-lite/package.json'), '{"name":"iconv-lite","origin":"profile"}\n')
  assert.equal(profileCopy('@deepseek-ai/dsh-toolkit/package.json'), '{"name":"@deepseek-ai/dsh-toolkit","origin":"profile"}\n')
})

test('a stale marker entry the lockfile accounts for survives the re-mirror and the drop', async () => {
  // The shape the failure was measured in: an earlier shell mirrored
  // iconv-lite, pnpm then reinstalled that name as the market's dependency, and
  // the runtime has since dropped it. The prune must read the lockfile, not the
  // marker, or the next production boot dies on a package `dsh-better-edit`
  // resolves.
  const runtime = fakeRuntime()
  const profile = profileWithMarketInstall()
  writeFileSync(
    path.join(profile, PROFILE_KERNEL_MARKER),
    `${JSON.stringify({ runtime: realpathSync(runtime), names: ['iconv-lite', 'yaml'], files: 3, at: '' })}\n`,
  )
  await mirrorRuntimeIntoProfile(runtime, profile)
  const copy = readFileSync(path.join(profile, 'node_modules', 'iconv-lite', 'package.json'), 'utf8')
  assert.equal(copy, '{"name":"iconv-lite","origin":"profile"}\n')
  // And the marker stops claiming it, so nothing downstream can take it later.
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(profile, PROFILE_KERNEL_MARKER), 'utf8')).names,
    ['@deepseek-ai/dsh', 'yaml'],
  )

  const dropped = await dropRuntimeMirror(profile, runtime)
  assert.equal(dropped.status, 'removed')
  assert.equal(copy, readFileSync(path.join(profile, 'node_modules', 'iconv-lite', 'package.json'), 'utf8'))
})

test('without a usable lockfile the mirror owns the name, as before', async () => {
  for (const lockfile of [undefined, 'this is not a lockfile\n']) {
    const runtime = runtimeOverMarketInstall()
    const profile = profileWithMarketInstall()
    if (lockfile === undefined) unlinkSync(path.join(profile, 'pnpm-lock.yaml'))
    else writeFileSync(path.join(profile, 'pnpm-lock.yaml'), lockfile)

    const mirrored = await mirrorRuntimeIntoProfile(runtime, profile)
    assert.equal(mirrored.status, 'mirrored')
    assert.equal(mirrored.entries, 3)
    const copy = (rel) => readFileSync(path.join(profile, 'node_modules', ...rel.split('/')), 'utf8')
    // The runtime's copy wins for every name, which is the behaviour this fence
    // was added beside rather than instead of.
    assert.equal(copy('iconv-lite/package.json'), '{"name":"iconv-lite","origin":"runtime"}\n')
    assert.equal(copy('@deepseek-ai/dsh-toolkit/package.json'), '{"name":"@deepseek-ai/dsh-toolkit","origin":"runtime"}\n')
    const dropped = await dropRuntimeMirror(profile, runtime)
    assert.equal(dropped.entries, 3)
    assert.equal(existsSync(path.join(profile, 'node_modules', 'iconv-lite')), false)
  }
})
