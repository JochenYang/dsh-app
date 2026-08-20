#!/usr/bin/env node
/**
 * Builds a dsh kernel runtime artifact (CI + local).
 *
 * Usage:
 *   node scripts/build-runtime.mjs <platform> <arch> [version]
 *
 * Example:
 *   node scripts/build-runtime.mjs win32 x64 0.1.0-rc.7
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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { c as createTar } from 'tar'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [platform = process.platform, arch = process.arch, versionArg] = process.argv.slice(2)

const DSH_VERSION = versionArg?.trim() || process.env.DSH_VERSION?.trim() || '0.1.0-rc.8'
const SUITE_VERSION = process.env.DSH_APP_SUITE_VERSION ?? '0.1.0'
const CHANNEL = process.env.DSH_APP_CHANNEL ?? 'stable'

const suitePlugins = ['@dsh-app/plugin-brand', '@dsh-app/plugin-client-ui']

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const opts = { cwd, stdio: 'inherit' }
  // Windows runners: Node 22.12+ no longer wraps .cmd via cmd.exe implicitly
  // (CVE-2024-27980 mitigation), so shell is required; pass the joined line
  // instead of args to avoid DEP0190. args here are script-built constants.
  if (process.platform === 'win32') execFileSync(`${cmd} ${args.join(' ')}`, { ...opts, shell: true })
  else execFileSync(cmd, args, opts)
}

// Map a (platform, arch) to the nodejs.org dist tuple. nodejs.org uses
// 'win'|'darwin'|'linux' and 'x64'|'arm64'; our caller already passes those.
const NODE_DIST_PLATFORM = { win32: 'win', darwin: 'darwin', linux: 'linux' }
const NODE_DIST_EXT = { win32: 'zip', darwin: 'tar.gz', linux: 'tar.xz' }

async function downloadNodeBinary(platform, arch, destDir) {
  const ver = process.version // e.g. v22.x — matches the runtime's own major
  const distPlatform = NODE_DIST_PLATFORM[platform]
  if (!distPlatform) throw new Error(`unsupported platform for node download: ${platform}`)
  const ext = NODE_DIST_EXT[platform]
  const base = process.env.NODE_DIST_MIRROR?.replace(/\/$/, '') || 'https://nodejs.org/dist'
  const archiveName = `node-${ver}-${distPlatform}-${arch}`
  const url = `${base}/${ver}/${archiveName}.${ext}`
  const archivePath = path.join(destDir, `node-archive.${ext}`)
  console.log(`$ download ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`node dist download failed (${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
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
  for (const name of suitePlugins) {
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], path.join(root, 'plugins', name.replace('@dsh-app/', '')))
  }
  const appPkg = {
    name: 'dsh-app-runtime',
    private: true,
    version: DSH_VERSION,
    dependencies: {
      '@deepseek-ai/dsh': DSH_VERSION,
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
  const nmDeep = path.join(nmDir, '@deepseek-ai')
  const missingPeers = new Set()
  // Walk every package.json under node_modules and collect declared peers.
  for (const scopeDir of [nmDir, nmDeep].filter(existsSync)) {
    for (const entry of readdirSync(scopeDir)) {
      const pkgDirs = scopeDir === nmDeep ? [path.join(scopeDir, entry)] : (entry.startsWith('@') ? [] : [path.join(scopeDir, entry)])
      for (const pkgDir of pkgDirs) {
        const pj = path.join(pkgDir, 'package.json')
        if (!existsSync(pj)) continue
        const pkg = JSON.parse(readFileSync(pj, 'utf8'))
        if (!pkg.peerDependencies) continue
        for (const peer of Object.keys(pkg.peerDependencies)) {
          // Check if this peer exists anywhere in the flattened node_modules.
          const peerPath = peer.startsWith('@')
            ? path.join(nmDir, peer)
            : path.join(nmDir, peer)
          if (!existsSync(path.join(peerPath, 'package.json'))) {
            missingPeers.add(peer)
          }
        }
      }
    }
  }
  if (missingPeers.size > 0) {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const peerSpecs = {}
    for (const name of missingPeers) {
      const ver = execFileSync(npmBin, ['view', name, 'version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
      peerSpecs[name] = name.startsWith('@deepseek-ai/dsh-') ? `^${DSH_VERSION}` : `^${ver}`
      console.log(`missing peer: ${name}@${peerSpecs[name]}`)
    }
    appPkg.dependencies = { ...appPkg.dependencies, ...peerSpecs }
    await writeFile(path.join(runtimeDir, 'app', 'package.json'), JSON.stringify(appPkg, null, 2))
    run(npmBin, ['install', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'], path.join(runtimeDir, 'app'))
  }

  // 2b. Copy the built suite plugins into the runtime's node_modules so dsh
  //     can resolve them. Each plugin ships its package.json (for the main
  //     field) + the lib/ build output; no source or external paths needed.
  const nmScope = path.join(runtimeDir, 'app', 'node_modules', '@dsh-app')
  await mkdir(nmScope, { recursive: true })
  for (const name of suitePlugins) {
    const shortName = name.replace('@dsh-app/', '')
    const srcDir = path.join(root, 'plugins', shortName)
    const destDir = path.join(nmScope, shortName)
    await mkdir(destDir, { recursive: true })
    await cp(path.join(srcDir, 'package.json'), path.join(destDir, 'package.json'))
    await cp(path.join(srcDir, 'lib'), path.join(destDir, 'lib'), { recursive: true })
  }

  // 3. Runtime manifest.
  const tgzName = `dsh-runtime-${platform}-${arch}-${DSH_VERSION}.tgz`
  const manifest = {
    dshVersion: DSH_VERSION,
    suiteVersion: SUITE_VERSION,
    channel: CHANNEL,
    platform,
    arch,
    integrity: '', // filled after tarring
    publishedAt: new Date().toISOString(),
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
  const tgzPath = path.join(root, 'runtime-dist', tgzName)
  await createTar({ gzip: true, file: tgzPath, cwd: work }, ['runtime'])

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

  // 7. Release-metadata copy of the manifest with the real integrity filled in.
  manifest.integrity = sha512
  await writeFile(path.join(root, 'runtime-dist', 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`\nRuntime artifact ready: ${tgzPath}`)
  console.log(`sha512: ${sha512}`)
  await rm(work, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
