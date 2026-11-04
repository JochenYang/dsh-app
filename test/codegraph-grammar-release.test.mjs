// The code-graph grammars that are downloaded, not shipped, must be findable at
// the URL the plugin builds — and the plugin builds that URL from constants it
// cannot import.
//
// `plugin-codegraph` runs inside the kernel child; the release coordinates, the
// ModelScope endpoint and the `runtime-` tag prefix live in the SHELL
// (`src/shared/constants.ts`, `src/kernel/sources/artifact.ts`). The plugin
// therefore repeats those four values. Repeating them is the cheap half;
// agreeing is the half that breaks, and the failure mode is silent in the worst
// way: the code stays green, the release stays green, and a user's settings page
// answers "download failed" for a language we told them we support. This test is
// the seam — it reads both sides as text and fails when they drift.
//
// It reads source text rather than importing, because the shell is CommonJS
// compiled to `dist/` and the plugin is ESM TypeScript: importing either from
// here would test a build rather than the declaration. A value this reader
// cannot find is a FAILURE, never a pass — a gate that reports agreement it
// could not check is worse than no gate.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** One exported string constant out of a source file, or null when it is not there. */
function constantIn(file, name) {
  const source = readFileSync(path.join(root, file), 'utf8')
  const match = new RegExp(`export const ${name} = '([^']*)'`, 'u').exec(source)
  return match === null ? null : match[1]
}

test('the plugin downloads its on-demand grammars from this app’s own runtime release', () => {
  const pluginLanguages = path.join('plugins', 'plugin-codegraph', 'src', 'languages.ts')
  const plugin = readFileSync(path.join(root, pluginLanguages), 'utf8')
  const block = /export const GRAMMAR_RELEASE = \{([\s\S]*?)\} as const/u.exec(plugin)
  assert.ok(block !== null, 'GRAMMAR_RELEASE is missing from the plugin, so no grammar can be downloaded')

  const read = (key) => {
    const match = new RegExp(`${key}: '([^']*)'`, 'u').exec(block[1] ?? '')
    assert.ok(match !== null, `GRAMMAR_RELEASE.${key} could not be read; this gate refuses to guess`)
    return match[1]
  }

  // The shell's side of the same four facts.
  const endpoint = constantIn(path.join('src', 'shared', 'constants.ts'), 'MODELSCOPE_ENDPOINT')
  const repo = constantIn(path.join('src', 'shared', 'constants.ts'), 'MODELSCOPE_REPO')
  assert.ok(endpoint !== null, 'MODELSCOPE_ENDPOINT could not be read from the shell constants')
  assert.ok(repo !== null, 'MODELSCOPE_REPO could not be read from the shell constants')

  assert.equal(read('modelscopeEndpoint'), endpoint, 'the mirror endpoint must be the shell’s')
  assert.equal(read('modelscopeRepo'), repo, 'the mirror repo must be the shell’s')

  // The GitHub owner/repo and the tag prefix come from the shell's artifact resolver.
  const resolver = readFileSync(path.join(root, 'src', 'kernel', 'sources', 'artifact.ts'), 'utf8')
  const prefix = /const RELEASE_TAG_PREFIX = '([^']*)'/u.exec(resolver)
  assert.ok(prefix !== null, 'RELEASE_TAG_PREFIX could not be read from the artifact resolver')
  assert.equal(read('tagPrefix'), prefix[1], 'the plugin must look under the tag the release actually creates')

  // The GitHub side is spelled with the repository the workflow publishes into.
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(workflow, /TAG: runtime-\$\{\{ steps\.runtime\.outputs\.dsh_version \}\}/u,
    'the release workflow must create the runtime- tag the plugin looks under')
  assert.match(read('githubRepo'), /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'owner/repo, not a URL')
})

test('every downloadable grammar uploads with the release that ships the plugin', () => {
  // The bytes and the upload must be one change: a digest recorded for a file the
  // workflow never uploads is a download that 404s for every user, and nothing in
  // the build would notice.
  const plugin = readFileSync(path.join(root, 'plugins', 'plugin-codegraph', 'src', 'languages.ts'), 'utf8')
  const releaseSourced = [...plugin.matchAll(/grammar: '([a-z-]+)', label: '[^']*', extensions: \[[^\]]*\], bundled: false, source: 'release'/gu)]
    .map(match => match[1])
  assert.ok(releaseSourced.length > 0, 'no release-sourced grammar found; the reader is out of date')

  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(workflow, /plugins\/plugin-codegraph\/grammars-optional\/\*\.wasm/u,
    'release.yml must upload grammars-optional/*.wasm to the runtime release, or every download 404s')
})
