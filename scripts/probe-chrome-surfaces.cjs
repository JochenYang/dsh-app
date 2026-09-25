// Runtime probe for the desktop chrome (repo probe; scratch output).
//
// Boots a REAL kernel (the followed line's checkout) with the suite overlay and
// opens the UI in an Electron window, then measures the surfaces whose controls
// can end up under the native window-button strip (Windows: the top-right
// ~138x36 zone the titleBarOverlay draws its three buttons in):
//
//   1. every visible button in the top 80px — anything whose box intersects
//      that zone is a control the native buttons cover,
//   2. the conversation header's corner seat (the right-sidebar expander),
//   3. the right dock sidebar once opened: its panel and its collapse button,
//   4. any window the page opens (window.open): measured the same way, because
//      a child window inherits the overlay but never received the injected
//      chrome CSS before that gap was closed.
//
// Run: node_modules/.bin/electron scripts/probe-chrome-surfaces.cjs
const { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const { app, BrowserWindow, session } = require('electron')

const root = path.resolve(__dirname, '..')
const OVERLAY = path.join(root, 'dist', 'main', 'dsh-app.patch.yml')

/** The native strip: three caption buttons, 46px each, 36px tall (Windows 11). */
const STRIP_W = 138
const STRIP_H = 36

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms) }),
])

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

/** Boxes of the elements that matter, as plain data. */
const SURFACE_REPORT = `(function () {
  const strip = { w: ${STRIP_W}, h: ${STRIP_H}, right: window.innerWidth, top: 0 }
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      cls: (el.className || '').toString().slice(0, 90),
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
    }
  }
  const underStrip = (b) => b.w > 0 && b.h > 0 && b.y < strip.h && b.right > strip.right - strip.w
  const top = []
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    const b = box(el)
    if (b.w === 0 || b.y > 80) continue
    b.underStrip = underStrip(b)
    b.parent = (el.parentElement && el.parentElement.className || '').toString().slice(0, 90)
    b.grand = (el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.className || '').toString().slice(0, 90)
    top.push(b)
  }
  const corner = document.querySelector('[data-conversation-header-corner]')
  const panels = []
  for (const el of document.querySelectorAll('[class*="_panel"]')) {
    const b = box(el)
    if (b.w < 240 || b.h < 240) continue
    panels.push(b)
  }
  const collapse = []
  for (const el of document.querySelectorAll('[class*="_collapseGlyph"], [class*="_iconButton"]')) {
    const b = box(el)
    if (b.w === 0) continue
    b.underStrip = underStrip(b)
    b.parent = (el.parentElement && el.parentElement.className || '').toString().slice(0, 90)
    b.grand = (el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.className || '').toString().slice(0, 90)
    collapse.push(b)
  }
  return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, strip, top, corner: corner === null ? null : box(corner), panels, collapse }
})()`

/** Click the corner seat (the right-sidebar expander) if it is there. */
const OPEN_RIGHT_SIDEBAR = `(function () {
  const corner = document.querySelector('[data-conversation-header-corner]')
  if (corner === null) return 'no corner seat'
  const btn = corner.matches('button') ? corner : corner.querySelector('button')
  if (btn === null) return 'no button in the corner seat'
  btn.click()
  return 'clicked'
})()`

/** Every button that could open the automation/schedule surface. */
const TASK_ENTRIES = `(function () {
  const out = []
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    const text = (el.textContent || '').trim()
    if (!/任务|自动化|提醒|定时|Task|Automation|Reminder|Schedule/i.test(text)) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    out.push({ text: text.slice(0, 40), x: Math.round(r.x), y: Math.round(r.y) })
  }
  return out
})()`

const CLICK_TEXT = (text) => `(function () {
  const el = [...document.querySelectorAll('button, [role="button"]')]
    .find((b) => (b.textContent || '').trim().includes(${JSON.stringify(text)}))
  if (el === undefined) return false
  el.click()
  return true
})()`

async function main() {
  // Boot the kernel from the BUILT runtime artifact (the same bytes a user's
  // kernel update installs), not from a source checkout — the artifact is what
  // ships, and it carries the suite plugins itself. Extract to a temp work dir.
  const cell = `${process.platform}-${process.arch}`
  const tgz = path.join(root, 'runtime-dist', `dsh-runtime-${cell}-0.1.7-rc.2.tgz`)
  if (!existsSync(tgz)) throw new Error(`no runtime artifact for ${cell}: ${tgz} (build one: npm run runtime:build)`)
  const work = mkdtempSync(path.join(os.tmpdir(), 'dsh-chrome-probe-runtime-'))
  spawnSync('tar', ['--force-local', '-xzf', tgz, '-C', work], { stdio: 'inherit' })
  const runtimeDir = path.join(work, 'runtime')
  const nodeBin = path.join(runtimeDir, process.platform === 'win32' ? 'node/node.exe' : 'node/node')
  const script = path.join(runtimeDir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(nodeBin) || !existsSync(script)) throw new Error(`runtime dir incomplete: ${runtimeDir}`)

  const dshHome = mkdtempSync(path.join(os.tmpdir(), 'dsh-chrome-probe-home-'))
  const logDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-chrome-probe-log-'))
  const logPath = path.join(logDir, 'kernel.log')
  const port = await freePort()
  console.log(`runtime  : ${tgz}`)
  console.log(`DSH_HOME : ${dshHome}`)
  console.log(`port     : ${port}`)

  // The shell's migration materializes the profile manifest before the first
  // boot; a throwaway home has nothing to migrate, so write it directly (same
  // seed as scripts/smoke-suite.mjs and src/main/suite-profile.ts).
  const profileDir = path.join(dshHome, 'profiles', 'dsh-app')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-dsh-app',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)
  // The suite plugins come from the runtime artifact itself; link them into
  // both scopes the shell writes (the booted profile's own node_modules is the
  // one the enforcing resolver walks).
  const suiteSource = path.join(runtimeDir, 'app', 'node_modules', '@dsh-app')
  for (const scope of [
    path.join(profileDir, 'node_modules', '@dsh-app'),
    path.join(dshHome, 'profiles', 'node_modules', '@dsh-app'),
  ]) {
    mkdirSync(scope, { recursive: true })
    for (const entry of readdirSync(suiteSource)) {
      const link = path.join(scope, entry)
      if (!existsSync(link)) symlinkSync(path.join(suiteSource, entry), link, 'junction')
    }
  }

  const logFd = openSync(logPath, 'a')
  const child = spawn(nodeBin, [script, '--profile', 'dsh-app', '--patch', OVERLAY, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: runtimeDir,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, DSH_HOME: dshHome, DSH_APP_PROFILE: 'dsh-app' },
    windowsHide: true,
  })
  const watchdog = setTimeout(() => { console.error('probe watchdog fired'); app.exit(1) }, 300_000)
  watchdog.unref?.()

  try {
    const settled = await waitForSettledUrl(logPath, 180_000)
    console.log(`settled  : ${settled}`)
    await session.defaultSession.clearStorageData({ storages: ['cookies'] }).catch(() => undefined)
    const win = new BrowserWindow({
      width: 1440, height: 900, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    })
    // Children the page opens (window.open): measured like any other surface.
    const children = []
    win.webContents.on('did-create-window', (childWin) => {
      children.push(childWin)
      childWin.webContents.on('did-finish-load', async () => {
        await sleep(1500)
        const report = await childWin.webContents.executeJavaScript(SURFACE_REPORT).catch((error) => ({ error: String(error) }))
        console.log('\n--- child window (window.open) ---')
        console.log(JSON.stringify(report, null, 1))
      })
    })
    await withTimeout(win.loadURL(settled), 60_000, 'the page load')
    await sleep(6000)

    // Inject the SAME desktop chrome CSS the shell injects, so the probe
    // measures the adapted layout rather than the vanilla one. The built
    // window.js carries the stylesheet as a template literal over two numeric
    // constants; resolve both and inline the result.
    const built = readFileSync(path.join(root, 'dist', 'main', 'window.js'), 'utf8')
    const constOf = (name) => new RegExp(`const ${name} = (\\d+)`).exec(built)?.[1]
    const cssTemplate = /const DESKTOP_CHROME_CSS = `([\s\S]*?)`;\n/u.exec(built)
    if (cssTemplate !== null && constOf('WINDOW_CONTROLS_WIDTH') !== undefined) {
      const css = cssTemplate[1]
        .replace(/\$\{WINDOW_CONTROLS_WIDTH\}/gu, constOf('WINDOW_CONTROLS_WIDTH'))
        .replace(/\$\{OVERLAY_HEIGHT\}/gu, constOf('OVERLAY_HEIGHT') ?? '36')
        .replace(/\\`/gu, '`')
      await win.webContents.executeJavaScript(`(function () {
        if (document.getElementById('dsh-desktop-chrome')) return
        const el = document.createElement('style')
        el.id = 'dsh-desktop-chrome'
        el.textContent = ${JSON.stringify(css)}
        document.head.appendChild(el)
      })()`).catch(() => undefined)
      console.log(`chrome   : injected (${css.length} chars)`)
    } else {
      console.log('chrome   : NOT injected (CSS literal not found in the build)')
    }

    // The first-run notice covers the center and swallows clicks.
    await win.webContents.executeJavaScript(`(function () {
      const notice = [...document.querySelectorAll('button')].find((b) => /Continue|继续/.test(b.textContent))
      if (notice !== undefined) notice.click()
      return notice !== undefined
    })()`).catch(() => false)
    await sleep(800)

    const before = await win.webContents.executeJavaScript(SURFACE_REPORT)
    console.log('\n--- main window, initial ---')
    console.log(JSON.stringify(before, null, 1))

    const opened = await win.webContents.executeJavaScript(OPEN_RIGHT_SIDEBAR)
    console.log(`\ncorner seat: ${opened}`)
    await sleep(2000)
    const after = await win.webContents.executeJavaScript(SURFACE_REPORT)
    console.log('\n--- main window, right sidebar open ---')
    console.log(JSON.stringify(after, null, 1))

    const entries = await win.webContents.executeJavaScript(TASK_ENTRIES)
    console.log('\n--- task/automation entries ---')
    console.log(JSON.stringify(entries, null, 1))
    for (const entry of entries.slice(0, 2)) {
      const clicked = await win.webContents.executeJavaScript(CLICK_TEXT(entry.text)).catch((error) => `threw: ${String(error).slice(0, 80)}`)
      console.log(`clicked "${entry.text}": ${clicked}`)
      await sleep(3000)
    }
    const final = await win.webContents.executeJavaScript(SURFACE_REPORT)
    console.log('\n--- main window, after opening task surfaces ---')
    console.log(JSON.stringify(final, null, 1))
    await sleep(2000)
    for (const childWin of children) {
      if (childWin.isDestroyed()) continue
      const report = await childWin.webContents.executeJavaScript(SURFACE_REPORT).catch((error) => ({ error: String(error) }))
      console.log('\n--- child window (late read) ---')
      console.log(JSON.stringify(report, null, 1))
    }
  } finally {
    clearTimeout(watchdog)
    try { child.kill() } catch { /* already gone */ }
    app.exit(0)
  }
}

main().catch((error) => { console.error(error.message || error); app.exit(1) })
