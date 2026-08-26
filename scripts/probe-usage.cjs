// Probe: usage settings section renders and the usage API answers.
// Usage: electron scripts/probe-usage.cjs <url>
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-usage-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const out = {}
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await win.loadURL(url)
        break
      } catch {
        await sleep(2000)
      }
    }
    await sleep(8000)
    out.openedSettings = await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes('设置'))
      if (t) t.click()
      return !!t
    })()`)
    await sleep(1200)
    out.navFound = await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim().includes('用量统计'))
      if (t) t.click()
      return !!t
    })()`)
    await sleep(3000)
    out.api = await win.webContents.executeJavaScript(`(async () => {
      const get = async (p) => {
        try {
          const r = await fetch(p, { credentials: 'same-origin', cache: 'no-store' })
          return { http: r.status, body: await r.json() }
        } catch (e) { return { error: String(e) } }
      }
      const status = await get('/plugins/@dsh-app/plugin-usage/api/status')
      const summary = await get('/plugins/@dsh-app/plugin-usage/api/summary?days=30')
      const heat = await get('/plugins/@dsh-app/plugin-usage/api/heatmap?weeks=26')
      return {
        status: status.body && status.body.value,
        summaryTotals: summary.body && summary.body.value && summary.body.value.totals,
        summaryModels: summary.body && summary.body.value ? summary.body.value.models.length : undefined,
        summaryDaily: summary.body && summary.body.value ? summary.body.value.daily.length : undefined,
        heatCells: heat.body && heat.body.value ? heat.body.value.cells.length : undefined,
      }
    })()`)
    out.dom = await win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelector(s)
      const count = (s) => document.querySelectorAll(s).length
      const empty = q('.dshau_empty')
      return {
        section: !!q('.dshau_section'),
        title: q('.dshau_title') ? q('.dshau_title').textContent : null,
        cards: count('.dshau_card'),
        calendarCells: count('.dshau_calCell'),
        chart: !!q('svg.dshau_chart'),
        table: !!q('.dshau_table'),
        emptyText: empty ? empty.textContent.trim() : null,
        banner: q('.dshau_banner') ? q('.dshau_banner').textContent.trim() : null,
      }
    })()`)
    const image = await win.webContents.capturePage()
    const output = path.join('scratch', 'usage-section.png')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, image.toPNG())
    out.screenshot = path.resolve(output)
    console.log(JSON.stringify(out, null, 2))
  } catch (error) {
    out.error = String(error)
    console.log(JSON.stringify(out, null, 2))
  } finally {
    app.exit(0)
  }
})
