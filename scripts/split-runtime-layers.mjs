// Split a built kernel runtime into cacheable layers.
//
// Why: a kernel update currently re-downloads the whole ~96 MiB tarball even
// though a dsh release only replaces the ~10 MiB of `@deepseek-ai/*` packages.
// Measured on dsh-runtime-win32-x64-0.1.5-rc.2 (see docs/desktop-optimization-plan.md):
//
//   node    33.9 MiB   the Node binary          (changes on a Node bump only)
//   vendor  45.5 MiB   third-party closure      (changes when the dep set does)
//   dsh      9.9 MiB   @deepseek-ai/* packages  (changes every dsh release)
//   suite    6.9 MiB   @dsh-app/* plugins       (changes when we ship plugins)
//
// The layer names are the cache keys: node/vendor are content-addressed (a
// rebuild with identical content keeps the same name, so a client reuses what
// it already has), dsh/suite are version-addressed (their name changes exactly
// when their content should).
//
// Usage:
//   node scripts/split-runtime-layers.mjs <runtime.tgz | runtime dir> [--out <dir>] [--no-verify]
//
// Output: <out>/<layer>.tgz per layer plus layers.json (the composite manifest
// the client resolves), and — unless --no-verify — a re-assembly check that the
// layers reproduce the input byte-for-byte.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const tar = require('tar')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Files that belong to no package scope but are still required to boot. */
const META_ENTRIES = ['runtime/manifest.json', 'runtime/app/package.json']

/** Layer definitions: what goes in, and where it unpacks inside the runtime. */
const LAYER_SPECS = [
  { kind: 'node', entries: ['runtime/node'] },
  { kind: 'vendor', entries: ['runtime/app'], excludePackageScopes: true },
  { kind: 'dsh', entries: ['runtime/app/node_modules/@deepseek-ai'] },
  { kind: 'suite', entries: ['runtime/app/node_modules/@dsh-app'] },
  // The manifest and the app's package.json (the latter carries `type: module`,
  // which module resolution depends on). Without this layer the emitted set
  // cannot reproduce the tree on its own.
  { kind: 'meta', entries: META_ENTRIES },
]

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
}

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
}

/** Vendor/vendor-style layers are keyed by their content, so identical rebuilds collide. */
const cacheKey = (sha256) => sha256.slice(0, 12)

async function main() {
  const argv = process.argv.slice(2)
  const noVerify = argv.includes('--no-verify')
  const outIndex = argv.indexOf('--out')
  const outDir = outIndex === -1 ? path.join(root, 'runtime-layers') : path.resolve(argv[outIndex + 1])
  // Guarded: with no --out, outIndex + 1 would be 0 and would swallow the input.
  const outValue = outIndex === -1 ? undefined : argv[outIndex + 1]
  const input = argv.find((arg) => !arg.startsWith('--') && arg !== outValue)
  if (!input) throw new Error('usage: split-runtime-layers.mjs <runtime.tgz | runtime dir> [--out <dir>] [--no-verify]')

  const work = path.join(tmpdir(), `dsh-layers-${process.pid}`)
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  const sourceDir = path.join(work, 'source')
  await mkdir(sourceDir, { recursive: true })

  // Either extract the shipped tarball or copy an already-built tree, so the
  // script works both in CI (after build-runtime) and against an unpacked dir.
  if (input.endsWith('.tgz')) {
    console.log(`extracting ${path.relative(root, input)} …`)
    await tar.x({ file: path.resolve(input), cwd: sourceDir })
  } else {
    await cp(path.resolve(input), sourceDir, { recursive: true })
  }

  const runtimeDir = path.join(sourceDir, 'runtime')
  const manifest = JSON.parse(await readFile(path.join(runtimeDir, 'manifest.json'), 'utf8'))
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const layers = []
  for (const spec of LAYER_SPECS) {
    const staging = path.join(work, `layer-${spec.kind}.tgz`)
    const filter = spec.excludePackageScopes === true
      ? (entryPath) => !/runtime\/app\/node_modules\/@(?:deepseek-ai|dsh-app)(?:\/|$)/u.test(entryPath)
        && !META_ENTRIES.includes(entryPath)
      : undefined
    await tar.c(
      { gzip: true, file: staging, cwd: sourceDir, portable: true, mtime: new Date(0), ...(filter ? { filter } : {}) },
      spec.entries,
    )
    const digest = await sha512File(staging)
    // Content-addressed for the layers whose name IS their cache key (an
    // identical rebuild must reuse a client's cached file); version-addressed
    // for the two that should change name exactly when their content should.
    const name = spec.kind === 'dsh'
      ? `dsh-${manifest.dshVersion}-${manifest.platform}-${manifest.arch}.tgz`
      : spec.kind === 'suite'
        ? `suite-${manifest.suiteVersion}-${manifest.platform}-${manifest.arch}.tgz`
        : `${spec.kind}-${cacheKey(await sha256File(staging))}-${manifest.platform}-${manifest.arch}.tgz`
    const target = path.join(outDir, name)
    await cp(staging, target)
    layers.push({ kind: spec.kind, name, sha512: digest, bytes: (await stat(target)).size, entries: spec.entries })
    console.log(`${spec.kind.padEnd(7)} ${name}  ${(layers[layers.length - 1].bytes / 1048576).toFixed(1)} MiB`)
  }

  const composite = {
    ...manifest,
    layers,
  }
  await writeFile(path.join(outDir, 'layers.json'), `${JSON.stringify(composite, undefined, 2)}\n`)

  const total = layers.reduce((sum, layer) => sum + layer.bytes, 0)
  console.log(`\n${layers.length} layers, ${(total / 1048576).toFixed(1)} MiB total`)

  if (!noVerify) await verify(sourceDir, outDir, layers)
  await rm(work, { recursive: true, force: true })
}

/**
 * Re-assemble the layers ALONE into a fresh directory and compare every file
 * against the input tree. Deliberately uses nothing but the emitted files: an
 * earlier revision kept the manifest out of every layer and only passed this
 * check because it stitched in a temporary tarball, which would have shipped a
 * layer set that cannot boot.
 */
async function verify(sourceDir, outDir, layers) {
  const reassembled = path.join(tmpdir(), `dsh-layers-verify-${process.pid}`)
  await rm(reassembled, { recursive: true, force: true })
  await mkdir(reassembled, { recursive: true })
  for (const layer of layers) {
    await tar.x({ file: path.join(outDir, layer.name), cwd: reassembled })
  }

  const [expected, actual] = await Promise.all([hashTree(path.join(sourceDir, 'runtime')), hashTree(path.join(reassembled, 'runtime'))])
  const missing = [...expected.keys()].filter((key) => !actual.has(key))
  const extra = [...actual.keys()].filter((key) => !expected.has(key))
  const differing = [...expected.keys()].filter((key) => actual.has(key) && actual.get(key) !== expected.get(key))
  if (missing.length > 0 || extra.length > 0 || differing.length > 0) {
    throw new Error(
      `layer re-assembly differs from the input tree: ${missing.length} missing, ${extra.length} extra, ${differing.length} differing`
      + `\nexamples: ${[...missing, ...extra, ...differing].slice(0, 5).join(', ')}`,
    )
  }
  console.log(`verify  ok — ${expected.size} files reproduced exactly`)
  await rm(reassembled, { recursive: true, force: true })
}

/** Map of path (relative to the runtime root) -> sha256, for whole-tree comparison. */
async function hashTree(dir) {
  const result = new Map()
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) result.set(path.relative(dir, full).split(path.sep).join('/'), await sha256File(full))
    }
  }
  if (existsSync(dir)) await walk(dir)
  return result
}

await main().catch((error) => {
  console.error(`split-runtime-layers failed: ${error.message}`)
  process.exitCode = 1
})
