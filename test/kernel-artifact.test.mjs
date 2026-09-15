// Kernel artifact resolution: the tarball may be transported by the ModelScope
// mirror, while the trusted digest chain stays official-first. These tests pin
// that separation — it is the invariant that lets a mirror serve 100 MB without
// ever being able to substitute content.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { GitHubArtifactResolver, githubMirrorPrefixes, modelscopeRuntimeAssetUrl } =
  require('../dist/kernel/sources/artifact.js')
const { MODELSCOPE_ENDPOINT, MODELSCOPE_REPO } = require('../dist/shared/constants.js')

const OWNER = 'JochenYang'
const REPO = 'dsh-app'
const VERSION = '0.1.5-rc.2'
const PLATFORM = 'win32'
const ARCH = 'x64'
const NAME = `dsh-runtime-${PLATFORM}-${ARCH}-${VERSION}.tgz`
const OFFICIAL_BASE = `https://github.com/${OWNER}/${REPO}/releases/download/runtime-${VERSION}`
const MANIFEST = {
  dshVersion: VERSION, suiteVersion: 'suite-1', channel: 'beta',
  platform: PLATFORM, arch: ARCH, integrity: '', source: 'artifact',
}
const OFFICIAL_SHA = 'a'.repeat(128)
const MIRROR_SHA = 'b'.repeat(128)

/**
 * Install a fetch stub. `handler` may answer a URL itself; returning undefined
 * falls back to "the official release publishes both metadata sidecars".
 */
function stubFetch(handler) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    calls.push(target)
    const custom = handler?.(target)
    if (custom !== undefined) return custom
    if (target === `${OFFICIAL_BASE}/${NAME}.sha512`) return new Response(`${OFFICIAL_SHA}\n`, { status: 200 })
    if (target === `${OFFICIAL_BASE}/manifest-${PLATFORM}-${ARCH}.json`) {
      return new Response(JSON.stringify(MANIFEST), { status: 200 })
    }
    throw new Error(`unexpected fetch ${target}`)
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}

function resolver() {
  return new GitHubArtifactResolver(OWNER, REPO, PLATFORM, ARCH)
}

test('tarball candidates are official-first and end with the ModelScope copy', async () => {
  const stub = stubFetch()
  try {
    const info = await resolver().fetchArtifact(VERSION)
    assert.ok(info)
    assert.deepEqual(info.candidates, [
      `${OFFICIAL_BASE}/${NAME}`,
      ...githubMirrorPrefixes().map((prefix) => `${prefix}${OFFICIAL_BASE}/${NAME}`),
      modelscopeRuntimeAssetUrl(VERSION, NAME),
    ])
    assert.equal(info.candidates.filter((url) => url.startsWith(MODELSCOPE_ENDPOINT)).length, 1)
    assert.equal(info.sha512, OFFICIAL_SHA)
    assert.equal(info.source, OFFICIAL_BASE, 'metadata still comes from the official host')
  } finally {
    stub.restore()
  }
})

test('the digest comes from the official host and the mirror is never asked for metadata', async () => {
  const stub = stubFetch((target) => {
    // A mirror that would happily serve a DIFFERENT digest for the same asset.
    if (target.startsWith(MODELSCOPE_ENDPOINT)) return new Response(`${MIRROR_SHA}\n`, { status: 200 })
    return undefined
  })
  try {
    const info = await resolver().fetchArtifact(VERSION)
    assert.ok(info)
    assert.equal(info.sha512, OFFICIAL_SHA)
    assert.ok(
      stub.calls.every((url) => !url.startsWith(MODELSCOPE_ENDPOINT)),
      'the mirror is a transport entry only — it must not be consulted while resolving metadata',
    )
  } finally {
    stub.restore()
  }
})

test('resolution fails closed when GitHub and its proxies are unreachable, even if the mirror would answer', async () => {
  const stub = stubFetch((target) => {
    if (target.startsWith(MODELSCOPE_ENDPOINT)) return new Response(`${MIRROR_SHA}\n`, { status: 200 })
    throw new Error('github blocked')
  })
  try {
    assert.equal(await resolver().fetchArtifact(VERSION), null)
    assert.ok(
      stub.calls.every((url) => !url.startsWith(MODELSCOPE_ENDPOINT)),
      'a blocked GitHub must not silently promote the mirror into a metadata authority',
    )
  } finally {
    stub.restore()
  }
})

test('the availability probe reports the official verdict without consulting the mirror', async () => {
  const stub = stubFetch((target) => {
    if (target.startsWith(MODELSCOPE_ENDPOINT)) return new Response(`${MIRROR_SHA}\n`, { status: 200 })
    if (target.startsWith(OFFICIAL_BASE)) return new Response('not published', { status: 404 })
    throw new Error('proxy blocked')
  })
  try {
    assert.equal(await resolver().probeArtifact(VERSION), 'missing')
    assert.ok(stub.calls.every((url) => !url.startsWith(MODELSCOPE_ENDPOINT)))
  } finally {
    stub.restore()
  }
})

test('the ModelScope runtime URL encodes each segment and keeps slashes literal', () => {
  const build = '1.0.0+build.1'
  const asset = `dsh-runtime-${PLATFORM}-${ARCH}-${build}.tgz`
  const url = modelscopeRuntimeAssetUrl(build, asset)
  assert.ok(url.startsWith(`${MODELSCOPE_ENDPOINT}/api/v1/models/${MODELSCOPE_REPO}/repo?Revision=master&FilePath=`))
  // '+' must not decode to a space, and the directory slashes stay literal.
  assert.ok(url.includes(`releases/runtime/runtime-1.0.0%2Bbuild.1/${asset}`.replace('+', '%2B')))
  assert.ok(!url.includes('%2F'))
})
