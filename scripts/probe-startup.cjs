// Render the real startup page at the window sizes and states users can reach.
// Usage: node_modules/.bin/electron scripts/probe-startup.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'scratch', 'startup-shots')
fs.mkdirSync(outDir, { recursive: true })
app.setPath('userData', path.join(app.getPath('temp'), `dsh-startup-probe-${process.pid}`))

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const write = (...parts) => fs.writeSync(1, `${parts.join(' ')}\n`)
const assert = (condition, message) => { if (!condition) throw new Error(message) }
async function themeReady(win, theme) {
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000
    const check = () => {
      if (document.documentElement.dataset.theme === '${theme}') { resolve(true); return }
      if (Date.now() > deadline) { reject(new Error('theme did not settle: ${theme}')); return }
      setTimeout(check, 25)
    }
    check()
  })`)
  await sleep(100)
}

const view = (over = {}) => `window.__dshStartupUpdate(${JSON.stringify({
  stage: 4,
  message: '正在启动 dsh 服务…',
  progress: 0.76,
  brand: { name: 'DSH APP', version: '0.17.7' },
  saying: '心里有数，就不必声张',
  theme: 'light',
  skeleton: {
    steps: ['准备运行时', '解压运行时', '激活运行时', '启动内核服务', '打开界面'],
    hint: '首次启动需要准备运行环境，可能需要几十秒。',
    failureHint: '若多次重试未果，可打开日志目录查看详细排障信息。',
    pause: '暂停下载', resume: '继续下载',
  },
  ...over,
})})`

const geometry = `(() => {
  const box = (selector) => {
    const element = document.querySelector(selector)
    const r = element.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  }
  const items = [...document.querySelectorAll('#startup-steps .step-item')].map((item) => ({
    state: item.dataset.state,
    text: item.textContent.trim(),
    rows: item.getClientRects().length,
    scrollWidth: item.scrollWidth,
    clientWidth: item.clientWidth,
    rect: (() => { const r = item.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })(),
  }))
  const canvas = document.querySelector('#whale-canvas')
  const context = canvas.getContext('2d')
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  let opaque = 0
  let alpha = 0
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] > 100) { opaque++; alpha += pixels[i] }
  }
  return {
    viewport: { width: innerWidth, height: innerHeight },
    page: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
    stage: box('.stage-monolith'), whale: box('.whale-stage-wrap'), status: box('#startup-status'),
    progress: box('.progress-section'), steps: box('#startup-steps'), footer: box('.footer-wrap'),
    items,
    stepRows: [...new Set(items.map(item => Math.round(item.rect.top)))].length,
    canvas: { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, opaque, meanAlpha: opaque ? alpha / opaque / 255 : 0 },
    theme: document.documentElement.dataset.theme,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    sheen: getComputedStyle(document.querySelector('#startup-bar-fill'), '::after').display,
    percent: document.querySelector('#startup-percent').textContent,
    progressNow: document.querySelector('#startup-bar').getAttribute('aria-valuenow'),
    stageAnimation: getComputedStyle(document.querySelector('.stage-monolith')).animationName,
    stepAnimation: (() => { const badge = document.querySelector('.step-item[data-state="current"] .step-badge'); return badge ? getComputedStyle(badge, '::after').animationName : 'none' })(),
    dpr: devicePixelRatio,
  }
})()`

async function capture(win, name) {
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG())
}

async function inspect(win, name, expectedRows) {
  const data = await win.webContents.executeJavaScript(geometry)
  write(name, JSON.stringify(data))
  assert(data.page.scrollWidth <= data.viewport.width, `${name}: horizontal overflow`)
  assert(data.page.scrollHeight <= data.viewport.height, `${name}: vertical overflow`)
  assert(data.stage.top >= 38, `${name}: content crosses native titlebar`)
  assert(data.stage.bottom <= data.viewport.height, `${name}: stage below viewport`)
  assert(data.status.bottom <= data.progress.top, `${name}: headline overlaps progress`)
  assert(data.progress.bottom <= data.steps.top, `${name}: progress overlaps steps`)
  assert(data.steps.bottom <= data.footer.top, `${name}: steps overlap footer`)
  assert(data.stepRows === expectedRows, `${name}: expected ${expectedRows} step rows, got ${data.stepRows}`)
  assert(data.canvas.width >= data.canvas.cssWidth, `${name}: DPR was degraded`)
  assert(data.canvas.opaque > 100, `${name}: whale has no visible pixels`)
  for (const item of data.items) {
    assert(item.rect.left >= 0 && item.rect.right <= data.viewport.width, `${name}: step ${item.text} is clipped`)
    assert(item.scrollWidth <= item.clientWidth + 1, `${name}: step ${item.text} text overflows`)
  }
  await capture(win, name)
  return data
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true,
    backgroundColor: '#f8fafc',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const errors = []
  win.webContents.on('console-message', (...args) => {
    const event = args[0]
    const level = typeof event === 'object' ? event.level : args[1]
    const message = typeof event === 'object' ? event.message : args[2]
    if (level === 'error' || level === 3) { errors.push(String(message)); write('renderer-error', message) }
  })
  try {
    await win.loadURL(pathToFileURL(path.join(root, 'dist', 'static', 'startup.html')).href)
    await win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }],
    })
    await sleep(700)
    await win.webContents.executeJavaScript(view({ stage: 1, progress: 0 }))
    await themeReady(win, 'light')
    const light = await inspect(win, '01-light-1440x900', 1)
    assert(light.reducedMotion && light.stageAnimation === 'none' && light.stepAnimation === 'none', 'reduced-motion still animates decorative UI')
    assert(light.dpr >= 1 && light.canvas.width >= light.canvas.cssWidth * light.dpr, 'canvas does not match device DPR')
    assert(Number(light.progressNow) < 25 && light.percent === `${light.progressNow}%`, 'stage 1 progress must stay inside its own band')
    await win.webContents.executeJavaScript(view({ stage: 2, progress: null }))
    await sleep(150)
    const mode = await win.webContents.executeJavaScript(`document.querySelector('#startup-bar').dataset.mode`)
    assert(mode === 'indeterminate', 'null progress must be indeterminate')
    await win.webContents.executeJavaScript(view({ stage: 4, progress: 0.76 }))
    await sleep(1200)
    assert(await win.webContents.executeJavaScript(`document.querySelector('#startup-percent').textContent === '90%'`), 'stage 4 at 76% must map to 90% of the total boot')

    await win.webContents.executeJavaScript(`document.querySelector('#startup-bar').dataset.mode = 'indeterminate'; window.__dshStartupUpdate({ stage: 4, message: 'normal motion', progress: null, brand: { name: 'DSH APP', version: '0.17.7' }, theme: 'light', saying: '' })`)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await sleep(150)
    const motion = await win.webContents.executeJavaScript(`({ sweep: getComputedStyle(document.querySelector('#startup-bar'), '::after').animationName, stage: getComputedStyle(document.querySelector('.stage-monolith')).animationName })`)
    assert(motion.sweep === 'railSweep' && motion.stage === 'stageFadeIn', 'normal motion did not enable the restrained entrance/sweep')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 2, mobile: false })
    await sleep(200)
    assert(await win.webContents.executeJavaScript(`document.querySelector('#whale-canvas').width === document.querySelector('#whale-canvas').clientWidth * 2`), 'DPR=2 canvas was not rendered at full resolution')
    await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride', {})
    await win.webContents.executeJavaScript(view({ stage: 4, progress: 0.76 }))
    await themeReady(win, 'light')

    for (let stage = 1; stage <= 5; stage += 1) {
      write('stage-check', stage)
      await win.webContents.executeJavaScript(view({ stage, progress: stage === 5 ? 1 : null }))
      await sleep(180)
      const states = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#startup-steps .step-item')].map(item => item.dataset.state)`)
      assert(states.length === 5 && states.every((state, index) => state === (stage === 5 || index + 1 < stage ? 'done' : index + 1 === stage ? 'current' : 'pending')), `stage ${stage} step states are wrong`)
    }
    await win.webContents.executeJavaScript(view({ stage: 4, progress: 0.76 }))
    await themeReady(win, 'light')

    await win.webContents.executeJavaScript(view({ theme: 'dark' }))
    await themeReady(win, 'dark')
    const dark = await inspect(win, '02-dark-1440x900', 1)
    assert(dark.theme === 'dark', 'dark theme not applied')
    assert(dark.sheen === 'none', 'determinate sheen should stay removed')

    await win.webContents.executeJavaScript(view({ theme: 'light' }))
    await themeReady(win, 'light')
    win.setContentSize(900, 600)
    await sleep(350)
    const small = await inspect(win, '03-light-900x600', 2)

    win.setContentSize(1440, 900)
    await win.webContents.executeJavaScript(view({
      skeleton: {
        steps: ['Prepare runtime', 'Extract runtime', 'Activate runtime', 'Start kernel service', 'Open interface'],
        hint: 'The first launch prepares the runtime and may take a few seconds.',
        failureHint: 'Open the log directory for troubleshooting.', pause: 'Pause download', resume: 'Resume download',
      },
    }))
    await sleep(250)
    await inspect(win, '04-english-1440x900', 1)

    win.setContentSize(900, 600)
    await sleep(250)
    await win.webContents.executeJavaScript(view({
      skeleton: {
        steps: ['Prepare runtime', 'Extract runtime', 'Activate runtime', 'Start kernel service', 'Open interface'],
        hint: 'The first launch prepares the runtime and may take a few seconds.',
        failureHint: 'Open the log directory for troubleshooting.', pause: 'Pause download', resume: 'Resume download',
      },
    }))
    await sleep(250)
    await inspect(win, '05-english-900x600', 2)

    await win.webContents.executeJavaScript(view({ pausable: true, paused: false }))
    await sleep(150)
    assert(await win.webContents.executeJavaScript(`!document.querySelector('#startup-pause').hidden`), 'pause is not visible')
    await win.webContents.executeJavaScript(`window.__pauseChoice = undefined; window.__dshStartupAwaitPause().then(value => { window.__pauseChoice = value }); document.querySelector('#startup-pause').click()`)
    await sleep(100)
    assert(await win.webContents.executeJavaScript('window.__pauseChoice === true'), 'pause action did not resolve true')
    await win.webContents.executeJavaScript(view({ pausable: true, paused: true }))
    await sleep(100)
    await capture(win, '06-paused-900x600')

    write('before failure')
    const failure = win.webContents.executeJavaScript(`window.__failureChoice = undefined; window.__dshStartupShowFailure({ title: '启动未完成', detail: '内核服务未能启动，请重试。', actions: [{ id: 'retry', label: '重试', primary: true }, { id: 'open-logs', label: '打开日志' }] }).then(id => { window.__failureChoice = id })`)
    failure.catch(() => {})
    write('after failure')
    await sleep(150)
    write('failure-focus', JSON.stringify(await win.webContents.executeJavaScript(`({ tag: document.activeElement && document.activeElement.tagName, id: document.activeElement && document.activeElement.id, hidden: document.querySelector('#startup-error').hidden, primary: document.querySelector('#startup-error button[data-primary="true"]') !== null })`)))
    assert(await win.webContents.executeJavaScript(`!document.querySelector('#startup-error').hidden && document.querySelector('#startup-error button[data-primary="true"]') !== null`), 'failure card or primary action missing')
    await capture(win, '07-failure-900x600')
    await win.webContents.executeJavaScript(`document.querySelector('#startup-error button[data-primary="true"]').click()`)
    await sleep(100)
    assert(await win.webContents.executeJavaScript(`window.__failureChoice === 'retry'`), 'failure retry did not resolve')
    await failure
    await win.webContents.executeJavaScript(view({ pausable: false, paused: false }))
    await sleep(100)
    assert(await win.webContents.executeJavaScript(`document.querySelector('#startup-error').hidden`), 'failure card did not close on next view')
    await win.webContents.executeJavaScript(view({ stage: 5, progress: 1 }))
    await sleep(250)
    assert(await win.webContents.executeJavaScript(`document.querySelector('#startup-percent').textContent === '100%' && [...document.querySelectorAll('#startup-steps .step-item')].every(item => item.dataset.state === 'done')`), 'completion does not reach 100% with all steps done')
    write('light-alpha-check', JSON.stringify({ meanAlpha: light.canvas.meanAlpha, smallMeanAlpha: small.canvas.meanAlpha }))
    assert(light.canvas.meanAlpha > 0.3 && small.canvas.meanAlpha > 0.3, 'light whale is too faint')
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
    write('PASS: startup geometry, themes, states, and recovery checks')
  } finally {
    await win.webContents.executeJavaScript('void 0').catch(() => {})
    win.destroy()
    app.exit(0)
  }
}).catch(error => {
  write('FAIL', error.stack || error.message)
  app.exit(1)
})
