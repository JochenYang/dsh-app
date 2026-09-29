// Packaged-artifact smoke: assert an electron-builder output actually carries
// the files the shell loads at boot, and nothing it stopped loading.
//
// This is the layer the other probes cannot see. `smoke-suite.mjs` boots a
// kernel from a tarball and never looks inside an installer; the unit suites
// run against dist/. The failures this catches are the ones that only exist
// after packaging: a missing asar entry (electron-builder `files` no longer
// matching), a stale file surviving a rebuild, or an installer that shipped
// without the bundled kernel — the last one silently disables bundled-runtime
// adoption, whose manifest.json is an easy thing to leave out of `filter`.
//
// Usage: node scripts/smoke-package.mjs [--dir <unpacked>] [--platform <p>] [--arch <a>]
//   With no --dir, the usual electron-builder output directories are probed.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Entries the shell loads from inside app.asar at boot. */
const REQUIRED_ASAR_ENTRIES = [
  'package.json',
  'dist/main/index.js',
  'dist/main/dsh-app.patch.yml',
  'dist/static/startup.html',
  'dist/icon.png',
  // Production dependencies the shell imports at module scope: if a builder
  // upgrade ever stops copying node_modules into the asar, the app dies on
  // the first import instead of at a feature — and nothing else looks here.
  'node_modules/electron-updater/package.json',
  'node_modules/tar/package.json',
  'node_modules/semver/package.json',
]

/** The splash, plus the opening film's own directory, under `dist/static`.
 *
 * The single-file rule exists because a stale setup UI once shipped here; the
 * film is a deliberate second entry, so the exception is spelled out as a
 * SUBDIRECTORY instead of a second filename: everything the splash needs beyond
 * itself lives under `static/media/`, and nothing else may appear at the top. */
const STATIC_DIR = 'dist/static/'
const STATIC_MEDIA_DIR = `${STATIC_DIR}media/`
/** The media DIRECTORY's own asar entry, which carries no trailing slash. */
const STATIC_MEDIA_ENTRY = STATIC_MEDIA_DIR.replace(/\/$/u, '')
/** The opening film the splash page loads; a build without it plays nothing. */
const SPLASH_VIDEO = `${STATIC_MEDIA_DIR}DSH-APP startup.mp4`

/** Files electron-builder's `extraResources` filter is allowed to place there. */
const REQUIRED_KERNEL_FILES = ['kernel.tgz', 'kernel.tgz.sha512', 'manifest.json']

/** Candidate output directories, in the order electron-builder writes them. */
const OUTPUT_CANDIDATES = [
  'release/win-unpacked',
  'release/mac',
  'release/mac-arm64',
  'release/mac-universal',
  'release/linux-unpacked',
  'release/linux-arm64-unpacked',
]

function parseArgs(argv) {
  const options = { dir: null, platform: process.platform, arch: process.arch }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--dir' && value) options.dir = value
    else if (flag === '--platform' && value) options.platform = value
    else if (flag === '--arch' && value) options.arch = value
    else throw new Error(`unknown argument: ${flag}`)
    index += 1
  }
  return options
}

async function isDirectory(target) {
  return fs.stat(target).then((stat) => stat.isDirectory(), () => false)
}

/** Locate an unpacked build, preferring an explicit --dir. */
async function resolveOutputDir(explicit) {
  if (explicit !== null) {
    if (!(await isDirectory(explicit))) throw new Error(`not a directory: ${explicit}`)
    return explicit
  }
  for (const candidate of OUTPUT_CANDIDATES) {
    const full = path.join(root, candidate)
    if (await isDirectory(full)) return full
  }
  throw new Error('no unpacked build found; pass --dir <unpacked> or run npm run dist:win first')
}

/**
 * On macOS the payload sits inside `<App>.app/Contents`; keep the returned path
 * the same shape on every platform so the assertions below stay platform-free.
 */
async function resolveResourcesDir(outputDir, platform) {
  const direct = path.join(outputDir, 'resources')
  if (await isDirectory(direct)) return direct
  if (platform === 'darwin') {
    const entries = await fs.readdir(outputDir, { withFileTypes: true })
    const app = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    if (app) {
      const nested = path.join(outputDir, app.name, 'Contents', 'Resources')
      if (await isDirectory(nested)) return nested
    }
  }
  throw new Error(`no resources directory under ${outputDir}`)
}

const failures = []
const checks = []

function check(label, ok, detail) {
  checks.push({ label, ok, detail })
  if (!ok) failures.push(detail === undefined ? label : `${label}: ${detail}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const outputDir = await resolveOutputDir(options.dir)
  const resourcesDir = await resolveResourcesDir(outputDir, options.platform)
  console.log(`package smoke: ${path.relative(root, resourcesDir)} (${options.platform}-${options.arch})`)

  // --- app.asar ------------------------------------------------------------
  const asarPath = path.join(resourcesDir, 'app.asar')
  const asarExists = await fs.stat(asarPath).then(() => true, () => false)
  check('app.asar present', asarExists, asarPath)
  if (asarExists) {
    const { extractFile, listPackage } = await import('@electron/asar')
    // The library reports entries with a leading, platform-specific separator
    // (backslashes on Windows); normalize so the assertions stay portable.
    const entries = (await listPackage(asarPath)).map(
      (entry) => entry.replace(/\\/gu, '/').replace(/^\/+/u, ''),
    )
    for (const required of REQUIRED_ASAR_ENTRIES) {
      check(`asar has ${required}`, entries.includes(required))
    }
    const staticEntries = entries.filter((entry) => entry.startsWith(STATIC_DIR) && entry !== STATIC_DIR)
    // `dist/static/media` itself is one of those entries — asar lists the
    // DIRECTORY (no trailing slash) as well as the files under it. Measured on a
    // packaged 0.14.4 build: without this line the gate failed the very change it
    // was added for, one directory entry short of correct.
    const unexpected = staticEntries.filter((entry) =>
      entry !== `${STATIC_DIR}startup.html` && entry !== STATIC_MEDIA_ENTRY && !entry.startsWith(STATIC_MEDIA_DIR))
    check(
      'asar ships only the splash and static/media under dist/static',
      unexpected.length === 0,
      unexpected.length === 0 ? '' : `unexpected: ${unexpected.join(', ')}`,
    )
    check('asar ships the splash page', staticEntries.includes(`${STATIC_DIR}startup.html`), `found ${staticEntries.join(', ') || '(none)'}`)
    check('asar ships the opening film', staticEntries.includes(SPLASH_VIDEO), `found ${staticEntries.filter((entry) => entry.startsWith(STATIC_MEDIA_DIR)).join(', ') || '(nothing under static/media)'}`)
    if (entries.includes('package.json')) {
      const pkg = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'))
      check('package.json main points at the built entry', pkg.main === 'dist/main/index.js', String(pkg.main))
    }
  }

  // --- bundled kernel ------------------------------------------------------
  const kernelDir = path.join(resourcesDir, 'kernel')
  const kernelExists = await isDirectory(kernelDir)
  check('resources/kernel present', kernelExists, kernelDir)
  if (kernelExists) {
    const names = (await fs.readdir(kernelDir)).sort()
    check(
      'bundled kernel carries exactly the expected files',
      names.length === REQUIRED_KERNEL_FILES.length
        && REQUIRED_KERNEL_FILES.every((name) => names.includes(name)),
      names.join(', '),
    )
    const manifestPath = path.join(kernelDir, 'manifest.json')
    if (names.includes('manifest.json')) {
      // Adoption keys on these fields; without them the shell never records a
      // bundle identity and a same-version suite change silently never lands.
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      for (const field of ['dshVersion', 'suiteVersion', 'platform', 'arch']) {
        check(`bundled manifest has ${field}`, typeof manifest[field] === 'string' && manifest[field] !== '')
      }
      check(
        'bundled manifest matches the packaged target',
        manifest.platform === options.platform && manifest.arch === options.arch,
        `${String(manifest.platform)}-${String(manifest.arch)}`,
      )
    }
  }

  // --- report --------------------------------------------------------------
  for (const { label, ok, detail } of checks) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  }
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`)
  if (failures.length > 0) {
    console.error('\npackaged artifact is not shippable:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  }
}

await main().catch((error) => {
  console.error(`package smoke failed to run: ${error.message}`)
  process.exitCode = 1
})
