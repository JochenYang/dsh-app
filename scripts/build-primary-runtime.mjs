#!/usr/bin/env node
/**
 * Builds the "primary runtime" — the pinned Python + Node.js + pnpm set the
 * desktop host's `load_workspace_dependencies` tool hands to an agent.
 *
 * Usage:
 *   node scripts/build-primary-runtime.mjs <platform> <arch> [outDir]
 *
 * Example:
 *   node scripts/build-primary-runtime.mjs win32 x64
 *   node scripts/build-primary-runtime.mjs darwin arm64 runtime-dist/primary-runtime-darwin-arm64
 *
 * Why it exists: the runtime artifact is downloaded by every user on every
 * kernel update and the Python set is only needed once an Office document is
 * authored or converted, so this tree travels inside the OFFICE payload (see
 * `DSH_APP_PRIMARY_RUNTIME` in scripts/build-runtime.mjs) instead of the runtime
 * itself. The host's tool refuses to answer without it: it installs the payload's
 * `primary-runtime/` under `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` on the
 * first tool call and answers absolute paths into that copy.
 *
 * What the tree must look like is NOT decided here: it is the layout
 * `workspaceDependencyPaths` returns in upstream's
 * `apps/desktop-host/src/primary-runtime.ts`, and the `runtime.json` fields
 * `readPrimaryRuntime` validates there. That module is deliberately not imported
 * (this build must not need a harness checkout), so the layout is restated in
 * {@link workspaceLayout} and checked against the real function by
 * `scripts/smoke-primary-runtime.mjs`, which runs the host's own module.
 *
 * Every input is pinned by digest in `scripts/primary-runtime-lock.json`: the
 * Node.js dist archive and the python-build-standalone archive per target, the
 * wheels (with their transitive dependencies), and the pnpm npm package. A
 * download that does not match its digest fails the build — a mirror is a
 * transport, never a source of content.
 *
 * Targets: win32-x64, win32-arm64 (both arches of this app's Windows installer),
 * darwin-x64 and darwin-arm64. Linux is NOT a target: `readPrimaryRuntime`
 * accepts only `win32` and `darwin` manifests, and `installPrimaryRuntime`
 * refuses a manifest whose platform is not the running one, so a linux payload
 * could never be installed — linux cells build the office payload without it.
 *
 * Proxies: the script uses global `fetch`, which ignores `HTTP_PROXY`/
 * `HTTPS_PROXY` unless Node is told to honour them — run it as
 * `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://host:port node scripts/build-primary-runtime.mjs …`
 * when direct downloads are blocked.
 *
 * @module dsh-app/scripts/build-primary-runtime
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { x as extractTar } from 'tar'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Pinned inputs; see the module header for what each record covers. */
const LOCK = JSON.parse(readFileSync(path.join(root, 'scripts', 'primary-runtime-lock.json'), 'utf8'))

/** Release the Python archives come from (astral-sh/python-build-standalone). */
const PYTHON_RELEASE_BASE = 'https://github.com/astral-sh/python-build-standalone/releases/download'

/** Official Node.js distribution host. */
const NODE_DIST_BASE = 'https://nodejs.org/dist'

/**
 * Registries the pnpm tarball may come from, in order: the digest decides which
 * one wins, so the chain only costs a retry. npmmirror first for the same reason
 * the shell's own registry chain puts it there — every other package input of
 * this build comes from a domestic-reachable host.
 */
const PNPM_REGISTRY_BASE = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

/** Where verified downloads are cached, so a rebuild does not re-download them. */
const CACHE_DIR = path.join(root, 'runtime-dist', '.primary-runtime-cache')

/** Per-request ceiling for the archive downloads; a stalled link must fail the build. */
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000

/** Human-readable byte size for the build log. */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${String(bytes)} B`
}

function log(line) {
  console.log(`[build-primary-runtime] ${line}`)
}

/** Lock key of one (platform, arch) cell, named as upstream's own lock names it. */
function targetName(platform, arch) {
  return platform === 'win32' ? `win-${arch}` : `mac-${arch}`
}

/**
 * Platform tags a wheel may carry for one target. A pure-Python wheel is valid
 * everywhere; a binary one is only valid for the target it was built for, and
 * `universal2` is the macOS wheel that serves both arches (lxml publishes one
 * instead of per-arch builds).
 */
const WHEEL_TAGS = {
  'win-x64': /-(?:win_amd64|none-any)\.whl$/u,
  'win-arm64': /-(?:win_arm64|none-any)\.whl$/u,
  'mac-x64': /-(?:macosx_\d+_\d+_(?:x86_64|universal2)|none-any)\.whl$/u,
  'mac-arm64': /-(?:macosx_\d+_\d+_(?:arm64|universal2)|none-any)\.whl$/u,
}

/**
 * The target's pinned inputs, or a failure naming the cells that do exist.
 *
 * Every wheel is checked against two rules the extraction itself cannot see: its
 * platform tag must belong to this target (a `win_amd64` wheel in the arm64 cell
 * would install a library that cannot load), and a compiled wheel must be built
 * for the pinned Python's ABI (`cp312`). Both are lock errors that would
 * otherwise surface as a broken document conversion in a released build.
 */
function targetLock(platform, arch) {
  const name = targetName(platform, arch)
  const entry = LOCK.targets[name]
  if (entry === undefined) {
    throw new Error(`no primary runtime is pinned for ${platform}-${arch} (lock targets: ${Object.keys(LOCK.targets).join(', ')})`)
  }
  const abi = `cp${LOCK.pythonVersion.split('.').slice(0, 2).join('')}`
  for (const wheel of [...entry.wheels, ...LOCK.wheels]) {
    const filename = wheel.url.split('/').pop() ?? ''
    if (!WHEEL_TAGS[name].test(filename)) throw new Error(`${filename} is not a ${name} wheel`)
    if (!filename.includes('-none-any.whl') && !filename.includes(`-${abi}-`)) {
      throw new Error(`${filename} is not built for ${abi} (the pinned Python is ${LOCK.pythonVersion})`)
    }
  }
  return { name, entry }
}

/**
 * The directory layout the host's tool answers with, restated from
 * `workspaceDependencyPaths` (apps/desktop-host/src/primary-runtime.ts).
 *
 * The build cannot import that module — it must run without a harness checkout —
 * so the two copies exist and `scripts/smoke-primary-runtime.mjs` is what keeps
 * them equal: it asks the host's own function for these paths and fails when any
 * of them is missing from the tree this script produced.
 *
 * @param outDir - staged primary runtime root.
 * @param platform - `win32` or `darwin`.
 * @param pythonVersion - `components.python`, e.g. `3.12.14`.
 * @returns absolute paths of the files and directories the host exposes.
 */
function workspaceLayout(outDir, platform, pythonVersion) {
  const dependencies = path.join(outDir, 'dependencies')
  const windows = platform === 'win32'
  return {
    python: path.join(dependencies, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
    node: path.join(dependencies, 'node', 'bin', windows ? 'node.exe' : 'node'),
    pnpm: path.join(dependencies, 'pnpm', 'bin', 'pnpm.mjs'),
    pythonPackages: path.join(dependencies, 'python', ...(windows
      ? ['Lib', 'site-packages']
      : ['lib', `python${pythonVersion.split('.').slice(0, 2).join('.')}`, 'site-packages'])),
    nodePackages: path.join(dependencies, 'node', 'node_modules'),
  }
}

/**
 * The payload identity of one target's inputs, computed exactly as upstream's
 * `primaryRuntimePayloadDigest` computes it (format 2, same field order).
 *
 * Why the identical formula: the host compares this digest against the manifest
 * of an already installed tree to decide whether it must reinstall, so a payload
 * staged here and one staged by upstream's packaging must agree for identical
 * inputs — and a payload change that keeps the inputs must bump the format,
 * which is the same rule upstream documents.
 *
 * @param name - lock target name (`win-x64`).
 * @param pnpmVersion - version of the pnpm package the payload carries.
 * @returns lowercase hex SHA-256.
 */
function payloadDigest(name, pnpmVersion) {
  const { pythonVersion, pythonRelease, nodeVersion, wheels, pythonPackages } = LOCK
  return createHash('sha256').update(JSON.stringify({
    format: 2, target: name, pythonVersion, pythonRelease, nodeVersion,
    artifact: LOCK.targets[name], wheels, pythonPackages, pnpm: pnpmVersion,
  })).digest('hex')
}

/** Hex digest of a buffer, `algorithm` being any createHash name. */
function digestOf(buffer, algorithm) {
  return createHash(algorithm).update(buffer).digest('hex')
}

/** True when `error` is a Node filesystem error with the given code. */
function isErrorWithCode(error, code) {
  return typeof error === 'object' && error !== null && error.code === code
}

/**
 * Fetch one pinned artifact into the cache, verifying it on every run.
 *
 * The cache is keyed by the digest, never by URL: two targets sharing a wheel
 * share one file, and a corrupt cache entry fails the build instead of being
 * silently extracted. `npm` is deliberately not involved — these are direct
 * artifact downloads whose bytes the lock pins, and a package manager would add
 * resolution, install scripts and a lockfile of its own.
 *
 * @param url - pinned download URL.
 * @param expected - expected digest, encoded as the lock records it: lowercase
 *   hex for `sha256`, base64 for `sha512` (npm's own integrity encoding).
 * @param algorithm - `sha256` (Python/Node/wheels) or `sha512` (pnpm).
 * @returns absolute path of the verified file in the cache.
 */
async function fetchPinned(url, expected, algorithm) {
  const expectedHex = algorithm === 'sha256' ? expected : Buffer.from(expected, 'base64').toString('hex')
  const cached = path.join(CACHE_DIR, expectedHex)
  if (existsSync(cached)) {
    const bytes = await readFile(cached)
    if (digestOf(bytes, algorithm) === expectedHex) return cached
    log(`cache entry ${expectedHex} does not match its digest — re-downloading`)
    await rm(cached, { force: true })
  }
  await mkdir(CACHE_DIR, { recursive: true })
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`download failed (${String(response.status)}): ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const got = digestOf(bytes, algorithm)
  if (got !== expectedHex) throw new Error(`${algorithm} mismatch for ${url}: expected ${expectedHex}, got ${got}`)
  await writeFile(cached, bytes)
  log(`downloaded ${formatBytes(bytes.length)} ${algorithm}-verified: ${url}`)
  return cached
}

/**
 * Fetch one pinned artifact from the first candidate that serves matching bytes.
 *
 * Candidate order is a transport question only: every candidate is checked
 * against the same digest, so a mirror that serves different bytes fails and the
 * next candidate is tried instead of the build continuing with them.
 *
 * @param urls - candidate URLs, in preference order.
 * @param expected - expected digest, encoded as {@link fetchPinned} documents.
 * @param algorithm - `sha256` or `sha512`.
 * @returns absolute path of the verified file in the cache.
 */
async function fetchPinnedFrom(urls, expected, algorithm) {
  let lastError
  for (const url of urls) {
    try {
      return await fetchPinned(url, expected, algorithm)
    } catch (error) {
      lastError = error
      log(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw lastError
}

/** Escape a value for a single-quoted PowerShell string. */
function psQuote(value) {
  return `'${value.replace(/'/gu, "''")}'`
}

/** Run PowerShell quietly and capture stdout as text. */
function powershell(script) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

/**
 * Entry names of a zip archive, in archive order.
 *
 * Wheels are zips and Node has no zip reader, so this and {@link extractZip} use
 * the platform's own tool — PowerShell/.NET on Windows (the same tool
 * scripts/build-runtime.mjs expands the Node dist zip with) and Info-ZIP's
 * `unzip` elsewhere. Nothing here parses the format.
 *
 * @param archive - absolute path of the archive.
 * @returns entry paths exactly as stored, `/`-separated.
 */
function listZipEntries(archive) {
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; `
      + `$zip = [IO.Compression.ZipFile]::OpenRead(${psQuote(archive)}); `
      + `$zip.Entries | ForEach-Object { $_.FullName }; $zip.Dispose()`
    return powershell(script).split(/\r?\n/u).filter((line) => line !== '')
  }
  return execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split(/\r?\n/u).filter((line) => line !== '')
}

/**
 * Expand a zip archive into a directory.
 *
 * Windows goes through .NET rather than `Expand-Archive`: that cmdlet refuses an
 * archive whose path does not end in `.zip` (the download cache names files by
 * digest, so it does not), and the calling step must overwrite entries because
 * several wheels expand into ONE site-packages directory — `-Force` covers that
 * but nothing in `Expand-Archive` covers the name. Measured on a windows-latest
 * runner, where the old fallback failed the whole cell; `unzip` is not present
 * there either.
 *
 * @param archive - absolute path of the archive.
 * @param destination - directory to expand into (created by the tool at need).
 */
function extractZip(archive, destination) {
  if (process.platform === 'win32') {
    const script = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; '
      + `$zip = [IO.Compression.ZipFile]::OpenRead(${psQuote(archive)}); `
      + 'try { foreach ($entry in $zip.Entries) { '
      + `$target = Join-Path ${psQuote(destination)} $entry.FullName; `
      + 'if ($entry.Name -eq "") { continue } '
      + '$dir = Split-Path -Parent $target; '
      + 'if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }; '
      + '[IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true) } } '
      + 'finally { $zip.Dispose() }'
    powershell(script)
    return
  }
  execFileSync('unzip', ['-q', '-o', archive, '-d', destination], { stdio: 'inherit' })
}

/**
 * Unpack one wheel into site-packages, refusing a wheel that needs an installer
 * step this build does not perform.
 *
 * The guard is upstream's (`unpackPrimaryRuntimeWheel`): a wheel whose `.data`
 * tree carries anything but `scripts` needs a scheme-specific destination this
 * extraction does not know, and silently dropping it would ship an incomplete
 * library. Every wheel in the lock is a plain one; the check is what keeps a
 * lock update from introducing the failure quietly.
 *
 * @param archive - verified wheel archive.
 * @param sitePackages - absolute site-packages directory.
 * @param label - wheel file name, for the failure message.
 */
async function unpackWheel(archive, sitePackages, label) {
  for (const entry of listZipEntries(archive)) {
    const [directory, scheme = ''] = entry.split('/')
    if (directory?.endsWith('.data') === true && scheme !== 'scripts') {
      throw new Error(`${label}: the wheel installs ${entry}, which needs an installation scheme this build cannot honour`)
    }
  }
  await mkdir(sitePackages, { recursive: true })
  extractZip(archive, sitePackages)
}

/** Distribution name normalization (PEP 503): lowercase, runs of `-_.` to `-`. */
function normalizeDistribution(name) {
  return name.toLowerCase().replace(/[-_.]+/gu, '-')
}

/**
 * Check the installed set against the versions the lock records.
 *
 * `pythonPackages` is what the host reports to the agent and what `runtime.json`
 * is validated against, so a wheel that extracted to a different distribution
 * than the lock names — or one that did not install at all — must fail the build
 * rather than travel as a claim.
 *
 * @param sitePackages - absolute site-packages directory the wheels filled.
 */
async function assertInstalledDistributions(sitePackages) {
  const installed = new Map()
  for (const entry of await readdir(sitePackages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue
    const match = /^(?<name>.+?)-(?<version>[^-]+)\.dist-info$/u.exec(entry.name)
    if (match?.groups === undefined) continue
    installed.set(normalizeDistribution(match.groups.name), match.groups.version)
  }
  const problems = []
  for (const [name, version] of Object.entries(LOCK.pythonPackages)) {
    const found = installed.get(normalizeDistribution(name))
    if (found === undefined) problems.push(`${name} ${version} is not installed`)
    else if (found !== version) problems.push(`${name} installed as ${found}, lock pins ${version}`)
  }
  if (problems.length > 0) throw new Error(`the extracted wheels do not match the lock: ${problems.join('; ')}`)
}

/**
 * Assemble one target's primary runtime and move it into place.
 *
 * The tree is built in a temporary directory beside `outDir` and swapped in only
 * once it is complete, so an interrupted or failed build never leaves a partial
 * tree where the next step would package it — the same rule the host's own
 * installer follows for the same reason.
 *
 * @param options - `platform`, `arch` and the destination directory.
 * @returns the destination, its byte size and the per-input download sizes.
 */
export async function buildPrimaryRuntime({ platform, arch, outDir }) {
  const { name, entry } = targetLock(platform, arch)
  const desktopVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const sizes = { node: 0, python: 0, pnpm: 0, wheels: 0 }

  const nodeArchiveName = `node-v${LOCK.nodeVersion}-${entry.nodeArchive}`
  const pythonArchiveName = `cpython-${LOCK.pythonVersion}+${LOCK.pythonRelease}-${entry.pythonTarget}-install_only_stripped.tar.gz`
  const stagingRoot = path.join(path.dirname(outDir), '.primary-runtime-staging-')
  await mkdir(path.dirname(outDir), { recursive: true })
  const staging = await mkdtemp(stagingRoot)
  const previous = `${outDir}.previous`
  try {
    const dependencies = path.join(staging, 'dependencies')
    await mkdir(dependencies, { recursive: true })

    // --- Node.js: the binary the tool tells the agent to run pnpm with --------
    // NODE_DIST_MIRROR joins the candidate list first (a domestic mirror is
    // faster in China and cannot substitute bytes: the digest is checked either
    // way), exactly as scripts/build-runtime.mjs treats it.
    const nodeMirror = (process.env.NODE_DIST_MIRROR ?? '').trim().replace(/\/+$/u, '')
    const nodePath = `v${LOCK.nodeVersion}/${nodeArchiveName}`
    const nodeArchive = await fetchPinnedFrom(
      [...(nodeMirror === '' ? [] : [`${nodeMirror}/${nodePath}`]), `${NODE_DIST_BASE}/${nodePath}`],
      entry.nodeSha256,
      'sha256',
    )
    sizes.node = statSync(nodeArchive).size
    const nodeExtract = path.join(staging, '.node-extract')
    await mkdir(nodeExtract, { recursive: true })
    if (platform === 'win32') extractZip(nodeArchive, nodeExtract)
    else await extractTar({ file: nodeArchive, cwd: nodeExtract })
    const nodeSource = path.join(nodeExtract, nodeArchiveName.replace(/\.(?:zip|tar\.gz)$/u, ''))
    const nodeBinary = platform === 'win32' ? 'node.exe' : 'node'
    await mkdir(path.join(dependencies, 'node', 'bin'), { recursive: true })
    await mkdir(path.join(dependencies, 'node', 'node_modules'), { recursive: true })
    await cp(path.join(nodeSource, ...(platform === 'win32' ? [nodeBinary] : ['bin', nodeBinary])), path.join(dependencies, 'node', 'bin', nodeBinary))
    await cp(path.join(nodeSource, 'LICENSE'), path.join(dependencies, 'node', 'LICENSE'))
    // The host's tool answers this directory, so it has to exist; pnpm creates
    // its own store and virtual store wherever it is run from.
    await writeFile(path.join(dependencies, 'node', 'node_modules', 'README.txt'), 'Reserved for bundled Node packages. pnpm uses its default installation directories.\n')
    if (platform !== 'win32') await chmod(path.join(dependencies, 'node', 'bin', nodeBinary), 0o755)
    await rm(nodeExtract, { recursive: true, force: true })
    log(`node ${LOCK.nodeVersion} ${platform}-${arch} staged from ${formatBytes(sizes.node)}`)

    // --- Python: python-build-standalone, extracted as `dependencies/python/` --
    const pythonArchive = await fetchPinnedFrom(
      [`${PYTHON_RELEASE_BASE}/${LOCK.pythonRelease}/${encodeURIComponent(pythonArchiveName)}`],
      entry.pythonSha256,
      'sha256',
    )
    sizes.python = statSync(pythonArchive).size
    await extractTar({ file: pythonArchive, cwd: dependencies })
    if (platform !== 'win32') {
      for (const interpreterName of ['python3', `python${LOCK.pythonVersion.split('.').slice(0, 2).join('.')}`]) {
        const interpreter = path.join(dependencies, 'python', 'bin', interpreterName)
        if (existsSync(interpreter)) await chmod(interpreter, 0o755)
      }
    }
    log(`python ${LOCK.pythonVersion} staged from ${formatBytes(sizes.python)}`)

    // --- pnpm: the npm package, run through the Node above --------------------
    const [pnpmAlgorithm, pnpmIntegrity] = LOCK.pnpmIntegrity.split('-')
    const pnpmTarball = await fetchPinnedFrom(
      [...new Set([...PNPM_REGISTRY_BASE.map((base) => `${base}/pnpm/-/pnpm-${LOCK.pnpmVersion}.tgz`), LOCK.pnpmTarball])],
      pnpmIntegrity,
      pnpmAlgorithm,
    )
    sizes.pnpm = statSync(pnpmTarball).size
    const pnpmExtract = path.join(staging, '.pnpm-extract')
    await mkdir(pnpmExtract, { recursive: true })
    await extractTar({ file: pnpmTarball, cwd: pnpmExtract })
    await cp(path.join(pnpmExtract, 'package'), path.join(dependencies, 'pnpm'), { recursive: true })
    await rm(pnpmExtract, { recursive: true, force: true })
    log(`pnpm ${LOCK.pnpmVersion} staged from ${formatBytes(sizes.pnpm)}`)

    // --- wheels ---------------------------------------------------------------
    const layout = workspaceLayout(staging, platform, LOCK.pythonVersion)
    for (const wheel of [...entry.wheels, ...LOCK.wheels]) {
      const label = wheel.url.split('/').pop() ?? wheel.url
      const archive = await fetchPinnedFrom([wheel.url], wheel.sha256, 'sha256')
      sizes.wheels += statSync(archive).size
      await unpackWheel(archive, layout.pythonPackages, label)
    }
    await assertInstalledDistributions(layout.pythonPackages)
    log(`${String(entry.wheels.length + LOCK.wheels.length)} wheels staged (${formatBytes(sizes.wheels)})`)

    // --- manifest -------------------------------------------------------------
    const manifest = {
      desktopVersion,
      platform,
      arch,
      payloadDigest: payloadDigest(name, LOCK.pnpmVersion),
      pythonPackages: LOCK.pythonPackages,
      components: {
        python: LOCK.pythonVersion,
        node: LOCK.nodeVersion,
        pnpm: LOCK.pnpmVersion,
        numpy: LOCK.pythonPackages.numpy,
        pandas: LOCK.pythonPackages.pandas,
      },
    }
    for (const file of [layout.python, layout.node, layout.pnpm]) {
      if (!existsSync(file)) throw new Error(`the staged tree is incomplete: ${file} is missing`)
    }
    await writeFile(path.join(staging, 'runtime.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

    await rm(previous, { recursive: true, force: true })
    const replacing = existsSync(outDir)
    if (replacing) await rename(outDir, previous)
    try {
      await rename(staging, outDir)
    } catch (error) {
      if (replacing) await rename(previous, outDir)
      throw error
    }
    await rm(previous, { recursive: true, force: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const bytes = await treeSize(outDir)
  log(`primary runtime ${LOCK.pythonVersion} + node ${LOCK.nodeVersion} + pnpm ${LOCK.pnpmVersion} (${name}) at ${outDir}: ${formatBytes(bytes)} unpacked`)
  return { outDir, bytes, sizes, name }
}

/** Total byte size of every file under a tree. */
async function treeSize(dir) {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await treeSize(child)
    else if (entry.isFile()) total += (await statFile(child)).size
  }
  return total
}

/** Size of one file, or 0 when it vanished between listing and stat. */
async function statFile(file) {
  try {
    return await stat(file)
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) return { size: 0 }
    throw error
  }
}

/**
 * Parse the command line and build one cell.
 * @param argv - `process.argv.slice(2)`.
 * @returns the build result.
 */
export async function main(argv) {
  const [platform, arch, outDirArg] = argv
  if (platform === undefined || arch === undefined) {
    throw new Error('usage: node scripts/build-primary-runtime.mjs <platform> <arch> [outDir]')
  }
  if (platform === 'linux') {
    // Not an oversight and not a container limitation: the host's
    // readPrimaryRuntime accepts only win32 and darwin manifests, and
    // installPrimaryRuntime refuses one whose platform is not the running one —
    // so a linux tree could never be installed, while carrying ~150 MB in every
    // linux office payload.
    throw new Error('linux primary runtimes cannot be used: the desktop host validates `platform` against win32|darwin only '
      + '(readPrimaryRuntime in apps/desktop-host/src/primary-runtime.ts), so build the office payload for linux cells without DSH_APP_PRIMARY_RUNTIME')
  }
  if (platform !== 'win32' && platform !== 'darwin') {
    throw new Error(`unsupported platform "${platform}": expected win32, darwin or linux`)
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`unsupported arch "${arch}": expected x64 or arm64`)
  }
  const outDir = path.resolve(outDirArg ?? path.join(root, 'runtime-dist', `primary-runtime-${platform}-${arch}`))
  return buildPrimaryRuntime({ platform, arch, outDir })
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main(process.argv.slice(2))
    log(`downloads: node ${formatBytes(result.sizes.node)}, python ${formatBytes(result.sizes.python)}, `
      + `pnpm ${formatBytes(result.sizes.pnpm)}, wheels ${formatBytes(result.sizes.wheels)}`)
  } catch (error) {
    console.error(`[build-primary-runtime] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
