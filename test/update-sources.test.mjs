// Unit tests for the Windows update source chain (ModelScope mirror first).
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  MANUAL_DOWNLOAD_HINT,
  assetCandidates,
  fetchAndParseLatest,
  latestYamlCandidates,
  modelscopeReleaseFileUrl,
  releaseAssetCandidates,
  releaseLatestYamlCandidates,
} = require('../dist/main/updater.js')
const { MODELSCOPE_ENDPOINT, MODELSCOPE_RELEASES_URL, MODELSCOPE_REPO } = require('../dist/shared/constants.js')

const OWNER = 'JochenYang'
const REPO = 'dsh-app'
const GITHUB_LATEST = `https://github.com/${OWNER}/${REPO}/releases/latest/download`
const OFFICIAL_YAML = `${GITHUB_LATEST}/latest.yml`
const MIRROR_PREFIXES = ['https://ghfast.top/', 'https://gh-proxy.com/']

const GOOD_YAML = [
  'version: 9.9.9',
  'files:',
  '  - url: DSH-APP-9.9.9-win-x64.exe',
  '    sha512: c2hhNTEy',
  'path: DSH-APP-9.9.9-win-x64.exe',
].join('\n')

test('latest.yml candidates put the ModelScope mirror first, then official GitHub, then prefixes', () => {
  const candidates = latestYamlCandidates(OWNER, REPO)
  assert.equal(
    candidates[0],
    `${MODELSCOPE_ENDPOINT}/api/v1/models/${MODELSCOPE_REPO}/repo?Revision=master&FilePath=releases/latest/latest.yml`,
  )
  assert.equal(candidates[1], OFFICIAL_YAML)
  for (const prefix of MIRROR_PREFIXES) assert.ok(candidates.includes(`${prefix}${OFFICIAL_YAML}`))
  assert.equal(candidates.length, 2 + MIRROR_PREFIXES.length)
})

test('ModelScope FilePath URL keeps slashes literal and encodes the filename segment', () => {
  const base = `${MODELSCOPE_ENDPOINT}/api/v1/models/${MODELSCOPE_REPO}/repo?Revision=master&FilePath=`
  // electron-builder has produced names with a space; '+' must not decode to a
  // space and '&'/'#' must not escape the query value.
  assert.equal(
    modelscopeReleaseFileUrl('releases/latest/DSH APP-1.0.0-win-x64.exe'),
    `${base}releases/latest/DSH%20APP-1.0.0-win-x64.exe`,
  )
  assert.equal(modelscopeReleaseFileUrl('releases/latest/DSH+APP.exe'), `${base}releases/latest/DSH%2BAPP.exe`)
  assert.equal(modelscopeReleaseFileUrl('releases/latest/a&b#c.exe'), `${base}releases/latest/a%26b%23c.exe`)
  // Directory separators stay literal (the verified URL shape, no %2F).
  assert.ok(!modelscopeReleaseFileUrl('releases/archive/1.0.0/x.exe').includes('%2F'))
})

test('asset candidates lead with the mirror only when metadata came from the mirror', () => {
  const asset = 'DSH-APP-9.9.9-win-x64.exe'
  const fromMirror = assetCandidates(OWNER, REPO, asset, modelscopeReleaseFileUrl('releases/latest/latest.yml'))
  assert.equal(fromMirror[0], modelscopeReleaseFileUrl(`releases/latest/${asset}`))
  assert.equal(fromMirror[1], `${GITHUB_LATEST}/${asset}`)
  for (const prefix of MIRROR_PREFIXES) assert.ok(fromMirror.includes(`${prefix}${GITHUB_LATEST}/${asset}`))

  const fromGitHub = assetCandidates(OWNER, REPO, asset, OFFICIAL_YAML)
  assert.equal(fromGitHub[0], `${GITHUB_LATEST}/${asset}`)
  assert.ok(!fromGitHub.some((url) => url.startsWith(MODELSCOPE_ENDPOINT)))
})

test('rollback metadata candidates lead with the mirror archive for the requested version', () => {
  const candidates = releaseLatestYamlCandidates(OWNER, REPO, '0.11.6')
  assert.equal(
    candidates[0],
    `${MODELSCOPE_ENDPOINT}/api/v1/models/${MODELSCOPE_REPO}/repo?Revision=master&FilePath=releases/archive/0.11.6/latest.yml`,
  )
  assert.equal(candidates[1], `https://github.com/${OWNER}/${REPO}/releases/download/v0.11.6/latest.yml`)
  for (const prefix of MIRROR_PREFIXES) {
    assert.ok(candidates.includes(`${prefix}https://github.com/${OWNER}/${REPO}/releases/download/v0.11.6/latest.yml`))
  }
})

test('rollback installer candidates use the mirror archive when metadata came from the mirror', () => {
  const asset = 'DSH-APP-0.11.6-win-x64.exe'
  const fromMirror = releaseAssetCandidates(OWNER, REPO, '0.11.6', asset, modelscopeReleaseFileUrl('releases/archive/0.11.6/latest.yml'))
  assert.equal(fromMirror[0], modelscopeReleaseFileUrl(`releases/archive/0.11.6/${asset}`))
  assert.equal(fromMirror[1], `https://github.com/${OWNER}/${REPO}/releases/download/v0.11.6/${asset}`)

  const fromGitHub = releaseAssetCandidates(OWNER, REPO, '0.11.6', asset, `https://github.com/${OWNER}/${REPO}/releases/download/v0.11.6/latest.yml`)
  assert.equal(fromGitHub[0], `https://github.com/${OWNER}/${REPO}/releases/download/v0.11.6/${asset}`)
  assert.ok(!fromGitHub.some((url) => url.startsWith(MODELSCOPE_ENDPOINT)))
})

test('mirror failure falls through to the next metadata source', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (calls.length === 1) throw new Error('mirror unreachable')
    return new Response(GOOD_YAML, { status: 200 })
  }
  try {
    const meta = await fetchAndParseLatest()
    assert.ok(meta, 'a later source should win')
    assert.equal(meta.source, OFFICIAL_YAML)
    assert.equal(meta.yaml.version, '9.9.9')
    assert.ok(calls[0].startsWith(MODELSCOPE_ENDPOINT), 'mirror is tried first')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a mirror answering 200 with a non-metadata body falls through too', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return calls.length === 1
      ? new Response('<html>rate limited</html>', { status: 200 })
      : new Response(GOOD_YAML, { status: 200 })
  }
  try {
    const meta = await fetchAndParseLatest()
    assert.equal(meta?.source, OFFICIAL_YAML)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('every source failing returns null and the error hint points at the mirror repo', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  try {
    assert.equal(await fetchAndParseLatest(), null)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(MODELSCOPE_RELEASES_URL, `${MODELSCOPE_ENDPOINT}/models/${MODELSCOPE_REPO}/files`)
  assert.ok(MANUAL_DOWNLOAD_HINT.includes('镜像'), 'hint mentions the mirror')
  assert.ok(MANUAL_DOWNLOAD_HINT.includes(MODELSCOPE_RELEASES_URL), 'hint carries the mirror address')
})
