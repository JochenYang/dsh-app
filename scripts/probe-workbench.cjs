#!/usr/bin/env node
/**
 * Runtime probe for the workbench container (`plugins/plugin-workbench`).
 *
 * The container contributes ONE row to the sidebar's global-panel rail and one
 * `main` keyed full-page container, and that page declares two child seats a
 * DOMAIN plugin registers into (`workbench.item`, `workbench.view`). Whether
 * those seats resolve, what the page renders, where the card's frame lands, and
 * whether leaving the panel resets the page are facts about a RENDERED DOM:
 * `npm run check:slots` proves the registrations resolve and `npm run verify`
 * proves the bundles are served, and neither drives a browser
 * (`docs/agents/kernel-line-regression.md` §6).
 *
 * Shape: the probe unpacks a REAL runtime artifact, boots the REAL kernel child
 * with the SHIPPED overlay (`plugins/dsh-app.patch.yml`, which carries the
 * workbench row) plus one insert row for a walk-in domain plugin
 * (`scripts/fixtures/probe-workbench`, an ordinary `@dsh-app/*` package that
 * fills both seats), and drives the UI in an Electron window. The container
 * itself is linked from the WORKING TREE (`plugins/plugin-workbench/lib`), so a
 * change to it is what gets tested; every other suite plugin comes from the
 * artifact.
 *
 * What it asserts, each from a raw observation printed above the verdict:
 *
 *   A0    both client bundles were SERVED (the container's and the fixture's) —
 *         the fact behind every DOM assertion below
 *   A1    the 工作台 row exists and is the FIRST row of
 *         `nav[aria-label="全局面板"]`; that row carries no `data-slot`
 *         attribute, so the accessible name is the only stable selector on this
 *         kernel line
 *   A2    clicking the row opens the container: title and intro are the
 *         dictionary's zh strings VERBATIM; and — on the empty-state control
 *         load, where the fixture suppresses its card — the dictionary's empty
 *         sentence is rendered and no card is present
 *   A3    the fixture's card is a child of `.dshWorkbench-grid`, entered through
 *         the kernel's `data-slot` anchor, and both seats hold the fixture's
 *         registrations
 *   A3b   the container's card-frame rule lands on the CARD, not on the
 *         renderer's `display: contents` anchor: the anchor measures 0x0 and
 *         does not match the rule, the card does and carries padding, border,
 *         radius and a background
 *   A4    the card's entry opens the view registered under `workbench.view`
 *         (content marker in, grid out), 返回工作台 is rendered VERBATIM, and
 *         returning through it shows the grid again on the SAME page element
 *   A5    `ctx.layout.selectPanel(null)` — and the rail's other row — unmount the
 *         page (measured by an expando stamped on the element: gone means
 *         unmounted, not hidden), and coming back shows a FRESH element with the
 *         grid, not the view the user had opened
 *   A6    a clean boot: the shell reports no unresolved client entry, the kernel
 *         log carries no failure signal, and no slot entry reported a render-time
 *         crash — that last one reaches the console, not the log, so the log
 *         check alone cannot see it
 *   B0-B3 the session-mode door the container added afterwards: a real directory
 *         becomes a workspace (sidebar row appears, container page unmounts,
 *         `activePanelId` back to null), an empty path answers
 *         `error:invalid-argument` and the card renders the container's sentence
 *         for it VERBATIM without navigating, and `window.onerror` /
 *         `unhandledrejection` stayed empty across all of it — which is the point
 *         of `enterWorkspace` answering a token instead of rejecting
 *   W8    every entry point the card renders, and the container's own 返回工作台,
 *         is a real focusable `<button>`; Escape is the same door the back button
 *         is. Before the keyboard check the probe waits for the kernel's own
 *         first-run welcome dialog to be out of the way — while it is up the page
 *         behind it is `inert` and NOTHING in the container can take focus (the
 *         measured failure this assertion used to report). What is deliberately
 *         NOT asserted is arrow-key behaviour INSIDE a
 *         card: the container renders entries of a seat it does not own and
 *         installs no per-card key handling, so there is no such handler to test
 *         (`plugins/plugin-workbench/src/client/page.tsx`)
 *
 * Preconditions refuse rather than degrade: a missing or STALE `lib/` for either
 * half is a hard failure naming the build to run (the same rule as the four
 * plugin gates, `plugins/AGENTS.md` §3), and a runtime tree left over from a
 * different artifact is re-extracted rather than silently reused.
 *
 * Reported but not asserted: console errors over the run. They are the page's
 * own stream and carry whatever the kernel injects; the two arrays the
 * `enterWorkspace` design constraint is about are the per-load `error` /
 * `unhandledrejection` collectors, and those ARE asserted.
 *
 * Run under Electron from Git Bash (the MSYS `tar` cannot open a backslash
 * Windows path, so its arguments are converted to forward slashes):
 *   node_modules/.bin/electron scripts/probe-workbench.cjs
 *   node_modules/.bin/electron scripts/probe-workbench.cjs --tgz runtime-dist/dsh-runtime-win32-x64-0.2.0-rc.2.tgz
 *   node_modules/.bin/electron scripts/probe-workbench.cjs --kernel "<userData>/kernel/dsh-<v>"
 *
 * Exits non-zero on any failed assertion.
 */
const { existsSync, mkdirSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { app, BrowserWindow, session } = require('electron')

// Deterministic locale: the row's accessible name and the container's copy are
// the dictionary's zh strings, and without this switch the renderer would follow
// the machine's own language, making the assertions about the host.
app.commandLine.appendSwitch('lang', 'zh-CN')

const root = path.resolve(__dirname, '..')
const here = path.join(root, 'scratch', 'probe-workbench')
const rtRoot = path.join(here, 'rt')
const runtimeDir = path.join(rtRoot, 'runtime')
const fixtureDir = path.join(root, 'scripts', 'fixtures', 'probe-workbench')
const dshHome = path.join(here, 'home')
const logDir = path.join(here, 'logs')
const overlay = path.join(here, 'overlay.patch.yml')
const kernelLog = path.join(logDir, 'kernel.log')
/** Which artifact the extraction under `rtRoot` came from. */
const marker = path.join(rtRoot, 'extracted-from.txt')

/** The container under test, as the shipped overlay names it. */
const WORKBENCH_DIRNAME = 'plugin-workbench'
const WORKBENCH_PACKAGE = '@dsh-app/plugin-workbench'
const WORKBENCH_BUILD = 'node plugins/plugin-workbench/build.mjs'
/** The walk-in domain plugin this probe adds. */
const PROBE_DIRNAME = 'probe-workbench'
const PROBE_PACKAGE = '@dsh-app/probe-workbench'
const FIXTURE_BUILD = 'node scripts/fixtures/probe-workbench/build.mjs'

/** The container's own dictionary (zh), copied verbatim from its locales.ts. */
const ZH_LABEL = '工作台'
const EN_LABEL = 'Workbench'
const ZH_INTRO = '每个领域在这里放一张卡片，点开即是它自己的工作台。'
const ZH_EMPTY_TEXT = '还没有注册任何领域工作台。领域插件向工作台的座位注册一张卡片后，它就会出现在这里。'
const ZH_BACK = '返回工作台'
/** The fixture's own markers. */
const PROBE_CARD_TEXT = 'PROBE DOMAIN CARD'
const PROBE_VIEW_TEXT = 'PROBE VIEW CONTENT'
/** The container's panel id: the sidebar row and the `main` key are one string. */
const WORKBENCH_PANEL_ID = 'workbench'

/**
 * Session-mode entry (`enterWorkspace`) — the door the B-series is about.
 *
 * The directory is a REAL one under `scratch/`, created by the probe and
 * published to the page before the click, so the bundle carries no path. Its
 * basename is deliberately distinctive: the workspace row's label is the
 * workspace title, which the host derives as `basename(path)`, and the sidebar
 * assertion is a text match on that label.
 */
const WORKDIR_NAME = 'probe-entry-workdir'
/** The exact sentence the container's dictionary holds for `error:invalid-argument`. */
const ENTRY_ERROR_TEXT = '没有可打开的目录。'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms) }),
])
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

const section = (title, value) => {
  console.log(`\n=== ${title} ===`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
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

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitForSettledUrl(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const match = /(?:^|\s)dsh web:\s+(http:\/\/\S+)/m.exec(readFileSync(logPath, 'utf8'))
      if (match !== null) return match[1]
    }
    await sleep(500)
  }
  throw new Error(`kernel never printed its settled URL; see ${logPath}`)
}

/** A runtime tree is only usable when it carries both binaries the child needs. */
function assertRuntimeTree(dir, source) {
  const bin = path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const nodeBin = path.join(dir, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  if (!existsSync(bin) || !existsSync(nodeBin)) {
    throw new Error(`${source} is not a runtime tree: ${bin} and ${nodeBin} must both exist`)
  }
}

/**
 * The runtime tree the kernel child runs out of: an explicit `--kernel`
 * directory, an explicit `--tgz`, or the newest artifact under `runtime-dist/`.
 *
 * An extraction is keyed by its SOURCE: a tree unpacked from a different
 * artifact is discarded instead of reused, because otherwise `--tgz <today's
 * build>` would quietly test yesterday's unpack — the same mistake as a stale
 * `lib/`, one level up.
 */
async function resolveRuntime(args) {
  if (args.kernel !== undefined) {
    const dir = path.resolve(args.kernel)
    assertRuntimeTree(dir, `--kernel ${args.kernel}`)
    return { dir, source: `kernel:${dir}` }
  }
  const distDir = path.join(root, 'runtime-dist')
  let tarball
  if (args.tgz !== undefined) {
    tarball = path.resolve(args.tgz)
    if (!existsSync(tarball)) throw new Error(`--tgz ${args.tgz} does not exist`)
  } else {
    const { newestRuntimeTarball } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'runtime-artifacts.mjs')).href)
    const names = readdirSync(distDir, { throwIfNoEntry: false }) ?? []
    const name = newestRuntimeTarball(names, process.platform, process.arch)
    if (name === null) {
      throw new Error(`no runtime artifact for ${process.platform}-${process.arch} in ${distDir} — build one: npm run runtime:build, or pass --kernel <dir>`)
    }
    tarball = path.join(distDir, name)
  }
  const source = `tgz:${path.basename(tarball)}`
  const extracted = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null
  if (existsSync(runtimeDir) && extracted !== source) {
    const { removeTree } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'remove-tree.mjs')).href)
    console.log(`discarding      : the extraction under ${relative(rtRoot)} (from ${extracted ?? 'an unknown source'})`)
    await removeTree(rtRoot)
  }
  if (!existsSync(runtimeDir)) {
    mkdirSync(rtRoot, { recursive: true })
    console.log(`extracting      : ${path.basename(tarball)}`)
    const slashes = (value) => value.replace(/\\/gu, '/')
    const result = spawnSync('tar', ['--force-local', '-xzf', slashes(tarball), '-C', slashes(rtRoot)], { stdio: 'inherit' })
    if (result.status !== 0) {
      throw new Error(`tar failed with status ${String(result.status)} (the paths above are converted to forward slashes for Git Bash's MSYS tar)`)
    }
    writeFileSync(marker, `${source}\n`)
  }
  assertRuntimeTree(runtimeDir, path.basename(tarball))
  return { dir: runtimeDir, source }
}

/**
 * Refuse to test a build that is missing or older than its own sources.
 *
 * `plugins/plugin-workbench/lib` and the fixture's `lib` are what the kernel
 * serves; a `lib/` from another moment renders the DOM of another moment, and
 * the repository's own freshness check (`scripts/lib/plugin-gates.mjs`, the
 * fourth of the four gates in `plugins/AGENTS.md` §3) is the rule reused here so
 * the probe refuses exactly where a pack refuses.
 */
async function assertProbeInputs() {
  const { pluginLibStaleness } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'plugin-gates.mjs')).href)
  const targets = [
    { what: 'the container under test', dir: path.join(root, 'plugins', WORKBENCH_DIRNAME), build: WORKBENCH_BUILD },
    { what: 'the probe fixture (walk-in domain plugin)', dir: fixtureDir, build: FIXTURE_BUILD },
  ]
  const problems = []
  for (const target of targets) {
    const where = `${target.what} (${relative(target.dir)})`
    if (!existsSync(path.join(target.dir, 'lib', 'client.js'))) {
      problems.push(`${where} is not built — run: ${target.build}`)
      continue
    }
    const { stale, newestInput, libMtime } = pluginLibStaleness(target.dir)
    if (stale) {
      problems.push(`${where} has a lib/ older than its own sources: newest input ${newestInput.path}`
        + ` (${new Date(newestInput.mtimeMs).toISOString()}) is newer than the newest lib/ entry ${libMtime.path}`
        + ` (${new Date(libMtime.mtimeMs).toISOString()}) — rebuild: ${target.build}`)
    }
  }
  if (problems.length > 0) throw new Error(`refusing to assert against a stale or missing build:\n- ${problems.join('\n- ')}`)
}

/**
 * Lay out the scratch home: the profile manifest, the suite links taken from the
 * extracted RUNTIME (what a user's install carries), and the two packages the
 * probe must control itself — `plugins/plugin-workbench` (the container under
 * test) and the fixture — into BOTH `@dsh-app` scopes. Without the booted
 * profile's own scope the packages load and the UI stays silently vanilla
 * (`plugins/AGENTS.md` §6), and the workbench row in the shipped overlay would
 * resolve against nothing.
 *
 * A copy of either package inside the artifact is SKIPPED rather than linked, so
 * the working tree wins and the probe keeps working once a runtime carrying the
 * container is built.
 */
function prepareHome() {
  const profileDir = path.join(dshHome, 'profiles', 'dsh-app')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-dsh-app',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)

  const suiteSource = path.join(runtimeDir, 'app', 'node_modules', '@dsh-app')
  if (!existsSync(suiteSource)) throw new Error(`the runtime tree carries no @dsh-app scope: ${suiteSource}`)
  const shipped = readdirSync(suiteSource)
  const ours = [WORKBENCH_DIRNAME, PROBE_DIRNAME]
  const overridden = shipped.filter((name) => ours.includes(name))
  const sources = shipped
    .filter((name) => !ours.includes(name))
    .map((name) => [name, path.join(suiteSource, name)])
  sources.push([WORKBENCH_DIRNAME, path.join(root, 'plugins', WORKBENCH_DIRNAME)])
  sources.push([PROBE_DIRNAME, fixtureDir])

  for (const scope of [
    path.join(profileDir, 'node_modules', '@dsh-app'),
    path.join(dshHome, 'profiles', 'node_modules', '@dsh-app'),
  ]) {
    mkdirSync(scope, { recursive: true })
    for (const [name, target] of sources) symlinkSync(target, path.join(scope, name), 'junction')
  }

  // BOTH scopes, asserted: the shared link alone leaves the UI silently vanilla
  // (`plugins/AGENTS.md` §6), which would look like a probe finding rather than a
  // broken fixture.
  for (const scope of [
    path.join(profileDir, 'node_modules', '@dsh-app'),
    path.join(dshHome, 'profiles', 'node_modules', '@dsh-app'),
  ]) {
    for (const name of ours) {
      const linked = path.join(scope, name, 'package.json')
      if (!existsSync(linked)) throw new Error(`suite link missing: ${path.relative(root, linked)}`)
    }
  }
  const booted = path.join(profileDir, 'node_modules', '@dsh-app', WORKBENCH_DIRNAME, 'package.json')

  // The SHIPPED overlay, verbatim, plus one insert row for the walk-in plugin.
  const base = readFileSync(path.join(root, 'plugins', 'dsh-app.patch.yml'), 'utf8')
  if (!base.includes(`'${WORKBENCH_PACKAGE}'`)) {
    throw new Error(`plugins/dsh-app.patch.yml carries no row for ${WORKBENCH_PACKAGE} — the probe would test nothing`)
  }
  writeFileSync(overlay, `${base}\n- insert:\n    - id: ${PROBE_DIRNAME}\n      name: '${PROBE_PACKAGE}'\n`)
  return { booted, linked: sources.length, overridden }
}

/** A1: the global-panel rail, and the row whose position this probe is about. */
const SIDEBAR_SNAP = `(function () {
  var nav = document.querySelector('nav[aria-label="全局面板"]')
  var buttons = nav === null ? [] : Array.prototype.slice.call(nav.querySelectorAll('button'))
  var labels = buttons.map(function (b) { return b.getAttribute('aria-label') })
  var row = document.querySelector('button[aria-label=${JSON.stringify(ZH_LABEL)}]')
  var alt = document.querySelector('button[aria-label=${JSON.stringify(EN_LABEL)}]')
  var found = row !== null ? row : alt
  return {
    navFound: nav !== null,
    navAriaLabel: nav === null ? null : nav.getAttribute('aria-label'),
    labels: labels,
    buttonCount: buttons.length,
    workbenchRowIndex: labels.indexOf(${JSON.stringify(ZH_LABEL)}),
    rowFound: found !== null,
    rowTag: found === null ? null : found.tagName,
    rowInsideNav: found !== null && nav !== null && nav.contains(found),
    rowDataSlot: found === null ? null : found.getAttribute('data-slot'),
    rowAttributes: found === null ? null : Array.prototype.map.call(found.attributes, function (a) { return a.name })
  }
})()`

/** A2/A3/A4/A5: everything the centre column says, in one pass. */
const CENTRE_SNAP = `(function () {
  var page = document.querySelector('.dshWorkbench-page')
  var grid = document.querySelector('.dshWorkbench-grid')
  var empty = document.querySelector('.dshWorkbench-empty')
  var card = document.querySelector('[data-probe-card]')
  var view = document.querySelector('[data-probe-view]')
  var back = document.querySelector('.dshWorkbench-back')
  var title = document.querySelector('.dshWorkbench-title')
  var intro = document.querySelector('.dshWorkbench-intro')
  var out = []
  if (grid !== null) {
    for (var i = 0; i < grid.children.length; i++) {
      var child = grid.children[i]
      out.push({
        tag: child.tagName,
        dataSlot: child.getAttribute('data-slot'),
        dataProbeCard: child.getAttribute('data-probe-card'),
        className: String(child.className || '').slice(0, 40),
        attributeNames: Array.prototype.map.call(child.attributes, function (a) { return a.name }),
        text: (child.innerText || '').replace(/\\s+/g, ' ').slice(0, 80)
      })
    }
  }
  // The card's descent path: whether the fixture's own element is INSIDE the
  // container's grid, and what sits between the two.
  var ancestry = []
  for (var node = card; node !== null && node !== grid && ancestry.length < 6; node = node.parentElement) {
    var slot = node.getAttribute('data-slot')
    ancestry.push(node.tagName
      + (node.getAttribute('data-probe-card') !== null ? '[data-probe-card]' : '')
      + (slot === null ? '' : '[data-slot=' + slot + ']'))
  }
  // Node identity across a round trip: an expando survives React reusing the
  // element and disappears when React unmounts it, which is the whole claim
  // behind "the container page resets by unmounting, not by a store".
  var bodyText = document.body.innerText
  return {
    pageInDom: page !== null,
    titleInDom: title !== null,
    titleText: title === null ? null : title.innerText,
    introInDom: intro !== null,
    introTextMatches: intro !== null && intro.innerText === ${JSON.stringify(ZH_INTRO)},
    emptyInDom: empty !== null,
    emptyText: empty === null ? null : empty.innerText,
    emptyTextMatches: empty !== null && empty.innerText === ${JSON.stringify(ZH_EMPTY_TEXT)},
    gridInDom: grid !== null,
    gridChildCount: grid === null ? null : grid.children.length,
    gridChildren: out,
    gridContainsCard: grid !== null && card !== null && grid.contains(card),
    cardAncestry: ancestry,
    cardInDom: card !== null,
    cardText: card === null ? null : card.innerText,
    cardTextInBody: bodyText.indexOf(${JSON.stringify(PROBE_CARD_TEXT)}) >= 0,
    pageToken: page === null ? null : (page.__probeToken === undefined ? 'NO-TOKEN (fresh element)' : page.__probeToken),
    viewInDom: view !== null,
    viewKey: view === null ? null : view.getAttribute('data-probe-view'),
    viewText: view === null ? null : view.innerText,
    backInDom: back !== null,
    backText: back === null ? null : back.innerText,
    backTextMatches: back !== null && back.innerText === ${JSON.stringify(ZH_BACK)},
    bodyHead: bodyText.replace(/\\s+/g, ' ').slice(0, 160)
  }
})()`

/**
 * Where the container's card-frame rule actually lands. `.dshWorkbench-grid > *`
 * matches ELEMENTS whose parent is the grid — so what it styles is whatever the
 * renderer put there, which this probe reads rather than assumes.
 */
const FRAME_SNAP = `(function () {
  var grid = document.querySelector('.dshWorkbench-grid')
  if (grid === null) return { gridInDom: false }
  var anchor = grid.children.length > 0 ? grid.children[0] : null
  var card = document.querySelector('[data-probe-card]')
  var box = function (el) {
    if (el === null) return null
    var r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  var frameOf = function (el) {
    if (el === null) return null
    var s = getComputedStyle(el)
    return {
      display: s.display,
      paddingTop: s.paddingTop,
      borderTopWidth: s.borderTopWidth,
      borderRadius: s.borderTopLeftRadius,
      backgroundColor: s.backgroundColor
    }
  }
  return {
    gridInDom: true,
    gridBox: box(grid),
    gridDisplay: getComputedStyle(grid).display,
    anchorTag: anchor === null ? null : anchor.tagName,
    anchorDataSlot: anchor === null ? null : anchor.getAttribute('data-slot'),
    anchorInlineStyle: anchor === null ? null : anchor.getAttribute('style'),
    anchorFrame: frameOf(anchor),
    anchorBox: box(anchor),
    cardFrame: frameOf(card),
    cardBox: box(card),
    // Only the card half is kept: the anchor is the grid's own direct child, so a
    // rule that requires the PARENT to carry data-slot can never match it.
    // anchorMatchesRule was a tautology, and a tautology in a probe inflates the
    // count without guarding anything.
    cardMatchesRule: card !== null && card.matches('.dshWorkbench-grid > [data-slot] > *:not(.dshWorkbench-empty)')
  }
})()`

/** The seam the fixture published: live seat registry + panel store. */
const SEAM_SNAP = `(function () {
  if (window.__probeWorkbenchPage === undefined) return { globalMissing: true }
  return {
    globalMissing: false,
    skipCard: window.__probeWorkbenchPage.skipCard,
    activePanelId: window.__probeWorkbenchPage.activePanelId(),
    cardIds: window.__probeWorkbenchPage.cardIds(),
    viewIds: window.__probeWorkbenchPage.viewIds()
  }
})()`

const CLICK_WORKBENCH_ROW = `(function () {
  var row = document.querySelector('button[aria-label=${JSON.stringify(ZH_LABEL)}]')
  if (row === null) return 'no row'
  row.click()
  return 'clicked ' + row.getAttribute('aria-label')
})()`

/** Click any global-panel row that is NOT the workbench (the user's other move). */
const CLICK_OTHER_ROW = `(function () {
  var nav = document.querySelector('nav[aria-label="全局面板"]')
  if (nav === null) return 'no nav'
  var buttons = Array.prototype.slice.call(nav.querySelectorAll('button'))
  var other = buttons.filter(function (b) { return b.getAttribute('aria-label') !== ${JSON.stringify(ZH_LABEL)} })[0]
  if (other === undefined) return 'no other row'
  other.click()
  return 'clicked ' + other.getAttribute('aria-label')
})()`

const CLICK_CARD_OPEN = `(function () {
  var button = document.querySelector('[data-probe-open]')
  if (button === null) return 'no card entry'
  button.click()
  return 'clicked card entry'
})()`

const CLICK_BACK = `(function () {
  var back = document.querySelector('.dshWorkbench-back')
  if (back === null) return 'no back button'
  back.click()
  return 'clicked back'
})()`

const ESCAPE_VIEW = `(function () {
  // The container listens on the document while a view is open (the same idiom
  // the suite's dialogs use), so a synthetic keydown reaches the same handler a
  // real Escape would.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  return 'dispatched Escape'
})()`

const SELECT_PANEL_NULL = `(function () {
  if (window.__probeWorkbenchPage === undefined) return 'no seam'
  window.__probeWorkbenchPage.selectPanel(null)
  return 'selectPanel(null)'
})()`

/**
 * Stamp the mounted container page with a fresh token. The token rides the DOM
 * element itself, so reading it later answers "is this the SAME element?" —
 * which is how the unmount claim is proved rather than inferred.
 */
const STAMP_PAGE = `(function () {
  var page = document.querySelector('.dshWorkbench-page')
  if (page === null) return 'no page'
  var token = 'T' + Date.now() + Math.random().toString(16).slice(2, 6)
  page.__probeToken = token
  return token
})()`

const BOOT_HEALTH = `(function () {
  var text = document.body.innerText
  return {
    failedToLoadPlugins: /Failed to load plugins|插件加载失败/.test(text),
    entriesDidNotActivate: /did not activate|未能激活/.test(text),
    rootChildren: document.getElementById('root') === null ? 0 : document.getElementById('root').children.length,
    bodyHead: text.replace(/\\s+/g, ' ').slice(0, 160)
  }
})()`

/**
 * Arm the probe's own dismisser for the kernel's first-run welcome dialog
 * ("预览版说明").
 *
 * It mounts a few seconds AFTER boot and puts the page behind it `inert` —
 * measured, not inferred: while it was up the dialog's own `h2` held focus and
 * `back.closest('[inert]')` was true, so nothing inside the container could take
 * focus. A fixed sleep races it (the scratch harness's 7s happened to land after
 * it), so the probe installs a MutationObserver instead and never waits: the
 * dialog is clicked the moment it appears, and the observer disconnects itself
 * after one success.
 *
 * The matcher is deliberately narrow — an `h1`/`h2`/`h3` whose text is exactly
 * 预览版说明, and the first button in its nearest ancestor that has one — so no
 * other surface in the app can be clicked by accident.
 */
const ARM_WELCOME_DISMISSER = `(function () {
  if (window.__probeDismissWelcome !== undefined) return 'already armed'
  window.__probeWelcomeDismissals = []
  window.__probeDismissWelcome = function () {
    var headings = Array.prototype.slice.call(document.querySelectorAll('h1, h2, h3'))
    var heading = headings.filter(function (h) { return (h.textContent || '').trim() === '预览版说明' })[0]
    if (heading === undefined) return null
    var button = null
    for (var node = heading; node !== null && node !== document.body; node = node.parentElement) {
      var candidate = node.querySelector('button')
      if (candidate !== null) { button = candidate; break }
    }
    if (button === null) return null
    window.__probeWelcomeDismissals.push((button.textContent || '').trim())
    button.click()
    return (button.textContent || '').trim()
  }
  var observer = new MutationObserver(function () {
    // A re-render replaces the dialog's node, which would drop a one-shot click.
    if (window.__probeDismissWelcome() !== null) observer.disconnect()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  if (window.__probeDismissWelcome() !== null) observer.disconnect()
  return 'armed'
})()`

/** Whether the welcome dialog is still up, and what the dismisser has done. */
const WELCOME_SNAP = `(function () {
  var headings = Array.prototype.slice.call(document.querySelectorAll('h1, h2, h3'))
  var heading = headings.filter(function (h) { return (h.textContent || '').trim() === '预览版说明' })[0]
  var active = document.activeElement
  return {
    armed: window.__probeDismissWelcome !== undefined,
    dismissals: window.__probeWelcomeDismissals === undefined ? null : window.__probeWelcomeDismissals.slice(),
    dialogUp: heading !== undefined,
    inertNodes: document.querySelectorAll('[inert]').length,
    activeTag: active === null ? null : active.tagName,
    activeClassName: active === null ? null : String(active.className || '').slice(0, 60)
  }
})()`

const SET_NO_CARD = `(function () {
  sessionStorage.setItem('probeNoCard', '1')
  return sessionStorage.getItem('probeNoCard')
})()`

const CLEAR_NO_CARD = `(function () {
  sessionStorage.removeItem('probeNoCard')
  return String(sessionStorage.getItem('probeNoCard'))
})()`

/**
 * Publish the directory the success-path button will send, and read it back.
 *
 * The card reads this global AT CLICK TIME, so the value a probe sees here is
 * the value the container's seam received — no path is baked into the bundle.
 */
const SET_ENTRY_PATH = `(function () {
  window.__probeWorkbenchEntryPath = ${JSON.stringify(path.join(here, WORKDIR_NAME))}
  return window.__probeWorkbenchEntryPath
})()`

/**
 * Error collector. A page reload replaces the window, so this is installed once
 * per load; the array it fills is what "the flow raised nothing" is read from.
 *
 * `error` and `unhandledrejection` are the two shapes a broken
 * `enterWorkspace` would take — the design constraint is that it answers a
 * status token instead of rejecting, so a rejection here is a real finding and
 * `console-message` alone would not see it.
 */
const INSTALL_ERROR_COLLECTOR = `(function () {
  if (window.__probeErrors !== undefined) return 'already installed'
  var errors = []
  window.__probeErrors = errors
  window.addEventListener('error', function (event) {
    errors.push('error: ' + (event.message || String(event.error)))
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason
    errors.push('unhandledrejection: ' + (reason && reason.message ? reason.message : String(reason)))
  })
  return 'installed'
})()`

const READ_ERRORS = `(function () {
  if (window.__probeErrors === undefined) return { collectorMissing: true }
  return { collectorMissing: false, count: window.__probeErrors.length, errors: window.__probeErrors.slice() }
})()`

const CLICK_ENTER_WORKSPACE = `(function () {
  var button = document.querySelector('[data-probe-enter-workspace]')
  if (button === null) return 'no workspace entry'
  var published = window.__probeWorkbenchEntryPath
  button.click()
  return 'clicked with path=' + String(published)
})()`

const CLICK_ENTER_EMPTY = `(function () {
  var button = document.querySelector('[data-probe-enter-empty]')
  if (button === null) return 'no empty-path entry'
  button.click()
  return 'clicked'
})()`

/** Every entry point the card renders, as elements — reachability is a tag fact. */
const CARD_ENTRY_ELEMENTS = `(function () {
  var selectors = ['[data-probe-open]', '[data-probe-enter-workspace]', '[data-probe-enter-empty]']
  var out = []
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i])
    out.push({
      selector: selectors[i],
      found: el !== null,
      tagName: el === null ? null : el.tagName,
      type: el === null ? null : el.getAttribute('type'),
      tabIndex: el === null ? null : el.tabIndex,
      text: el === null ? null : (el.textContent || '').trim()
    })
  }
  return out
})()`

/** The card's own words after an entry attempt, kept apart from the raw token. */
const CARD_ENTRY_SNAP = `(function () {
  var card = document.querySelector('[data-probe-card]')
  var token = document.querySelector('[data-probe-entry-token]')
  var pathNode = document.querySelector('[data-probe-entry-path]')
  var message = document.querySelector('[data-probe-entry-message]')
  return {
    cardInDom: card !== null,
    cardText: card === null ? null : card.innerText,
    tokenText: token === null ? null : token.textContent,
    pathText: pathNode === null ? null : pathNode.textContent,
    messageText: message === null ? null : message.textContent,
    workbenchPageInDom: document.querySelector('.dshWorkbench-page') !== null,
    activePanelId: window.__probeWorkbenchPage === undefined ? 'NO-SEAM' : window.__probeWorkbenchPage.activePanelId()
  }
})()`

/**
 * W8: the container's own back control, focused programmatically. `tabIndex` is
 * read off the live element (`-1` for a non-focusable control), and
 * `document.activeElement` is the answer to "did the focus land".
 *
 * `before`/`after` identify the element that had focus before the call and the
 * one that holds it immediately after: when the call does NOT land, WHO took the
 * focus is the whole reading, and a tag name alone has already been read wrong
 * once in this probe.
 */
const BACK_FOCUS_SNAP = `(function () {
  var back = document.querySelector('.dshWorkbench-back')
  if (back === null) return { backInDom: false }
  var describe = function (el) {
    if (el === null) return null
    return {
      tag: el.tagName,
      tabIndex: el.tabIndex,
      className: String(el.className || '').slice(0, 60),
      text: (el.textContent || '').trim().slice(0, 40),
      outerHtml: el.outerHTML.slice(0, 200)
    }
  }
  var before = describe(document.activeElement)
  back.focus()
  var active = document.activeElement
  var rect = back.getBoundingClientRect()
  return {
    backInDom: true,
    backTag: back.tagName,
    backType: back.getAttribute('type'),
    backTabIndex: back.tabIndex,
    backText: back.innerText,
    backBox: { w: Math.round(rect.width), h: Math.round(rect.height) },
    backDisabled: back.disabled === true,
    backInert: back.closest('[inert]') !== null,
    focusLandedOnBack: active === back,
    activeTag: active === null ? null : active.tagName,
    activeTabIndex: active === null ? null : active.tabIndex,
    before,
    after: describe(active),
    documentHasFocus: document.hasFocus()
  }
})()`

/**
 * The sidebar's workspace rows, located by the session tree's own `data-row-key`
 * (`workspace:<workspaceId>`, measured on this kernel line) and matched by the
 * TEXT a user reads — the workspace title, which the host derives from the
 * directory's basename.
 */
const WORKSPACE_ROWS_SNAP = `(function () {
  var name = ${JSON.stringify(WORKDIR_NAME)}
  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-key]'))
  var workspaceRows = rows.filter(function (r) {
    return String(r.getAttribute('data-row-key')).indexOf('workspace:') === 0
  })
  var matching = workspaceRows.filter(function (r) { return (r.innerText || '').indexOf(name) >= 0 })
  return {
    allRowKeys: rows.map(function (r) { return r.getAttribute('data-row-key') }),
    workspaceRows: workspaceRows.map(function (r) {
      return {
        rowKey: r.getAttribute('data-row-key'),
        role: r.getAttribute('role'),
        text: (r.innerText || '').replace(/\\s+/g, ' ').trim()
      }
    }),
    matchingRowKeys: matching.map(function (r) { return r.getAttribute('data-row-key') }),
    matchingRowTexts: matching.map(function (r) { return (r.innerText || '').replace(/\\s+/g, ' ').trim() }),
    matchingRowOuterHtml: matching.length === 0 ? null : matching[0].outerHTML.slice(0, 240),
    bodyHead: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200)
  }
})()`

/** The middle column's own answer to "did the frame leave the workbench?". */
const MIDDLE_COLUMN_SNAP = `(function () {
  return {
    workbenchPageInDom: document.querySelector('.dshWorkbench-page') !== null,
    workbenchPageSelectorCount: document.querySelectorAll('.dshWorkbench-page').length,
    activePanelId: window.__probeWorkbenchPage === undefined ? 'NO-SEAM' : window.__probeWorkbenchPage.activePanelId(),
    composerInDom: /描述你想要构建的内容|Describe what you want to build/.test(document.body.innerText),
    bodyHead: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200)
  }
})()`

/** The kernel's own log, redacted; the only place a rejected overlay row shows. */
function readKernelLog() {
  if (!existsSync(kernelLog)) return { all: [], suspicious: [] }
  const text = readFileSync(kernelLog, 'utf8').replace(/token=[^\s&]*/gu, 'token=<redacted>')
  const all = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  return { all, suspicious: all.filter((line) => /did not activate|failedToLoadPlugins|not found|ERR_MODULE|failed/.test(line)) }
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  await app.whenReady()
  mkdirSync(logDir, { recursive: true })

  await assertProbeInputs()
  const runtime = await resolveRuntime(args)
  const runtimeDirResolved = runtime.dir

  // The home holds junctions into the runtime tree, so it goes through the
  // link-safe walker rather than a sync recursive delete.
  if (existsSync(dshHome)) {
    const { removeTree } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'remove-tree.mjs')).href)
    await removeTree(dshHome)
  }
  const home = prepareHome()
  // The directory the session-mode entry is asked to adopt. Real, absolute and
  // under `scratch/` (gitignored): the host canonicalises it with `realpath` and
  // refuses anything that is not an existing directory.
  const workdir = path.join(here, WORKDIR_NAME)
  mkdirSync(workdir, { recursive: true })

  console.log(`app locale     : ${app.getLocale()}`)
  console.log(`runtime        : ${runtimeDirResolved} (${runtime.source})`)
  console.log(`DSH_HOME       : ${dshHome}`)
  console.log(`linked         : ${String(home.linked)} packages into both @dsh-app scopes`)
  console.log(`container      : ${home.booted}${home.overridden.includes(WORKBENCH_DIRNAME) ? ' (working tree; the artifact copy was skipped)' : ''}`)
  console.log(`domain plugin  : ${path.join(fixtureDir, 'lib', 'client.js')}`)
  console.log(`overlay        : ${overlay}`)
  console.log(`workdir        : ${workdir}`)

  const nodeBin = path.join(runtimeDirResolved, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const script = path.join(runtimeDirResolved, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  // Truncated rather than deleted so the log holds this run alone.
  writeFileSync(kernelLog, '')
  const port = await freePort()
  console.log(`port           : ${String(port)}`)

  const logFd = openSync(kernelLog, 'a')
  const child = spawn(nodeBin, [script, '--profile', 'dsh-app', '--patch', overlay, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: runtimeDirResolved,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, DSH_HOME: dshHome, DSH_APP_PROFILE: 'dsh-app' },
    // Without this every console child pops a terminal onto the user's desktop.
    windowsHide: true,
  })

  try {
    const settled = await waitForSettledUrl(kernelLog, 240_000)
    console.log(`settled        : ${settled.replace(/\?.*$/u, '?token=<redacted>')}`)

    // Provenance: which client modules the shell actually asked the kernel for.
    const moduleGets = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (details.url.includes(WORKBENCH_DIRNAME) || details.url.includes(PROBE_PACKAGE)) {
        moduleGets.push(details.url.replace(/token=[^&]*/gu, 'token=<redacted>'))
      }
      callback({})
    })
    await session.defaultSession.clearStorageData({ storages: ['cookies', 'localstorage', 'sessionstorage'] }).catch(() => undefined)

    const win = new BrowserWindow({
      width: 1440, height: 900, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    })
    const consoleErrors = []
    win.webContents.on('console-message', (...logArgs) => {
      const event = logArgs[0]
      const level = typeof event === 'object' ? event.level : logArgs[1]
      const message = typeof event === 'object' ? event.message : logArgs[2]
      if (level === 'error' || level === 3) consoleErrors.push(String(message).slice(0, 500))
    })

    /**
     * Poll a page expression until it says what the next assertion reads. A fixed
     * sleep is a guess about how long the renderer needs: this waits for the
     * state, so a slow machine slows the probe instead of failing it, and the
     * failure names the observation it never got.
     */
    const waitUntil = async (label, timeoutMs, expression, holds) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const observed = await win.webContents.executeJavaScript(expression)
        if (holds(observed)) return observed
        if (Date.now() > deadline) {
          throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${label}; last observation: ${JSON.stringify(observed).slice(0, 600)}`)
        }
        await sleep(250)
      }
    }

    const loadAndSettle = async (label) => {
      await withTimeout(win.loadURL(settled), 60_000, `${label}: the page load`)
      await waitUntil(`${label}: the app to mount`, 60_000, BOOT_HEALTH, (health) => health.rootChildren > 0)
      // A reload replaces the window, so every load installs its own collector
      // and its own welcome dismisser. Installed after `loadURL` resolves, i.e.
      // after the initial scripts ran — what they cover is everything the probe
      // then drives, not first-paint.
      await win.webContents.executeJavaScript(INSTALL_ERROR_COLLECTOR)
      const armed = await win.webContents.executeJavaScript(ARM_WELCOME_DISMISSER).catch((error) => `threw: ${error.message}`)
      return armed
    }

    await loadAndSettle('first load')

    // ---------------------------------------------------------------- A6
    const boot = await win.webContents.executeJavaScript(BOOT_HEALTH)
    section('A6 — boot health', boot)
    check('A6 the shell reports no unresolved client entry and no failed plugin',
      boot.failedToLoadPlugins === false && boot.entriesDidNotActivate === false,
      JSON.stringify(boot))
    check('A6 the app mounted a root element', boot.rootChildren > 0, `rootChildren=${String(boot.rootChildren)}`)

    // ---------------------------------------------------------------- A0
    const deadline = Date.now() + 20_000
    let provenance = []
    for (;;) {
      provenance = [...new Set(moduleGets)]
      if ((provenance.some((url) => url.includes(WORKBENCH_DIRNAME)) && provenance.some((url) => url.includes(PROBE_PACKAGE))) || Date.now() > deadline) break
      await sleep(250)
    }
    section('A0 — module provenance (requests naming the container and the fixture)', provenance)
    check('A0 the kernel served the container\'s client bundle',
      provenance.some((url) => url.includes(WORKBENCH_DIRNAME)),
      JSON.stringify(provenance))
    check("A0 the kernel served the fixture's client bundle",
      provenance.some((url) => url.includes(PROBE_PACKAGE)),
      JSON.stringify(provenance))

    // ---------------------------------------------------------------- A1
    const rail = await win.webContents.executeJavaScript(SIDEBAR_SNAP)
    section('A1 — global-panel rail, before any click', rail)
    const seats = await win.webContents.executeJavaScript(SEAM_SNAP)
    section('A0/A1 — live seats + panel store as the fixture sees them', seats)

    check('A1 the global-panel rail exists with its zh accessible name',
      rail.navFound === true && rail.navAriaLabel === '全局面板',
      `navFound=${String(rail.navFound)} navAriaLabel=${JSON.stringify(rail.navAriaLabel)}`)
    check('A1 the 工作台 row is the rail\'s FIRST row and is inside the rail',
      rail.rowFound === true && rail.rowInsideNav === true && rail.rowTag === 'BUTTON' && rail.workbenchRowIndex === 0,
      `index=${String(rail.workbenchRowIndex)} tag=${String(rail.rowTag)} insideNav=${String(rail.rowInsideNav)} labels=${JSON.stringify(rail.labels)}`)
    // Only the half this file DEPENDS on is asserted: the row must carry an
    // `aria-label`, because that is the only selector used here. Whether it also
    // carries `data-slot` is the kernel's business — upstream adding one would be
    // an improvement, and asserting its absence would turn that into a red probe
    // with no regression behind it. The value is printed either way.
    check('A1 the row is addressable by its accessible name',
      Array.isArray(rail.rowAttributes) && rail.rowAttributes.includes('aria-label'),
      `attributes=${JSON.stringify(rail.rowAttributes)} data-slot=${JSON.stringify(rail.rowDataSlot)}`)
    check('A1 the fixture registered into both container seats before any click',
      seats.globalMissing === false && Array.isArray(seats.cardIds) && seats.cardIds.includes('probe')
      && Array.isArray(seats.viewIds) && seats.viewIds.includes('probe'),
      JSON.stringify(seats))

    // ---------------------------------------------------------------- A2
    section('A2 — click the 工作台 row', await win.webContents.executeJavaScript(CLICK_WORKBENCH_ROW))
    await waitUntil('the fixture card to appear in the container grid', 30_000, CENTRE_SNAP, (centre) => centre.gridContainsCard === true)
    const opened = await win.webContents.executeJavaScript(CENTRE_SNAP)
    section('A2/A3 — centre column with the card registered', opened)
    const openedSeam = await win.webContents.executeJavaScript(SEAM_SNAP)
    section('A2 — panel store after opening the panel', openedSeam)

    // The row's own selected state is a user-visible fact the rest of A2 does not
    // cover: the page can be mounted while the rail still marks the previous row
    // as current, and nothing else here would notice.
    const rowAriaCurrent = await win.webContents.executeJavaScript(
      `(function () { var r = document.querySelector('button[aria-label=${JSON.stringify(ZH_LABEL)}]'); return r === null ? null : r.getAttribute('aria-current') })()`)
    check('A2 the sidebar row marks itself as the selected panel',
      rowAriaCurrent === 'page', `aria-current=${JSON.stringify(rowAriaCurrent)}`)

    check('A2 clicking the row mounts the container page and selects its panel id',
      opened.pageInDom === true && openedSeam.activePanelId === WORKBENCH_PANEL_ID,
      `pageInDom=${String(opened.pageInDom)} activePanelId=${JSON.stringify(openedSeam.activePanelId)}`)
    check('A2 the page renders the dictionary title VERBATIM',
      opened.titleInDom === true && opened.titleText === ZH_LABEL,
      JSON.stringify(opened.titleText))
    check('A2 the page renders the dictionary intro VERBATIM',
      opened.introTextMatches === true,
      JSON.stringify(opened.introTextMatches))

    // ---------------------------------------------------------------- A3
    check('A3 the fixture card is a child of the container grid and rendered',
      opened.gridContainsCard === true && opened.gridChildCount >= 1 && opened.cardTextInBody === true,
      `gridContainsCard=${String(opened.gridContainsCard)} gridChildCount=${String(opened.gridChildCount)}`)
    check('A3 the card is entered through the kernel\'s seat anchor (data-slot below the grid)',
      opened.cardAncestry.length > 0 && opened.cardAncestry[opened.cardAncestry.length - 1] === 'DIV[data-slot=workbench.item]',
      JSON.stringify(opened.cardAncestry))

    const token = await win.webContents.executeJavaScript(STAMP_PAGE)
    section('A5 — node-identity token stamped on the mounted page', token)

    const frame = await win.webContents.executeJavaScript(FRAME_SNAP)
    section('A3b — where the card-frame rule lands', frame)
    check('A3b the grid renders through the kernel\'s slot anchor (display: contents, 0x0 box)',
      frame.gridInDom === true && frame.anchorDataSlot === 'workbench.item'
      && frame.anchorFrame.display === 'contents' && frame.anchorBox.w === 0 && frame.anchorBox.h === 0,
      JSON.stringify({ anchorDataSlot: frame.anchorDataSlot, anchorFrame: frame.anchorFrame, anchorBox: frame.anchorBox }))
    check('A3b the card-frame rule matches the CARD and not the anchor',
      frame.cardMatchesRule === true,
      `cardMatchesRule=${String(frame.cardMatchesRule)}`)
    check('A3b the card carries the frame that rule draws (padding, border, radius, background)',
      frame.cardMatchesRule === true
      && frame.cardFrame.paddingTop !== '0px' && frame.cardFrame.borderTopWidth !== '0px'
      && frame.cardFrame.borderRadius !== '0px' && frame.cardFrame.backgroundColor !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(frame.cardFrame))

    // ---------------------------------------------------------------- A4
    section('A4 — click the card entry', await win.webContents.executeJavaScript(CLICK_CARD_OPEN))
    const view = await waitUntil('the view registered in workbench.view to appear', 20_000, CENTRE_SNAP, (centre) => centre.viewInDom === true)
    section('A4 — centre column showing workbench.view', view)
    check('A4 the card entry opens the view registered under workbench.view (content in, grid out)',
      view.viewInDom === true && view.viewKey === 'probe' && view.viewText === PROBE_VIEW_TEXT && view.gridInDom === false,
      JSON.stringify({ viewKey: view.viewKey, viewText: view.viewText, gridInDom: view.gridInDom }))
    check('A4 返回工作台 is rendered VERBATIM while the view is open',
      view.backInDom === true && view.backTextMatches === true,
      JSON.stringify(view.backText))
    check('A4 opening the view keeps the SAME page element (the container switches content, not page)',
      view.pageToken === token,
      `before=${String(token)} after=${JSON.stringify(view.pageToken)}`)

    section('A4b — click 返回工作台', await win.webContents.executeJavaScript(CLICK_BACK))
    const backOnGrid = await waitUntil('the grid to come back after 返回工作台', 20_000, CENTRE_SNAP,
      (centre) => centre.pageInDom === true && centre.gridInDom === true && centre.viewInDom === false)
    section('A4b — centre column back on the grid', backOnGrid)
    check('A4b 返回工作台 returns to the grid with the card still in it',
      backOnGrid.gridContainsCard === true && backOnGrid.cardInDom === true && backOnGrid.viewInDom === false,
      JSON.stringify({ gridContainsCard: backOnGrid.gridContainsCard, viewInDom: backOnGrid.viewInDom }))

    // ---------------------------------------------------------------- A5
    // Re-open the view, then leave the panel the way the store's own API does.
    section('A5 — reopen the view', await win.webContents.executeJavaScript(CLICK_CARD_OPEN))
    await waitUntil('the view to be open before leaving', 20_000, CENTRE_SNAP, (centre) => centre.viewInDom === true)
    section('A5 — ctx.layout.selectPanel(null)', await win.webContents.executeJavaScript(SELECT_PANEL_NULL))
    const left = await waitUntil('the container page to unmount', 20_000, CENTRE_SNAP, (centre) => centre.pageInDom === false)
    const leftSeam = await win.webContents.executeJavaScript(SEAM_SNAP)
    section('A5 — after leaving: panel store + centre column', { seam: leftSeam, centre: left })
    check('A5 selectPanel(null) unmounts the container page and clears the selection',
      left.pageInDom === false && left.pageToken === null && leftSeam.activePanelId === null,
      `pageInDom=${String(left.pageInDom)} pageToken=${JSON.stringify(left.pageToken)} activePanelId=${JSON.stringify(leftSeam.activePanelId)}`)

    section('A5 — click the 工作台 row again', await win.webContents.executeJavaScript(CLICK_WORKBENCH_ROW))
    const returned = await waitUntil('the grid to show again after returning', 30_000, CENTRE_SNAP, (centre) => centre.gridInDom === true)
    section('A5 — back on the workbench: grid or the old view?', returned)
    check('A5 returning shows the GRID, not the view that was open',
      returned.gridInDom === true && returned.viewInDom === false && returned.gridContainsCard === true,
      JSON.stringify({ gridInDom: returned.gridInDom, viewInDom: returned.viewInDom }))
    check('A5 the returned page is a FRESH element (the old one was unmounted, not hidden)',
      returned.pageToken === 'NO-TOKEN (fresh element)',
      `token before leaving=${String(token)} after returning=${JSON.stringify(returned.pageToken)}`)

    // The same round trip through the user's other move: click another row.
    section('A5b — reopen the view', await win.webContents.executeJavaScript(CLICK_CARD_OPEN))
    await waitUntil('the view to be open before leaving via the rail', 20_000, CENTRE_SNAP, (centre) => centre.viewInDom === true)
    const stampedAgain = await win.webContents.executeJavaScript(STAMP_PAGE)
    section('A5b — node-identity token stamped on the mounted page', stampedAgain)
    section('A5b — click another global-panel row', await win.webContents.executeJavaScript(CLICK_OTHER_ROW))
    await waitUntil('the page to unmount when another row is clicked', 20_000, CENTRE_SNAP, (centre) => centre.pageInDom === false)
    const leftViaRail = await win.webContents.executeJavaScript(SEAM_SNAP)
    section('A5b — panel store after leaving via the rail', leftViaRail)
    check('A5b clicking another rail row leaves the workbench panel (another panel is selected)',
      leftViaRail.globalMissing === false && leftViaRail.activePanelId !== WORKBENCH_PANEL_ID && leftViaRail.activePanelId !== null,
      `activePanelId=${JSON.stringify(leftViaRail.activePanelId)}`)

    section('A5b — click the 工作台 row again', await win.webContents.executeJavaScript(CLICK_WORKBENCH_ROW))
    const returnedViaRail = await waitUntil('the grid to show again after returning via the rail', 30_000, CENTRE_SNAP,
      (centre) => centre.gridInDom === true)
    section('A5b — back on the workbench: grid or the old view?', returnedViaRail)
    check('A5b returning through the rail also shows a fresh page on the grid',
      returnedViaRail.gridInDom === true && returnedViaRail.viewInDom === false
      && returnedViaRail.pageToken === 'NO-TOKEN (fresh element)',
      `viewInDom=${String(returnedViaRail.viewInDom)} pageToken=${JSON.stringify(returnedViaRail.pageToken)}`)

    // ------------------------------- B-series: session-mode entry, real kernel
    // The card's OTHER door. A session-bound domain does not show a view inside
    // this container: it turns a directory into a workspace and opens it, which
    // returns the frame to the Conversation and unmounts this page. Everything
    // below is read out of the DOM and the panel store, not out of the plugin.
    const beforeSeam = await win.webContents.executeJavaScript(SEAM_SNAP)
    section('B0 — panel store + seats before any entry attempt', beforeSeam)
    check('B0 the workbench page is mounted and selected before the entry attempt',
      beforeSeam.activePanelId === WORKBENCH_PANEL_ID && beforeSeam.cardIds.includes('probe'),
      `activePanelId=${String(beforeSeam.activePanelId)} cardIds=${JSON.stringify(beforeSeam.cardIds)}`)

    section('B0 — the directory the card will send', await win.webContents.executeJavaScript(SET_ENTRY_PATH))
    const entryElements = await win.webContents.executeJavaScript(CARD_ENTRY_ELEMENTS)
    section('W8 — the card\'s entry points, as elements', entryElements)
    for (const element of entryElements) {
      check(`W8 ${element.selector} is a real <button>`,
        element.found === true && element.tagName === 'BUTTON' && element.type === 'button',
        `found=${String(element.found)} tag=${String(element.tagName)} type=${String(element.type)}`)
      check(`W8 ${element.selector} is focusable (tabIndex !== -1)`,
        element.found === true && element.tabIndex !== -1,
        `tabIndex=${String(element.tabIndex)}`)
    }

    // --- B1: the empty path. The container refuses it and the card renders the
    // container's own sentence for the token it got back. ---
    section('B1 — click the empty-path entry', await win.webContents.executeJavaScript(CLICK_ENTER_EMPTY))
    const emptyCase = await waitUntil('the card to render the container\'s sentence for the token', 20_000, CARD_ENTRY_SNAP,
      (snap) => typeof snap.tokenText === 'string' && snap.tokenText.endsWith('error:invalid-argument'))
    section('B1 — the card after the empty-path attempt', emptyCase)
    check('B1 the token came back as error:invalid-argument',
      typeof emptyCase.tokenText === 'string' && emptyCase.tokenText.endsWith('error:invalid-argument'),
      JSON.stringify(emptyCase.tokenText))
    check(`B1 the card renders "${ENTRY_ERROR_TEXT}" verbatim`,
      emptyCase.messageText === ENTRY_ERROR_TEXT,
      JSON.stringify(emptyCase.messageText))
    check('B1 the failed entry did not navigate (page still mounted, panel unchanged)',
      emptyCase.workbenchPageInDom === true && emptyCase.activePanelId === beforeSeam.activePanelId,
      `pageInDom=${String(emptyCase.workbenchPageInDom)} activePanelId=${String(emptyCase.activePanelId)}`)

    // --- W8: the container's own back control is reachable from the keyboard. ---
    section('W8 — open the domain view', await win.webContents.executeJavaScript(CLICK_CARD_OPEN))
    await waitUntil('the view to be open for the focus check', 20_000, CENTRE_SNAP, (centre) => centre.viewInDom === true)
    // Nothing inside the container can take focus while the kernel's welcome
    // dialog is up — it puts the page behind it `inert` — so its dismissal is
    // asserted rather than assumed. The wait costs nothing in the normal case:
    // the dismisser armed at load clicks it the moment it mounts.
    const welcome = await waitUntil('the kernel\'s welcome dialog to be out of the way', 20_000, WELCOME_SNAP,
      (snap) => snap.armed === true && snap.dialogUp === false)
    section('W8 — welcome-dialog state before the focus check', welcome)
    check('W8 the kernel\'s first-run welcome dialog is out of the way (it makes the page inert)',
      welcome.armed === true && welcome.dialogUp === false,
      JSON.stringify(welcome))
    /**
     * Focus the back control, re-attempting until it holds.
     *
     * Opening a view also moves focus to the container's own page element
     * (`plugins/plugin-workbench/src/client/page.tsx`: `useEffect(() =>
     * viewRef.current?.focus(), [viewId])`), so a single `focus()` call can lose
     * that race. Re-attempting is what proves the control ACCEPTS focus; the last
     * observation, with the identity of whoever holds it instead, is what gets
     * reported.
     */
    const focusBackControl = async (timeoutMs) => {
      const until = Date.now() + timeoutMs
      for (;;) {
        const observed = await win.webContents.executeJavaScript(BACK_FOCUS_SNAP)
        if (observed.backInDom !== true || observed.focusLandedOnBack === true || Date.now() > until) return observed
        await sleep(250)
      }
    }
    const backFocus = await focusBackControl(10_000)
    section('W8 — 返回工作台, focused programmatically', backFocus)
    check('W8 返回工作台 is a real <button>',
      backFocus.backInDom === true && backFocus.backTag === 'BUTTON' && backFocus.backType === 'button',
      `tag=${String(backFocus.backTag)} type=${String(backFocus.backType)}`)
    check('W8 返回工作台 is focusable (tabIndex !== -1) and takes programmatic focus',
      backFocus.focusLandedOnBack === true && backFocus.backTabIndex !== -1 && backFocus.activeTabIndex !== -1,
      `backTabIndex=${String(backFocus.backTabIndex)} focusLandedOnBack=${String(backFocus.focusLandedOnBack)} activeTag=${String(backFocus.activeTag)}`)

    section('W8 — Escape while the domain view is open', await win.webContents.executeJavaScript(ESCAPE_VIEW))
    const afterEscape = await waitUntil('Escape to return to the grid', 20_000, CENTRE_SNAP,
      (centre) => centre.pageInDom === true && centre.viewInDom === false)
    section('W8 — centre column after Escape', afterEscape)
    check('W8 Escape returns to the grid, the same door the back button is',
      afterEscape.pageInDom === true && afterEscape.viewInDom === false,
      `pageInDom=${String(afterEscape.pageInDom)} viewInDom=${String(afterEscape.viewInDom)}`)

    // --- B2: the success path. A real directory becomes a workspace, and the
    // frame returns to the Conversation. Three facts together are the claim, and
    // they do NOT arrive together: the sidebar row appears while the row is being
    // created, the frame follows when the container opens it. Each is waited on
    // for what it asserts rather than assumed from the other.
    section('B2 — click the workspace entry', await win.webContents.executeJavaScript(CLICK_ENTER_WORKSPACE))
    const entered = await waitUntil('the workspace row to appear in the sidebar', 90_000, WORKSPACE_ROWS_SNAP,
      (snap) => snap.matchingRowKeys.length > 0)
    section('B2 — sidebar workspace rows after the entry', entered)
    const enteredFrame = await waitUntil('the frame to leave the workbench container', 90_000, MIDDLE_COLUMN_SNAP,
      (snap) => snap.workbenchPageInDom === false && snap.activePanelId === null)
    section('B2 — the middle column after the entry', enteredFrame)
    const enteredSeam = await win.webContents.executeJavaScript(SEAM_SNAP)
    section('B2 — panel store + seats after the entry', enteredSeam)

    check('B2a the sidebar shows a workspace row labelled with the directory',
      entered.matchingRowKeys.length > 0 && entered.matchingRowTexts.some((text) => text.includes(WORKDIR_NAME)),
      `matchingRowKeys=${JSON.stringify(entered.matchingRowKeys)} workspaceRows=${JSON.stringify(entered.workspaceRows)}`)
    check('B2b the middle column is no longer the workbench container page',
      enteredFrame.workbenchPageInDom === false && enteredFrame.workbenchPageSelectorCount === 0,
      `pageInDom=${String(enteredFrame.workbenchPageInDom)} count=${String(enteredFrame.workbenchPageSelectorCount)}`)
    check('B2c the frame returned to the Conversation (activePanelId === null)',
      enteredSeam.activePanelId === null,
      `activePanelId=${JSON.stringify(enteredSeam.activePanelId)}`)

    // --- B3: nothing was thrown into the page while all of that ran. ---
    const errorsAfterEntry = await win.webContents.executeJavaScript(READ_ERRORS)
    section('B3 — error + unhandledrejection over this load', errorsAfterEntry)
    check('B3 the error collector was installed on this load', errorsAfterEntry.collectorMissing === false)
    check('B3 no error / unhandledrejection was raised',
      errorsAfterEntry.collectorMissing === false && errorsAfterEntry.count === 0,
      JSON.stringify(errorsAfterEntry.errors))

    // ------------------------------------------------- A2, empty-state control
    section('A2-empty — arm the empty-state control', await win.webContents.executeJavaScript(SET_NO_CARD))
    await loadAndSettle('empty-state reload')
    const emptySeats = await win.webContents.executeJavaScript(SEAM_SNAP)
    section('A2-empty — seats after the reload (no card this load)', emptySeats)
    check('A2-empty the control suppressed the card and kept the view registration',
      emptySeats.globalMissing === false && emptySeats.skipCard === true
      && emptySeats.cardIds.includes('probe') === false && emptySeats.viewIds.includes('probe') === true,
      JSON.stringify(emptySeats))

    section('A2-empty — click the 工作台 row', await win.webContents.executeJavaScript(CLICK_WORKBENCH_ROW))
    const emptyPage = await waitUntil('the dictionary\'s empty sentence to render', 30_000, CENTRE_SNAP,
      (centre) => centre.emptyInDom === true)
    section('A2-empty — centre column with NOTHING registered into workbench.item', emptyPage)
    check('A2-empty the container renders the dictionary\'s empty sentence VERBATIM',
      emptyPage.emptyInDom === true && emptyPage.emptyTextMatches === true,
      JSON.stringify(emptyPage.emptyText))
    check('A2-empty no card is present in the grid this load',
      emptyPage.cardInDom === false && emptyPage.gridContainsCard === false,
      `cardInDom=${String(emptyPage.cardInDom)} gridContainsCard=${String(emptyPage.gridContainsCard)}`)

    section('A2-empty — disarm the control', await win.webContents.executeJavaScript(CLEAR_NO_CARD))

    const errorsLastLoad = await win.webContents.executeJavaScript(READ_ERRORS)
    section('B3 — error + unhandledrejection over the empty-state load', errorsLastLoad)
    check('B3 no error / unhandledrejection over the empty-state load either',
      errorsLastLoad.collectorMissing === false && errorsLastLoad.count === 0,
      JSON.stringify(errorsLastLoad.errors))

    // ---------------------------------------------------------------- A6 log
    const log = readKernelLog()
    section('A6 — kernel log', log.all.length === 0 ? '(empty)' : log.all.join('\n'))
    check('A6 the kernel log carries no failure signal and no rejected row',
      log.all.length > 0 && log.suspicious.length === 0,
      log.suspicious.length === 0 ? `${String(log.all.length)} non-empty line(s)` : JSON.stringify(log.suspicious))
    // A component that throws while rendering is caught by the outlet's own error
    // boundary and reported to the CONSOLE, never to the kernel log — so the
    // check above cannot see it. This one can: it is the renderer half of "the
    // plugin works", and the kernel-line runbook counts a non-zero
    // `slot entry crashed` as a broken plugin.
    const crashed = consoleErrors.filter((message) => /slot entry crashed|slot factory occurrence crashed/u.test(message))
    check('A6 no slot entry crashed while rendering',
      crashed.length === 0,
      crashed.length === 0
        ? `${String(consoleErrors.length)} console error(s), none of them a crashed entry`
        : crashed.join(' | ').slice(0, 300))
    section('A6 — console errors over the whole run', consoleErrors)
  } finally {
    try { child.kill() } catch { /* already gone */ }
    await sleep(500)
  }
}

async function main() {
  let fatal = null
  try {
    await run()
  } catch (error) {
    fatal = error
    console.error('')
    console.error(fatal.stack || fatal.message || String(fatal))
  }
  console.log('')
  if (fatal !== null) {
    console.log(`RESULT: FAIL (crashed before the last assertion: ${fatal.message})`)
  } else if (passed === 0) {
    // A run that asserted nothing is not a clean run. The exit code keys on
    // failures, so without this branch an empty run would print PASS and exit 0 —
    // the same silent-pass shape a crashed `finally` used to produce here.
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
