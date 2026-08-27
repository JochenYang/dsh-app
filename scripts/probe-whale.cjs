// Probe: whale background v2 (static + hover diffusion) — canvas geometry,
// dark/light pixel contrast, interaction frames, and idle rAF stop.
// Usage: electron scripts/probe-whale.cjs <url>
// Captures into scratch/whale-shots/ and prints DOM diagnostics.
//
// The probe machine may run with OS-level "reduce animation" and any system
// color scheme, so both media features are forced via CDP emulation before
// load (the whale mounts with matchMedia reads + CSS media queries), and the
// theme passes flip the DOM exactly like ui-layout's ThemePresenter does:
// html { color-scheme } + body[data-ds-dark-theme] + the brand token set as
// inline custom properties on body.
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

// Unique per-run userData: a probe killed mid-run leaves a locked/dirty
// Chromium profile that can hang the next boot on the same directory.
app.setPath('userData', path.join(app.getPath('temp'), `dsh-probe-userdata-${process.pid}`))
const url = process.argv[2] || 'http://127.0.0.1:4788'
const outDir = path.resolve('scratch/whale-shots')
fs.mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Piped stdout is fully buffered until process exit — and exit itself can
// hang on an attached CDP session — so write straight to the fd and always
// end with app.exit().
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n')

// Brand token injection REMOVED (v2.1): the brand theme is registered but
// never activated (preference only accepts built-in light/dark/system), so
// forcing those tokens measured a palette users never see. The probe now
// measures the REAL upstream palettes: CDP forces prefers-color-scheme at
// load (boot-theme sets the body attribute), and passes below only flip
// the DOM attribute for the second theme pass.

// Page-side diagnostic: whale canvas geometry + alpha-channel pixel stats
// (visibility evidence for the light-theme contrast fix).
const DIAG_JS = `(() => {
  const canvas = document.querySelector('#dshapp-whale-bg')
  const seat = document.querySelector('textarea[class*="_input"]')
  const phase = document.querySelector("[data-phase='hero'], [data-phase='active'], [data-phase='settling']")
  if (canvas === null) return JSON.stringify({ canvas: false })
  const rect = canvas.getBoundingClientRect()
  const g = canvas.getContext('2d')
  const { width, height, data } = g.getImageData(0, 0, canvas.width, canvas.height)
  let n = 0, aSum = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 8) { n++; aSum += data[i] }
  }
  const seatRect = seat ? seat.getBoundingClientRect() : null
  return JSON.stringify({
    canvas: true,
    cssSize: Math.round(rect.width) + 'x' + Math.round(rect.height),
    center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
    bottom: Math.round(rect.bottom),
    opacity: getComputedStyle(canvas).opacity,
    darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
    bgToken: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
    phase: phase ? phase.getAttribute('data-phase') : null,
    seat: seatRect ? { top: Math.round(seatRect.top), left: Math.round(seatRect.left), w: Math.round(seatRect.width) } : null,
    whale: { opaquePx: n, coverage: +(n / (width * height)).toFixed(3), meanAlpha: n ? +(aSum / n / 255).toFixed(3) : 0 },
    debug: window.__dshappWhale ? { frames: window.__dshappWhale.frames, interacting: window.__dshappWhale.interacting, running: window.__dshappWhale.running } : null,
  })
})()`

// Flip the DOM palette attribute ThemePresenter-style (no token injection —
// the upstream stylesheet's own light/dark alias values take over).
const themeFlip = (mode) => `(() => {
  document.documentElement.style.colorScheme = '${mode}'
  document.body.${mode === 'dark' ? "setAttribute('data-ds-dark-theme', '')" : "removeAttribute('data-ds-dark-theme')"}
  return 'ok'
})()`

app.whenReady().then(async () => {
  log('ready')
  // Visible window: a hidden window's rAF is throttled by Windows occlusion
  // detection, which freezes the whale's fade-in, phase transitions, hover
  // interaction, AND the idle rAF-stop — every probe signal at once.
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  })
  await win.loadURL(url)
  log('loaded')
  // Shield the probe from the operator's real pointer: genuine mousemove
  // streams (and clicks — one flipped the page to the active phase mid-run)
  // pollute the interaction/idle signals. Synthetic DOM events still work.
  win.setIgnoreMouseEvents(true)
  // Force the OPERATOR-LIKE media environment AFTER load (sendCommand hangs
  // against the pre-load empty frame): reduced-motion ON — exactly the
  // machine this build must work on — to prove the pointer scatter is no
  // longer gated by the accessibility flag.
  await win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-color-scheme', value: 'dark' },
    ],
  })
  log('media forced (reduce)')
  // Plugin load + 0.6s fade-in + a couple of 250ms polls.
  await sleep(2500)

  const readDiag = async () => JSON.parse(await win.webContents.executeJavaScript(DIAG_JS))
  const shot = async (name) => {
    const image = await win.webContents.capturePage()
    const file = path.join(outDir, `${name}.png`)
    fs.writeFileSync(file, image.toPNG())
    log('captured', file)
  }
  // Drive the whale via synthetic DOM mousemove events: the probe window is
  // visible (rAF must run), so the operator's real pointer would otherwise
  // inject genuine mousemove streams and pollute every signal.
  const moveTo = (x, y) =>
    win.webContents.executeJavaScript(
      `window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y} }))`,
    )
  const sweep = async (cx, cy) => {
    for (let i = -3; i <= 3; i++) {
      await moveTo(cx + i * 30, cy)
      await sleep(80)
    }
  }

  // ---- dark pass ----------------------------------------------------------
  await win.webContents.executeJavaScript(themeFlip('dark'))
  await sleep(800)
  const dark = await readDiag()
  log('[dark-hero]', JSON.stringify(dark))
  await shot('1-dark-hero')

  if (dark.canvas && dark.debug !== null) {
    // Interaction: hover the whale center, hold, sweep across it.
    await moveTo(dark.center.x, dark.center.y)
    await sleep(250)
    await sweep(dark.center.x, dark.center.y)
    const hot = await readDiag()
    log('[dark-pointer]', JSON.stringify({ debug: hot.debug }))
    await shot('2-dark-hero-pointer')

    // Peak-state hold: park the pointer at the whale center long enough for
    // the push strength to converge, then capture for ring analysis.
    await moveTo(dark.center.x, dark.center.y)
    await sleep(600)
    const held = await readDiag()
    log('[dark-center-hold]', JSON.stringify({ debug: held.debug }))
    await shot('2b-dark-center-hold')

    // Idle stop: pointer far away → decay → the rAF loop must park.
    await moveTo(40, 820)
    await sleep(2200)
    const parked1 = await readDiag()
    await sleep(700)
    const parked2 = await readDiag()
    log('[idle-stop]', JSON.stringify({
      framesStable: parked1.debug.frames === parked2.debug.frames,
      running: parked2.debug.running,
      frames: parked2.debug.frames,
    }))

    // Active phase: flip the conversation root's data-phase and verify the
    // whale re-centers on the conversation column (not the viewport).
    await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector("[data-phase='hero'], [data-phase='settling']")
      if (root) root.setAttribute('data-phase', 'active')
      const col = document.querySelector('[class*="_centerCol"]')
      const r = col ? col.getBoundingClientRect() : null
      return JSON.stringify({
        flipped: !!root,
        colCenter: r ? Math.round(r.left + r.width / 2) : null,
        vw: innerWidth,
      })
    })()`)
    await sleep(900) // > one poll tick + the 0.45s placement transition
    const activeDiag = await win.webContents.executeJavaScript(`(() => {
      const c = document.getElementById('dshapp-whale-bg')
      const r = c.getBoundingClientRect()
      const col = document.querySelector('[class*="_centerCol"]')
      const cr = col.getBoundingClientRect()
      return JSON.stringify({
        whaleCenter: Math.round(r.left + r.width / 2),
        colCenter: Math.round(cr.left + cr.width / 2),
        viewportCenter: Math.round(innerWidth / 2),
      })
    })()`)
    log('[dark-active]', activeDiag)
    await shot('2c-dark-active')
  }

  // ---- light pass ----------------------------------------------------------
  await moveTo(40, 820)
  await win.webContents.executeJavaScript(themeFlip('light'))
  await sleep(1200) // > one 250ms poll so the palette rebuilds
  const light = await readDiag()
  log('[light-hero]', JSON.stringify(light))
  await shot('3-light-hero')

  if (light.canvas && light.debug !== null) {
    await moveTo(light.center.x, light.center.y)
    await sleep(250)
    await sweep(light.center.x, light.center.y)
    await shot('4-light-hero-pointer')
  }

  win.webContents.debugger.detach()
  app.exit(0)
}).catch((err) => {
  fs.writeSync(2, 'probe failed: ' + (err && err.stack ? err.stack : String(err)) + '\n')
  app.exit(1)
})
