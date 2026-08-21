/**
 * In-window update status card script (pure, testable).
 *
 * Renders a compact fixed top-center card into a loaded page: a leading icon
 * (spinner for progress, ✓ success, ✕ error) plus the phase message and an
 * optional determinate progress bar (0..1). The card reuses one element
 * (`dsh-update-card`) and clears any pending auto-hide timer, so rapid
 * progress updates never stack timers or leak stale cards. It runs inside the
 * sandboxed dsh web UI via executeJavaScript — shell-side adaptation only.
 *
 * Kept in its own module so scripts/probe-update-card.cjs can execute the
 * exact production script against a DOM stub instead of duplicating it.
 */

export type UpdateCardTone = 'progress' | 'success' | 'error'

export interface UpdateCardPayload {
  message: string
  progress: number | null
  tone: UpdateCardTone
  /** Auto-hide after this many ms; 0/undefined keeps the card until cleared. */
  autoHide?: number
}

const TONE_BG: Record<UpdateCardTone, string> = {
  progress: 'rgba(75, 103, 252, 0.92)',
  success: 'rgba(34, 139, 80, 0.90)',
  error: 'rgba(190, 44, 44, 0.92)',
}

export const UPDATE_CARD_SCRIPT = (payload: UpdateCardPayload): string => `(function () {
  const p = ${JSON.stringify(payload)};
  const id = 'dsh-update-card';
  // One <style> per document for the spinner keyframes.
  if (!document.getElementById('dsh-card-style')) {
    const style = document.createElement('style');
    style.id = 'dsh-card-style';
    style.textContent = '@keyframes dshCardSpin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }
  let root = document.getElementById(id);
  if (!root) {
    root = document.createElement('div');
    root.id = id;
    root.setAttribute('role', 'status');
    document.body.appendChild(root);
  }
  const bg = ${JSON.stringify(TONE_BG)}[p.tone];
  root.style.cssText =
    'position:fixed;top:48px;left:50%;transform:translateX(-50%);' +
    'z-index:2147483647;display:flex;align-items:center;gap:10px;' +
    'max-width:520px;padding:8px 14px;border-radius:10px;font-size:13px;' +
    'line-height:1.5;color:#fff;background:' + bg + ';' +
    'box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;' +
    'transition:opacity .3s;opacity:1;' +
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;';
  root.textContent = '';
  // Icon
  const icon = document.createElement('div');
  const iconCommon = 'flex:0 0 16px;width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;';
  if (p.tone === 'progress') {
    icon.style.cssText = iconCommon +
      'border:2px solid rgba(255,255,255,.4);border-top-color:#fff;' +
      'animation:dshCardSpin .8s linear infinite;';
  } else {
    icon.style.cssText = iconCommon + 'background:rgba(255,255,255,.25);font-size:11px;line-height:1;';
    icon.textContent = p.tone === 'success' ? '✓' : '✕';
  }
  root.appendChild(icon);
  // Content column
  const content = document.createElement('div');
  content.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:0;';
  const text = document.createElement('div');
  text.textContent = p.message;
  content.appendChild(text);
  if (typeof p.progress === 'number') {
    const bar = document.createElement('div');
    bar.style.cssText = 'height:4px;border-radius:2px;background:rgba(255,255,255,.35);overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:' + Math.min(100, Math.max(0, Math.round(p.progress * 100))) + '%;background:#fff;transition:width .2s ease;';
    bar.appendChild(fill);
    content.appendChild(bar);
  }
  root.appendChild(content);
  const KEY = '__dshCardTimer';
  if (window[KEY]) { clearTimeout(window[KEY]); window[KEY] = null; }
  if (p.autoHide) {
    window[KEY] = setTimeout(function () {
      root.style.opacity = '0';
      setTimeout(function () { root.remove(); }, 400);
    }, p.autoHide);
  }
})()`