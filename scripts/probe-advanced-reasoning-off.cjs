// Probe: explicit reasoning-off writes false instead of removing the field.
// The original settings document is restored before the probe exits.
// Usage: electron scripts/probe-advanced-reasoning-off.cjs <url>
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-adv-reasoning-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'
const settingsPath = path.join(process.env.USERPROFILE || '', '.dsh', 'settings.yaml')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function setSelect(win, selector, value) {
  return win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)})
    if (!select) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, ${JSON.stringify(value)})
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
}

app.whenReady().then(async () => {
  const original = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
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
    await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes('设置'))
      if (t) t.click()
      return !!t
    })()`)
    await sleep(1200)
    await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '模型高级设置')
      if (t) t.click()
      return !!t
    })()`)
    await sleep(2200)
    await setSelect(win, '.dshAma-root select[aria-label="选择路由"]', 'sensenova')
    await sleep(1200)
    await win.webContents.executeJavaScript(`(() => {
      const t = document.querySelector('.dshAma-root button[aria-label^="展开模型"]')
      if (t) t.click()
      return !!t
    })()`)
    await sleep(500)
    out.modeChanged = await setSelect(
      win,
      '.dshAma-entryBody select[aria-label^="推理等级模式"]',
      'off',
    )
    await sleep(300)
    out.mode = await win.webContents.executeJavaScript(
      `document.querySelector('.dshAma-entryBody select[aria-label^="推理等级模式"]')?.value ?? null`,
    )
    out.saveClicked = await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('.dshAma-root button')]
        .find((b) => (b.textContent || '').includes('保存更改'))
      if (!t || t.disabled) return false
      t.click()
      return true
    })()`)
    await sleep(2800)
    const after = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : ''
    const firstModel = after.match(/- id: deepseek-v4-flash[\s\S]*?(?=\r?\n\s+- id:|$)/)?.[0] || ''
    out.persistedFalse = /reasoningEfforts:\s*false/.test(firstModel)
    out.modelSnippet = firstModel.slice(0, 420)
    out.notice = await win.webContents.executeJavaScript(
      `document.querySelector('.dshAma-notice')?.textContent ?? null`,
    )
    console.log(JSON.stringify(out, null, 2))
  } catch (error) {
    out.error = String(error)
    console.log(JSON.stringify(out, null, 2))
  } finally {
    if (original !== null) fs.writeFileSync(settingsPath, original, 'utf8')
    app.exit(0)
  }
})
