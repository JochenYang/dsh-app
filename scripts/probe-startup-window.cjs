// Runtime probe for the first-launch splash window (scratch only, gitignored).
// Verifies the parts typecheck cannot: the local page loads inside a real
// sandboxed renderer, executeJavaScript is not blocked by the page CSP,
// injected state renders, an early push is queued by the page, the failure
// card resolves its injected promise with the clicked action id, and the
// splash closes when the real window paints.
//
// Also covers the brand row (logo/name/version) and the appearance hand-off:
// the splash must come up in the theme the UI's own setting asks for, not in
// whatever the OS happens to prefer.
//
// Run: npx electron scripts/probe-startup-window.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const splash = require(path.join(root, 'dist', 'main', 'startup-window.js'))
const splashPage = path.join(root, 'dist', 'static', 'startup.html')

const lines = []
const record = (name, ok, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + detail}`
  lines.push(line)
  console.log(line)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const READ_UI = `({
  name: document.getElementById('startup-name').textContent,
  version: document.getElementById('startup-version').textContent,
  theme: document.documentElement.getAttribute('data-theme'),
  saying: document.getElementById('startup-saying').textContent,
  mark: (function () {
    const mark = document.getElementById('startup-logo')
    const style = getComputedStyle(mark)
    return {
      svg: mark.querySelector('svg') !== null,
      bg: style.backgroundColor,
      ink: style.color,
      box: Math.round(mark.getBoundingClientRect().width),
    }
  })(),
  status: document.getElementById('startup-status').textContent,
  width: document.getElementById('startup-bar-fill').style.width,
  mode: document.getElementById('startup-bar').getAttribute('data-mode'),
  current: (document.querySelector('#startup-steps li[data-state="current"]') || {}).textContent,
  done: document.querySelectorAll('#startup-steps li[data-state="done"]').length,
  errorHidden: document.getElementById('startup-error').hidden,
  title: document.getElementById('startup-error-title').textContent,
  detail: document.getElementById('startup-error-detail').textContent,
  buttons: Array.from(document.querySelectorAll('#startup-error-actions button')).map((b) => b.textContent),
  disabled: document.querySelectorAll('#startup-error-actions button:disabled').length,
  focused: document.activeElement ? document.activeElement.textContent : null
})`

/** The finished-step marker: its computed colours and its check geometry. */
const READ_DONE_MARKER = `(function () {
  const li = document.querySelector('#startup-steps li[data-state="done"]')
  if (li === null) return null
  // Transitions are paused while the window is OCCLUDED, and a paused
  // transition reads as its START value — which made this measurement report a
  // transparent disc in one run and green in the next. The colour wiring is
  // what matters here, not the animation, so it is switched off for the read.
  const mute = document.createElement('style')
  mute.textContent = '* { transition: none !important; }'
  document.head.append(mute)
  const circle = getComputedStyle(li, '::before')
  const check = getComputedStyle(li, '::after')
  const read = {
    bg: circle.backgroundColor,
    box: circle.width,
    content: check.content,
    w: check.width,
    h: check.height,
    ink: check.borderRightColor,
    rotated: check.transform !== 'none',
  }
  mute.remove()
  return read
})()`

async function main() {
  // The app binds this module to the MAIN window, which opens showing the
  // loading page (see window.ts). The probe does the same: it owns a window,
  // loads the page into it, binds the module, then shows it.
  const hosted = new BrowserWindow({
    // The window the app hosts the page in is the MAIN window: full size, no
    // system title bar (its native controls float over the page). A smaller or
    // framed fixture would break the page's own layout assertions below.
    width: 1180,
    height: 800,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#1a1a1a', height: 36 },
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  const loaded = hosted.loadFile(splashPage)
  splash.attachSplashToWindow(hosted)
  hosted.once('ready-to-show', () => hosted.show())
  await loaded
  await wait(1500)
  const win = hosted
  win.show()
  await wait(250)
  record('splash window exists', win !== undefined && !win.isDestroyed())
  record('splash is visible', win.isVisible())
  // Custom chrome: same posture as the main window (no system title bar, the
  // native controls float over the page). A framed splash would make the two
  // windows look like two different products — and the content/viewport delta
  // is how that is measurable without a screenshot.
  const bounds = win.getBounds()
  const content = win.getContentBounds()
  record('the splash has no system title bar',
    bounds.height - content.height <= 4 && bounds.width - content.width <= 4,
    `bounds=${JSON.stringify(bounds)} content=${JSON.stringify(content)}`)
  const drag = await win.webContents.executeJavaScript(`(function () {
    const bar = document.getElementById('startup-titlebar')
    if (bar === null) return null
    const style = getComputedStyle(bar)
    return { h: style.height, region: style.getPropertyValue('-webkit-app-region') }
  })()`)
  record('the page reserves a draggable strip under the window controls',
    drag !== null && drag.h === '36px' && drag.region === 'drag', JSON.stringify(drag))

  const sandbox = await win.webContents.executeJavaScript(
    "({ require: typeof require, process: typeof process, module: typeof module })",
  )
  record(
    'renderer has no node globals (sandbox + no preload)',
    sandbox.require === 'undefined' && sandbox.process === 'undefined' && sandbox.module === 'undefined',
    JSON.stringify(sandbox),
  )

  const refs = await win.webContents.executeJavaScript(
    'Array.from(document.querySelectorAll("script[src],link[href],img[src],iframe[src],source[src]")).map((el) => el.outerHTML)',
  )
  // The brand mark is inline SVG now, so the page references NOTHING: no remote
  // URL (a network dependency in a page that renders before anything else in
  // the app exists) and no file that could fail to ship beside it.
  record('page references no external resource at all', refs.length === 0, JSON.stringify(refs))

  // Injected state (this is what the page CSP could have blocked).
  splash.updateStartupWindow({ phase: 'extracting', message: '正在解压运行时…（3/10）', progress: 0.3 })
  await wait(250)
  const ui = await win.webContents.executeJavaScript(READ_UI)
  record('injected state reaches the DOM', ui.status === '正在解压运行时…（3/10）', ui.status)
  record('determinate bar renders at 30%', ui.width === '30%' && ui.mode === 'determinate', `${ui.mode}/${ui.width}`)
  record('step 2 current, step 1 done', ui.current === '解压运行时' && ui.done === 1, JSON.stringify({ current: ui.current, done: ui.done }))
  record('failure card hidden during progress', ui.errorHidden === true)
  // The fixed wish at the foot: pushed by the shell (the page's markup cannot
  // know the language). Compared against the shell's own table, so the check is
  // about the WIRING and not about which language this machine resolves to.
  const { t: shellT } = require(path.join(root, 'dist', 'shared', 'locale.js'))
  record('the foot line carries the pushed saying', ui.saying === shellT('splash.saying'), ui.saying)
  const doneMarker = await win.webContents.executeJavaScript(READ_DONE_MARKER)
  // Finished = the app success green with a WHITE check on top (2.2:1 — the
  // disc carries the state, the check confirms it; the product asked for white).
  record('a finished step is a green circle with a drawn check',
    doneMarker !== null
      && doneMarker.bg === 'rgb(34, 197, 94)'
      && doneMarker.box === '12px'
      && doneMarker.content !== 'none'
      && doneMarker.w === '3px' && doneMarker.h === '6px'
      && doneMarker.ink === 'rgb(255, 255, 255)'
      && doneMarker.rotated === true,
    JSON.stringify(doneMarker))
  record('brand row shows the product name', ui.name === 'DSH APP', ui.name)
  record('brand row shows the running version', /^v\d+\.\d+\.\d+/.test(ui.version), ui.version)
  record(
    'brand mark is a vector glyph sized by the page, not a bitmap',
    ui.mark.svg === true && ui.mark.box >= 44 && ui.mark.box <= 72,
    JSON.stringify(ui.mark),
  )
  // The page is not scrolled: the normal boot state has to fit the window it
  // is hosted in — the main window here (1180x800), and the splash-sized one
  // the failure card was drawn for. The failure card may scroll — its detail
  // line is arbitrary text — but this state must not.
  const layout = await win.webContents.executeJavaScript(
    '({ scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight })',
  )
  record('the boot state fits the window without scrolling', layout.scrollHeight <= layout.innerHeight,
    JSON.stringify(layout))
  // The shell resolves the appearance from the UI's own setting; recomputing it
  // here from the same two inputs is what makes this an assertion rather than a
  // restatement of what the page happened to paint.
  const theme = require(path.join(root, 'dist', 'main', 'theme.js'))
  const expected = theme.resolveThemeMode(
    theme.readThemePreference(path.join(require('node:os').homedir(), '.dsh', 'settings.yaml')),
    require('electron').nativeTheme.shouldUseDarkColors,
  )
  record('appearance follows the UI setting, not just the OS', ui.theme === expected, `${ui.theme} vs ${expected}`)
  // Both modes must be drivable from a push: the page owns the attribute, so a
  // future shell that ships another surface can reuse it.
  for (const mode of ['dark', 'light']) {
    await win.webContents.executeJavaScript(
      'window.__dshStartupUpdate({ stage: 2, message: "x", progress: null, brand: { name: "DSH APP", version: "9.9.9" }, theme: ' + JSON.stringify(mode) + ' })',
    )
    const forced = await win.webContents.executeJavaScript(READ_UI)
    record(`a push can force ${mode} mode`, forced.theme === mode && forced.version === 'v9.9.9', JSON.stringify({ theme: forced.theme, version: forced.version }))
    // The mark must look the SAME in both themes: the app-icon tile, not a
    // per-theme variant. A brand mark that changes shape between themes reads
    // as two different marks — reported by the user, and the reason this
    // assertion is symmetric.
    record(`the brand mark is the brand tile in ${mode} mode`,
      forced.mark.bg === 'rgb(76, 104, 252)' && forced.mark.ink === 'rgb(255, 255, 255)',
      JSON.stringify({ bg: forced.mark.bg, ink: forced.mark.ink }))
  }
  splash.updateStartupWindow({ phase: 'extracting', message: '正在解压运行时…（3/10）', progress: 0.3 })
  await wait(150)

  splash.updateStartupWindow({ phase: 'checking', message: '正在检查更新…', progress: null })
  await wait(200)
  const afterUnknown = await win.webContents.executeJavaScript(READ_UI)
  record(
    'unmapped message keeps the step and returns to indeterminate',
    afterUnknown.current === '解压运行时' && afterUnknown.mode === 'indeterminate',
    JSON.stringify({ current: afterUnknown.current, mode: afterUnknown.mode }),
  )

  splash.updateStartupWindow({ phase: 'error', message: '安装失败', error: '内置运行时完整性校验失败' })
  await wait(200)
  const afterError = await win.webContents.executeJavaScript(READ_UI)
  record('error keeps the step where the boot stopped', afterError.current === '解压运行时', String(afterError.current))
  record('error broadcasts a message line only', afterError.status === '安装失败', afterError.status)

  const pending = splash.showStartupFailure('安装失败', '内置运行时完整性校验失败（期望 abc，实际 def）')
  await wait(250)
  const card = await win.webContents.executeJavaScript(READ_UI)
  record('failure card visible with title and detail', card.errorHidden === false && card.title === '安装失败', card.title)
  record('detail rendered verbatim', card.detail.includes('期望 abc'), card.detail)
  record('three actions in order', JSON.stringify(card.buttons) === JSON.stringify(['重试', '打开日志目录', '退出']), JSON.stringify(card.buttons))
  record('primary action focused', card.focused === '重试', String(card.focused))

  await win.webContents.executeJavaScript('document.querySelectorAll("#startup-error-actions button")[1].click()')
  const choice = await pending
  record('click resolves the injected promise with the action id', choice === 'open-logs', String(choice))
  await wait(150)
  const afterClick = await win.webContents.executeJavaScript(READ_UI)
  record('actions disable after the answer', afterClick.disabled === 3, String(afterClick.disabled))

  splash.updateStartupWindow({ phase: 'starting', message: '正在启动 dsh 服务…', progress: null })
  await wait(200)
  const resumed = await win.webContents.executeJavaScript(READ_UI)
  record(
    'progress after a failure clears the card and moves to step 4',
    resumed.errorHidden === true && resumed.current === '启动内核服务',
    JSON.stringify({ hidden: resumed.errorHidden, current: resumed.current }),
  )

  // Hand-off: this module stops driving the page, and the window it was bound
  // to is the one that now shows the live UI — so it must survive.
  const idle = new BrowserWindow({ show: false })
  await idle.loadURL('about:blank')
  await wait(300)
  splash.handoffToMainWindow(win)
  await wait(250)
  record('the handed-off window survives hand-off', !win.isDestroyed())
  record('the unrelated window is left untouched', !idle.isDestroyed() && !idle.isVisible())
  splash.updateStartupWindow({ phase: 'installing', message: '正在激活运行时…', progress: null })
  await wait(200)
  const afterHandoff = await win.webContents.executeJavaScript(READ_UI)
  record(
    'this module stops driving the page after hand-off',
    afterHandoff.status !== '正在激活运行时…',
    String(afterHandoff.status),
  )
  win.destroy()
  await wait(200)

  // Cold-start race, on a fresh binding: a state pushed BEFORE the page can
  // render must be applied once it loads.
  const second = new BrowserWindow({
    width: 1180,
    height: 800,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#1a1a1a', height: 36 },
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  const reloading = second.loadFile(splashPage)
  splash.attachSplashToWindow(second)
  splash.updateStartupWindow({ phase: 'installing', message: '正在激活运行时…', progress: null })
  await reloading
  await wait(700)
  second.show()
  await wait(200)
  const early = await second.webContents.executeJavaScript(READ_UI)
  record(
    'a state pushed before the page loads is applied once it loads',
    early.status === '正在激活运行时…' && early.current === '激活运行时',
    JSON.stringify({ status: early.status, current: early.current }),
  )
  const real = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  real.once('ready-to-show', () => real.show())
  const loading = real.loadFile(splashPage)
  splash.handoffToMainWindow(real)
  await loading
  await wait(1200)
  record('the handed-off window stays up and shows the live UI', second !== undefined && !second.isDestroyed())
  record('real window is on screen', real.isVisible())

  const failed = lines.filter((line) => line.startsWith('FAIL'))
  record('all probe checks passed', failed.length === 0, `${lines.length - failed.length}/${lines.length}`)
  return failed.length === 0 ? 0 : 1
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await main()
  } catch (error) {
    record('probe crashed', false, error && error.stack ? error.stack : String(error))
  }
  fs.writeFileSync(path.join(__dirname, 'probe-startup-window.out.txt'), lines.join('\n') + '\n')
  app.exit(code)
})
