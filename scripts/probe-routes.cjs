#!/usr/bin/env node
/**
 * Runtime probe: what this composition's route carriers actually do, measured on
 * the combination the SHELL really boots.
 *
 * Five sections, each answered from an HTTP response rather than from the
 * carrier's own documentation — the documentation and the code have disagreed
 * here before. The labels below are the labels the OUTPUT carries, so the line
 * behind a conclusion is found by its own name:
 *
 *   S1  a sibling plugin that declares `inject: ['connection', 'webServer']`
 *       ACTIVATED — its own marker route answers 200 with `activated: true`. That
 *       is what makes "`webServer` is present in this composition" a measured
 *       fact rather than a guess, and S2–S4 rest on it.
 *   S2  `ctx.get('webServer')` has a value at apply time AND again inside the
 *       optional inject door, and the service is the host package's own webserver
 *       carrier: its port, its `register`, its members.
 *   S3  what each registration KIND serves. `ctx.connection.fetch.register({
 *       path })` is documented as an EXACT route: register
 *       `/api/plugins/dsh-app/probe-routes/tree` and `/tree` answers while
 *       `/tree/a/b/c.js` is a 404. A `kind: 'prefix'` route on `webServer`
 *       serves a DEEP sub-path; a `kind: 'exact'` one does not. S3b re-reads the
 *       prefix handler's own recording of the paths it was asked for.
 *   S4  the carrier does not strip `Range`, rewrite the response or buffer it.
 *       `Range: bytes=0-3` must arrive as the handler's own 206 with its
 *       `content-range` and `accept-ranges` intact, and `/stream` answers a
 *       `ReadableStream` whose chunks are 400ms apart — the only reading that
 *       separates "the carrier streams the body" from "the carrier buffered it".
 *       S4 is the Range half, S4b the streaming half.
 *   S5  the fence, and half the reason this probe runs in the desktop shape.
 *       S5a is the CONTROL on the `/api` carrier: no session cookie is refused
 *       (401), a foreign `Origin` is refused (403). S5b asks the SAME server for
 *       the `webServer` prefix route and gets its body both ways — the fence is
 *       applied by each route's OWNER, not by the server. That is the measured
 *       fact W14's routing decision rests on (`docs/plans/workbench-hub.md`), so
 *       it is asserted rather than merely printed: a kernel line that moves the
 *       fence flips the decision, and this probe is where that becomes visible.
 *       S5b is a ONE-WAY check on purpose. An upstream kernel that starts fencing
 *       the `webServer` routes is pure hardening, and it turns S5b RED — that is
 *       the signal to re-make the W14 decision. Do NOT loosen this check to make
 *       it green.
 *
 * Why the desktop-host shape, and what it replaces. W13 measured S1–S3 on the
 * CLI/`dsh web` combination (`dsh/lib/bin.js --profile … --patch <overlay>
 * --host … --port … --no-open`), which is NOT what a shell start spawns. A shell
 * start spawns `@deepseek-ai/dsh-desktop-host/lib/index.js` with POSITIONAL
 * arguments and no `--patch` at all (`src/main/desktop-host.ts` `webShapeArgs`),
 * and the suite's rows reach the profile as a BUNDLE LAYER
 * (`src/main/suite-layer.ts`) rather than through the profile's own
 * `cordis.patch.yml`. Two consequences: S5 is unaskable in the CLI shape by the
 * page-side technique W13 used (a page's cookie jar and origin are its own, so it
 * cannot send "no cookie" or a foreign `Origin`), and S4 had only ever been
 * measured there — it is folded into THIS probe, on this shape.
 *
 * What it reproduces, with which code:
 *
 *   - the runtime tree (`--kernel`, `--tgz`, or the newest artifact under
 *     `runtime-dist/`), the child's ENTRY and ARGV
 *     (`<tree>/node/node.exe --expose-internals
 *     <tree>/app/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js
 *     <tree>/app <profileDir> <primaryRuntime> [pnpm.mjs <tree>/node]`), spawned
 *     with `stdio: ['ignore','pipe','pipe','ipc']` and `windowsHide: true`,
 *     exactly the shape `DshHost.startAttempt` builds,
 *   - the URL, taken off the IPC channel's `ready` message — the same one
 *     `handleMessage` reads — never off stdout,
 *   - the session cookie, bought with the shell's OWN `authenticateHostWeb`
 *     (`dist/main/host-web.js`, which is Electron-free),
 *   - the suite wiring, run through the shell's OWN code: `ensureSuiteProfile`
 *     (the profile manifest), `prepareBrandSuite` (the `@dsh-app` links into both
 *     scopes) and `installSuiteLayer` (the layer package, from the SHIPPED
 *     overlay `dist/main/dsh-app.patch.yml`),
 *   - the office payload the web transport cannot boot without, materialized the
 *     way `prepareOfficePayload` does (a copy of `office-skills` beside the
 *     `primary-runtime` leaf, with the runtime's own Node placed inside it).
 *
 * What it deliberately does NOT reproduce (stated so the reading is not
 * over-claimed): the Electron shell around the child. No window, no
 * `dsh-app://app` protocol, no forwarded request. Every request here is one raw
 * `node:http` round trip against the child's own loopback surface, which is what
 * gives byte-exact control over `Cookie` and `Origin`; the shell's window reaches
 * the same routes through `forwardHostWebRequest`, which strips `origin`/`cookie`
 * and installs the session cookie, and that path is unchanged by anything
 * measured here.
 *
 * Preconditions refuse rather than degrade: the host binds an OS-ASSIGNED port on
 * this line (`dsh-desktop-host` passes `--port 0`, so a fixed one is neither
 * reserved nor asserted here — a directory that is
 * not a runtime tree, a missing or STALE `lib/` — on the two probe fixtures AND
 * on every roster package under `plugins/`, which this probe links from the
 * working tree (the same freshness rule as the four plugin gates,
 * `plugins/AGENTS.md` §3) — and a profile the shipped overlay's rows cannot
 * resolve each fail with the command to run, never a green run against a broken
 * fixture or a `lib/` from another moment.
 *
 * Run under Electron from Git Bash (the shell modules it calls import
 * `electron`; nothing here opens a window). Run `npm run build` FIRST: the
 * `require`s below resolve into `dist/main/`, which `.gitignore` keeps out of a
 * clean checkout, and the overlay read as the SHIPPED one is
 * `dist/main/dsh-app.patch.yml`. The roster packages must be built as well
 * (`plugins/AGENTS.md` §2) — this probe refuses a missing or stale `lib/` on any
 * of them:
 *   npm run build
 *   node_modules/.bin/electron scripts/probe-routes.cjs
 *   node_modules/.bin/electron scripts/probe-routes.cjs --tgz runtime-dist/dsh-runtime-win32-x64-0.2.0-rc.2.tgz
 *   node_modules/.bin/electron scripts/probe-routes.cjs --kernel "<userData>/kernel/dsh-<v>"
 *
 * Exits non-zero on any failed assertion.
 */
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const { app } = require('electron')

const root = path.resolve(__dirname, '..')
const here = path.join(root, 'scratch', 'probe-routes')
const rtRoot = path.join(here, 'rt')
const runtimeDir = path.join(rtRoot, 'runtime')
const dshHome = path.join(here, 'home')
const logDir = path.join(here, 'logs')
const hostLog = path.join(logDir, 'host.log')
const officeRoot = path.join(dshHome, 'dsh-app-office')
/** Which artifact the extraction under `rtRoot` came from. */
const marker = path.join(rtRoot, 'extracted-from.txt')

/**
 * The port the host actually bound, learned from its `ready` URL.
 *
 * Kernel 0.2.1 moved the desktop host to an OS-assigned port (`--port 0`), so a
 * fixed constant no longer exists to assert against; every port comparison below
 * derives from what the child reported.
 */
function portOf(reportedUrl) {
  const port = Number(new URL(reportedUrl).port)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`the host reported no usable port: ${reportedUrl}`)
  return port
}

/** How long the child may take to report `ready` (its first boot composes the whole profile). */
const HOST_READY_TIMEOUT_MS = 300_000

/**
 * The two probe fixtures, as the profile patch names them.
 *
 * Both live under `scripts/fixtures/` and are linked from the WORKING TREE into
 * the booted profile, because they are the packages this probe must control; the
 * nineteen suite packages come from the repository's own `plugins/` through the
 * shell's `SUITE_PLUGIN_DIRS`.
 */
const PROBE_FIXTURES = [
  { dirName: 'probe-routes', packageName: '@dsh-app/probe-routes' },
  { dirName: 'probe-wsinject', packageName: '@dsh-app/probe-wsinject' },
]

/** The Connection route the exact-only and Range questions are asked of. */
const TREE_PATH = '/api/plugins/dsh-app/probe-routes/tree'
/** The route the streamed-vs-buffered question is asked of. */
const STREAM_PATH = '/api/plugins/dsh-app/probe-routes/stream'
/** The path the deep-sub-path question is asked about. */
const DEEP_PATH = '/probe-tree/a/b/c.js'
const DEEP_BODY = `PROBE-PREFIX:${DEEP_PATH}`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const relative = (absolute) => path.relative(root, absolute).split(path.sep).join('/')

/**
 * Assertions. Every section below prints raw observations; these are the claims
 * read off them, and the run's exit code is what a caller can gate on.
 */
let passed = 0
const failures = []
function check(label, ok, detail = '') {
  const suffix = detail === '' ? '' : ` — ${detail}`
  if (ok) {
    passed += 1
    console.log(`  PASS: ${label}`)
    return
  }
  failures.push(`${label}${suffix}`)
  console.log(`  FAIL: ${label}${suffix}`)
}

/** A measured direction, printed as a finding beside the assertion it belongs to. */
function finding(text) {
  console.log(`  FINDING: ${text}`)
}

const section = (title, value) => {
  console.log(`\n=== ${title} ===`)
  console.log(typeof value === 'string' ? redact(value) : redact(JSON.stringify(value, null, 1)))
}

/**
 * Strip anything that looks like a launch token or a session cookie before it is
 * printed. The URL the child reports carries a one-shot token and the cookie is
 * a live credential; neither belongs in a probe's output.
 */
function redact(text) {
  return text
    .replace(/token=[^\s&"']*/gu, 'token=<redacted>')
    .replace(/(dsh-auth-[^=;'"\s]*=)[^;'"\s]*/gu, '$1<redacted>')
}

/** `--tgz <artifact>` / `--kernel <extracted runtime dir>`, nothing else. */
function parseArgs(argv) {
  const args = { tgz: undefined, kernel: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token !== '--tgz' && token !== '--kernel') {
      throw new Error(`unknown argument: ${token} (this probe takes --tgz <runtime.tgz> or --kernel <extracted runtime dir>)`)
    }
    const value = argv[index + 1]
    // The value is CONSUMED, not visited again: without the extra step the loop
    // reads `--tgz <path>` as the flag followed by an unknown argument.
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`)
    if (token === '--tgz') args.tgz = value
    else args.kernel = value
    index += 1
  }
  return args
}

/**
 * Refuse a directory that is not a runtime tree, naming the file that decides it.
 *
 * The office payload's contract moved with kernel 0.2.1: `skill-office` reads
 * `<assetRoot>/<skill>/SKILL.md` for every name in its `SKILL_NAMES`, and the
 * single `scripts/check_office.py` marker no longer exists anywhere. Asserting
 * the old marker rejected every artifact of this line.
 */
const OFFICE_SKILL_NAMES = [
  'office',
  'office-docx',
  'office-pptx',
  'office-xlsx',
  'office-render',
  'office-recalculate',
  'office-export-pdf',
]

function assertRuntimeTree(dir, source) {
  const bin = path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const nodeBin = path.join(dir, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const hostEntry = path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  const officeSkills = path.join(dir, 'runtime', 'office-skills')
  for (const file of [bin, nodeBin, hostEntry]) {
    if (!fs.existsSync(file)) throw new Error(`${source} is not a runtime tree: ${file} is missing`)
  }
  for (const name of OFFICE_SKILL_NAMES) {
    const skill = path.join(officeSkills, name, 'SKILL.md')
    if (!fs.existsSync(skill)) throw new Error(`${source} is not a runtime tree: ${skill} is missing`)
  }
  return { nodeBin, bin, hostEntry, officeSkills }
}

/**
 * The runtime tree the host child runs out of: an explicit `--kernel` directory,
 * an explicit `--tgz`, or the newest artifact under `runtime-dist/`.
 *
 * An extraction is keyed by its SOURCE: a tree unpacked from a different artifact
 * is discarded instead of reused, because otherwise `--tgz <today's build>` would
 * quietly test yesterday's unpack — the same mistake as a stale fixture `lib/`,
 * one level up.
 *
 * The tree's own files come back with it: the check that decides "this is a
 * runtime tree" runs exactly once, here, on whichever branch resolved it.
 */
async function resolveRuntime(args) {
  if (args.kernel !== undefined) {
    const dir = path.resolve(args.kernel)
    return { dir, source: `kernel:${dir}`, files: assertRuntimeTree(dir, `--kernel ${args.kernel}`) }
  }
  const distDir = path.join(root, 'runtime-dist')
  let tarball
  if (args.tgz !== undefined) {
    tarball = path.resolve(args.tgz)
    if (!fs.existsSync(tarball)) throw new Error(`--tgz ${args.tgz} does not exist`)
  } else {
    const { newestRuntimeTarball } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'runtime-artifacts.mjs')).href)
    const names = fs.readdirSync(distDir, { throwIfNoEntry: false }) ?? []
    const name = newestRuntimeTarball(names, process.platform, process.arch)
    if (name === null) {
      throw new Error(`no runtime artifact for ${process.platform}-${process.arch} in ${distDir} — build one: npm run runtime:build, or pass --kernel <dir>`)
    }
    tarball = path.join(distDir, name)
  }
  const source = `tgz:${path.basename(tarball)}`
  const extracted = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null
  if (fs.existsSync(runtimeDir) && extracted !== source) {
    const { removeTree } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'remove-tree.mjs')).href)
    console.log(`discarding      : the extraction under ${relative(rtRoot)} (from ${extracted ?? 'an unknown source'})`)
    await removeTree(rtRoot)
  }
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(rtRoot, { recursive: true })
    console.log(`extracting      : ${path.basename(tarball)}`)
    const slashes = (value) => value.replace(/\\/gu, '/')
    const result = spawnSync('tar', ['--force-local', '-xzf', slashes(tarball), '-C', slashes(rtRoot)], { stdio: 'inherit' })
    if (result.status !== 0) {
      throw new Error(`tar failed with status ${String(result.status)} (the paths above are converted to forward slashes for Git Bash's MSYS tar)`)
    }
    fs.writeFileSync(marker, `${source}\n`)
  }
  return { dir: runtimeDir, source, files: assertRuntimeTree(runtimeDir, path.basename(tarball)) }
}

/**
 * The shell's own build, which every `shellModule` call below resolves into.
 *
 * `dist/` is gitignored, so on a clean checkout the first sign of a missing build
 * would be a bare `Cannot find module …dist\main\suite-profile.js` in the middle
 * of the run. The overlay is checked with the modules because
 * `readShippedOverlay` reads it from the same directory and a missing one would
 * quietly become an EMPTY layer — a suite-less boot that still passes the
 * questions this probe asks.
 */
function assertShellBuild() {
  const distMain = path.join(root, 'dist', 'main')
  const needed = ['suite-profile.js', 'brand-suite.js', 'suite-layer.js', 'host-web.js', 'dsh-app.patch.yml']
  const missing = needed.filter((name) => !fs.existsSync(path.join(distMain, name)))
  if (missing.length > 0) {
    throw new Error(`${relative(distMain)} is incomplete (missing ${missing.join(', ')}) — build the shell first: npm run build`)
  }
}

/**
 * The roster this probe links from the WORKING TREE, each entry with its own
 * manifest, read once per run.
 *
 * The roster is the shell's own `SUITE_PLUGIN_DIRS` (`src/main/brand-suite.ts`),
 * and each package's `package.json` says whether it has a client half
 * (`dsh.client`). Nothing here is hand-listed: a plugin added to the roster joins
 * both the build precondition and the L0 assertion with no edit to this file. The
 * single read is also what makes those two the SAME expectation rather than two
 * readings that could drift.
 */
let roster = null
function suiteRoster() {
  if (roster !== null) return roster
  const { SUITE_PLUGIN_DIRS } = shellModule('brand-suite.js')
  roster = SUITE_PLUGIN_DIRS.map((dirName) => {
    const dir = path.join(root, 'plugins', dirName)
    const manifestPath = path.join(dir, 'package.json')
    if (!fs.existsSync(manifestPath)) throw new Error(`suite source ${dirName} has no package.json at ${manifestPath}`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return { dirName, dir, name: manifest.name, declaresClient: manifest.dsh?.client !== undefined }
  })
  return roster
}

/**
 * Refuse to assert against a `lib/` that is missing or older than its own
 * sources — on the two probe fixtures AND on every roster package.
 *
 * The kernel loads `lib/index.js`, so a `lib/` from another moment answers
 * another moment's questions; the repository's own freshness check
 * (`scripts/lib/plugin-gates.mjs`, the fourth of the four gates in
 * `plugins/AGENTS.md` §3) is reused here so this probe refuses exactly where a
 * pack refuses. The roster packages are linked from this working tree, so they
 * carry the same precondition as the fixtures — and the command named is the
 * package's OWN build script, because `plugin-brand` is built by `tsc` and has no
 * `build.mjs`.
 */
async function assertProbeInputs() {
  const { pluginLibStaleness } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'plugin-gates.mjs')).href)
  const problems = []
  const refuseIfUnbuilt = (where, dir, build) => {
    if (!fs.existsSync(path.join(dir, 'lib', 'index.js'))) {
      problems.push(`${where} is not built — run: ${build}`)
      return
    }
    const { stale, newestInput, libMtime } = pluginLibStaleness(dir)
    if (stale) {
      problems.push(`${where} has a lib/ older than its own sources: newest input ${newestInput.path}`
        + ` (${new Date(newestInput.mtimeMs).toISOString()}) is newer than the newest lib/ entry ${libMtime.path}`
        + ` (${new Date(libMtime.mtimeMs).toISOString()}) — rebuild: ${build}`)
    }
  }
  for (const fixture of PROBE_FIXTURES) {
    const dir = path.join(root, 'scripts', 'fixtures', fixture.dirName)
    refuseIfUnbuilt(`${fixture.packageName} (${relative(dir)})`, dir, `node scripts/fixtures/${fixture.dirName}/build.mjs`)
  }
  for (const entry of suiteRoster()) {
    refuseIfUnbuilt(`${entry.name} (${relative(entry.dir)})`, entry.dir, `(cd plugins/${entry.dirName} && npm install --legacy-peer-deps && npm run build)`)
  }
  if (problems.length > 0) throw new Error(`refusing to assert against a stale or missing build:\n- ${problems.join('\n- ')}`)
}

/** How long one raw round trip may take before it is a failure rather than a hang. */
const HTTP_TIMEOUT_MS = 30_000

/**
 * Arm one request with the probe's deadline: an idle socket is a hung response,
 * and a probe that waits forever reports nothing instead of FAILing.
 */
function armTimeout(request, urlString) {
  request.setTimeout(HTTP_TIMEOUT_MS, () => {
    request.destroy(new Error(`no response from ${urlString} within ${String(HTTP_TIMEOUT_MS / 1000)}s`))
  })
}

/** One raw HTTP GET: no redirect following, no cookie jar, no header filtering. */
function httpGet(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const request = http.request(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET', headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve({
            status: response.statusCode,
            headers: response.headers,
            bytes: body.length,
            body: body.toString('utf8'),
          })
        })
      },
    )
    armTimeout(request, urlString)
    request.once('error', reject)
    request.end()
  })
}

/**
 * One raw HTTP GET, with the ARRIVAL TIME of every body chunk.
 *
 * This is the whole of the streamed-vs-buffered reading: a carrier that buffered
 * the body delivers one chunk (or none, until the end), so the spread between the
 * first and the last arrival is what separates the two — a fact no header can
 * carry, and the reason the fixture's `/stream` handler spaces its chunks 400ms
 * apart.
 */
function httpGetStreaming(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const startedAt = Date.now()
    const request = http.request(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET', headers },
      (response) => {
        const chunks = []
        const marks = []
        response.on('data', (chunk) => {
          marks.push({ atMs: Date.now() - startedAt, bytes: chunk.length })
          chunks.push(chunk)
        })
        response.on('end', () => resolve({
          status: response.statusCode,
          headers: response.headers,
          marks,
          totalBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
          totalMs: Date.now() - startedAt,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      },
    )
    armTimeout(request, urlString)
    request.once('error', reject)
    request.end()
  })
}

/** The shell's own module, out of the build the shell runs (`npm run build`). */
function shellModule(name) {
  return require(path.join(root, 'dist', 'main', name))
}

/**
 * Lay out the scratch home the way the shell lays out a real one, running the
 * shell's own seeding/linking/layer code against it.
 */
async function prepareHome(tree, treeFiles) {
  const { removeTree } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'remove-tree.mjs')).href)
  if (fs.existsSync(dshHome)) await removeTree(dshHome)
  fs.mkdirSync(logDir, { recursive: true })

  // The child resolves its home from $DSH_HOME; `resolveDshHome` in the shell's
  // own modules reads the same variable, so the shell code below writes into
  // THIS home rather than the machine's.
  process.env.DSH_HOME = dshHome

  const suiteProfile = shellModule('suite-profile.js')
  const brand = shellModule('brand-suite.js')
  const suiteLayer = shellModule('suite-layer.js')

  const seeded = await suiteProfile.ensureSuiteProfile()
  if (!seeded.ready) throw new Error(`the scratch profile could not be seeded: ${JSON.stringify(seeded.outcome)}`)
  const profileDir = seeded.dir

  // The suite sources are the repository's own plugins — the dev shell's
  // `devSuiteSources()` — because that is what the machine's profile links point
  // at, and the packaged runtime artifact does not carry every roster package
  // (measured: `plugin-workbench` is one it lacks today). Their manifests and
  // their `lib/` were already checked by `assertProbeInputs`, which runs before
  // any of this.
  const sources = suiteRoster().map((entry) => ({ dirName: entry.dirName, dir: entry.dir }))

  const linked = await brand.prepareBrandSuite(sources, {
    profileDir,
    suite: true,
    layer: true,
    kernelNodeModules: path.join(tree, 'app', 'node_modules'),
    report: (line) => console.log(`  [shell] ${line}`),
  })
  if (!linked.suite) throw new Error('the shell\'s own prepareBrandSuite refused the suite links; a missing link would make every suite row fail to activate')

  const probeSources = PROBE_FIXTURES.map((fixture) => ({
    dirName: fixture.dirName,
    dir: path.join(root, 'scripts', 'fixtures', fixture.dirName),
  }))
  const probeLinked = await brand.linkSuitePlugins(probeSources, [
    path.join(dshHome, 'profiles', 'node_modules', '@dsh-app'),
    path.join(profileDir, 'node_modules', '@dsh-app'),
  ], (line) => console.log(`  [shell] ${line}`))
  if (!probeLinked) throw new Error('the probe fixtures could not be linked into the @dsh-app scopes')

  const layer = await suiteLayer.installSuiteLayer({
    profileDir,
    overlay: await suiteLayer.readShippedOverlay(),
    report: (line) => console.log(`  [shell] ${line}`),
  })
  if (layer.status === 'failed') throw new Error(`the shell's own installSuiteLayer failed: ${layer.detail ?? 'unknown error'}`)

  // The probe rows ride the profile's own patch file — the channel the kernel
  // itself writes the user's settings into, composed AFTER every bundle layer
  // (`readProfilePatches`: layers → profile patch → home patch → overlays). The
  // suite's own rows ride the LAYER, above, which is the point of the exercise.
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PROBE_FIXTURES
    .map((fixture) => `- insert:\n    - id: ${fixture.dirName}\n      name: '${fixture.packageName}'\n`)
    .join('\n'))

  // The office payload: `prepareOfficePayload` copies the skills beside the fixed
  // `primary-runtime` leaf and puts the child's own Node inside that leaf
  // (`dependencies/node/bin/node.exe`), because the host's office plugin stats
  // both on every start.
  const skillsTarget = path.join(officeRoot, 'office-skills')
  fs.mkdirSync(officeRoot, { recursive: true })
  fs.cpSync(treeFiles.officeSkills, skillsTarget, { recursive: true })
  const primaryRuntime = path.join(officeRoot, 'primary-runtime')
  const leafNode = path.join(primaryRuntime, 'dependencies', 'node', 'bin', path.basename(treeFiles.nodeBin))
  fs.mkdirSync(path.dirname(leafNode), { recursive: true })
  try {
    fs.linkSync(treeFiles.nodeBin, leafNode)
  } catch {
    fs.copyFileSync(treeFiles.nodeBin, leafNode)
  }

  return { profileDir, layer, primaryRuntime }
}

/**
 * The child's environment: the shell's own FILTER, then exactly the six variables
 * below.
 *
 * This is deliberately not the shell's own `kernelEnv` (`src/main/index.ts`), and
 * the difference is not a detail — it is what this probe does NOT reproduce. The
 * shell additionally sets `DSH_APP_SHELL_ACTIONS`, `DSH_APP_OFFICE_PAYLOAD`,
 * `DSH_APP_KERNEL_VERSION` / `DSH_APP_KERNEL_CHANNEL`, the proxy pair
 * (`proxyEnv`), and `desktop-host.ts` puts the bundled pnpm shim at the front of
 * `PATH` plus `ELECTRON_RUN_AS_NODE` for an Electron executable. None of them is
 * needed to reach the routes measured here, and each one left unset is one more
 * thing a green run has not proved — so they are omitted on purpose rather than
 * by oversight.
 */
function childEnv(treeFiles) {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    // The shell removes these before spawning (`startAttempt`): NODE_OPTIONS can
    // inject a require hook, NODE_PATH can shadow the runtime's packages, and a
    // `npm run` parent's npm/pnpm variables describe a project this child is not.
    if (name === 'NODE_OPTIONS' || name === 'NODE_PATH' || /^DSH_DESKTOP_/u.test(name) || /^(?:npm|pnpm|corepack)_/iu.test(name)) continue
    env[name] = value
  }
  const shellVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  return {
    ...env,
    DSH_HOME: dshHome,
    DSH_APP_DESKTOP: '1',
    DSH_APP_PROFILE: 'dsh-app',
    DSH_APP_LOG_DIR: logDir,
    DSH_APP_DSH_BIN: treeFiles.bin,
    DSH_APP_SHELL_VERSION: shellVersion,
  }
}

/** The child's argv, in the web transport's own positional shape. */
function webShapeArgs(tree, treeFiles, profileDir, primaryRuntime) {
  const pnpm = path.join(tree, 'pnpm', 'bin', 'pnpm.mjs')
  return [
    '--expose-internals',
    treeFiles.hostEntry,
    path.join(tree, 'app'),
    profileDir,
    primaryRuntime,
    ...(fs.existsSync(pnpm) ? [pnpm, path.join(tree, 'node')] : []),
  ]
}

/** Spawn the host and resolve its `ready` message (or reject on `fatal`/exit/deadline). */
function startHost(tree, treeFiles, profileDir, primaryRuntime) {
  const args = webShapeArgs(tree, treeFiles, profileDir, primaryRuntime)
  const executable = treeFiles.nodeBin
  const logFd = fs.openSync(hostLog, 'w')
  const child = spawn(executable, args, {
    cwd: profileDir,
    env: childEnv(treeFiles),
    // Index positions ARE the descriptors: the web transport has no pipes, and
    // the IPC channel carries the child's `ready`.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // Without this every console child pops a terminal onto the user's desktop.
    windowsHide: true,
  })
  // The child's RAW bytes go to disk, unredacted, and they must stay a local
  // artifact: the `dsh web:` line carries the one-shot launch token. `redact`
  // runs on what this probe PRINTS (the `section` helper), never on this stream —
  // a chunk boundary can fall inside the token, so a per-chunk rewrite would
  // leave half of it in the file anyway. The file's protections are the ones
  // around it: `scratch/` is gitignored, the token is one-shot and the port is
  // loopback-only. Nothing may copy this file into a report or an issue.
  child.stdout.on('data', (chunk) => fs.writeSync(logFd, chunk))
  child.stderr.on('data', (chunk) => fs.writeSync(logFd, chunk))
  fs.writeSync(logFd, `${JSON.stringify({ executable, args, cwd: profileDir })}\n`)

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the host never reported ready within ${String(HOST_READY_TIMEOUT_MS / 1000)}s; see ${relative(hostLog)}`))
    }, HOST_READY_TIMEOUT_MS)
    child.on('message', (message) => {
      if (message === null || typeof message !== 'object' || !('type' in message)) return
      if (message.type === 'ready') {
        clearTimeout(timer)
        resolve(message)
        return
      }
      if (message.type === 'fatal') {
        clearTimeout(timer)
        reject(new Error(`the host reported fatal: ${String(message.message)}`))
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the host exited with ${String(code)} before reporting ready; see ${relative(hostLog)}`))
    })
  })
  return { child, args, ready }
}

/** Ask the host to shut down the way the shell does, then make sure it is gone. */
async function stopHost(child) {
  try {
    child.send({ type: 'shutdown' })
  } catch {
    /* already gone */
  }
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const winner = await Promise.race([exited.then(() => 'exit'), sleep(8_000).then(() => 'timeout')])
  if (winner === 'timeout') {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  await sleep(300)
}

function readHostLog() {
  if (!fs.existsSync(hostLog)) return { lines: [], skipped: [], notActivated: [] }
  const lines = fs.readFileSync(hostLog, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '')
  return {
    lines,
    skipped: lines.filter((line) => /skipping profile bundle/u.test(line)),
    notActivated: lines.filter((line) => /did not activate|未能激活|failedToLoadPlugins/u.test(line)),
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  assertShellBuild()
  await app.whenReady()
  fs.mkdirSync(logDir, { recursive: true })

  await assertProbeInputs()
  const runtime = await resolveRuntime(args)
  const tree = runtime.dir
  const treeFiles = runtime.files
  const hostPackage = JSON.parse(fs.readFileSync(path.join(tree, 'app', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json'), 'utf8'))

  console.log('runtime tree   : ' + tree + ' (' + runtime.source + ')')
  console.log('host package   : ' + hostPackage.name + '@' + hostPackage.version)
  console.log('entry          : ' + treeFiles.hostEntry)
  // No port precondition: the host binds 0 and the OS assigns one. The reported
  // URL is the only source of truth, and it is checked at A2 below.

  const prepared = await prepareHome(tree, treeFiles)
  console.log('DSH_HOME       : ' + dshHome)
  console.log('profile        : ' + prepared.profileDir)
  console.log('suite layer    : ' + prepared.layer.status + ' → ' + prepared.layer.layerDir)
  console.log('probe fixtures : ' + PROBE_FIXTURES.map((fixture) => path.join(relative(root), 'scripts', 'fixtures', fixture.dirName)).join(', '))

  const { child, args: spawnArgs, ready } = startHost(tree, treeFiles, prepared.profileDir, prepared.primaryRuntime)
  console.log('argv           : ' + redact(JSON.stringify(spawnArgs)))

  try {
    const message = await ready
    section('host ready (over the IPC channel — the same message `handleMessage` reads)', {
      url: redact(String(message.url)),
      injectionRows: Array.isArray(message.injections) ? message.injections.length : null,
      injectionKinds: Array.isArray(message.injections) ? message.injections.map((row) => row?.kind ?? null) : null,
    })
    check('A0 the desktop host reported `ready` with an authenticated URL over the IPC channel',
      typeof message.url === 'string' && message.url.startsWith('http://127.0.0.1:'),
      `url=${redact(String(message.url))}`)
    check('A0 the index injection table came with it (the window cannot boot without it)',
      Array.isArray(message.injections) && message.injections.length > 0,
      `rows=${String(Array.isArray(message.injections) ? message.injections.length : null)}`)

    // The shell's own exchange: one manual fetch, the `set-cookie` of its 303.
    const { authenticateHostWeb } = shellModule('host-web.js')
    const auth = await authenticateHostWeb(message.url)
    const hostPort = portOf(message.url)
    section('session (the shell\'s own `authenticateHostWeb`)', { origin: auth.origin, cookie: auth.cookie })
    check('A1 the shell\'s own authentication exchange bought a session cookie', auth.cookie.startsWith('dsh-auth-'))
    check('A2 the host origin is the one its `ready` URL named, on an OS-assigned port',
      auth.origin === new URL(message.url).origin && hostPort > 0, `${auth.origin} (port ${String(hostPort)})`)

    const base = auth.origin
    const withCookie = { cookie: auth.cookie }
    const url = (pathname) => new URL(pathname, base).href

    // ---------------------------------------------------------------- S1
    const marker = await httpGet(url('/api/plugins/dsh-app/probe-wsinject/marker'), withCookie)
    let markerJson = null
    try { markerJson = JSON.parse(marker.body) } catch { /* reported raw below */ }
    section('S1 — the inject-gated sibling: did a plugin declaring inject: [\'connection\', \'webServer\'] ACTIVATE (is `webServer` in this composition at all)?', {
      request: 'GET /api/plugins/dsh-app/probe-wsinject/marker (with cookie)',
      status: marker.status,
      body: marker.body,
    })
    check('S1 the inject-gated plugin ACTIVATED (its own marker route answered 200 with `activated: true`)',
      marker.status === 200 && markerJson !== null && markerJson.activated === true,
      `status=${String(marker.status)} body=${JSON.stringify(marker.body.slice(0, 160))}`)

    // ---------------------------------------------------------------- S2
    const factsResponse = await httpGet(url('/api/plugins/dsh-app/probe-routes/facts'), withCookie)
    let facts = null
    try { facts = JSON.parse(factsResponse.body) } catch { /* reported raw below */ }
    section('S2 — ctx.get(\'webServer\') inside the plugin process: is the service there, and is it the host package\'s own carrier?', {
      status: factsResponse.status,
      immediate: facts === null ? null : facts.immediate,
      injected: facts === null ? null : facts.injected,
      prefixRoute: facts === null ? null : facts.prefixRoute,
      exactRoute: facts === null ? null : facts.exactRoute,
    })
    check('S2 `ctx.get(\'webServer\')` has a value at apply time, and again inside the optional inject door',
      facts !== null && facts.immediate !== null && facts.immediate.present === true
      && facts.injected !== null && facts.injected.present === true,
      JSON.stringify({ immediate: facts?.immediate, injected: facts?.injected }))
    check('S2 the service is the webserver carrier, on the port the host reported, and it can register',
      facts !== null && facts.injected.port === hostPort && facts.injected.register === 'function'
      && facts.injected.members.includes('collectIndexInjections') && facts.injected.members.includes('registerFallback'),
      JSON.stringify(facts?.injected ?? null))

    // ---------------------------------------------------------------- S3
    const treeRoot = await httpGet(url(TREE_PATH), withCookie)
    const treeDeep = await httpGet(url(`${TREE_PATH}/a/b/c.js`), withCookie)
    const prefixRoot = await httpGet(url('/probe-tree'), withCookie)
    const prefixDeep = await httpGet(url(DEEP_PATH), withCookie)
    const exactRoot = await httpGet(url('/probe-exact'), withCookie)
    const exactDeep = await httpGet(url('/probe-exact/x'), withCookie)
    section('S3 — route kinds: is the Connection route exact-only, and does a kind: \'prefix\' route on webServer serve a DEEP sub-path?', {
      exactRoute: { request: `GET ${TREE_PATH}`, status: treeRoot.status, body: treeRoot.body },
      exactRouteSubPath: { request: `GET ${TREE_PATH}/a/b/c.js`, status: treeDeep.status, body: treeDeep.body.slice(0, 80) },
      prefixRoot: { request: 'GET /probe-tree', status: prefixRoot.status, body: prefixRoot.body },
      prefixDeep: { request: `GET ${DEEP_PATH}`, status: prefixDeep.status, body: prefixDeep.body },
      exactOnWebServer: { request: 'GET /probe-exact', status: exactRoot.status, body: exactRoot.body },
      exactOnWebServerSubPath: { request: 'GET /probe-exact/x', status: exactDeep.status, body: exactDeep.body.slice(0, 80) },
    })
    check('S3 the registered Connection path itself answers 200 with the plugin\'s own body',
      treeRoot.status === 200 && treeRoot.body === 'ABCDEFGHIJ',
      `status=${String(treeRoot.status)} body=${JSON.stringify(treeRoot.body)}`)
    check('S3 a DEEP sub-path of that route does NOT answer (the route is exact)',
      treeDeep.status === 404,
      `status=${String(treeDeep.status)} body=${JSON.stringify(treeDeep.body.slice(0, 80))}`)
    check('S3 the webServer prefix route answers its own path',
      prefixRoot.status === 200 && prefixRoot.body === 'PROBE-PREFIX:/probe-tree',
      `status=${String(prefixRoot.status)} body=${JSON.stringify(prefixRoot.body)}`)
    check('S3 the webServer prefix route ALSO serves the deep sub-path /probe-tree/a/b/c.js',
      prefixDeep.status === 200 && prefixDeep.body === DEEP_BODY,
      `status=${String(prefixDeep.status)} body=${JSON.stringify(prefixDeep.body.slice(0, 120))}`)
    // Re-read: the payload above was captured BEFORE these requests, and the
    // handler records every pathname it is asked for.
    const factsAfterRoutes = JSON.parse((await httpGet(url('/api/plugins/dsh-app/probe-routes/facts'), withCookie)).body)
    section('S3b — the prefix handler\'s own recording, re-read after the requests', factsAfterRoutes.prefixSubpathObserved)
    check('S3 the handler really ran for that sub-path (its own recording names the path it saw)',
      Array.isArray(factsAfterRoutes.prefixSubpathObserved) && factsAfterRoutes.prefixSubpathObserved.includes(DEEP_PATH),
      JSON.stringify(factsAfterRoutes.prefixSubpathObserved))
    check('S3 a kind: \'exact\' route on the same service does NOT serve a sub-path (kind decides)',
      exactRoot.status === 200 && exactRoot.body === 'PROBE-EXACT' && exactDeep.status === 404,
      `exact=${JSON.stringify(exactRoot.body.slice(0, 40))} subPathStatus=${String(exactDeep.status)}`)

    // ---------------------------------------------------------------- S4
    // The half W13 measured on the CLI shape and this one had not: the handler
    // builds its own 206, and whether that survives is a fact about the carrier.
    const treeRange = await httpGet(url(TREE_PATH), { ...withCookie, range: 'bytes=0-3' })
    const treeRangeOpen = await httpGet(url(TREE_PATH), { ...withCookie, range: 'bytes=2-' })
    section('S4 — Range through the Connection carrier: is the handler\'s own 206 passed through untouched?', {
      request: `GET ${TREE_PATH}  Range: bytes=0-3`,
      response: treeRange,
      openRange: {
        request: 'Range: bytes=2-',
        status: treeRangeOpen.status,
        headers: treeRangeOpen.headers,
        body: treeRangeOpen.body,
        bytes: treeRangeOpen.bytes,
      },
    })
    check('S4 the handler\'s 206 status survives the carrier',
      treeRange.status === 206,
      `status=${String(treeRange.status)}`)
    check('S4 content-range survives the carrier',
      treeRange.headers['content-range'] === 'bytes 0-3/10',
      JSON.stringify(treeRange.headers['content-range']))
    check('S4 accept-ranges survives the carrier',
      treeRange.headers['accept-ranges'] === 'bytes',
      JSON.stringify(treeRange.headers['accept-ranges']))
    check('S4 the body is the requested slice, 4 bytes of "ABCD"',
      treeRange.body === 'ABCD',
      `body=${JSON.stringify(treeRange.body)} bytes=${String(treeRange.bytes)}`)
    check('S4 the carrier passes the Range header through to the handler',
      treeRange.headers['x-probe-range-seen'] === 'bytes=0-3',
      JSON.stringify(treeRange.headers['x-probe-range-seen']))
    check('S4 an open-ended range (bytes=2-) also slices correctly',
      treeRangeOpen.status === 206 && treeRangeOpen.body === 'CDEFGHIJ',
      `status=${String(treeRangeOpen.status)} body=${JSON.stringify(treeRangeOpen.body)}`)

    const stream = await httpGetStreaming(url(STREAM_PATH), withCookie)
    section('S4b — is the response body streamed or buffered? (chunk arrival times, 400ms apart in the handler)', stream)
    const marks = stream.marks
    const firstAt = marks.length > 0 ? marks[0].atMs : null
    const lastAt = marks.length > 0 ? marks[marks.length - 1].atMs : null
    check('S4b the streamed body arrives complete',
      stream.status === 200 && stream.body === 'CHUNK-ONE;CHUNK-TWO;CHUNK-THREE;',
      `status=${String(stream.status)} body=${JSON.stringify(stream.body)}`)
    check('S4b the first chunk lands well before the last (the carrier streams, it does not buffer)',
      marks.length >= 2 && firstAt !== null && lastAt !== null && lastAt - firstAt >= 500,
      `marks=${JSON.stringify(marks)} totalMs=${String(stream.totalMs)}`)
    check('S4b a custom response header survives the carrier',
      stream.headers['x-probe-stream'] === 'yes',
      JSON.stringify(stream.headers))

    // ---------------------------------------------------------------- S5a
    const apiNoCookie = await httpGet(url(TREE_PATH))
    const apiForeignOrigin = await httpGet(url(TREE_PATH), { ...withCookie, origin: 'https://evil.example' })
    const apiSameOrigin = await httpGet(url(TREE_PATH), { ...withCookie, origin: base })
    section('S5a — CONTROL, the Connection carrier\'s own fence on the same server (read: 403 when Host/Origin is foreign, 401 without the cookie)', {
      noCookie: { status: apiNoCookie.status, body: apiNoCookie.body },
      foreignOrigin: { status: apiForeignOrigin.status, body: apiForeignOrigin.body },
      sameOriginWithCookie: { status: apiSameOrigin.status, body: apiSameOrigin.body.slice(0, 40) },
    })
    check('S5a the /api carrier refuses a request with NO cookie (401)',
      apiNoCookie.status === 401,
      `status=${String(apiNoCookie.status)} body=${JSON.stringify(apiNoCookie.body.slice(0, 80))}`)
    check('S5a the /api carrier refuses a foreign `Origin` (403)',
      apiForeignOrigin.status === 403,
      `status=${String(apiForeignOrigin.status)} body=${JSON.stringify(apiForeignOrigin.body.slice(0, 80))}`)
    check('S5a the same request with the session cookie and a same-origin Origin passes the fence',
      apiSameOrigin.status === 200,
      `status=${String(apiSameOrigin.status)}`)

    // ---------------------------------------------------------------- S5b
    // The same deep prefix path, with no cookie and with a foreign Origin. This
    // is the measured fact behind W14's "do not make an exception for the
    // resource tree": the fence is the route OWNER's, not the server's.
    const wsNoCookie = await httpGet(url(DEEP_PATH))
    const wsForeignOrigin = await httpGet(url(DEEP_PATH), { origin: 'https://evil.example' })
    const wsSameOriginNoCookie = await httpGet(url(DEEP_PATH), { origin: base })
    section('S5b — the same deep prefix path, with no cookie and with a foreign Origin: is the fence the route owner\'s, or the server\'s?', {
      noCookie: { status: wsNoCookie.status, body: wsNoCookie.body, headers: wsNoCookie.headers },
      foreignOrigin: { status: wsForeignOrigin.status, body: wsForeignOrigin.body, headers: wsForeignOrigin.headers },
      sameOriginNoCookie: { status: wsSameOriginNoCookie.status, body: wsSameOriginNoCookie.body },
    })
    const servedDeep = (response) => response.status === 200 && response.body === DEEP_BODY
    const outsideFence = servedDeep(wsNoCookie) && servedDeep(wsForeignOrigin)
    finding(outsideFence
      ? 'S5b ANSWER: the webServer prefix route answered BOTH a cookie-less and a foreign-Origin request with its own body — it is OUTSIDE the Connection carrier\'s Host/Origin fence and browser authentication'
      : `S5b ANSWER: the webServer prefix route did NOT answer one of the two fence probes (no-cookie ${String(wsNoCookie.status)}, foreign-Origin ${String(wsForeignOrigin.status)}) — the fence moved, and the routing decision it supports has to be re-made`)
    check('S5b the prefix route answers BOTH a cookie-less and a foreign-Origin request (the fence is the route owner\'s, not the server\'s). RED here is an UPSTREAM HARDENING SIGNAL: re-make the W14 routing decision — do NOT loosen this check',
      outsideFence,
      `no-cookie=${String(wsNoCookie.status)}/${JSON.stringify(wsNoCookie.body.slice(0, 40))} foreign-Origin=${String(wsForeignOrigin.status)}/${JSON.stringify(wsForeignOrigin.body.slice(0, 40))}`)
    check('S5b the request was a real same-server request, not a different listener (same port, and the route echoes its own path)',
      servedDeep(wsSameOriginNoCookie),
      `status=${String(wsSameOriginNoCookie.status)} body=${JSON.stringify(wsSameOriginNoCookie.body)}`)

    // ---------------------------------------------------- observation: the index
    // Not a question this probe is asked, but the pair that makes the S5b answer
    // readable: the same server, the same client, one route the app itself owns.
    const indexNoCookie = await httpGet(url('/'))
    const indexWithCookie = await httpGet(url('/'), withCookie)
    section('OBSERVATION — the index document (`/`), the route the shell\'s own window loads', {
      noCookie: {
        status: indexNoCookie.status,
        location: redact(String(indexNoCookie.headers.location ?? '')),
        contentType: indexNoCookie.headers['content-type'] ?? null,
        bytes: indexNoCookie.bytes,
      },
      withCookie: {
        status: indexWithCookie.status,
        contentType: indexWithCookie.headers['content-type'] ?? null,
        bytes: indexWithCookie.bytes,
        carriesBootTable: indexWithCookie.body.includes('__DSH_BOOT__'),
      },
    })
    finding(`OBSERVATION: the index route answered ${String(indexNoCookie.status)} without a cookie and ${String(indexWithCookie.status)} with one`
      + ` (${String(indexNoCookie.bytes)} vs ${String(indexWithCookie.bytes)} bytes) — the fence, where it exists, is applied by the route OWNER, not by the carrier`)

    // ------------------------------------------- positive evidence for the LAYER
    // The negative signals above (no skipped bundle, no failed entry) cannot
    // prove the layer's rows MOUNTED. The host's own boot table can: it carries
    // the composed CLIENT graph as the `__DSH_BOOT__` global, and that graph is
    // built from the Loader's live entries (`ctx.loader.entries()`), so an id in
    // it is a row that mounted. The graph's own bundle URLs are the only URLs the
    // bundle route answers — it matches revisioned resources (`?rev=…`), which is
    // why a hand-written `/plugins/<package>/client.js` is a 404 — so they are
    // taken from the table rather than guessed.
    const bootRow = Array.isArray(message.injections)
      ? message.injections.find((row) => row?.kind === 'global' && row?.name === '__DSH_BOOT__')
      : undefined
    const bootText = bootRow === undefined ? '' : JSON.stringify(bootRow.value)
    const clientIds = [...new Set([...bootText.matchAll(/"id":"([^"]+)"/gu)].map((match) => match[1]))]
    const bundleUrls = (Array.isArray(message.injections) ? message.injections : [])
      .filter((row) => row?.kind === 'script-src' || row?.kind === 'script-preload')
      .map((row) => row.src)
    const suiteClient = suiteRoster().filter((entry) => entry.declaresClient)
    const suiteIdsPresent = suiteClient.filter((entry) => clientIds.includes(entry.name))
    const suiteIdsMissing = suiteClient.filter((entry) => !clientIds.includes(entry.name))
    section('LAYER EVIDENCE — the client graph the host published (`__DSH_BOOT__`) and the bundle URLs it advertises', {
      graphBytes: bootText.length,
      clientIds,
      rosterClientPackages: suiteClient.map((entry) => entry.name),
      rosterClientPackagesPresent: suiteIdsPresent.map((entry) => entry.name),
      rosterClientPackagesMissing: suiteIdsMissing.map((entry) => entry.name),
      bundleUrls: bundleUrls.map((src) => redact(src)),
    })
    // The ROSTER is the judge, not a count: `>= 5` is satisfied by any five ids, so
    // it stays green however many of the roster's declared client halves are absent
    // — the false green this assertion exists to prevent. (Measured on this run:
    // every declared client half was present, so the threshold was green for the
    // right reason and would have been green anyway.) `suiteClient` comes from the
    // shell's `SUITE_PLUGIN_DIRS` plus each package's own `dsh.client`, so the
    // expectation follows the roster instead of an edit here.
    check('L0 the composed client graph names EVERY roster package that declares a client half (`dsh.client`) — those rows are LIVE composition entries',
      suiteClient.length > 0 && suiteIdsMissing.length === 0,
      `${String(suiteIdsPresent.length)}/${String(suiteClient.length)} present`
      + (suiteIdsMissing.length === 0 ? '' : `; missing from the graph: ${JSON.stringify(suiteIdsMissing.map((entry) => entry.name))}`))
    const firstBundle = bundleUrls.length === 0 ? { status: 0, body: '' } : await httpGet(new URL(bundleUrls[0], base).href, withCookie)
    check('L0 the graph\'s own bundle URL is served by the host (200 + JavaScript)',
      firstBundle.status === 200 && firstBundle.body.length > 1000,
      `url=${redact(String(bundleUrls[0] ?? ''))} status=${String(firstBundle.status)} bytes=${String(firstBundle.body.length)}`)

    // ---------------------------------------------------------------- log
    const log = readHostLog()
    const hostLines = log.lines.filter((line) => !line.startsWith('{'))
    section('host log', hostLines.length === 0 ? '(only the spawn record)' : hostLines.join('\n'))
    check('L0 no profile bundle was skipped (a bundle that cannot resolve is the layer failing, and a false green)',
      log.skipped.length === 0,
      JSON.stringify(log.skipped))
    // A GUARD, not evidence: `notActivated` is empty by construction on a log that
    // was never written, so the check also demands the child's own settled line —
    // the one W13's CLI predecessor anchored on with `log.all.length > 0`. A host
    // that renames its banner reads here as `settled=false`, never as a pass.
    const settled = log.lines.some((line) => line.startsWith('dsh web:'))
    check('L0 no composition entry failed to activate — read on a log the child itself wrote to, not on an empty file',
      settled && log.notActivated.length === 0,
      `settled=${String(settled)} notActivated=${JSON.stringify(log.notActivated)}`)
    const profileBundles = JSON.parse(fs.readFileSync(path.join(prepared.profileDir, 'package.json'), 'utf8')).dsh.profile.bundles
    check('L0 the suite layer\'s own rows were in the composition the host booted (its `dsh.profile.bundles` names them)',
      profileBundles.includes('@dsh-app/suite-layer'),
      JSON.stringify(profileBundles))
  } finally {
    await stopHost(child)
  }
}

async function main() {
  let fatal = null
  try {
    await run()
  } catch (error) {
    fatal = error
    console.error('')
    console.error(error.stack || error.message || String(error))
  }
  console.log('')
  if (fatal !== null) {
    console.log(`RESULT: FAIL (crashed before the last assertion: ${fatal.message})`)
  } else if (passed === 0) {
    // A run that asserted nothing is not a clean run. The exit code keys on
    // failures, so without this branch an empty run would print PASS and exit 0.
    console.log('RESULT: FAIL (0 checks ran)')
  } else if (failures.length === 0) {
    console.log(`RESULT: PASS (${String(passed)} checks)`)
  } else {
    console.log(`RESULT: FAIL (${String(passed)} passed, ${String(failures.length)} failed)\n- ${failures.join('\n- ')}`)
  }
  // A crash must never exit 0: a failed wait is a failed run, not a clean one.
  app.exit(fatal !== null || failures.length > 0 || passed === 0 ? 1 : 0)
}

main()
