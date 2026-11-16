/**
 * The 「关于 DSH-APP」 page: what this installation is, and the few things a user
 * does about it without hunting through the tray.
 *
 * Three cards, in the order a "what am I running?" question arrives:
 * 1. **版本信息** — the shell's version, the active kernel's version and
 *    channel, and the two runtimes underneath (Electron, Node). Unavailable
 *    fields read as 未知 rather than as blanks: a page of empty rows looks
 *    broken, and "the shell did not say" is itself an answer.
 * 2. **位置** — the data directory and the log directory, with the log
 *    directory openable and the data path copyable. A path is shown in full
 *    (wrapped, not ellipsised) because the point of this card is that a user
 *    can read or copy it; the diagnostics page's `shortenPath` exists for a
 *    different job.
 * 3. **操作** — check app updates, check kernel updates, restart the service.
 *    The update checks' only manual entry point (the tray keeps daily actions
 *    and recovery alone); the restart is shared with the tray. Each answers as
 *    soon as it is STARTED: the shell takes over from there and shows its own
 *    progress, so this page must not pretend to know the outcome.
 *
 * Everything here comes from the `dsh-app.client-ui` namespace through the `t`
 * standard seat: the section registers with `locale: NS`, so the renderer hands
 * the component a namespace-bound translate that reads the active UI locale at
 * call time and re-renders on a language switch.
 *
 * @module @dsh-app/plugin-client-ui/client/about/section
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchAboutInfo, startAboutAction, type AboutAction, type AboutInfo } from './api.ts'
import { noticeText } from '../diagnostics/api.ts'
import type { RouteNotice } from '../diagnostics/api.ts'
import { openLogDirectory } from '../diagnostics/api.ts'
import { NS } from './locales.ts'

/** How long a success notice stays on screen (same policy as the other pages). */
const NOTICE_TIMEOUT_MS = 4_000

/**
 * One success notice's self-clear. Success is feedback, not state: it holds
 * for {@link NOTICE_TIMEOUT_MS} and returns to idle; a failure stays on screen
 * because the user still has to act on it. The deps are this notice's own
 * `done` flag and a stable clear, so a neighbour's click never extends its
 * hold, and unmount clears the timer.
 *
 * Why an inline status instead of the host's floating Toast: during these
 * operations the SHELL owns the top-center banner seat (its update progress
 * card, `update-card.ts`), and a second floating banner would land on top of
 * it. The confirmation belongs beside its button and clears itself.
 */
function useSelfClearingNotice(done: boolean, clear: () => void): void {
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(clear, NOTICE_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [done, clear])
}

/** Props delivered by the slot outlet: the `t` seat of this page's namespace. */
export type AboutSectionProps = PropsLocale<typeof NS>

/** The facts card's state. */
type InfoState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly info: AboutInfo['info'] }
  | { readonly kind: 'failed'; readonly notice: RouteNotice }

/** One action row's state. */
type ActionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly notice: RouteNotice }

/** One field of the versions card. */
interface Field {
  readonly key: string
  readonly label: string
  readonly value: string
}

export function AboutSection({ t }: AboutSectionProps): ReactNode {
  const [info, setInfo] = useState<InfoState>({ kind: 'loading' })
  const [actions, setActions] = useState<Readonly<Record<AboutAction, ActionState>>>({
    'check-app-update': { kind: 'idle' },
    'check-kernel-update': { kind: 'idle' },
    'restart-server': { kind: 'idle' },
  })
  const [open, setOpen] = useState<ActionState>({ kind: 'idle' })
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle')

  const clearAction = useCallback((action: AboutAction): void => {
    setActions((current) => current[action].kind === 'done' ? { ...current, [action]: { kind: 'idle' } } : current)
  }, [])
  const clearAppUpdate = useCallback(() => { clearAction('check-app-update') }, [clearAction])
  const clearKernelUpdate = useCallback(() => { clearAction('check-kernel-update') }, [clearAction])
  const clearRestart = useCallback(() => { clearAction('restart-server') }, [clearAction])
  const clearOpen = useCallback(() => { setOpen((current) => current.kind === 'done' ? { kind: 'idle' } : current) }, [])
  const clearCopy = useCallback(() => { setCopy((current) => current === 'done' ? 'idle' : current) }, [])

  // Every success notice on the page self-clears; failures and unsupported
  // states persist until the next attempt replaces them.
  useSelfClearingNotice(actions['check-app-update'].kind === 'done', clearAppUpdate)
  useSelfClearingNotice(actions['check-kernel-update'].kind === 'done', clearKernelUpdate)
  useSelfClearingNotice(actions['restart-server'].kind === 'done', clearRestart)
  useSelfClearingNotice(open.kind === 'done', clearOpen)
  useSelfClearingNotice(copy === 'done', clearCopy)

  const load = useCallback(async (): Promise<void> => {
    setInfo({ kind: 'loading' })
    const answer = await fetchAboutInfo()
    if (answer.kind === 'ok') setInfo({ kind: 'ready', info: answer.body.info })
    else setInfo({ kind: 'failed', notice: answer.notice })
  }, [])

  useEffect(() => { void load() }, [load])

  const runAction = useCallback(async (action: AboutAction): Promise<void> => {
    setActions((current) => ({ ...current, [action]: { kind: 'busy' } }))
    const answer = await startAboutAction(action)
    setActions((current) => ({
      ...current,
      [action]: answer.kind === 'ok'
        ? { kind: 'done' }
        : answer.kind === 'unsupported'
          ? { kind: 'unsupported' }
          : { kind: 'failed', notice: answer.notice },
    }))
  }, [])

  const revealLogs = useCallback(async (): Promise<void> => {
    setOpen({ kind: 'busy' })
    const answer = await openLogDirectory()
    setOpen(answer.kind === 'ok'
      ? { kind: 'done' }
      : answer.kind === 'unsupported'
        ? { kind: 'unsupported' }
        : { kind: 'failed', notice: answer.notice })
  }, [])

  const copyHome = useCallback(async (value: string): Promise<void> => {
    // Retire any previous confirmation first: copy has no busy state, so without
    // this a re-click while 'done' would not flip the flag and the new notice
    // could inherit the old timer's remaining hold.
    setCopy('idle')
    try {
      await navigator.clipboard.writeText(value)
      setCopy('done')
    } catch {
      // A denied clipboard is a normal browser state, not a page failure: the
      // text is on screen and selectable, which is what the notice says.
      setCopy('failed')
    }
  }, [])

  const value = info.kind === 'ready' ? info.info : undefined
  const show = (field: string | undefined): string =>
    field === undefined || field === '' ? t('about.unknown') : field

  const fields: readonly Field[] = [
    { key: 'shell', label: t('about.shell.label'), value: show(value?.shellVersion) },
    { key: 'kernel', label: t('about.kernel.label'), value: show(value?.kernelVersion) },
    { key: 'channel', label: t('about.channel.label'), value: show(value?.kernelChannel) },
    { key: 'electron', label: t('about.electron.label'), value: show(value?.electronVersion) },
    { key: 'node', label: t('about.node.label'), value: show(value?.nodeVersion) },
    { key: 'platform', label: t('about.platform.label'), value: show(value?.platform) },
  ]

  const actionRow = (action: AboutAction, label: string): ReactNode => {
    const state = actions[action]
    return (
      <div className="dshAbout-actionRow" key={action}>
        <button
          type="button" className="dshAbout-button"
          disabled={state.kind === 'busy'}
          onClick={() => { void runAction(action) }}
        >{label}</button>
        {state.kind === 'done' ? <span className="dshAbout-notice" role="status">{t('about.actions.started')}</span> : null}
        {state.kind === 'unsupported' ? <span className="dshAbout-hint" role="status">{t('about.actions.unsupported')}</span> : null}
        {state.kind === 'failed'
          ? <span className="dshAbout-error" role="status">{t('about.actions.failed', { message: noticeText(state.notice, t) })}</span>
          : null}
      </div>
    )
  }

  return (
    <section className="dshAbout-root" aria-label={t('about.nav')}>
      <style>{ABOUT_CSS}</style>
      <p className="dshAbout-intro">{t('about.intro')}</p>

      <div className="dshAbout-card">
        <div className="dshAbout-cardHead">
          <span className="dshAbout-cardTitle">{t('about.versions.title')}</span>
          {info.kind === 'loading' ? <span className="dshAbout-badge" role="status">{t('about.loading')}</span> : null}
          {info.kind === 'failed' ? (
            <>
              <span className="dshAbout-error" role="status">
                {t('about.failed', { message: noticeText(info.notice, t) })}
              </span>
              <button type="button" className="dshAbout-button" onClick={() => { void load() }}>
                {t('about.retry')}
              </button>
            </>
          ) : null}
        </div>
        <dl className="dshAbout-fields">
          {fields.map((field) => (
            <div className="dshAbout-field" key={field.key}>
              <dt className="dshAbout-fieldLabel">{field.label}</dt>
              <dd className="dshAbout-fieldValue">{field.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="dshAbout-card">
        <div className="dshAbout-cardHead">
          <span className="dshAbout-cardTitle">{t('about.paths.title')}</span>
        </div>
        <p className="dshAbout-hint">{t('about.paths.hint')}</p>
        <div className="dshAbout-pathRow">
          <span className="dshAbout-pathLabel">{t('about.paths.home')}</span>
          <code className="dshAbout-path">{value?.dshHome ?? t('about.unknown')}</code>
          <button
            type="button" className="dshAbout-button"
            disabled={value?.dshHome === undefined || value.dshHome === ''}
            onClick={() => { void copyHome(value?.dshHome ?? '') }}
          >{t('about.paths.copyHome')}</button>
          {copy === 'done' ? <span className="dshAbout-notice" role="status">{t('about.paths.copied')}</span> : null}
          {copy === 'failed' ? <span className="dshAbout-error" role="status">{t('about.paths.copyFailed')}</span> : null}
        </div>
        <div className="dshAbout-pathRow">
          <span className="dshAbout-pathLabel">{t('about.paths.logs')}</span>
          <code className="dshAbout-path">{value?.logDir ?? t('about.unknown')}</code>
        </div>
        <div className="dshAbout-actions">
          <button
            type="button" className="dshAbout-button dshAbout-buttonPrimary"
            disabled={open.kind === 'busy'}
            onClick={() => { void revealLogs() }}
          >{open.kind === 'busy' ? t('about.paths.opening') : t('about.paths.openLogs')}</button>
          {open.kind === 'done' ? <span className="dshAbout-notice" role="status">{t('about.paths.opened')}</span> : null}
          {open.kind === 'unsupported' ? <span className="dshAbout-hint" role="status">{t('about.actions.unsupported')}</span> : null}
          {open.kind === 'failed'
            ? <span className="dshAbout-error" role="status">{t('about.actions.failed', { message: noticeText(open.notice, t) })}</span>
            : null}
        </div>
      </div>

      <div className="dshAbout-card">
        <div className="dshAbout-cardHead">
          <span className="dshAbout-cardTitle">{t('about.actions.title')}</span>
        </div>
        <p className="dshAbout-hint">{t('about.actions.hint')}</p>
        {value?.updateSupported === false
          ? <p className="dshAbout-hint dshAbout-hintBlocked">{t('about.actions.devHint')}</p>
          : null}
        <div className="dshAbout-actionList">
          {actionRow('check-app-update', t('about.actions.checkApp'))}
          {actionRow('check-kernel-update', t('about.actions.checkKernel'))}
          {actionRow('restart-server', t('about.actions.restart'))}
        </div>
      </div>
    </section>
  )
}

/**
 * The page's own styles. Backtick literal, so no backtick may appear inside it
 * (`AGENTS.md` §5) — the class prefix keeps every rule off the other pages.
 */
const ABOUT_CSS = `
.dshAbout-root { display: flex; flex-direction: column; gap: 12px; padding-top: 16px; font-size: 13px; color: var(--dsw-alias-label-primary, #0f172a); }
.dshAbout-intro { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); line-height: 1.6; }
.dshAbout-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.dshAbout-cardHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshAbout-cardTitle { font-weight: 600; }
.dshAbout-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; background: var(--dsw-alias-bg-layer-2, rgba(148,163,184,.16)); color: var(--dsw-alias-label-secondary, #64748b); }
.dshAbout-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 16px; margin: 0; }
.dshAbout-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshAbout-fieldLabel { color: var(--dsw-alias-label-secondary, #64748b); font-size: 11.5px; }
.dshAbout-fieldValue { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.dshAbout-hint { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; line-height: 1.5; }
.dshAbout-hintBlocked { padding: 6px 10px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); background: var(--dsw-alias-bg-layer-2, #f1f5f9); border-radius: 0 6px 6px 0; }
.dshAbout-pathRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshAbout-pathLabel { color: var(--dsw-alias-label-secondary, #64748b); font-size: 11.5px; flex: none; min-width: 84px; }
.dshAbout-path { margin: 0; padding: 2px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, #f8fafc); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
.dshAbout-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* The three actions sit side by side: they are peers — same weight, same trigger,
   nothing to choose between them — and a column read as a menu of steps. Each one
   keeps its own cluster so a status message stays beside the button it belongs to,
   and the list wraps as whole clusters instead of splitting a message from it. */
.dshAbout-actionList { display: flex; flex-direction: row; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px; }
.dshAbout-actionRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 28px; }
.dshAbout-notice { color: #16a34a; font-size: 12px; }
.dshAbout-error { margin: 0; color: #dc2626; font-size: 12px; }
.dshAbout-button { padding: 5px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; cursor: pointer; font-size: 12.5px; }
.dshAbout-button:disabled { opacity: .5; cursor: default; }
.dshAbout-buttonPrimary { border-color: transparent; background: var(--dsw-alias-brand-primary, #3b82f6); color: var(--dsw-alias-label-primary-foreground, #fff); }
`
