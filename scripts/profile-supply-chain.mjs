#!/usr/bin/env node
/**
 * The profile supply chain checkup: the two things a kernel-line move breaks in
 * a USER's environment, run against the profiles this app boots.
 *
 *   profiles:audit   list every profile, its release-age exclusions, and which
 *                    of those are stale (no longer in its lockfile)
 *   profiles:prune   drop the stale ones, ASCII- and byte-preserving, with a
 *                    `.bak-before-prune-<YYYYMMDD>` copy beside the file
 *   profiles:peers   report which profile plugins the followed kernel line can
 *                    still admit, and print the exact follow-up command
 *
 * Why a script at all: both jobs are the same every time and neither is a
 * judgement call. What is NOT automated is the one decision that belongs to the
 * operator — accepting an incompatible third-party plugin with an exact-version
 * exemption. This script PRINTS that command and never runs it.
 *
 * The measured facts behind the two halves (both recorded in the repo):
 *
 *   - pnpm's release-age policy is checked against the LOCKFILE before EVERY
 *     command, and it IGNORES `minimumReleaseAgeExclude` entirely — so a profile
 *     whose lockfile pins a version inside the window is blocked for the rest of
 *     the window no matter what the exclusion list says
 *     (`plugins/plugin-market/src/release-age.ts`, measured on pnpm 11.7.0).
 *     The list still governs the RESOLUTION path, which is why pruning it stays
 *     worthwhile instead of deleting the key.
 *   - a plugin whose `peerDependencies` cap out below the followed line is
 *     REFUSED at boot on 0.2.0+ (`dsh: skipping profile bundle "…"`), where the
 *     older lines only warned.
 *
 * The one thing this script must never be talked into: disabling the policy
 * itself. `minimumReleaseAge: 0` removes the 24 h buffer that keeps a
 * freshly-published broken or malicious version out of the dependency graph; the
 * audit reports it if it finds it and never writes it.
 *
 * @module dsh-app/scripts/profile-supply-chain
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { followedSpec } from './kernel-line.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** The exclusion key, as pnpm spells it. */
const EXCLUDE_KEY = 'minimumReleaseAgeExclude'
/** The policy key whose value must never be touched by this tool. */
const POLICY_KEY = 'minimumReleaseAge'

/**
 * Parse the CLI's arguments.
 * @param {readonly string[]} argv - process.argv.slice(2).
 * @returns {{command: string, home: string, profiles: string[], check: boolean, json: boolean, kernel: string | undefined}}
 */
function parseArgs(argv) {
  const parsed = { command: 'audit', home: '', profiles: [], check: false, json: false, kernel: undefined }
  const rest = [...argv]
  parsed.command = rest.shift() ?? 'audit'
  while (rest.length > 0) {
    const flag = rest.shift()
    switch (flag) {
      case '--home': parsed.home = rest.shift() ?? ''; break
      case '--profile': {
        const name = rest.shift()
        if (name !== undefined) parsed.profiles.push(name)
        break
      }
      case '--kernel': parsed.kernel = rest.shift(); break
      case '--check': parsed.check = true; break
      case '--json': parsed.json = true; break
      default: throw new Error(`unknown argument: ${String(flag)}`)
    }
  }
  if (!['audit', 'prune', 'peers'].includes(parsed.command)) {
    throw new Error(`unknown command "${parsed.command}" (audit | prune | peers)`)
  }
  return parsed
}

/**
 * The harness home: `--home`, else `$DSH_HOME`, else `~/.dsh` — the same order
 * the kernel itself uses.
 * @param {string} explicit - the `--home` value ('' when absent).
 * @returns {string} an absolute path.
 */
function resolveHome(explicit) {
  if (explicit !== '') return path.resolve(explicit)
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  if (fromEnv !== '') return path.resolve(fromEnv)
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home === '') throw new Error('cannot locate the harness home: pass --home <dir>')
  return path.join(home, '.dsh')
}

/**
 * Every profile under a home, in a stable order.
 *
 * A profile is a directory holding a manifest; the tool looks at all of them
 * rather than at a hard-coded list, because the set differs per machine (this one
 * carries `web`, `dsh-app`, `headless`, …).
 *
 * @param {string} home - the harness home.
 * @param {readonly string[]} only - names to restrict to (empty = all).
 * @returns {string[]} profile directory names.
 */
function listProfiles(home, only) {
  const dir = path.join(home, 'profiles')
  if (!existsSync(dir)) return []
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort()
  return only.length === 0 ? names : names.filter((name) => only.includes(name))
}

/**
 * The exclusion entries of a profile's `pnpm-workspace.yaml`, with the line index
 * of each so a prune can delete exactly that line and nothing else.
 *
 * Deliberately line-oriented, not a YAML round-trip: the file belongs to the
 * package manager and to the user, and re-serializing it would rewrite comments,
 * quoting and key order that nobody asked us to touch. This is the same
 * discipline `plugins/plugin-market/src/workspace-list.ts` applies on the write
 * side — the target key is the only thing that changes.
 *
 * @param {string} text - the file's contents.
 * @returns {{policyValue: string | undefined, entries: {text: string, value: string, line: number}[]}}
 *   the policy's raw value when it is set, and each exclusion entry with its
 *   unquoted value.
 */
function readExclusions(text) {
  const lines = text.split('\n')
  let policyValue
  const entries = []
  let inList = false
  let listIndent = -1
  for (const [index, line] of lines.entries()) {
    const policy = /^minimumReleaseAge:\s*(.*?)\s*$/u.exec(line)
    if (policy !== null) {
      policyValue = policy[1] ?? ''
      continue
    }
    const key = new RegExp(`^(\\s*)${EXCLUDE_KEY}:\\s*(.*)$`, 'u').exec(line)
    if (key !== null) {
      inList = true
      listIndent = (key[1] ?? '').length
      continue
    }
    if (!inList) continue
    // The list ends at the first line that is not an item of it and not blank.
    const item = /^(\s*)-\s*(.*?)\s*$/u.exec(line)
    if (item === null) {
      if (line.trim() !== '') inList = false
      continue
    }
    if ((item[1] ?? '').length < listIndent) {
      inList = false
      continue
    }
    const raw = item[2] ?? ''
    const value = raw.replace(/^(['"])(.*)\1$/u, '$2')
    entries.push({ text: raw, value, line: index })
  }
  return { policyValue, entries }
}

/**
 * Whether a lockfile still pins an exclusion entry.
 *
 * The match is the entry text itself, as the maintenance procedure prescribes.
 * An entry that is not version-qualified cannot be judged this way and is
 * reported as `unresolved` instead of being pruned — removing a line on a guess
 * is the one direction this tool refuses to take.
 *
 * @param {string} lockfileText - the profile's lockfile ('' when absent).
 * @param {string} value - the entry's unquoted value.
 * @returns {'live' | 'stale' | 'unresolved'} the verdict.
 */
function classify(lockfileText, value) {
  if (lockfileText === '') return 'unresolved'
  if (!value.includes('@', 1)) return 'unresolved'
  return lockfileText.includes(value) ? 'live' : 'stale'
}

/**
 * Inspect one profile.
 * @param {string} home - the harness home.
 * @param {string} name - the profile's directory name.
 * @returns {{name: string, dir: string, workspacePath: string, lockfilePath: string, policy: string | undefined, entries: {text: string, value: string, line: number, verdict: string}[], exists: {workspace: boolean, lockfile: boolean}}}
 */
function inspectProfile(home, name) {
  const dir = path.join(home, 'profiles', name)
  const workspacePath = path.join(dir, 'pnpm-workspace.yaml')
  const lockfilePath = path.join(dir, 'pnpm-lock.yaml')
  const workspace = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : ''
  const lockfile = existsSync(lockfilePath) ? readFileSync(lockfilePath, 'utf8') : ''
  const { policyValue, entries } = readExclusions(workspace)
  return {
    name,
    dir,
    workspacePath,
    lockfilePath,
    policy: policyValue,
    exists: { workspace: workspace !== '', lockfile: lockfile !== '' },
    entries: entries.map((entry) => ({ ...entry, verdict: classify(lockfile, entry.value) })),
  }
}

/** Print one report line for every profile. */
function report(profiles) {
  for (const profile of profiles) {
    const stale = profile.entries.filter((entry) => entry.verdict === 'stale')
    const unresolved = profile.entries.filter((entry) => entry.verdict === 'unresolved')
    console.log(`\n${profile.name}  (${profile.dir})`)
    if (!profile.exists.workspace) {
      console.log('  no pnpm-workspace.yaml — nothing to audit')
      continue
    }
    if (!profile.exists.lockfile) {
      console.log('  no pnpm-lock.yaml — every entry is UNRESOLVED (nothing can be judged, nothing will be pruned)')
    }
    console.log(`  exclusions: ${String(profile.entries.length)}  live: ${String(profile.entries.length - stale.length - unresolved.length)}  stale: ${String(stale.length)}  unresolved: ${String(unresolved.length)}`)
    for (const entry of profile.entries) {
      if (entry.verdict === 'live') continue
      console.log(`    ${entry.verdict === 'stale' ? '- ' : '? '}${entry.value}`)
    }
    if (profile.policy !== undefined) {
      const disabled = /^(?:0|false|'0'|"0"|'false'|"false")$/u.test(profile.policy)
      console.log(disabled
        ? `  !! minimumReleaseAge is DISABLED here (${profile.policy}) — the 24 h buffer that keeps a freshly-published broken or malicious version out of the graph is gone. This tool never writes that key; restore the policy by hand.`
        : `  note: minimumReleaseAge is set to ${profile.policy} (this tool never touches that key)`)
    }
  }
}

/**
 * Drop the stale entries from one profile's `pnpm-workspace.yaml`.
 *
 * Bytes in, bytes out: the file is read and written as UTF-8 with its own line
 * endings and every untouched line identical, the backup is taken before the
 * first write, and a second run finds nothing to do. A profile with no lockfile
 * is left alone (nothing can be proven stale).
 *
 * @param {{name: string, workspacePath: string, entries: {text: string, value: string, line: number, verdict: string}[], exists: {lockfile: boolean}}} profile - one profile's inspection.
 * @returns {{removed: string[], backup: string | undefined}} what happened.
 */
function pruneProfile(profile) {
  if (!profile.exists.lockfile) return { removed: [], backup: undefined }
  const stale = new Set(profile.entries.filter((entry) => entry.verdict === 'stale').map((entry) => entry.line))
  if (stale.size === 0) return { removed: [], backup: undefined }
  const original = readFileSync(profile.workspacePath, 'utf8')
  const kept = original.split('\n').filter((_line, index) => !stale.has(index))
  const next = kept.join('\n')
  if (next === original) return { removed: [], backup: undefined }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/gu, '')
  const backup = `${profile.workspacePath}.bak-before-prune-${stamp}`
  writeFileSync(backup, original, 'utf8')
  writeFileSync(profile.workspacePath, next, 'utf8')
  return {
    removed: profile.entries.filter((entry) => stale.has(entry.line)).map((entry) => entry.value),
    backup,
  }
}

/**
 * The registry base: the environment's own mirror wins, so a machine behind
 * `registry.npmmirror.com` is read through it.
 * @returns {string} a base URL without a trailing slash.
 */
function registryBase() {
  const fromEnv = (process.env.DSH_APP_REGISTRY ?? process.env.npm_config_registry ?? '').trim()
  return (fromEnv === '' ? 'https://registry.npmjs.org' : fromEnv).replace(/\/+$/u, '')
}

/**
 * One package's latest version and its declared peers, straight from the registry.
 *
 * The registry's HTTP API, not `npm view`: on Windows npm is a `.cmd` shim that
 * Node refuses to spawn without a shell, and the first version of this tool
 * reported every third-party plugin as "unknown" because of exactly that.
 * `application/vnd.npm.install-v1+json` is npm's abbreviated metadata — a
 * fraction of the bytes, and it still carries `peerDependencies`.
 *
 * @param {string} pkg - the package name.
 * @param {string} [registry] - the registry base (defaults to {@link registryBase}).
 * @returns {Promise<{version: string, peers: Record<string, string>}>} the latest version and its peers.
 */
async function fetchPeers(pkg, registry = registryBase()) {
  const response = await fetch(`${registry}/${pkg.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const meta = await response.json()
  const latest = meta['dist-tags']?.latest
  if (typeof latest !== 'string') throw new Error('the registry lists no dist-tags.latest')
  return { version: latest, peers: meta.versions?.[latest]?.peerDependencies ?? {} }
}

/**
 * Whether a third-party plugin's published latest version admits a kernel version.
 *
 * `npm view <pkg>@latest peerDependencies` is the procedure's own check; semver's
 * `satisfies` decides it, with prereleases included because a followed kernel line
 * IS a prerelease for most of its life (and `^0.2.0-rc.1` must admit `0.2.0-rc.2`).
 *
 * @param {string} pkg - the package name.
 * @param {readonly string[]} kernelPeers - the kernel packages to test.
 * @param {string} kernelVersion - the followed line's version.
 * @param {typeof fetchPeers} fetchImpl - injectable for tests.
 * @returns {Promise<{latest: string | undefined, peer: string | undefined, verdict: 'compatible' | 'incompatible' | 'unknown'}>} the verdict.
 */
async function peerVerdict(pkg, kernelPeers, kernelVersion, fetchImpl = fetchPeers) {
  let latest
  let peers
  try {
    const result = await fetchImpl(pkg)
    latest = result.version
    peers = result.peers
  } catch {
    return { latest: undefined, peer: undefined, verdict: 'unknown' }
  }
  const declared = kernelPeers.map((name) => peers?.[name]).filter((range) => typeof range === 'string')
  if (declared.length === 0) return { latest, peer: undefined, verdict: 'compatible' }
  const satisfied = declared.every((range) => semver.satisfies(kernelVersion, range, { includePrerelease: true }))
  return { latest, peer: declared.join(' || '), verdict: satisfied ? 'compatible' : 'incompatible' }
}

/** The profile's declared dependencies, newest-first by name. */
function declaredDependencies(profileDir) {
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  return Object.entries(manifest.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))
}

/** `peers`: which plugins still admit the followed line, and what to do about the rest. */
async function reportPeers(profiles, kernelVersion) {
  const kernelPeers = ['@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh']
  let refused = 0
  for (const profile of profiles) {
    console.log(`\n${profile.name}  (${profile.dir})`)
    const deps = declaredDependencies(profile.dir)
    if (deps.length === 0) console.log('  declares no dependencies')
    for (const [name] of deps) {
      if (name.startsWith('@deepseek-ai/dsh')) {
        console.log(`  official  ${name} — the line's own set: \`dsh plugin --profile ${profile.name} update ${name}\` if the kernel reports it skipped`)
        continue
      }
      const { latest, peer, verdict } = await peerVerdict(name, kernelPeers, kernelVersion)
      if (verdict === 'compatible') {
        console.log(`  ok        ${name}${latest === undefined ? '' : ` (latest ${latest})`}${peer === undefined ? '' : `  peers: ${peer}`}`)
        continue
      }
      if (verdict === 'unknown') {
        console.log(`  unknown   ${name} — the registry did not answer (a local tarball or git spec has no registry entry to read); check by hand: npm view ${name}@latest peerDependencies`)
        continue
      }
      refused += 1
      console.log(`  REFUSED   ${name} (latest ${latest ?? '?'}) — its peers cap below ${kernelVersion}: ${peer ?? '(none declared)'}`)
      console.log(`            update it when the author publishes, or accept the risk explicitly:`)
      console.log(`            dsh plugin --profile ${profile.name} allow-version ${name}@<installed-version> --dsh-version ${kernelVersion} --accept-risk`)
      console.log(`            (revoke later with: dsh plugin --profile ${profile.name} revoke-version ${name}@<version> --dsh-version ${kernelVersion})`)
    }
  }
  return refused
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'peers') {
    const home = resolveHome(args.home)
    const kernel = args.kernel ?? followedSpec().replace(/^\^/u, '')
    console.log(`followed line: ${kernel}   home: ${home}   registry: ${registryBase()}`)
    const profiles = listProfiles(home, args.profiles).map((name) => inspectProfile(home, name))
    const refused = await reportPeers(profiles, kernel)
    process.exitCode = args.check && refused > 0 ? 1 : 0
    return
  }

  const home = resolveHome(args.home)
  const names = listProfiles(home, args.profiles)
  if (names.length === 0) {
    console.error(`no profiles with a package.json under ${path.join(home, 'profiles')}`)
    process.exitCode = 2
    return
  }
  let profiles = names.map((name) => inspectProfile(home, name))
  if (args.json) console.log(JSON.stringify(profiles, undefined, 2))
  console.log(`home: ${home}`)
  report(profiles)

  if (args.command === 'prune') {
    for (const profile of profiles) {
      const { removed, backup } = pruneProfile(profile)
      if (removed.length === 0) {
        console.log(`\n${profile.name}: nothing to prune`)
        continue
      }
      console.log(`\n${profile.name}: pruned ${String(removed.length)} stale exclusion(s): ${removed.join(', ')}`)
      console.log(`  backup: ${backup ?? '(none)'}`)
    }
    profiles = names.map((name) => inspectProfile(home, name))
    console.log('\nafter prune:')
    report(profiles)
  }

  for (const profile of profiles) {
    const disabled = profile.policy !== undefined && /^(?:0|false|'0'|"0"|'false'|"false")$/u.test(profile.policy)
    if (disabled) process.exitCode = args.check ? 1 : 0
    if (args.check) {
      const stale = profile.entries.filter((entry) => entry.verdict === 'stale').length
      if (stale > 0) {
        console.error(`check: ${profile.name} has ${String(stale)} stale exclusion(s); run: npm run profiles:prune`)
        process.exitCode = 1
      }
    }
  }
  if (args.command === 'audit') {
    console.log('\nnext: `npm run profiles:prune` to drop the stale lines (backup kept), then in each profile:')
    console.log('      pnpm install --lockfile-only --ignore-scripts   (expect "Lockfile passes supply-chain policies")')
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`profile-supply-chain: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

export { readExclusions, classify, pruneProfile, inspectProfile, listProfiles, resolveHome, peerVerdict, registryBase, ROOT }
