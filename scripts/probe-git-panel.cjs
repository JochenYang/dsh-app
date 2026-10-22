#!/usr/bin/env node
/**
 * Runtime probe for the Git panel (`plugins/plugin-sidebar`).
 *
 * Why this cannot be a static check. The plugin suite pins the two pure
 * functions (`buildPathTree`, `diffRulerMarks`) and `npm run check:slots` proves
 * the view registers — neither drives a browser. What none of them can see is
 * what the user actually gets, and all three facts below are properties of a
 * RENDERED DOM:
 *
 *   - whether a deep path renders as a HIERARCHY (nested headers, one row per
 *     real directory) or as one flat group with a long label per row;
 *   - how many scrollbars the right pane shows for a tall diff — the bug was
 *     two, one from the pane and one from the `<pre>` inside it;
 *   - whether the change ruler exists, where its marks sit, and whether
 *     clicking one actually moves the diff.
 *
 * Shape: unpacks a REAL runtime artifact, boots the REAL kernel child with the
 * SHIPPED overlay (`plugins/dsh-app.patch.yml`), links `plugin-sidebar` from the
 * WORKING TREE so the code under test is the code in the tree, seeds one
 * workspace pointing at a git repository the probe builds itself, and drives
 * the Git tab in an Electron window.
 *
 * The repository it builds is the fixture that makes the three facts
 * observable, and its shape is deliberate:
 *
 *   - a DEEP, SINGLE-CHILD path (`apps/api/src/modules/agent/tools/…`) so the
 *     compaction rule has something to compact and the nesting rule has
 *     something to nest;
 *   - a SIBLING directory and a file at the same level, so compaction stops
 *     where it must;
 *   - one file whose diff is far taller than the pane, so the scroll question
 *     is decidable at all (a short diff shows one scrollbar no matter how many
 *     elements could scroll).
 *
 * What it asserts, each from a raw observation printed above the verdict:
 *
 *   A0    the client bundle was SERVED — the fact behind every DOM assertion
 *   A1    the Git tab opens and lists the fixture's changes
 *   A2    the tree is REAL: the deep path renders as nested headers whose names
 *         are directory segments, no file row's label still carries a `/`, and
 *         a header exists for the level that holds a sibling
 *   A3    compaction is what the header text shows: the single-child chain is
 *         ONE header (`apps/api/src/modules/agent`), not five rows
 *   A4    the right pane has exactly ONE vertical scroller for a tall diff
 *   A5    the ruler renders marks, their kinds match the diff's own +/− lines,
 *         and a click moves the scroll position
 *   A6    a clean run: no console error, no crashed slot entry, no failure line
 *
 * Usage:
 *   node_modules/.bin/electron scripts/probe-git-panel.cjs [--tgz <runtime.tgz> | --kernel <dir>]
 *
 * Run `npm run build` first (it `require`s the shell's own `dist/main/` modules
 * in the sibling probes; this one keeps to the kernel and the plugin), and build
 * the plugin under test: it refuses a missing or stale `lib/`.
 *
 * @module dsh-app/scripts/probe-git-panel
 */

const { app, BrowserWindow, session } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

app.commandLine.appendSwitch('lang', 'zh-CN')

const root = path.resolve(__dirname, '..')
const here = path.join(root, 'scratch', 'probe-git-panel')
const rtRoot = path.join(here, 'rt')
const runtimeDir = path.join(rtRoot, 'runtime')
const dshHome = path.join(here, 'home')
const logDir = path.join(here, 'logs')
const overlay = path.join(here, 'overlay.patch.yml')
const kernelLog = path.join(logDir, 'kernel.log')
const marker = path.join(rtRoot, 'extracted-from.txt')
/** The fixture repository the Git tab is pointed at. */
const repoDir = path.join(here, 'repo')

/** The plugin under test, as the shipped overlay names it. */
const SIDEBAR_DIRNAME = 'plugin-sidebar'
const SIDEBAR_PACKAGE = '@dsh-app/plugin-sidebar'
const SIDEBAR_BUILD = 'node plugins/plugin-sidebar/build.mjs'

/** The single seeded workspace's id. */
const WORKSPACE_ID = 'probe-git-ws'
/** Its directory name, which is also the title the sidebar row shows. */
const WORKDIR_NAME = 'repo'

/**
 * The fixture's deep path. `apps/api/src/modules/agent` is a single-child chain
 * below `apps/`, so it must render as ONE header; `tools/` is the level that
 * holds the file, and `service.ts` sits beside it.
 */
const DEEP_DIR = 'apps/api/src/modules/agent'
const DEEP_FILES = [
  `${DEEP_DIR}/tools/detail.tool.ts`,
  `${DEEP_DIR}/tools/chef-loop.ts`,
  `${DEEP_DIR}/service.ts`,
  `${DEEP_DIR}/llm-client.ts`,
]
/** A second top-level directory, so the tree has more than one root. */
const OTHER_FILE = 'docs/guide.md'
/** A root-level file, which must render with no header above it. */
const ROOT_FILE = 'README.md'
const ALL_FILES = [...DEEP_FILES, OTHER_FILE, ROOT_FILE]

/**
 * Lines of padding the tall file carries, so its diff holds MANY hunks.
 *
 * A single edit yields a 13-line diff (git emits three context lines either
 * side), which is far shorter than the pane and makes the scroll question
 * undecidable — measured: `bodyScrollHeight === bodyClientHeight === 508`. The
 * file therefore changes every {@link TALL_STRIDE}th line, so git emits one hunk
 * per edit and the diff grows past any pane height.
 */
const TALL_LINES = 400
const TALL_STRIDE = 12
const TALL_FILE = `${DEEP_DIR}/tools/chef-prompt.ts`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms) }),
])
const relative = (absolute) => path.relative(root, absolute).split(path.sep).join('/')

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
 * An extraction is keyed by its SOURCE, so a tree unpacked from a different
 * artifact is discarded rather than reused.
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
      throw new Error(`tar failed with status ${String(result.status)} (paths are converted to forward slashes for Git Bash's MSYS tar)`)
    }
    writeFileSync(marker, `${source}\n`)
  }
  assertRuntimeTree(runtimeDir, path.basename(tarball))
  return { dir: runtimeDir, source }
}

/**
 * Refuse to test a build that is missing or older than its own sources: the
 * repository's own freshness rule (the fourth gate in `plugins/AGENTS.md` §3),
 * reused so the probe refuses exactly where a pack refuses.
 */
async function assertProbeInputs() {
  const { pluginLibStaleness } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'plugin-gates.mjs')).href)
  const dir = path.join(root, 'plugins', SIDEBAR_DIRNAME)
  if (!existsSync(path.join(dir, 'lib', 'client.js'))) {
    throw new Error(`the plugin under test is not built (${relative(dir)}/lib/client.js) — run: ${SIDEBAR_BUILD}`)
  }
  const { stale, newestInput, libMtime } = pluginLibStaleness(dir)
  if (stale) {
    throw new Error(`the plugin under test has a lib/ older than its own sources: newest input ${newestInput.path}`
      + ` (${new Date(newestInput.mtimeMs).toISOString()}) is newer than the newest lib/ entry ${libMtime.path}`
      + ` (${new Date(libMtime.mtimeMs).toISOString()}) — rebuild: ${SIDEBAR_BUILD}`)
  }
}

/** Run one git command in the fixture repository; throws git's own stderr. */
function git(args) {
  const result = spawnSync('git', args, {
    cwd: repoDir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? process.env.USERPROFILE },
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}${result.stdout ?? ''}`)
  }
  return result.stdout ?? ''
}

/**
 * Build the fixture repository: one commit of the base tree, then a worktree
 * edit per file so every entry the panel lists is a real, uncommitted change.
 *
 * The tall file changes every {@link TALL_STRIDE}th line, which makes git emit
 * one hunk per edit and a diff far taller than any pane — the condition the
 * scroll assertions need.
 */
function prepareRepo() {
  mkdirSync(repoDir, { recursive: true })
  const write = (relPath, text) => {
    const full = path.join(repoDir, ...relPath.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  const tallBody = (marker) => Array.from({ length: TALL_LINES }, (_, index) => (
    index % TALL_STRIDE === 0 ? `const line${String(index)} = '${marker}'` : `// padding ${String(index)}`
  )).join('\n') + '\n'

  for (const relPath of ALL_FILES) write(relPath, `// ${relPath}\nexport const marker = 'base'\n`)
  write(TALL_FILE, tallBody('base'))

  git(['init', '--initial-branch=main'])
  git(['config', 'user.email', 'probe@example.invalid'])
  git(['config', 'user.name', 'probe'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['add', '-A'])
  git(['commit', '-m', 'probe baseline'])

  // Every listed file changes, so the panel has entries to draw.
  for (const relPath of ALL_FILES) write(relPath, `// ${relPath}\nexport const marker = 'edited'\n`)
  write(TALL_FILE, tallBody('edited'))
  return { files: ALL_FILES, tallFile: TALL_FILE }
}

/**
 * Lay out the scratch home: the profile manifest, the suite links taken from the
 * extracted RUNTIME, and `plugin-sidebar` taken from the WORKING TREE into BOTH
 * `@dsh-app` scopes. The shared link alone leaves the UI silently vanilla
 * (`plugins/AGENTS.md` §6), so both scopes are asserted.
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

  // One workspace pointing at the fixture repository. This is what gives the
  // page a session, which is what the Git tab needs for its `cwd` — the view
  // resolves `cwd` from the session LIST row, so no session means no repository
  // and the tab renders its "open a session" hint instead of a list.
  const storages = path.join(dshHome, 'storages')
  mkdirSync(storages, { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(path.join(storages, 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [WORKSPACE_ID],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: WORKSPACE_ID,
    },
    tables: {
      workspaces: {
        [WORKSPACE_ID]: {
          path: repoDir,
          title: WORKDIR_NAME,
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  }, undefined, 2)}\n`)

  const suiteSource = path.join(runtimeDir, 'app', 'node_modules', '@dsh-app')
  if (!existsSync(suiteSource)) throw new Error(`the runtime tree carries no @dsh-app scope: ${suiteSource}`)
  const shipped = readdirSync(suiteSource)
  const sources = shipped
    .filter((name) => name !== SIDEBAR_DIRNAME)
    .map((name) => [name, path.join(suiteSource, name)])
  sources.push([SIDEBAR_DIRNAME, path.join(root, 'plugins', SIDEBAR_DIRNAME)])

  const scopes = [
    path.join(profileDir, 'node_modules', '@dsh-app'),
    path.join(dshHome, 'profiles', 'node_modules', '@dsh-app'),
  ]
  for (const scope of scopes) {
    mkdirSync(scope, { recursive: true })
    for (const [name, target] of sources) symlinkSync(target, path.join(scope, name), 'junction')
  }
  for (const scope of scopes) {
    const linked = path.join(scope, SIDEBAR_DIRNAME, 'package.json')
    if (!existsSync(linked)) throw new Error(`suite link missing: ${path.relative(root, linked)}`)
  }

  // The SHIPPED overlay, verbatim: the probe adds no plugin row of its own.
  const base = readFileSync(path.join(root, 'plugins', 'dsh-app.patch.yml'), 'utf8')
  if (!base.includes(`'${SIDEBAR_PACKAGE}'`)) {
    throw new Error(`plugins/dsh-app.patch.yml carries no row for ${SIDEBAR_PACKAGE} — the probe would test nothing`)
  }
  writeFileSync(overlay, base)
  return { linked: sources.length, overridden: shipped.includes(SIDEBAR_DIRNAME) }
}

/**
 * Arm a dismisser for the kernel's first-run welcome dialog, which sets the page
 * `inert` — and an inert page silently swallows `focus()` and `insertText`, so
 * nothing else in this probe can work until it is gone.
 *
 * Re-armed after every reload, because the dialog's own "seen" flag is written
 * per profile and the reload below re-runs the boot sequence.
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
    if (window.__probeDismissWelcome() !== null) observer.disconnect()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  if (window.__probeDismissWelcome() !== null) observer.disconnect()
  return 'armed'
})()`

/** Whether the first-run dialog is still up (dismissing it on the way through). */
const WELCOME_CLEAR = `(function () {
  if (typeof window.__probeDismissWelcome === 'function') window.__probeDismissWelcome()
  var headings = Array.prototype.slice.call(document.querySelectorAll('h1, h2, h3'))
  var heading = headings.filter(function (h) { return (h.textContent || '').trim() === '预览版说明' })[0]
  return {
    dialogUp: heading !== undefined,
    inertCount: document.querySelectorAll('[inert]').length,
    dismissals: window.__probeWelcomeDismissals === undefined ? [] : window.__probeWelcomeDismissals.slice()
  }
})()`

/**
 * The composer's editable surface — the same accessibility contract the kernel
 * documents (`contenteditable` + `role="textbox"` inside the composer card).
 */
const COMPOSER_SELECTOR = 'div[data-composer-card] div[contenteditable="true"][role="textbox"]'

const COMPOSER_SNAP = `(function () {
  var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
  if (el === null) return { found: false }
  return { found: true, editable: el.getAttribute('contenteditable'), text: (el.innerText || '').trim() }
})()`

/** Focus the composer, which is what makes `insertText` land in the editor. */
const FOCUS_COMPOSER = `(function () {
  var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
  if (el === null) return 'no composer'
  el.focus()
  return document.activeElement === el ? 'focused' : 'not focused'
})()`

/**
 * Submit one turn, which is what makes the conversation non-blank.
 *
 * This is not optional stagecraft: `DefaultConversationViews` returns NULL while
 * the session is blank (`session.blank && conversationPhase(session, conversation)
 * === 'blank'`), so the view ring — and therefore the Git view — renders nothing
 * until a turn has been attempted. The reply itself is irrelevant to every
 * assertion below: `conversationPhase` turns 'engaging' as soon as the prompt is
 * attempted, before any model output exists, so the probe does not wait on the
 * network and never reads a reply.
 */
const SUBMIT_TURN = `(function () {
  var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
  if (el === null) return { submitted: false, reason: 'no composer' }
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
  return { submitted: true }
})()`

const BOOT_HEALTH = `(function () {
  var text = document.body.innerText
  return {
    failedToLoadPlugins: /Failed to load plugins|插件加载失败/.test(text),
    entriesDidNotActivate: /did not activate|未能激活/.test(text),
    rootChildren: document.getElementById('root') === null ? 0 : document.getElementById('root').children.length,
    composerInDom: document.querySelector('div[data-composer-card]') !== null,
    bodyHead: text.replace(/\\s+/g, ' ').slice(0, 160)
  }
})()`

/**
 * Enter the seeded workspace, which is what gives the page a SESSION.
 *
 * The Git view resolves `cwd` from the session LIST row, and the tab row only
 * exists inside a session — on the workspace-picker page there is no Git tab at
 * all (measured: the tab labels were the sidebar's own rows). The row is
 * located by the session tree's `data-row-key` (`workspace:<id>`, measured on
 * this kernel line) and matched by the TEXT a user reads, the workspace title.
 */
const OPEN_WORKSPACE = `(function () {
  var name = ${JSON.stringify(WORKDIR_NAME)}
  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-key]'))
  var workspaceRows = rows.filter(function (r) {
    return String(r.getAttribute('data-row-key')).indexOf('workspace:') === 0
  })
  var matching = workspaceRows.filter(function (r) { return (r.innerText || '').indexOf(name) >= 0 })
  if (matching.length === 0) {
    return { clicked: false, workspaceRows: workspaceRows.map(function (r) { return (r.innerText || '').replace(/\\s+/g, ' ').trim() }) }
  }
  matching[0].click()
  return { clicked: true, rowKey: matching[0].getAttribute('data-row-key') }
})()`

/**
 * Whether a SESSION is really open.
 *
 * `div[data-composer-card]` is not enough: the workspace-picker hero renders the
 * same card (measured — the card was in the DOM while the page still read
 * 选择工作区), so the honest signal is the card's EDITABLE surface, which only a
 * session has.
 */
const SESSION_SNAP = `(function () {
  var editor = document.querySelector('div[data-composer-card] div[contenteditable="true"][role="textbox"]')
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
  return {
    editable: editor !== null && editor.getAttribute('contenteditable') === 'true',
    hasComposerCard: document.querySelector('div[data-composer-card]') !== null,
    picker: /选择工作区|Select a workspace/.test(document.body.innerText),
    tabs: buttons.map(function (n) { return (n.innerText || '').trim() }).filter(function (t) { return t !== '' && t.length < 12 }).slice(0, 20),
    bodyHead: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160)
  }
})()`

/** Start a new session from the picker, which is what the 新会话 control does. */
const NEW_SESSION = `(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
  var target = buttons.filter(function (n) {
    var text = (n.innerText || '').replace(/\\s+/g, ' ').trim()
    return text.indexOf('新会话') === 0 || text.indexOf('New session') === 0
  })[0]
  if (target === undefined) return { clicked: false, buttons: buttons.map(function (n) { return (n.innerText || '').replace(/\\s+/g, ' ').trim() }).filter(function (t) { return t !== '' }).slice(0, 20) }
  target.click()
  return { clicked: true }
})()`

/**
 * Open the Git view.
 *
 * The view-tab STRIP is not a usable door on this kernel line: it renders only
 * when `conversation.view` holds more than one registration (`showTabs = tabs
 * .length > 1`, measured in `ui-conversation`'s ConversationSessionHeader), and
 * on this line the suite's own `git` is the only registrant — upstream's
 * 对话/轨迹 rows are not registered, so the strip never appears and there is no
 * button to click.
 *
 * What DOES decide the rendered view is the per-session conversation store's
 * `view` field, persisted at `localStorage['dsh.conversation.<sessionId>']`.
 * Writing that preference and reloading opens the Git view directly — the same
 * path the kernel's own `restoreView` takes on session resume, so the probe
 * exercises the real mechanism rather than a private hook.
 */
function openGitView(sessionId) {
  return `(function () {
    var key = 'dsh.conversation.' + ${JSON.stringify(sessionId)}
    var raw = localStorage.getItem(key)
    var stored = raw === null ? {} : JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null) stored = {}
    stored.view = 'git'
    localStorage.setItem(key, JSON.stringify(stored))
    return { key: key, written: stored.view }
  })()`
}

/**
 * The current session id, as the store keys its per-session state.
 *
 * Read from the session tree's own row keys (`session:<id>`, measured on this
 * kernel line) — the same source the sidebar uses — rather than from a private
 * store handle. A freshly created session is the one the row list marks active.
 */
const SESSION_ID = `(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-key]'))
  var sessions = rows.filter(function (r) {
    return String(r.getAttribute('data-row-key')).indexOf('session:') === 0
  })
  var active = sessions.filter(function (r) {
    return r.getAttribute('aria-current') !== null || r.getAttribute('data-active') !== null
      || String(r.className || '').toLowerCase().indexOf('active') >= 0
  })
  var chosen = active.length > 0 ? active[0] : sessions[0]
  return {
    sessionId: chosen === undefined ? null : String(chosen.getAttribute('data-row-key')).slice('session:'.length),
    sessionRows: sessions.map(function (r) { return r.getAttribute('data-row-key') })
  }
})()`
const PANEL_SNAP = `(function () {
  var panel = document.querySelector('.dshAsbGit')
  if (panel === null) return { mounted: false }
  var text = panel.innerText || ''
  return {
    mounted: true,
    dirRows: panel.querySelectorAll('.dshAsbGit-dirRow').length,
    fileRows: panel.querySelectorAll('.dshAsbGit-fileRow').length,
    rows: panel.querySelectorAll('.dshAsbGit-row').length,
    clean: /工作区干净/.test(text),
    noSession: /打开一个会话/.test(text),
    notARepo: /不是 Git 仓库/.test(text),
    loading: /正在读取/.test(text)
  }
})()`

/**
 * The whole tree, read as the user sees it: every header's text and indentation,
 * and every file row's label with its own indent. Labels are the fact under
 * test — a nested tree labels a row with its file name alone.
 */
const TREE_SNAP = `(function () {
  var panel = document.querySelector('.dshAsbGit')
  if (panel === null) return { mounted: false, dirs: [], files: [] }
  var dirs = Array.prototype.map.call(panel.querySelectorAll('.dshAsbGit-dirRow'), function (node) {
    var name = node.querySelector('.dshAsbGit-dirName')
    var count = node.querySelector('.dshAsbGit-dirCount')
    return {
      name: name === null ? '' : (name.innerText || '').trim(),
      count: count === null ? '' : (count.innerText || '').trim(),
      indent: parseInt(node.style.paddingLeft || '0', 10) || 0,
      expanded: node.getAttribute('aria-expanded') === 'true'
    }
  })
  var files = Array.prototype.map.call(panel.querySelectorAll('.dshAsbGit-fileRow'), function (node) {
    var path = node.querySelector('.dshAsbGit-path')
    var letter = node.querySelector('.dshAsbGit-letter')
    return {
      label: path === null ? '' : (path.innerText || '').trim(),
      letter: letter === null ? '' : (letter.innerText || '').trim(),
      indent: parseInt(node.style.marginLeft || '0', 10) || 0
    }
  })
  // Root-level files are NOT wrapped in a fileRow element (there is no
  // directory to indent from), so they are read from the rows that are not
  // inside one. Without this the probe would report "no root files" for a
  // correct tree.
  var nested = Array.prototype.slice.call(panel.querySelectorAll('.dshAsbGit-fileRow .dshAsbGit-row'))
  var loose = Array.prototype.slice.call(panel.querySelectorAll('.dshAsbGit-list > .dshAsbGit-row'))
  var looseFiles = loose.filter(function (node) { return nested.indexOf(node) === -1 }).map(function (node) {
    var path = node.querySelector('.dshAsbGit-path')
    var letter = node.querySelector('.dshAsbGit-letter')
    return {
      label: path === null ? '' : (path.innerText || '').trim(),
      letter: letter === null ? '' : (letter.innerText || '').trim(),
      indent: 0,
      root: true
    }
  })
  return { mounted: true, dirs: dirs, files: files, rootFiles: looseFiles }
})()`

/** Click one file row by its label, so its diff opens in the right pane. */
function clickFile(label) {
  return `(function () {
    var panel = document.querySelector('.dshAsbGit')
    if (panel === null) return { clicked: false, reason: 'no panel' }
    var rows = Array.prototype.slice.call(panel.querySelectorAll('.dshAsbGit-fileRow .dshAsbGit-rowPath'))
    var target = rows.filter(function (node) { return (node.innerText || '').trim().indexOf(${JSON.stringify(label)}) >= 0 })[0]
    if (target === undefined) return { clicked: false, reason: 'no row', labels: rows.map(function (n) { return (n.innerText || '').trim() }) }
    target.click()
    return { clicked: true }
  })()`
}

/**
 * The scroll question, measured on the elements that can actually scroll.
 *
 * A scroller is counted when it OVERFLOWS VERTICALLY — `scrollHeight` above
 * `clientHeight` and a computed `overflow-y` that admits scrolling. Counting
 * elements with `overflow: auto` alone would report a scroller that never
 * appears; counting only the pane's own would miss the bug, which was a second
 * scroller INSIDE it.
 */
const SCROLL_SNAP = `(function () {
  var detail = document.querySelector('.dshAsbGit-detail')
  if (detail === null) return { mounted: false }
  var scrollable = []
  var walk = function (node) {
    var style = getComputedStyle(node)
    var admits = style.overflowY === 'auto' || style.overflowY === 'scroll'
    var overflows = node.scrollHeight > node.clientHeight + 1
    if (admits && overflows) {
      scrollable.push({
        cls: String(node.className || ''),
        tag: node.tagName.toLowerCase(),
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight
      })
    }
    for (var i = 0; i < node.children.length; i += 1) walk(node.children[i])
  }
  walk(detail)
  var body = document.querySelector('.dshAsbGit-diffBody')
  var pre = document.querySelector('.dshAsbGit-diff')
  return {
    mounted: true,
    scrollable: scrollable,
    detailOverflowY: getComputedStyle(detail).overflowY,
    bodyPresent: body !== null,
    bodyScrollTop: body === null ? null : body.scrollTop,
    bodyScrollHeight: body === null ? null : body.scrollHeight,
    bodyClientHeight: body === null ? null : body.clientHeight,
    preOverflowY: pre === null ? null : getComputedStyle(pre).overflowY,
    preScrollHeight: pre === null ? null : pre.scrollHeight,
    preClientHeight: pre === null ? null : pre.clientHeight
  }
})()`

/** The ruler: its marks, where they sit, and what the diff says it changed. */
const RULER_SNAP = `(function () {
  var ruler = document.querySelector('.dshAsbGit-ruler')
  var pre = document.querySelector('.dshAsbGit-diff')
  if (pre === null) return { rulerPresent: ruler !== null, marks: [], diffLines: 0 }
  var rows = pre.querySelectorAll('div')
  var adds = 0
  var dels = 0
  for (var i = 0; i < rows.length; i += 1) {
    var cls = String(rows[i].className || '')
    if (cls.indexOf('dshAsbGit-diffAdd') >= 0) adds += 1
    if (cls.indexOf('dshAsbGit-diffDel') >= 0) dels += 1
  }
  var marks = []
  var rulerHeight = ruler === null ? 0 : ruler.getBoundingClientRect().height
  if (ruler !== null) {
    marks = Array.prototype.map.call(ruler.querySelectorAll('.dshAsbGit-rulerMark'), function (node) {
      var cls = String(node.className || '')
      var rect = node.getBoundingClientRect()
      return {
        kind: cls.indexOf('dshAsbGit-rulerMarkAdd') >= 0 ? 'add' : cls.indexOf('dshAsbGit-rulerMarkDel') >= 0 ? 'del' : 'unknown',
        top: node.style.top,
        height: node.style.height,
        // The PAINTED height, which is what the reader sees: a floor applied in
        // CSS shows up here and nowhere in the inline style.
        px: Math.round(rect.height * 100) / 100,
        pxTop: Math.round(rect.top * 100) / 100,
        label: node.getAttribute('aria-label')
      }
    })
  }
  return {
    rulerPresent: ruler !== null,
    rulerAria: ruler === null ? null : ruler.getAttribute('aria-label'),
    rulerHeight: Math.round(rulerHeight * 100) / 100,
    marks: marks,
    diffLines: rows.length,
    adds: adds,
    dels: dels
  }
})()`

/** Click the first ruler mark and report where the diff ended up. */
const CLICK_RULER_MARK = `(function () {
  var mark = document.querySelector('.dshAsbGit-rulerMark')
  var body = document.querySelector('.dshAsbGit-diffBody')
  if (mark === null || body === null) return { clicked: false }
  var before = body.scrollTop
  mark.click()
  return { clicked: true, before: before, after: body.scrollTop }
})()`

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

  if (existsSync(dshHome)) {
    const { removeTree } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'remove-tree.mjs')).href)
    await removeTree(dshHome)
  }
  if (existsSync(repoDir)) {
    const { removeTree } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'remove-tree.mjs')).href)
    await removeTree(repoDir)
  }
  const fixture = prepareRepo()
  const home = prepareHome()

  console.log(`app locale     : ${app.getLocale()}`)
  console.log(`runtime        : ${runtimeDirResolved} (${runtime.source})`)
  console.log(`DSH_HOME       : ${dshHome}`)
  console.log(`fixture repo   : ${repoDir} (${String(fixture.files.length + 1)} changed files)`)
  console.log(`linked         : ${String(home.linked)} packages into both @dsh-app scopes`)
  console.log(`plugin under test: ${path.join(root, 'plugins', SIDEBAR_DIRNAME, 'lib', 'client.js')}${home.overridden ? ' (working tree; the artifact copy was skipped)' : ''}`)
  console.log(`overlay        : ${overlay}`)

  const nodeBin = path.join(runtimeDirResolved, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const script = path.join(runtimeDirResolved, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  writeFileSync(kernelLog, '')
  const port = await freePort()
  console.log(`port           : ${String(port)}`)

  const logFd = openSync(kernelLog, 'a')
  const child = spawn(nodeBin, [script, '--profile', 'dsh-app', '--patch', overlay, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: runtimeDirResolved,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, DSH_HOME: dshHome, DSH_APP_PROFILE: 'dsh-app' },
    windowsHide: true,
  })

  try {
    const settled = await waitForSettledUrl(kernelLog, 240_000)
    console.log(`settled        : ${settled.replace(/\?.*$/u, '?token=<redacted>')}`)

    const moduleGets = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (details.url.includes(SIDEBAR_DIRNAME)) moduleGets.push(details.url.replace(/token=[^&]*/gu, 'token=<redacted>'))
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

    const evalIn = (expression, timeoutMs = 20_000) => withTimeout(
      win.webContents.executeJavaScript(expression),
      timeoutMs,
      `a page evaluation (${expression.replace(/\s+/gu, ' ').slice(0, 70)}…)`,
    )

    const waitUntil = async (label, timeoutMs, expression, holds) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const observed = await evalIn(expression, Math.min(timeoutMs, 20_000))
        if (holds(observed)) return observed
        if (Date.now() > deadline) {
          throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${label}; last observation: ${JSON.stringify(observed).slice(0, 800)}`)
        }
        await sleep(250)
      }
    }

    const step = (title) => {
      process.stdout.write(`\n>>> ${title}\n`)
    }

    await withTimeout(win.loadURL(settled), 60_000, 'the page load')
    await waitUntil('the app to mount', 60_000, BOOT_HEALTH, (health) => health.rootChildren > 0)

    step('SETUP — enter the seeded workspace so a session (and its Git tab) exists')
    // ------------------------------------------------------------- A1 setup
    // The workspace seeded in prepareHome is what opens a session; the Git view
    // resolves its repository from that session's list row, so without this the
    // tab does not exist at all. Selecting the row is not enough on this kernel
    // line — it lands on the workspace hero, and 新会话 is what opens a session
    // (the editable composer is the only honest proof of one).
    const armed = await evalIn(ARM_WELCOME_DISMISSER).catch((error) => `threw: ${error.message}`)
    console.log(`welcome        : ${String(armed)}`)
    const entered = await waitUntil('the workspace row to appear', 60_000, OPEN_WORKSPACE,
      (snap) => snap.clicked === true)
    section('SETUP — workspace row', entered)
    const started = await evalIn(NEW_SESSION).catch((error) => `threw: ${error.message}`)
    section('SETUP — new session click', started)
    const sessionReady = await waitUntil('the session to open', 90_000, SESSION_SNAP,
      (snap) => snap.editable === true)
    section('SETUP — session', sessionReady)
    check('SETUP the seeded workspace opened an editable session', sessionReady.editable === true,
      JSON.stringify(sessionReady))
    // The first-run dialog mounts a few seconds after boot and makes the page
    // behind it inert; its ABSENCE is what the typing below depends on.
    const welcomeCleared = await waitUntil('the first-run dialog to clear', 30_000, WELCOME_CLEAR,
      (snap) => snap.dialogUp === false)
    section('SETUP — first-run dialog', welcomeCleared)

    step('A0 — served client bundle')
    // ------------------------------------------------------------------ A0
    section('A0 — client module requests for the plugin under test', moduleGets)
    check('A0 the client bundle was served', moduleGets.length > 0, `${String(moduleGets.length)} request(s)`)

    const boot = await evalIn(BOOT_HEALTH)
    section('A6 — boot health', boot)
    check('A6 a clean boot: no unresolved entry, no failed plugin',
      boot.failedToLoadPlugins === false && boot.entriesDidNotActivate === false,
      JSON.stringify(boot))

    step('A1 — make the conversation non-blank, then open the Git view')
    // ------------------------------------------------------------------ A1
    // Three facts of this kernel line have to be satisfied before the Git view
    // can render, and none of them is about this plugin:
    //
    //   1. `DefaultConversationViews` returns NULL while the session is BLANK
    //      (`session.blank && conversationPhase(...) === 'blank'`), so the view
    //      ring — and the Git view inside it — does not exist until a turn has
    //      been attempted. That is why the probe submits one.
    //   2. The view-tab STRIP only renders with more than one `conversation.view`
    //      registration, and `git` is the only one on this line, so there is no
    //      tab button to click.
    //   3. What decides the rendered view instead is the per-session preference
    //      the kernel restores on every session BINDING (`restoreView` reads
    //      `localStorage['dsh.conversation.<sessionId>'].view`). Writing it and
    //      re-binding the session is therefore the real mechanism, not a private
    //      hook — and re-binding is a session switch, never a page reload, which
    //      would drop the app back to the workspace picker.
    const focused = await evalIn(FOCUS_COMPOSER)
    section('A1 — focus the composer', focused)
    check('A1 the composer took focus', focused === 'focused', JSON.stringify(focused))
    await withTimeout(win.webContents.insertText('probe: open the git view'), 15_000, 'typing the probe prompt')
    const typed = await evalIn(COMPOSER_SNAP)
    section('A1 — composer after typing', typed)
    check('A1 the prompt reached the editor', typed.found === true && typed.text.includes('git view'), JSON.stringify(typed))
    const submitted = await evalIn(SUBMIT_TURN)
    section('A1 — submit', submitted)
    check('A1 the turn was submitted', submitted.submitted === true, JSON.stringify(submitted))

    const sessionRow = await waitUntil('a session row to exist', 30_000, SESSION_ID,
      (snap) => snap.sessionId !== null)
    section('A1 — session id', sessionRow)
    const written = await evalIn(openGitView(sessionRow.sessionId))
    section('A1 — view preference written', written)

    // Re-bind the session so `restoreView` runs with the preference in place.
    //
    // Clicking the CURRENT session row does not re-bind it (measured: the click
    // lands and nothing changes — the store is already bound to that id). What
    // does force a fresh binding is SWITCHING sessions, because
    // `uiSession.provide`'s `resolve` calls `restoreView(binding.sessionId)`
    // every time a binding is created. The target session must therefore be
    // non-blank AND carry the preference before the switch happens.
    const secondSession = await evalIn(NEW_SESSION).catch((error) => `threw: ${error.message}`)
    section('A1 — second session', secondSession)
    const secondRow = await waitUntil('the second session row', 60_000, SESSION_ID,
      (snap) => snap.sessionId !== null && snap.sessionId !== sessionRow.sessionId)
    section('A1 — second session id', secondRow)
    // Non-blank first: a blank session renders no view at all.
    const focusedAgain = await evalIn(FOCUS_COMPOSER)
    section('A1 — focus the second composer', focusedAgain)
    await withTimeout(win.webContents.insertText('probe: second turn'), 15_000, 'typing the second prompt')
    const submittedAgain = await evalIn(SUBMIT_TURN)
    section('A1 — submit the second turn', submittedAgain)
    const writtenSecond = await evalIn(openGitView(secondRow.sessionId))
    section('A1 — preference written for the second session', writtenSecond)
    // Switch away to the FIRST session and back: the return creates a binding,
    // which runs `restoreView` and activates `git`.
    const switched = await evalIn(`(function () {
      var first = 'session:' + ${JSON.stringify(sessionRow.sessionId)}
      var second = 'session:' + ${JSON.stringify(secondRow.sessionId)}
      var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-key]'))
      var byKey = {}
      rows.forEach(function (r) { byKey[r.getAttribute('data-row-key')] = r })
      if (byKey[first] === undefined || byKey[second] === undefined) {
        return { ok: false, rowKeys: rows.map(function (r) { return r.getAttribute('data-row-key') }) }
      }
      byKey[first].click()
      return { ok: true, clickedFirst: first }
    })()`)
    section('A1 — switched to the first session', switched)
    await sleep(1_500)
    const backToSecond = await evalIn(`(function () {
      var second = 'session:' + ${JSON.stringify(secondRow.sessionId)}
      var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-key]'))
      var target = rows.filter(function (r) { return r.getAttribute('data-row-key') === second })[0]
      if (target === undefined) return { ok: false }
      target.click()
      return { ok: true, clickedSecond: second }
    })()`)
    section('A1 — switched back to the second session', backToSecond)

    const listed = await waitUntil('the Git panel to list the fixture changes', 90_000, PANEL_SNAP,
      (snap) => snap.mounted === true && snap.rows > 0)
    section('A1 — panel', listed)
    check('A1 the Git view opened and drew rows', listed.mounted === true && listed.rows > 0, JSON.stringify(listed))
    check('A1 the fixture repository resolved (no "not a repository" / "open a session" state)',
      listed.notARepo === false && listed.noSession === false, JSON.stringify(listed))

    step('A2 — read the tree: nesting, labels, headers')
    // ------------------------------------------------------------------ A2
    const tree = await evalIn(TREE_SNAP)
    section('A2 — the rendered tree', tree)
    const dirNames = tree.dirs.map((dir) => dir.name)
    const fileLabels = tree.files.map((file) => file.label)
    const rootLabels = (tree.rootFiles ?? []).map((file) => file.label)

    check('A2 every file row is labelled with its own name, never a path',
      [...fileLabels, ...rootLabels].every((label) => !label.includes('/')),
      JSON.stringify([...fileLabels, ...rootLabels]))
    // `apps/api/src/modules/agent` holds files AND a subdirectory, so compaction
    // stops there by design; `tools/` is a nested header, not a merged one.
    check('A2 a nested header exists for the subdirectory that holds files',
      dirNames.includes('tools/'), JSON.stringify(dirNames))
    check('A2 the header for the deep chain is the compacted single-child run',
      dirNames.includes(`${DEEP_DIR}/`), JSON.stringify(dirNames))
    check('A2 the second top-level directory has its own header',
      dirNames.includes('docs/'), JSON.stringify(dirNames))
    check('A2 a root file renders with no header above it',
      rootLabels.includes('README.md'), JSON.stringify(rootLabels))
    check('A2 nesting is real: the nested header is indented past its parent',
      tree.dirs.some((dir) => dir.name === 'tools/'
        && tree.dirs.some((parent) => parent.name === `${DEEP_DIR}/` && dir.indent > parent.indent)),
      JSON.stringify(tree.dirs.map((dir) => ({ name: dir.name, indent: dir.indent }))))
    check('A2 a nested file is indented past its own header',
      tree.files.filter((file) => file.label === 'detail.tool.ts').every((file) => file.indent > 0),
      JSON.stringify(tree.files.filter((file) => file.label === 'detail.tool.ts')))

    step('A3 — folding a header hides only its own subtree')
    // ------------------------------------------------------------------ A3
    const collapsed = await evalIn(`(function () {
      var panel = document.querySelector('.dshAsbGit')
      var rows = Array.prototype.slice.call(panel.querySelectorAll('.dshAsbGit-dirRow'))
      var target = rows.filter(function (node) {
        var name = node.querySelector('.dshAsbGit-dirName')
        return name !== null && (name.innerText || '').trim() === ${JSON.stringify(`${DEEP_DIR}/`)}
      })[0]
      if (target === undefined) return { clicked: false }
      target.click()
      return { clicked: true }
    })()`)
    check('A3 the deep header is clickable', collapsed.clicked === true, JSON.stringify(collapsed))
    await sleep(200)
    const afterCollapse = await evalIn(TREE_SNAP)
    section('A3 — the tree after folding the deep header', afterCollapse)
    check('A3 folding hides the files under that header',
      !afterCollapse.files.some((file) => file.label === 'detail.tool.ts'),
      JSON.stringify(afterCollapse.files.map((file) => file.label)))
    check('A3 folding leaves the other top-level directory alone',
      afterCollapse.dirs.some((dir) => dir.name === 'docs/'),
      JSON.stringify(afterCollapse.dirs.map((dir) => dir.name)))
    // Re-open, so the diff assertions below run against the full tree.
    await evalIn(`(function () {
      var panel = document.querySelector('.dshAsbGit')
      var rows = Array.prototype.slice.call(panel.querySelectorAll('.dshAsbGit-dirRow'))
      var target = rows.filter(function (node) {
        var name = node.querySelector('.dshAsbGit-dirName')
        return name !== null && (name.innerText || '').trim() === ${JSON.stringify(`${DEEP_DIR}/`)}
      })[0]
      if (target !== undefined) target.click()
      return true
    })()`)
    await sleep(200)

    step('A4 — open the tall diff and count its vertical scrollers')
    // ------------------------------------------------------------------ A4
    const clicked = await evalIn(clickFile('chef-prompt.ts'))
    section('A4 — click the tall file', clicked)
    check('A4 the tall file row was clicked', clicked.clicked === true, JSON.stringify(clicked))
    const scrolled = await waitUntil('the tall diff to render', 30_000, SCROLL_SNAP,
      (snap) => snap.mounted === true && snap.bodyPresent === true && snap.bodyScrollHeight > snap.bodyClientHeight + 1)
    section('A4 — the right pane, measured', scrolled)
    check('A4 the diff overflows its body, so the scroll question is decidable',
      scrolled.bodyScrollHeight > scrolled.bodyClientHeight + 1,
      JSON.stringify({ scrollHeight: scrolled.bodyScrollHeight, clientHeight: scrolled.bodyClientHeight }))
    check('A4 the right pane has exactly ONE vertical scroller',
      scrolled.scrollable.length === 1,
      JSON.stringify(scrolled.scrollable))
    check('A4 that scroller is the diff body, not the pane and not the <pre>',
      scrolled.scrollable.length === 1 && scrolled.scrollable[0].cls.includes('dshAsbGit-diffBody'),
      JSON.stringify(scrolled.scrollable.map((node) => node.cls)))
    check('A4 the <pre> inside it does not scroll vertically of its own accord',
      scrolled.preOverflowY !== 'auto' && scrolled.preOverflowY !== 'scroll',
      String(scrolled.preOverflowY))

    step('A5 — the change ruler')
    // ------------------------------------------------------------------ A5
    const ruler = await evalIn(RULER_SNAP)
    section('A5 — ruler marks against the diff itself', ruler)
    check('A5 the ruler rendered', ruler.rulerPresent === true, JSON.stringify(ruler.rulerAria))
    check('A5 it carries marks', ruler.marks.length > 0, `${String(ruler.marks.length)} mark(s)`)
    check('A5 every mark is an add or a del', ruler.marks.every((mark) => mark.kind === 'add' || mark.kind === 'del'),
      JSON.stringify(ruler.marks.map((mark) => mark.kind)))
    // The fixture changes many lines in the tall file, so the marks must be
    // several — one per contiguous run, never one per line.
    check('A5 the marks match the diff: every kind present is add or del, and both appear',
      ruler.marks.some((mark) => mark.kind === 'add') && ruler.marks.some((mark) => mark.kind === 'del'),
      JSON.stringify({ marks: ruler.marks.length, adds: ruler.adds, dels: ruler.dels }))
    // The fixture replaces one line every 12 lines, so each hunk is a del+add
    // pair. A pair keeps two marks (different colours); a run of identical
    // lines collapses to one. Both rules are visible in the counts below.
    check('A5 a run of same-kind lines is ONE mark, not one per line',
      ruler.marks.length <= ruler.adds + ruler.dels,
      JSON.stringify({ marks: ruler.marks.length, changedLines: ruler.adds + ruler.dels }))
    check('A5 every mark carries its own accessible label',
      ruler.marks.every((mark) => typeof mark.label === 'string' && mark.label !== ''), JSON.stringify(ruler.marks[0]))
    check('A5 a mark sits inside the ruler, not below it',
      ruler.marks.every((mark) => parseFloat(mark.top) >= 0 && parseFloat(mark.top) <= 100),
      JSON.stringify(ruler.marks.map((mark) => mark.top)))
    // The mark's PAINTED length is the true fraction of changed lines. This is
    // the fact a CSS floor destroys: a `min-height` or a `Math.max(span, 0.6%)`
    // makes a one-line change as long as a real block, so the ruler stops
    // telling the reader how much changed. The fixture's marks are 1-2 lines
    // each, so on any ordinary ruler height a floor shows up as a mismatch here.
    {
      const rulerHeight = ruler.rulerHeight
      const expected = ruler.marks.map((mark) => {
        // `height` is the inline percentage the component wrote; the mark's line
        // span is in its aria label (from-to, 1-based).
        return { spanPct: parseFloat(mark.height), px: mark.px }
      })
      const faithful = expected.every((entry) => {
        if (!Number.isFinite(entry.spanPct) || rulerHeight <= 0) return false
        const predicted = (entry.spanPct / 100) * rulerHeight
        // 1px of slack: sub-pixel rounding in the compositor, nothing more. A
        // floor of 2px or 0.6% exceeds this on a ruler shorter than 333px.
        return Math.abs(entry.px - predicted) <= 1
      })
      check('A5 a mark is PAINTED at its true line fraction, with no minimum height',
        faithful,
        JSON.stringify({ rulerHeight, marks: expected.map((e) => ({ span: e.spanPct, px: e.px, predicted: Math.round((e.spanPct / 100) * rulerHeight * 100) / 100 })) }))
    }

    const jumped = await evalIn(CLICK_RULER_MARK)
    section('A5 — clicking the first mark', jumped)
    check('A5 clicking a mark moves the diff', jumped.clicked === true && jumped.after !== jumped.before,
      JSON.stringify(jumped))

    step('A6 — clean run')
    // ------------------------------------------------------------------ A6
    const log = readKernelLog()
    section('A6 — kernel log tail', log.all.slice(-6))
    check('A6 no console error was logged', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 4)))
    check('A6 no crashed slot entry', (await evalIn(`document.querySelectorAll('[data-slot-error]').length`)) === 0, '')
    check('A6 the kernel log carries no failure signal', log.suspicious.length === 0,
      JSON.stringify(log.suspicious.slice(0, 4)))

    child.kill()
  } finally {
    if (!child.killed) child.kill()
  }
}

async function main() {
  try {
    await run()
  } catch (error) {
    console.error(`\nprobe failed: ${error instanceof Error ? error.message : String(error)}`)
    failures.push(String(error))
  }
  console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`)
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`)
  }
  app.exit(failures.length === 0 ? 0 : 1)
}

/**
 * Exit on a module-load failure.
 *
 * A syntax or reference error in this file happens BEFORE `main()` exists, so
 * nothing calls `app.exit()` and the Electron process sits alive with no window
 * until an external timeout kills it — measured: one such run burned its full
 * 15-minute budget and left a hung process behind, and the terminal reported a
 * timeout instead of the actual `ReferenceError`. Electron prints the load error
 * and then waits, so the exit has to be scheduled from here.
 */
process.on('uncaughtException', (error) => {
  console.error(`\nprobe crashed while loading: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  app.exit(1)
})

void main()
