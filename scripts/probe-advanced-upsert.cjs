// Probe: create-route upsert semantics + new chip icon.
// Flow: create probe-upsert-extra with one model; reopen the card with the
// SAME id (declared upsert) — expect merge hint, locked fields, "追加到该
// 路由" button; append a second model; verify YAML holds both rows; clean up.
// Also re-asserts the nav icon swap with the new glyph.
// Usage: electron scripts/probe-advanced-upsert.cjs <url>
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-upsert-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64321'
const SETTINGS = path.join(process.env.USERPROFILE ?? '', '.dsh', 'settings.yaml')
const ROUTE = 'probe-upsert-extra'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const exec = (code) => win.webContents.executeJavaScript(code)
  const out = {}
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await win.loadURL(url); break } catch { await sleep(2000) }
    }
    await sleep(8000)
    await exec(`(() => {
      const t = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('设置'));
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(1200)
    // Nav icon still swaps with the new glyph.
    out.navIcon = await exec(`(() => {
      const cells = [...document.querySelectorAll('[class*="navList"] button')];
      const idx = cells.findIndex((c) => (c.textContent || '').trim() === '模型高级设置');
      return idx >= 0 ? {
        tagged: cells[idx].classList.contains('dshAmaAdvNav'),
        mask: getComputedStyle(cells[idx], '::before').maskImage !== 'none',
        gearHidden: cells[idx].querySelector('svg') === null || getComputedStyle(cells[idx].querySelector('svg')).display === 'none',
      } : null;
    })()`)
    await exec(`(() => {
      const t = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '模型高级设置');
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(2000)

    /** Fill one create-card field by aria-label. */
    const fill = (label, value) => exec(`(() => {
      const el = document.querySelector('.dshAma-newRoute input[aria-label=${JSON.stringify(label)}], .dshAma-newRoute select[aria-label=${JSON.stringify(label)}]');
      if (!el) return false;
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      return true;
    })()`)

    /** Add one manual row in the create card with the given id. */
    const addRow = (id) => exec(`(() => {
      const t = [...document.querySelectorAll('.dshAma-newRoute button')].find((b) => (b.textContent || '') === '手动添加');
      if (!t) return false;
      t.click();
      return true;
    })()`).then(async () => {
      await sleep(400)
      await exec(`(() => {
        const btns = [...document.querySelectorAll('.dshAma-entryHead button[aria-label^="展开初始模型"]')];
        const last = btns[btns.length - 1];
        if (last && last.getAttribute('aria-expanded') !== 'true') last.click();
        return true;
      })()`)
      await sleep(500)
      return exec(`(() => {
        const inputs = [...document.querySelectorAll('.dshAma-entryBody input[aria-label^="模型 ID"]')];
        const input = inputs[inputs.length - 1];
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(id)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`)
    })

    const clickPrimary = (text) => exec(`(() => {
      const btn = [...document.querySelectorAll('.dshAma-newRoute button')].find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`)

    // --- Phase 1: create the route with model A. ---
    await exec(`(() => { document.querySelector('.dshAma-newRouteSummary')?.click(); return true; })()`)
    await sleep(400)
    await clickPrimary('开始创建')
    await sleep(400)
    out.fillCreate = [
      await fill('路由 ID', ROUTE),
      await fill('wire 协议', 'openai-completions'),
      await fill('baseURL', 'https://opencode.ai/zen/go/v1'),
    ]
    await addRow('probe-model-a')
    await sleep(400)
    out.created = await clickPrimary('创建路由')
    await sleep(3000)
    const yaml1 = fs.readFileSync(SETTINGS, 'utf8')
    out.phase1 = {
      routeInYaml: yaml1.includes(ROUTE),
      modelA: yaml1.includes('probe-model-a'),
    }

    // --- Phase 2: same id again → upsert hint + append model B. ---
    await exec(`(() => { document.querySelector('.dshAma-newRouteSummary')?.click(); return true; })()`)
    await sleep(400)
    await clickPrimary('开始创建')
    await sleep(400)
    await fill('路由 ID', ROUTE)
    await sleep(500)
    out.upsertUi = await exec(`(() => {
      const card = document.querySelector('.dshAma-newRoute');
      // querySelector would hit the card's static top hint; the merge hint is
      // any hint whose text carries the merge keyword.
      const hints = [...card.querySelectorAll('.dshAma-hint')].map((h) => h.textContent);
      return {
        hint: hints.some((text) => text.includes('合并追加')),
        apiLocked: card.querySelector('select[aria-label="wire 协议"]')?.disabled ?? null,
        baseLocked: card.querySelector('input[aria-label="baseURL"]')?.disabled ?? null,
        buttonLabel: [...card.querySelectorAll('button')].map((b) => b.textContent).find((t) => t.includes('追加到该路由')) ?? null,
      };
    })()`)
    await addRow('probe-model-b')
    await sleep(400)
    out.appended = await clickPrimary('追加到该路由')
    await sleep(3000)
    const yaml2 = fs.readFileSync(SETTINGS, 'utf8')
    out.phase2 = {
      modelA: yaml2.includes('probe-model-a'),
      modelB: yaml2.includes('probe-model-b'),
      notice: await exec(`document.querySelector('.dshAma-notice')?.textContent ?? null`),
    }

    // --- Cleanup: drop the probe route block. ---
    const cleaned = yaml2.replace(/^    probe-upsert-extra:\r?\n(?:[ \t]{6,}.*\r?\n)*/m, '')
    fs.writeFileSync(SETTINGS, cleaned, 'utf8')
    await sleep(1500)
    out.cleanup = {
      routeRemoved: !fs.readFileSync(SETTINGS, 'utf8').includes(ROUTE),
      modelsGone: !fs.readFileSync(SETTINGS, 'utf8').includes('probe-model-'),
    }
    console.log(JSON.stringify(out, null, 2))
  } catch (error) {
    out.error = String(error)
    console.log(JSON.stringify(out, null, 2))
  } finally {
    app.exit(0)
  }
})
