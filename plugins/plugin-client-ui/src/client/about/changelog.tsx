/**
 * The 「更新日志」 card on the About page: the last few releases, shipped with
 * the app instead of behind a browser tab.
 *
 * Where the data comes from: the shell generates `dist/changelog.json` out of
 * `CHANGELOG.md` at build time and serves it same-origin at
 * `/__changelog.json`, localized to the active UI language. This page only
 * fetches that URL and renders bullets — it never parses markdown, and it has no
 * channel to the main process (the preload exposes nothing for it).
 *
 * The dialog is the kernel's `Modal` primitive: it owns the portal, the mask,
 * Escape, the focus trap and the focus return, so this file only composes the
 * content inside it.
 *
 * @module @dsh-app/plugin-client-ui/client/about/changelog
 */

import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AboutSectionProps } from './section.ts'

/** One release exactly as the generated file carries it. */
interface ChangelogVersion {
  readonly version: string
  readonly date: string
  readonly bullets: readonly string[]
}

/** The dialog's data state. */
type ChangelogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly versions: readonly ChangelogVersion[] }
  | { readonly kind: 'failed' }

/** The About page's changelog card and its dialog. */
export function ChangelogCard({ t }: Pick<AboutSectionProps, 't'>): ReactNode {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ChangelogState>({ kind: 'loading' })

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const response = await fetch('/__changelog.json', { cache: 'no-store' })
      if (!response.ok) throw new Error(String(response.status))
      const data = await response.json() as { versions?: ChangelogVersion[] }
      setState({ kind: 'ready', versions: Array.isArray(data.versions) ? data.versions : [] })
    } catch {
      setState({ kind: 'failed' })
    }
  }, [])

  return (
    <>
      <div className="dshAbout-rowCard">
        <div className="dshAbout-rowText">
          <span className="dshAbout-rowTitle">{t('about.changelog.title')}</span>
          <span className="dshAbout-hint">{t('about.changelog.hint')}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(true)
            void load()
          }}
        >
          {t('about.changelog.open')}
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('about.changelog.title')}
        closeLabel={t('about.changelog.close')}
        className="dshAbout-changelogModal"
        contentClassName="dshAbout-changelogScroll"
      >
        {state.kind === 'loading' ? <p className="dshAbout-hint">{t('about.loading')}</p> : null}
        {state.kind === 'failed' ? <p className="dshAbout-error">{t('about.changelog.failed')}</p> : null}
        {state.kind === 'ready' && state.versions.length === 0
          ? <p className="dshAbout-hint">{t('about.changelog.empty')}</p>
          : null}
        {state.kind === 'ready'
          ? state.versions.map((entry) => (
            <article className="dshAbout-changelogEntry" key={entry.version}>
              <div className="dshAbout-changelogHead">
                <span className="dshAbout-changelogVersion">v{entry.version}</span>
                <span className="dshAbout-changelogDate">{entry.date}</span>
              </div>
              <ul className="dshAbout-changelogList">
                {entry.bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}
              </ul>
            </article>
          ))
          : null}
      </Modal>
    </>
  )
}
