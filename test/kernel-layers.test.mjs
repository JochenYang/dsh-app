// Split-layer kernel install: index validation, fail-closed digest checks,
// cache reuse, the layer-cache retention policy, and the backward
// compatibility of a current.json written before `layers` existed.
// Every test runs against fake layer sets in its own userData directory, so
// there is no network and no real kernel involved.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { KernelManager } = require('../dist/kernel/manager.js')
const { missingLayers, parseLayerIndex, readLayerIndex } = require('../dist/kernel/layers.js')
const { KERNEL_ROOT_DIR, LAYERS_DIR } = require('../dist/shared/constants.js')
const tar = require('tar')

const PLATFORM = process.platform
const ARCH = process.arch
const NODE_BINARY = PLATFORM === 'win32' ? 'node.exe' : 'node'

/** Mirrors scripts/split-runtime-layers.mjs: same partitions, same names. */
const META_ENTRIES = ['runtime/manifest.json', 'runtime/app/package.json']
const LAYER_SPECS = [
  { kind: 'node', entries: ['runtime/node'] },
  { kind: 'vendor', entries: ['runtime/app'], excludePackageScopes: true },
  { kind: 'dsh', entries: ['runtime/app/node_modules/@deepseek-ai'] },
  { kind: 'suite', entries: ['runtime/app/node_modules/@dsh-app'] },
  { kind: 'meta', entries: META_ENTRIES },
]

function sha512Hex(file) {
  return createHash('sha512').update(readFileSync(file)).digest('hex')
}

function cacheKey(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
}

/** Content-addressed layers: a rebuild with unchanged content emits them verbatim. */
const INHERITED_KINDS = ['node', 'vendor']

function layerName(kind, manifest, file) {
  if (kind === 'dsh') return `dsh-${manifest.dshVersion}-${manifest.platform}-${manifest.arch}.tgz`
  if (kind === 'suite') return `suite-${manifest.suiteVersion}-${manifest.platform}-${manifest.arch}.tgz`
  return `${kind}-${cacheKey(file)}-${manifest.platform}-${manifest.arch}.tgz`
}

/**
 * Build a layer directory (the producer's output shape): five layer tarballs
 * plus layers.json. `inherit` copies the content-addressed node/vendor layers
 * of an earlier set verbatim, which is what a producer rebuild with unchanged
 * dependencies emits — same bytes, same name, same digest.
 */
async function makeLayerSet(dir, { dshVersion, suiteVersion, platform = PLATFORM, arch = ARCH, inherit = null }) {
  mkdirSync(dir, { recursive: true })
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
  const manifest = { dshVersion, suiteVersion, channel: 'stable', platform, arch, integrity: '', source: 'artifact' }
  writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify(manifest))

  const layers = []
  for (const spec of LAYER_SPECS) {
    const inherited = inherit && INHERITED_KINDS.includes(spec.kind)
      ? inherit.layers.find((layer) => layer.kind === spec.kind)
      : null
    if (inherited) {
      // Byte-identical layer → byte-identical name and digest.
      writeFileSync(path.join(dir, inherited.name), readFileSync(inherit.file(inherited.name)))
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
    const target = path.join(dir, name)
    rmSync(target, { force: true })
    writeFileSync(target, readFileSync(file))
    rmSync(file, { force: true })
    layers.push({ kind: spec.kind, name, sha512: sha512Hex(target), bytes: statSync(target).size, entries: spec.entries })
  }
  const index = { ...manifest, layers }
  writeFileSync(path.join(dir, 'layers.json'), JSON.stringify(index, undefined, 2))
  return {
    dir,
    index,
    manifest,
    layers,
    file: (name) => path.join(dir, name),
    writeIndex: (value) => writeFileSync(path.join(dir, 'layers.json'), JSON.stringify(value, undefined, 2)),
    layerNamed: (name) => layers.find((layer) => layer.name === name),
  }
}

/** A harness with its own temp tree; `dir` is removed when the test ends. */
async function harness(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const userData = path.join(dir, 'userData')
  const root = path.join(userData, KERNEL_ROOT_DIR)
  const manager = new KernelManager({
    runtimeRoot: userData, platform: PLATFORM, arch: ARCH, source: 'artifact', channel: 'stable',
    artifactOwner: 'owner', artifactRepo: 'repo',
  })
  let sets = 0
  return {
    dir, userData, root, manager,
    currentFile: path.join(root, 'current.json'),
    cacheDir: path.join(root, LAYERS_DIR),
    layerSet: (options) => makeLayerSet(path.join(dir, `set-${++sets}`), options),
    readCurrent: () => JSON.parse(readFileSync(path.join(root, 'current.json'), 'utf8')),
    versionDirs: () => (existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('dsh-')) : []),
    cacheFiles: () => (existsSync(path.join(root, LAYERS_DIR)) ? readdirSync(path.join(root, LAYERS_DIR)).sort() : []),
  }
}

// ------------------------------------------------------------ index reading

test('a valid layer index parses into the manifest plus its layers', async (t) => {
  const h = await harness(t, 'dsh-layers-parse-')
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })

  const index = await readLayerIndex(set.dir)

  assert.equal(index.dshVersion, '1.0.0')
  assert.equal(index.suiteVersion, 's1')
  assert.equal(index.platform, PLATFORM)
  assert.equal(index.arch, ARCH)
  assert.deepEqual(index.layers.map((layer) => layer.kind), ['node', 'vendor', 'dsh', 'suite', 'meta'])
  assert.equal(index.layers.length, 5)
})

test('a structurally broken index fails loudly instead of being repaired', () => {
  const layer = { kind: 'node', name: 'node-abcdef123456-win32-x64.tgz', sha512: 'a'.repeat(128), bytes: 1, entries: ['runtime/node'] }
  const manifest = { dshVersion: '1.0.0', suiteVersion: 's1', channel: 'stable', platform: PLATFORM, arch: ARCH, integrity: '', source: 'artifact' }
  const cases = [
    ['not an object', 'nope'],
    ['array root', []],
    ['missing dshVersion', { ...manifest, dshVersion: undefined, layers: [layer] }],
    ['bad channel', { ...manifest, channel: 'nightly', layers: [layer] }],
    ['bad source', { ...manifest, source: 'git', layers: [layer] }],
    ['missing layers', { ...manifest }],
    ['empty layers', { ...manifest, layers: [] }],
    ['layers not an array', { ...manifest, layers: 'node' }],
    ['layer not an object', { ...manifest, layers: ['node'] }],
    ['unknown kind', { ...manifest, layers: [{ ...layer, kind: 'core' }] }],
    ['missing sha512', { ...manifest, layers: [{ ...layer, sha512: undefined }] }],
    ['short digest', { ...manifest, layers: [{ ...layer, sha512: 'abc' }] }],
    ['non-integer bytes', { ...manifest, layers: [{ ...layer, bytes: 0 }] }],
    ['empty entries', { ...manifest, layers: [{ ...layer, entries: [] }] }],
    ['absolute entry', { ...manifest, layers: [{ ...layer, entries: ['/etc/passwd'] }] }],
    ['name is a path', { ...manifest, layers: [{ ...layer, name: '../../evil.tgz' }] }],
    ['name without the container suffix', { ...manifest, layers: [{ ...layer, name: 'node-layer' }] }],
    ['duplicate name', { ...manifest, layers: [layer, { ...layer, kind: 'vendor' }] }],
  ]
  for (const [label, value] of cases) {
    assert.throws(() => parseLayerIndex(value), `${label} must throw`)
  }
})

test('an unreadable or malformed layers.json never degrades into "no layers"', async (t) => {
  const h = await harness(t, 'dsh-layers-read-')
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })

  await assert.rejects(readLayerIndex(path.join(set.dir, 'no-such-dir')), /无法读取层索引/)
  writeFileSync(path.join(set.dir, 'layers.json'), '{ not json')
  await assert.rejects(readLayerIndex(set.dir), /不是有效的 JSON/)
})

test('missingLayers reports exactly the cache entries that do not match the index', async (t) => {
  const h = await harness(t, 'dsh-layers-missing-')
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })
  const index = await readLayerIndex(set.dir)
  const [node, vendor, dsh, suite, meta] = index.layers

  assert.deepEqual(
    missingLayers(index, new Map()).map((layer) => layer.name),
    index.layers.map((layer) => layer.name),
    'an empty cache misses everything',
  )
  assert.deepEqual(
    missingLayers(index, new Map(index.layers.map((layer) => [layer.name, layer.sha512]))),
    [],
    'a fully matching cache misses nothing',
  )
  assert.deepEqual(
    missingLayers(index, new Map([
      [node.name, node.sha512],
      [vendor.name, 'f'.repeat(128)],
      [dsh.name, dsh.sha512],
      [suite.name, suite.sha512],
      [meta.name, meta.sha512],
    ])).map((layer) => layer.name),
    [vendor.name],
    'a cached file with the wrong digest is missing, not trusted',
  )
})

// ---------------------------------------------------------- install refusal

test('an index for another platform/arch is refused before anything is written', async (t) => {
  const h = await harness(t, 'dsh-layers-target-')
  const wrongArch = ARCH === 'arm64' ? 'x64' : 'arm64'
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1', arch: wrongArch })

  await assert.rejects(h.manager.installFromLocalLayers(set.dir), /平台不匹配/)
  assert.equal(h.manager.getCurrent(), null)
  assert.deepEqual(h.versionDirs(), [], 'a refused layer set activates nothing')
  assert.ok(!existsSync(h.currentFile), 'no activation record is written')
  assert.ok(!existsSync(h.cacheDir), 'nothing is copied into the cache either')
})

test('a tampered layer aborts the whole install and leaves no half-product', async (t) => {
  const h = await harness(t, 'dsh-layers-tampered-')
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })
  // Corrupt a LATER layer: everything before it verifies, so this only passes
  // if the whole set is checked before anything is assembled.
  writeFileSync(set.file(set.layers[3].name), 'tampered')

  await assert.rejects(h.manager.installFromLocalLayers(set.dir), /完整性校验失败/)
  assert.equal(h.manager.getCurrent(), null)
  assert.deepEqual(h.versionDirs(), [])
  assert.ok(!existsSync(h.currentFile), 'no activation record is written')
  assert.ok(!existsSync(h.cacheDir), 'the cache is filled after verification, never before')
})

test('an index whose digest was swapped out is refused the same way', async (t) => {
  const h = await harness(t, 'dsh-layers-index-digest-')
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })
  const tampered = { ...set.index, layers: set.index.layers.map((layer, index) => (index === 2 ? { ...layer, sha512: '0'.repeat(128) } : layer)) }
  set.writeIndex(tampered)

  await assert.rejects(h.manager.installFromLocalLayers(set.dir), /完整性校验失败/)
  assert.deepEqual(h.versionDirs(), [])
  assert.ok(!existsSync(h.currentFile))
})

test('a layer the index references but the directory lacks is refused', async (t) => {
  const h = await harness(t, 'dsh-layers-missing-file-')
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })
  rmSync(set.file(set.layers[1].name), { force: true })

  await assert.rejects(h.manager.installFromLocalLayers(set.dir), /缺少层文件/)
  assert.deepEqual(h.versionDirs(), [])
})

// ---------------------------------------------------------------- assembly

test('assembly produces the tgz layout, records layer provenance, and caches every layer', async (t) => {
  const h = await harness(t, 'dsh-layers-install-')
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })

  const current = await h.manager.installFromLocalLayers(set.dir)

  assert.equal(current.active, 'dsh-1.0.0+suite-s1')
  assert.equal(current.previous, null)
  assert.equal(current.manifest.dshVersion, '1.0.0')
  const dir = path.join(h.root, current.active)
  assert.ok(existsSync(path.join(dir, 'node', NODE_BINARY)))
  assert.ok(existsSync(path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
  assert.ok(existsSync(path.join(dir, 'app', 'node_modules', '@dsh-app', 'plugin-x', 'index.js')))
  assert.ok(existsSync(path.join(dir, 'app', 'node_modules', 'third-party', 'index.js')), 'the vendor layer landed')
  assert.ok(existsSync(path.join(dir, 'app', 'package.json')), 'the meta layer landed')
  assert.ok(!existsSync(path.join(h.root, 'staging')), 'staging never survives an activation')

  const spec = h.manager.getServerSpec()
  assert.equal(spec.kind, 'node')
  assert.equal(spec.nodePath, path.join(dir, 'node', NODE_BINARY))
  assert.equal(spec.scriptPath, path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  assert.equal(spec.cwd, path.join(dir, 'app'))

  const onDisk = h.readCurrent()
  assert.deepEqual(
    onDisk.layers.map((layer) => layer.name),
    set.index.layers.map((layer) => layer.name),
    'the record names every layer the install used',
  )
  assert.deepEqual(
    onDisk.layers.map((layer) => layer.sha512),
    set.index.layers.map((layer) => layer.sha512),
    'and the digest each was verified against',
  )
  assert.deepEqual(h.cacheFiles(), [...set.index.layers.map((layer) => layer.name)].sort())
  for (const layer of set.index.layers) {
    assert.equal(sha512Hex(path.join(h.cacheDir, layer.name)), layer.sha512)
  }
})

test('a second install of the same set is served entirely from the cache', async (t) => {
  const h = await harness(t, 'dsh-layers-reuse-')
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })
  await h.manager.installFromLocalLayers(set.dir)
  // Take away every source tarball (only the index survives) AND the extracted
  // version dir: a cache hit must reproduce the runtime without reading the
  // layer directory at all — the strongest form of "reused, not re-copied".
  for (const layer of set.index.layers) rmSync(set.file(layer.name), { force: true })
  rmSync(path.join(h.root, 'dsh-1.0.0+suite-s1'), { recursive: true, force: true })

  const again = await h.manager.installFromLocalLayers(set.dir)

  assert.equal(again.active, 'dsh-1.0.0+suite-s1')
  assert.equal(again.previous, null, 'same-dir re-activation leaves nothing to roll back to')
  assert.ok(existsSync(path.join(h.root, 'dsh-1.0.0+suite-s1', 'node', NODE_BINARY)))
  assert.equal(h.readCurrent().active, 'dsh-1.0.0+suite-s1')
  assert.deepEqual(h.readCurrent().layers.map((layer) => layer.name), set.index.layers.map((layer) => layer.name))
  assert.deepEqual(h.cacheFiles(), [...set.index.layers.map((layer) => layer.name)].sort())
})

test('an update only contributes the layers whose cache key changed', async (t) => {
  const h = await harness(t, 'dsh-layers-update-')
  const first = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })
  await h.manager.installFromLocalLayers(first.dir)

  const second = await h.layerSet({ dshVersion: '2.0.0', suiteVersion: 's2', inherit: first })
  // A producer inheriting unchanged content emits the same bytes under the same
  // name; deleting them from the update proves the client used the cached copy
  // instead — a re-copy would fail with ENOENT.
  const inherited = ['node', 'vendor'].map((kind) => second.layers.find((layer) => layer.kind === kind))
  for (const layer of inherited) rmSync(second.file(layer.name), { force: true })

  const after = await h.manager.installFromLocalLayers(second.dir)

  assert.equal(after.active, 'dsh-2.0.0+suite-s2')
  assert.equal(after.previous, 'dsh-1.0.0+suite-s1', 'the previous version stays the rollback target')
  assert.deepEqual(after.layers.map((layer) => layer.name), second.index.layers.map((layer) => layer.name))
  assert.ok(h.cacheFiles().includes(second.layers.find((layer) => layer.kind === 'dsh').name), 'the new dsh layer is cached')
  assert.ok(
    h.cacheFiles().includes(first.layers.find((layer) => layer.kind === 'dsh').name),
    'an install never reclaims cache entries by itself',
  )
  assert.ok(existsSync(path.join(h.root, 'dsh-2.0.0+suite-s2', 'app', 'node_modules', '@dsh-app', 'plugin-x', 'index.js')))
})

// ------------------------------------------------------ cache / cleanup

test('cleanup keeps the layer cache and reclaims only unreferenced entries', async (t) => {
  const h = await harness(t, 'dsh-layers-cleanup-')
  const first = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })
  await h.manager.installFromLocalLayers(first.dir)
  const second = await h.layerSet({ dshVersion: '2.0.0', suiteVersion: 's2', inherit: first })
  await h.manager.installFromLocalLayers(second.dir)
  const stale = first.layerNamed(`dsh-1.0.0-${PLATFORM}-${ARCH}.tgz`).name
  const staleSuite = first.layerNamed(`suite-s1-${PLATFORM}-${ARCH}.tgz`).name
  mkdirSync(path.join(h.cacheDir, 'not-a-layer'), { recursive: true })
  writeFileSync(path.join(h.cacheDir, 'stray.bin'), 'x')

  await h.manager.cleanup()

  assert.ok(existsSync(h.cacheDir), 'the layer cache survives cleanup')
  assert.ok(!existsSync(path.join(h.cacheDir, stale)), 'the replaced version layer is reclaimed')
  assert.ok(!existsSync(path.join(h.cacheDir, staleSuite)))
  assert.ok(!existsSync(path.join(h.cacheDir, 'stray.bin')))
  assert.ok(existsSync(path.join(h.cacheDir, 'not-a-layer')), 'cleanup only reclaims layer files')
  assert.deepEqual(
    h.cacheFiles().filter((name) => name.endsWith('.tgz')),
    [...second.index.layers.map((layer) => layer.name)].sort(),
    'exactly the active install\'s layers remain',
  )
  assert.deepEqual(h.versionDirs().sort(), ['dsh-1.0.0+suite-s1', 'dsh-2.0.0+suite-s2'])
  assert.ok(!existsSync(path.join(h.root, 'staging')))
})

test('cleanup for an install with no layer provenance deletes no cached layer', async (t) => {
  const h = await harness(t, 'dsh-layers-cleanup-legacy-')
  const set = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })
  await h.manager.installFromLocalLayers(set.dir)
  const legacy = h.readCurrent()
  delete legacy.layers
  writeFileSync(h.currentFile, JSON.stringify(legacy, undefined, 2))

  await h.manager.cleanup()

  assert.deepEqual(h.cacheFiles(), [...set.index.layers.map((layer) => layer.name)].sort())
})

// ------------------------------------------------------- backward compatibility

test('a current.json without a layers field still loads and rolls back', async (t) => {
  const h = await harness(t, 'dsh-layers-compat-')
  const first = await h.layerSet({ dshVersion: '1.0.0', suiteVersion: 's1' })
  await h.manager.installFromLocalLayers(first.dir)
  const second = await h.layerSet({ dshVersion: '2.0.0', suiteVersion: 's2', inherit: first })
  await h.manager.installFromLocalLayers(second.dir)

  // Rewrite the record the way a pre-layers shell would have written it.
  const legacy = h.readCurrent()
  delete legacy.layers
  writeFileSync(h.currentFile, JSON.stringify(legacy, undefined, 2))

  const fresh = new KernelManager({
    runtimeRoot: h.userData, platform: PLATFORM, arch: ARCH, source: 'artifact', channel: 'stable',
    artifactOwner: 'owner', artifactRepo: 'repo',
  })
  const loaded = await fresh.load()
  assert.ok(loaded)
  assert.equal(loaded.active, 'dsh-2.0.0+suite-s2')
  assert.equal(loaded.layers, undefined, 'a missing field is "no provenance", not a broken record')
  assert.equal(fresh.getServerSpec().nodePath, path.join(h.root, loaded.active, 'node', NODE_BINARY))

  const rolled = await fresh.rollback()
  assert.ok(rolled)
  assert.equal(rolled.active, 'dsh-1.0.0+suite-s1')
  assert.equal(rolled.previous, null)
  assert.equal(h.readCurrent().active, 'dsh-1.0.0+suite-s1')
})
