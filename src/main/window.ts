import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import type { KernelPhase, KernelStatusPayload } from '../shared/types'
import { kernelChannelLabel, t } from '../shared/locale'
import { APP_ORIGIN, APP_URL } from './desktop-host'
import { UPDATE_CARD_SCRIPT, UPDATE_CARD_TONE_BG, KERNEL_UPDATE_CARD_SCRIPT, type KernelUpdateCardOption, type UpdateCardTone } from './update-card'

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
/* Sidebar foot: upstream renders the plugin action row (sidebar.footer.action)
   as a flex ROW, so two suite entries — the market plus any third-party one —
   shrink side by side and cram above the settings seat. Stack them instead, one
   full-width row per entry, in registration order; a single entry lays out
   exactly as before. */
body [class*="_footerActions"] { flex-direction: column; align-items: stretch; }
body [class*="_footerActions"] > * { flex: none; width: 100%; }
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
 * Main window: loads the local dsh web UI. All navigation is confined to the
 * local server origin (host AND port); other http(s) URLs open in the system
 * browser. A hostname-only check would let any 127.0.0.1:<other-port> page
 * (e.g. a local dev server) load inside the app window.
 */
/**
 * The loading page, loaded by the main window before the kernel is up. Same
 * file the standalone splash used (static/startup.html → dist/static), so its
 * state contract with startup-window.ts is unchanged.
 */
const SPLASH_PAGE = path.join(__dirname, '..', 'static', 'startup.html')

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
 * The navigation guard allows exactly one in-app origin, {@link APP_ORIGIN},
 * for the window's whole life: the UI's URL no longer contains a port that a
 * kernel update could change, so there is nothing to re-arm. The splash is a
 * file:// document and is allowed through as the shell's own doing.
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({ ...MAIN_WINDOW_OPTS, show: false })
  win.once('ready-to-show', () => win.show())
  // The splash installs the same state handlers the standalone window did, so
  // the shell keeps driving it through updateStartupWindow/showStartupFailure.
  markLoadingPage(win)
  void win.loadFile(SPLASH_PAGE)

  // Real-time overlay sync: an injected page observer pushes the effective
  // strip color the moment it changes (theme switch, modal mask open/close,
  // resize) — no polling lag.
  startChromeSync(win)

  installExportToast(win)

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    // Same-origin window.open (e.g. the Models settings page opening a
    // sub-view) should open inside the app, not be kicked to the browser.
    try {
      if (new URL(target).origin === APP_ORIGIN) {
        return { action: 'allow', overrideBrowserWindowOptions: MAIN_WINDOW_OPTS }
      }
    } catch {
      // not a valid URL — fall through to external
    }
    openExternalSafe(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    // The splash is a file:// document: navigating to it (or reloading it) is
    // the shell's own doing, never an external link.
    if (target.startsWith('file:')) return
    let allowed = false
    try {
      allowed = new URL(target).origin === APP_ORIGIN
    } catch {
      // not a valid URL — treat as external
    }
    if (!allowed) {
      event.preventDefault()
      openExternalSafe(target)
    }
  })

  return win
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

