// Unit tests for the Windows update source chain (ModelScope mirror first).
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  DOWNLOAD_TIMEOUT_MS,
  MANUAL_DOWNLOAD_HINT,
  assetCandidates,
  downloadWithFallback,
  fetchAndParseLatest,
  isSafeVersion,
  latestYamlCandidates,
  modelscopeReleaseFileUrl,
  parseLatestYaml,
  pickAsset,
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
  // Mirror-first does not also append the same mirror URL at the end.
  assert.equal(fromMirror.filter((url) => url.startsWith(MODELSCOPE_ENDPOINT)).length, 1)
})

test('asset candidates close with the ModelScope mirror even when metadata came from GitHub', () => {
  const asset = 'DSH-APP-9.9.9-win-x64.exe'
  const fromGitHub = assetCandidates(OWNER, REPO, asset, OFFICIAL_YAML)
  // The official chain keeps its order...
  assert.equal(fromGitHub[0], `${GITHUB_LATEST}/${asset}`)
  for (const prefix of MIRROR_PREFIXES) assert.ok(fromGitHub.includes(`${prefix}${GITHUB_LATEST}/${asset}`))
  // ...and the mainland mirror is the last resort, exactly once. This is the
  // "latest.yml reachable but the 180 MB installer is not" topology.
  assert.equal(fromGitHub[fromGitHub.length - 1], modelscopeReleaseFileUrl(`releases/latest/${asset}`))
  assert.equal(fromGitHub.filter((url) => url.startsWith(MODELSCOPE_ENDPOINT)).length, 1)
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
  assert.equal(fromMirror.filter((url) => url.startsWith(MODELSCOPE_ENDPOINT)).length, 1)
})

test('rollback installer candidates append the archive mirror as the last resort', () => {
  const asset = 'DSH-APP-0.11.6-win-x64.exe'
  const fromGitHub = releaseAssetCandidates(OWNER, REPO, '0.11.6', asset, `https://github.com/${OWNER}/${REPO}/releases/download/v0.11.6/latest.yml`)
  assert.equal(fromGitHub[0], `https://github.com/${OWNER}/${REPO}/releases/download/v0.11.6/${asset}`)
  assert.equal(fromGitHub[fromGitHub.length - 1], modelscopeReleaseFileUrl(`releases/archive/0.11.6/${asset}`))
  assert.equal(fromGitHub.filter((url) => url.startsWith(MODELSCOPE_ENDPOINT)).length, 1)
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

// ------------------------------------------------- asset download failure path

const sha512b64 = (data) => createHash('sha512').update(data).digest('base64')

function makeTempDest() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-updater-test-'))
  return { dir, dest: path.join(dir, 'installer.exe') }
}

test('every asset candidate failing surfaces the mirror manual-download address', async () => {
  const realFetch = globalThis.fetch
  const { dir, dest } = makeTempDest()
  const attempts = []
  globalThis.fetch = async (url) => {
    attempts.push(String(url))
    throw new Error('connection reset')
  }
  try {
    const candidates = assetCandidates(OWNER, REPO, 'DSH-APP-9.9.9-win-x64.exe', OFFICIAL_YAML)
    await assert.rejects(
      () => downloadWithFallback(candidates, dest, sha512b64('payload'), () => {}),
      (err) => {
        assert.ok(err.message.includes('无法从任何源下载更新包'), 'reports that every source failed')
        assert.ok(err.message.includes(MANUAL_DOWNLOAD_HINT), 'carries the actionable hint')
        assert.ok(err.message.includes(MODELSCOPE_RELEASES_URL), 'names the mirror manual-download address')
        return true
      },
    )
    assert.equal(attempts.length, candidates.length, 'every candidate was tried')
    assert.equal(
      attempts[attempts.length - 1],
      modelscopeReleaseFileUrl('releases/latest/DSH-APP-9.9.9-win-x64.exe'),
      'the mirror is the last resort even though the metadata came from GitHub',
    )
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a sha512 mismatch falls through to the next candidate and succeeds on its good bytes', async () => {
  const realFetch = globalThis.fetch
  const { dir, dest } = makeTempDest()
  const goodBytes = 'the-verified-installer-bytes'
  const candidates = [
    'https://github.com/o/r/releases/latest/download/DSH-APP-9.9.9-win-x64.exe',
    'https://www.modelscope.cn/mirror/installer.exe',
  ]
  const attempts = []
  const progress = []
  globalThis.fetch = async (url) => {
    attempts.push(String(url))
    // The first candidate serves different bytes than latest.yml pins (a
    // lagging/tampered mirror or a truncated mirror copy); the second is the
    // destination whose bytes match the digest.
    return attempts.length === 1
      ? new Response('tampered-bytes', { status: 200 })
      : new Response(goodBytes, { status: 200 })
  }
  try {
    const won = await downloadWithFallback(candidates, dest, sha512b64(goodBytes), (received) => progress.push(received))
    assert.equal(attempts.length, 2, 'the mismatch did not stop the chain')
    assert.equal(won, candidates[1], 'the candidate whose bytes verify wins')
    assert.equal(readFileSync(dest, 'utf8'), goodBytes, 'the verified bytes are what stayed on disk')
    assert.ok(progress.length > 0, 'download progress was reported')
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version guard accepts shipped versions and rejects `..` or non-digit starts', () => {
  for (const version of ['0.11.7', '0.11.8-beta.1', '1.2.3-rc.2', '0.1.5-alpha.2']) {
    assert.equal(isSafeVersion(version), true, `${version} must stay accepted`)
  }
  for (const version of ['1..2', '0..11.7', '..', '../etc', 'v0.11.7', '.hidden', '-bad', '', '1.0.0+x']) {
    assert.equal(isSafeVersion(version), false, `${version} must be rejected`)
  }
})

test('per-candidate download timeout stays bounded at 180 s', () => {
  // Four candidates (mirror appended) => ~12 min worst case, not ~40 min.
  assert.equal(DOWNLOAD_TIMEOUT_MS, 180_000)
})

// ------------------------------------------------------------------ asset pick

test('pickAsset selects the running arch and keeps the generic x64 fallback', () => {
  const files = [
    { url: 'DSH-APP-9.9.9-win-arm64.exe', sha512: 'arm' },
    { url: 'DSH-APP-9.9.9-win-x64.exe', sha512: 'x64' },
  ]
  assert.equal(pickAsset(files, 'x64')?.sha512, 'x64')
  assert.equal(pickAsset(files, 'arm64')?.sha512, 'arm')
  // No exact-arch asset: the generic `-win.exe` / x64-named fallback is used.
  assert.equal(pickAsset([{ url: 'DSH-APP-9.9.9-win.exe', sha512: 'generic' }], 'x64')?.sha512, 'generic')
  assert.equal(pickAsset([{ url: 'DSH-APP-9.9.9-win-x64.exe', sha512: 'x64fb' }], 'arm64')?.sha512, 'x64fb')
})

test('pickAsset tolerates malformed entries without throwing', () => {
  const files = [
    { note: 'not a file entry' },
    { url: 'DSH-APP-9.9.9-win-x64.exe' }, // sha512 missing
    { url: '', sha512: 'empty-url' },
    { sha512: 'url-missing' },
    { url: 'DSH-APP-9.9.9-win-x64.exe', sha512: 'valid' },
  ]
  assert.equal(pickAsset(files, 'x64')?.sha512, 'valid')
  // Only malformed records: nothing is picked, nothing throws.
  assert.equal(pickAsset([{ url: '' }, { sha512: 'x' }, { note: 'n' }], 'x64'), null)
  assert.equal(pickAsset([], 'x64'), null)
  assert.equal(pickAsset([{ url: 'DSH-APP-9.9.9-win-x64.exe' }], 'x64'), null)
})

// ------------------------------------------------------------ metadata parsing

test('parseLatestYaml rejects malformed or unusable metadata', () => {
  assert.equal(parseLatestYaml(''), null)
  assert.equal(parseLatestYaml('   \n# only a comment\n'), null)
  assert.equal(parseLatestYaml('::: not yaml :::'), null)
  assert.equal(parseLatestYaml('<html>rate limited</html>'), null)
  // files without a version, and a version without files, are both unusable.
  assert.equal(parseLatestYaml('files:\n  - url: a.exe\n    sha512: aa\n'), null)
  assert.equal(parseLatestYaml('version: 1.0.0\n'), null)
})

test('parseLatestYaml keeps top-level fields out of files and tolerates a sha512-less entry', () => {
  const text = [
    'version: 0.11.7',
    'files:',
    '  - url: DSH-APP-0.11.7-win-x64.exe',
    '    sha512: AAAA',
    '  - url: DSH-APP-0.11.7-win-arm64.exe',
    '  - note: see the release notes for details',
    'path: DSH-APP-0.11.7-win-x64.exe',
    'sha512: BBBB',
    'releaseDate: 2026-09-13T00:00:00Z',
  ].join('\n')
  const yaml = parseLatestYaml(text)
  assert.equal(yaml?.version, '0.11.7')
  assert.deepEqual(
    yaml.files.map((f) => f.url),
    ['DSH-APP-0.11.7-win-x64.exe', 'DSH-APP-0.11.7-win-arm64.exe'],
  )
  assert.equal(yaml.files[0].sha512, 'AAAA')
  assert.equal(yaml.files[1].sha512, undefined, 'a missing sha512 stays absent, never inherited from a top-level key')
  assert.ok(!yaml.files.some((f) => f.url === 'BBBB'), 'a top-level field is not a file entry')
  // End to end: the sha512-less entry is filtered, the valid x64 one is picked.
  assert.equal(pickAsset(yaml.files, 'x64')?.url, 'DSH-APP-0.11.7-win-x64.exe')
})
