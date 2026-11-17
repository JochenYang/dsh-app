/**
 * The in-app changelog: the same data the About page reads, rendered as a
 * modal over the app window.
 *
 * Why it exists: the post-update notice must not send a mainland user to a
 * GitHub page they cannot open. The build already ships `dist/changelog.json`
 * (generated from `CHANGELOG.md`), so the notice's button opens this sheet — the
 * notes themselves, with no outbound link to depend on.
 *
 * Injected into the app document (shell-side chrome, no harness change): the
 * mask, Escape and the close button all tear it down, and opening it twice
 * replaces the first instance instead of stacking.
 *
 * @module dsh-app/main/changelog-dialog
 */
import { type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getLocale, t } from '../shared/locale'

/** One release as the generated file carries it. */
export interface ChangelogEntry {
  readonly version: string
  readonly date: string
  readonly bullets: readonly string[]
}

/**
 * Read the generated changelog, localized.
 *
 * A missing file (a dev tree before the first build) is an empty list: the
 * dialog then shows nothing rather than an error, because the build that ships
 * it always generates it.
 *
 * @param limit - at most this many versions, newest first.
 * @returns the entries for the active language.
 */
export function loadChangelog(limit = 5): ChangelogEntry[] {
  try {
    const raw = readFileSync(path.join(__dirname, '..', 'changelog.json'), 'utf8')
    const data = JSON.parse(raw) as { versions?: Array<{ version: string, date: string, zh: string[], en: string[] }> }
    const english = getLocale() === 'en-US'
    return (data.versions ?? []).slice(0, limit).map(({ version, date, zh, en }) => ({
      version,
      date,
      bullets: english ? en : zh,
    }))
  } catch {
    return []
  }
}

/**
 * The injected sheet.
 *
 * Every string is pre-localized by {@link openChangelogDialog}; the script has
 * no translation logic and uses the app's own colour tokens so it follows the
 * current theme.
 */
export const CHANGELOG_DIALOG_SCRIPT = (payload: {
  title: string
  close: string
  entries: readonly ChangelogEntry[]
  empty: string
}): string => `(function () {
  const p = ${JSON.stringify(payload)};
  const id = 'dsh-changelog';
  const previous = document.getElementById(id);
  if (previous) previous.remove();

  const layer = document.createElement('div');
  layer.id = id;
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', p.title);
  layer.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
    'padding:24px;background:rgba(15,23,42,.48);' +
    'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';

  const panel = document.createElement('div');
  panel.style.cssText =
    'width:min(560px,100%);max-height:min(80vh,640px);display:flex;flex-direction:column;gap:14px;' +
    'padding:20px;border-radius:12px;overflow:hidden;' +
    'background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f172a);' +
    'border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.08));' +
    'box-shadow:0 24px 64px rgba(0,0,0,.35);';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
  const title = document.createElement('div');
  title.textContent = p.title;
  title.style.cssText = 'font-size:16px;font-weight:600;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = p.close;
  close.style.cssText =
    'padding:4px 10px;border-radius:6px;cursor:pointer;font:inherit;font-size:12px;' +
    'border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.18));' +
    'background:transparent;color:inherit;';
  head.appendChild(title);
  head.appendChild(close);

  const body = document.createElement('div');
  body.style.cssText = 'overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding-right:4px;';
  if (p.entries.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = p.empty;
    empty.style.cssText = 'margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#64748b);';
    body.appendChild(empty);
  }
  for (const entry of p.entries) {
    const article = document.createElement('article');
    article.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:baseline;gap:8px;';
    const version = document.createElement('span');
    version.textContent = 'v' + entry.version;
    version.style.cssText = 'font-weight:600;font-variant-numeric:tabular-nums;';
    const date = document.createElement('span');
    date.textContent = entry.date;
    date.style.cssText = 'font-size:11.5px;color:var(--dsw-alias-label-secondary,#64748b);';
    row.appendChild(version);
    row.appendChild(date);
    article.appendChild(row);
    const list = document.createElement('ul');
    list.style.cssText = 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;line-height:1.6;font-size:12.5px;';
    for (const bullet of entry.bullets) {
      const item = document.createElement('li');
      item.textContent = bullet;
      list.appendChild(item);
    }
    article.appendChild(list);
    body.appendChild(article);
  }

  panel.appendChild(head);
  panel.appendChild(body);
  layer.appendChild(panel);

  const onKey = function (event) {
    if (event.key === 'Escape') closeSelf();
  };
  function closeSelf() {
    document.removeEventListener('keydown', onKey);
    layer.remove();
  }
  close.addEventListener('click', closeSelf);
  layer.addEventListener('click', function (event) { if (event.target === layer) closeSelf(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(layer);
  close.focus();
})()`

/**
 * Open the changelog sheet over the app window.
 *
 * @param win - the main window (no-op when it is gone).
 */
export function openChangelogDialog(win: BrowserWindow | null): void {
  const entries = loadChangelog()
  const script = CHANGELOG_DIALOG_SCRIPT({
    title: t('changelog.title'),
    close: t('changelog.close'),
    entries,
    empty: t('changelog.empty'),
  })
  if (win === null || win.isDestroyed()) return
  win.webContents.executeJavaScript(script).catch(() => undefined)
}
