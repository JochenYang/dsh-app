// Runtime probe: does the kernel reserve the caption strip, so its MODAL MASK
// stays off the window buttons? (repo probe; scratch output.)
//
// The defect this guards: the kernel paints its mask as
// `inset: var(--dsh-frame-chrome-top, 0px) 0 0` (ui-primitives/Modal.module.css),
// reserving exactly that much at the top. The variable is declared upstream only
// under `html[data-windows-titlebar]`, which the official desktop's own Windows
// preload sets and this shell never did — so the mask's inset collapsed to 0px,
// the scrim painted over the caption, and the strip went near-black over the page
// (reported as the window buttons not following the theme with a dialog open).
//
// What this measures, and what it deliberately does NOT: it boots the kernel in a
// bare Electron window and reads the KERNEL side — whether the variable is
// published and what the mask's computed inset resolves to. It cannot measure the
// shell's own strip colour (that is `setTitleBarOverlay`, native chrome the
// renderer cannot see, and not a public API); the shell side is verified by
// scratch/probe-overlay-applied.mjs against a running app. Keeping the two apart
// is why this probe has no screen-capture section: an earlier version sampled
// screen pixels, which this environment answers with whatever window happens to be
// on top — a measurement that reported failures it could not attribute.
//
// Run: node_modules/.bin/electron scripts/probe-overlay-modal.cjs [runtimeDir]
const { app, BrowserWindow, nativeTheme, session } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const OVERLAY = path.join(root, 'dist', 'main', 'dsh-app.patch.yml')
const RUNTIME = path.resolve(process.argv[2] ?? path.join(root, 'scratch', 'newrt-rc2', 'runtime'))
const PROFILE = 'dsh-app'
const STRIP = 36
const CONTROLS_W = 140

const lines = []
const record = (name, ok, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + detail}`
  lines.push(line)
  console.log(line)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Scratch directories this run created under the system temp, removed on the
 * way out. Without it every run left a scratch DSH_HOME and its junctions
 * behind (this machine had accumulated thousands of these; measured
 * 2026-10-02: 41,570 of our own entries and ~640 MB in %TEMP%).
 *
 * Removal goes through the link-safe walker: the home holds junctions into the
 * runtime tree, and a sync recursive delete descends THROUGH a junction instead
 * of unlinking it (scripts/lib/remove-tree.mjs holds the measurement).
 */
const scratch = []

/** Remove the scratch directories, best effort. */
async function cleanup() {
  const { removeTree } = await import('./lib/remove-tree.mjs')
  for (const dir of scratch) {
    try { await removeTree(dir) } catch { /* best effort */ }
  }
}

/** Remove scratch, then exit — `app.exit()` is immediate and runs no `finally`. */
async function exitAfterCleanup(code) {
  await cleanup()
  app.exit(code)
}

const watchdog = setTimeout(() => {
  console.error('probe watchdog fired — treating as FAIL')
  void exitAfterCleanup(1)
}, Number(process.env.PROBE_WATCHDOG_MS ?? 240_000))
watchdog.unref?.()

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
  })
}

/** The mask's own inset plus the frame variables, as the kernel resolves them. */
const STRIP_REPORT = `(function () {
  const cs = getComputedStyle(document.documentElement);
  const mask = document.querySelector('[class*="_mask_"]');
  const frame = document.querySelector('[class*="_frame"]');
  return {
    chromeTop: cs.getPropertyValue('--dsh-frame-chrome-top').trim() || null,
    topClearance: cs.getPropertyValue('--dsh-frame-top-clearance').trim() || null,
    titlebarMarker: document.documentElement.hasAttribute('data-windows-titlebar'),
    modalOpen: document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
    maskInsetTop: mask === null ? null : getComputedStyle(mask).inset.split(' ')[0],
    maskAfterBg: mask === null ? null : getComputedStyle(mask, '::after').backgroundColor,
    framePaddingTop: frame === null ? null : getComputedStyle(frame).paddingTop,
  };
})()`

async function main() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-overlay-probe-home-'))
  scratch.push(home)
  const profileDir = path.join(home, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)
  // The shell's brand-suite seam, replicated: one link per suite plugin into the
  // booted profile's OWN node_modules (a shared-scope link alone leaves every
  // suite entry failing to import, which would make this measure its own setup).
  const suiteSource = path.join(RUNTIME, 'app', 'node_modules', '@dsh-app')
  const scope = path.join(profileDir, 'node_modules', '@dsh-app')
  mkdirSync(scope, { recursive: true })
  for (const dir of readdirSync(suiteSource)) {
    if (!existsSync(path.join(suiteSource, dir, 'package.json'))) continue
    symlinkSync(path.join(suiteSource, dir), path.join(scope, dir), 'junction')
  }

  const port = await freePort()
  const logPath = path.join(home, 'kernel.log')
  const logFd = openSync(logPath, 'w')
  const nodeBin = path.join(RUNTIME, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const binJs = path.join(RUNTIME, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  console.log(`runtime  : ${RUNTIME}\nDSH_HOME : ${home}\nport     : ${port}\n`)
  const child = spawn(nodeBin, [binJs, '--profile', PROFILE, '--patch', OVERLAY, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: path.join(RUNTIME, 'app'),
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, DSH_HOME: home, DSH_APP_PROFILE: PROFILE },
    windowsHide: true,
  })

  try {
    const settled = await waitForSettledUrl(logPath, 120_000)
    console.log(`settled  : ${settled}\n`)
    // The reported symptom is a dark strip over a LIGHT page, so pin the light
    // theme: a dark document would make a dark sample legitimate and hide it.
    nativeTheme.themeSource = 'light'
    await session.defaultSession.clearStorageData({ storages: ['cookies'] }).catch(() => undefined)
    const win = new BrowserWindow({
      width: 1440, height: 900, show: false,
      // The app's own posture: hidden title bar plus a native overlay strip.
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#ffffff', symbolColor: '#1a1a1a', height: STRIP },
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    })
    await win.loadURL(settled)
    await waitFor(win, `[...document.querySelectorAll('button')].some((b) => /Continue|继续/.test(b.textContent)) || document.querySelector('[class*="sidebarCol"]') !== null`, 60_000, 'the app shell')
    await win.webContents.executeJavaScript(`(function () {
      const n = [...document.querySelectorAll('button')].find((b) => /Continue|继续/.test(b.textContent))
      if (n !== undefined) n.click()
      return true
    })()`)
    await sleep(800)

    // Open a real modal the way a user does.
    const opened = await win.webContents.executeJavaScript(`(function () {
      const row = [...document.querySelectorAll('button')].find((b) => /^(Plugins|插件)$/.test(b.textContent.trim()))
      if (row !== undefined) row.click()
      return row !== undefined
    })()`)
    await sleep(1200)
    const addClicked = await win.webContents.executeJavaScript(`(function () {
      const b = [...document.querySelectorAll('button')].find((x) => /Add plugin|添加插件/.test(x.textContent))
      if (b !== undefined) b.click()
      return b !== undefined
    })()`)
    await sleep(1000)
    const state = await win.webContents.executeJavaScript(STRIP_REPORT)
    console.log('--- add-plugin modal open, no inset published (pre-fix state) ---')
    console.log(JSON.stringify(state, null, 1))

    record('the probe opened the plugins page', opened)
    record('the probe opened the add-plugin modal', addClicked && state.modalOpen, `modalOpen=${String(state.modalOpen)}`)
    // The defect, reproduced: with nothing published the mask's inset collapses to
    // 0px, so the scrim covers the caption where the window buttons are.
    record('without the inset the mask covers the caption (the reported defect)',
      state.maskInsetTop === '0px' && state.maskAfterBg !== 'rgba(0, 0, 0, 0)',
      `mask inset-top=${String(state.maskInsetTop)} scrim=${String(state.maskAfterBg)}`)

    // Now publish exactly what the shell publishes (src/main/window.ts
    // installFrameMetrics) and confirm the kernel honours it. This is the
    // KERNEL's half of the contract; that the shell really publishes it is
    // verified against a running app (scratch/probe-minimal-fix.mjs) and by
    // test/desktop-chrome-css.test.mjs.
    await win.webContents.executeJavaScript(
      `document.documentElement.style.setProperty('--dsh-frame-chrome-top', '${STRIP}px')`,
    )
    await sleep(600)
    const fixed = await win.webContents.executeJavaScript(STRIP_REPORT)
    console.log('--- with the inset published (post-fix state) ---')
    console.log(JSON.stringify(fixed, null, 1))
    record('publishing the inset makes the mask reserve the caption',
      fixed.maskInsetTop === `${STRIP}px`, `mask inset-top=${String(fixed.maskInsetTop)} (caption ${STRIP}px)`)
    // The narrow scope: the inset alone must not hand the kernel a caption LAYOUT,
    // which would reserve a 36px row and round the main panel. Measured in the
    // running window as frame `padding-top` 0px -> 36px when the marker is used.
    record('the inset alone leaves the layout alone',
      fixed.framePaddingTop === '0px' && fixed.titlebarMarker === false,
      `frame padding-top=${String(fixed.framePaddingTop)} titlebarMarker=${String(fixed.titlebarMarker)}`)

    console.log(`\n${lines.filter((l) => l.startsWith('FAIL')).length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL'}`)
    await exitAfterCleanup(lines.some((l) => l.startsWith('FAIL')) ? 1 : 0)
  } catch (error) {
    console.error(error)
    await exitAfterCleanup(1)
  } finally {
    clearTimeout(watchdog)
    try { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* gone */ }
  }
}

async function waitForSettledUrl(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const match = /(?:^|\s)dsh web:\s+(http:\/\/\S+)/m.exec(text)
    if (match) return match[1]
    await sleep(500)
  }
  const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').slice(-20).join('\n') : '(no log)'
  throw new Error(`kernel did not report a settled URL:\n${tail}`)
}

async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await win.webContents.executeJavaScript(`(function () { try { return !!(${expression}); } catch (e) { return false; } })()`).catch(() => false)
    if (ok) return
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}

app.whenReady().then(main)
