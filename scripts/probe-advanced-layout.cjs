// Probe: Advanced Models content stays below the native settings header.
// Usage: electron scripts/probe-advanced-layout.cjs <url>
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-adv-layout-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'
const width = Number(process.env.DSH_PROBE_WIDTH || 1280)
const height = Number(process.env.DSH_PROBE_HEIGHT || 860)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function rectOf(element) {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
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
    out.layout = await win.webContents.executeJavaScript(`(() => {
      const open = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes('打开配置文件'))
      const root = document.querySelector('.dshAma-root')
      const intro = document.querySelector('.dshAma-intro')
      return {
        nativeAction: ${rectOf.toString()}(open),
        advancedRoot: ${rectOf.toString()}(root),
        intro: ${rectOf.toString()}(intro),
        overlap: !!open && !!intro && intro.getBoundingClientRect().top < open.getBoundingClientRect().bottom,
      }
    })()`)
    const image = await win.webContents.capturePage()
    const output = path.join('scratch', 'advanced-layout.png')
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
