// Probe: built-in provider model discovery on the Advanced Models page.
// Usage: electron scripts/probe-advanced-provider-discovery.cjs <url>
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-adv-provider-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
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

    out.opened = await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes('设置'))
      if (t) t.click()
      return !!t
    })()`)
    await sleep(1200)

    out.advancedOpened = await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '模型高级设置')
      if (t) t.click()
      return !!t
    })()`)
    await sleep(2200)

    out.selected = await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('.dshAma-root select[aria-label="选择路由"]')
      if (!select) return false
      select.value = 'sensenova'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(1200)

    out.dialogOpened = await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('.dshAma-root button')]
        .find((b) => (b.textContent || '').trim() === '从 provider 获取')
      if (t) t.click()
      return !!t
    })()`)
    await sleep(5000)

    out.discovery = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.dshAma-discoveryModal')
      if (!dialog) return { mounted: false }
      const rows = [...dialog.querySelectorAll('.dshAma-discoveryRow')]
      return {
        mounted: true,
        source: dialog.querySelector('.dshAma-discoverySource code')?.textContent ?? null,
        rowCount: rows.length,
        firstModel: rows[0]?.querySelector('strong')?.textContent ?? null,
        hasSearch: !!dialog.querySelector('input[aria-label="筛选模型"]'),
        adoptDisabled: [...dialog.querySelectorAll('button')]
          .find((b) => (b.textContent || '').includes('采用'))?.disabled ?? null,
        busy: dialog.textContent?.includes('正在向 provider 获取模型') ?? false,
        failure: dialog.querySelector('.dshAma-error')?.textContent ?? null,
        bodyText: dialog.querySelector('.dshAma-modalBody')?.textContent?.slice(0, 240) ?? null,
      }
    })()`)
    out.adopted = await win.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('.dshAma-discoveryModal button')]
        .find((b) => (b.textContent || '').includes('采用'))
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`)
    await sleep(700)
    out.afterAdopt = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.dshAma-root')
      const ids = [...root.querySelectorAll('.dshAma-entryId')].map((e) => e.textContent)
      return {
        dialogClosed: !document.querySelector('.dshAma-discoveryModal'),
        importedId: ids.includes('sensenova-6.7-flash-lite'),
      }
    })()`)
    console.log(JSON.stringify(out, null, 2))
  } catch (error) {
    out.error = String(error)
    console.log(JSON.stringify(out, null, 2))
  } finally {
    app.exit(0)
  }
})
