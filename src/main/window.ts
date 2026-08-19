import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { DEFAULT_HTTP_HOST } from '../shared/constants'

/** Height of the title-bar overlay (matches the injected drag top bars). */
const OVERLAY_HEIGHT = 36
/** Width reserved on the right for the native window-control buttons. */
const WINDOW_CONTROLS_WIDTH = 140
/** Last overlay color applied per window, so identical samples are no-ops. */
const appliedChromeColors = new WeakMap<BrowserWindow, string>()

/** '#rrggbb' from 'rgb(r, g, b)' / 'rgba(...)' strings. */
function rgbToHex(rgb: string): string {
  const m = rgb.match(/\d+/g)
  if (!m || m.length < 3) return '#ffffff'
  return `#${m
    .slice(0, 3)
    .map((n) => parseInt(n, 10).toString(16).padStart(2, '0'))
    .join('')}`
}

/** Choose a readable window-button color for a given background. */
function symbolColorFor(bg: string): string {
  const m = bg.match(/\d+/g)
  if (!m || m.length < 3) return '#1a1a1a'
  const [r, g, b] = m.slice(0, 3).map(Number)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.5 ? '#1a1a1a' : '#e0e0e0'
}

const MAIN_WINDOW_OPTS = {
  width: 1280,
  height: 800,
  minWidth: 900,
  minHeight: 600,
  title: 'DSH App',
  autoHideMenuBar: true,
  // Title bar overlay: keeps native window controls but lets the web content
  // theme bleed through. The overlay color follows the page's own theme
  // (synced from the page below), so it matches dsh light/dark palettes.
  titleBarStyle: 'hidden' as const,
  titleBarOverlay: {
    color: '#ffffff',
    symbolColor: '#1a1a1a',
    height: OVERLAY_HEIGHT,
  },
  icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'),
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // No preload for the dsh web UI: it is a remote-origin page with its own
    // security model. All desktop capabilities flow through the local server.
  },
} as const

/**
 * Probe the effective color behind the native window-control strip: the
 * topmost element at the strip's center wins. A full-viewport modal mask
 * (settings, dialogs, lightbox) darkens the strip, so compositing it over the
 * page base keeps the overlay in the same layer as the masked page; with no
 * mask the first opaque ancestor (normally the app frame's bg-base) is
 * returned, matching the dsh theme. Shared by the one-shot probe and the
 * persistent observer below.
 */
const SAMPLE_FN = `
  function sample() {
    const meta = document.querySelector('meta[name="theme-color"]');
    const base = (meta && meta.content) || getComputedStyle(document.body).backgroundColor || 'rgb(255, 255, 255)';
    const parse = (c) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(',').map((s) => parseFloat(s));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (fg, bg) => {
      const f = parse(fg), b = parse(bg);
      if (!f || !b) return fg;
      const a = f.a;
      return 'rgb(' + Math.round(f.r * a + b.r * (1 - a)) + ', ' +
        Math.round(f.g * a + b.g * (1 - a)) + ', ' +
        Math.round(f.b * a + b.b * (1 - a)) + ')';
    };
    const x = Math.max(0, window.innerWidth - ${WINDOW_CONTROLS_WIDTH} / 2);
    const y = Math.floor(${OVERLAY_HEIGHT} / 2);
    let el = document.elementFromPoint(x, y);
    let color = null;
    while (el && el !== document.documentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') { color = bg; break; }
      el = el.parentElement;
    }
    return color ? over(color, base) : base;
  }
`

/** Sample the strip color once. */
const SAMPLE_SCRIPT = `(function () {${SAMPLE_FN} return sample(); })()`

/**
 * Install a persistent observer in the page that resolves the returned promise
 * with the NEXT strip-color change (theme attribute/style edits, modal
 * mount/unmount, resize, scroll, visibility). The observer and its state live
 * on `window` across executeJavaScript calls, so the shell's sync loop blocks
 * quietly until a real change happens — no polling traffic. Navigation resets
 * the script context; the shell reinstalls it on the fresh document.
 */
const OBSERVER_SCRIPT = `(function () {
  ${SAMPLE_FN}
  const KEY = '__dshAppChromeSync';
  const state = window[KEY] || (window[KEY] = { last: null, pending: null });
  const push = () => {
    let color = null;
    try { color = sample(); } catch (err) { return; }
    if (color === null || color === state.last) return;
    state.last = color;
    if (state.pending) { const resolve = state.pending; state.pending = null; resolve(color); }
  };
  if (!state.installed) {
    state.installed = true;
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      (window.requestAnimationFrame || ((cb) => setTimeout(cb, 16)))(() => { scheduled = false; push(); });
    };
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'content', 'data-ds-dark-theme'],
      childList: true,
      subtree: true,
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    document.addEventListener('visibilitychange', schedule);
  }
  return new Promise((resolve) => {
    state.pending = resolve;
    if (state.last !== null) { state.pending = null; resolve(state.last); }
    else push();
  });
})()`

/** Apply one sampled color to the title-bar overlay; identical samples are no-ops. */
function applyOverlayColor(win: BrowserWindow, color: string): void {
  if (win.isDestroyed() || appliedChromeColors.get(win) === color) return
  appliedChromeColors.set(win, color)
  win.setTitleBarOverlay({
    color: rgbToHex(color),
    symbolColor: symbolColorFor(color),
    height: OVERLAY_HEIGHT,
  })
}

/** Read the strip color once (initial load, did-finish-load, window show). */
async function syncOverlayOnce(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  try {
    const color = await win.webContents.executeJavaScript(SAMPLE_SCRIPT)
    if (typeof color === 'string') applyOverlayColor(win, color)
  } catch {
    // Page not ready yet; the observer loop retries on the next beat.
  }
}

/**
 * Real-time overlay sync. The loop awaits the page observer: each
 * executeJavaScript call resolves with the next color change, so it blocks
 * quietly while nothing changes; navigation rejects the pending call and the
 * catch-and-retry reinstalls the observer on the fresh document.
 */
function startChromeSync(win: BrowserWindow): void {
  void syncOverlayOnce(win)
  win.on('show', () => void syncOverlayOnce(win))
  win.webContents.on('did-finish-load', () => {
    installDesktopChrome(win)
    void syncOverlayOnce(win)
  })
  void (async () => {
    while (!win.isDestroyed()) {
      try {
        const color = await win.webContents.executeJavaScript(OBSERVER_SCRIPT)
        if (typeof color === 'string') applyOverlayColor(win, color)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  })()
}

/**
 * Desktop chrome injected into the dsh web UI (shell-side adaptation only;
 * the harness stays untouched).
 *
 * - Drag: the top bars (sidebar logo row + session header title row) become
 *   window-drag regions, with every interactive descendant opted back out via
 *   `no-drag` — unlike a fixed overlay strip this never swallows clicks on
 *   the header controls (mode / subagent / export buttons).
 * - Concession: when the details column is collapsed the session header runs
 *   under the native window buttons, so the right-aligned utilities list
 *   (session export) pads away from them.
 * Selectors key on CSS-module local names (built classes are
 * `<hash>_<localName>`, e.g. `Q1rQeq_titleRow`) and the frame's
 * `data-details-collapsed` attribute, both stable across hashed builds.
 */
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
body [data-details-collapsed] [class*="_headerUtilities"] { padding-right: ${WINDOW_CONTROLS_WIDTH}px; }
/* Fallback drag bar for the main column: the session title bar only exists
   once a session is open, so on the welcome/empty state the whole top strip
   right of the sidebar had no drag region. :has() scopes the bar to that
   case only — when a titleRow renders it owns the drag region instead. */
body [class*="_centerCol"] { position: relative; }
body [class*="_centerCol"]:not(:has([class*="_titleRow"]))::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: ${OVERLAY_HEIGHT}px;
  -webkit-app-region: drag;
  z-index: 5;
}
/* The settings dialog floats above the frame, so the frame's drag regions are
   masked while it is open; give the panel its own title strip instead. The
   panel is position:relative, so the bar hugs its top edge; header controls
   opt back out below. */
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

/** Inject the desktop chrome stylesheet once per document. */
function installDesktopChrome(win: BrowserWindow): void {
  win.webContents
    .executeJavaScript(
      `(function () {
        if (document.getElementById('dsh-desktop-chrome')) return;
        const el = document.createElement('style');
        el.id = 'dsh-desktop-chrome';
        el.textContent = ${JSON.stringify(DESKTOP_CHROME_CSS)};
        document.head.appendChild(el);
      })()`,
    )
    .catch(() => undefined)
}

/**
 * Shell-side export feedback: the in-page export dialog can be swallowed by
 * ancestor transforms/filters in some layouts, so when the Electron download
 * manager completes a dsh-session ZIP we inject a transient toast as a
 * guaranteed-visible confirmation. Pure shell adaptation; harness untouched.
 */
function installExportToast(win: BrowserWindow): void {
  win.webContents.session.on('will-download', (_event, item) => {
    const name = item.getFilename()
    if (!name.startsWith('dsh-session-') || !name.endsWith('.zip')) return
    item.once('done', (_e, state) => {
      const ok = state === 'completed'
      const text = ok ? 'Session 导出完成，已开始下载' : 'Session 导出失败'
      win.webContents
        .executeJavaScript(
          `(function () {
            const old = document.getElementById('dsh-export-toast');
            if (old) old.remove();
            const el = document.createElement('div');
            el.id = 'dsh-export-toast';
            el.setAttribute('role', 'status');
            el.textContent = ${JSON.stringify(text)};
            el.style.cssText =
              'position:fixed;top:48px;left:50%;transform:translateX(-50%);' +
              'z-index:2147483647;padding:8px 16px;border-radius:10px;' +
              'font-size:13px;line-height:1.4;color:#fff;' +
              'background:${ok ? 'rgba(75, 103, 252, 0.92)' : 'rgba(190, 44, 44, 0.92)'};' +
              'box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;' +
              'transition:opacity .4s;opacity:1;';
            document.body.appendChild(el);
            setTimeout(() => { el.style.opacity = '0'; }, 3200);
            setTimeout(() => { el.remove(); }, 3800);
          })()`,
        )
        .catch(() => undefined)
    })
  })
}

/**
 * Main window: loads the local dsh web UI. All navigation is confined to the
 * local server origin; everything else opens in the system browser.
 */
export function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({ ...MAIN_WINDOW_OPTS, show: false })
  win.once('ready-to-show', () => win.show())

  // Real-time overlay sync: an injected page observer pushes the effective
  // strip color the moment it changes (theme switch, modal mask open/close,
  // resize) — no polling lag.
  startChromeSync(win)

  installExportToast(win)

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    const allowed = new URL(target)
    if (allowed.hostname !== DEFAULT_HTTP_HOST) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })

  void win.loadURL(url)
  return win
}

/**
 * Setup window: shown before the kernel is ready (first run, repair,
 * update install). A tiny static page wired through a contextBridge preload.
 */
export function createSetupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 380,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'DSH App — 安装',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'static', 'setup-preload.js'),
    },
  })
  void win.loadFile(path.join(__dirname, '..', 'static', 'setup.html'))
  return win
}
