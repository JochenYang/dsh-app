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
 *   runtime/node/            — the Node.js binary (copied from this process)
 *   runtime/app/             — npm-installed dsh profile (package.json + node_modules)
 *   dsh-runtime-<platform>-<arch>-<version>.tgz
 *   dsh-runtime-<platform>-<arch>-<version>.tgz.sha512
 *
 * The suite plugins (@dsh-app/plugin-*) join the runtime via file: references
 * in app/package.json; switch to registry versions once they are published.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { c as createTar } from 'tar'
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
 * FFF native binding version, derived from the plugin that declares it (plugins
 * are copied into node_modules by hand, never npm-installed, so the runtime's
 * app/package.json must carry the binding itself). Reading it here keeps the
 * runtime install and the plugin spec in lockstep.
 */
const FFF_NODE_PIN = JSON.parse(readFileSync(path.join(root, 'plugins', '@dsh-app/plugin-fff'.replace('@dsh-app/', ''), 'package.json'), 'utf8')).dependencies['@ff-labs/fff-node']

// The plugin roster and the suite version it hashes to both come from
// scripts/kernel-line.mjs — the same module the release workflow reads to
// decide whether a published runtime can be reused, so the two can never
// disagree about what "the current suite" is.
const SUITE_VERSION = computeSuiteVersion()

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
function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const opts = { cwd, stdio: 'inherit' }
  // Windows runners: Node 22.12+ no longer wraps .cmd via cmd.exe implicitly
  // (CVE-2024-27980 mitigation), so shell is required; pass one joined line
  // instead of args to avoid DEP0190. Every token is strictly quoted so paths
  // with spaces (e.g. under Program Files) cannot split or inject.
  // npm resolves to an absolute path beside the running node: a bare
  // `npm.cmd` lets cmd.exe prefer a same-named file under the cwd (a plugin
  // dir whose node_modules happens to ship npm shims), running the wrong
  // cli.js and failing with a missing-module error.
  if (process.platform === 'win32') {
    if (cmd === 'npm.cmd' || cmd === 'npm') cmd = npmBin()
    execFileSync([cmd, ...args].map(quoteWinArg).join(' '), { ...opts, shell: true })
  } else execFileSync(cmd, args, opts)
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
  await downloadNodeBinary(platform, arch, path.join(runtimeDir, 'node'))

  // 2. npm-installed dsh profile. The suite plugins are NOT declared as
  //    file: dependencies here — a relative file: path resolves outside the
  //    runtime dir and breaks on a clean CI checkout (and would become a
  //    dangling symlink once tarred). Instead we npm install dsh alone, then
  //    copy each plugin's built lib/ + package.json into node_modules by hand
  //    so the runtime is fully self-contained.
  for (const name of SUITE_PLUGINS) {
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], path.join(root, 'plugins', name.replace('@dsh-app/', '')))
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
    },
  }
  await writeFile(path.join(runtimeDir, 'app', 'package.json'), JSON.stringify(appPkg, null, 2))
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'], path.join(runtimeDir, 'app'))

  // 2a. npm --legacy-peer-deps skips ALL peer resolution, so second-level
  //     peers (peers of dsh's peers, e.g. dsh-timeout, dsh-scope, dsh-sandbox)
  //     are missing and crash dsh at boot. Scan every installed package's
  //     peerDependencies and add any that are absent from node_modules as
  //     direct dependencies, then reinstall. Generic: new peers added by
  //     future dsh versions are picked up automatically.
  const nmDir = path.join(runtimeDir, 'app', 'node_modules')
  const missingPeers = new Set()
  // Recursively walk every package.json under node_modules (including nested
  // node_modules of transitive deps) and collect declared peers. The old scan
  // only looked one level deep, so peers declared by transitive dependencies
  // were missed and crashed dsh at boot. Symlinks and .bin are skipped so the
  // walk cannot loop or descend into bin shims.
  function collectPeers(dir) {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name === '.bin') continue
      const sub = path.join(dir, entry.name)
      if (entry.name === 'node_modules') { collectPeers(sub); continue }
      const pj = path.join(sub, 'package.json')
      if (existsSync(pj)) {
        try {
          const pkg = JSON.parse(readFileSync(pj, 'utf8'))
          if (pkg.peerDependencies) {
            for (const peer of Object.keys(pkg.peerDependencies)) {
              // Check if this peer exists in the flattened top-level node_modules.
              if (!existsSync(path.join(path.join(nmDir, peer), 'package.json'))) {
                missingPeers.add(peer)
              }
            }
          }
        } catch { /* unreadable manifest: ignore */ }
      }
      collectPeers(sub)
    }
  }
  collectPeers(nmDir)
  if (missingPeers.size > 0) {
    const npm = npmBin()
    const peerSpecs = {}
    for (const name of missingPeers) {
      // Array form with shell:true trips DEP0190 on newer Node; on Windows pass
      // one strictly-quoted line instead (same discipline as run()).
      const ver = (process.platform === 'win32'
        ? execFileSync([npm, 'view', name, 'version'].map(quoteWinArg).join(' '), { encoding: 'utf8', shell: true })
        : execFileSync(npm, ['view', name, 'version'], { encoding: 'utf8' })).trim()
      peerSpecs[name] = name.startsWith('@deepseek-ai/dsh-') ? `^${DSH_VERSION}` : `^${ver}`
      console.log(`missing peer: ${name}@${peerSpecs[name]}`)
    }
    appPkg.dependencies = { ...appPkg.dependencies, ...peerSpecs }
    await writeFile(path.join(runtimeDir, 'app', 'package.json'), JSON.stringify(appPkg, null, 2))
    run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'], path.join(runtimeDir, 'app'))
  }

  // 2b. Copy the built suite plugins into the runtime's node_modules so dsh
  //     can resolve them. Each plugin ships its package.json (for the main
  //     field) + the lib/ build output; no source or external paths needed.
  const nmScope = path.join(runtimeDir, 'app', 'node_modules', '@dsh-app')
  await mkdir(nmScope, { recursive: true })
  for (const name of SUITE_PLUGINS) {
    const shortName = name.replace('@dsh-app/', '')
    const srcDir = path.join(root, 'plugins', shortName)
    const destDir = path.join(nmScope, shortName)
    await mkdir(destDir, { recursive: true })
    await cp(path.join(srcDir, 'package.json'), path.join(destDir, 'package.json'))
    await cp(path.join(srcDir, 'lib'), path.join(destDir, 'lib'), { recursive: true })
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

  // 5. Tar the runtime directory (single top-level dir: runtime/).
  //    Reproducible archive: `portable` strips uid/gid/uname/gname/atime/ctime
  //    (header fields that vary per CI runner) and `mtime` pins every entry to
  //    the epoch, so the same content always yields the same sha512 — the
  //    precondition for the shell's drift check (sha-equal ⇔ content-equal).
  const tgzPath = path.join(root, 'runtime-dist', tgzName)
  await createTar({ gzip: true, file: tgzPath, cwd: work, portable: true, mtime: new Date(0) }, ['runtime'])

  // 6. sha512 sidecar — the trusted integrity value used at install time.
  const hash = createHash('sha512')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(tgzPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  const sha512 = hash.digest('hex')
  await writeFile(`${tgzPath}.sha512`, `${sha512}\n`)
  await rm(path.join(runtimeDir, 'app', 'node_modules', '.package-lock.json'), { force: true })

  // 7. Release-metadata copy of the manifest with the real integrity and the
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
