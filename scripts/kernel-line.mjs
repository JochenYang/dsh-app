/**
 * Kernel-line resolution, shared by the build script and the release workflow.
 *
 * WHICH kernel line to follow has exactly one source of truth: the root
 * package.json's `@deepseek-ai/dsh` devDependency. The shell and all ten suite
 * plugins are typechecked and built against that spec, so the kernel bundled
 * into an installer must be resolved from the same line. Keeping a second,
 * hand-flipped copy of the channel in the workflow is how v0.11.1 shipped an
 * alpha kernel beside rc-typed code with every CI job green — nothing ever
 * compared the two.
 *
 * Two distinct questions this module answers, deliberately not conflated:
 *   - which dist-tag to resolve FROM  → the followed spec (package.json)
 *   - which channel to LABEL an artifact with → the version actually built
 *
 * CLI (used by the release workflow):
 *   node scripts/kernel-line.mjs            → resolved dist-tag name
 *   node scripts/kernel-line.mjs --json     → { spec, channel, tag, suiteVersion }
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** The kernel package whose line this repo follows. */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/**
 * Suite plugins copied into the runtime's node_modules. KEEP IN SYNC with
 * plugins/dsh-app.patch.yml (insert rows), src/main/brand-suite.ts
 * SUITE_PLUGIN_DIRS, and scripts/smoke-suite.mjs SUITE_DIRS — a row in the
 * overlay without its package here ships a runtime that fails to compose
 * (settings pages silently missing), while the reverse ships dead weight.
 */
export const SUITE_PLUGINS = [
  '@dsh-app/plugin-brand',
  '@dsh-app/plugin-client-ui',
  '@dsh-app/plugin-sidebar',
  '@dsh-app/plugin-swarm',
  '@dsh-app/plugin-usage',
  '@dsh-app/plugin-archives',
  '@dsh-app/plugin-memory',
  '@dsh-app/plugin-fff',
  '@dsh-app/plugin-mcp',
  '@dsh-app/plugin-hooks',
]

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** The devDependency spec every shell/plugin build is typechecked against. */
export function followedSpec(repoRoot = root) {
  const pkg = readJson(path.join(repoRoot, 'package.json'))
  const specs = new Set()
  for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    // The repo pins the individual subpackages (@deepseek-ai/dsh-session, …);
    // they are released together with the kernel itself, so any one of them
    // describes the followed line. Every one must agree — a split set means
    // the tree was half-upgraded and no single kernel line can satisfy it.
    if (name !== DSH_PACKAGE && !name.startsWith(`${DSH_PACKAGE}-`)) continue
    if (typeof spec === 'string' && spec !== '') specs.add(spec)
  }
  if (specs.size === 0) {
    throw new Error(`package.json declares no ${DSH_PACKAGE}* dependency — cannot determine the followed kernel line`)
  }
  if (specs.size > 1) {
    throw new Error(
      `the ${DSH_PACKAGE}* dependencies are on ${specs.size} different specs (${[...specs].sort().join(', ')}) — `
      + 'every dsh package must move together before a kernel version can be resolved from them',
    )
  }
  return [...specs][0]
}

/**
 * Which line a spec follows: `-alpha.` → alpha, `-rc.`/`-beta.` → beta (the
 * `next` tag), anything else → stable. Used to pick the dist-tag to resolve.
 */
export function channelFromSpec(spec) {
  if (/-alpha\./.test(spec)) return 'alpha'
  if (/-rc\.|-beta\./.test(spec)) return 'beta'
  return 'stable'
}

/**
 * Which line a concrete version belongs to. Used to LABEL an artifact: a
 * workflow_dispatch build of an explicitly pinned version must be labelled by
 * that version, not by whatever line the repo currently follows.
 */
export function channelFromVersion(version) {
  if (/-alpha\./.test(version)) return 'alpha'
  if (/-rc\.|-beta\./.test(version)) return 'beta'
  return 'stable'
}

/** npm dist-tag for a channel: alpha→alpha, beta→next, stable→latest. */
export function distTagFor(channel) {
  return channel === 'alpha' ? 'alpha' : channel === 'beta' ? 'next' : 'latest'
}

/**
 * The channel to resolve FROM. `DSH_APP_CHANNEL` stays as an explicit override
 * (a workflow_dispatch input, or a deliberate one-off build); without it the
 * followed spec decides.
 */
export function resolveFollowChannel(repoRoot = root, env = process.env) {
  const override = env.DSH_APP_CHANNEL
  if (override === 'alpha' || override === 'beta' || override === 'stable') return override
  return channelFromSpec(followedSpec(repoRoot))
}

/**
 * Require a well-formed semver without tying it to the followed line — the
 * shape check for a deliberate cross-line build.
 */
export function assertValidVersion(version) {
  if (!semver.valid(version)) {
    throw new Error(`resolved dsh version "${version}" is not a valid semver version`)
  }
  return version
}

/**
 * Guard against building a kernel the code was not written against: the
 * resolved version must satisfy the followed spec. This is the assertion whose
 * absence let an alpha kernel ship next to rc-typed code — it runs on both the
 * dist-tag path and an explicitly pinned version, so a wrong pin fails CI
 * loudly instead of producing a silently mismatched installer.
 */
export function assertFollowedVersion(version, spec = followedSpec()) {
  assertValidVersion(version)
  // includePrerelease: without it semver refuses to match ANY prerelease
  // version against a range that does not spell one out itself — so a spec of
  // `*`, the deliberate cross-line escape hatch, would reject exactly the rc
  // and alpha builds it exists to let through.
  if (!semver.satisfies(version, spec, { includePrerelease: true })) {
    throw new Error(
      `resolved dsh ${version} does not satisfy the followed spec ${spec} — the bundled kernel would come from a `
      + 'different line than the shell and plugins are built against. Align the devDependency, or pass an explicit '
      + 'DSH_APP_CHANNEL/DSH_VERSION if a mismatched build is genuinely intended.',
    )
  }
  return version
}

/**
 * Suite version, content-addressed from the bundled plugins' package.json
 * versions. Any suite change yields a new versionDir name (dsh-<v>+suite-<h>)
 * so activation lands in a fresh directory and the previous one stays for
 * rollback, while an unchanged suite keeps the same name AND — with the
 * reproducible tarball — the same artifact sha512, so a boot-time drift check
 * sees "no change" and skips the extract entirely.
 * An explicit DSH_APP_SUITE_VERSION still wins for hand-tagged builds.
 */
export function computeSuiteVersion(repoRoot = root, env = process.env) {
  const explicit = env.DSH_APP_SUITE_VERSION?.trim()
  if (explicit) return explicit
  const parts = [...SUITE_PLUGINS].sort().map((name) => {
    const pkg = readJson(path.join(repoRoot, 'plugins', name.replace('@dsh-app/', ''), 'package.json'))
    return `${name}@${pkg.version}`
  })
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 8)
}

/** Resolve one npm dist-tag to a concrete version, with a hard timeout. */
export async function resolveDistTagVersion(tag, { timeoutMs = 15_000 } = {}) {
  const res = await fetch(`https://registry.npmjs.org/-/package/${DSH_PACKAGE}/dist-tags`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`dist-tag lookup failed: HTTP ${res.status}`)
  const tags = await res.json()
  const version = tags[tag]
  if (typeof version !== 'string' || version === '') {
    throw new Error(`dist-tag "${tag}" is absent from the registry response (tags=${JSON.stringify(tags)})`)
  }
  return version
}

/** Everything the release workflow needs in one shot. */
export function describeLine(repoRoot = root, env = process.env) {
  const spec = followedSpec(repoRoot)
  const channel = resolveFollowChannel(repoRoot, env)
  return { spec, channel, tag: distTagFor(channel), suiteVersion: computeSuiteVersion(repoRoot, env) }
}

// ------------------------------------------------------------------- CLI

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const override = process.env.DSH_APP_CHANNEL?.trim() || undefined
  const assertIndex = args.indexOf('--assert')
  try {
    if (args.includes('--resolve')) {
      // Resolve the followed line's dist-tag to a concrete version. A version
      // obtained this way belongs to the followed line by construction, so it
      // is always asserted; only an explicit DSH_APP_CHANNEL override — the
      // documented escape hatch for a deliberate cross-line build — is exempt.
      const version = await resolveDistTagVersion(distTagFor(resolveFollowChannel()))
      process.stdout.write(`${override === undefined ? assertFollowedVersion(version) : assertValidVersion(version)}\n`)
    } else if (assertIndex >= 0) {
      const version = args[assertIndex + 1]
      if (version === undefined || version === '') throw new Error('--assert needs a version argument')
      process.stdout.write(`${override === undefined ? assertFollowedVersion(version) : assertValidVersion(version)}\n`)
    } else {
      const line = describeLine()
      process.stdout.write(args.includes('--json') ? `${JSON.stringify(line)}\n` : `${line.tag}\n`)
    }
  } catch (error) {
    console.error(`[kernel-line] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
