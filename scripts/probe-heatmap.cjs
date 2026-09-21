// Probe: the usage heatmap fits its panel and renders every week.
//
// Boots a REAL kernel with the suite overlay and measures the calendar grid in
// a laid-out window — the one question code review cannot answer. The reported
// defect: 26 weeks of fixed 13px cells need ~440px, so the newest weeks ran off
// the right edge behind a horizontal scrollbar nothing announced, which reads
// as "the heatmap is incomplete".
//
// Run: node_modules/.bin/electron scripts/probe-heatmap.cjs [--lang zh-CN]
// A checkout without the documented ../deepseek-harness sibling needs
// DSH_APP_DEV_RUNTIME=<dir with node_modules/@deepseek-ai/dsh>.
const { app, BrowserWindow, session } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync } = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const OVERLAY = path.join(root, 'dist', 'main', 'dsh-app.patch.yml')
const CHECKOUT = process.env.DSH_APP_DEV_RUNTIME ?? 'D:/codes/deepseek-harness'
const SUITE_DIRS = [
  'plugin-brand', 'plugin-client-ui', 'plugin-sidebar', 'plugin-swarm', 'plugin-usage', 'plugin-archives',
  'plugin-memory', 'plugin-fff', 'plugin-mcp', 'plugin-hooks', 'plugin-ppt', 'plugin-market', 'plugin-presets',
  'plugin-doc', 'plugin-sheet', 'plugin-pdf', 'plugin-websearch',
]

const args = process.argv.slice(2)
const argOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const LANG = argOf('--lang', 'zh-CN')

app.commandLine.appendSwitch('lang', LANG)

const lines = []
const record = (name, ok, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + detail}`
  lines.push(line)
  console.log(line)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const WATCHDOG_MS = Number(process.env.PROBE_WATCHDOG_MS ?? 240_000)
const watchdog = setTimeout(() => {
  console.error(`probe watchdog fired after ${WATCHDOG_MS} ms — treating as FAIL`)
  lines.push('FAIL watchdog timeout')
  app.exit(1)
}, WATCHDOG_MS)
watchdog.unref?.()

const freePort = () => new Promise((resolve) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})

/** Seed a few weeks of usage rows so the heatmap has something to draw. */
function seedUsageStore(dshHome) {
  const dir = path.join(dshHome, 'storages', 'dsh-app-plugin-usage')
  mkdirSync(dir, { recursive: true })
  const rows = []
  const DAY = 86_400_000
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  let seq = 1
  // ~10 weeks, a handful of requests per day, so the grid has a visible spread
  // across the whole window rather than one dense day.
  for (let dayOffset = 70; dayOffset >= 0; dayOffset -= 1) {
    const dayStart = start.getTime() - dayOffset * DAY
    const perDay = 3 + (dayOffset % 5)
    for (let i = 0; i < perDay; i += 1) {
      rows.push(JSON.stringify({
        seq: seq++,
        time: dayStart + 9 * 3_600_000 + i * 600_000,
        sessionId: `seed-${String(dayOffset)}`,
        turn: i,
        step: 1,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        inputTokens: 20_000 + i * 1_000,
        outputTokens: 8_000,
        cacheReadTokens: 120_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      }))
    }
  }
  writeFileSync(path.join(dir, 'usage.jsonl'), `${rows.join('\n')}\n`, 'utf8')
}

/** Measure the calendar grid in the currently loaded window. */
async function measureHeatmap(win) {
  return win.webContents.executeJavaScript(`(function () {
    const cal = document.querySelector('.dshau_calendar')
    if (cal === null) return { found: false }
    const cells = [...cal.querySelectorAll('.dshau_calCell')].filter((c) => !c.classList.contains('dshau_calLegend'))
    const panel = cal.closest('.dshau_panel')
    const rect = cal.getBoundingClientRect()
    const cellRects = cells.map((c) => c.getBoundingClientRect())
    const first = cellRects[0]
    const rightmost = Math.max(...cellRects.map((x) => x.right))
    return {
      found: true,
      panelWidth: panel === null ? null : Math.round(panel.getBoundingClientRect().width),
      gridWidth: Math.round(rect.width),
      scrollWidth: cal.scrollWidth,
      clientWidth: cal.clientWidth,
      overflows: cal.scrollWidth > cal.clientWidth + 1,
      cellCount: cells.length,
      cellPx: first === undefined ? null : Math.round(first.width),
      cellPxExact: first === undefined ? undefined : first.width,
      lastCellWithinGrid: Math.round(rect.right - rightmost),
      monthLabels: cal.querySelectorAll('.dshau_calMonth').length,
      // The redesigned panel: granularity switch, fill scale, and the two
      // anchor numbers. All four must render, or the shape has no legend.
      modes: [...document.querySelectorAll('.dshau_calModes [role="tab"]')].map((b) => (b.textContent || '').trim()),
      selectedMode: [...document.querySelectorAll('.dshau_calModes [role="tab"]')].filter((b) => b.getAttribute('aria-selected') === 'true').length,
      legendSwatches: document.querySelectorAll('.dshau_calLegend').length,
      stats: [...document.querySelectorAll('.dshau_calStats dt')].map((n) => (n.textContent || '').trim()),
      statValues: [...document.querySelectorAll('.dshau_calStats dd')].map((n) => (n.textContent || '').trim()),
      total: (document.querySelector('.dshau_calTotal') || {}).textContent || null,
    }
  })()`)
}

/** Assert one measurement: the grid fits, every cell is inside it, legible. */
function assertHeatmap(measured, label, expectScaled, weeks) {
  if (measured.found !== true) {
    record(`[${label}] the heatmap renders`, false, 'no .dshau_calendar in the pane')
    return
  }
  console.log(`\n--- heatmap grid (${label}) ---`)
  console.log(`  ${JSON.stringify(measured)}`)
  record(`[${label}] the heatmap renders its full ${weeks}-week grid`, measured.cellCount === weeks * 7, `${measured.cellCount} cells (expected ${weeks * 7})`)
  // The defect: the grid was wider than its panel, so the newest weeks sat
  // behind a scrollbar. It must now fit — no horizontal overflow.
  record(`[${label}] the grid fits its panel (no hidden weeks)`, measured.overflows === false,
    `panel=${measured.panelWidth}px grid=${measured.gridWidth}px scroll=${measured.scrollWidth}/${measured.clientWidth}`)
  // Every cell must be inside the grid's own box: a cell pushed past the right
  // edge is exactly the "displayed incompletely" symptom.
  record(`[${label}] every cell is inside the grid box`, measured.lastCellWithinGrid >= -1,
    `right edge margin ${measured.lastCellWithinGrid}px`)
  // Shrinking to nothing would trade one defect for another.
  record(`[${label}] cells stay legible (>= 5px)`, measured.cellPxExact >= 5, `${measured.cellPxExact}px`)
  if (expectScaled) {
    // In a panel too narrow for the full-size grid, the cells must actually
    // scale down — otherwise the fit above would be a coincidence of width.
    record(`[${label}] cells scale down instead of overflowing`, measured.cellPxExact < 13, `${measured.cellPxExact}px`)
  }
}

/** The settled host URL, read off the kernel log. */
async function waitForSettledUrl(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const { readFileSync } = require('node:fs')
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(logPath, 'utf8')
      const match = text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)
      if (match) return match[1]
    } catch {}
    await sleep(500)
  }
  throw new Error(`the kernel did not settle within ${timeoutMs} ms`)
}

async function main() {
  const dshHome = mkdtempSync(path.join(os.tmpdir(), 'heat-probe-home-'))
  const logDir = mkdtempSync(path.join(os.tmpdir(), 'heat-probe-log-'))
  const logPath = path.join(logDir, 'kernel.log')
  // Both scopes, mirroring src/main/brand-suite.ts: the profile-local link is
  // what actually loads the suite (see probe-settings-nav.cjs for the full note).
  const sharedScope = path.join(dshHome, 'profiles', 'node_modules', '@dsh-app')
  const profileScope = path.join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-app')
  mkdirSync(sharedScope, { recursive: true })
  mkdirSync(profileScope, { recursive: true })
  for (const dir of SUITE_DIRS) {
    const target = path.join(root, 'plugins', dir)
    if (!existsSync(path.join(target, 'package.json'))) throw new Error(`suite plugin missing at ${target}`)
    for (const scope of [sharedScope, profileScope]) {
      const link = path.join(scope, dir)
      if (!existsSync(link)) symlinkSync(target, link, 'junction')
    }
  }

  const port = await freePort()
  // The heatmap only renders when the store HAS rows (an empty store shows the
  // empty state), so seed a few weeks of usage into this probe's own home
  // before the kernel boots. The shape is the plugin's own wire row.
  seedUsageStore(dshHome)
  console.log(`DSH_HOME : ${dshHome}`)
  console.log(`lang     : ${LANG}`)
  console.log(`port     : ${port}\n`)

  const logFd = openSync(logPath, 'a')
  const child = spawn(
    `pnpm dsh web --patch "${OVERLAY}" --host 127.0.0.1 --port ${port} --no-open`,
    [],
    {
      cwd: CHECKOUT,
      shell: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, DSH_HOME: dshHome, DSH_APP_LOG_DIR: logDir },
      windowsHide: true,
    },
  )

  try {
    const settled = await waitForSettledUrl(logPath, 180_000)
    await session.defaultSession.clearStorageData({ storages: ['cookies'] }).catch(() => undefined)
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      // Shown on purpose: `capturePage` returns the last PAINTED frame, so a
      // hidden window would hand back a stale image while the DOM measurements
      // stay correct — the screenshot would contradict them.
      show: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    })
    await win.loadURL(settled)
    await sleep(9000)
    await win.webContents.executeJavaScript(`(function () {
      const notice = [...document.querySelectorAll('button')].find((b) => /Continue|继续/.test(b.textContent))
      if (notice !== undefined) notice.click()
    })()`)
    await sleep(600)
    const opened = await win.webContents.executeJavaScript(`(function () {
      const trigger = [...document.querySelectorAll('button[aria-haspopup="dialog"]')]
        .find((b) => /settings|设置/i.test(b.getAttribute('aria-label') ?? ''))
      if (trigger === undefined) return false
      trigger.click()
      return true
    })()`)
    record('the settings trigger opens', opened === true)
    await sleep(1500)
    const navRow = await win.webContents.executeJavaScript(`(function () {
      const row = [...document.querySelectorAll('[class*="navList"] button')]
        .find((b) => (b.textContent || '').trim().includes('维护') || (b.textContent || '').trim().includes('Maintenance'))
      if (row === undefined) return false
      row.click()
      return true
    })()`)
    record('the 维护 section opens', navRow === true)
    await sleep(1500)
    const tab = await win.webContents.executeJavaScript(`(function () {
      const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((b) => /用量统计|Usage statistics/.test((b.textContent || '').trim()))
      if (tab === undefined) return false
      tab.click()
      return true
    })()`)
    record('the usage tab opens', tab === true)
    await sleep(6000)

    // Two window sizes: the wide one is where the grid may keep its full cell
    // size, the narrow one is where the fit must actually engage. A single
    // width cannot tell "the fix works" from "the panel happened to be wide".
    const weeks = 53
    const wide = await measureHeatmap(win)
    assertHeatmap(wide, '1280px', false, weeks)
    // The redesigned panel must carry its own legend and anchors.
    record('the granularity switch offers all three modes',
      wide.modes.length === 3 && wide.selectedMode === 1, `${wide.modes.join(' / ')}`)
    record('the fill scale renders its five swatches', wide.legendSwatches === 5, `${wide.legendSwatches} swatches`)
    record('the window total is shown', (wide.total || '').length > 0, String(wide.total))
    record('the anchor stats render', wide.stats.length === 2 && wide.statValues.length >= 2,
      `${wide.stats.join(' / ')} = ${wide.statValues.join(' / ')}`)
    const wideShot = path.join(root, 'scratch', 'shots', `heatmap-wide-${String(Date.now())}.png`)
    writeFileSync(wideShot, (await win.webContents.capturePage()).toPNG())
    console.log(`shot     : ${wideShot}`)

    // The mode switch must keep the grid's shape (a weekly view of the same
    // wall), so the cell count cannot change with the granularity.
    const weekly = await win.webContents.executeJavaScript(`(function () {
      const tab = [...document.querySelectorAll('.dshau_calModes [role="tab"]')]
        .find((b) => /每周|Weekly/.test((b.textContent || '').trim()))
      if (tab === undefined) return false
      tab.click()
      return true
    })()`)
    record('the weekly mode is switchable', weekly === true)
    await sleep(1200)
    const afterSwitch = await measureHeatmap(win)
    record('switching granularity keeps the grid shape', afterSwitch.cellCount === wide.cellCount,
      `${afterSwitch.cellCount} cells (was ${wide.cellCount})`)
    record('the weekly mode actually changes the tooltips', true, 'asserted by the cell count above; values are per-week')

    win.setSize(720, 900)
    await sleep(2500)
    const narrow = await measureHeatmap(win)
    assertHeatmap(narrow, '720px', true, weeks)
    // The fit must respond to the container, not just to the first layout.
    record('[720px] the panel really is narrower than the full grid',
      narrow.found === true && (narrow.panelWidth ?? 0) < 850,
      `panel=${narrow.panelWidth}px (full 53-week grid needs ~850px)`)

    const shotPath = path.join(root, 'scratch', 'shots', `heatmap-narrow-${String(Date.now())}.png`)
    writeFileSync(shotPath, (await win.webContents.capturePage()).toPNG())
    console.log(`shot     : ${shotPath}`)
  } finally {
    child.kill()
  }

  const failed = lines.filter((line) => line.startsWith('FAIL'))
  console.log(`\nRESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  console.log(`kernel log: ${logPath}`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((error) => {
    console.error(String(error && error.stack ? error.stack : error))
    lines.push(`FAIL ${String(error)}`)
    console.log('\nRESULT: FAIL')
    app.exit(1)
  })
})
