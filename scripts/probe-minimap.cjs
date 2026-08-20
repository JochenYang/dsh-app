// Probe: is the brand client plugin loaded, and does the minimap render?
// Usage: electron scripts/probe-minimap.cjs <url>
// Loads the dsh web UI in a fresh window, opens the first session with
// message history, then reports slot/plugin/minimap DOM evidence.
// Pair with a running dev instance:  $env:DSH_APP_DEV="1"; npm start
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.setPath('userData', path.join(app.getPath('temp'), 'dsh-probe-minimap'))
const url = process.argv[2] || 'http://127.0.0.1:59506'
// --inject-chrome: replicate the shell's desktop chrome CSS in the probe
// window so it matches the real main-window rendering (drag regions, header
// utility padding, fallback drag bars).
const injectChrome = process.argv.includes('--inject-chrome')

// Mirror of src/main/window.ts DESKTOP_CHROME_CSS (keep in sync).
const DESKTOP_CHROME_CSS = `
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
body [data-details-collapsed] [class*="_headerUtilities"] { padding-right: 140px; }
body [class*="_centerCol"] { position: relative; }
body [class*="_centerCol"]:not(:has([class*="_titleRow"]))::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 36px;
  -webkit-app-region: drag;
  z-index: 5;
}
body [class*="_panel"]::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 36px;
  -webkit-app-region: drag;
  z-index: 0;
}
body [class*="_panel"] [class*="_header"] {
  padding-top: 36px;
}
body [class*="_panel"] [class*="_header"] button,
body [class*="_panel"] [class*="_header"] a,
body [class*="_panel"] [class*="_header"] [role="button"],
body [class*="_panel"] [class*="_header"] [class*="button"],
body [class*="_panel"] [class*="_header"] [class*="Button"],
body [class*="_panel"] [class*="_close"],
body [class*="_panel"] [class*="Close"] { -webkit-app-region: no-drag; }
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: true })
  const logs = []
  win.webContents.on('console-message', (_e, _level, message) => {
    if (logs.length < 40) logs.push(message)
  })
  try {
    await win.loadURL(url)
  } catch (err) {
    console.log('LOAD FAILED: ' + err.message)
    app.exit(1)
    return
  }
  await new Promise(r => setTimeout(r, 14000))
  // Open the session that has message history (sidebar row by title).
  const opened = await win.webContents.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('[class*="session"],[class*="item"],[class*="row"]'))
    const target = rows.find(el => el.textContent.trim().includes('成都今日天气如何'))
    if (target) { target.click(); return 'clicked' }
    return 'not-found'
  })()`)
  console.log('>> open session: ' + opened)
  await new Promise(r => setTimeout(r, 3500))

  if (injectChrome) {
    await win.webContents.executeJavaScript(`(function () {
      const el = document.createElement('style');
      el.id = 'dsh-desktop-chrome-test';
      el.textContent = ${JSON.stringify(DESKTOP_CHROME_CSS)};
      document.head.appendChild(el);
    })()`)
    console.log('>> injected desktop chrome CSS')
    await new Promise(r => setTimeout(r, 2500))
  }

  const result = await win.webContents.executeJavaScript(`(() => {
    const scroll = document.querySelector('[data-conversation-scroll]')
    const track = document.querySelector('.dshapp-mm-track')
    const preview = document.querySelector('.dshapp-mm-preview')
    const anchors = document.querySelectorAll('[data-chat-anchor-key]').length
    const ticks = document.querySelectorAll('.dshapp-mm-tick').length
    const resources = performance.getEntriesByType('resource')
      .map(e => e.name)
      .filter(n => n.includes('dsh-app') || n.includes('plugin-client'))
    const mmStyles = Array.from(document.querySelectorAll('style'))
      .filter(s => s.textContent && s.textContent.includes('dshapp-mm'))
      .length
    const tr = track ? track.getBoundingClientRect() : null
    const tickFirst = document.querySelector('.dshapp-mm-tick')
    const tfr = tickFirst ? tickFirst.getBoundingClientRect() : null
    const activeTicks = document.querySelectorAll('.dshapp-mm-tick.is-active').length
    const tickTops = Array.from(document.querySelectorAll('.dshapp-mm-tick'))
      .map(t => Math.round(t.getBoundingClientRect().top))
      .slice(0, 6)
    // Simulate hover on the first node (React onMouseEnter derives from
    // mouseover) and measure where the preview lands.
    const hv = document.querySelector('.dshapp-mm-tick')
    const hvr = hv ? hv.getBoundingClientRect() : null
    let previewRect = null
    if (hvr) {
      hv.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: hvr.x + 4, clientY: hvr.y + 2 }))
      hv.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: hvr.x + 4, clientY: hvr.y + 2 }))
      hv.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: hvr.x + 4, clientY: hvr.y + 2 }))
      const pv = document.querySelector('.dshapp-mm-preview')
      if (pv) {
        const pr = pv.getBoundingClientRect()
        previewRect = { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) }
      }
    }
    return JSON.stringify({
      url: location.href,
      hasScrollport: !!scroll,
      scrollHeight: scroll ? scroll.scrollHeight : -1,
      anchorRows: anchors,
      hasTrack: !!track,
      trackStyle: track ? track.getAttribute('style') : null,
      trackRect: tr ? { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) } : null,
      trackDisplay: track ? getComputedStyle(track).display : null,
      firstTickRect: tfr ? { x: Math.round(tfr.x), y: Math.round(tfr.y), w: Math.round(tfr.width), h: Math.round(tfr.height) } : null,
      activeTicks,
      tickTops,
      previewRect,
      ticks,
      hasPreview: !!preview,
      minimapStyleTags: mmStyles,
      dshAppResources: resources,
      bodyHead: document.body.innerText.slice(0, 160).replace(/\\n/g, ' | '),
    }, null, 2)
  })()`)
  console.log(result)
  // Separate async hover check: React renders the preview on the next frame,
  // so wait before measuring where it lands.
  const previewProbe = await win.webContents.executeJavaScript(`new Promise(resolve => {
    const hv = document.querySelector('.dshapp-mm-tick')
    if (!hv) { resolve('no tick'); return }
    const r = hv.getBoundingClientRect()
    hv.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.x + 4, clientY: r.y + 2 }))
    hv.dispatchEvent(new MouseEvent('mousemove',  { bubbles: true, clientX: r.x + 4, clientY: r.y + 2 }))
    setTimeout(() => {
      const pv = document.querySelector('.dshapp-mm-preview')
      const pr = pv ? pv.getBoundingClientRect() : null
      const vis = pv ? getComputedStyle(pv).position : null
      resolve(pr ? { pos: vis, rect: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) } } : 'no preview')
    }, 500)
  })`)
  console.log('>> hover preview: ' + (typeof previewProbe === 'string' ? previewProbe : JSON.stringify(previewProbe)))
  // Accuracy check: click the 4th node, wait for the smooth scroll to settle,
  // then verify the active highlight landed on exactly that node. Any other
  // active node means the position-tracking is off.
  const accuracy = await win.webContents.executeJavaScript(`new Promise(resolve => {
    const ticks = Array.from(document.querySelectorAll('.dshapp-mm-tick'))
    if (ticks.length < 4) { resolve('too few ticks'); return }
    const target = ticks[3]
    const targetKey = target.getAttribute('data-dshapp-mm-key')
    target.click()
    setTimeout(() => {
      const active = document.querySelector('.dshapp-mm-tick.is-active')
      const activeKey = active ? active.getAttribute('data-dshapp-mm-key') : null
      const scrollTop = (document.querySelector('[data-conversation-scroll]') || {}).scrollTop ?? null
      resolve({ targetKey, activeKey, match: targetKey === activeKey, scrollTop })
    }, 2500)
  })`)
  console.log('>> accuracy: ' + (typeof accuracy === 'string' ? accuracy : JSON.stringify(accuracy)))
  console.log('--- console messages (first 40) ---')
  console.log(logs.join('\n') || '(none)')
  app.exit(0)
})