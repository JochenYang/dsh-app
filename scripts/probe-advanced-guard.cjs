// Probe: off-catalog guard on the Advanced Models page (catalog route,
// whole-list mode). Verifies: clean 16-row list shows no badge; adding an
// off-catalog id (qwen3.5-plus) shows the badge, the zh-CN gate message,
// and a disabled save; removing the row restores a clean state.
// Usage: electron scripts/probe-advanced-guard.cjs <url>
const { app, BrowserWindow } = require('electron')
const path = require('path')
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-guard-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'

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
      select.value = 'opencode-go';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    await sleep(2000)

    // 1) Baseline: 16 catalog rows, no badge, save disabled (no change).
    out.baseline = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.dshAma-root');
      const rows = [...root.querySelectorAll('.dshAma-entryId')].map((e) => e.textContent);
      return {
        rowCount: rows.length,
        offCatalogBadges: root.querySelectorAll('.dshAma-offCatalogBadge').length,
        saveDisabled: [...root.querySelectorAll('button')].find((b) => (b.textContent || '').includes('保存更改'))?.disabled ?? null,
      };
    })()`)

    // 2) Add an off-catalog row: click 手动添加, expand it, type the id.
    await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('.dshAma-root button')].find((b) => (b.textContent || '') === '手动添加');
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(400)
    await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll('.dshAma-entryHead button[aria-label^="展开模型"]')];
      const last = btns[btns.length - 1];
      if (last && last.getAttribute('aria-expanded') !== 'true') last.click();
      return btns.length;
    })()`)
    await sleep(500)
    await win.webContents.executeJavaScript(`(() => {
      const inputs = [...document.querySelectorAll('.dshAma-entryBody input[aria-label^="模型 ID"]')];
      const input = inputs[inputs.length - 1];
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'qwen3.5-plus');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(600)
    out.afterAdd = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.dshAma-root');
      return {
        offCatalogBadges: root.querySelectorAll('.dshAma-offCatalogBadge').length,
        gateMessage: root.querySelector('.dshAma-error')?.textContent ?? null,
        saveDisabled: [...root.querySelectorAll('button')].find((b) => (b.textContent || '').includes('保存更改'))?.disabled ?? null,
      };
    })()`)

    // 3) Remove the added row: badge and gate message clear.
    await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll('.dshAma-entryHead button[aria-label^="移除模型"]')];
      const last = btns[btns.length - 1];
      if (last) last.click();
      return btns.length;
    })()`)
    await sleep(600)
    out.afterRemove = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.dshAma-root');
      return {
        rowCount: root.querySelectorAll('.dshAma-entryId').length,
        offCatalogBadges: root.querySelectorAll('.dshAma-offCatalogBadge').length,
        gateMessage: root.querySelector('.dshAma-error')?.textContent ?? null,
      };
    })()`)

    console.log(JSON.stringify(out, null, 2))
  } catch (error) {
    out.error = String(error)
    console.log(JSON.stringify(out, null, 2))
  } finally {
    app.exit(0)
  }
})
