// Probe: companion-route migration (off-catalog rows on a catalog route).
// Adds one off-catalog row to opencode-go, clicks the migrate button, and
// verifies settings.yaml: opencode-go-extra created (api/baseURL/apiKeyEnv/
// models), opencode-go list clean. Then removes the probe route from the
// YAML text (unique block) so settings.yaml returns to its prior state.
// Usage: electron scripts/probe-advanced-migrate.cjs <url>
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-migrate-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'
const SETTINGS = path.join(process.env.USERPROFILE ?? '', '.dsh', 'settings.yaml')
const PROBE_ID = 'qwen3.5-probe-migrate'

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

    // Add one off-catalog row and fill its id.
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
      setter.call(input, ${JSON.stringify(PROBE_ID)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(600)

    // Click the migrate button next to the gate message.
    out.migrateButton = await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.dshAma-root button')]
        .find((b) => (b.textContent || '').includes('迁移 1 个模型到伴生路由'));
      if (!btn) return false;
      btn.click();
      return true;
    })()`)
    await sleep(600)
    out.modal = await win.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('.dshAma-modal[aria-label="迁移到伴生路由"]');
      if (!modal) return { open: false };
      return {
        open: true,
        routeId: modal.querySelector('input[aria-label="伴生路由 ID"]')?.value ?? null,
        api: modal.querySelector('select[aria-label="伴生路由协议"]')?.value ?? null,
        displayName: modal.querySelector('input[aria-label="伴生路由显示名称"]')?.value ?? null,
        baseURLPrefill: modal.querySelector('input[aria-label="伴生路由 baseURL"]')?.value ?? null,
      };
    })()`)
    // Fill the baseURL (required: the catalog does not know the new route).
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.dshAma-modal input[aria-label="伴生路由 baseURL"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'https://opencode.ai/zen/go/v1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await win.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('.dshAma-modal[aria-label="迁移到伴生路由"]');
      const btn = modal && [...modal.querySelectorAll('button')].find((b) => (b.textContent || '') === '迁移');
      if (btn) btn.click();
      return !!btn;
    })()`)
    await sleep(3000)
    out.modalError = await win.webContents.executeJavaScript(
      `document.querySelector('.dshAma-modal .dshAma-error')?.textContent ?? null`,
    )
    out.pageError = await win.webContents.executeJavaScript(
      `document.querySelector('.dshAma-root > .dshAma-footer .dshAma-error')?.textContent ?? null`,
    )

    const yaml = (() => { try { return fs.readFileSync(SETTINGS, 'utf8') } catch { return null } })()
    out.result = {
      extraRouteCreated: yaml !== null && /^    opencode-go-extra:\r?\n/m.test(yaml),
      extraHasApi: yaml !== null && /opencode-go-extra:[\s\S]*?api: openai-completions/.test(yaml),
      extraHasKeyEnv: yaml !== null && /opencode-go-extra:[\s\S]*?apiKeyEnv: OPENCODE_GO_API_KEY/.test(yaml),
      probeModelMigrated: yaml !== null && new RegExp(`opencode-go-extra:[\\s\\S]*?id: ${PROBE_ID}`).test(yaml),
      mainListClean: yaml !== null && !new RegExp(`opencode-go:\\r?\\n[\\s\\S]*?id: ${PROBE_ID}`).test(yaml),
    }
    out.notice = await win.webContents.executeJavaScript(
      `document.querySelector('.dshAma-notice')?.textContent ?? null`,
    )

    // Cleanup: remove the opencode-go-extra block (unique key) so the file
    // returns to its pre-probe state; the kernel hot-reloads the removal.
    if (out.result.extraRouteCreated && yaml !== null) {
      const cleaned = yaml.replace(/^    opencode-go-extra:\r?\n(?:[ \t]{6,}.*\r?\n)*/m, '')
      fs.writeFileSync(SETTINGS, cleaned, 'utf8')
      await sleep(1500)
      const after = fs.readFileSync(SETTINGS, 'utf8')
      out.cleanup = {
        extraRemoved: !/^    opencode-go-extra:/m.test(after),
        probeIdGone: !after.includes(PROBE_ID),
      }
    }
    console.log(JSON.stringify(out, null, 2))
  } catch (error) {
    out.error = String(error)
    console.log(JSON.stringify(out, null, 2))
  } finally {
    app.exit(0)
  }
})
