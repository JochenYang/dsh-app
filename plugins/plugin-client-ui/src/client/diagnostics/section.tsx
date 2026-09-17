/**
 * The 诊断 settings section (order 22): what the app can tell about its own
 * runtime without leaving the page.
 *
 * Four cards, in the order a support question arrives:
 * 1. **桌面功能** — whether this environment can perform a desktop action at
 *    all (the shell published its route, see plugin-brand's `/status`).
 *    Unavailable is a normal state (a bare `dsh` run, an older shell), so it
 *    reads as a status line, never as an error dialog.
 * 2. **打开日志目录** — the shell reveals `<userData>/logs` in the OS file
 *    manager. When desktop features are missing the button is disabled WITH the
 *    reason next to it: a greyed control nobody can explain is worse than no
 *    control.
 * 3. **导出诊断包** — the shell saves one plain-text file (versions + log tail)
 *    wherever the user points the native dialog. A cancelled dialog stays
 *    silent: the user already knows they cancelled, and a red line would claim
 *    something went wrong.
 * 4. **内核日志** — the tail of the newest server log, monospace, scrolled to
 *    the end, refreshed by hand. No live stream: the log is written by the
 *    shell's child process, and a poll would show a page that moves while the
 *    user reads it.
 *
 * The lines arrive already redacted (the shell redacts before writing), and this
 * page never asks for, shows or copies a credential.
 *
 * Every string here comes from the `dsh-app.client-ui` namespace through the
 * `t` standard seat: the section registers with `locale: NS`, so the renderer
 * hands the component a namespace-bound translate that reads the active UI
 * locale at call time and re-renders on a language switch.
 *
 * @module @dsh-app/plugin-client-ui/client/diagnostics/section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  fetchExportFacts,
  saveTextAs,
  fetchBrandStatus,
  fetchLogTail,
  noticeText,
  openLogDirectory,
  TAIL_LINES,
  UNREACHABLE_NOTICE,
} from './api.ts'
import type { RouteNotice } from './api.ts'
import { NS } from './locales.ts'
import { buildReportText, reportFileName } from './report.ts'

/**
 * How long a success notice stays on screen. Same policy as the websearch page:
 * a confirmation is feedback, not state; a failure is neither, so it stays.
 */
const NOTICE_TIMEOUT_MS = 4_000

/** Props delivered by the slot outlet: the `t` seat of this page's namespace. */
export type DiagnosticsSectionProps = PropsLocale<typeof NS>

/** Desktop-feature availability as the page shows it. */
type DesktopState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly available: boolean }
  | { readonly kind: 'failed'; readonly notice: RouteNotice }

/** The log tail as the page shows it. */
type TailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly file: string; readonly fileLines: readonly string[]; readonly at: string }
  | { readonly kind: 'unsupported'; readonly notice: RouteNotice }
  | { readonly kind: 'failed'; readonly notice: RouteNotice }

/** The "open logs" action as the page shows it. */
type OpenState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done' }
  | { readonly kind: 'unsupported'; readonly notice: RouteNotice }
  | { readonly kind: 'failed'; readonly notice: RouteNotice }

/**
 * The "export diagnostics" action as the page shows it. `done` carries the path
 * the shell reported; a cancelled dialog resets to `idle` instead, because
 * there is nothing to report.
 */
type ExportState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly path: string }
  | { readonly kind: 'unsupported'; readonly notice: RouteNotice }
  | { readonly kind: 'failed'; readonly notice: RouteNotice }

/** Longest path shown before {@link shortenPath} trims its middle. */
const PATH_DISPLAY_MAX = 96

/**
 * Shorten a path in the MIDDLE: both ends carry what a reader needs — where it
 * landed and what it is called. The full value stays in the element's tooltip.
 * @param path - the path the shell reported.
 * @returns the path unchanged when it fits, otherwise `head…tail`.
 */
function shortenPath(path: string): string {
  if (path.length <= PATH_DISPLAY_MAX) return path
  const head = Math.ceil((PATH_DISPLAY_MAX - 1) / 2)
  const tail = PATH_DISPLAY_MAX - 1 - head
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`
}

/** Local wall-clock stamp for "refreshed at", so the page is honest about age. */
function nowStamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/**
 * Render the 诊断 settings section.
 * @param props - the framework-supplied `t` seat of this page's namespace.
 * @returns the section page; it owns its data, so no inject face is needed.
 */
export function DiagnosticsSection({ t }: DiagnosticsSectionProps): ReactNode {
  const [desktop, setDesktop] = useState<DesktopState>({ kind: 'loading' })
  const [tail, setTail] = useState<TailState>({ kind: 'loading' })
  const [open, setOpen] = useState<OpenState>({ kind: 'idle' })
  const [save, setSave] = useState<ExportState>({ kind: 'idle' })
  const logRef = useRef<HTMLPreElement | null>(null)

  const loadDesktop = useCallback(async (): Promise<void> => {
    // The badge and the button read this state, which is the ONLY feedback a
    // re-check produces. Without it a local fetch answers so fast that the
    // control looks dead (reported from real use).
    setDesktop({ kind: 'loading' })
    const outcome = await fetchBrandStatus()
    if (outcome.kind === 'ok') {
      setDesktop({ kind: 'ready', available: outcome.body.bridge === true })
      return
    }
    // `unsupported` on the status route means the plugin is not registered at
    // all — from this page's point of view the same as no answer.
    setDesktop({
      kind: 'failed',
      notice: outcome.kind === 'unsupported' ? UNREACHABLE_NOTICE : outcome.notice,
    })
  }, [])

  const loadTail = useCallback(async (): Promise<void> => {
    setTail({ kind: 'loading' })
    const outcome = await fetchLogTail(TAIL_LINES)
    if (outcome.kind === 'ok') {
      setTail({
        kind: 'ready',
        file: outcome.body.path ?? '',
        fileLines: outcome.body.lines ?? [],
        at: nowStamp(),
      })
      return
    }
    if (outcome.kind === 'unsupported') {
      setTail({ kind: 'unsupported', notice: outcome.notice })
      return
    }
    setTail({ kind: 'failed', notice: outcome.notice })
  }, [])

  useEffect(() => {
    void loadDesktop()
    void loadTail()
  }, [loadDesktop, loadTail])

  // The newest lines are the interesting ones: pin the view to the end after
  // every load, unless there is nothing to scroll.
  useEffect(() => {
    const log = logRef.current
    if (log !== null) log.scrollTop = log.scrollHeight
  }, [tail])

  const revealLogs = useCallback(async (): Promise<void> => {
    setOpen({ kind: 'busy' })
    const outcome = await openLogDirectory()
    if (outcome.kind === 'ok') {
      setOpen({ kind: 'done' })
      return
    }
    if (outcome.kind === 'unsupported') {
      setOpen({ kind: 'unsupported', notice: outcome.notice })
      return
    }
    setOpen({ kind: 'failed', notice: outcome.notice })
  }, [])

  // Transient success notices (log folder opened, package exported) clear
  // themselves. Long enough to read a path, short enough that a stale line
  // cannot read as the current condition. Errors deliberately stay.
  useEffect(() => {
    if (open.kind !== 'done') return undefined
    const timer = setTimeout(() => { setOpen({ kind: 'idle' }) }, NOTICE_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [open])

  useEffect(() => {
    if (save.kind !== 'done') return undefined
    const timer = setTimeout(() => { setSave({ kind: 'idle' }) }, NOTICE_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [save])

  const openBlocked = open.kind === 'unsupported'
    || (desktop.kind === 'ready' && !desktop.available)
  const openHint = open.kind === 'unsupported'
    ? noticeText(open.notice, t)
    : desktop.kind === 'ready' && !desktop.available
      ? t('diag.open.blocked')
      : undefined

  const exportPackage = useCallback(async (): Promise<void> => {
    setSave({ kind: 'busy' })
    // Two hops, one user action: collect the facts, render the file HERE (this
    // page owns the language the reader will see), then let the shell save it.
    const facts = await fetchExportFacts()
    if (facts.kind === 'unsupported') {
      setSave({ kind: 'unsupported', notice: facts.notice })
      return
    }
    if (facts.kind !== 'ok') {
      setSave({ kind: 'failed', notice: facts.notice })
      return
    }
    const outcome = await saveTextAs(reportFileName(facts.body), buildReportText(facts.body, t))
    if (outcome.kind === 'ok') {
      const path = outcome.body.path
      // A cancelled save dialog is a normal outcome: the user closed the native
      // dialog themselves, so the card goes back to idle and says nothing.
      setSave(path === null || path === undefined || path === '' ? { kind: 'idle' } : { kind: 'done', path })
      return
    }
    if (outcome.kind === 'unsupported') {
      setSave({ kind: 'unsupported', notice: outcome.notice })
      return
    }
    setSave({ kind: 'failed', notice: outcome.notice })
    // `t` is a stable thunk over the locale binding, so re-running the export
    // after a language switch writes the file in the new language.
  }, [t])

  const exportBlocked = save.kind === 'unsupported'
    || (desktop.kind === 'ready' && !desktop.available)
  const exportHint = save.kind === 'unsupported'
    ? noticeText(save.notice, t)
    : desktop.kind === 'ready' && !desktop.available
      ? t('diag.export.blocked')
      : undefined

  return (
    <section className="dshDiag-root" aria-label={t('diag.nav')}>
      <style>{DIAGNOSTICS_CSS}</style>
      <p className="dshDiag-intro">
        {t('diag.intro', { lines: TAIL_LINES })}
      </p>

      <div className="dshDiag-card">
        <div className="dshDiag-cardHead">
          <span className="dshDiag-cardTitle">{t('diag.bridge.title')}</span>
          <span
            className={desktop.kind === 'ready' && desktop.available
              ? 'dshDiag-badge dshDiag-badgeOk'
              : 'dshDiag-badge dshDiag-badgeMuted'}
            role="status"
          >
            {desktop.kind === 'loading'
              ? t('diag.bridge.checking')
              : desktop.kind === 'ready'
                ? desktop.available ? t('diag.bridge.available') : t('diag.bridge.unavailable')
                : noticeText(desktop.notice, t)}
          </span>
          <button
            type="button" className="dshDiag-button" disabled={desktop.kind === 'loading'}
            onClick={() => { void loadDesktop() }}
          >{t('diag.bridge.recheck')}</button>
        </div>
        <p className="dshDiag-hint">
          {desktop.kind === 'ready' && desktop.available
            ? t('diag.bridge.hintAvailable')
            : desktop.kind === 'ready'
              ? t('diag.bridge.hintMissing')
              : desktop.kind === 'failed'
                ? t('diag.bridge.hintFailed', { message: noticeText(desktop.notice, t) })
                : t('diag.bridge.hintLoading')}
        </p>
        <div className="dshDiag-actions">
          <button
            type="button" className="dshDiag-button dshDiag-buttonPrimary"
            disabled={openBlocked || open.kind === 'busy'}
            onClick={() => { void revealLogs() }}
          >{open.kind === 'busy' ? t('diag.open.busy') : t('diag.open.action')}</button>
          {open.kind === 'done' ? <span className="dshDiag-notice" role="status">{t('diag.open.done')}</span> : null}
          {open.kind === 'failed'
            ? <span className="dshDiag-error" role="status">{t('diag.open.failed', { message: noticeText(open.notice, t) })}</span>
            : null}
        </div>
        {openHint === undefined ? null : <p className="dshDiag-hint dshDiag-hintBlocked">{openHint}</p>}
      </div>

      <div className="dshDiag-card">
        <div className="dshDiag-cardHead">
          <span className="dshDiag-cardTitle">{t('diag.export.title')}</span>
          <button
            type="button" className="dshDiag-button dshDiag-buttonPrimary"
            disabled={exportBlocked || save.kind === 'busy'}
            onClick={() => { void exportPackage() }}
          >{save.kind === 'busy' ? t('diag.export.busy') : t('diag.export.action')}</button>
        </div>
        <p className="dshDiag-hint">{t('diag.export.hint')}</p>
        {save.kind === 'done'
          ? (
            <p className="dshDiag-notice dshDiag-breakAll" role="status" title={save.path}>
              {t('diag.export.done', { path: shortenPath(save.path) })}
            </p>
          )
          : null}
        {save.kind === 'failed'
          ? <p className="dshDiag-error">{t('diag.export.failed', { message: noticeText(save.notice, t) })}</p>
          : null}
        {exportHint === undefined ? null : <p className="dshDiag-hint dshDiag-hintBlocked">{exportHint}</p>}
      </div>

      <div className="dshDiag-card">
        <div className="dshDiag-cardHead">
          <span className="dshDiag-cardTitle">{t('diag.log.title', { lines: TAIL_LINES })}</span>
          <button
            type="button" className="dshDiag-button" disabled={tail.kind === 'loading'}
            onClick={() => { void loadTail() }}
          >{tail.kind === 'loading' ? t('diag.log.refreshing') : t('diag.log.refresh')}</button>
        </div>
        {tail.kind === 'ready'
          ? (
            <>
              <p className="dshDiag-path" title={tail.file}>{t('diag.log.path', { file: tail.file, at: tail.at })}</p>
              {tail.fileLines.length === 0
                ? <p className="dshDiag-hint">{t('diag.log.empty')}</p>
                : (
                  <pre className="dshDiag-log" ref={logRef} tabIndex={0} aria-label={t('diag.log.aria')}>
                    {tail.fileLines.join('\n')}
                  </pre>
                )}
            </>
          )
          : tail.kind === 'loading'
            ? <p className="dshDiag-hint">{t('diag.log.reading')}</p>
            : tail.kind === 'unsupported'
              ? <p className="dshDiag-hint dshDiag-hintBlocked">{noticeText(tail.notice, t)}</p>
              : <p className="dshDiag-error">{t('diag.log.failed', { message: noticeText(tail.notice, t) })}</p>}
      </div>
    </section>
  )
}

/** Page styles (class prefix dshDiag-), injected inline — the brand bundle has no CSS pipeline. */
const DIAGNOSTICS_CSS = `
.dshDiag-root { display: flex; flex-direction: column; gap: 12px; padding-top: 16px; font-size: 13px; color: var(--dsw-alias-label-primary, #0f172a); }
.dshDiag-intro { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); line-height: 1.6; }
.dshDiag-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.dshDiag-cardHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshDiag-cardTitle { font-weight: 600; }
.dshDiag-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; }
.dshDiag-badgeOk { background: rgba(22, 163, 74, .12); color: #16a34a; }
.dshDiag-badgeMuted { background: var(--dsw-alias-bg-layer-2, rgba(148,163,184,.16)); color: var(--dsw-alias-label-secondary, #64748b); }
.dshDiag-hint { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; line-height: 1.5; }
.dshDiag-hintBlocked { padding: 6px 10px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); background: var(--dsw-alias-bg-layer-2, #f1f5f9); border-radius: 0 6px 6px 0; }
.dshDiag-path { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshDiag-log { margin: 0; padding: 8px 10px; box-sizing: border-box; height: 320px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f8fafc); color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.dshDiag-log:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.dshDiag-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshDiag-notice { color: #16a34a; font-size: 12px; }
.dshDiag-breakAll { margin: 0; overflow-wrap: anywhere; }
.dshDiag-error { margin: 0; color: #dc2626; font-size: 12px; }
.dshDiag-button { padding: 5px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; cursor: pointer; font-size: 12.5px; }
.dshDiag-button:disabled { opacity: .5; cursor: default; }
.dshDiag-buttonPrimary { border-color: transparent; background: var(--dsw-alias-brand-primary, #3b82f6); color: var(--dsw-alias-label-primary-foreground, #fff); }
`
