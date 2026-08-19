// Probe: drag regions (default + settings open) and brand Models page render.
// Usage: electron scripts/probe-drag.cjs <url>
const { app, BrowserWindow } = require('electron')
const path = require('path')
app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-userdata'))
const url = process.argv[2] || 'http://127.0.0.1:64300'

const OVERLAY_HEIGHT = 36
const WINDOW_CONTROLS_WIDTH = 140
// Mirror of src/main/window.ts DESKTOP_CHROME_CSS (keep in sync).
const CSS = `
body [class*="_logoRow"],
body [class*="_titleRow"] { -webkit-app-region: drag; }
body [class*="_logoRow"] button,
body [class*="_logoRow"] a,
body [class*="_logoRow"] input,
body [class*="_logoRow"] [role="button"],
body [class*="_titleRow"] button,
body [class*="_titleRow"] a,
body [class*="_titleRow"] input,
body [class*="_titleRow"] [role="button"] { -webkit-app-region: no-drag; }
body [data-details-collapsed] [class*="_headerUtilities"] { padding-right: ${WINDOW_CONTROLS_WIDTH}px; }
body [class*="_centerCol"] { position: relative; }
body [class*="_centerCol"]:not(:has([class*="_titleRow"]))::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: ${OVERLAY_HEIGHT}px;
  -webkit-app-region: drag;
  z-index: 5;
}
body [class*="_panel"]::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 44px;
  -webkit-app-region: drag;
  z-index: 2;
}
body [class*="_panel"] [class*="_header"] button,
body [class*="_panel"] [class*="_header"] a { -webkit-app-region: no-drag; }
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#1a1a1a', height: OVERLAY_HEIGHT },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  await win.loadURL(url)
  await sleep(6000)
  await win.webContents.executeJavaScript(`(() => {
    const el = document.createElement('style'); el.id = 'probe-chrome';
    el.textContent = ${JSON.stringify(CSS)};
    document.head.appendChild(el);
  })()`)
  await sleep(300)

  const regionAt = (x, y) => `(() => {
    const el = document.elementFromPoint(${x}, ${y});
    if (!el) return null;
    return { cls: String(el.className).slice(0, 60), region: getComputedStyle(el).webkitAppRegion };
  })()`

  const out = {}
  out.default_topMid = await win.webContents.executeJavaScript(regionAt(640, 18))
  out.default_topLeft = await win.webContents.executeJavaScript(regionAt(120, 18))

  // Open settings via the sidebar foot trigger (text 设置).
  await win.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const t = btns.find((b) => (b.textContent || '').includes('设置'));
    if (t) t.click();
    return !!t;
  })()`)
  await sleep(1200)

  // Click the 模型 nav row.
  await win.webContents.executeJavaScript(`(() => {
    const cells = [...document.querySelectorAll('button')];
    const t = cells.find((b) => (b.textContent || '').trim() === '模型');
    if (t) t.click();
    return !!t;
  })()`)
  await sleep(1500)

  out.settings_models = await win.webContents.executeJavaScript(`(() => {
    const m = document.querySelector('.dshapp-models');
    const panel = document.querySelector('[class*="_panel"]');
    const headerBtn = document.querySelector('[class*="_panel"] [class*="_header"] button');
    return {
      modelsFound: !!m,
      modelsText: m ? m.innerText.slice(0, 200) : null,
      panelRegion: panel ? getComputedStyle(panel, '::before').webkitAppRegion : null,
      closeBtnRegion: headerBtn ? getComputedStyle(headerBtn).webkitAppRegion : null,
      styleTag: !!document.querySelector('style[data-plugin-css="dsh-app-client-ui/models.css"]'),
      errors: (window.__probeErrors || []).slice(0, 3),
    };
  })()`)

  console.log(JSON.stringify(out, null, 2))
  setTimeout(() => app.quit(), 300)
})
