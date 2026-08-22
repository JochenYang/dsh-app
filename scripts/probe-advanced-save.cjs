// Probe: Advanced Models save path (UI -> settings.mutate -> settings.yaml)
// and the models.dev browser-fetch (CORS) feasibility check.
// Mutates ONE display field (sensenova/deepseek-v4-flash name), verifies the
// YAML, then restores it and verifies again. Leaves settings.yaml as found.
// Usage: electron scripts/probe-advanced-save.cjs <url>
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-save-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'
const SETTINGS = path.join(process.env.USERPROFILE ?? '', '.dsh', 'settings.yaml')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Read settings.yaml text (null when unreadable). */
const readSettings = () => {
  try { return fs.readFileSync(SETTINGS, 'utf8') } catch { return null }
}

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

    // 1) models.dev direct browser fetch (CORS feasibility).
    out.modelsDevFetch = await win.webContents.executeJavaScript(`fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(15000) })
      .then((r) => r.json().then((d) => ({ ok: true, status: r.status, providers: Object.keys(d).length })))
      .catch((e) => ({ ok: false, error: String(e) }))`)

    // 2) Open settings -> advanced page -> select sensenova.
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

    /** Set a React-controlled text input to a value (native setter + input). */
    const setInput = (selector, value) => win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)

    /** Click the save button and wait for the write + hot reload to settle. */
    const save = async () => {
      const clicked = await win.webContents.executeJavaScript(`(() => {
        const btn = [...document.querySelectorAll('.dshAma-root button')].find((b) => (b.textContent || '').includes('保存更改'));
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      })()`)
      await sleep(2500)
      return clicked
    }

    // Expand row 1 (deepseek-v4-flash), rename its display name, save.
    await win.webContents.executeJavaScript(`(() => {
      const first = [...document.querySelectorAll('.dshAma-entryHead button[aria-label^="展开模型"]')][0];
      if (first) first.click();
      return !!first;
    })()`)
    await sleep(600)
    out.nameFieldSet = await setInput('.dshAma-entryBody input[aria-label="显示名称 1"]', 'deepseek-v4-flash-probe')
    out.saveClicked = await save()
    const afterWrite = readSettings()
    out.yamlHasProbeName = afterWrite !== null && afterWrite.includes('deepseek-v4-flash-probe')

    // Rename restoration lives in probe-advanced-restore.cjs (this probe's
    // own restore attempt double-toggled the row expander — the restore probe
    // checks aria-expanded before clicking).
    out.yamlRestoredBy = 'scripts/probe-advanced-restore.cjs'
    out.noticeAfterSave = await win.webContents.executeJavaScript(
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
