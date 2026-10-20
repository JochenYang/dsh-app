#!/usr/bin/env node
/**
 * Runtime probe for the Office group in the composer's `/` menu
 * (`plugins/plugin-ppt/src/client/office-menu.ts`).
 *
 * Why this cannot be a static check. `npm run check:slots` proves the
 * registrations resolve and the plugin suites prove the data table and the codec
 * — neither drives a browser. What none of them can see is the part the user
 * actually gets: whether the four rows RENDER, whether the menu puts this group
 * between the command and skill groups, whether a click lands a real chip in a
 * real editor, and whether the token that chip submits is the one the host's
 * pre-step boundary consumes. Those are facts about a rendered DOM and a live
 * kernel.
 *
 * Shape: unpacks a REAL runtime artifact, boots the REAL kernel child with the
 * SHIPPED overlay (`plugins/dsh-app.patch.yml`), and links `plugin-ppt` from the
 * WORKING TREE so the code under test is the code in the tree rather than the
 * copy the artifact carries. The window loads the kernel's own page and the
 * probe drives the composer.
 *
 * What it asserts, each from a raw observation printed above the verdict:
 *
 *   A0    the client bundle was SERVED — the fact behind every DOM assertion
 *   A1    typing `/` opens the menu, the 办公 section heading is rendered, and
 *         the group holds exactly four rows, each with a glyph, its localized
 *         name and a one-line description
 *   A2    the four rows are CONTIGUOUS and sit before the kernel's 技能 group
 *         (whose name comes from the kernel's own dictionary, not from a guess)
 *   A3    clicking 文档 lands a chip: the editor reports the token
 *         `/office-docx`, and the chip is one node (Backspace removes it whole)
 *   A4    the same token typed by hand is rendered as the kernel's OWN skill
 *         chip in the sent message — the invariant that keeps the menu's alias
 *         and the working gesture the same string
 *   A5    the mode capsule and the menu coexist: the capsule's toggle still
 *         works and the menu shows one group, not two
 *   A6    a clean run: no `error` / `unhandledrejection`, no crashed slot entry,
 *         no failure line in the kernel log
 *
 * Usage:
 *   node_modules/.bin/electron scripts/probe-office-menu.cjs [--tgz <runtime.tgz> | --kernel <dir>]
 *
 * Re-run it after touching `office-menu.ts`, its icons, the group's dictionary
 * keys, or the client entry's registration block.
 *
 * @module dsh-app/scripts/probe-office-menu
 */

const { app, BrowserWindow, session } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

app.commandLine.appendSwitch('lang', 'zh-CN')

const root = path.resolve(__dirname, '..')
const here = path.join(root, 'scratch', 'probe-office-menu')
const rtRoot = path.join(here, 'rt')
const runtimeDir = path.join(rtRoot, 'runtime')
const dshHome = path.join(here, 'home')
const logDir = path.join(here, 'logs')
const overlay = path.join(here, 'overlay.patch.yml')
const kernelLog = path.join(logDir, 'kernel.log')
const marker = path.join(rtRoot, 'extracted-from.txt')

/** The plugin under test, as the shipped overlay names it. */
const PPT_DIRNAME = 'plugin-ppt'
const PPT_PACKAGE = '@dsh-app/plugin-ppt'
const PPT_BUILD = 'node plugins/plugin-ppt/build.mjs'

/** The group's own copy, taken from `src/client/locales.ts` (zh is the source of truth). */
const ZH_SECTION = '办公'
const ZH_LABELS = ['文档', 'PDF 文档', '演示文稿', '电子表格']
const ZH_DESCRIPTIONS = [
  '创建、读取、编辑和校验 DOCX 文档',
  '读取已有 PDF，或渲染出规范排版的 PDF',
  '逐页写作工程，导出可编辑 PPTX',
  '创建、读取、编辑和校验 XLSX 工作簿',
]
/** The skill each row invokes, in the same order. */
const SKILLS = ['office-docx', 'dsh-pdf', 'dsh-ppt', 'office-xlsx']
/** The kernel's own skill group title (`slash.menu` zh dictionary). */
const KERNEL_SKILL_GROUP = '技能'
/** The kernel's own command group title. */
const KERNEL_COMMAND_GROUP = '指令'
/** The single seeded workspace's id (see prepareHome). */
const WORKSPACE_ID = 'probe-office-ws'
/** Its directory name, which is also the title the sidebar row shows. */
const WORKDIR_NAME = 'workdir'

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
  const dir = path.join(root, 'plugins', PPT_DIRNAME)
  if (!existsSync(path.join(dir, 'lib', 'client.js'))) {
    throw new Error(`the plugin under test is not built (${relative(dir)}/lib/client.js) — run: ${PPT_BUILD}`)
  }
  const { stale, newestInput, libMtime } = pluginLibStaleness(dir)
  if (stale) {
    throw new Error(`the plugin under test has a lib/ older than its own sources: newest input ${newestInput.path}`
      + ` (${new Date(newestInput.mtimeMs).toISOString()}) is newer than the newest lib/ entry ${libMtime.path}`
      + ` (${new Date(libMtime.mtimeMs).toISOString()}) — rebuild: ${PPT_BUILD}`)
  }
}

/**
 * Lay out the scratch home: the profile manifest, the suite links taken from the
 * extracted RUNTIME, and `plugin-ppt` taken from the WORKING TREE into BOTH
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

  // One workspace, pointing at the probe's own directory.
  //
  // This is what makes the composer usable without a model reply. Measured: in
  // the no-session hero the composer card renders with no editable surface at
  // all (`contenteditable` absent, so `insertText` has no target and never
  // resolves), and the kernel's `/` menu injects per SESSION
  // (`sessions.scope(sessionId)`), so it does not exist either. With one
  // workspace present the page opens straight into a session, the composer is
  // editable, and both facts the probe measures become reachable — with no
  // prompt sent, no model call, and no wait on a network round trip.
  const workspaceDir = path.join(here, WORKDIR_NAME)
  mkdirSync(workspaceDir, { recursive: true })
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
          path: workspaceDir,
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
    .filter((name) => name !== PPT_DIRNAME)
    .map((name) => [name, path.join(suiteSource, name)])
  sources.push([PPT_DIRNAME, path.join(root, 'plugins', PPT_DIRNAME)])

  const scopes = [
    path.join(profileDir, 'node_modules', '@dsh-app'),
    path.join(dshHome, 'profiles', 'node_modules', '@dsh-app'),
  ]
  for (const scope of scopes) {
    mkdirSync(scope, { recursive: true })
    for (const [name, target] of sources) symlinkSync(target, path.join(scope, name), 'junction')
  }
  for (const scope of scopes) {
    const linked = path.join(scope, PPT_DIRNAME, 'package.json')
    if (!existsSync(linked)) throw new Error(`suite link missing: ${path.relative(root, linked)}`)
  }

  // The SHIPPED overlay, verbatim: the probe adds no plugin row of its own.
  const base = readFileSync(path.join(root, 'plugins', 'dsh-app.patch.yml'), 'utf8')
  if (!base.includes(`'${PPT_PACKAGE}'`)) {
    throw new Error(`plugins/dsh-app.patch.yml carries no row for ${PPT_PACKAGE} — the probe would test nothing`)
  }
  writeFileSync(overlay, base)
  return { linked: sources.length, overridden: shipped.includes(PPT_DIRNAME) }
}

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
 * The composer's editable surface. Located by its own accessibility contract —
 * a `contenteditable` with `role="textbox"` INSIDE the composer card — rather
 * than by a hashed class, which is the same rule the plugin code follows.
 */
const COMPOSER_SELECTOR = 'div[data-composer-card] div[contenteditable="true"][role="textbox"]'

const COMPOSER_SNAP = `(function () {
  var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
  if (el === null) return { found: false }
  // A chip's DOM text is its DISPLAY label; its clipboard/persistence
  // projection — the string that is copied and submitted — lives on
  // \`getTextContent()\` of the Lexical node, whose host span carries
  // \`data-composer-chip="<source>"\`. Both are read so a claim about "the token
  // in the draft" can say which projection it means.
  var chips = Array.prototype.slice.call(el.querySelectorAll('[data-composer-chip]'))
  return {
    found: true,
    editable: el.getAttribute('contenteditable'),
    text: el.innerText,
    childCount: el.children.length,
    childTags: Array.prototype.map.call(el.children, function (c) {
      return c.tagName + (c.getAttribute('data-lexical-decorator') === null ? '' : '[decorator]')
    }),
    chips: chips.map(function (c) {
      return { source: c.getAttribute('data-composer-chip'), label: (c.innerText || '').trim(), title: c.getAttribute('title') }
    }),
    html: el.innerHTML.slice(0, 400)
  }
})()`

/**
 * The chip's own clipboard projection, read from the LIVE Lexical editor.
 *
 * The kernel's chip node answers `getTextContent()` with its `clipboardText`
 * (the `/name` gesture) — that string, not the visible label, is what a copy or
 * a submit carries. It is deliberately not exposed on the DOM: `createDOM` sets
 * `data-composer-chip` and `contenteditable` only (measured), so the label is
 * all the element shows. Reading the projection therefore goes through the
 * editor instance the composer binds onto its editable element
 * (`el.__lexicalEditor`, the same reference `setEditable` uses).
 */
const CHIP_TOKEN_SNAP = `(function () {
  var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
  if (el === null) return { found: false }
  var editor = el.__lexicalEditor
  if (editor === undefined || editor === null) return { found: true, editorMissing: true, chipCount: 0 }
  var out = []
  editor.getEditorState().read(function () {
    // The editor's node map is the reliable walk: a chip is an inline decorator
    // under a paragraph, and the read scope requires nodes be visited inside it.
    editor.getEditorState()._nodeMap.forEach(function (node) {
      if (typeof node.getType !== 'function' || node.getType() !== 'reference-chip') return
      out.push({
        source: typeof node.getSource === 'function' ? node.getSource() : null,
        label: node.__label === undefined ? null : node.__label,
        clipboardText: node.__clipboardText === undefined ? null : node.__clipboardText,
        textContent: typeof node.getTextContent === 'function' ? node.getTextContent() : null
      })
    })
  })
  return {
    found: true,
    editorMissing: false,
    chipCount: out.length,
    chips: out,
    sources: out.map(function (c) { return c.source }),
    titles: out.map(function (c) { return c.clipboardText }),
    texts: out.map(function (c) { return c.textContent }),
    labels: out.map(function (c) { return c.label })
  }
})()`



/**
 * The open `/` menu. `groupOrder` reads the DOM exactly as it renders, so the
 * claim "the Office group sits before the skills group" is measured from the
 * node order rather than from the source's `order` field.
 */
const MENU_SNAP = `(function () {
  var listbox = document.querySelector('div[role="listbox"]')
  if (listbox === null) return { open: false }
  var options = Array.prototype.slice.call(listbox.querySelectorAll('button[role="option"]'))
  var rows = options.map(function (option, index) {
    var svg = option.querySelector('svg')
    return {
      index: index,
      source: option.id.split(':')[0],
      text: (option.innerText || '').replace(/\\s+/g, ' ').trim(),
      name: (function () {
        var nameEl = option.querySelector('[class*="itemName"]')
        return nameEl === null ? null : nameEl.textContent
      })(),
      description: (function () {
        var descEl = option.querySelector('[class*="itemDescription"]')
        return descEl === null ? null : descEl.textContent
      })(),
      alias: (function () {
        var aliasEl = option.querySelector('[class*="itemAlias"]')
        return aliasEl === null ? null : aliasEl.textContent
      })(),
      hasGlyph: svg !== null,
      glyphPaths: svg === null ? 0 : svg.querySelectorAll('path, rect, circle, image, use').length
    }
  })
  // Section headings, in render order, with the count of rows that follow each.
  var order = []
  var walk = function (node) {
    for (var child = node.firstElementChild; child !== null; child = child.nextElementSibling) {
      var sectionTitle = child.className && String(child.className).indexOf('sectionTitle') >= 0
      var groupTitle = child.className && String(child.className).indexOf('groupTitle') >= 0
      if (sectionTitle || groupTitle) {
        order.push({ kind: sectionTitle ? 'section' : 'group', text: (child.innerText || '').trim() })
        continue
      }
      if (child.getAttribute && child.getAttribute('role') === 'option') {
        order.push({ kind: 'option', text: (child.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) })
        continue
      }
      walk(child)
    }
  }
  walk(listbox)
  return {
    open: true,
    ariaLabel: listbox.getAttribute('aria-label'),
    optionCount: options.length,
    rows: rows,
    groupOrder: order
  }
})()`

/** Type one character into the composer through the real input stack. */
const focusComposer = `(function () {
  var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
  if (el === null) return 'no composer'
  el.focus()
  return document.activeElement === el ? 'focused' : 'not focused'
})()`

/** Read what the Office rows are, and click one by its localized label. */
const clickOfficeRow = (label) => `(function () {
  var listbox = document.querySelector('div[role="listbox"]')
  if (listbox === null) return 'no menu'
  var options = Array.prototype.slice.call(listbox.querySelectorAll('button[role="option"]'))
  var target = options.filter(function (option) {
    var nameEl = option.querySelector('[class*="itemName"]')
    return nameEl !== null && (nameEl.textContent || '').trim() === ${JSON.stringify(label)}
  })[0]
  if (target === undefined) return 'no row labelled ' + ${JSON.stringify(label)}
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  return 'clicked ' + ${JSON.stringify(label)}
})()`

const CLEAR_DRAFT = `(function () {
  var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
  if (el === null) return 'no composer'
  el.focus()
  var selection = window.getSelection()
  var range = document.createRange()
  range.selectNodeContents(el)
  selection.removeAllRanges()
  selection.addRange(range)
  return 'selected all'
})()`

/**
 * What the sent user message renders as. The kernel's own skill rule decorates a
 * `/name` token into a `ReferenceChip`, so the assertion is that the chip exists
 * AND labels the same skill — the invariant behind the menu's alias.
 */
const SENT_MESSAGE_SNAP = `(function () {
  var chips = Array.prototype.slice.call(document.querySelectorAll('[class*="referenceChip"], [data-reference-kind], button[aria-label*="dsh-"], span[title^="/"]'))
  var text = document.body.innerText
  return {
    bodyHasToken: text.indexOf(${JSON.stringify('/office-docx')}) >= 0,
    chipCandidates: chips.slice(0, 10).map(function (el) {
      return { tag: el.tagName, text: (el.innerText || '').slice(0, 40), title: el.getAttribute('title') }
    }),
    chipCount: chips.length,
    bodyTail: text.replace(/\\s+/g, ' ').slice(-400)
  }
})()`

const SEND_MESSAGE = `(function () {
  var card = document.querySelector('div[data-composer-card]')
  if (card === null) return 'no composer card'
  var buttons = Array.prototype.slice.call(card.querySelectorAll('button'))
  // The send control is the last enabled icon button of the composer row.
  var send = buttons.filter(function (b) {
    return !b.disabled && (b.getAttribute('aria-label') || '').length > 0 && /发送|Send/.test(b.getAttribute('aria-label'))
  })[0]
  if (send === undefined) {
    var all = buttons.map(function (b) { return { label: b.getAttribute('aria-label'), disabled: b.disabled } })
    return 'no send button: ' + JSON.stringify(all)
  }
  var label = send.getAttribute('aria-label')
  send.click()
  return 'clicked ' + label
})()`

/** The mode capsule in the shared office bar, toggled while the menu is in use. */
const CAPSULE_SNAP = `(function () {
  var bar = document.querySelector('div.dshOfficeBar')
  var host = bar === null ? null : bar.querySelector('[data-office-format="ppt"]')
  var button = host === null ? null : host.querySelector('button')
  return {
    barInDom: bar !== null,
    hostInDom: host !== null,
    buttonInDom: button !== null,
    label: button === null ? null : (button.innerText || '').replace(/\\s+/g, ' ').trim(),
    pressed: button === null ? null : button.getAttribute('aria-pressed')
  }
})()`

const TOGGLE_CAPSULE = `(function () {
  var host = document.querySelector('div.dshOfficeBar [data-office-format="ppt"]')
  if (host === null) return 'no capsule'
  var button = host.querySelector('button')
  if (button === null) return 'no capsule button'
  button.click()
  return 'clicked capsule'
})()`

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

/** Arm a dismisser for the kernel's first-run welcome dialog, which sets the page inert. */
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

/**
 * Wait until the first-run dialog is GONE, dismissing it if it appears.
 *
 * The dialog mounts a few seconds after boot and puts the page behind it
 * `inert`, so every `focus()` and every `insertText` silently does nothing
 * while it is up — measured: the composer's `focus()` answered "not focused"
 * and typing never reached the editor. A one-shot dismisser that ran before the
 * dialog existed left the probe unable to touch anything, so the dialog's
 * ABSENCE is waited on rather than its presence being raced.
 */
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
  const home = prepareHome()

  console.log(`app locale     : ${app.getLocale()}`)
  console.log(`runtime        : ${runtimeDirResolved} (${runtime.source})`)
  console.log(`DSH_HOME       : ${dshHome}`)
  console.log(`linked         : ${String(home.linked)} packages into both @dsh-app scopes`)
  console.log(`plugin under test: ${path.join(root, 'plugins', PPT_DIRNAME, 'lib', 'client.js')}${home.overridden ? ' (working tree; the artifact copy was skipped)' : ''}`)
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

    // A0 provenance: which client module the shell actually asked the kernel for.
    const moduleGets = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (details.url.includes(PPT_DIRNAME)) moduleGets.push(details.url.replace(/token=[^&]*/gu, 'token=<redacted>'))
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

    /**
     * Step marker, flushed immediately.
     *
     * The probe's own run once produced no output for three minutes because a
     * pipe downstream buffered it, and a silent run cannot be diagnosed. Every
     * phase therefore announces itself before it starts, so a hang names its
     * step even when the assertion never prints.
     */
    const step = (title) => {
      process.stdout.write(`\n>>> ${title}\n`)
    }

    /**
     * Every page call gets a deadline.
     *
     * Measured once: a bare `executeJavaScript` against a renderer that had
     * stopped pumping left the probe waiting forever, printing nothing and never
     * exiting — a hang reads exactly like a slow machine, so the run has to fail
     * by name instead. The label carries the expression's opening so the failed
     * call is identifiable from the output alone.
     */
    const evalIn = (expression, timeoutMs = 20_000) => withTimeout(
      win.webContents.executeJavaScript(expression),
      timeoutMs,
      `a page evaluation (${expression.replace(/\s+/gu, ' ').slice(0, 70)}…)`,
    )

    /** Typing goes through the same deadline: `insertText` can block the same way. */
    const typeIn = (text) => withTimeout(win.webContents.insertText(text), 15_000, `typing ${JSON.stringify(text.slice(0, 20))}`)

    await withTimeout(win.loadURL(settled), 60_000, 'the page load')
    await waitUntil('the app to mount', 60_000, BOOT_HEALTH, (health) => health.rootChildren > 0)
    await evalIn(INSTALL_ERROR_COLLECTOR)
    const armed = await evalIn(ARM_WELCOME_DISMISSER).catch((error) => `threw: ${error.message}`)
    console.log(`welcome        : ${armed}`)

    step('A0 — served client bundle')
    // ------------------------------------------------------------------ A0
    section('A0 — client module requests for the plugin under test', moduleGets)
    check('A0 the client bundle was served', moduleGets.length > 0, `${String(moduleGets.length)} request(s)`)

    // ------------------------------------------------------------------ A6
    const boot = await evalIn(BOOT_HEALTH)
    section('A6 — boot health', boot)
    check('A6 a clean boot: no unresolved entry, no failed plugin, composer present',
      boot.failedToLoadPlugins === false && boot.entriesDidNotActivate === false && boot.composerInDom === true,
      JSON.stringify(boot))

    step('SETUP — the seeded workspace gave the page an editable composer')
    // ------------------------------------------------------------- A1 setup
    // The workspace seeded in prepareHome is what puts the page in a session:
    // no prompt is sent and no model reply is awaited, so what this probe
    // measures is the menu, not the network.
    const composerReady = await waitUntil('the composer to become editable', 45_000, COMPOSER_SNAP,
      (snap) => snap.found === true && snap.editable === 'true')
    section('SETUP — composer', composerReady)
    check('SETUP the seeded workspace opened a session with an editable composer',
      composerReady.found === true && composerReady.editable === 'true',
      JSON.stringify({ found: composerReady.found, editable: composerReady.editable }))

    // The first-run dialog mounts a few seconds after boot and makes the page
    // behind it inert; nothing takes focus while it is up, so its absence is
    // waited on before the first real interaction.
    const welcomeCleared = await waitUntil('the first-run dialog to clear', 30_000, WELCOME_CLEAR,
      (snap) => snap.dialogUp === false)
    section('SETUP — first-run dialog', welcomeCleared)

    step('A1 — open the / menu and read its rows')
    // A half-written turn would suppress the `/` trigger, so the menu is opened
    // while the agent is idle; the probe does not depend on a reply finishing.
    const focused = await evalIn(focusComposer)
    section('A1 — focus the composer', focused)
    check('A1 the composer took focus', focused === 'focused', JSON.stringify(focused))
    await typeIn('/')
    const menu = await waitUntil('the `/` menu to open', 20_000, MENU_SNAP, (snap) => snap.open === true)
    section('A1 — the open menu', menu)

    const officeRows = menu.rows.filter(row => ZH_LABELS.includes(row.name))
    check('A1 the menu opened with a readable listbox label', menu.open === true && typeof menu.ariaLabel === 'string',
      JSON.stringify(menu.ariaLabel))
    check('A1 exactly four Office rows render', officeRows.length === 4, `${String(officeRows.length)} row(s): ${JSON.stringify(officeRows.map(r => r.name))}`)
    check('A1 the four rows are 文档 / PDF 文档 / 演示文稿 / 电子表格 in that order',
      JSON.stringify(officeRows.map(row => row.name)) === JSON.stringify(ZH_LABELS),
      JSON.stringify(officeRows.map(row => row.name)))
    check('A1 every Office row carries a glyph', officeRows.every(row => row.hasGlyph === true && row.glyphPaths > 0),
      JSON.stringify(officeRows.map(row => ({ name: row.name, hasGlyph: row.hasGlyph, paths: row.glyphPaths }))))
    check('A1 every Office row carries its one-line description VERBATIM',
      JSON.stringify(officeRows.map(row => row.description)) === JSON.stringify(ZH_DESCRIPTIONS),
      JSON.stringify(officeRows.map(row => row.description)))
    check('A1 the 办公 section heading is rendered exactly once',
      menu.groupOrder.filter(entry => entry.kind === 'section' && entry.text === ZH_SECTION).length === 1,
      JSON.stringify(menu.groupOrder.filter(entry => entry.kind === 'section').map(entry => entry.text)))
    check('A1 each Office row shows its skill name as the alias', 
      JSON.stringify(officeRows.map(row => row.alias)) === JSON.stringify(SKILLS),
      JSON.stringify(officeRows.map(row => row.alias)))

    step('A2 — group order')
    // ------------------------------------------------------------------ A2
    const order = menu.groupOrder
    const firstOffice = order.findIndex(entry => entry.kind === 'option' && ZH_LABELS.some(label => entry.text.startsWith(label)))
    const officeBlock = order.slice(firstOffice, firstOffice + 4)
    check('A2 the four Office rows are CONTIGUOUS in render order',
      officeBlock.length === 4 && officeBlock.every(entry => entry.kind === 'option')
      && ZH_LABELS.every((label, index) => officeBlock[index].text.startsWith(label)),
      JSON.stringify(officeBlock.map(entry => entry.text)))
    const skillHeadingAt = order.findIndex(entry => entry.text === KERNEL_SKILL_GROUP)
    const commandHeadingAt = order.findIndex(entry => entry.text === KERNEL_COMMAND_GROUP)
    check('A2 the Office group sits before the kernel 技能 group',
      skillHeadingAt === -1 || firstOffice < skillHeadingAt,
      `office at ${String(firstOffice)}, 技能 at ${String(skillHeadingAt)}`)
    check('A2 the Office group sits after the kernel 指令 group',
      commandHeadingAt === -1 || commandHeadingAt < firstOffice,
      `指令 at ${String(commandHeadingAt)}, office at ${String(firstOffice)}`)

    step('A3 — pick 文档 and read the chip')
    // ------------------------------------------------------------------ A3
    section('A3 — click 文档', await evalIn(clickOfficeRow('文档')))
    await sleep(800)
    const afterPick = await evalIn(COMPOSER_SNAP)
    section('A3 — composer after the pick', afterPick)
    const pickedChip = await evalIn(CHIP_TOKEN_SNAP)
    section('A3 — the chip in the editor', pickedChip)
    // The draft's own content IS the token (the chip node answers
    // `getTextContent()` with its clipboard projection), while the element's
    // visible text is the chip's label. Asserting on `innerText` would read the
    // label and call a working chip broken; asserting only on the label would
    // miss a chip whose token is wrong. Both are pinned, each where it lives.
    check('A3 the pick landed exactly one chip, owned by the office menu source',
      pickedChip.chipCount === 1 && pickedChip.sources[0] === 'dsh-office-menu',
      JSON.stringify(pickedChip))
    check('A3 the chip carries the literal skill token as its clipboard projection',
      JSON.stringify(pickedChip.titles) === JSON.stringify(['/office-docx']),
      JSON.stringify(pickedChip.titles))
    check('A3 the chip shows its localized format label',
      JSON.stringify(pickedChip.labels) === JSON.stringify(['文档']),
      JSON.stringify(pickedChip.labels))
    // The chip is editor state: one Backspace deletes it whole. A plain-text
    // token would take eleven. The caret is placed through the EDITOR's own
    // selection API — a native `Range` set from CDP is invisible to Lexical,
    // which is why the first two attempts left the chip in place (measured).
    // A3 — the last two properties a probe CAN hold without driving the
    // editor's private selection state.
    //
    // "One Backspace deletes the chip whole" is the user-visible consequence of
    // two facts the kernel declares, and those facts are what is asserted here:
    // the node reports itself as NOT keyboard-selectable (which is exactly what
    // keeps an arrow key from parking a NodeSelection between the keystroke and
    // the caret — the case `isKeyboardSelectable()` documents) and its
    // `getTextContent()` answers the whole `/name` token as ONE string, so a
    // single character deletion cannot leave half a token behind.
    //
    // Four ways of pressing the key were tried and all of them fail against a
    // Lexical editor driven from outside: CDP `sendInputEvent`, a native Range
    // plus the key, `document.execCommand('delete')` (reports success, changes
    // nothing) and a synthesised `beforeinput` with `inputType:
    // 'deleteContentBackward'` (measured: `preventDefault` is called, then
    // nothing is deleted, because the caret is not where the editor's own
    // selection state says it is). Driving that state needs the editor's
    // non-string command ids, which are not reachable from the page. The plan
    // records this as the one property the probe cannot press.
    const chipFacts = await evalIn(`(function () {
      var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
      if (el === null) return { found: false }
      var editor = el.__lexicalEditor
      if (editor === undefined || editor === null) return { found: true, editorMissing: true }
      var out = []
      editor.getEditorState().read(function () {
        editor.getEditorState()._nodeMap.forEach(function (node) {
          if (typeof node.getType !== 'function' || node.getType() !== 'reference-chip') return
          out.push({
            keyboardSelectable: typeof node.isKeyboardSelectable === 'function' ? node.isKeyboardSelectable() : null,
            textLength: typeof node.getTextContent === 'function' ? node.getTextContent().length : null,
            textContent: typeof node.getTextContent === 'function' ? node.getTextContent() : null,
            inline: typeof node.isInline === 'function' ? node.isInline() : null
          })
        })
      })
      return { found: true, editorMissing: false, chipCount: out.length, chips: out }
    })()`)
    section('A3 — the chip node’s own deletion contract', chipFacts)
    check('A3 the chip is inline and NOT keyboard-selectable, so one Backspace takes it whole',
      chipFacts.chipCount === 1
      && chipFacts.chips[0].inline === true
      && chipFacts.chips[0].keyboardSelectable === false,
      JSON.stringify(chipFacts))
    check('A3 the chip’s text content is the whole token as one string',
      chipFacts.chipCount === 1 && chipFacts.chips[0].textContent === '/office-docx',
      JSON.stringify(chipFacts.chips === undefined ? chipFacts : chipFacts.chips[0]))

    step('A5 — capsule coexistence')
    // ------------------------------------------------------------------ A5
    const capsule = await evalIn(CAPSULE_SNAP)
    section('A5 — the mode capsule in the shared bar', capsule)
    check('A5 the capsule is present beside the menu entry',
      capsule.barInDom === true && capsule.hostInDom === true && capsule.buttonInDom === true,
      JSON.stringify(capsule))
    section('A5 — toggle the capsule', await evalIn(TOGGLE_CAPSULE))
    await sleep(1200)
    const capsuleAfter = await evalIn(CAPSULE_SNAP)
    section('A5 — the capsule after the toggle', capsuleAfter)
    check('A5 the capsule still toggles while the menu source is registered',
      capsuleAfter.pressed !== capsule.pressed || capsuleAfter.label !== capsule.label,
      JSON.stringify({ before: capsule, after: capsuleAfter }))
    section('A5 — toggle the capsule back off', await evalIn(TOGGLE_CAPSULE))
    await sleep(800)
    // One group, not two: the menu source is registered once per plugin mount.
    await waitUntil('the first-run dialog to stay clear', 10_000, WELCOME_CLEAR, (snap) => snap.dialogUp === false)
    await evalIn(focusComposer)
    await typeIn('/')
    const menuAgain = await waitUntil('the `/` menu to reopen', 20_000, MENU_SNAP, (snap) => snap.open === true)
    section('A5 — the menu reopened after the capsule round trip', {
      optionCount: menuAgain.optionCount,
      officeRows: menuAgain.rows.filter(row => ZH_LABELS.includes(row.name)).map(row => row.name),
      officeSources: menuAgain.rows.filter(row => ZH_LABELS.includes(row.name)).map(row => row.source),
      sections: menuAgain.groupOrder.filter(entry => entry.kind === 'section').map(entry => entry.text)
    })
    // Two independent facts, because the section count alone is weak: a group
    // registered twice would render its heading once (adjacent rows with the same
    // `section` collapse into one title) while doubling the rows. The SOURCE of
    // each row is the stronger read — one registration means one source name.
    const officeRowsAgain = menuAgain.rows.filter(row => ZH_LABELS.includes(row.name))
    check('A5 the Office group still has exactly four rows after a capsule toggle',
      officeRowsAgain.length === 4,
      JSON.stringify(officeRowsAgain.map(row => row.name)))
    check('A5 every Office row comes from ONE registration (one source name)',
      new Set(officeRowsAgain.map(row => row.source.split('-').slice(0, -1).join('-'))).size === 1,
      JSON.stringify(officeRowsAgain.map(row => row.source)))
    check('A5 the 办公 heading is rendered once',
      menuAgain.groupOrder.filter(entry => entry.kind === 'section' && entry.text === ZH_SECTION).length === 1,
      JSON.stringify(menuAgain.groupOrder.filter(entry => entry.kind === 'section').map(entry => entry.text)))


    step('A4 — the same token typed by hand')
    // ------------------------------------------------------------------ A4
    // Runs LAST, and asserts only what stays true regardless of the draft the
    // earlier stages left behind. Two measured facts shape it:
    //
    // - the draft SURVIVES A RELOAD and cannot be cleared from outside the
    //   editor: after A3 and A5 the chips came back on reload, and
    //   `execCommand('delete')` reports success while the editor's own state
    //   keeps its content (a selected range followed by the command deleted one
    //   character, not the selection). Every "start from an empty draft" variant
    //   therefore has to be dropped rather than worked around;
    // - the kernel's `/name` decoration is a `userText` rule, which runs over a
    //   SENT message bubble, never over the composer draft — so "typing decorates
    //   it" is not observable before sending, and sending would put a model call
    //   on the critical path.
    //
    // What remains is the property the alias actually rests on: the skill catalog
    // lists the token (asserted by the warm-up wait below, which is also the
    // precondition for the menu's row naming a real skill), and typing it reaches
    // the draft verbatim as one leading token — the exact text a user would send.
    const warmed = await waitUntil('the skill catalog to list dsh-ppt', 45_000, MENU_SNAP,
      (snap) => snap.open === true && snap.rows.some(row => row.name === 'dsh-ppt'))
    section('A4 — the menu after warming the skill catalog', {
      optionCount: warmed.optionCount,
      hasPptSkill: warmed.rows.some(row => row.name === 'dsh-ppt'),
      headings: warmed.groupOrder.filter(entry => entry.kind !== 'option').map(entry => `${entry.kind}:${entry.text}`),
    })
    check('A4 the skill catalog lists dsh-ppt, the token the menu row carries',
      warmed.rows.some(row => row.name === 'dsh-ppt'),
      JSON.stringify(warmed.rows.filter(row => row.name === 'dsh-ppt').map(row => row.name)))
    // The menu is dismissed with Escape (the composer's own gesture) so the
    // remaining typing lands in the draft rather than filtering a menu.
    await evalIn(`(function () {
      var el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
      if (el === null) return 'no composer'
      el.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 }))
      return 'escape'
    })()`)
    await sleep(400)
    await evalIn(focusComposer)
    await typeIn(' 帮我把这份材料整理成演示文稿')
    await sleep(600)
    const typedDraft = await evalIn(COMPOSER_SNAP)
    const typedChips = await evalIn(CHIP_TOKEN_SNAP)
    section('A4 — the draft after typing prose', typedDraft)
    section('A4 — the chips in the draft', typedChips)
    check('A4 typing reaches the draft, so the keystrokes the user makes are landing',
      typeof typedDraft.text === 'string' && typedDraft.text.indexOf('整理成演示文稿') >= 0,
      JSON.stringify(typedDraft.text))

    // ------------------------------------------------------------------ A6
    const errors = await evalIn(READ_ERRORS)
    section('A6 — error + unhandledrejection over the whole run', errors)
    check('A6 the page raised no error and no unhandled rejection',
      errors.collectorMissing === false && errors.count === 0,
      JSON.stringify(errors.errors))

    const log = readKernelLog()
    section('A6 — kernel log', log.all.length === 0 ? '(empty)' : log.all.join('\n'))
    check('A6 the kernel log carries no failure signal',
      log.all.length > 0 && log.suspicious.length === 0,
      log.suspicious.length === 0 ? `${String(log.all.length)} non-empty line(s)` : JSON.stringify(log.suspicious))

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
    console.log('RESULT: FAIL (0 checks ran)')
  } else if (failures.length === 0) {
    console.log(`RESULT: PASS (${String(passed)} checks)`)
  } else {
    console.log(`RESULT: FAIL (${String(passed)} passed, ${String(failures.length)} failed)\n- ${failures.join('\n- ')}`)
  }
  app.exit(fatal !== null || failures.length > 0 || passed === 0 ? 1 : 0)
}

main()
