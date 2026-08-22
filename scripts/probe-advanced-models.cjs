// Probe: Advanced Models settings page (brand plugin) render + nav icon.
// Verifies: nav entry after 模型, brand icon patch, page mount, route select
// population, sensenova model list, reasoning editor, create-route card.
// Usage: electron scripts/probe-advanced-models.cjs <url>
const { app, BrowserWindow } = require('electron')
const path = require('path')
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-adv-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const out = {}
  try {
    // Load with retry until the server is settled (health fence).
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await win.loadURL(url); break } catch { await sleep(2000) }
    }
    await sleep(8000)

    // Open the settings dialog via the sidebar foot trigger.
    out.opened = await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find((b) => (b.textContent || '').includes('设置'));
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(1500)

    // Nav: the advanced entry exists and sits right after 模型.
    out.nav = await win.webContents.executeJavaScript(`(() => {
      const cells = [...document.querySelectorAll('[class*="navList"] button')];
      const labels = cells.map((c) => (c.textContent || '').trim());
      const idx = labels.indexOf('模型高级设置');
      return {
        labels,
        advancedIndex: idx,
        afterModels: idx > 0 && labels[idx - 1] === '模型',
        iconTagged: idx >= 0 ? cells[idx].classList.contains('dshAmaAdvNav') : false,
        iconMask: idx >= 0
          ? getComputedStyle(cells[idx], '::before').maskImage !== 'none'
            || getComputedStyle(cells[idx], '::before').webkitMaskImage !== 'none'
          : false,
        gearHidden: idx >= 0
          ? cells[idx].querySelector('svg') === null || getComputedStyle(cells[idx].querySelector('svg')).display === 'none'
          : false,
      };
    })()`)
    await sleep(600)

    // Mount the page.
    await win.webContents.executeJavaScript(`(() => {
      const cells = [...document.querySelectorAll('button')];
      const t = cells.find((b) => (b.textContent || '').trim() === '模型高级设置');
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(2500)

    out.page = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.dshAma-root');
      if (!root) return { mounted: false };
      const select = root.querySelector('select[aria-label="选择路由"]');
      const options = select ? [...select.options].map((o) => o.value).filter((v) => v !== '') : [];
      return {
        mounted: true,
        intro: root.querySelector('.dshAma-intro')?.textContent.slice(0, 60) ?? null,
        routeOptions: options,
        hasSensenova: options.includes('sensenova'),
        hasGoVision: options.includes('opencode-go-vision'),
        createCard: root.querySelector('.dshAma-newRouteSummary')?.textContent ?? null,
      };
    })()`)

    // Select sensenova → whole-list mode, three models, expand one row.
    if (out.page?.mounted) {
      await win.webContents.executeJavaScript(`(() => {
        const select = document.querySelector('.dshAma-root select[aria-label="选择路由"]');
        if (!select) return false;
        select.value = 'sensenova';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      await sleep(1800)
      out.sensenova = await win.webContents.executeJavaScript(`(() => {
        const root = document.querySelector('.dshAma-root');
        const entries = [...root.querySelectorAll('.dshAma-entryId')].map((e) => e.textContent);
        const banner = root.querySelector('.dshAma-modeBanner')?.textContent ?? null;
        // Expand the first row (deepseek-v4-flash) and read the editors.
        const first = [...root.querySelectorAll('.dshAma-entryHead button[aria-label^="展开模型"]')][0];
        if (first) first.click();
        return { banner, entries };
      })()`)
      await sleep(600)
      out.entryEditor = await win.webContents.executeJavaScript(`(() => {
        const body = document.querySelector('.dshAma-entryBody');
        if (!body) return { open: false };
        const labels = [...body.querySelectorAll('.dshAma-fieldLabel')].map((e) => e.textContent);
        const reasoningSelect = body.querySelector('select[aria-label^="推理等级模式"]');
        const kvRows = [...body.querySelectorAll('.dshAma-kvRow .dshAma-kvKey')].map((e) => e.textContent);
        const checks = [...body.querySelectorAll('.dshAma-check span')].map((e) => e.textContent);
        return {
          open: true,
          fieldLabels: labels,
          reasoningMode: reasoningSelect ? reasoningSelect.value : null,
          reasoningLevels: kvRows,
          modalities: checks,
          capacityTexts: [...body.querySelectorAll('input[inputmode="numeric"]')].map((i) => i.value),
        };
      })()`)
    }

    console.log(JSON.stringify(out, null, 2))
  } catch (error) {
    out.error = String(error)
    console.log(JSON.stringify(out, null, 2))
  } finally {
    app.exit(0)
  }
})
