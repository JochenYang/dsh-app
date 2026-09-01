import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import type { KernelPhase, KernelStatusPayload } from '../shared/types'
import { UPDATE_CARD_SCRIPT, type UpdateCardTone } from './update-card'

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
  title: 'DSH APP',
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
    reinjectKernelProgress(win)
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
   strip stops at the header's own top padding (20px) so it never covers the
   header buttons: an absolutely positioned ::before paints above normal flow,
   and a drag strip overlapping a button would swallow clicks on its upper
   half even with the button marked no-drag. Below the strip the header row
   itself carries the drag region (blank areas drag, buttons opt back out).
   Geometry keeps everything clear of the native window controls for free:
   the centered panel always starts >=24px below the viewport top and the
   header padding adds 20 more, so buttons sit at >=44px — below the 36px
   overlay strip — at every window size. */
body [class*="_panel"]::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 20px;
  -webkit-app-region: drag;
  z-index: 0;
}
/* Header blank areas drag the window; controls opt back out (same pattern as
   the frame's logoRow/titleRow). This restores the native layout: buttons
   return to their original position, on the same axis as the nav title. */
body [class*="_panel"] [class*="_header"] { -webkit-app-region: drag; }
/* The header rule above also catches headers that ARE buttons: a plugin
   disclosure card (ui-settings-plugins header button) would otherwise be
   swallowed by the drag region and never receive clicks. The button itself
   opts back out; blank header areas of non-button headers keep dragging. */
body [class*="_panel"] button[class*="_header"] { -webkit-app-region: no-drag; }
/* Header controls (buttons, links, and any role=button element) stay clickable. */
body [class*="_panel"] [class*="_header"] button,
body [class*="_panel"] [class*="_header"] a,
body [class*="_panel"] [class*="_header"] [role="button"],
body [class*="_panel"] [class*="_header"] [class*="button"],
body [class*="_panel"] [class*="_header"] [class*="Button"],
body [class*="_panel"] [class*="_close"],
body [class*="_panel"] [class*="Close"] { -webkit-app-region: no-drag; }
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
 * Shell-side export feedback for dsh-session ZIP downloads.
 *
 * The harness web UI owns the export flow: an in-page modal tracks the export
 * and, once the browser download is handed off, parks on a browser-oriented
 * "download started" state until it is manually closed. On the desktop the
 * file lands in the OS Downloads folder moments later, so that copy is stale
 * and the lingering modal is noise. When the Electron download manager
 * settles:
 *
 *   - completed: dismiss the export modal (matched by its "Session" dialog
 *     aria-label — both locales title it with "Session" — and closed through
 *     its own close button so the harness dismiss path runs), then toast
 *     where the file was actually saved;
 *   - otherwise: toast the failure reason; the modal stays on its own error
 *     state, which is the harness's surface for export-time failures.
 *
 * Pure shell adaptation; harness untouched.
 */
function installExportToast(win: BrowserWindow): void {
  win.webContents.session.on('will-download', (_event, item) => {
    const name = item.getFilename()
    if (!name.startsWith('dsh-session-') || !name.endsWith('.zip')) return
    item.once('done', (_e, state) => {
      const ok = state === 'completed'
      const reason = state === 'cancelled' ? '已取消' : state === 'interrupted' ? '已中断' : state
      const title = ok ? 'Session 导出完成' : 'Session 导出失败'
      const detail = ok ? `已保存到：${item.getSavePath() || name}` : reason
      // Desktop: the download has settled, so the modal's "download started"
      // state is stale. Route through its own close button (React onClick),
      // not a synthetic Escape, so only the export dialog is affected.
      const dismissModal = ok
        ? `for (const dialog of document.querySelectorAll('[role="dialog"][aria-label]')) {
             if (!dialog.getAttribute('aria-label').includes('Session')) continue
             const close = dialog.querySelector('button[aria-label]')
             if (close) close.click()
           }`
        : ''
      win.webContents
        .executeJavaScript(
          `(function () {
            const old = document.getElementById('dsh-export-toast');
            if (old) old.remove();
            ${dismissModal}
            const el = document.createElement('div');
            el.id = 'dsh-export-toast';
            el.setAttribute('role', 'status');
            el.style.cssText =
              'position:fixed;top:48px;left:50%;transform:translateX(-50%);' +
              'z-index:2147483647;padding:10px 18px;border-radius:10px;' +
              'font-size:13px;line-height:1.5;color:#fff;max-width:min(90vw,640px);' +
              'background:${ok ? 'rgba(75, 103, 252, 0.92)' : 'rgba(190, 44, 44, 0.92)'};' +
              'box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;' +
              'transition:opacity .4s;opacity:1;';
            const title = document.createElement('div');
            title.textContent = ${JSON.stringify(title)};
            const detail = document.createElement('div');
            detail.textContent = ${JSON.stringify(detail)};
            detail.style.cssText =
              'font-size:12px;opacity:.85;word-break:break-all;margin-top:2px;';
            el.appendChild(title);
            el.appendChild(detail);
            document.body.appendChild(el);
            setTimeout(() => { el.style.opacity = '0'; }, 4200);
            setTimeout(() => { el.remove(); }, 4800);
          })()`,
        )
        .catch(() => undefined)
    })
  })
}

/**
 * In-window update status card state + APIs. The injected page script lives in
 * update-card.ts (pure and probe-testable); this module owns the per-process
 * state and the window wiring.
 */

/** Terminal phases that are not re-injected after a page reload. */
const TERMINAL_PHASES: ReadonlySet<KernelPhase> = new Set(['idle', 'ready'])

let activeKernelStatus: KernelStatusPayload | null = null

function toneForPhase(phase: KernelPhase): UpdateCardTone {
  if (phase === 'error') return 'error'
  if (phase === 'ready') return 'success'
  return 'progress'
}

function autoHideForPhase(phase: KernelPhase): number | undefined {
  if (phase === 'error') return 5_000
  if (phase === 'ready') return 1_200
  return undefined
}

/** Inject (or update) the update status card in a window. */
export function showKernelProgress(win: BrowserWindow | null, status: KernelStatusPayload): void {
  // `ready` is terminal: drop the stored status so a later did-finish-load
  // reinjection cannot resurrect a stale phase (e.g. "starting") after the
  // server already restarted — that was a stuck-card race on healthy boots.
  if (status.phase === 'ready') activeKernelStatus = null
  else activeKernelStatus = status
  if (!win || win.isDestroyed()) return
  // A plain boot "ready" is not an event worth a toast (the tray tooltip still
  // reflects it); only update flows (e.g. "已激活 dsh X") show a success card.
  if (status.phase === 'ready' && status.message === '就绪') {
    clearKernelProgress(win)
    return
  }
  win.webContents
    .executeJavaScript(
      UPDATE_CARD_SCRIPT({
        message: status.message,
        progress: status.progress,
        tone: toneForPhase(status.phase),
        autoHide: autoHideForPhase(status.phase),
      }),
    )
    .catch(() => undefined)
}

/** Re-inject the active status after a page reload (server restart mid-update). */
function reinjectKernelProgress(win: BrowserWindow): void {
  const status = activeKernelStatus
  if (!status || TERMINAL_PHASES.has(status.phase)) return
  showKernelProgress(win, status)
}

/** Transient notification toast (e.g. background update findings). */
export function showUpdateToast(win: BrowserWindow | null, message: string, tone: UpdateCardTone = 'progress', durationMs = 6_000): void {
  if (!win || win.isDestroyed()) return
  win.webContents
    .executeJavaScript(UPDATE_CARD_SCRIPT({ message, progress: null, tone, autoHide: durationMs }))
    .catch(() => undefined)
}

/**
 * One-shot toast that waits for the window's current page to finish loading
 * before injecting. A loadURL in flight replaces the old document, so a toast
 * injected during the reload would be destroyed almost immediately (this is
 * the normal path after a server restart, e.g. kernel-update success and the
 * previous-install-result notice). Times out after 10 s instead of hanging.
 */
export async function showToastWhenLoaded(win: BrowserWindow | null, message: string, tone: UpdateCardTone = 'progress', durationMs = 5_000): Promise<void> {
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (wc.isLoading()) {
    const loaded = new Promise<void>((resolve) => wc.once('did-finish-load', () => resolve()))
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 10_000))])
  }
  showUpdateToast(win, message, tone, durationMs)
}

/** Remove the update status card immediately. */
export function clearKernelProgress(win: BrowserWindow | null): void {
  activeKernelStatus = null
  if (!win || win.isDestroyed()) return
  win.webContents
    .executeJavaScript(`(function () { const el = document.getElementById('dsh-update-card'); if (el) el.remove(); })()`)
    .catch(() => undefined)
}

/**
 * Main window: loads the local dsh web UI. All navigation is confined to the
 * local server origin (host AND port); everything else opens in the system
 * browser. A hostname-only check would let any 127.0.0.1:<other-port> page
 * (e.g. a local dev server) load inside the app window.
 */
export function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({ ...MAIN_WINDOW_OPTS, show: false })
  win.once('ready-to-show', () => win.show())

  // Real-time overlay sync: an injected page observer pushes the effective
  // strip color the moment it changes (theme switch, modal mask open/close,
  // resize) — no polling lag.
  startChromeSync(win)

  installExportToast(win)

  // Origin of the dsh server the window was created for. If the URL cannot be
  // parsed (should never happen; the shell builds it), no origin is allowed.
  let serverOrigin = ''
  try {
    serverOrigin = new URL(url).origin
  } catch {
    // leave empty — navigation falls back to external
  }

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    // Same-origin window.open (e.g. the Models settings page opening a
    // sub-view) should open inside the app, not be kicked to the browser.
    try {
      const parsed = new URL(target)
      if (serverOrigin !== '' && parsed.origin === serverOrigin) {
        return { action: 'allow', overrideBrowserWindowOptions: MAIN_WINDOW_OPTS }
      }
    } catch {
      // not a valid URL — fall through to external
    }
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    let allowed = false
    try {
      allowed = serverOrigin !== '' && new URL(target).origin === serverOrigin
    } catch {
      // not a valid URL — treat as external
    }
    if (!allowed) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })

  void win.loadURL(url)
  return win
}

/**
 * Setup window: removed — kernel install/repair now runs silently in the
 * background (the main window appears when the server is healthy). The static
 * setup UI (setup.html/preload) was deleted together with this function.
 */
