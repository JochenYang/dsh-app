// Online split-layer install: how the layer index is resolved and validated,
// how a layer whose bytes do not match the index walks on to the next
// candidate, that a warm cache issues no layer request at all, and — the
// invariant that matters most — that EVERY layer-path fault falls back to the
// single runtime tarball instead of failing the install.
// The release is served by an injected fetch, so there is no network.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { KernelManager } = require('../dist/kernel/manager.js')
const { GitHubArtifactResolver, githubMirrorPrefixes, modelscopeRuntimeAssetUrl } =
  require('../dist/kernel/sources/artifact.js')
const { layerIndexAssetName, parseLayerIndex } = require('../dist/kernel/layers.js')
const { KERNEL_ROOT_DIR, LAYERS_DIR, MODELSCOPE_ENDPOINT } = require('../dist/shared/constants.js')
const tar = require('tar')

const PLATFORM = process.platform
const ARCH = process.arch
const NODE_BINARY = PLATFORM === 'win32' ? 'node.exe' : 'node'
const OWNER = 'owner'
const REPO = 'repo'
const VERSION = '1.0.0'
const SUITE = 's1'
const TGZ_NAME = `dsh-runtime-${PLATFORM}-${ARCH}-${VERSION}.tgz`
const OFFICIAL_BASE = `https://github.com/${OWNER}/${REPO}/releases/download/runtime-${VERSION}`
const INDEX_NAME = layerIndexAssetName(PLATFORM, ARCH)

/** Mirror bases are derived, never hardcoded: the chain is env-configurable. */
const mirrorBases = () => githubMirrorPrefixes().map((prefix) => `${prefix}${OFFICIAL_BASE}`)

/** Mirrors scripts/split-runtime-layers.mjs: same partitions, same names. */
const META_ENTRIES = ['runtime/manifest.json', 'runtime/app/package.json']
const LAYER_SPECS = [
  { kind: 'node', entries: ['runtime/node'] },
  { kind: 'vendor', entries: ['runtime/app'], excludePackageScopes: true },
  { kind: 'dsh', entries: ['runtime/app/node_modules/@deepseek-ai'] },
  { kind: 'suite', entries: ['runtime/app/node_modules/@dsh-app'] },
  { kind: 'meta', entries: META_ENTRIES },
]
const INHERITED_KINDS = ['node', 'vendor']

function sha512Hex(value) {
  return createHash('sha512').update(value).digest('hex')
}

function cacheKey(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
}

function layerName(kind, manifest, file) {
  if (kind === 'dsh') return `dsh-${manifest.dshVersion}-${manifest.platform}-${manifest.arch}.tgz`
  if (kind === 'suite') return `suite-${manifest.suiteVersion}-${manifest.platform}-${manifest.arch}.tgz`
  return `${kind}-${cacheKey(file)}-${manifest.platform}-${manifest.arch}.tgz`
}

/**
 * Build a fake release: the split layers with their index AND the equivalent
 * single tarball with its sidecar and manifest — both from the same tree, so
 * the tarball fallback lands on exactly the runtime the layers describe.
 * Every asset is addressed by name, which is what the fetch stub serves.
 */
async function makeRelease(dir, { dshVersion = VERSION, suiteVersion = SUITE, inherit = null } = {}) {
  const src = path.join(dir, 'src')
  const runtime = path.join(src, 'runtime')
  mkdirSync(path.join(runtime, 'node'), { recursive: true })
  mkdirSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  mkdirSync(path.join(runtime, 'app', 'node_modules', '@dsh-app', 'plugin-x'), { recursive: true })
  mkdirSync(path.join(runtime, 'app', 'node_modules', 'third-party'), { recursive: true })
  writeFileSync(path.join(runtime, 'node', NODE_BINARY), 'fake-node')
  writeFileSync(path.join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// dsh')
  writeFileSync(path.join(runtime, 'app', 'node_modules', '@dsh-app', 'plugin-x', 'index.js'), '// plugin')
  writeFileSync(path.join(runtime, 'app', 'node_modules', 'third-party', 'index.js'), '// vendor')
  writeFileSync(path.join(runtime, 'app', 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
  const manifest = {
    dshVersion, suiteVersion, channel: 'stable',
    platform: PLATFORM, arch: ARCH, integrity: '', source: 'artifact',
  }
  writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify(manifest))

  const assets = new Map()
  const layers = []
  for (const spec of LAYER_SPECS) {
    const inherited = inherit && INHERITED_KINDS.includes(spec.kind)
      ? inherit.layers.find((layer) => layer.kind === spec.kind)
      : null
    if (inherited) {
      // Byte-identical layer → identical name and digest, exactly what a
      // producer rebuild with unchanged dependencies emits.
      assets.set(inherited.name, inherit.assets.get(inherited.name))
      layers.push({ ...inherited })
      continue
    }
    const filter = spec.excludePackageScopes === true
      ? (entryPath) => !/runtime\/app\/node_modules\/@(?:deepseek-ai|dsh-app)(?:\/|$)/u.test(entryPath)
        && !META_ENTRIES.includes(entryPath)
      : undefined
    const file = path.join(dir, `${spec.kind}.tgz`)
    await tar.c({ gzip: true, file, cwd: src, portable: true, mtime: new Date(0), ...(filter ? { filter } : {}) }, spec.entries)
    const name = layerName(spec.kind, manifest, file)
    const bytes = readFileSync(file)
    assets.set(name, bytes)
    layers.push({ kind: spec.kind, name, sha512: sha512Hex(bytes), bytes: bytes.length, entries: spec.entries })
  }

  const tarball = path.join(dir, 'runtime.tgz')
  await tar.c({ gzip: true, file: tarball, cwd: src, portable: true, mtime: new Date(0) }, ['runtime'])
  const tarballBytes = readFileSync(tarball)
  assets.set(TGZ_NAME, tarballBytes)
  assets.set(`${TGZ_NAME}.sha512`, `${sha512Hex(tarballBytes)}\n`)
  assets.set(`manifest-${PLATFORM}-${ARCH}.json`, JSON.stringify(manifest))

  const index = { ...manifest, layers }
  assets.set(INDEX_NAME, JSON.stringify(index, undefined, 2))

  const base = `https://github.com/${OWNER}/${REPO}/releases/download/runtime-${dshVersion}`
  return {
    assets, index, layers, manifest,
    tgzName: TGZ_NAME,
    tgzDigest: sha512Hex(tarballBytes),
    tgzUrl: `${base}/${TGZ_NAME}`,
    indexUrl: `${base}/${INDEX_NAME}`,
    layerNamed: (name) => layers.find((layer) => layer.name === name),
  }
}

/** Release asset names sit after `…/download/runtime-<version>/` in every base. */
const RELEASE_ASSET = /\/releases\/download\/runtime-[0-9A-Za-z][0-9A-Za-z._+-]*\/([^/]+)$/u

/** Asset name a candidate URL points at, or null when the URL is not one of ours. */
function assetNameOf(target) {
  if (target.startsWith(MODELSCOPE_ENDPOINT)) {
    const filePath = new URL(target).searchParams.get('FilePath')
    return filePath === null ? null : filePath.split('/').pop()
  }
  const match = RELEASE_ASSET.exec(target)
  return match === null ? null : match[1]
}

/**
 * Install a fetch stub over one or more fake releases. `override` may answer
 * (or, by returning an Error, fail) a URL itself; returning undefined falls
 * back to the asset table, where an unknown name is a 404. Every URL is recorded.
 */
function stubFetch(assets, override) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    calls.push(target)
    const custom = override?.(target)
    if (custom instanceof Error) throw custom
    if (custom !== undefined) return custom
    const name = assetNameOf(target)
    const body = name === null ? undefined : assets.get(name)
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body, { status: 200 })
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}

/** A fake release in its own temp dir, removed when the test ends. */
async function releaseFixture(t, prefix, options) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return makeRelease(path.join(dir, 'release'), options)
}

/** A harness with its own temp tree; `dir` is removed when the test ends. */
function harness(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const userData = path.join(dir, 'userData')
  const root = path.join(userData, KERNEL_ROOT_DIR)
  const logs = []
  const manager = new KernelManager({
    runtimeRoot: userData, platform: PLATFORM, arch: ARCH, source: 'artifact', channel: 'stable',
    artifactOwner: OWNER, artifactRepo: REPO, log: (message) => logs.push(message),
  })
  let releases = 0
  return {
    dir, userData, root, manager, logs,
    cacheDir: path.join(root, LAYERS_DIR),
    release: (options) => makeRelease(path.join(dir, `release-${++releases}`), options),
    readCurrent: () => JSON.parse(readFileSync(path.join(root, 'current.json'), 'utf8')),
    cacheFiles: () => (existsSync(path.join(root, LAYERS_DIR)) ? readdirSync(path.join(root, LAYERS_DIR)).sort() : []),
    versionDirs: () => (existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('dsh-')) : []),
    fellBack: () => logs.some((message) => message.includes('falling back to the single tarball')),
  }
}

function resolver() {
  return new GitHubArtifactResolver(OWNER, REPO, PLATFORM, ARCH)
}

// ------------------------------------------------------------ pure resolution

test('layer asset candidates are official-first, then the ModelScope copy, then the proxies', () => {
  const name = `node-abcdef123456-${PLATFORM}-${ARCH}.tgz`
  assert.deepEqual(resolver().assetCandidates(VERSION, name), [
    `${OFFICIAL_BASE}/${name}`,
    modelscopeRuntimeAssetUrl(VERSION, name),
    ...mirrorBases().map((base) => `${base}/${name}`),
  ])
})

test('the layer index asset name is per cell, so six matrix cells never collide', () => {
  assert.equal(layerIndexAssetName('win32', 'x64'), 'layers-win32-x64.json')
  assert.equal(layerIndexAssetName('darwin', 'arm64'), 'layers-darwin-arm64.json')
})

test('an official 404 for the layer index is final and never falls through to a mirror', async (t) => {
  const release = await releaseFixture(t, 'dsh-remote-404-')
  const stub = stubFetch(release.assets, (target) =>
    target === release.indexUrl ? new Response('not found', { status: 404 }) : undefined)
  try {
    assert.equal(await resolver().fetchLayerIndex(VERSION), null)
    assert.deepEqual(
      stub.calls,
      [release.indexUrl],
      'a mirror may not answer for metadata the official host has answered about',
    )
  } finally {
    stub.restore()
  }
})

test('an unreachable official host falls back to a mirror index, never to ModelScope', async (t) => {
  const release = await releaseFixture(t, 'dsh-remote-mirror-')
  const stub = stubFetch(release.assets, (target) => {
    if (target.startsWith(`${OFFICIAL_BASE}/`)) throw new Error('github blocked')
    return undefined
  })
  try {
    const info = await resolver().fetchLayerIndex(VERSION)
    assert.ok(info)
    assert.equal(info.source, mirrorBases()[0], 'the first answering mirror supplies the index')
    assert.equal(info.index.layers.length, release.layers.length)
    assert.ok(
      stub.calls.every((url) => !url.startsWith(MODELSCOPE_ENDPOINT)),
      'the mirror is transport-only: it may not supply metadata either',
    )
  } finally {
    stub.restore()
  }
})

test('an index that arrives but does not validate is an error, not a silent "no layers"', async (t) => {
  const release = await releaseFixture(t, 'dsh-remote-invalid-')
  const cases = [
    ['unparsable JSON', '{ not json'],
    ['wrong shape', JSON.stringify({ dshVersion: VERSION, layers: [] })],
    ['a layer whose digest is not a digest', JSON.stringify({
      ...release.index,
      layers: release.index.layers.map((layer, index) => (index === 0 ? { ...layer, sha512: 'nope' } : layer)),
    })],
  ]
  for (const [label, body] of cases) {
    const stub = stubFetch(release.assets, (target) =>
      target === release.indexUrl ? new Response(body, { status: 200 }) : undefined)
    try {
      await assert.rejects(resolver().fetchLayerIndex(VERSION), /层索引/, label)
    } finally {
      stub.restore()
    }
  }
})

test('a resolved index round-trips through the validator unchanged', async (t) => {
  const release = await releaseFixture(t, 'dsh-remote-roundtrip-')
  const stub = stubFetch(release.assets)
  try {
    const info = await resolver().fetchLayerIndex(VERSION)
    assert.ok(info)
    assert.deepEqual(Object.keys(info.index).sort(), [
      'arch', 'channel', 'dshVersion', 'integrity', 'layers', 'platform', 'source', 'suiteVersion',
    ])
    assert.deepEqual(parseLayerIndex(JSON.parse(release.assets.get(INDEX_NAME).toString())), info.index)
  } finally {
    stub.restore()
  }
})

// ------------------------------------------------------------- online install

test('the layer path installs from the official host without ever requesting the tarball', async (t) => {
  const h = harness(t, 'dsh-remote-ok-')
  const release = await h.release({})
  const stub = stubFetch(release.assets)
  try {
    const current = await h.manager.installVersion(VERSION)

    assert.equal(current.active, `dsh-${VERSION}+suite-${SUITE}`)
    assert.equal(current.previous, null)
    assert.equal(stub.calls[0], release.indexUrl, 'the index is resolved first, from the official host')
    assert.ok(!stub.calls.includes(release.tgzUrl), 'a layer install must not download the whole tarball')
    assert.equal(current.sha512, undefined, 'a layer install records no tarball digest')
    assert.deepEqual(
      current.layers.map((layer) => layer.name),
      release.index.layers.map((layer) => layer.name),
      'the record names every layer the install used',
    )
    assert.deepEqual(
      h.readCurrent().layers.map((layer) => layer.name),
      release.index.layers.map((layer) => layer.name),
      'and that provenance is persisted',
    )

    const dir = path.join(h.root, current.active)
    assert.ok(existsSync(path.join(dir, 'node', NODE_BINARY)))
    assert.ok(existsSync(path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
    assert.ok(existsSync(path.join(dir, 'app', 'node_modules', '@dsh-app', 'plugin-x', 'index.js')))
    assert.ok(existsSync(path.join(dir, 'app', 'node_modules', 'third-party', 'index.js')))
    assert.ok(!existsSync(path.join(h.root, 'staging')), 'staging never survives an activation')
    assert.deepEqual(h.cacheFiles(), release.layers.map((layer) => layer.name).sort())
    for (const layer of release.layers) {
      assert.equal(sha512Hex(readFileSync(path.join(h.cacheDir, layer.name))), layer.sha512)
    }
  } finally {
    stub.restore()
  }
})

test('a layer whose bytes do not match the index is fetched from the next candidate', async (t) => {
  const h = harness(t, 'dsh-remote-candidate-')
  const release = await h.release({})
  const [node, vendor] = release.index.layers
  const stub = stubFetch(release.assets, (target) =>
    target === `${OFFICIAL_BASE}/${vendor.name}` ? new Response('tampered bytes', { status: 200 }) : undefined)
  try {
    const current = await h.manager.installVersion(VERSION)

    assert.equal(current.active, `dsh-${VERSION}+suite-${SUITE}`)
    assert.ok(stub.calls.includes(`${OFFICIAL_BASE}/${vendor.name}`), 'the official copy was tried first')
    // The next candidate is the ModelScope copy, not a public proxy: a file the
    // project itself published outranks a third-party transport.
    assert.ok(
      stub.calls.includes(modelscopeRuntimeAssetUrl(VERSION, vendor.name)),
      'and rejected in favour of the ModelScope copy',
    )
    assert.ok(
      !stub.calls.includes(`${mirrorBases()[0]}/${vendor.name}`),
      'a proxy is only reached when the mirror could not serve the bytes',
    )
    assert.equal(sha512Hex(readFileSync(path.join(h.cacheDir, vendor.name))), vendor.sha512, 'only verified bytes reach the cache')
    assert.deepEqual(
      stub.calls.filter((url) => url.endsWith(`/${node.name}`)),
      [`${OFFICIAL_BASE}/${node.name}`],
      'a mismatch on one layer does not push the others through the mirror chain',
    )
  } finally {
    stub.restore()
  }
})

test('every candidate failing for one layer still installs, via the single tarball', async (t) => {
  const h = harness(t, 'dsh-remote-fallback-')
  const release = await h.release({})
  const names = new Set(release.layers.map((layer) => layer.name))
  const stub = stubFetch(release.assets, (target) => {
    const name = assetNameOf(target)
    return name !== null && names.has(name) ? new Response('gone', { status: 404 }) : undefined
  })
  try {
    const current = await h.manager.installVersion(VERSION)

    assert.equal(current.active, `dsh-${VERSION}+suite-${SUITE}`)
    assert.ok(stub.calls.includes(release.tgzUrl), 'the real tarball path ran')
    assert.ok(stub.calls.includes(`${release.tgzUrl}.sha512`), 'and it verified against the release sidecar')
    assert.equal(current.sha512, release.tgzDigest)
    assert.equal(current.layers, undefined, 'a tgz install records no layer provenance')
    assert.equal(h.readCurrent().sha512, release.tgzDigest)
    assert.ok(h.fellBack(), 'the fallback is visible in the log')
    assert.deepEqual(h.cacheFiles(), [], 'nothing unverified was cached')
    assert.ok(!existsSync(path.join(h.root, 'staging')), 'the failed layer attempt leaves no staging behind')
  } finally {
    stub.restore()
  }
})

test('a malformed layer index falls back to the tarball instead of failing the install', async (t) => {
  const h = harness(t, 'dsh-remote-badindex-')
  const release = await h.release({})
  const stub = stubFetch(release.assets, (target) =>
    target === release.indexUrl ? new Response('{ not json', { status: 200 }) : undefined)
  try {
    const current = await h.manager.installVersion(VERSION)

    assert.equal(current.active, `dsh-${VERSION}+suite-${SUITE}`)
    assert.ok(stub.calls.includes(release.tgzUrl))
    assert.ok(h.fellBack(), 'a broken index must be reported, not swallowed')
  } finally {
    stub.restore()
  }
})

test('a release with no layer index installs from the tarball as an ordinary path', async (t) => {
  const h = harness(t, 'dsh-remote-nolayers-')
  const release = await h.release({})
  const stub = stubFetch(release.assets, (target) =>
    target.endsWith(`/${INDEX_NAME}`) ? new Response('not found', { status: 404 }) : undefined)
  try {
    const current = await h.manager.installVersion(VERSION)

    assert.equal(current.active, `dsh-${VERSION}+suite-${SUITE}`)
    assert.ok(stub.calls.includes(release.tgzUrl))
    assert.ok(!h.fellBack(), '"this release has no layers" is not an error path')
  } finally {
    stub.restore()
  }
})

test('an index for another target is refused and the install falls back to the tarball', async (t) => {
  const h = harness(t, 'dsh-remote-target-')
  const release = await h.release({})
  const foreign = { ...release.index, arch: ARCH === 'arm64' ? 'x64' : 'arm64' }
  const stub = stubFetch(release.assets, (target) =>
    target === release.indexUrl ? new Response(JSON.stringify(foreign), { status: 200 }) : undefined)
  try {
    const current = await h.manager.installVersion(VERSION)

    assert.equal(current.active, `dsh-${VERSION}+suite-${SUITE}`)
    assert.equal(current.manifest.arch, ARCH)
    assert.ok(stub.calls.includes(release.tgzUrl))
    assert.ok(h.fellBack())
  } finally {
    stub.restore()
  }
})

// ------------------------------------------------------------------- cache

test('a second install is served entirely from the layer cache', async (t) => {
  const h = harness(t, 'dsh-remote-cache-')
  const release = await h.release({})
  const first = stubFetch(release.assets)
  try {
    await h.manager.installVersion(VERSION)
  } finally {
    first.restore()
  }
  // Take away every layer source AND the extracted version dir: a cache hit has
  // to reproduce the runtime without requesting a single layer.
  const names = new Set(release.layers.map((layer) => layer.name))
  const second = stubFetch(release.assets, (target) => {
    const name = assetNameOf(target)
    return name !== null && names.has(name) ? new Response('gone', { status: 404 }) : undefined
  })
  try {
    rmSync(path.join(h.root, `dsh-${VERSION}+suite-${SUITE}`), { recursive: true, force: true })

    const current = await h.manager.installVersion(VERSION)

    assert.equal(current.active, `dsh-${VERSION}+suite-${SUITE}`)
    for (const layer of release.layers) {
      assert.ok(
        !second.calls.some((url) => url.endsWith(`/${layer.name}`)),
        `a cached layer must not be downloaded again (${layer.name})`,
      )
    }
    assert.deepEqual(second.calls, [release.indexUrl], 'only the index is fetched — the index is metadata, not a layer')
    assert.deepEqual(h.cacheFiles(), release.layers.map((layer) => layer.name).sort())
    assert.equal(current.previous, null, 'same-dir re-activation leaves nothing to roll back to')
  } finally {
    second.restore()
  }
})

test('a cached layer whose bytes changed is re-downloaded, never trusted', async (t) => {
  const h = harness(t, 'dsh-remote-cache-repair-')
  const release = await h.release({})
  const first = stubFetch(release.assets)
  try {
    await h.manager.installVersion(VERSION)
  } finally {
    first.restore()
  }
  const damaged = release.index.layers[2]
  writeFileSync(path.join(h.cacheDir, damaged.name), 'corrupted')

  const second = stubFetch(release.assets)
  try {
    rmSync(path.join(h.root, `dsh-${VERSION}+suite-${SUITE}`), { recursive: true, force: true })
    await h.manager.installVersion(VERSION)

    assert.equal(sha512Hex(readFileSync(path.join(h.cacheDir, damaged.name))), damaged.sha512, 'the corrupted entry was repaired')
    assert.deepEqual(
      second.calls.filter((url) => url.endsWith('.tgz') && !url.endsWith(`/${release.tgzName}`)),
      [`${OFFICIAL_BASE}/${damaged.name}`],
      'exactly the layers whose digest did not match were fetched',
    )
  } finally {
    second.restore()
  }
})

test('an update reuses the content-addressed layers and downloads only what changed', async (t) => {
  const h = harness(t, 'dsh-remote-update-')
  const first = await h.release({})
  const stub1 = stubFetch(first.assets)
  try {
    await h.manager.installVersion(VERSION)
  } finally {
    stub1.restore()
  }

  // A new dsh release: node/vendor are content-addressed, so the same bytes
  // come back under the same names and the cache already holds them.
  const second = await h.release({ dshVersion: '2.0.0', suiteVersion: 's2', inherit: first })
  const inherited = second.layers.filter((layer) => INHERITED_KINDS.includes(layer.kind))
  const stub2 = stubFetch(second.assets, (target) => {
    const name = assetNameOf(target)
    return name !== null && inherited.some((layer) => layer.name === name)
      ? new Response('gone', { status: 404 })
      : undefined
  })
  try {
    const current = await h.manager.installVersion('2.0.0')

    assert.equal(current.active, 'dsh-2.0.0+suite-s2')
    assert.equal(current.previous, `dsh-${VERSION}+suite-${SUITE}`, 'the previous version stays the rollback target')
    for (const layer of inherited) {
      assert.ok(!stub2.calls.some((url) => url.endsWith(`/${layer.name}`)), `the inherited ${layer.kind} layer came from the cache`)
    }
    assert.ok(stub2.calls.includes(second.indexUrl), 'the update resolved its own index')
    assert.ok(!stub2.calls.includes(second.tgzUrl), 'and never needed the whole tarball')
  } finally {
    stub2.restore()
  }
})
