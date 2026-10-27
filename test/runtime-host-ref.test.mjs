// The runtime build must accept a kernel version upstream kept as a TAG only.
//
// Why this test exists — measured on v0.17.8's release run 40351118119: all six
// runtime cells died in `git clone` with
//
//     fatal: Remote branch dsh-v0.2.1-rc.4 not found in upstream origin
//
// The build resolves its kernel version from the npm `next` dist-tag (beta line),
// which pointed at 0.2.1-rc.4, while the harness repository had published no
// branch for it — and no tag either. `--branch` accepts a tag, so the REF'S KIND
// was never the real problem; asking for a ref that does not exist was.
//
// The rule that follows is narrow: the branch is preferred when it exists (that
// is what a line in flight uses), a tag of the same name is an acceptable
// substitute, and neither existing fails with a message that names the ref rather
// than the clone's own error.
//
// These are static facts about the build script, so this needs no network and no
// build.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUILD = path.join(ROOT, 'scripts', 'build-runtime.mjs')

/** The build script's source, read once. */
function buildSource() {
  return readFileSync(BUILD, 'utf8')
}

test('the clone resolves its ref through upstreamRef, not the raw hostTag', () => {
  const source = buildSource()
  // The regression is calling hostTag() straight into --branch: that string is
  // an assumption about upstream's ref layout, and it is the assumption that
  // failed. upstreamRef is the function that VERIFIES it first.
  assert.match(
    source,
    /const ref = upstreamRef\(url, workRoot\)/u,
    'the clone must ask upstreamRef for its ref',
  )
  assert.match(
    source,
    /'--branch', ref, url, dir/u,
    'the verified ref is what reaches git clone',
  )
  assert.doesNotMatch(
    source,
    /'--branch', hostTag\(\)/u,
    'a raw hostTag() must never be passed to --branch again — it is unverified',
  )
})

test('a branch wins, a tag of the same name is the fallback', () => {
  const source = buildSource()
  const start = source.indexOf('function upstreamRefKind(')
  assert.notEqual(start, -1, 'upstreamRefKind must exist')
  const body = source.slice(start, source.indexOf('\nfunction ', start + 1))
  // Order matters: the branch is what a line in flight uses, so it is asked for
  // first and returned first. A tag-only ref is the substitute, not the default.
  const branchAt = body.indexOf('refs/heads/')
  const tagAt = body.indexOf('refs/tags/')
  assert.notEqual(branchAt, -1, 'the branch is probed')
  assert.notEqual(tagAt, -1, 'the tag is probed')
  assert.ok(branchAt < tagAt, 'the branch must be probed before the tag')
})

test('neither ref existing fails with the ref named, not a clone error', () => {
  const source = buildSource()
  const start = source.indexOf('function upstreamRef(')
  assert.notEqual(start, -1, 'upstreamRef must exist')
  const body = source.slice(start, source.indexOf('\nfunction ', start + 1))
  assert.match(body, /neither a branch nor a tag named/u, 'the error names both candidates')
  assert.match(body, /DSH_APP_HOST_TAG/u, 'the error names the override that unblocks a build')
})

test('a tag-only build says so instead of silently changing shape', () => {
  const source = buildSource()
  const start = source.indexOf('function upstreamRef(')
  const body = source.slice(start, source.indexOf('\nfunction ', start + 1))
  // A warning is the honest signal: the build succeeded, but from a tag rather
  // than the branch this line normally uses. Silent substitution is how a build
  // ends up shipping a tree nobody chose.
  assert.match(body, /console\.warn\(/u, 'falling back to a tag is announced')
  assert.match(body, /is a tag, not a branch/u, 'and says which kind it used')
})
