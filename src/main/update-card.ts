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
  const clampWidth = function (v) {
    return Math.min(100, Math.max(0, Math.round(v * 100))) + '%';
  };
  const makeBar = function (content) {
    const bar = document.createElement('div');
    bar.style.cssText = 'height:4px;border-radius:2px;background:rgba(255,255,255,.35);overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:0;background:#fff;transition:width .2s ease;';
    bar.appendChild(fill);
    content.appendChild(bar);
    return { bar: bar, fill: fill };
  };
  let root = document.getElementById(id);
  // Same-tone fast path: update the message and progress bar in place.
  // Rebuilding the icon would restart its CSS animation on every throttled
  // progress callback (~4/s during a download), so the spinner would twitch
  // at a quarter turn instead of ever completing a rotation.
  const st = root && root.__dshCard;
  if (st && st.tone === p.tone) {
    st.text.textContent = p.message;
    if (typeof p.progress === 'number') {
      if (!st.bar) {
        const made = makeBar(st.content);
        st.bar = made.bar;
        st.fill = made.fill;
      }
      st.fill.style.width = clampWidth(p.progress);
    } else if (st.bar) {
      st.bar.remove();
      st.bar = null;
      st.fill = null;
    }
    root.style.opacity = '1';
  } else {
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
    root.appendChild(content);
    let bar = null;
    let fill = null;
    if (typeof p.progress === 'number') {
      const made = makeBar(content);
      bar = made.bar;
      fill = made.fill;
      fill.style.width = clampWidth(p.progress);
    }
    root.__dshCard = { tone: p.tone, content: content, text: text, bar: bar, fill: fill };
  }
  const KEY = '__dshCardTimer';
  if (window[KEY]) { clearTimeout(window[KEY]); window[KEY] = null; }
  if (p.autoHide) {
    window[KEY] = setTimeout(function () {
      root.style.opacity = '0';
      // Track the removal too, so a status arriving inside the fade window
      // cancels the pending remove instead of only the outer delay.
      window[KEY] = setTimeout(function () { root.remove(); window[KEY] = null; }, 400);
    }, p.autoHide);
  }
})()`

/**
 * Persistent "kernel update available" card script (pure, testable).
 *
 * Renders a fixed bottom-right card into the loaded dsh web UI: a heading
 * (`dsh <current> → <latest>`) plus a `稍后` / `立即更新` button pair. Unlike
 * {@link UPDATE_CARD_SCRIPT} it never auto-hides — the background kernel
 * check surfaces its finding once, and the card stays until the user either
 * acts on it or closes it, so a quiet update is not missed while remaining
 * non-blocking (in contrast to the modal in-frame dialog, which interrupts
 * whatever the user is doing).
 *
 * The promise it returns is what the shell's `executeJavaScript` awaits: it
 * resolves with 'update' or 'later' when the user clicks the matching button,
 * and with 'later' when a re-invocation replaces the card (each invocation is
 * a fresh card; a stale one settles as 'later').
 *
 * Kept in this module for the same reason as UPDATE_CARD_SCRIPT: probe
 * scripts execute it against a DOM stub to verify behavior.
 */
export const KERNEL_UPDATE_CARD_SCRIPT = (payload: { current: string; latest: string }): string => `(function () {
  'use strict';
  var cfg = ${JSON.stringify(payload)};
  var id = 'dsh-kernel-update-card';
  var KEY = '__dshKernelUpdateCard';
  // A re-invocation must not leave two cards (or one stale promise) behind:
  // settle the previous instance as 'later' before mounting the new one.
  var prev = window[KEY];
  if (prev && prev.resolve) prev.resolve('later');
  var resolveChoice = null;
  var promise = new Promise(function (resolve) { resolveChoice = resolve; });
  window[KEY] = { resolve: resolveChoice };

  // Theme tokens with neutral fallbacks (same policy as in-frame-dialog).
  var cv = getComputedStyle(document.body);
  function token(name, fallback) {
    var v = cv.getPropertyValue(name).trim();
    return v !== '' ? v : fallback;
  }
  var bg = token('--dsw-alias-bg-layer-1', '#ffffff');
  var ink = token('--dsw-alias-label-primary', '#0f172a');
  var inkSecondary = token('--dsw-alias-label-secondary', '#475569');
  var border = token('--dsw-alias-border-l1', 'rgba(15, 23, 42, 0.06)');
  var brand = token('--dsw-alias-brand-primary', '#3b82f6');

  var old = document.getElementById(id);
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var root = document.createElement('div');
  root.id = id;
  root.setAttribute('role', 'status');
  function style(el, css) { el.style.cssText = css; }
  style(root,
    'position:fixed;right:20px;bottom:20px;z-index:2147483646;' +
    'display:flex;flex-direction:column;gap:10px;max-width:340px;' +
    'padding:14px 16px;border-radius:12px;background:' + bg + ';' +
    'border:1px solid ' + border + ';box-shadow:0 8px 24px rgba(0,0,0,.22);' +
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;');

  var title = document.createElement('div');
  style(title, 'font-size:13px;font-weight:600;color:' + ink + ';line-height:1.5;');
  title.textContent = '发现新版本 dsh ' + cfg.latest;
  root.appendChild(title);

  var detail = document.createElement('div');
  style(detail, 'font-size:12px;color:' + inkSecondary + ';line-height:1.6;');
  detail.textContent = '当前版本 dsh ' + cfg.current + '。更新将下载新运行时并重启服务。';
  root.appendChild(detail);

  function button(spec) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = spec.label;
    var base =
      'cursor:pointer;padding:7px 14px;border-radius:8px;font-size:13px;' +
      'line-height:1.5;font-family:inherit;';
    if (spec.primary) {
      style(btn, base + 'background:' + brand + ';color:#fff;border:1px solid transparent;font-weight:500;');
    } else {
      style(btn, base + 'background:transparent;color:' + ink + ';border:1px solid ' + border + ';');
    }
    btn.addEventListener('click', function () { resolveChoice(spec.value); });
    return btn;
  }

  var actions = document.createElement('div');
  style(actions, 'display:flex;gap:8px;justify-content:flex-end;margin-top:2px;');
  actions.appendChild(button({ label: '稍后', value: 'later' }));
  actions.appendChild(button({ label: '立即更新', value: 'update', primary: true }));
  root.appendChild(actions);
  document.body.appendChild(root);

  promise.then(function () {
    if (root.parentNode) root.parentNode.removeChild(root);
    if (window[KEY]) window[KEY] = null;
  });

  return promise;
})()`