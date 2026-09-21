// Runtime probe for the settings panel (scratch only, gitignored).
//
// Boots a REAL kernel with the suite overlay, opens the dsh UI in Electron with
// the app's own window posture (sandbox, no preload) and measures what only a
// laid-out page can answer:
//   - the nav rail's overflow state (is the list scrollable, or clipped?),
//   - every nav row: label, on-screen box, whether the row carries an icon,
//   - the merged 维护 row: one rail row, three tabs in order, one visible panel,
//     and a visited tab that stays mounted when another one shows,
//   - the ACTIVE section pane's untranslated copy in English mode.
// The last one is the automated half of "这个页面的 i18n 不完整": it lists every
// string the pane renders that still contains Han characters — walking the
// merged section's tabs, so its second and third pages are covered too.
//
// Run: node_modules/.bin/electron scripts/probe-settings-nav.cjs [--lang en-US|zh-CN] [--section <label substring>]
// A checkout without the documented ../deepseek-harness sibling needs a kernel
// launcher instead: DSH_APP_DEV_RUNTIME=<dir containing node_modules/@deepseek-ai/dsh>
// (see scratch/dsh-kernel-stub/package.json for the shape of one).
const { app, BrowserWindow, session } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync } = require('node:fs')
const fs = require('node:fs')
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
const LANG = argOf('--lang', 'en-US')
const SECTION = argOf('--section', null)
/** `--sweep`: walk every section and count the copy still in Chinese. */
const SWEEP = args.includes('--sweep')
const SHOTS = path.join(root, 'scratch', 'shots')

// The renderer's navigator.language decides the UI locale when no preference
// is stored, so the switch has to be in place before the app is ready.
app.commandLine.appendSwitch('lang', LANG)

const lines = []
const record = (name, ok, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + detail}`
  lines.push(line)
  console.log(line)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Hard stop: a probe that hung must exit with a verdict, not sit forever. */
const WATCHDOG_MS = Number(process.env.PROBE_WATCHDOG_MS ?? 240_000)
const watchdog = setTimeout(() => {
  console.error(`probe watchdog fired after ${WATCHDOG_MS} ms — treating as FAIL`)
  lines.push('FAIL watchdog timeout')
  app.exit(1)
}, WATCHDOG_MS)
watchdog.unref?.()


const NAV_REPORT = `(function () {
  const navList = document.querySelector('[class*="navList"]')
  if (navList === null) return { error: 'no navList' }
  const panel = navList.closest('[role="dialog"]') ?? document.querySelector('[role="dialog"]')
  const rows = [...navList.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect()
    const svg = b.querySelector('svg')
    return {
      label: b.textContent.trim(),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      patched: /dsh[A-Za-z]+-?[Nn]av|dshAsb|dshWs|dshMcp|dshMem|dshSwm|dshPre|dshUsg|dshArc|dshAma|dshMkt|dshDiag/.test(b.className),
      hasIcon: svg !== null,
    }
  })
  const before = navList.scrollTop
  navList.scrollTop = 99999
  const scrolled = navList.scrollTop
  navList.scrollTop = before
  const r = navList.getBoundingClientRect()
  return {
    panel: panel === null ? null : (() => { const p = panel.getBoundingClientRect(); return { top: Math.round(p.top), bottom: Math.round(p.bottom), height: Math.round(p.height) } })(),
    navList: { top: Math.round(r.top), bottom: Math.round(r.bottom), clientHeight: navList.clientHeight, scrollHeight: navList.scrollHeight, overflowY: getComputedStyle(navList).overflowY, canScroll: scrolled > 0 },
    rows,
  }
})()`

const HAN_REPORT = `(function () {
  const pane = document.querySelector('[class*="options"]')
  if (pane === null) return { error: 'no options pane' }
  const seen = new Set()
  const han = /[\\u4e00-\\u9fff]/
  for (const node of pane.querySelectorAll('*')) {
    if (node.children.length > 0) continue
    const text = (node.textContent || '').trim()
    if (text !== '' && han.test(text)) seen.add(text)
  }
  for (const el of pane.querySelectorAll('input, textarea, select, option')) {
    const text = (el.value || el.textContent || '').trim()
    if (text !== '' && han.test(text)) seen.add(text)
  }
  return { strings: [...seen] }
})()`

const CLICK_ROW = (needle) => `(function () {
  const row = [...document.querySelectorAll('[class*="navList"] button')]
    .find((b) => b.textContent.includes(${JSON.stringify(needle)}))
  if (row === undefined) return false
  row.click()
  return true
})()`

// --- The merged 维护 section. Three plugins used to register three rail rows
// (用量统计 16, 预设包 21, 诊断 22); they are now three TABS of one row, so the
// expectations below are the merge's contract: one row, no retired rows, one
// glyph, three tabs in order, and a visited tab that stays mounted.
/** The merged row's label, either locale. */
const MERGED_ROW = /^(?:Maintenance|维护)$/
/** The rail labels the merge retired (each is a tab inside 维护 now). */
const RETIRED_ROWS = new Set(['Usage statistics', '用量统计', 'Presets', '预设包', 'Diagnostics', '诊断'])
/** The tab labels of 维护, in order, either locale. */
const TAB_LABELS = [/^(?:Usage statistics|用量统计)$/u, /^(?:Presets|预设包)$/u, /^(?:Diagnostics|诊断)$/u]
/** The tab strip of the ACTIVE pane — the merged section's own, not a page's inner one. */
const MERGED_TABS = `(function () {
  const pane = document.querySelector('[class*="options"]')
  const strip = (pane ?? document).querySelector('[role="tablist"]')
  if (strip === null) return 0
  if (!/Maintenance views|维护视图/.test(strip.getAttribute('aria-label') ?? '')) return 0
  return strip.querySelectorAll('[role="tab"]').length
})()`

const CLICK_MERGED = `(function () {
  const row = [...document.querySelectorAll('[class*="navList"] button')]
    .find((b) => /${MERGED_ROW.source}/u.test(b.textContent.trim()))
  if (row === undefined) return false
  row.click()
  return true
})()`

const CLICK_TAB = (index) => `(function () {
  const pane = document.querySelector('[class*="options"]')
  const strip = (pane ?? document).querySelector('[role="tablist"]')
  if (strip === null) return false
  const tab = [...strip.querySelectorAll('[role="tab"]')][${String(index)}]
  if (tab === undefined) return false
  tab.click()
  return true
})()`

/** The strip's state: labels, selection, roving tabindex, and the mounted panels. */
const TABS_REPORT = `(function () {
  const pane = document.querySelector('[class*="options"]')
  const area = pane ?? document
  const strip = area.querySelector('[role="tablist"]')
  if (strip === null) return { error: 'no tablist' }
  return {
    aria: strip.getAttribute('aria-label'),
    tabs: [...strip.querySelectorAll('[role="tab"]')].map((tab) => ({
      id: tab.id,
      text: tab.textContent.trim(),
      selected: tab.getAttribute('aria-selected') === 'true',
      controls: tab.getAttribute('aria-controls'),
      tabIndex: tab.tabIndex,
    })),
    panels: [...area.querySelectorAll('[role="tabpanel"]')].map((panel) => ({
      id: panel.id,
      labelledBy: panel.getAttribute('aria-labelledby'),
      hidden: panel.hasAttribute('hidden'),
      rendered: panel.querySelector('section') !== null,
    })),
  }
})()`

/**
 * The Han copy of the ACTIVE pane, walking every tab of the merged section when
 * that is what is open — its three pages are tabs now, so a single read would
 * only ever see the first one. Leaves the pane on its LAST tab (诊断), which is
 * where the diagnostics sub-check below expects to find its button.
 * @param page - the probe window.
 * @returns the distinct strings and whether a pane was found at all.
 */
async function paneHanCopy(page) {
  const tabs = await page.webContents.executeJavaScript(MERGED_TABS)
  const strings = new Set()
  let missing = false
  const count = tabs > 0 ? tabs : 1
  for (let index = 0; index < count; index += 1) {
    if (tabs > 0) {
      await page.webContents.executeJavaScript(CLICK_TAB(index))
      await sleep(900)
    }
    const report = await page.webContents.executeJavaScript(HAN_REPORT)
    if (report.error !== undefined) {
      missing = true
      continue
    }
    for (const text of report.strings ?? []) strings.add(text)
  }
  return { missing, strings: [...strings] }
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

/** Await a promise that has no timeout of its own. */
function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => { setTimeout(() => { reject(new Error(`timed out waiting for ${label}`)) }, timeoutMs) }),
  ])
}

async function waitFor(page, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await page.webContents.executeJavaScript(expression).catch(() => false)
    if (ok === true) return true
    await sleep(400)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Poll a status line the renderer owns, so a slow first paint is not a failure. */
async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true })
  const image = await page.webContents.capturePage()
  const file = path.join(SHOTS, `${name}-${Date.now()}.png`)
  await fs.promises.writeFile(file, image.toPNG())
  console.log(`shot     : ${file}`)
}

async function main() {
  const dshHome = mkdtempSync(path.join(os.tmpdir(), 'dsh-nav-probe-home-'))
  const logDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-nav-probe-log-'))
  const logPath = path.join(logDir, 'kernel.log')
  // The suite plugins are linked into BOTH scopes, mirroring the product's own
  // src/main/brand-suite.ts. The profile-local one is what actually loads them:
  // the kernel's profile resolver collects candidates from the booted profile's
  // node_modules walk and stops at the shared fallback position, which is
  // resolved only through the installation closure — a suite package is in
  // neither, so the shared link alone leaves all seventeen entries failing with
  // "Cannot find package '@dsh-app/plugin-*' imported from <home>/profiles/web/".
  const sharedScope = path.join(dshHome, 'profiles', 'node_modules', '@dsh-app')
  // `dsh web` boots the profile named after the command; the probe pre-creates
  // its scope dir so the links are in place before the kernel reads the tree.
  const profileScope = path.join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-app')
  mkdirSync(sharedScope, { recursive: true })
  mkdirSync(profileScope, { recursive: true })
  for (const dir of SUITE_DIRS) {
    const target = path.join(root, 'plugins', dir)
    if (!existsSync(path.join(target, 'package.json'))) throw new Error(`suite plugin missing at ${target}`)
    for (const scope of [sharedScope, profileScope]) {
      const link = path.join(scope, dir)
      // Re-running against a home the kernel already materialized must not throw.
      if (!existsSync(link)) symlinkSync(target, link, 'junction')
    }
  }

  const port = await freePort()
  console.log(`checkout : ${CHECKOUT}`)
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
      // Electron has no console of its own, so a console child spawned without
      // this gets a NEW console window on the user's desktop.
      windowsHide: true,
    },
  )

  try {
    const settled = await waitForSettledUrl(logPath, 180_000)
    console.log(`settled  : ${settled}\n`)

    await session.defaultSession.clearStorageData({ storages: ['cookies'] }).catch(() => undefined)
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    })
    await withTimeout(win.loadURL(settled), 60_000, 'the page load')
    // A fresh home shows the upstream first-run notice; it covers the center of
    // the window and swallows clicks, so dismiss it before driving the UI.
    await waitFor(win, `document.querySelector('button[aria-haspopup="dialog"]') !== null`, 60_000, 'the settings trigger')
    await win.webContents.executeJavaScript(`(function () {
      const notice = [...document.querySelectorAll('button')].find((b) => /Continue|继续/.test(b.textContent))
      if (notice !== undefined) notice.click()
      return notice !== undefined
    })()`)
    await sleep(600)
    // Two buttons carry aria-haspopup="dialog": the market's sidebar footer
    // action and the settings trigger. The settings one is the only one whose
    // aria-label is the settings copy (upstream sets it from `t('trigger')`).
    const opened = await win.webContents.executeJavaScript(`(function () {
      const trigger = [...document.querySelectorAll('button[aria-haspopup="dialog"]')]
        .find((b) => /settings|设置/i.test(b.getAttribute('aria-label') ?? ''))
      if (trigger === undefined) return false
      trigger.click()
      return true
    })()`)
    record('the settings trigger is findable by its label', opened === true)
    const navReady = await waitFor(win, `document.querySelector('[class*="navList"]') !== null`, 20_000, 'the settings nav').then(() => true).catch(() => false)
    if (!navReady) {
      const dump = await win.webContents.executeJavaScript(`(function () {
        const classes = new Set()
        for (const el of document.querySelectorAll('*')) {
          for (const name of String(el.className).split(/\\s+/)) {
            if (/nav|dialog|panel|overlay|settings/i.test(name)) classes.add(name)
          }
        }
        return {
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          expanded: document.querySelector('button[aria-haspopup="dialog"]')?.getAttribute('aria-expanded'),
          classes: [...classes].slice(0, 40),
          bodyLength: document.body.innerHTML.length,
        }
      })()`)
      console.log('\n--- why no nav ---')
      console.log(JSON.stringify(dump, null, 1))
      await shot(win, 'settings-no-nav')
      throw new Error('the settings dialog never rendered a navList')
    }
    await sleep(1200)

    const nav = await win.webContents.executeJavaScript(NAV_REPORT)
    console.log('\n--- nav rail (window 1440x900) ---')
    console.log(`panel   : ${JSON.stringify(nav.panel)}`)
    console.log(`navList : ${JSON.stringify(nav.navList)}`)
    for (const row of nav.rows) console.log(`  ${row.label.padEnd(18)} top=${row.top} bottom=${row.bottom} icon=${row.hasIcon ? 'yes' : 'NO'} patched=${row.patched}`)
    const last = nav.rows[nav.rows.length - 1]
    record('every nav row starts inside the panel', nav.rows.every((row) => row.top < nav.panel.bottom), `panel.bottom=${nav.panel.bottom}`)
    record('the last nav row is fully visible', last.bottom <= nav.panel.bottom, `${last.label} bottom=${last.bottom} panel=${nav.panel.bottom}`)
    record('the nav list can scroll when it overflows', nav.navList.scrollHeight <= nav.navList.clientHeight || nav.navList.canScroll, `overflowY=${nav.navList.overflowY} scrollHeight=${nav.navList.scrollHeight} clientHeight=${nav.navList.clientHeight}`)
    const mergedRows = nav.rows.filter((row) => MERGED_ROW.test(row.label))
    const retiredRows = nav.rows.filter((row) => RETIRED_ROWS.has(row.label))
    record('the rail carries exactly one 维护 row', mergedRows.length === 1, `rows=${JSON.stringify(nav.rows.map((row) => row.label))}`)
    record('the three retired rows left the rail', retiredRows.length === 0, retiredRows.map((row) => row.label).join(', ') || '(none)')

    // The interesting case is a SMALL window: the panel follows the viewport
    // (min(800, 100vh - 48)), so the rail is where the rows get cut.
    win.setContentSize(1280, 620)
    await sleep(800)
    const small = await win.webContents.executeJavaScript(NAV_REPORT)
    const lastSmall = small.rows[small.rows.length - 1]
    console.log('\n--- nav rail (window 1280x620) ---')
    console.log(`panel   : ${JSON.stringify(small.panel)}`)
    console.log(`navList : ${JSON.stringify(small.navList)}`)
    console.log(`  rows below the panel: ${small.rows.filter((row) => row.bottom > small.panel.bottom).map((row) => row.label).join(', ') || '(none)'}`)
    const maintenance = small.rows.find((row) => MERGED_ROW.test(row.label))
    record('the merged 维护 row paints its own glyph', maintenance !== undefined && maintenance.patched === true, JSON.stringify(maintenance))
    record('a small window still reaches every row', small.navList.canScroll || lastSmall.bottom <= small.panel.bottom, `canScroll=${small.navList.canScroll} last=${lastSmall.label}@${lastSmall.bottom} panel=${small.panel.bottom}`)
    win.setContentSize(1440, 900)
    await sleep(600)

    await shot(win, 'settings-nav')

    // --- The merge itself: three plugins contribute tabs, the section owner
    // draws the strip and mounts one panel at a time, and every visited panel
    // stays mounted (that is what preserves a page's state across switches). ---
    const openedMerged = await win.webContents.executeJavaScript(CLICK_MERGED)
    record('the merged 维护 row opens its section', openedMerged === true)
    await sleep(1200)
    const strip = await win.webContents.executeJavaScript(TABS_REPORT)
    const tabLabels = (strip.tabs ?? []).map((tab) => tab.text)
    console.log(`\n--- 维护 tab strip (${LANG}) ---`)
    console.log(`aria-label: ${JSON.stringify(strip.aria)}`)
    for (const tab of strip.tabs ?? []) console.log(`  ${tab.text.padEnd(18)} selected=${String(tab.selected).padEnd(5)} tabIndex=${tab.tabIndex} controls=${tab.controls}`)
    for (const panel of strip.panels ?? []) console.log(`  panel ${panel.id} hidden=${String(panel.hidden).padEnd(5)} rendered=${panel.rendered} labelledBy=${panel.labelledBy}`)
    record('维护 holds its three pages as tabs, in order',
      tabLabels.length === 3 && TAB_LABELS.every((pattern, index) => pattern.test(tabLabels[index] ?? '')),
      JSON.stringify(tabLabels))
    record('exactly one tab is selected, and it is the only one in the tab order',
      (strip.tabs ?? []).filter((tab) => tab.selected).length === 1
        && strip.tabs?.[0]?.selected === true
        && (strip.tabs ?? []).slice(1).every((tab) => tab.tabIndex === -1),
      JSON.stringify((strip.tabs ?? []).map((tab) => [tab.text, tab.selected, tab.tabIndex])))
    record('the selected tab owns one visible panel, wired by aria-controls/labelledby to the real page',
      strip.panels?.length === 1
        && strip.panels[0].hidden === false
        && strip.panels[0].rendered === true
        && strip.panels[0].labelledBy === strip.tabs?.[0]?.id
        && strip.panels[0].id === strip.tabs?.[0]?.controls,
      JSON.stringify(strip.panels))
    // The second tab: its panel mounts, the first goes hidden but STAYS in the
    // DOM — a remount there would throw away a loaded page's data.
    await win.webContents.executeJavaScript(CLICK_TAB(1))
    await sleep(1000)
    const afterSwitch = await win.webContents.executeJavaScript(TABS_REPORT)
    record('a visited tab stays mounted (hidden) while another one shows',
      afterSwitch.panels?.length === 2
        && afterSwitch.panels.filter((panel) => panel.hidden === false).length === 1
        && afterSwitch.panels.filter((panel) => panel.hidden === true && panel.rendered === true).length === 1
        && afterSwitch.tabs?.filter((tab) => tab.selected).length === 1
        && afterSwitch.tabs[1].selected === true,
      JSON.stringify(afterSwitch.panels))
    await shot(win, 'settings-maintenance-tabs')

    if (SWEEP) {
      // Sweep every section: click it, let it paint, count the strings still
      // containing Han characters in an English-mode UI. This is the automated
      // form of "this page's i18n is incomplete" — the original bug report —
      // and it covers pages a single --section run would never reach.
      console.log(`\n--- sweep: every section in ${LANG} ---`)
      let dirty = 0
      for (const row of nav.rows) {
        const clicked = await win.webContents.executeJavaScript(CLICK_ROW(row.label))
        if (clicked !== true) {
          console.log(`  ${row.label.padEnd(22)} (row not clickable)`)
          continue
        }
        await sleep(1100)
        // The merged section's three pages are tabs, so the sweep walks them:
        // reading the pane alone would only ever cover the first one.
        const { strings } = await paneHanCopy(win)
        if (strings.length > 0) dirty += 1
        console.log(`  ${row.label.padEnd(22)} ${strings.length === 0 ? 'clean' : `${strings.length} Han`}`)
        for (const text of strings.slice(0, 4)) console.log(`      • ${text.slice(0, 90)}`)
        if (strings.length > 4) console.log(`      … ${strings.length - 4} more`)
      }
      record(`every settings section renders without Han copy (${LANG})`, dirty === 0, `${dirty} of ${nav.rows.length} sections still show Chinese`)
      await shot(win, 'settings-sweep-last')
    }

    if (SECTION !== null) {
      const clicked = await win.webContents.executeJavaScript(CLICK_ROW(SECTION))
      record(`nav row "${SECTION}" is clickable`, clicked === true)
      if (clicked) {
        await sleep(1500)
        await shot(win, 'settings-section')
        const { missing, strings } = await paneHanCopy(win)
        console.log(`\n--- section "${SECTION}" in ${LANG}: strings still containing Han ---`)
        if (missing) console.log('  (no options pane)')
        else if (strings.length === 0) console.log('  (none)')
        else for (const text of strings) console.log(`  • ${text}`)
        // The check is an ENGLISH-mode check: a zh-CN run renders Chinese by
        // design, so counting Han there says nothing. Print the strings either
        // way (they are the zh copy), assert only in en-US.
        if (LANG === 'en-US') {
          record(`no Chinese left in the "${SECTION}" pane (${LANG})`, !missing && strings.length === 0, `${strings.length} strings`)
        } else {
          console.log(`  (zh-CN run: the Han count is not asserted — see the note above)`)
        }

        // The diagnostics pane's one interactive control that has no side
        // effect: re-checking the desktop bridge. Reported defect: clicking it
        // changed nothing on screen, because the badge never entered its
        // checking state. The pane is on 诊断 by the time the walk above ends
        // (it is the LAST tab), whether the merge is what was asked for or not.
        if (/diagnostic|诊断|maintenance|维护/i.test(SECTION)) {
          const CLICK_RECHECK = `(function () {
            const button = [...document.querySelectorAll('button')]
              .find((b) => /重新检测|check again/i.test(b.textContent))
            if (button === undefined) return false
            button.click()
            return true
          })()`
          const READ_BADGE = `(function () {
            const button = [...document.querySelectorAll('button')]
              .find((b) => /重新检测|check again/i.test(b.textContent))
            const badge = button === undefined ? null : button.parentElement.querySelector('[role="status"]')
            return badge === null ? null : badge.textContent
          })()`
          const clicked = await win.webContents.executeJavaScript(CLICK_RECHECK)
          const seen = []
          for (let i = 0; i < 24; i += 1) {
            const text = await win.webContents.executeJavaScript(READ_BADGE)
            if (text !== null && seen[seen.length - 1] !== text) seen.push(text)
            if (seen.some((x) => /检测中|checking/i.test(x)) && seen.length > 1 && !/检测中|checking/i.test(seen[seen.length - 1])) break
            await sleep(60)
          }
          record('a re-check shows work in flight, then settles on a verdict',
            clicked === true
              && seen.some((text) => /检测中|checking/i.test(text))
              && /可用|不可用|available|unavailable/i.test(seen[seen.length - 1]),
            JSON.stringify(seen))
        }
      }
    }
  } finally {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill()
  }

  console.log(`\nRESULT: ${lines.every((line) => line.startsWith('PASS')) ? 'PASS' : 'FAIL'}`)
  console.log(`kernel log: ${logPath}`)
}

app.whenReady().then(() => main().catch((error) => {
  console.error('\nprobe failed:', error)
  lines.push('FAIL ' + String(error))
}).finally(() => {
  clearTimeout(watchdog)
  app.exit(lines.every((line) => line.startsWith('PASS')) ? 0 : 1)
}))
