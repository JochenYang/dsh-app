#!/usr/bin/env node
/**
 * Builds a dsh kernel runtime artifact (CI + local).
 *
 * Usage:
 *   node scripts/build-runtime.mjs <platform> <arch> [version]
 *
 * Example:
 *   node scripts/build-runtime.mjs win32 x64
 *   node scripts/build-runtime.mjs win32 x64 0.1.5-rc.1
 *
 * Without a version, the dist-tag to resolve from is derived from the
 * @deepseek-ai/dsh* dependency in package.json (scripts/kernel-line.mjs).
 * Whichever version is finally used — resolved or explicit — is asserted to
 * satisfy that same spec, so a build can never bundle a kernel from a line the
 * shell and plugins were not built against. DSH_APP_CHANNEL overrides the
 * derivation for a deliberate cross-line build.
 *
 * Produces, under runtime-dist/:
 *   runtime/manifest.json
 *   runtime/node/            — the Node.js binary (downloaded, sha256-verified)
 *   runtime/app/             — pnpm-assembled dsh profile (package.json +
 *                              node_modules + runtime-files.json inventory)
 *   dsh-runtime-<platform>-<arch>-<version>.tgz
 *   dsh-runtime-<platform>-<arch>-<version>.tgz.sha512
 *   runtime-files-<platform>-<arch>.json — release-time copy of the inventory
 *
 * The suite plugins (@dsh-app/plugin-*) join the runtime as tarballs produced
 * by `npm pack`, referenced through file: specs that `overrides` also point at,
 * so no @dsh-app package can resolve from the registry; switch them to registry
 * versions once they are published.
 *
 * Assembly is pnpm ≥ 10 with the hoisted linker (see "pnpm assembly" above
 * main()): a lockfile is generated first and asserted to hold no
 * registry-resolved core package, then installed from that frozen lockfile.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { c as createTar, t as listTar, x as extractTar } from 'tar'
import {
  assertFollowedVersion,
  assertValidVersion,
  channelFromVersion,
  computeSuiteVersion,
  followedSpec,
  resolveFollowChannel,
  resolveDistTagVersion,
  SUITE_PLUGINS,
  distTagFor,
} from './kernel-line.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [platform = process.platform, arch = process.arch, versionArg] = process.argv.slice(2)

/**
 * When no version is given (plain tag push or workflow_dispatch), publish the
 * dsh version the tree itself follows: the dist-tag is derived from the
 * @deepseek-ai/dsh* dependency in package.json, which is also the line the
 * shell and every plugin are typechecked against. Keeping that mapping here
 * (rather than in a hand-flipped workflow variable) is what stops a release
 * from bundling a kernel the code was never built against.
 *
 * DSH_APP_CHANNEL, when set, is a deliberate cross-line override and skips the
 * spec assertion below — it exists for one-off builds, not for routine
 * releases; the default path is always asserted.
 */
async function resolveDefaultDshVersion(channelOverride) {
  const channel = channelOverride ?? resolveFollowChannel()
  let tag
  if (channel === 'alpha') tag = 'alpha'
  else if (channel === 'beta') tag = distTagFor('beta')
  else tag = distTagFor('stable')
  try {
    return await resolveDistTagVersion(tag)
  } catch (err) {
    console.error(`[build-runtime] dist-tag resolution failed: ${err.message}`)
    // CI must never silently rebuild an OLD version and --clobber its tag
    // with content built from current code — that is exactly the drift this
    // resolution was introduced to kill. Fail loudly; the job can be re-run
    // once the registry is reachable again.
    throw new Error('cannot resolve dsh version from npm dist-tag — set DSH_VERSION explicitly or fix registry access')
  }
}

const CHANNEL_OVERRIDE = process.env.DSH_APP_CHANNEL?.trim() || undefined
const REQUESTED_VERSION = versionArg?.trim() || process.env.DSH_VERSION?.trim()
const DSH_VERSION = REQUESTED_VERSION || (await resolveDefaultDshVersion(CHANNEL_OVERRIDE))

if (CHANNEL_OVERRIDE === undefined) {
  // The default path (and any explicitly pinned dsh_version) must land on the
  // line the tree follows. This is the assertion whose absence let v0.11.1
  // ship a 0.1.5-alpha.2 kernel beside ^0.1.5-rc.1 code with CI fully green.
  assertFollowedVersion(DSH_VERSION)
} else {
  assertValidVersion(DSH_VERSION)
  console.warn(
    `[build-runtime] DSH_APP_CHANNEL=${CHANNEL_OVERRIDE} overrides the followed line (${followedSpec()}); `
    + `bundling ${DSH_VERSION} on purpose`,
  )
}

// Publish the resolved version to GitHub Actions outputs so the release job
// can name its release tag (runtime-<dshVersion>). No-op outside CI.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `dsh_version=${DSH_VERSION}\n`)
}

// The artifact's channel LABEL describes the version actually built, never the
// line the repo happens to follow: a workflow_dispatch build of an explicitly
// pinned alpha version is labelled alpha even while the tree sits on rc.
const CHANNEL = channelFromVersion(DSH_VERSION)

/**
 * FFF native binding version, derived from the plugin that declares it: the
 * runtime's app/package.json must carry the binding itself, because build-lib's
 * external filters keep `@ff-labs/*` out of the plugin bundle (fff-node loads a
 * native library at runtime) and a hoisted top-level copy is what its require
 * resolves. Reading the plugin's own pin keeps the two in lockstep.
 */
const FFF_NODE_PIN = JSON.parse(readFileSync(path.join(root, 'plugins', '@dsh-app/plugin-fff'.replace('@dsh-app/', ''), 'package.json'), 'utf8')).dependencies['@ff-labs/fff-node']

// The plugin roster and the suite version it hashes to both come from
// scripts/kernel-line.mjs — the same module the release workflow reads to
// decide whether a published runtime can be reused, so the two can never
// disagree about what "the current suite" is.
const SUITE_VERSION = computeSuiteVersion()

/**
 * Fallback runtime RESOURCES for a plugin that declares no `files` field. Source,
 * tests, scripts and node_modules are deliberately absent: they must never reach
 * the artifact (size and supply-chain surface).
 */
const RUNTIME_RESOURCE_FALLBACK = ['lib', 'templates', 'assets', 'cordis.patch.yml', 'README.md']

/** Top-level entries that must never reach the runtime, even if `files` lists them. */
const RUNTIME_RESOURCE_DENYLIST = new Set(['src', 'test', 'tests', 'scripts', 'node_modules', '.git', '.test-dist'])

/**
 * Top-level runtime resources one plugin declares. Its own `files` field is the
 * source of truth: that is npm's publish contract, `npm pack` consumes exactly
 * the same list, and it already names every resource the plugin needs
 * (`templates/`, `assets/`, `cordis.patch.yml`). READING it — instead of keeping
 * a second, hand-written list — is what makes a newly added asset directory ship
 * without anyone remembering to update this script; the old hand-written list is
 * what dropped plugin-ppt/templates/ and plugin-pdf/assets/ while every route
 * still answered `ok:true`. A plugin that declares no `files` falls back to
 * RUNTIME_RESOURCE_FALLBACK.
 *
 * A declared entry that must never ship is a hard FAILURE, not a silent strip:
 * packaging is `npm pack`, which has no filter hook, and the same entry would
 * ship from `npm publish` too. `scripts/check-plugin-graph.mjs` guards the
 * `node_modules` half of this at graph level; this catches the rest at pack time.
 *
 * Only the FIRST path segment of an entry counts: a nested `lib/dist` still ships
 * the whole `lib/` tree, which is what relative imports need.
 * @param shortName - plugin directory name, for the error message.
 * @param pkg - the parsed plugin package.json.
 * @returns top-level entry names expected inside the packed tarball.
 */
function declaredResourceEntries(shortName, pkg) {
  const declared = Array.isArray(pkg.files)
    ? pkg.files.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : []
  const names = declared.length > 0
    ? declared.map((entry) => entry.trim().replace(/^\.\//u, '').replace(/\/+$/u, '').split('/')[0])
    : RUNTIME_RESOURCE_FALLBACK
  const entries = [...new Set(names)].filter((entry) => entry !== '')
  for (const entry of entries) {
    if (RUNTIME_RESOURCE_DENYLIST.has(entry)) {
      throw new Error(
        `plugin ${shortName}: files[] declares "${entry}", which must never ship in the runtime —`
        + ' remove it from the plugin package.json (npm publish would ship it too)',
      )
    }
  }
  return entries
}

/** Human-readable byte size for the build log. */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${String(bytes)} B`
}

function quoteWinArg(value) {
  return `"${value.replace(/"/g, '\\"')}"`
}

/**
 * npm executable for child processes. On Windows this must be absolute
 * (beside the running node): a bare `npm.cmd` lets cmd.exe prefer a
 * same-named shim under the cwd (see run()), and the same hijack applies
 * to direct execFileSync calls — a missing-module failure pointing inside
 * the cwd's node_modules is the tell.
 */
function npmBin() {
  return process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'npm.cmd') : 'npm'
}

/** First PATH entry holding one of `names`, or undefined. */
function findOnPath(names) {
  const pathValue = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * pnpm executable for child processes. Windows shares npmBin()'s hijack hazard —
 * a bare `pnpm.cmd` lets cmd.exe prefer a same-named shim under the cwd — but
 * pnpm is a global install and does not sit beside the running node, so it is
 * resolved through PATH instead.
 */
function pnpmBin() {
  if (process.platform !== 'win32') return 'pnpm'
  const found = findOnPath(['pnpm.cmd', 'pnpm.exe', 'pnpm.bat'])
  if (found === undefined) {
    throw new Error('pnpm not found on PATH — the runtime is assembled with pnpm >= 10 (npm i -g pnpm)')
  }
  return found
}

/**
 * Fail before anything is downloaded when pnpm is absent or too old. The
 * settings this script writes into pnpm-workspace.yaml (nodeLinker,
 * autoInstallPeers, the build-script allowlist) only mean what they say from
 * pnpm 10 on: an older pnpm would assemble a different tree — silently, which is
 * the failure mode this whole assembly exists to remove.
 * @returns the parsed pnpm version.
 */
function assertPnpm() {
  const version = capture(pnpmBin(), ['--version']).trim()
  const major = Number.parseInt(/(\d+)\./u.exec(version)?.[1] ?? '', 10)
  if (!Number.isFinite(major) || major < 10) {
    throw new Error(`pnpm ${version} is too old: the runtime assembly requires pnpm >= 10 (npm i -g pnpm@latest)`)
  }
  return { version, major }
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const opts = { cwd, stdio: 'inherit', env: childEnv() }
  // Windows runners: Node 22.12+ no longer wraps .cmd via cmd.exe implicitly
  // (CVE-2024-27980 mitigation), so shell is required; pass one joined line
  // instead of args to avoid DEP0190. Every token is strictly quoted so paths
  // with spaces (e.g. under Program Files) cannot split or inject.
  // npm/pnpm are resolved to absolute paths up front (npmBin/pnpmBin): a bare
  // `npm.cmd` lets cmd.exe prefer a same-named file under the cwd (a plugin dir
  // whose node_modules happens to ship npm shims), running the wrong cli.js and
  // failing with a missing-module error.
  if (process.platform === 'win32') {
    execFileSync([cmd, ...args].map(quoteWinArg).join(' '), { ...opts, shell: true })
  } else execFileSync(cmd, args, opts)
}

/** Capture a child process's stdout with the same Windows quoting rule as run(). */
function capture(cmd, args, cwd) {
  const opts = { cwd, encoding: 'utf8', env: childEnv() }
  if (process.platform === 'win32') {
    return execFileSync([cmd, ...args].map(quoteWinArg).join(' '), { ...opts, shell: true })
  }
  return execFileSync(cmd, args, opts)
}

/**
 * Environment for package-manager children. `npm run` serialises the caller's
 * npmrc (including its allow-scripts policy) into npm_config_* environment
 * variables, and npm ≥11 rejects an allow-scripts policy that arrives through
 * the environment for a project-scoped install (EALLOWSCRIPTS). The artifact
 * install owns its policy (package.json allowScripts / onlyBuiltDependencies),
 * so drop the inherited keys.
 */
function childEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^npm_config_(strict_)?allow_scripts/i.test(key) || /^npm_config_dangerously_allow_all_scripts/i.test(key)) delete env[key]
  }
  return env
}


// Map a (platform, arch) to the nodejs.org dist tuple. nodejs.org uses
// 'win'|'darwin'|'linux' and 'x64'|'arm64'; our caller already passes those.
const NODE_DIST_PLATFORM = { win32: 'win', darwin: 'darwin', linux: 'linux' }
const NODE_DIST_EXT = { win32: 'zip', darwin: 'tar.gz', linux: 'tar.xz' }
// Official Node.js distribution host. SHASUMS256.txt metadata is always fetched
// here first so a NODE_DIST_MIRROR can never substitute content; the mirror
// only fills in when the official host is unreachable.
const OFFICIAL_NODE_DIST = 'https://nodejs.org/dist'

async function downloadNodeBinary(platform, arch, destDir) {
  const ver = process.version // e.g. v22.x — matches the runtime's own major
  const distPlatform = NODE_DIST_PLATFORM[platform]
  if (!distPlatform) throw new Error(`unsupported platform for node download: ${platform}`)
  const ext = NODE_DIST_EXT[platform]
  const base = process.env.NODE_DIST_MIRROR?.replace(/\/$/, '') || OFFICIAL_NODE_DIST
  const archiveName = `node-${ver}-${distPlatform}-${arch}`
  const url = `${base}/${ver}/${archiveName}.${ext}`
  const archivePath = path.join(destDir, `node-archive.${ext}`)
  console.log(`$ download ${url}`)
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok) throw new Error(`node dist download failed (${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // Verify the archive against the official SHASUMS256.txt before extracting,
  // so a dist mirror can never substitute bytes. Metadata is fetched from the
  // official host first (mirrors only fill in when the official host is
  // unreachable); every candidate is checked against the same digest.
  // Both fetches are bounded: without a timeout a stalled connection hangs the
  // CI cell until the runner's 6 h default, which reads as a stuck release.
  const sumsName = `${archiveName}.${ext}`
  const sumsBases = base === OFFICIAL_NODE_DIST ? [base] : [OFFICIAL_NODE_DIST, base]
  let sumsText = ''
  let sumsFrom = ''
  for (const sumsBase of sumsBases) {
    const sumsUrl = `${sumsBase}/${ver}/SHASUMS256.txt`
    try {
      const sumsRes = await fetch(sumsUrl, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (sumsRes.ok) { sumsText = await sumsRes.text(); sumsFrom = sumsUrl; break }
      console.log(`$ node SHASUMS256.txt ${sumsRes.status}: ${sumsUrl}`)
    } catch (err) {
      console.log(`$ node SHASUMS256.txt ERR: ${sumsUrl} (${err.message})`)
    }
  }
  if (sumsText === '') throw new Error(`node SHASUMS256.txt unreachable for ${ver}`)
  const want = sumsText.split('\n').map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === sumsName)?.[0]?.toLowerCase()
  if (want === undefined) throw new Error(`archive ${sumsName} missing from ${sumsFrom}`)
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== want) throw new Error(`node dist sha256 mismatch for ${sumsName}: expected ${want}, got ${got}`)
  console.log(`$ verified ${sumsName} sha256 against ${sumsFrom}`)
  await writeFile(archivePath, buf)
  // Extract to a temp dir then move just the node binary into destDir.
  // Windows: MSYS tar mangles drive-letter paths and bsdtar-on-win is flaky
  // for zip, so use PowerShell Expand-Archive via cmd. mac/linux: system tar
  // auto-detects gz/xz.
  const extractDir = path.join(destDir, 'extract')
  await rm(extractDir, { recursive: true, force: true })
  await mkdir(extractDir, { recursive: true })
  if (platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force`], { stdio: 'inherit' })
  } else {
    execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' })
  }
  const nodeBin = platform === 'win32' ? 'node.exe' : 'node'
  const src = path.join(extractDir, archiveName, 'bin', nodeBin)
  // Windows official zip ships node.exe at the archive root, not under bin/.
  const winSrc = path.join(extractDir, archiveName, nodeBin)
  const finalSrc = platform === 'win32' ? winSrc : src
  await rm(path.join(destDir, nodeBin), { force: true })
  await rename(finalSrc, path.join(destDir, nodeBin))
  if (platform !== 'win32') execFileSync('chmod', ['+x', path.join(destDir, nodeBin)])
  await rm(extractDir, { recursive: true, force: true })
  await rm(archivePath, { force: true })
  console.log(`node ${ver} ${distPlatform}-${arch} placed at ${path.join(destDir, nodeBin)}`)
}

// ---------------------------------------------------------------------------
// pnpm assembly (docs/desktop-optimization-plan.md §2.4)
// ---------------------------------------------------------------------------

/**
 * Native dependencies whose lifecycle scripts must run during the install.
 *
 * npm ≥11 blocks dependency build scripts unless the project allow-lists them,
 * and pnpm ≥10 does the same by default (it prints every skipped one). Both
 * policies are fed from this single list: `allowScripts` (npm-shaped, the field
 * the shipped app/package.json has always carried) and `onlyBuiltDependencies`
 * (pnpm-shaped, in the build-only pnpm-workspace.yaml). A new native dependency
 * fails the install with a named error until someone verifies what its scripts
 * do and adds it — which is why this is an explicit list, not "allow all".
 */
const NATIVE_BUILD_ALLOWLIST = [
  '@deepseek-ai/dsh-subprocess-local',
  'koffi',
  'node-pty',
  '@google/genai',
  'protobufjs',
  'bufferutil',
  'utf-8-validate',
]

/** Core package scopes: @dsh-app is our suite, @deepseek-ai/dsh* is the kernel. */
const SUITE_SCOPE = '@dsh-app/'
const KERNEL_PACKAGE = /^@deepseek-ai\/dsh(?:-|$)/u

/**
 * Pack one suite plugin with `npm pack`. The tarball holds exactly what
 * `npm publish` would ship, because the plugin's own `files` field is npm's
 * publish contract — the same source the previous hand-written copy loop read.
 * npm adds package.json and the `main` entry on top of `files`.
 *
 * @param shortName - plugin directory name (plugin-ppt), not the package name.
 * @param destDir - directory the tarball lands in (the pnpm project's pkgs/).
 * @returns the file: spec to reference it by, relative to the pnpm project.
 */
async function packPlugin(shortName, destDir) {
  const srcDir = path.join(root, 'plugins', shortName)
  const pkg = JSON.parse(readFileSync(path.join(srcDir, 'package.json'), 'utf8'))
  const expectedResources = declaredResourceEntries(shortName, pkg)
  run(npmBin(), ['pack', '--pack-destination', destDir, '--silent'], srcDir)
  // npm names a tarball after the package: @dsh-app/plugin-ppt -> dsh-app-plugin-ppt-<version>.tgz
  const file = `${pkg.name.replace(/^@/u, '').replace(/\//gu, '-')}-${pkg.version}.tgz`
  const tarball = path.join(destDir, file)
  if (!existsSync(tarball)) {
    throw new Error(`npm pack produced no tarball for ${pkg.name} in ${destDir} (expected ${file})`)
  }
  const entries = await tarEntries(tarball)
  // A declared resource missing from the tarball is npm's "absent entry" case:
  // npm omits it silently and the plugin ships incomplete. Warn (do not fail —
  // smoke-suite.mjs is what turns a missing runtime resource into a red build),
  // so the gap is visible in the build log rather than only in the artifact.
  for (const entry of expectedResources) {
    if (!entries.some((name) => name === `package/${entry}` || name.startsWith(`package/${entry}/`))) {
      console.warn(`[build-runtime] plugin ${shortName}: declared resource "${entry}" is absent from the packed tarball — not shipped`)
    }
  }
  const dropped = await stripShippedDependencies(tarball, pkg, entries)
  console.log(
    `[build-runtime] packed ${shortName}: ${entries.length} files, ${formatBytes(statSync(tarball).size)}`
    + ` -> ${file}${dropped.length > 0 ? ` (shipped package.json drops dependencies: ${dropped.join(', ')})` : ''}`,
  )
  return `file:pkgs/${file}`
}

/**
 * Rewrite the packed copy of a plugin without its `dependencies` field.
 *
 * The runtime never installs a plugin's production dependencies and must not:
 * `plugins/build-lib.mjs` inlines everything a plugin requires except the
 * framework imports and each plugin's declared extras (today only `@ff-labs/*`,
 * which the runtime carries as its own top-level dependency so the native
 * binding resolves from app/node_modules). Left in place, the field makes pnpm
 * unpack all of it a second time — measured at 76 MiB of duplicates (exceljs 23,
 * pdf-lib 21, docx 7, pptxgenjs 6, unpdf 3 plus their closure) for code already
 * inside lib/index.js, and the previous hand-copy never installed any of it.
 *
 * Only the SHIPPED package.json loses the field — the repo copy keeps it, since
 * that is what `npm publish` and the plugin's own installs need. `files` and the
 * payload are untouched: the tarball still holds exactly what npm pack selected,
 * in the same entry order (repacking with `entries` keeps the archive shape
 * identical too), with the same reproducibility options as the runtime archive —
 * portable headers, pinned mtime.
 * @param tarball - tarball produced by `npm pack`, replaced in place.
 * @param pkg - the plugin's repo package.json.
 * @param entries - entry names of the original tarball, reused as the file list.
 * @returns the dependency names that were dropped, sorted.
 */
async function stripShippedDependencies(tarball, pkg, entries) {
  const declared = Object.keys(pkg.dependencies ?? {})
  if (declared.length === 0) return []
  const staging = `${tarball}.staging`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await extractTar({ file: tarball, cwd: staging })
    const manifestPath = path.join(staging, 'package', 'package.json')
    const shipped = JSON.parse(await readFile(manifestPath, 'utf8'))
    const removed = Object.keys(shipped.dependencies ?? {}).sort()
    delete shipped.dependencies
    await writeFile(manifestPath, `${JSON.stringify(shipped, null, 2)}\n`)
    await rm(tarball, { force: true })
    await createTar({ gzip: true, file: tarball, cwd: staging, portable: true, mtime: new Date(0) }, entries)
    return removed
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Every entry name inside a tarball, in archive order.
 * @param file - path of the tarball to list.
 */
function tarEntries(file) {
  const names = []
  return listTar({ file, onentry: (entry) => names.push(entry.path) }).then(() => names)
}

/**
 * Assert that the generated lockfile resolved the CORE packages the artifact
 * requires. This is the gate of the whole assembly, not a smoke check:
 *
 *   - every `@dsh-app/*` entry must come from a local `file:` tarball. One that
 *     resolved from the registry would silently substitute whatever the registry
 *     serves for a suite plugin the build just packed from this tree;
 *   - every `@deepseek-ai/dsh*` entry must be exactly DSH_VERSION. The kernel's
 *     own ranges are `^<line>`, so a newer patch on the same line would otherwise
 *     install a second copy of some packages and dsh's module identity would
 *     split (the dsh-llm double-instance failure §2.4 names).
 *
 * Reads the `packages:` section line by line — its shape is stable (two-space
 * indented `name@version:` keys) and this is cheaper than adding a YAML parser
 * to the build toolchain.
 * @param lockfileText - contents of the generated pnpm-lock.yaml.
 * @returns counts for the build log.
 */
function assertLockfileCore(lockfileText) {
  const entries = []
  let inPackages = false
  for (const line of lockfileText.split(/\r?\n/u)) {
    if (/^packages:\s*$/u.test(line)) { inPackages = true; continue }
    if (!inPackages) continue
    if (/^\S/u.test(line)) break // next top-level section (snapshots:)
    const raw = /^ {2}(\S.*?):\s*$/u.exec(line)?.[1]
    if (raw === undefined) continue
    // pnpm quotes every key that starts with `@` (all scoped packages): strip
    // the quoting, or every core package would look like an unknown name.
    const key = (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))
      ? raw.slice(1, -1)
      : raw
    const at = key.lastIndexOf('@')
    if (at <= 0) throw new Error(`unexpected package key in pnpm-lock.yaml: ${key}`)
    entries.push({ name: key.slice(0, at), version: key.slice(at + 1) })
  }
  if (entries.length === 0) throw new Error('pnpm-lock.yaml has no packages: section — the lockfile is not usable')

  const missing = new Set(SUITE_PLUGINS)
  for (const entry of entries) {
    if (entry.name.startsWith(SUITE_SCOPE)) {
      if (!entry.version.startsWith('file:')) {
        throw new Error(
          `lockfile resolved core suite package from the registry: ${entry.name}@${entry.version}`
          + ' — the file: override did not apply, refusing to assemble',
        )
      }
      missing.delete(entry.name)
    } else if (KERNEL_PACKAGE.test(entry.name) && entry.version !== DSH_VERSION) {
      throw new Error(
        `lockfile resolved ${entry.name}@${entry.version}, but this runtime ships dsh ${DSH_VERSION}`
        + ' — two kernel versions in one tree is the double-instance bug, refusing to assemble',
      )
    }
  }
  if (missing.size > 0) {
    throw new Error(`lockfile holds no @dsh-app entry for: ${[...missing].join(', ')} — the suite would ship incomplete`)
  }
  const registry = entries.filter((entry) => !entry.version.startsWith('file:')).length
  return { total: entries.length, registry, file: entries.length - registry }
}

/**
 * Per-file inventory of the assembled runtime: relative path, byte size, sha256
 * and the executable bit, sorted by path.
 *
 * It is written INSIDE the archive (runtime/app/runtime-files.json) so it travels
 * with every artifact the way the user receives it — through the release tarball
 * and through the kernel bundled into the installer — and so the layer splitter's
 * `vendor` layer carries it, keeping its re-assembly self-check exact. A second
 * copy lands next to the tarball for release-time audits that must not unpack
 * 100 MB.
 *
 * Content is a pure function of the tree (no timestamps), so two builds of one
 * version must produce identical inventories — the reproducibility check §2.4
 * asks for — and it records the exec bits a Windows build host cannot test.
 * @param runtimeDir - the runtime/ tree being packaged.
 * @returns the inventory object written.
 */
async function writeFileInventory(runtimeDir, manifest) {
  const self = path.join('app', 'runtime-files.json')
  const files = []
  async function walk(current, relative) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { await walk(full, next); continue }
      // A symlink (or junction) cannot travel inside the tarball as a working
      // reference: the artifact must be self-contained, so an unexpected one
      // fails the build instead of silently shipping a dangling entry.
      if (!entry.isFile()) throw new Error(`runtime tree holds a non-file entry: ${next} (is it a symlink?)`)
      if (next === self) continue
      const stats = await stat(full)
      // A shared inode becomes a tar hard-link entry, which GNU tar refuses to
      // extract when the target appears later in the stream (pnpm's default
      // store hardlinks do exactly that). The install copies instead; if a future
      // change brings links back, fail here rather than ship a tarball only
      // node-tar can read.
      if (stats.nlink > 1) {
        throw new Error(`runtime tree holds a hard-linked file: ${next} (nlink=${stats.nlink}) — the artifact must be independent files`)
      }
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(full)) hash.update(chunk)
      files.push({
        path: next,
        size: stats.size,
        // Git-style mode: the exec bit is the only permission that survives
        // packaging, and the kernel's node/node[.exe] must keep it.
        mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
        sha256: hash.digest('hex'),
      })
    }
  }
  await walk(runtimeDir, '')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const inventory = {
    dshVersion: manifest.dshVersion,
    suiteVersion: manifest.suiteVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    algorithm: 'sha256',
    fileCount: files.length,
    files,
  }
  await writeFile(path.join(runtimeDir, self), JSON.stringify(inventory, null, 2))
  return inventory
}

async function main() {
  const work = path.join(root, 'runtime-dist', 'work')
  const runtimeDir = path.join(work, 'runtime')
  await rm(work, { recursive: true, force: true })
  await mkdir(path.join(runtimeDir, 'node'), { recursive: true })
  await mkdir(path.join(runtimeDir, 'app'), { recursive: true })

  // 1. Node.js binary for the TARGET platform/arch (not the runner's own node).
  //    Copying process.execPath produced wrong-arch binaries when the runner
  //    (e.g. x64 windows-latest) built an arm64 runtime, so the kernel could
  //    not start on arm64 hosts. Download the official same-version archive.
  //    The pnpm prerequisite is checked first: a build host without a new
  //    enough pnpm must fail here, not after the download.
  const pnpm = assertPnpm()
  console.log(`[build-runtime] assembling with pnpm ${pnpm.version}`)
  await downloadNodeBinary(platform, arch, path.join(runtimeDir, 'node'))

  // 2. Assemble the dsh profile with pnpm.
  //
  //    The previous flow was two `npm install --omit=dev --legacy-peer-deps`
  //    passes plus a hand-written plugin copy. `--legacy-peer-deps` skips peer
  //    resolution entirely, so pass 2a had to scan node_modules for missing
  //    peers and add each one back as a direct dependency — resolving non-dsh
  //    peers to `npm view <name> version`, i.e. the registry's LATEST rather
  //    than the declared peer range. Neither pass was lockfile-checked, so two
  //    builds of one version could resolve different trees.
  //
  //    Now: pack every suite plugin (npm pack, its own `files` field), point
  //    `overrides` at those tarballs plus the exact dsh version, generate the
  //    lockfile, ASSERT that no core package resolved from the registry, and
  //    install from that frozen lockfile with the hoisted linker — a flat
  //    node_modules, the shape the kernel's bare requires and the layer
  //    splitter's `vendor`/`dsh`/`suite` scopes both expect.
  //
  //    Peer policy: npm's --legacy-peer-deps installed NOTHING for peers;
  //    pnpm's default (autoInstallPeers) is the opposite and is what we keep,
  //    because it satisfies each peer from its DECLARED range and covers peers
  //    of transitive packages natively — the two things the hand-rolled scan
  //    got wrong. strictPeerDependencies stays off so an unsatisfiable peer is
  //    a warning rather than a hard failure: the audit is assertLockfileCore()
  //    below, not peer warnings. The visible consequence is that peers only our
  //    plugins declare (react, react-dom) now exist in the tree; before, they
  //    were skipped silently.
  for (const name of SUITE_PLUGINS) {
    run(npmBin(), ['run', 'build'], path.join(root, 'plugins', name.replace('@dsh-app/', '')))
  }
  const projectDir = path.join(work, 'assemble')
  const pkgsDir = path.join(projectDir, 'pkgs')
  await mkdir(pkgsDir, { recursive: true })
  const suiteSpecs = {}
  for (const name of SUITE_PLUGINS) {
    suiteSpecs[name] = await packPlugin(name.replace('@dsh-app/', ''), pkgsDir)
  }

  const appPkg = {
    name: 'dsh-app-runtime',
    private: true,
    version: DSH_VERSION,
    dependencies: {
      '@deepseek-ai/dsh': DSH_VERSION,
      // fff-node ships the platform-specific FFF binary into the runtime so
      // plugin-fff's external require resolves from app/node_modules.
      '@ff-labs/fff-node': FFF_NODE_PIN,
      ...suiteSpecs,
    },
    // npm ≥11 refuses to run install/build scripts of dependencies unless the
    // project allow-lists them. The field must be an OBJECT keyed by package
    // spec (`name@*` or bare name — an array degrades to useless numeric keys
    // because the loader uses Object.entries). npm ≤10 ignores the field, and
    // pnpm ignores it too (its own list is the workspace allowlist below, fed
    // from the same NATIVE_BUILD_ALLOWLIST). A new dependency needing scripts
    // fails the install with a named error — add it there after verifying what
    // its scripts do. Note the npm CLI --allow-scripts flag is rejected outright
    // for project-scoped installs, so the field is the only project-level
    // channel. (It is inert under pnpm, kept because the artifact's
    // package.json has always carried it.)
    allowScripts: Object.fromEntries(NATIVE_BUILD_ALLOWLIST.map((name) => [`${name}@*`, true])),
  }
  await writeFile(path.join(projectDir, 'package.json'), JSON.stringify(appPkg, null, 2))
  // Build-only workspace file: it carries the assembly settings and nothing in
  // it ships inside the artifact. YAML quoting is load-bearing — a plain scalar
  // may not start with `@`.
  await writeFile(path.join(projectDir, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    '',
    '# Flat node_modules, like npm: the kernel resolves its own dependencies by',
    '# bare specifier from app/node_modules.',
    'nodeLinker: hoisted',
    '',
    '# See the peer-policy note in scripts/build-runtime.mjs.',
    'autoInstallPeers: true',
    'strictPeerDependencies: false',
    '',
    '# pnpm 11 refuses versions published within a default release-age window',
    '# (~24 h), so it resolves e.g. koffi ^3.1.0 to 3.2.1 while npm on the same day',
    '# takes 3.3.0. Pinned to 0 for npm parity and for a resolution that does not',
    '# move with the build date — a frozen install must not depend on the hour.',
    '# Deciding to adopt the age window is a deliberate hardening call, not a',
    '# side effect of this script: raise it here and re-verify the runtime boots.',
    'minimumReleaseAge: 0',
    '',
    // Build-script allowlist. pnpm ≥ 10 blocks dependency lifecycle scripts by
    // default and *fails* a frozen install when a blocked package needed one; the
    // key it reads was renamed in pnpm 11 (`onlyBuiltDependencies` list →
    // `allowBuilds` map), so the field name follows the toolchain in use. pnpm
    // also appends a `set this to true or false` stub to this file when the
    // allowlist is missing — the same policy, spelled out.
    ...(pnpm.major >= 11
      ? ['allowBuilds:', ...NATIVE_BUILD_ALLOWLIST.map((name) => `  '${name}': true`)]
      : ['onlyBuiltDependencies:', ...NATIVE_BUILD_ALLOWLIST.map((name) => `  - '${name}'`)]),
    '',
    "# Core packages never come from the registry. `@deepseek-ai/dsh*` is pinned to",
    '# the version this runtime ships (the kernel moves as one line) and every',
    '# suite plugin is the tarball this build just packed.',
    'overrides:',
    `  '@deepseek-ai/dsh': '${DSH_VERSION}'`,
    `  '@deepseek-ai/dsh-*': '${DSH_VERSION}'`,
    ...SUITE_PLUGINS.map((name) => `  '${name}': '${suiteSpecs[name]}'`),
    '',
  ].join('\n'))

  // The registry is pinned explicitly instead of relying on the build host's
  // npmrc: pnpm reads the user config (~/.npmrc) and has no --userconfig
  // equivalent, so a machine-level `registry=` would silently change what the
  // artifact contains. An explicit NPM_CONFIG_REGISTRY still wins (mirror
  // builds), matching what the empty --userconfig file did for npm. npm's
  // --no-audit/--no-fund have no pnpm counterpart and are not needed: pnpm
  // audits nothing during install and has no funding message.
  const registry = (process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry ?? '').trim()
    || 'https://registry.npmjs.org/'
  // --package-import-method=copy: pnpm's default hardlinks the store into
  // node_modules, and two packages shipping identical bytes (a shared LICENSE,
  // a duplicated .d.ts) then become ONE inode. node-tar records the second
  // occurrence as a hard-link entry whose target can appear later in the stream,
  // which GNU tar refuses ("Cannot hard link to ..."), so the artifact would no
  // longer extract with anything but node-tar — including smoke-suite.mjs --tgz
  // and any user running tar -x. Copying costs an install-time pass over ~290 MB
  // and keeps the tree a set of independent files, like the npm-built one.
  const installArgs = ['install', '--registry', registry, '--package-import-method=copy']
  run(pnpmBin(), [...installArgs, '--lockfile-only'], projectDir)

  // 2a. The lockfile assertion — the whole point of a lockfile here. Runs
  //     BEFORE anything is downloaded, so a registry-resolved core package
  //     fails the build instead of shipping.
  const lockfilePath = path.join(projectDir, 'pnpm-lock.yaml')
  const locked = assertLockfileCore(await readFile(lockfilePath, 'utf8'))
  console.log(`[build-runtime] lockfile ok: ${locked.total} packages (${locked.file} file:, ${locked.registry} registry), no @dsh-app package from the registry`)

  // 2b. Install exactly what was asserted. --frozen-lockfile makes a lockfile
  //     that no longer matches package.json a hard failure; --trust-lockfile
  //     skips pnpm's re-verification of every entry against the registry's
  //     supply-chain policy — the lockfile was just generated by this build from
  //     the pinned registry, and CI runs this six times per release.
  run(pnpmBin(), [...installArgs, '--prod', '--frozen-lockfile', '--trust-lockfile'], projectDir)

  // 2c. Move the assembled tree into the runtime and drop pnpm's bookkeeping.
  //     Hoisted mode lays down real directories (file: tarballs are unpacked,
  //     not linked), so the move cannot leave a dangling reference behind.
  const nmDir = path.join(runtimeDir, 'app', 'node_modules')
  await rm(nmDir, { recursive: true, force: true })
  await rename(path.join(projectDir, 'node_modules'), nmDir)
  // The install input is what the runtime documents about itself; the plugin
  // `file:pkgs/...` specs are kept verbatim (they name the tarballs the suite
  // came from — the pkgs/ directory itself is build-only and is not shipped).
  await cp(path.join(projectDir, 'package.json'), path.join(runtimeDir, 'app', 'package.json'))
  // Build-only pnpm state inside node_modules. .bin stays: npm produced it too.
  for (const entry of await readdir(nmDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('.') || entry.name === '.bin') continue
    if (['.modules.yaml', '.pnpm', '.pnpm-workspace-state-v1.json', '.pnpm-workspace-state.json'].includes(entry.name)) {
      await rm(path.join(nmDir, entry.name), { recursive: true, force: true })
      continue
    }
    // An unknown dot-entry is either a new pnpm bookkeeping file (harmless, but
    // it would ship) or a package with a leading dot: say so instead of guessing.
    console.warn(`[build-runtime] unexpected dot entry in node_modules: ${entry.name} — kept, please review`)
  }

  // 3. Runtime manifest. No publishedAt here: every byte of the in-archive
  //    manifest must be a function of content, or the artifact sha512 changes
  //    on every rebuild and boot-time drift detection would re-extract an
  //    unchanged runtime on each app update. The build timestamp lands only
  //    in the release-metadata copy below, outside the archive.
  const tgzName = `dsh-runtime-${platform}-${arch}-${DSH_VERSION}.tgz`
  const manifest = {
    dshVersion: DSH_VERSION,
    suiteVersion: SUITE_VERSION,
    channel: CHANNEL,
    platform,
    arch,
    integrity: '', // filled after tarring
    source: 'artifact',
  }

  // 4. Write manifest.json (integrity left blank — it cannot reference the
  //    archive that contains it without a self-referential paradox). The
  //    authoritative integrity is the sidecar .sha512; activateTarball /
  //    installFromLocalTarball verify against that, not manifest.integrity.
  //    The runtime-dist/manifest.json copy is patched with the real sha512
  //    after tarring for the artifact resolver / release metadata.
  await writeFile(path.join(runtimeDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // 5. Per-file inventory (path, size, sha256, exec bit) — written inside the
  //    archive so it reaches users the same way the artifact does, plus a copy
  //    beside the tarball for release-time audits that must not unpack 100 MB.
  //    It is a pure function of the tree, so it is also the reproducibility
  //    check: two builds of one version must produce the same list.
  const inventory = await writeFileInventory(runtimeDir, manifest)
  await writeFile(
    path.join(root, 'runtime-dist', `runtime-files-${platform}-${arch}.json`),
    `${JSON.stringify(inventory, null, 2)}\n`,
  )
  console.log(`[build-runtime] inventory: ${inventory.fileCount} files listed in runtime/app/runtime-files.json`)

  // 6. Tar the runtime directory (single top-level dir: runtime/).
  //    Reproducible archive: `portable` strips uid/gid/uname/gname/atime/ctime
  //    (header fields that vary per CI runner) and `mtime` pins every entry to
  //    the epoch, so the same content always yields the same sha512 — the
  //    precondition for the shell's drift check (sha-equal ⇔ content-equal).
  const tgzPath = path.join(root, 'runtime-dist', tgzName)
  await createTar({ gzip: true, file: tgzPath, cwd: work, portable: true, mtime: new Date(0) }, ['runtime'])

  // 7. sha512 sidecar — the trusted integrity value used at install time.
  const hash = createHash('sha512')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(tgzPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  const sha512 = hash.digest('hex')
  await writeFile(`${tgzPath}.sha512`, `${sha512}\n`)

  // 8. Release-metadata copy of the manifest with the real integrity and the
  //    build timestamp — both live OUTSIDE the archive, so they never affect
  //    the artifact sha512.
  manifest.integrity = sha512
  manifest.publishedAt = new Date().toISOString()
  await writeFile(path.join(root, 'runtime-dist', 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`\nRuntime artifact ready: ${tgzPath}`)
  console.log(`sha512: ${sha512}`)
  await rm(work, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
