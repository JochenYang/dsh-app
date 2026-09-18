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
 *   office-payload-<platform>-<arch>-<version>.tgz (+ .sha512) — the LibreOffice
 *     engine, installed on demand by the shell (see below)
 *   office-payload-<platform>-<arch>.json — that artifact's release metadata
 *
 * The suite plugins (@dsh-app/plugin-*) join the runtime as tarballs produced
 * by `npm pack`, referenced through file: specs that `overrides` also point at,
 * so no @dsh-app package can resolve from the registry; switch them to registry
 * versions once they are published.
 *
 * Two more packages the desktop shell needs are part of the same tree:
 *   - @deepseek-ai/dsh-web-frontend — published per kernel line (mind the
 *     `latest` dist-tag: it still points at 0.0.1-rc.5, an older line), pinned
 *     to DSH_VERSION like every other @deepseek-ai/dsh* package;
 *   - @deepseek-ai/dsh-desktop-host — PRIVATE (never published), so this build
 *     obtains its source, builds it and packs it (see packDesktopHost): from a
 *     checkout or a git repository at the tag of the kernel line being built,
 *     or from a prebuilt tarball. The shell starts this package as the kernel
 *     child, so a runtime without it cannot boot at all.
 *
 * One payload the host needs is neither a package nor optional:
 *   - the Office skills (packages/skill/skill-office/assets in a harness
 *     checkout), staged beside the kernel tree as `runtime/office-skills` (see
 *     stageOfficeSkills). The host derives its skill asset root from its
 *     primary-runtime argument — `join(dirname(<kernelDir>/app), 'office-skills')`
 *     — and @deepseek-ai/dsh-skill-office THROWS at boot when
 *     `<assetRoot>/scripts/check_office.py` is absent, so a runtime shipped
 *     without it dies a few seconds into the first start.
 *
 * One payload the OFFICE PROVIDER needs is deliberately NOT in the tree:
 *   - the LibreOffice engine (@deepseek-ai/libreoffice-kit + its per-platform
 *     `…-kit-<platform>-<arch>` package, ~330 MiB unpacked). It is only needed
 *     when a document is actually converted, so it travels in a SECOND artifact
 *     (`office-payload-<platform>-<arch>-<version>.tgz`, built by
 *     buildOfficePayload) that the shell downloads on demand and installs under
 *     its own data directory. @deepseek-ai/dsh-office-to-pdf imports the kit
 *     STATICALLY at module scope, so the runtime keeps a tiny loader shim at
 *     that specifier instead (stageOfficeKitShim) — without it the provider
 *     entry fails to LOAD, which is a different failure from "no engine
 *     installed" and much harder to explain. See scripts/lib/office-payload.mjs.
 *
 * Assembly is pnpm ≥ 10 with the hoisted linker (see "pnpm assembly" above
 * main()): a lockfile is generated first and asserted to hold no
 * registry-resolved core package, then installed from that frozen lockfile.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { c as createTar, t as listTar, x as extractTar } from 'tar'
import { collectTreeEntries } from './lib/tree-entry.mjs'
import {
  createOfficePayloadManifest,
  kitEnginePackage,
  officePayloadAssetName,
  officePayloadManifestName,
  officePayloadManifestProblems,
  officePayloadRequiredFiles,
  officePayloadVersion,
  PAYLOAD_ARCHIVE_DIR,
  PAYLOAD_MANIFEST_FILE,
  PAYLOAD_MODULES_DIR,
  PAYLOAD_PRIMARY_RUNTIME_DIR,
} from './lib/office-payload.mjs'
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
 * Strip the userinfo of a URL before it is logged.
 *
 * DSH_APP_HOST_REPO_URL is the one argument in this build that can carry a
 * credential (a private mirror has no other channel), and a CI log is durable
 * and widely readable: the clone URL must never reach it verbatim. Only the
 * display is affected — the command itself still receives the full URL.
 */
function redactCredentials(value) {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1***@')
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
  console.log(`$ ${cmd} ${args.map(redactCredentials).join(' ')}`)
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
 * The private host the shell starts the kernel with. Not on npm (`private:
 * true`), so it travels as a locally packed tarball (see packDesktopHost).
 */
const DESKTOP_HOST_PACKAGE = '@deepseek-ai/dsh-desktop-host'

/** The host app inside a harness checkout: the directory that becomes the package. */
const DESKTOP_HOST_APP_DIR = 'apps/desktop-host'

/** The Office skills inside a harness checkout — the payload the host reads beside itself. */
const OFFICE_SKILLS_ASSETS = ['packages', 'skill', 'skill-office', 'assets']

/**
 * The package that carries the LibreOffice engines, one optional dependency
 * per platform/arch. Its own manifest is what `selectOfficeEngine` reads:
 * whichever of `@deepseek-ai/libreoffice-kit-*` it declares for the target is
 * the one the payload artifact stages for that target.
 */
const DESKTOP_OFFICE_KIT_PACKAGE = '@deepseek-ai/libreoffice-kit'

/**
 * The provider that imports the kit STATICALLY, at module scope. It is what
 * makes the engine package non-optional in a different way: with no
 * `@deepseek-ai/libreoffice-kit` resolvable at all, this package fails to load
 * and the whole plugin entry is refused — so the runtime ships a stub under that
 * specifier (see stageOfficeKitShim).
 */
const DESKTOP_OFFICE_PROVIDER_PACKAGE = '@deepseek-ai/dsh-office-to-pdf'

/** Where the runtime's stub of {@link DESKTOP_OFFICE_KIT_PACKAGE} comes from in this repo. */
const OFFICE_KIT_STUB_DIR = ['scripts', 'runtime-stubs', 'libreoffice-kit']

/**
 * Where the Office SKILLS land inside the built runtime tree.
 *
 * The shell hands the host `primaryRuntime = <kernelDir>/app` and
 * @deepseek-ai/dsh-skill-office takes its asset root from
 * `join(dirname(primaryRuntime), 'office-skills')`, so the directory has to sit
 * at `<kernelDir>/runtime/office-skills` — a path nothing else in the runtime
 * occupies, because the kernel tree itself is `<kernelDir>/app`.
 *
 * These are the four skill files (three SKILL.md and `scripts/check_office.py`),
 * not the conversion engine: the engine is the separate payload artifact.
 */
const OFFICE_SKILLS_DIR = 'runtime/office-skills'

/**
 * Upstream repository, cloned only when no local checkout of it exists. The
 * host is private, so CI has to obtain its source from the tag of the kernel
 * line it ships — this is where it comes from.
 */
const DEFAULT_HOST_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

/**
 * The web frontend the host serves as the UI. Published per kernel line like
 * every other kernel package — note the `latest` dist-tag still resolves to
 * 0.0.1-rc.5 from an older line, which is why this is pinned to DSH_VERSION
 * rather than to a tag.
 */
const WEB_FRONTEND_PACKAGE = '@deepseek-ai/dsh-web-frontend'

/**
 * Registry every install in this build resolves from. Pinned explicitly rather
 * than inherited: pnpm reads the user config (~/.npmrc) and has no --userconfig
 * equivalent, so a machine-level `registry=` would silently change what the
 * artifact contains. An explicit NPM_CONFIG_REGISTRY still wins (mirror builds).
 * @returns the registry URL to pass to pnpm.
 */
function registryUrl() {
  return (process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry ?? '').trim()
    || 'https://registry.npmjs.org/'
}

/** Tag naming a kernel version in the upstream repository (dsh-v0.1.5-rc.2). */
function hostTag() {
  return (process.env.DSH_APP_HOST_TAG ?? '').trim() || `dsh-v${DSH_VERSION}`
}

/**
 * Where a checkout of the harness repository may already sit on this machine.
 *
 * The same two candidates the shell's own dev mode and scripts/smoke-suite.mjs
 * look for: the checkout sits beside this repo on some machines and one level
 * further up on others. CI has neither and clones instead (see
 * prepareDesktopHostSource), so an absent candidate is not an error by itself.
 */
function harnessCheckoutCandidates() {
  return [path.resolve(root, '..', 'deepseek-harness'), path.resolve(root, '..', '..', 'deepseek-harness')]
}

/**
 * The checkout the office payload is read from when the host itself arrived as
 * a prebuilt tarball (DSH_APP_HOST_PACKAGE) — that path resolves no checkout of
 * the kernel line's tag, so the payload needs one of its own.
 *
 * No worktree and no clone here: the payload is four files, and a caller who
 * brought a prebuilt host is deliberately avoiding what cloning costs. An
 * explicit DSH_APP_HOST_CHECKOUT or DSH_APP_HOST_REPO wins; otherwise the first
 * sibling checkout that actually holds the payload.
 */
function officeSkillsCheckout() {
  const explicit = (process.env.DSH_APP_HOST_CHECKOUT ?? '').trim()
  if (explicit !== '') return path.resolve(explicit)
  const configured = (process.env.DSH_APP_HOST_REPO ?? '').trim()
  if (configured !== '') return path.resolve(configured)
  const siblings = harnessCheckoutCandidates()
  return siblings.find((dir) => existsSync(path.join(dir, ...OFFICE_SKILLS_ASSETS))) ?? siblings[0]
}

/**
 * Stage the Office skills a harness checkout carries into the runtime tree.
 *
 * The payload is not optional for a runtime of this line: the host composes
 * @deepseek-ai/dsh-skill-office with
 * `assetRoot = join(dirname(primaryRuntime), 'office-skills')`, and that plugin
 * THROWS at boot unless `<assetRoot>/scripts/check_office.py` exists. Dev mode
 * reads it from the checkout it runs from; a shipped artifact has nothing but
 * its own tree to read, so the copy is a build-side duty.
 *
 * No separate inventory step is needed: writeFileInventory walks the whole
 * runtime tree, so every staged file lands in runtime/app/runtime-files.json —
 * and, through the same paths, in the layer split (split-runtime-layers.mjs
 * carries this directory in its meta layer, the one layer that is not scoped to
 * a package tree).
 *
 * @param runtimeDir - the runtime tree being assembled (the kernel dir).
 * @param checkoutDir - a harness checkout of the kernel line being built.
 * @returns the staged payload directory.
 * @throws when the checkout does not carry the payload: skipping it would only
 *   move the failure to a user's machine, several seconds into the first boot.
 */
async function stageOfficeSkills(runtimeDir, checkoutDir) {
  const source = path.join(checkoutDir, ...OFFICE_SKILLS_ASSETS)
  if (!existsSync(path.join(source, 'scripts', 'check_office.py'))) {
    throw new Error(
      `no office payload at ${source}: the desktop host refuses to start unless <primaryRuntime>/../office-skills `
      + `holds scripts/check_office.py, so a runtime for this line must ship one — point DSH_APP_HOST_CHECKOUT `
      + `(or DSH_APP_HOST_REPO) at a checkout of dsh ${DSH_VERSION}`,
    )
  }
  const target = path.join(runtimeDir, OFFICE_SKILLS_DIR)
  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true })
  // Asserted at the destination too: this is the path the child derives, and a
  // misplaced payload is indistinguishable from a missing one at boot.
  if (!existsSync(path.join(target, 'scripts', 'check_office.py'))) {
    throw new Error(`the staged office payload at ${target} holds no scripts/check_office.py`)
  }
  console.log(`[build-runtime] office payload: ${source} -> ${OFFICE_SKILLS_DIR}`)
  return target
}

/** A checkout or a worktree keeps `.git` as a directory or a file. */
function isGitRepo(dir) {
  return existsSync(path.join(dir, '.git'))
}

/** Absolute path of a binary the checkout's own install placed in node_modules/.bin. */
function checkoutBin(checkoutDir, name) {
  const binDir = path.join(checkoutDir, 'node_modules', '.bin')
  for (const candidate of process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name]) {
    const full = path.join(binDir, candidate)
    if (existsSync(full)) return full
  }
  throw new Error(`${name} is missing from ${binDir} — the host checkout's install did not complete`)
}

/** True when `repoDir` holds the tag (annotated tags resolve through ^{commit}). */
function hasTag(repoDir, tag) {
  try {
    capture('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], repoDir)
    return true
  } catch {
    return false
  }
}

/**
 * Install and build the private desktop host inside a checkout of the kernel
 * line, and return its app directory.
 *
 * Scope is deliberate: the workspace install is narrowed to the host project
 * and its dependency closure plus the workspace root (whose devDependencies
 * are the toolchain — typescript, tsdown), and only `apps/desktop-host` is
 * built. `tsc -b` then compiles the project references that app's tsconfig
 * declares (~30 workspace projects) from source, and `tsdown` bundles its
 * `lib/types` into the `lib/index.js` the runtime ships.
 *
 * `--ignore-scripts`: no dependency lifecycle script contributes to tsc/tsdown
 * output — the ones this monorepo ships build native addons and bundler
 * binaries, which would only add build time and platform-specific failure
 * modes to a step that compiles TypeScript. `--frozen-lockfile`: the checkout
 * is a tag, so the lockfile is the resolution upstream released and this build
 * has no business re-resolving it.
 *
 * @param checkoutDir - checkout of the kernel line's tag.
 * @returns the app directory, holding a built lib/index.js.
 */
async function buildDesktopHostApp(checkoutDir) {
  const appDir = path.join(checkoutDir, DESKTOP_HOST_APP_DIR)
  const manifestPath = path.join(appDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`${checkoutDir} holds no ${DESKTOP_HOST_APP_DIR}/package.json — the host source must be a checkout of the harness repository`)
  }
  // Checked before the install: without it a checkout of the wrong line is only
  // caught after minutes of building, by the version assertion at pack time.
  const declared = JSON.parse(readFileSync(manifestPath, 'utf8')).version
  if (declared !== DSH_VERSION) {
    throw new Error(
      `host source at ${checkoutDir} is ${declared}, but this runtime ships dsh ${DSH_VERSION} — `
      + `the host must come from the same kernel line (tag ${hostTag()})`,
    )
  }
  await run(pnpmBin(), [
    'install', '--frozen-lockfile', '--ignore-scripts', '--registry', registryUrl(),
    '--filter', `${DESKTOP_HOST_PACKAGE}...`,
    // The workspace root project: it owns the devDependencies the build below
    // runs (typescript, tsdown), and it is what a `--filter` install otherwise
    // leaves out.
    '--filter', '.',
  ], checkoutDir)
  await run(checkoutBin(checkoutDir, 'tsc'), ['-b', path.join(DESKTOP_HOST_APP_DIR, 'tsconfig.json')], checkoutDir)
  await run(checkoutBin(checkoutDir, 'tsdown'), [], appDir)
  if (!existsSync(path.join(appDir, 'lib', 'index.js'))) {
    throw new Error(`building ${DESKTOP_HOST_APP_DIR} in ${checkoutDir} produced no lib/index.js`)
  }
  return appDir
}

/**
 * A built checkout of the private desktop host for this kernel line.
 *
 * Three ways in, tried in this order:
 *
 *   1. `DSH_APP_HOST_CHECKOUT` — a checkout whose app is ALREADY built.
 *      Nothing is installed or compiled in a tree the caller chose, so a
 *      missing lib/index.js is an error naming the commands that produce it.
 *   2. A git repository (`DSH_APP_HOST_REPO`, else a sibling
 *      `../deepseek-harness` or `../../deepseek-harness`): a detached worktree
 *      at the kernel line's tag, created in the build work dir, installed and
 *      built there, removed again. Taking the source from that tag is the point
 *      of this path — packing a 0.1.6 checkout against 0.1.5-rc.2 dependencies
 *      is what made an earlier attempt fail in the lockfile stage on
 *      `@deepseek-ai/dsh-settings>=0.1.6 <0.2.0-0`.
 *   3. No repository: a shallow clone of that tag from `DSH_APP_HOST_REPO_URL`
 *      (default upstream). This is the CI shape and the only network path; a
 *      workstation with a sibling checkout never fetches anything.
 *
 * @param workRoot - build work dir the disposable checkout lands in.
 * @returns the checkout directory, a label for the build log, and the disposer
 *   that removes whatever this call created.
 */
async function prepareDesktopHostSource(workRoot) {
  const explicit = (process.env.DSH_APP_HOST_CHECKOUT ?? '').trim()
  if (explicit !== '') {
    const dir = path.resolve(explicit)
    if (!existsSync(path.join(dir, DESKTOP_HOST_APP_DIR, 'package.json'))) {
      throw new Error(`DSH_APP_HOST_CHECKOUT=${dir} holds no ${DESKTOP_HOST_APP_DIR}/ — it must be a checkout of the harness repository`)
    }
    if (!existsSync(path.join(dir, DESKTOP_HOST_APP_DIR, 'lib', 'index.js'))) {
      throw new Error(
        `cannot pack ${DESKTOP_HOST_PACKAGE}: ${path.join(dir, DESKTOP_HOST_APP_DIR)} has no built lib/index.js — `
        + 'build it first (pnpm install, then tsc -b apps/desktop-host/tsconfig.json and tsdown inside apps/desktop-host), '
        + "or leave DSH_APP_HOST_CHECKOUT unset to let this script take the source from the kernel line's tag",
      )
    }
    return { dir, origin: `checkout ${dir}`, dispose: async () => {} }
  }
  const configured = (process.env.DSH_APP_HOST_REPO ?? '').trim()
  const siblings = harnessCheckoutCandidates()
  const repo = configured !== '' ? path.resolve(configured) : siblings.find((dir) => isGitRepo(dir)) ?? siblings[0]
  if (isGitRepo(repo)) {
    const tag = hostTag()
    if (!hasTag(repo, tag)) {
      console.log(`[build-runtime] ${repo} does not hold ${tag} yet — fetching the tag`)
      run('git', ['fetch', '--depth', '1', 'origin', 'tag', tag], repo)
    }
    if (!hasTag(repo, tag)) {
      throw new Error(`${repo} has no tag ${tag} — it must hold the kernel line this runtime ships (git fetch origin tag ${tag})`)
    }
    const dir = path.join(workRoot, 'host-src')
    await rm(dir, { recursive: true, force: true })
    // A crashed earlier build leaves the worktree registered while its
    // directory is already gone; prune first so `worktree add` never refuses a
    // path it cannot clean up itself.
    try { capture('git', ['worktree', 'prune'], repo) } catch { /* housekeeping only */ }
    run('git', ['worktree', 'add', '--detach', dir, tag], repo)
    return {
      dir,
      origin: `${repo} worktree at ${tag}`,
      dispose: async () => {
        await rm(dir, { recursive: true, force: true })
        try { capture('git', ['worktree', 'prune'], repo) } catch { /* the checkout is already gone */ }
      },
    }
  }
  if (configured !== '') {
    throw new Error(`DSH_APP_HOST_REPO=${repo} is not a git checkout — point it at a clone of the harness repository`)
  }
  if (existsSync(repo)) {
    // The default sibling exists but is not version-controlled: it cannot be
    // turned into a worktree at the tag, and reading it in place would take the
    // host from whatever revision happens to sit there. Say so rather than
    // silently cloning a second copy.
    throw new Error(
      `${repo} is not a git checkout, so its host source cannot be tied to kernel tag ${hostTag()} — `
      + 'point DSH_APP_HOST_CHECKOUT at it if its app is already built, or DSH_APP_HOST_REPO at a git clone',
    )
  }
  const url = (process.env.DSH_APP_HOST_REPO_URL ?? DEFAULT_HOST_REPO_URL).trim()
  if (url === '') {
    throw new Error(
      `no checkout of the harness repository at ${repo} and DSH_APP_HOST_REPO_URL is empty — `
      + `the private ${DESKTOP_HOST_PACKAGE} has no registry source, so set DSH_APP_HOST_REPO, DSH_APP_HOST_CHECKOUT or DSH_APP_HOST_PACKAGE`,
    )
  }
  const dir = path.join(workRoot, 'host-src')
  await rm(dir, { recursive: true, force: true })
  await mkdir(workRoot, { recursive: true })
  // One tag, no history, no other refs: the harness repository carries years of
  // history and nothing outside this tag's tree is ever read. `--no-tags` earns
  // its place because `--depth` bounds COMMITS, not refs — measured: without it
  // the clone also carries every tag of the remote (pointing at unfetched
  // commits); with it, exactly the one tag this build asked for. The blob filter
  // costs nothing here (at depth 1 the tree's blobs are all needed for the
  // checkout), and a server that does not support it answers "filtering not
  // recognized by server, ignoring" and a plain shallow clone — so a mirror
  // behind DSH_APP_HOST_REPO_URL cannot be broken by it.
  run('git', ['clone', '--filter=blob:none', '--depth', '1', '--no-tags', '--branch', hostTag(), url, dir], workRoot)
  return {
    dir,
    origin: `${redactCredentials(url)} at ${hostTag()}`,
    dispose: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

/**
 * Directories a checkout's pnpm-workspace.yaml `packages:` globs select.
 *
 * Hand-parsed for the same reason the lockfile is: the list is two-space
 * indented `- <glob>` lines with comments between entries, and the alternative
 * is a YAML parser in the build toolchain. Globs are expanded one path segment
 * at a time; a single wildcard segment is the whole of the syntax the harness
 * uses (`vendor`, `packages`, `apps` each hold one level of projects).
 * Negations are skipped: nothing here needs to subtract from the list.
 * @param checkoutDir - checkout root holding pnpm-workspace.yaml.
 */
function workspaceProjectDirs(checkoutDir) {
  const file = path.join(checkoutDir, 'pnpm-workspace.yaml')
  if (!existsSync(file)) return []
  const globs = []
  let inPackages = false
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    if (/^packages:/u.test(line)) { inPackages = true; continue }
    if (!inPackages || line.trim() === '' || /^\s*#/u.test(line)) continue
    const match = /^[ \t]+-[ \t]*['"]?([^'"\s]+)['"]?[ \t]*$/u.exec(line)
    if (match === null) break // the next top-level key ends the list
    if (!match[1].startsWith('!')) globs.push(match[1])
  }
  const dirs = []
  for (const glob of globs) {
    let current = [checkoutDir]
    for (const segment of glob.replace(/^\.\//u, '').replace(/\/+$/u, '').split('/')) {
      const next = []
      for (const dir of current) {
        if (segment === '*' || segment === '') {
          let entries = []
          try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
          for (const entry of entries) {
            if (segment === '') next.push(path.join(dir, entry.name))
            else if (entry.isDirectory() && !entry.name.startsWith('.')) next.push(path.join(dir, entry.name))
          }
          continue
        }
        const full = path.join(dir, segment)
        // Absent: an optional group directory in someone else's layout.
        if (existsSync(full)) next.push(full)
      }
      current = next
    }
    dirs.push(...current)
  }
  return dirs
}

/**
 * name → version for every workspace project a checkout declares.
 *
 * Only `workspace:` dependency specs need this (see
 * concretizeHostWorkspaceSpecs): the protocol means "the version of the package
 * at that path in this workspace", so the workspace's own manifests are the
 * only source that answers it.
 * @param checkoutDir - checkout root holding pnpm-workspace.yaml.
 */
function workspacePackageVersions(checkoutDir) {
  const versions = new Map()
  for (const dir of workspaceProjectDirs(checkoutDir)) {
    const manifestPath = path.join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof pkg.name === 'string' && typeof pkg.version === 'string') versions.set(pkg.name, pkg.version)
  }
  return versions
}

/**
 * Replace the `workspace:` dependency specs of the packed host with the
 * versions they stand for.
 *
 * `npm pack` copies the field verbatim, and pnpm refuses a tarball whose
 * dependencies use the workspace protocol — the tarball belongs to no
 * workspace, so resolution dies with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND ("no
 * package named @deepseek-ai/cordis is present in the workspace"). The host is
 * the one package here that reaches the runtime as a tarball while declaring
 * workspace specs, so this is where they have to be made concrete.
 *
 * `@deepseek-ai/dsh*` are pinned to DSH_VERSION: the kernel moves as one line
 * and the assembly's `overrides` already pin exactly this value. Everything
 * else keeps the protocol's meaning — `workspace:^x.y.z` → `^x.y.z` of the
 * package in the source checkout — which for the vendored Cordis packages is
 * the version this line publishes on npm.
 *
 * Only the packed copy is rewritten: the checkout keeps its manifest, and the
 * entry list is reused, so the archive keeps the shape `npm pack` produced.
 * @param tarball - tarball produced by `npm pack`, replaced in place.
 * @param manifest - the packed manifest, already read by the caller.
 * @param versions - name → version of the source checkout's workspace projects.
 * @returns the rewritten `<name>@<spec>` pairs, for the build log.
 */
async function concretizeHostWorkspaceSpecs(tarball, manifest, versions) {
  const specs = {}
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
    if (KERNEL_PACKAGE.test(name)) { specs[name] = DSH_VERSION; continue }
    const version = versions.get(name)
    if (version === undefined) {
      throw new Error(
        `${DESKTOP_HOST_PACKAGE} declares ${name}: ${spec}, which pnpm cannot resolve outside a workspace — `
        + (versions.size === 0
          ? 'the tarball came from DSH_APP_HOST_PACKAGE and no checkout was available to resolve it; '
            + 'either pack the host with `pnpm pack` (it rewrites the protocol to concrete ranges), '
            + 'or drop DSH_APP_HOST_PACKAGE so this build takes the source from the kernel line\'s tag'
          : `the host checkout declares no workspace package named ${name}`),
      )
    }
    specs[name] = spec === 'workspace:*' ? version : `${spec.slice('workspace:'.length)}${version}`
  }
  if (Object.keys(specs).length === 0) return []
  const entries = await tarEntries(tarball)
  const staging = `${tarball}.specs`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await extractTar({ file: tarball, cwd: staging })
    const manifestPath = path.join(staging, 'package', 'package.json')
    const shipped = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const [name, spec] of Object.entries(specs)) shipped.dependencies[name] = spec
    await writeFile(manifestPath, `${JSON.stringify(shipped, null, 2)}\n`)
    await rm(tarball, { force: true })
    await createTar({ gzip: true, file: tarball, cwd: staging, portable: true, mtime: new Date(0) }, entries)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return Object.entries(specs).map(([name, spec]) => `${name}@${spec}`)
}

/**
 * Pack the private desktop host for this runtime.
 *
 * The package cannot be installed by name, so the build either takes a tarball
 * someone already built (`DSH_APP_HOST_PACKAGE`) or packs one from a checkout
 * of the SAME kernel line (see prepareDesktopHostSource for where that checkout
 * comes from). Either way the packed manifest must name the version this
 * runtime ships — the host composes the kernel installed beside it, and a
 * mismatched pair fails at runtime with an opaque service error instead of
 * here — and its `workspace:` specs are resolved to concrete versions, because
 * pnpm cannot install them at all.
 *
 * The office payload the same host refuses to start without is staged here too
 * (see stageOfficeSkills): it belongs to the kernel line, so it has to come
 * from the same checkout the host was packed from.
 *
 * @param destDir - directory to pack into (the pnpm project's pkgs/).
 * @param workRoot - build work dir a disposable host checkout is created in.
 * @param runtimeDir - the runtime tree being assembled, the payload's destination.
 * @returns the file: spec for the runtime's dependencies, plus the runtime
 *   dependency names the host's own manifest declares.
 */
async function packDesktopHost(destDir, workRoot, runtimeDir) {
  const prebuilt = (process.env.DSH_APP_HOST_PACKAGE ?? '').trim()
  let tarball
  // Empty for the prebuilt path: there is no checkout, so a workspace: spec in
  // a foreign tarball is unresolvable and reported as such.
  let versions = new Map()
  let origin = 'DSH_APP_HOST_PACKAGE'
  if (prebuilt !== '') {
    if (!existsSync(prebuilt)) {
      throw new Error(`DSH_APP_HOST_PACKAGE points at ${prebuilt}, which does not exist`)
    }
    // Copy it in so every spec this build records is `file:pkgs/<name>`, like
    // the suite plugins — the tarball then lives beside the other pack outputs
    // for the whole build.
    const target = path.join(destDir, path.basename(prebuilt))
    if (path.resolve(target) !== path.resolve(prebuilt)) await cp(prebuilt, target)
    tarball = target
    // This path brings no checkout of the kernel line, so the payload has to be
    // resolved on its own (see officeSkillsCheckout).
    await stageOfficeSkills(runtimeDir, officeSkillsCheckout())
  } else {
    const source = await prepareDesktopHostSource(workRoot)
    origin = source.origin
    console.log(`[build-runtime] host source: ${source.origin}`)
    try {
      const appDir = await buildDesktopHostApp(source.dir)
      // Before the disposer runs: the checkout is the only place the payload
      // exists, and a worktree is removed with it.
      await stageOfficeSkills(runtimeDir, source.dir)
      const packed = JSON.parse(capture(npmBin(), ['pack', '--json', '--pack-destination', destDir], appDir))
      const filename = packed?.[0]?.filename
      if (typeof filename !== 'string') throw new Error(`npm pack produced no file name for ${DESKTOP_HOST_PACKAGE}`)
      tarball = path.join(destDir, filename)
      versions = workspacePackageVersions(source.dir)
    } finally {
      // The worktree is this build's to clean up, whether the pack succeeded or
      // threw: nothing outside the work dir may keep pointing at it.
      await source.dispose()
    }
  }
  // Read the packed manifest (the tarball, not the checkout): that is the copy
  // the runtime will install, and npm pack rewrites nothing inside it.
  const staging = `${tarball}.manifest`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  let manifest
  try {
    await extractTar({ file: tarball, cwd: staging, entries: ['package/package.json'] })
    manifest = JSON.parse(await readFile(path.join(staging, 'package', 'package.json'), 'utf8'))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  if (manifest.name !== DESKTOP_HOST_PACKAGE) {
    throw new Error(`packed host tarball names ${JSON.stringify(manifest.name)}, expected ${DESKTOP_HOST_PACKAGE}`)
  }
  if (manifest.version !== DSH_VERSION) {
    throw new Error(
      `packed host is ${manifest.version} but this runtime ships ${DSH_VERSION} — `
      + `pack the host from a checkout of the same kernel line (from ${origin}, expected tag ${hostTag()})`,
    )
  }
  const rewritten = await concretizeHostWorkspaceSpecs(tarball, manifest, versions)
  const dependencies = Object.keys(manifest.dependencies ?? {}).filter((name) => KERNEL_PACKAGE.test(name))
  console.log(
    `[build-runtime] packed desktop host ${manifest.version}: ${formatBytes(statSync(tarball).size)}`
    + ` (runtime dependencies: ${dependencies.join(', ')})`,
  )
  if (rewritten.length > 0) {
    console.log(`[build-runtime] host workspace specs resolved: ${rewritten.join(', ')}`)
  }
  return { spec: `file:pkgs/${path.basename(tarball)}`, dependencies }
}

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
function assertLockfileCore(lockfileText, hostPackageName) {
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
    } else if (KERNEL_PACKAGE.test(entry.name)) {
      // The private desktop host is the one kernel-shaped package that cannot
      // come from the registry: it must be the tarball this build packed, and
      // its own version was already asserted against DSH_VERSION at pack time.
      if (entry.name === hostPackageName) {
        if (!entry.version.startsWith('file:')) {
          throw new Error(
            `lockfile resolved the private ${entry.name} from the registry (${entry.version})`
            + ' — the pack tarball did not reach the dependency graph, refusing to assemble',
          )
        }
        continue
      }
      if (entry.version !== DSH_VERSION) {
        throw new Error(
          `lockfile resolved ${entry.name}@${entry.version}, but this runtime ships dsh ${DSH_VERSION}`
          + ' — two kernel versions in one tree is the double-instance bug, refusing to assemble',
        )
      }
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
 * and the executable bit, sorted by path — plus the symlinks, as a group of
 * their own (`{ path, target }`, target relative to the link's directory).
 *
 * It is written INSIDE the archive (runtime/app/runtime-files.json) so it travels
 * with every artifact the way the user receives it — through the release tarball
 * and through the kernel bundled into the installer — and so the layer splitter's
 * `vendor` layer carries it, keeping its re-assembly self-check exact. A second
 * copy lands next to the tarball for release-time audits that must not unpack
 * 100 MB.
 *
 * The links are separate from the files because `files` means exactly one thing
 * to the readers of this inventory: a regular file, with a size and a hash, both
 * of which a link lacks. pnpm's `.bin` shims are links on POSIX and real
 * `.cmd`/`.ps1` files on Windows, so their presence is a property of the build
 * host, not of the runtime — recording them keeps the inventory a faithful
 * description of either artifact instead of a Windows-only one (see
 * scripts/lib/tree-entry.mjs).
 *
 * Content is a pure function of the tree (no timestamps), so two builds of one
 * version must produce identical inventories — the reproducibility check §2.4
 * asks for — and it records the exec bits a Windows build host cannot test.
 * @param runtimeDir - the runtime/ tree being packaged.
 * @returns the inventory object written.
 */
async function writeFileInventory(runtimeDir, manifest) {
  const self = 'app/runtime-files.json'
  const { files, links } = await collectTreeEntries(runtimeDir, { skip: [self] })
  const inventory = {
    dshVersion: manifest.dshVersion,
    suiteVersion: manifest.suiteVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    algorithm: 'sha256',
    fileCount: files.length,
    files,
    // Always present, even at zero: a reader (and the layer splitter's own
    // comparison) must not have to guess whether a missing group means "none"
    // or "an inventory written by an older build".
    linkCount: links.length,
    links,
  }
  await writeFile(path.join(runtimeDir, self), JSON.stringify(inventory, null, 2))
  return inventory
}

/**
 * Which engine package the target loads: the LibreOffice kit the office payload
 * carries, plus the engine for THIS platform.
 *
 * Ported from the upstream desktop packaging
 * (apps/desktop/scripts/prepare-dsh.ts and scripts/libreoffice-engine.ts):
 * `@deepseek-ai/libreoffice-kit` declares one optional dependency per engine
 * (`…-win32-x64`, `…-darwin-arm64`, `…-wasm`, …) and each of those packages
 * carries its own platform/arch fields. Reading the SAME declaration answers
 * which one the target needs — no table of platforms lives here, and a new
 * engine upstream adds is handled without an edit. A target the kit declares no
 * native engine for falls back to `wasm`, which is what the kit itself does.
 * (buildOfficePayload installs it with `supportedArchitectures` naming the
 * target, so a cross-target cell gets the target's engine rather than the build
 * host's.)
 *
 * @param kitManifest - the installed kit's package.json.
 * @param platform - Node platform of the artifact being built.
 * @param arch - Node arch of the artifact being built.
 * @returns engine suffix as it appears in the engine package name.
 */
function selectOfficeEngine(kitManifest, platform, arch) {
  const native = `${platform}-${arch}`
  const declared = kitManifest?.optionalDependencies ?? {}
  return Object.hasOwn(declared, `@deepseek-ai/libreoffice-kit-${native}`) ? native : 'wasm'
}

/**
 * Why one path inside the runtime's `app/node_modules` must not ship, or
 * undefined when the entry is payload.
 *
 * Ported rule for rule from the upstream desktop runtime
 * (apps/desktop/scripts/runtime-file-policy.ts, which decides what their
 * `cpSync` filter copies): upstream ships the same dsh package tree this build
 * assembles and boots it as its desktop runtime, so the omissions are known to
 * be safe for exactly this payload — build and diagnostic files (source maps,
 * type declarations, build caches, compiler output) and native binaries for
 * platforms the artifact will never run on. What a target NEEDS is never
 * excluded: the node-pty prebuild it dlopens and anything unrecognized stay.
 *
 * One rule goes FURTHER than upstream's, and deliberately: the whole
 * LibreOffice kit (the API package and every engine package) leaves the runtime
 * for the separate payload artifact. Upstream keeps the target's engine inside
 * its desktop runtime; we cannot, because the shell installs that engine on
 * demand — a user who never converts a document must not download 115 MiB of it
 * with every kernel update. The runtime keeps a loader shim at the specifier
 * the provider imports (see stageOfficeKitShim).
 *
 * @param relativePath - path relative to the runtime's app/node_modules.
 * @param target - platform and arch of the artifact being built.
 * @returns the reason it is omitted, for the build log.
 */
function runtimeFileExclusion(relativePath, target) {
  const parts = relativePath.split(/[\\/]/u)
  if (parts.some((part) => ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(part))) {
    return 'package-manager metadata'
  }
  const file = parts.at(-1) ?? ''
  if (/\.(?:[cm]?[jt]s|css)\.map$/u.test(file)) return 'source map'
  if (/\.d\.[cm]?ts$/u.test(file)) return 'TypeScript declaration'
  if (/\.tsbuildinfo$/u.test(file)) return 'TypeScript build cache'
  // The package the entry belongs to, resolved from the LAST node_modules
  // segment so a nested tree is read as its own package.
  const packageParts = parts.slice(parts.lastIndexOf('node_modules') + 1)
  const nameParts = packageParts[0]?.startsWith('@') ? 2 : 1
  const name = packageParts.slice(0, nameParts).join('/')
  const entry = packageParts.slice(nameParts).join('/')
  if (name === DESKTOP_OFFICE_KIT_PACKAGE || name.startsWith(`${DESKTOP_OFFICE_KIT_PACKAGE}-`)) {
    // The whole kit: the API package AND every engine. All of it moves to the
    // on-demand payload artifact, whose install is what the runtime's stub
    // loads (see buildOfficePayload / stageOfficeKitShim). `officeEngine` is no
    // longer consulted here — it selects what the PAYLOAD stages, not what the
    // runtime keeps.
    return 'LibreOffice engine (separate artifact)'
  }
  if (name === 'fs-ext' && /^build\/(?:Release|Debug)\/(?:obj(?:\/|$)|fs_ext\.(?:exp|lib|pdb|iobj|ipdb)$)/u.test(entry)) {
    return 'fs-ext compiler output'
  }
  if (name === 'fs-ext' && /^build\/(?:binding\.sln|config\.gypi|fs_ext\.vcxproj(?:\.filters)?)$/u.test(entry)) {
    return 'fs-ext build configuration'
  }
  if (name === '@mixmark-io/domino' && (entry === 'test' || entry.startsWith('test/'))) return 'Domino test fixtures'
  if (name === 'node-pty' && entry.startsWith('prebuilds/')) {
    const platform = packageParts[nameParts + 1]
    if (platform !== undefined && platform !== `${target.platform}-${target.arch}`) return 'node-pty other platform'
    if (file.endsWith('.pdb')) return 'node-pty debug symbols'
  }
  if (name === '@koromix/koffi-win32-x64' && entry === 'win32_x64/koffi.lib') return 'Koffi import library'
  return undefined
}

/** Recursively remove a directory's entries that must not ship. */
async function pruneRuntimeTree(dir, root, target, dropped) {
  let kept = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const survivors = await pruneRuntimeTree(full, root, target, dropped)
      if (survivors === 0) {
        await rm(full, { recursive: true, force: true })
        continue
      }
      kept += 1
      continue
    }
    const relative = path.relative(root, full)
    const reason = runtimeFileExclusion(relative, target)
    if (reason === undefined) {
      kept += 1
      continue
    }
    const record = dropped.get(reason) ?? { files: 0, bytes: 0 }
    record.files += 1
    record.bytes += statSync(full, { throwIfNoEntry: false })?.size ?? 0
    dropped.set(reason, record)
    await rm(full, { force: true })
  }
  return kept
}

/**
 * Keep only the payload this target needs inside the assembled runtime's
 * `app/node_modules`, and report what was dropped.
 *
 * The artifact is a per-platform bundle (platform/arch travel in its manifest,
 * the installer ships one, and `assertLayerTarget` refuses a foreign one), so
 * carrying another platform's binaries — or anything that is only ever read
 * while developing — is payload the user downloads and never runs. This runs
 * BEFORE the file inventory and the tarball, so both describe exactly what
 * ships: the inventory has no entry for a path that is not there, and the
 * layer split reassembles the tree the clients actually receive.
 *
 * The LibreOffice kit goes further than "wrong platform": it leaves the runtime
 * entirely (see runtimeFileExclusion), because the shell installs the engine on
 * demand. What must NOT leave is the provider that imports it statically — the
 * stub stageOfficeKitShim writes in its place — so the absence is asserted here,
 * right after the rule that produces it.
 *
 * @param runtimeDir - the runtime tree being assembled (the kernel dir).
 * @param platform - target platform of this artifact.
 * @param arch - target arch of this artifact.
 */
async function trimRuntimePayload(runtimeDir, platform, arch) {
  const modulesDir = path.join(runtimeDir, 'app', 'node_modules')
  if (!existsSync(modulesDir)) return
  const dropped = new Map()
  await pruneRuntimeTree(modulesDir, modulesDir, { platform, arch }, dropped)
  const totals = [...dropped.values()].reduce((sum, record) => ({ files: sum.files + record.files, bytes: sum.bytes + record.bytes }), { files: 0, bytes: 0 })
  if (totals.files > 0) {
    const detail = [...dropped.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([reason, record]) => `${reason} ${record.files} (${formatBytes(record.bytes)})`)
      .join(', ')
    console.log(`[build-runtime] trimmed ${platform}-${arch} payload: ${totals.files} files, ${formatBytes(totals.bytes)} (${detail})`)
  } else {
    console.log(`[build-runtime] trimmed ${platform}-${arch} payload: nothing to drop`)
  }
  // "The rules dropped every engine" and "the install never had one" fail the
  // same way on a user's machine — a payload that cannot be resolved — so a
  // leftover engine package is treated as a rule gap, not as a bonus copy: it
  // would ship ~330 MiB the payload artifact already carries, under a path the
  // shell's install never updates.
  const leftover = readdirSync(path.join(modulesDir, '@deepseek-ai'), { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => name === 'libreoffice-kit' || name.startsWith('libreoffice-kit-'))
  if (leftover.length > 0) {
    throw new Error(`the runtime tree still holds ${leftover.join(', ')} after the trim — the payload exclusion is incomplete`)
  }
}

/**
 * Put the kit loader shim where the provider imports it.
 *
 * `@deepseek-ai/dsh-office-to-pdf` imports `@deepseek-ai/libreoffice-kit` at
 * module scope, so with the real package gone the specifier must still resolve:
 * a runtime without it makes that plugin fail to LOAD, which surfaces as "the
 * plugin tree did not activate" rather than as "the engine is not installed".
 * The shim is a few hundred bytes that load the real kit out of the installed
 * payload at call time and refuse with an actionable message while it is absent
 * (scripts/runtime-stubs/libreoffice-kit).
 *
 * Written only when the provider is actually in the tree — the shim exists for
 * that one importer, and a package nothing imports is payload too.
 *
 * @param runtimeDir - the runtime tree being assembled (the kernel dir).
 * @returns the absolute stub directory, or null when no provider needs it.
 */
async function stageOfficeKitShim(runtimeDir) {
  const modulesDir = path.join(runtimeDir, 'app', 'node_modules')
  const providerDir = path.join(modulesDir, ...DESKTOP_OFFICE_PROVIDER_PACKAGE.split('/'))
  if (!existsSync(path.join(providerDir, 'package.json'))) {
    console.log(`[build-runtime] no ${DESKTOP_OFFICE_PROVIDER_PACKAGE} in the tree; no kit shim needed`)
    return null
  }
  const source = path.join(root, ...OFFICE_KIT_STUB_DIR)
  const target = path.join(modulesDir, ...DESKTOP_OFFICE_KIT_PACKAGE.split('/'))
  if (!existsSync(path.join(source, 'index.js'))) {
    throw new Error(`the kit shim is missing from ${source} — a runtime without it cannot load ${DESKTOP_OFFICE_PROVIDER_PACKAGE}`)
  }
  // The trim removed the directory; removing it again keeps this idempotent if
  // the rule ever changes.
  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true })
  for (const file of ['package.json', 'index.js']) {
    if (!existsSync(path.join(target, file))) throw new Error(`the staged kit shim at ${target} is missing ${file}`)
  }
  console.log(`[build-runtime] LibreOffice kit shim: ${OFFICE_KIT_STUB_DIR.join('/')} -> app/node_modules/${DESKTOP_OFFICE_KIT_PACKAGE}`)
  return target
}

/** sha512 (hex) of a file, streamed so a 100 MiB artifact is never buffered. */
async function sha512File(file) {
  const hash = createHash('sha512')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

/** One package key of a pnpm-lock.yaml `packages:` section, or undefined. */
function lockfilePackages(lockfileText) {
  const entries = []
  let inPackages = false
  for (const line of lockfileText.split(/\r?\n/u)) {
    if (/^packages:\s*$/u.test(line)) { inPackages = true; continue }
    if (!inPackages) continue
    if (/^\S/u.test(line)) break // next top-level section (snapshots:)
    const raw = /^ {2}(\S.*?):\s*$/u.exec(line)?.[1]
    if (raw === undefined) continue
    const key = (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))
      ? raw.slice(1, -1)
      : raw
    const at = key.lastIndexOf('@')
    if (at <= 0) throw new Error(`unexpected package key in pnpm-lock.yaml: ${key}`)
    entries.push({ name: key.slice(0, at), version: key.slice(at + 1) })
  }
  return entries
}

/**
 * Where a staged Python set comes from, or null when none is staged.
 *
 * `DSH_APP_PRIMARY_RUNTIME` names one explicitly: the release workflow stages it
 * per cell with `scripts/build-primary-runtime.mjs` (upstream's packaging does
 * the same at `<resources>/runtime/primary-runtime`; see its
 * `apps/desktop/scripts/prepare-primary-runtime.ts`). Unset — the local default —
 * means the payload carries the engine alone, which is why the host's
 * `load_workspace_dependencies` tool then fails with ENOENT on
 * `<payload>/primary-runtime/runtime.json`. A caller who stages one gets it
 * inside the payload, where that tool finds it as the child's primary-runtime
 * argument.
 *
 * @returns absolute path of the staged set, or null.
 * @throws when the variable names something that is not a primary runtime.
 */
function primaryRuntimeSource() {
  const configured = (process.env.DSH_APP_PRIMARY_RUNTIME ?? '').trim()
  if (configured === '') return null
  const source = path.resolve(configured)
  if (!existsSync(path.join(source, 'runtime.json'))) {
    throw new Error(`DSH_APP_PRIMARY_RUNTIME names ${source}, which holds no runtime.json — that is not a staged primary runtime`)
  }
  return source
}

/**
 * Build the office payload artifact: the LibreOffice kit, the target's engine,
 * and — when one is staged — the Python set the office skills run on.
 *
 * This is the half of "the runtime no longer carries the engine" that makes the
 * other half usable: the shell resolves this artifact through the SAME release
 * metadata chain as the runtime (official host first, mirrors as transport
 * only), verifies its sha512 and installs it under `<userData>/dsh-app-office`.
 *
 * The closure comes from a pnpm install of its own, not from a hand-picked list
 * of files: the kit's dependencies (fflate, fontkit, saxes and their own
 * closures) must resolve from beside the kit inside the payload, because the
 * payload is extracted OUTSIDE the runtime tree — Node would never reach
 * `app/node_modules` from there. `supportedArchitectures` makes pnpm install the
 * TARGET's engine even when the cell builds cross-target (windows-latest builds
 * win32-arm64), which is what the previous, in-tree arrangement could not do: it
 * could only keep an engine the build host itself had installed.
 *
 * @param work - build work directory (disposable).
 * @param runtimeDir - the assembled runtime tree, read for the kit's version.
 * @param platform - target platform of this artifact.
 * @param arch - target arch of this artifact.
 * @returns the payload manifest plus the artifact paths and size.
 * @throws when the payload would be unusable — no kit to copy or no engine for
 *   the target: an engine-less payload artifact answers nothing, and shipping
 *   one silently is worse than failing the cell that would produce it.
 */
async function buildOfficePayload(work, runtimeDir, platform, arch) {
  const modulesDir = path.join(runtimeDir, 'app', 'node_modules')
  const providerInstalled = existsSync(path.join(modulesDir, ...DESKTOP_OFFICE_PROVIDER_PACKAGE.split('/'), 'package.json'))
  const kitManifestPath = path.join(modulesDir, ...DESKTOP_OFFICE_KIT_PACKAGE.split('/'), 'package.json')
  if (!existsSync(kitManifestPath)) {
    // A line without the office provider needs no payload and no shim; one WITH
    // the provider but no kit is a broken install, and the payload is the only
    // way that provider can ever work.
    if (!providerInstalled) {
      console.log(`[build-runtime] no ${DESKTOP_OFFICE_PROVIDER_PACKAGE} in the tree; no office payload for this line`)
      return null
    }
    throw new Error(`no ${DESKTOP_OFFICE_KIT_PACKAGE} in the assembled tree (${kitManifestPath}) — ${DESKTOP_OFFICE_PROVIDER_PACKAGE} imports it and the payload has nothing to carry`)
  }
  let kitManifest
  try {
    kitManifest = JSON.parse(readFileSync(kitManifestPath, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read ${kitManifestPath}: ${err.message}`, { cause: err })
  }
  const kitVersion = kitManifest.version
  if (typeof kitVersion !== 'string' || kitVersion === '') {
    throw new Error(`${kitManifestPath} declares no version — the payload cannot be identified`)
  }
  const engine = selectOfficeEngine(kitManifest, platform, arch)
  const python = primaryRuntimeSource()
  const pythonVersion = python === null
    ? null
    : JSON.parse(await readFile(path.join(python, 'runtime.json'), 'utf8'))?.components?.python ?? null
  if (python !== null && (typeof pythonVersion !== 'string' || pythonVersion === '')) {
    throw new Error(`the staged primary runtime at ${python} declares no components.python`)
  }
  const payloadVersion = officePayloadVersion(kitVersion, pythonVersion)

  // The install project: one dependency, pinned by an override so the lockfile
  // assertion below can prove the tree holds exactly that kit.
  const projectDir = path.join(work, 'payload-project')
  await rm(projectDir, { recursive: true, force: true })
  await mkdir(projectDir, { recursive: true })
  await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'dsh-app-office-payload',
    private: true,
    version: kitVersion,
    dependencies: { [DESKTOP_OFFICE_KIT_PACKAGE]: kitVersion },
  }, null, 2))
  await writeFile(path.join(projectDir, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - '.'",
    '',
    '# Flat node_modules: the payload is extracted outside the runtime tree, so',
    '# the kit resolves its own dependencies (and its engine) from beside itself.',
    'nodeLinker: hoisted',
    '',
    '# See the note in the runtime assembly below: the resolution must not move',
    '# with the build date.',
    'minimumReleaseAge: 0',
    '',
    '# The engine for the TARGET, even when this cell builds cross-target',
    '# (windows-latest builds win32-arm64). The engine packages carry os/cpu',
    '# fields, so without this pnpm installs only the build host\'s own engine.',
    'supportedArchitectures:',
    '  os:',
    `    - ${platform}`,
    '  cpu:',
    `    - ${arch}`,
    '',
    'overrides:',
    `  '${DESKTOP_OFFICE_KIT_PACKAGE}': '${kitVersion}'`,
    '',
  ].join('\n'))

  const registry = registryUrl()
  const installArgs = ['install', '--registry', registry, '--package-import-method=copy']
  run(pnpmBin(), [...installArgs, '--lockfile-only'], projectDir)
  const locked = lockfilePackages(await readFile(path.join(projectDir, 'pnpm-lock.yaml'), 'utf8'))
  if (locked.length === 0) throw new Error('the payload lockfile has no packages: section — it is not usable')
  const kitEntries = locked.filter((entry) => entry.name === DESKTOP_OFFICE_KIT_PACKAGE)
  if (kitEntries.length !== 1 || kitEntries[0].version !== kitVersion) {
    throw new Error(
      `the payload lockfile resolved ${kitEntries.map((entry) => `${entry.name}@${entry.version}`).join(', ') || 'no kit'}`
      + `, expected exactly ${DESKTOP_OFFICE_KIT_PACKAGE}@${kitVersion}`,
    )
  }
  const stray = locked.filter((entry) => KERNEL_PACKAGE.test(entry.name))
  if (stray.length > 0) {
    throw new Error(`the payload lockfile pulled kernel packages (${stray.map((entry) => entry.name).join(', ')}) — the payload must depend on the kit alone`)
  }
  run(pnpmBin(), [...installArgs, '--prod', '--frozen-lockfile', '--trust-lockfile'], projectDir)

  // The tree that becomes the archive: payload/ with the manifest, the
  // installed closure and — when staged — the Python set.
  const payloadDir = path.join(work, PAYLOAD_ARCHIVE_DIR)
  await rm(payloadDir, { recursive: true, force: true })
  await mkdir(payloadDir, { recursive: true })
  const payloadModulesDir = path.join(payloadDir, PAYLOAD_MODULES_DIR)
  await rename(path.join(projectDir, 'node_modules'), payloadModulesDir)
  // Build-only pnpm state, exactly as the runtime assembly drops it (step 2c):
  // `.modules.yaml` records the store and virtual-store paths of the machine
  // that built the artifact AND a `prunedAt` timestamp, which would make two
  // builds of identical content differ byte for byte — the artifact's sha512 is
  // verified against the release sidecar, so an unreproducible payload is not
  // dangerous, but a machine-layout leak in a published file is pointless.
  // `.bin` is kept when present: it is a payload question, not bookkeeping.
  for (const entry of await readdir(payloadModulesDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('.') || entry.name === '.bin') continue
    if (['.modules.yaml', '.pnpm', '.pnpm-workspace-state-v1.json', '.pnpm-workspace-state.json'].includes(entry.name)) {
      await rm(path.join(payloadModulesDir, entry.name), { recursive: true, force: true })
      continue
    }
    console.warn(`[build-runtime] unexpected dot entry in the payload's node_modules: ${entry.name} — kept, please review`)
  }
  if (python !== null) {
    await cp(python, path.join(payloadDir, PAYLOAD_PRIMARY_RUNTIME_DIR), { recursive: true })
  }
  const manifest = createOfficePayloadManifest({
    payloadVersion, dshVersion: DSH_VERSION, platform, arch,
    kitVersion, engine, pythonVersion,
  })
  // Self-check against the same rules the shell applies to what it extracts
  // (officePayloadManifestProblems): the two halves of this contract are
  // separate implementations, and this is the only place the build can notice
  // it wrote a manifest the client would refuse.
  const manifestProblems = officePayloadManifestProblems(manifest, { platform, arch, engine }, payloadVersion)
  if (manifestProblems.length > 0) {
    throw new Error(`the payload manifest this build produced is not usable: ${manifestProblems.join('; ')}`)
  }
  await writeFile(path.join(payloadDir, PAYLOAD_MANIFEST_FILE), JSON.stringify(manifest, null, 2))

  const missing = officePayloadRequiredFiles(engine, manifest.components.python).filter((relative) => !existsSync(path.join(payloadDir, relative)))
  if (missing.length > 0) {
    throw new Error(
      `the payload for ${platform}-${arch} is missing ${missing.join(', ')}: no ${kitEnginePackage(engine)} engine was installed. `
      + 'The kit declares one engine package per target in its optionalDependencies, and pnpm installs the one '
      + `supportedArchitectures names — a failure here means no engine is published for ${platform}-${arch} `
      + '(or the kit does not declare one). An engine-less payload artifact cannot convert anything, refusing to publish it',
    )
  }
  const archiveBytes = await directorySize(payloadDir)
  console.log(
    `[build-runtime] office payload ${payloadVersion}: kit ${kitVersion}, engine ${engine}, `
    + `python ${pythonVersion ?? 'none'} (${formatBytes(archiveBytes)} unpacked)`,
  )

  const tgzPath = path.join(root, 'runtime-dist', officePayloadAssetName(platform, arch, DSH_VERSION))
  await createTar({ gzip: true, file: tgzPath, cwd: work, portable: true, mtime: new Date(0) }, [PAYLOAD_ARCHIVE_DIR])
  const sha512 = await sha512File(tgzPath)
  await writeFile(`${tgzPath}.sha512`, `${sha512}\n`)
  // The release metadata copy carries what the in-archive manifest must not:
  // integrity of the archive containing it, and a build timestamp.
  await writeFile(
    path.join(root, 'runtime-dist', officePayloadManifestName(platform, arch)),
    `${JSON.stringify({ ...manifest, integrity: sha512, publishedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  return { manifest, tgzPath, sha512, bytes: statSync(tgzPath).size, unpackedBytes: archiveBytes }
}

/** Total byte size of every file under a tree. */
async function directorySize(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(full)
    else total += statSync(full, { throwIfNoEntry: false })?.size ?? 0
  }
  return total
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
  // The host the shell starts the kernel with, plus the UI it serves. Both have
  // to be in the tree or the packaged app cannot boot at all — the node/ binary
  // beside them is no longer the kernel's entry point. The host is built from
  // the kernel line's own tag (prepareDesktopHostSource), so this step is what
  // makes a release from an older line fail instead of shipping a mixed pair.
  // The office payload the host reads beside itself is staged in the same call.
  const host = await packDesktopHost(pkgsDir, work, runtimeDir)

  const appPkg = {
    name: 'dsh-app-runtime',
    private: true,
    version: DSH_VERSION,
    dependencies: {
      '@deepseek-ai/dsh': DSH_VERSION,
      // The web frontend the host serves as the UI, pinned to this kernel line.
      [WEB_FRONTEND_PACKAGE]: DSH_VERSION,
      // Everything the host imports at run time, derived from its own manifest:
      // most of it already arrives transitively through `@deepseek-ai/dsh`, but
      // the host's own closure is what the runtime must guarantee, and deriving
      // it here means a package it starts needing joins the tree automatically.
      ...Object.fromEntries(host.dependencies
        .filter((name) => name !== '@deepseek-ai/dsh')
        .map((name) => [name, DSH_VERSION])),
      [DESKTOP_HOST_PACKAGE]: host.spec,
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
    // The exact key outranks the wildcard for the private host: that package is
    // not on npm, so a wildcard resolution would fail the install (loudly, but
    // only after the whole download).
    `  '${DESKTOP_HOST_PACKAGE}': '${host.spec}'`,
    ...SUITE_PLUGINS.map((name) => `  '${name}': '${suiteSpecs[name]}'`),
    '',
  ].join('\n'))

  // The registry is pinned explicitly instead of relying on the build host's
  // npmrc: pnpm reads the user config (~/.npmrc) and has no --userconfig
  // equivalent, so a machine-level `registry=` would silently change what the
  // artifact contains. An explicit NPM_CONFIG_REGISTRY still wins (mirror
  // builds), matching what the empty --userconfig file did for npm. npm's
  // --no-audit/--no-fund have no pnpm counterpart and are not needed: pnpm
  // audits nothing during install and has no funding message. registryUrl()
  // holds the same rule for the host install above.
  const registry = registryUrl()
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
  const locked = assertLockfileCore(await readFile(lockfilePath, 'utf8'), DESKTOP_HOST_PACKAGE)
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
  // Build-only pnpm state inside node_modules. .bin stays here — it is a
  // payload question, not bookkeeping, and step 2d decides it with the rest of
  // the target-scoped omissions.
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

  // 2d. The office payload, from the tree that still has the kit: the engine
  //     (~330 MiB unpacked) leaves the runtime for its own artifact here, and
  //     the trim below is what actually drops it. The payload is built FIRST
  //     because it reads the kit's version and engine declaration out of the
  //     assembled tree.
  const officePayload = await buildOfficePayload(work, runtimeDir, platform, arch)

  // 2e. Target-scoped payload: drop what this platform/arch can never load —
  //     above all the whole LibreOffice kit, which now travels in the payload
  //     artifact above — plus the build and diagnostic files that only matter to
  //     a developer. Runs before the inventory below, so the inventory and the
  //     tarball describe the same tree, and before the layer split, which reads
  //     the artifact.
  await trimRuntimePayload(runtimeDir, platform, arch)

  // 2f. The loader shim that keeps `@deepseek-ai/dsh-office-to-pdf` loadable
  //     now that the real kit is gone. AFTER the trim, because the trim is what
  //     removes the package it replaces.
  await stageOfficeKitShim(runtimeDir)

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
    // The node binary this runtime bundles. The shell compares it with the
    // Node inside Electron: when Electron's is at least as new, the kernel
    // runs on Electron's own node and this binary is dead weight. Runtimes
    // built before the field existed read as "unknown", which keeps the
    // bundled binary — an older kernel keeps working unchanged.
    node: process.version.replace(/^v/, ''),
    // The office payload artifact this kernel needs, for the shell to resolve
    // and install on demand. Named fields rather than a bare version string:
    // the shell reports them, and a payload built for another cell must be
    // refusable before a byte is downloaded.
    ...(officePayload === null ? {} : { officePayload: {
      version: officePayload.manifest.payloadVersion,
      platform: officePayload.manifest.platform,
      arch: officePayload.manifest.arch,
      engine: officePayload.manifest.components.engine,
      python: officePayload.manifest.components.python,
    } }),
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

  // 5. Per-file inventory (path, size, sha256, exec bit) plus its links —
  //    written inside the archive so it reaches users the same way the artifact
  //    does, plus a copy beside the tarball for release-time audits that must
  //    not unpack 100 MB. It is a pure function of the tree, so it is also the
  //    reproducibility check: two builds of one version must produce the same
  //    list.
  const inventory = await writeFileInventory(runtimeDir, manifest)
  await writeFile(
    path.join(root, 'runtime-dist', `runtime-files-${platform}-${arch}.json`),
    `${JSON.stringify(inventory, null, 2)}\n`,
  )
  console.log(`[build-runtime] inventory: ${inventory.fileCount} files, ${inventory.linkCount} links listed in runtime/app/runtime-files.json`)

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
  console.log(`runtime size: ${formatBytes(statSync(tgzPath).size)} (${inventory.fileCount} files, ${formatBytes(unpackedRuntimeBytes(inventory))} unpacked)`)
  console.log(`sha512: ${sha512}`)
  if (officePayload !== null) {
    console.log(`\nOffice payload artifact ready: ${officePayload.tgzPath}`)
    console.log(`payload size: ${formatBytes(officePayload.bytes)} (${formatBytes(officePayload.unpackedBytes)} unpacked), version ${officePayload.manifest.payloadVersion}, engine ${officePayload.manifest.components.engine}`)
    console.log(`payload sha512: ${officePayload.sha512}`)
  }
  await rm(work, { recursive: true, force: true })
}

/** Sum of the inventory's file sizes — the unpacked runtime, as the artifact ships it. */
function unpackedRuntimeBytes(inventory) {
  return inventory.files.reduce((total, file) => total + file.size, 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
