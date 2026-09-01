/**
 * In-window themed dialog script (pure, testable).
 *
 * Renders a themed modal into the loaded dsh web UI: a mask + a centered card
 * with an optional title, message, and detail line, and a configurable button
 * list. All colors come from the live `--dsw-alias-*` theme tokens (with hard
 * fallbacks), so the dialog follows the dsh light/dark theme instead of the
 * OS-native message box.
 *
 * The script is parameterized by { title, message, detail, buttons } where
 * buttons is [{ label, value, primary? }]. It resolves to the chosen button's
 * value ('cancel' for Esc/mask-click, the default value for Enter). Replaces
 * one instance at a time: a re-invocation settles the previous unresolved
 * promise as 'cancel'.
 *
 * Kept in its own module so scripts/probe-in-frame-dialog.cjs can execute the
 * exact production script against a DOM stub instead of duplicating it.
 */

/** The parameter object baked into {@link IN_FRAME_DIALOG_SCRIPT}. */
export interface InFrameDialogConfig {
  /** Optional card title. */
  title?: string
  /** Primary message line. */
  message: string
  /** Optional secondary detail line (mutually exclusive with the title's role). */
  detail?: string
  /** Buttons in render order; values are what the resolved promise carries. */
  buttons: ReadonlyArray<{
    label: string
    value: string
    /** Render as the filled primary button (also the Enter default). */
    primary?: boolean
  }>
  /** Value resolved on Esc/mask click/prior-invocation dedup. */
  cancelValue?: string
  /** Value resolved on Enter; defaults to the primary button's value. */
  enterValue?: string
  /** Root element id; defaults to the shared generic one. */
  rootId?: string
}

const FALLBACKS = {
  bg: '#ffffff',
  ink: '#0f172a',
  inkSecondary: '#475569',
  border: 'rgba(15, 23, 42, 0.06)',
  brand: '#3b82f6',
}

/** Build the one-shot in-page script for a config. */
export const inFrameDialogScript = (config: InFrameDialogConfig): string => `(function () {
  'use strict';
  var cfg = ${JSON.stringify(config)};
  var ROOT_ID = cfg.rootId || 'dsh-in-frame-dialog';
  var cancelValue = cfg.cancelValue || 'cancel';
  var enterValue = cfg.enterValue || (cfg.buttons.find(function (b) { return b.primary; }) || cfg.buttons[0]).value;
  var resolveChoice = null;
  // Dedup: a previous invocation's resolver (if any) settles as cancelled.
  // The registry key derives from the root id so overlapping dialogs with
  // different ids do not cancel each other.
  var REGISTRY_KEY = '__dshInFrameDialog_' + ROOT_ID;
  var previous = window[REGISTRY_KEY];
  if (previous && previous.resolve) previous.resolve(cancelValue);
  var promise = new Promise(function (resolve) { resolveChoice = resolve; });
  window[REGISTRY_KEY] = { resolve: resolveChoice };

  // Theme tokens: dsh's own alias palette, with neutral fallbacks so the
  // dialog stays legible even when the theme plugin has not applied yet.
  var cv = getComputedStyle(document.body);
  function token(name, fallback) {
    var v = cv.getPropertyValue(name).trim();
    return v !== '' ? v : fallback;
  }
  var bg = token('--dsw-alias-bg-layer-1', ${JSON.stringify(FALLBACKS.bg)});
  var ink = token('--dsw-alias-label-primary', ${JSON.stringify(FALLBACKS.ink)});
  var inkSecondary = token('--dsw-alias-label-secondary', ${JSON.stringify(FALLBACKS.inkSecondary)});
  var border = token('--dsw-alias-border-l1', ${JSON.stringify(FALLBACKS.border)});
  var brand = token('--dsw-alias-brand-primary', ${JSON.stringify(FALLBACKS.brand)});

  function style(el, css) { el.style.cssText = css; }
  function button(spec) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = spec.label;
    btn.className = 'dsh-in-frame-dialog-btn';
    var base =
      'cursor:pointer;padding:8px 16px;border-radius:8px;font-size:13px;' +
      'line-height:1.5;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;';
    if (spec.primary) {
      style(btn, base +
        'background:' + brand + ';color:#fff;border:1px solid transparent;' +
        'font-weight:500;');
    } else {
      style(btn, base +
        'background:transparent;color:' + ink + ';border:1px solid ' + border + ';');
    }
    btn.addEventListener('click', function () { resolveChoice(spec.value); });
    return btn;
  }

  // Remove any stale instance first.
  var oldMask = document.getElementById(ROOT_ID);
  if (oldMask && oldMask.parentNode) oldMask.parentNode.removeChild(oldMask);

  var mask = document.createElement('div');
  mask.id = ROOT_ID;
  mask.setAttribute('role', 'presentation');
  style(mask,
    'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,.35);' +
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;');
  // Click on the mask itself = cancel (the card stops propagation).
  mask.addEventListener('click', function (event) {
    if (event.target === mask) resolveChoice(cancelValue);
  });

  var card = document.createElement('div');
  card.className = 'dsh-in-frame-dialog-card';
  style(card,
    'position:relative;width:340px;max-width:calc(100vw - 48px);background:' + bg + ';' +
    'border:1px solid ' + border + ';border-radius:12px;padding:20px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.28);');
  card.addEventListener('click', function (event) { event.stopPropagation(); });

  if (cfg.title !== undefined) {
    var title = document.createElement('div');
    title.className = 'dsh-in-frame-dialog-title';
    style(title, 'font-size:15px;font-weight:600;color:' + ink + ';margin-bottom:6px;');
    title.textContent = cfg.title;
    card.appendChild(title);
  }
  var message = document.createElement('div');
  message.className = 'dsh-in-frame-dialog-message';
  style(message,
    'font-size:13px;color:' + inkSecondary + ';line-height:1.6;' +
    (cfg.detail === undefined ? '' : 'margin-bottom:6px;'));
  message.textContent = cfg.message;
  card.appendChild(message);
  if (cfg.detail !== undefined) {
    var detail = document.createElement('div');
    detail.className = 'dsh-in-frame-dialog-detail';
    style(detail, 'font-size:12px;color:' + inkSecondary + ';line-height:1.6;margin-bottom:16px;');
    detail.textContent = cfg.detail;
    card.appendChild(detail);
  }

  var actions = document.createElement('div');
  actions.className = 'dsh-in-frame-dialog-actions';
  style(actions, 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;');
  for (var i = 0; i < cfg.buttons.length; i++) actions.appendChild(button(cfg.buttons[i]));

  card.appendChild(actions);
  mask.appendChild(card);
  document.body.appendChild(mask);

  // Keyboard: Esc = cancel, Enter = default. Removed on settle so a second
  // invocation cannot stack handlers.
  function onKey(event) {
    if (event.key === 'Escape') { resolveChoice(cancelValue); }
    else if (event.key === 'Enter') { resolveChoice(enterValue); }
  }
  document.addEventListener('keydown', onKey);
  promise.finally(function () {
    document.removeEventListener('keydown', onKey);
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    if (window[REGISTRY_KEY]) window[REGISTRY_KEY] = null;
  });

  // Return the promise: executeJavaScript awaits it, so the choice resolves
  // through the same channel as native showMessageBox.
  return promise;
})()`

