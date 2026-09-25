import { BrowserWindow, app, screen, shell } from 'electron'
import path from 'node:path'
import type { KernelPhase, KernelStatusPayload } from '../shared/types'
import { kernelChannelLabel, t } from '../shared/locale'
import { APP_URL } from './desktop-host'
import {
  readWindowBounds,
  resolveWindowGeometry,
  toWindowBounds,
  windowStateFile,
  writeWindowBounds,
  type WindowSize,
} from './window-bounds'
import { UPDATE_CARD_SCRIPT, UPDATE_CARD_TONE_BG, KERNEL_UPDATE_CARD_SCRIPT, type KernelUpdateCardOption, type UpdateCardTone } from './update-card'
import { isShellNavigationTarget, SPLASH_PAGE } from './nav-policy'

/** Height of the title-bar overlay (matches the injected drag top bars). */
const OVERLAY_HEIGHT = 36
/** Width reserved on the right for the native window-control buttons. */
const WINDOW_CONTROLS_WIDTH = 140
/** Last overlay color applied per window, so identical samples are no-ops. */
const appliedChromeColors = new WeakMap<BrowserWindow, string>()

/** Parse 'rgb(r, g, b)' / 'rgba(...)' into [r, g, b]; null when unparseable. */
function parseRgb(color: string): [number, number, number] | null {
  const m = color.match(/\d+/g)
  if (!m || m.length < 3) return null
  const [r, g, b] = m.slice(0, 3).map(Number)
  return [r, g, b]
}

/** '#rrggbb' from 'rgb(r, g, b)' / 'rgba(...)' strings. */
function rgbToHex(rgb: string): string {
  const parsed = parseRgb(rgb)
  if (!parsed) return '#ffffff'
  return `#${parsed.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`
}

/** Choose a readable window-button color for a given background. */
function symbolColorFor(bg: string): string {
  const parsed = parseRgb(bg)
  if (!parsed) return '#1a1a1a'
  const [r, g, b] = parsed
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.5 ? '#1a1a1a' : '#e0e0e0'
}

const MAIN_WINDOW_OPTS = {
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
    // ONE marker, and nothing else: the kernel's account UI exists only when the
    // page sees `window.dshDesktop` (`ui-settings-account/src/client/index.ts:28`
    // returns early without it), and without it the account section, sign-in
    // dialog and balance card are silently never registered. The preload exposes
    // that key and no channel — see src/main/account-preload.ts for what is
    // deliberately absent. Everything else still flows through the local server.
    preload: path.join(__dirname, 'account-preload.js'),
  },
} as const

/** Debounce before the window geometry is written to disk (resize/move end). */
const GEOMETRY_SAVE_DEBOUNCE_MS = 500

/**
 * How long the window waits for its first document before showing itself anyway.
 *
 * The splash is a local file, so it arrives in milliseconds; the bound only
 * fires when something is wrong (see `createMainWindow`), and a window on screen
 * beats no window at all.
 */
const SPLASH_SHOW_FALLBACK_MS = 10_000

/**
 * Opening size for the main window: the remembered geometry when there is one,
 * a size fitted to the display otherwise. The rules live in `window-bounds.ts`
 * so they can be driven by tests for displays this machine does not have.
 *
 * Called at window-creation time, never at module load: `screen` is not usable
 * before `app.ready`.
 */
function initialWindowGeometry(): WindowSize & { x?: number, y?: number } {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const saved = readWindowBounds(windowStateFile(app.getPath('userData')))
  return resolveWindowGeometry(saved, displays, primary.workArea)
}

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
 *
 * The promise must NOT resolve on entry once `last` is known. The shell's loop
 * re-enters on every resolution, so an eager resolve degrades into a tight
 * executeJavaScript ping-pong (measured ~5k round-trips/s, ~9% total CPU
 * across main + renderer, GPU idle at 0%). `push()` self-guards on an
 * unchanged sample, and that guard is what parks the loop.
 *
 * Every change gets TWO looks, and both are load-bearing:
 *
 * - the next animation frame, the fast path while the page paints;
 * - a 250 ms timer, the backstop. It is also the second look a CSS transition
 *   needs: the frame right after a class flip still shows the pre-transition
 *   geometry, so a panel sliding in over the sample point (the market drawer)
 *   is sampled while it is still off-screen. The sample then equals the
 *   recorded one, `push()` returns early, and NO further mutation ever comes —
 *   the strip kept the page colour over the drawer (measured). The timer also
 *   clears `scheduled`, which used to be cleared only inside the frame
 *   callback: frame callbacks stop while the window is occluded or hidden
 *   (Chromium throttles a non-visible page), so a single skipped frame latched
 *   the flag true and the observer went deaf for the rest of the document's
 *   life — the strip froze on a stale colour, the window was restored, and
 *   nothing (theme switch, modal mask, drawer) ever moved it again.
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
      const raf = window.requestAnimationFrame;
      if (typeof raf === 'function') raf(push);
      setTimeout(() => { scheduled = false; push(); }, 250);
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
    document.addEventListener('transitionend', schedule, true);
    document.addEventListener('animationend', schedule, true);
  }
  return new Promise((resolve) => {
    state.pending = resolve;
    push();
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
 * quietly while nothing changes.
 *
 * The observer lives IN the document, so it dies with the document it was
 * installed on — and a call still pending when that document navigates away
 * never settles (the frame it would answer from is gone; nothing rejects it).
 * The window now loads the splash first and the live UI second, so a single
 * loop parks on the splash for the rest of the session and the strip keeps
 * whatever the splash was painted in — observed as a white strip over the dark
 * UI, modal masks included. Each document therefore gets its own loop, and the
 * generations before it are retired so a late reply cannot repaint the strip
 * from the document the user already left.
 */
function startChromeSync(win: BrowserWindow): void {
  let generation = 0
  const sync = (): void => {
    const gen = ++generation
    void syncOverlayOnce(win)
    void (async () => {
      while (!win.isDestroyed() && gen === generation) {
        try {
          const color = await win.webContents.executeJavaScript(OBSERVER_SCRIPT)
          if (gen !== generation) return
          if (typeof color === 'string') applyOverlayColor(win, color)
        } catch {
          if (gen !== generation) return
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    })()
  }
  win.on('show', () => void syncOverlayOnce(win))
  win.webContents.on('did-finish-load', () => {
    installDesktopChrome(win)
    reinjectKernelProgress(win)
    sync()
  })
  sync()
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
/* The titleRow drag region spans the row's full box, which runs underneath the
   native window controls (min/max/close) — a drag region there swallows the
   mouse, so the buttons lose their hover. Punch a no-drag hole over the
   control strip: the topmost region wins, and this is the same pseudo-element
   mechanism the welcome-state drag bar above already relies on. The row gets
   position:relative so the hole anchors to the row, not to a tall ancestor. */
body [class*="_titleRow"] { position: relative; }
body [class*="_titleRow"]::after {
  content: "";
  position: absolute;
  top: 0; right: 0;
  width: ${WINDOW_CONTROLS_WIDTH}px;
  height: 100%;
  -webkit-app-region: no-drag;
}
body [data-details-collapsed] [class*="_headerUtilities"] { padding-right: ${WINDOW_CONTROLS_WIDTH}px; }
/* Alpha.1 removed the details column and added a far-right corner seat
   (data-conversation-header-corner, e.g. the sidebar expand button) that
   sits flush against the header's right edge — directly under the native
   window controls. Push the corner seat left of the controls; the flex row
   carries utilities along, and the vacated zone stays draggable via the
   titleRow drag region. (The details-collapsed rule above covers older
   kernels.) */
body [class*="_titleRow"]:has([data-conversation-header-corner]) [data-conversation-header-corner] { margin-right: ${WINDOW_CONTROLS_WIDTH}px; }
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
   masked while it is open; give the dialog its own title strip instead. The
   strip stops at the header's own top padding (20px) so it never covers the
   header buttons: an absolutely positioned ::before paints above normal flow,
   and a drag strip overlapping a button would swallow clicks on its upper
   half even with the button marked no-drag. Below the strip the header row
   itself carries the drag region (blank areas drag, buttons opt back out).
   Geometry keeps everything clear of the native window controls for free:
   the centered panel always starts >=24px below the viewport top and the
   header padding adds 20 more, so buttons sit at >=44px — below the 36px
   overlay strip — at every window size.
   Scoped by the dialog's own data-shortcut-modal="settings" marker, never
   by [class*="_panel"]: that matched every *_panel* class in the app —
   including the Team panel, whose skin is itself a ::before — and the strip's
   height/z-index overrode the skin, leaving the panel see-through (the skin
   only painted a 20px band). Measured: eleven elements matched, three of them
   unrelated overlays. */
body [data-shortcut-modal="settings"]::before {
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
body [data-shortcut-modal="settings"] [class*="_header"] { -webkit-app-region: drag; }
/* The header rule above also catches headers that ARE buttons: a plugin
   disclosure card (ui-settings-plugins header button) would otherwise be
   swallowed by the drag region and never receive clicks. The button itself
   opts back out; blank header areas of non-button headers keep dragging. */
body [data-shortcut-modal="settings"] button[class*="_header"] { -webkit-app-region: no-drag; }
/* Header controls (buttons, links, and any role=button element) stay clickable. */
body [data-shortcut-modal="settings"] [class*="_header"] button,
body [data-shortcut-modal="settings"] [class*="_header"] a,
body [data-shortcut-modal="settings"] [class*="_header"] [role="button"],
body [data-shortcut-modal="settings"] [class*="_header"] [class*="button"],
body [data-shortcut-modal="settings"] [class*="_header"] [class*="Button"],
body [data-shortcut-modal="settings"] [class*="_close"],
body [data-shortcut-modal="settings"] [class*="Close"] { -webkit-app-region: no-drag; }
/* Sidebar foot: upstream renders the plugin action row (sidebar.footer.action)
   as a flex ROW, so two suite entries — the market plus any third-party one —
   shrink side by side and cram above the settings seat. Stack them instead, one
   full-width row per entry, in registration order; a single entry lays out
   exactly as before. */
body [class*="_footerActions"] { flex-direction: column; align-items: stretch; }
body [class*="_footerActions"] > * { flex: none; width: 100%; }
/* rc.2 right dock sidebar: its tab strip carries the split / fullscreen /
   collapse buttons at the panel's top-right — under the native window
   controls. Pad the strip so they clear them (measured: the collapse button's
   right edge sat 42px past the strip's left edge). */
body [class*="_tabStrip"] { padding-right: ${WINDOW_CONTROLS_WIDTH}px; }
/* rc.2 schedule catalog (the 自动化任务 surface): its page heading carries the
   right-aligned create button under the native controls — pad the heading. */
body [class*="_pageHeading"] { padding-right: ${WINDOW_CONTROLS_WIDTH}px; }
/* Overlay skins in this kernel are painted on a ::before: a semi-transparent
   fill plus backdrop-filter (MenuSurface and the Team panel share the shape).
   This shell's window does not render that blur — measured on Windows: the
   identical page blurs in Chromium on the same machine, and in this window
   under software rendering, but not on the GPU path the app takes — so the
   fill alone reads see-through and page text shows through every menu. Upstream
   takes the same escape hatch on macOS, where the fill stays near-opaque for
   the same reason (ui-theme design-platform.css); apply it here for both
   themes. Both tokens are overridden: --dsw-specific-menu is the alias the
   Team panel consumes, --dsw-menu-surface-fill the value MenuSurface reads. */
html body {
  --dsw-menu-surface-fill: rgba(248, 249, 250, 0.96);
  --dsw-specific-menu: rgba(248, 249, 250, 0.96);
}
html body[data-ds-dark-theme] {
  --dsw-menu-surface-fill: rgba(40, 41, 45, 0.96);
  --dsw-specific-menu: rgba(40, 41, 45, 0.96);
}
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
/** Sessions already wired for the export toast (see installExportToast). */
const exportToastSessions = new WeakSet<Electron.Session>()

function installExportToast(win: BrowserWindow): void {
  const session = win.webContents.session
  // The download event lives on the SESSION, not the window, and the session
  // is shared: a rebuilt window (second-instance) would otherwise stack a
  // second listener and fire one toast per download. Install once per session
  // and address the downloading window through the event's own webContents,
  // so a rebuilt window gets its toast rather than a stale one's.
  if (exportToastSessions.has(session)) return
  exportToastSessions.add(session)
  session.on('will-download', (_event, item, contents) => {
    const name = item.getFilename()
    if (!name.startsWith('dsh-session-') || !name.endsWith('.zip')) return
    item.once('done', (_e, state) => {
      const ok = state === 'completed'
      const reason = state === 'cancelled' ? t('export.cancelled') : state === 'interrupted' ? t('export.interrupted') : state
      const title = ok ? t('export.completedTitle') : t('export.failedTitle')
      const detail = ok ? t('export.savedTo', { path: item.getSavePath() || name }) : reason
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
      if (contents.isDestroyed()) return
      contents
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
              'background:${ok ? UPDATE_CARD_TONE_BG.progress : UPDATE_CARD_TONE_BG.error};' +
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
  // The phase decides, not the wording: the line is localized, so matching its
  // text would only ever hold for one language.
  if (status.phase === 'ready') activeKernelStatus = null
  else activeKernelStatus = status
  if (!win || win.isDestroyed()) return
  // The loading page states the same thing in its own state line and step list,
  // so a card on top of it is a duplicate (reported twice, from a screenshot).
  // The status is still STORED above: once the real UI loads, a reload brings
  // the card back — which is what makes the tray's "restart server" visible.
  if (isShowingLoadingPage(win)) return
  // A plain boot "ready" is not an event worth a card (the tray tooltip still
  // reflects it), and a finished kernel update already painted its success card
  // from the 'installing' status.
  if (status.phase === 'ready') {
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

/**
 * Re-inject the active status after a page reload.
 *
 * Two callers matter and they want different things:
 *
 * - the REAL UI reloading (a kernel update restarted the server, or the tray's
 *   restart): the card must come back, because it is the only place that says
 *   "the kernel is being updated" / "the server is restarting" — a tray action
 *   with no visible effect would look broken;
 * - the LOADING PAGE finishing its load (the window is created before the
 *   kernel, so this fires on every boot): nothing to re-inject. That page shows
 *   the same status itself, in its own state line and step list, and an extra
 *   card at the top of it is a duplicate — measured on screen, twice.
 *
 * The document's own URL decides, which is the same signal the shell uses to
 * tell the two apart everywhere else (`isShowingLoadingPage` in index.ts).
 *
 * @param win - the window whose document just finished loading.
 */
function reinjectKernelProgress(win: BrowserWindow): void {
  if (isShowingLoadingPage(win)) return
  const status = activeKernelStatus
  if (!status || TERMINAL_PHASES.has(status.phase)) return
  showKernelProgress(win, status)
}

/**
 * Transient notification toast (e.g. background update findings).
 * @param durationMs - auto-hide delay; undefined keeps the card until cleared.
 */
export function showUpdateToast(win: BrowserWindow | null, message: string, tone: UpdateCardTone = 'progress', durationMs?: number): void {
  if (!win || win.isDestroyed()) return
  win.webContents
    .executeJavaScript(UPDATE_CARD_SCRIPT({ message, progress: null, tone, autoHide: durationMs }))
    .catch(() => undefined)
}

/**
 * Persistent "kernel update available" card for background checks (no toast,
 * no modal). Renders one button per installable option (primary line first)
 * plus the localized "later" button; resolves with the chosen version, or
 * 'later' once the user clicks it. Never auto-hides, so a background finding
 * stays visible until acted on. When the window is gone/unresponsive or the
 * page doesn't answer, it resolves 'later' (a pending rejection) rather than
 * crashing the caller.
 *
 * Every label is composed here, so the injected script (update-card.ts) only
 * carries text and stays free of translation logic.
 */
export async function showKernelUpdateCard(
  win: BrowserWindow | null,
  current: string,
  options: KernelUpdateCardOption[],
): Promise<string> {
  if (!win || win.isDestroyed()) return 'later'
  const multiple = options.length > 1
  try {
    const choice = await win.webContents
      .executeJavaScript(KERNEL_UPDATE_CARD_SCRIPT({
        current,
        options: options.map((o) => ({
          version: o.version,
          // Frozen card wording (§4.4): a single option reads "update now",
          // several name the channel so the picked line is unambiguous.
          label: multiple
            ? t('updateCard.optionWithChannel', { version: o.version, channel: kernelChannelLabel(o.channel) })
            : t('updateCard.optionNow', { version: o.version }),
          primary: o.primary,
        })),
        title: multiple ? t('updateCard.titleMulti') : t('updateCard.title'),
        detail: t('updateCard.detail', { current }),
        laterLabel: t('common.later'),
      }))
    return typeof choice === 'string' && choice !== '' ? choice : 'later'
  } catch {
    return 'later'
  }
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

/** Open only http(s) URLs in the system browser; non-web schemes are dropped. */
function openExternalSafe(target: string): void {
  let protocol = ''
  try {
    protocol = new URL(target).protocol
  } catch {
    return
  }
  if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(target)
}
/**
 * Main window: all navigation is confined to the app origin plus the shell's
 * own splash document (see nav-policy.ts); every other target — including any
 * other file: URL and any 127.0.0.1:<port> page — opens in the system browser
 * instead of in the window.
 */

/** Window background while the splash is up; the page paints the same value. */
const DEFAULT_BG = '#ffffff'

/**
 * Windows currently showing the loading page.
 *
 * An explicit flag rather than a look at the document URL: the shell broadcasts
 * its first status moments after creating the window, while the document is
 * still `about:blank`, so a URL test let an injection through that then landed
 * in whichever document committed next — the splash (measured, twice).
 * `createMainWindow` marks the window, `loadAppIntoWindow` clears it.
 */
const loadingPageWindows = new WeakSet<BrowserWindow>()

/**
 * Mark a window as showing the loading page.
 *
 * A shell-level concept rather than a detail of `createMainWindow`: the window
 * created for the boot shows the splash, and anything else that ever hosts that
 * page must say so the same way (a second host would otherwise re-introduce the
 * duplicate card this flag exists to prevent).
 *
 * @param win - the window about to load the loading page.
 */
export function markLoadingPage(win: BrowserWindow): void {
  loadingPageWindows.add(win)
}

/** Whether a window is still showing the loading page. */
export function isShowingLoadingPage(win: BrowserWindow | null): boolean {
  return win !== null && loadingPageWindows.has(win)
}

/**
 * Forget the overlay colour this window was last set to.
 *
 * The loading page paints the chrome from the SHELL's theme preference (it has
 * no page to read one from); the live UI paints it from the page's own palette,
 * through the chrome-sync loop. The sync loop skips a colour it believes is
 * already applied, so without this the splash's colour would stick — a white
 * strip over a dark app, which is exactly what a user saw after a hand-off.
 * Clearing the cache makes the next sample authoritative.
 *
 * @param win - the window whose overlay colour must be re-read.
 */
export function resetOverlayColor(win: BrowserWindow): void {
  appliedChromeColors.delete(win)
}

/**
 * Create the main window with the loading page in it.
 *
 * The window appears immediately and shows the LOCAL splash page; the caller
 * navigates it to the harness UI once the host is ready (see the window-first
 * boot in index.ts). This is the upstream desktop's own shape: the wait belongs
 * to a window that is already on screen, not to a second, smaller window that
 * then has to hand over. It also keeps the boot honest — everything the splash
 * used to report (staged progress, failures, retry) now happens in the window
 * the user will keep using.
 *
 * The navigation guard allows exactly one in-app origin, `dsh-app://app`
 * (nav-policy.ts owns the predicate), for the window's whole life: the UI's URL
 * no longer contains a port that a kernel update could change, so there is
 * nothing to re-arm. The splash file:// document is allowed through as the
 * shell's own doing — the resolved splash page, and no other file: target.
 *
 * The window is created hidden and put on screen as soon as its first document
 * is there. `ready-to-show` is the flash-free signal and is used where the
 * platform emits it, but this window's chrome — `titleBarStyle: 'hidden'`
 * together with a `titleBarOverlay` — suppresses it on Windows entirely: with
 * the same page and renderer, a plain window emits it at ~230 ms and this shape
 * never does (and `requestAnimationFrame` does not run while it is hidden
 * either, so nothing else reports a paint). The document's own load is the
 * trigger that does fire here, and waiting for it is not optional: the kernel
 * boot takes seconds (10.2 s measured on this machine on a production boot of
 * the 0.1.6-alpha.2 line), and a window that appears only once the host is ready
 * leaves the user staring at nothing for all of it, which is the one thing the
 * loading page exists to prevent. Showing there flashes nothing either: the
 * window's background colour is already the splash's own by then (see
 * startup-window.ts's applyWindowTheme).
 */
export function createMainWindow(): BrowserWindow {
  const geometry = initialWindowGeometry()
  const win = new BrowserWindow({ ...MAIN_WINDOW_OPTS, ...geometry, show: false })
  // Electron reports a MAXIMIZED window's bounds as the screen's own rect, so
  // persisting `getBounds()` on close would store "screen-sized at 0,0" and
  // lose the size the user had before they maximized. `getNormalBounds()` is
  // the pre-maximize rectangle, which is the one worth remembering.
  const rememberGeometry = (): void => {
    if (win.isDestroyed()) return
    const normal = win.getNormalBounds()
    writeWindowBounds(windowStateFile(app.getPath('userData')), {
      ...normal,
      maximized: win.isMaximized(),
    })
  }
  // Debounced: a drag fires `resize`/`move` continuously, and each one would
  // otherwise rewrite the file.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleGeometrySave = (): void => {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(rememberGeometry, GEOMETRY_SAVE_DEBOUNCE_MS)
    saveTimer.unref?.()
  }
  win.on('resize', scheduleGeometrySave)
  win.on('move', scheduleGeometrySave)
  win.on('maximize', scheduleGeometrySave)
  win.on('unmaximize', scheduleGeometrySave)
  win.on('close', () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    rememberGeometry()
  })
  // Restore the maximized state AFTER the window exists: `maximize()` before
  // the first paint is what makes the splash appear already maximized instead
  // of flashing a small window first.
  if (readWindowBounds(windowStateFile(app.getPath('userData')))?.maximized === true) {
    win.once('ready-to-show', () => { win.maximize() })
  }
  let fallback: ReturnType<typeof setTimeout> | undefined
  const showWhenReady = (): void => {
    if (fallback !== undefined) clearTimeout(fallback)
    if (!win.isDestroyed()) win.show()
  }
  win.once('ready-to-show', showWhenReady)
  // The trigger that actually fires for this window shape; see the note above.
  win.webContents.once('did-finish-load', showWhenReady)
  // Both triggers above belong to a document that has to ARRIVE. When it cannot
  // — a damaged install, security software blocking a read out of the asar, a
  // renderer that dies before its first paint — the window stays hidden for the
  // life of the process and the user sees nothing at all: no window, no failure
  // card (the splash's own handlers are not installed either), no dialog, while
  // the retry and rollback chain runs invisibly behind it. Showing the window
  // costs nothing by then — it already exists and its background is the splash's
  // own colour — so the failed load, a dead renderer, and a plain timeout all
  // put it on screen, and the shell can say what went wrong in it.
  win.webContents.once('did-fail-load', showWhenReady)
  win.webContents.once('render-process-gone', showWhenReady)
  fallback = setTimeout(showWhenReady, SPLASH_SHOW_FALLBACK_MS)
  fallback.unref?.()
  // The splash installs the same state handlers the standalone window did, so
  // the shell keeps driving it through updateStartupWindow/showStartupFailure.
  markLoadingPage(win)
  void win.loadFile(SPLASH_PAGE)

  // Real-time overlay sync: an injected page observer pushes the effective
  // strip color the moment it changes (theme switch, modal mask open/close,
  // resize) — no polling lag.
  startChromeSync(win)

  installExportToast(win)

  installNavigationFence(win)

  return win
}

/**
 * Install the navigation fence on a webContents.
 *
 * Extracted so the SAME fence covers every window the app opens:
 * `window.open` from the app origin is allowed (the Models settings page opens
 * a sub-view that way) and produces a child window whose webContents would
 * otherwise have no handlers at all — an unfenced, identical-looking window one
 * navigation away from any https page. The child is fenced by the
 * `did-create-window` hook below, which fires for exactly those windows.
 *
 * @param win - the window whose webContents gets the fence.
 */
function installNavigationFence(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    // Same-origin window.open (e.g. the Models settings page opening a
    // sub-view) should open inside the app, not be kicked to the browser.
    // The splash document is allowed as well: it is the shell's own file.
    if (isShellNavigationTarget(target)) {
      return { action: 'allow', overrideBrowserWindowOptions: MAIN_WINDOW_OPTS }
    }
    openExternalSafe(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    // The splash is a file:// document: navigating to it (or reloading it) is
    // the shell's own doing. Any OTHER file: target is an external ask from a
    // compromised page context and goes to the OS, never into this window.
    if (isShellNavigationTarget(target)) return
    event.preventDefault()
    openExternalSafe(target)
  })
  // A window this one opens (setWindowOpenHandler above allowed it) inherits
  // the fence; without this it would be the one unfenced window in the app.
  win.webContents.on('did-create-window', (child) => {
    installNavigationFence(child)
    // The chrome adaptation is per-window state, not per-session: the child
    // opens with the main window's options (titleBarOverlay included) but
    // nothing ever installs the injected stylesheet, the controls-width
    // concessions or the overlay color sync on it — observed on the schedule
    // catalog popup, whose own top-right create button sat under the native
    // window buttons while the strip kept the static light color. One call
    // wires the same did-finish-load chain the main window gets.
    startChromeSync(child)
  })
}

/**
 * Navigate the main window from the splash to the live UI.
 *
 * Separate from creation because the two happen seconds apart: the window is
 * shown first (with the splash), and this is called once the host is ready.
 *
 * @param win - the main window.
 */
export function loadAppIntoWindow(win: BrowserWindow): void {
  loadingPageWindows.delete(win)
  void win.loadURL(APP_URL)
}

