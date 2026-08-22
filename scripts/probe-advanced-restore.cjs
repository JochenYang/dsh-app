// Probe: restore the display name the save-probe renamed (idempotent).
// Opens the row only when it is not already expanded, renames back, saves.
// Usage: electron scripts/probe-advanced-restore.cjs <url>
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-restore-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'
const SETTINGS = path.join(process.env.USERPROFILE ?? '', '.dsh', 'settings.yaml')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const out = {}
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await win.loadURL(url); break } catch { await sleep(2000) }
    }
    await sleep(8000)
    await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('设置'));
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(1200)
    await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '模型高级设置');
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(2000)
    await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('.dshAma-root select[aria-label="选择路由"]');
      if (!select) return false;
      select.value = 'sensenova';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    await sleep(1800)

    // Expand row 1 only when it is collapsed (toggle semantics: a blind
    // second click would close it — the bug this restore probe fixes).
    out.expandState = await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.dshAma-entryHead button[aria-label^="展开模型"]')][0];
      if (!btn) return 'missing';
      if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
      return btn.getAttribute('aria-expanded');
    })()`)
    await sleep(600)
    out.nameSet = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.dshAma-entryBody input[aria-label="显示名称 1"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'deepseek-v4-flash');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(400)
    out.saveClicked = await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.dshAma-root button')].find((b) => (b.textContent || '').includes('保存更改'));
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`)
    await sleep(3000)
    const yaml = (() => { try { return fs.readFileSync(SETTINGS, 'utf8') } catch { return null } })()
    out.yamlRestored = yaml !== null && !yaml.includes('deepseek-v4-flash-probe')
    out.notice = await win.webContents.executeJavaScript(
      `document.querySelector('.dshAma-notice')?.textContent ?? null`,
    )
    console.log(JSON.stringify(out, null, 2))
  } catch (error) {
    out.error = String(error)
    console.log(JSON.stringify(out, null, 2))
  } finally {
    app.exit(0)
  }
})
