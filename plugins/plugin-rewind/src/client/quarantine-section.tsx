/**
 * The quarantine manager: the settings page that makes the safety net auditable.
 *
 * Every file a recall displaced is kept under `$DSH_HOME/storages/…/quarantine/`
 * so the recall stays reversible. That is the right default and it is also an
 * append-only directory on the user's disk: without a face it is a slow leak that
 * nobody can see into or reclaim. This page is that face.
 *
 * ## What it shows, and why each column
 *
 * A quarantined slot's NAME is a timestamp and a hash, so the listing reads the
 * `manifest.json` each slot carries. Without it the only honest column would be
 * "replaced", which tells a user nothing about whether the content is worth
 * keeping or safe to drop.
 *
 * The slot whose manifest cannot be read is still LISTED, marked unknown, rather
 * than hidden: an entry a user cannot see is an entry they cannot reclaim.
 *
 * ## Deletion is per slot, and confirmed
 *
 * Discarding quarantined content is the one irreversible action in this feature —
 * the safety copy is the copy. So it is armed per row (and per session) behind an
 * inline confirm, never a single global button that fires on one click.
 *
 * @module @dsh-app/plugin-rewind/client/quarantine-section
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, zh, type RewindKey } from './locales.ts'

/** The namespace-bound `t` seat this section receives. */
export type QuarantineTranslate = (key: RewindKey, params?: Readonly<Record<string, string | number>>) => string

/** Props delivered by the settings shell: the `t` seat of this namespace. */
export type QuarantineSectionProps = PropsLocale<typeof NS>

/** One quarantined slot, as the host lists it. */
interface Entry {
  readonly sessionId: string
  readonly slot: string
  readonly kind: 'replaced' | 'created' | 'unknown'
  readonly originalPath?: string
  readonly at?: number
  readonly bytes: number
}

/** One session's worth of quarantined content. */
interface Group {
  readonly sessionId: string
  readonly entries: readonly Entry[]
  readonly bytes: number
}

/** The whole quarantine, as `GET /quarantine` answers it. */
interface Listing {
  readonly groups: readonly Group[]
  readonly entries: number
  readonly bytes: number
}

/** The route namespace this page reads. */
const ROUTE = '/api/plugins/dsh-app/plugin-rewind/quarantine'

/**
 * A host answer that failed, carrying the coded message.
 *
 * The route sends BOTH a stable `code` (+ `params`) and an English diagnostic
 * (`routes.ts` `fail`). The code is the one this page renders — through its own
 * dictionary — and the English text is only the fallback for a code this build
 * does not know, which is what keeps a zh-CN page from showing English.
 */
class HostError extends Error {
  readonly host: { code?: string, params?: Record<string, string | number> } | undefined
  constructor(host: { code?: string, params?: Record<string, string | number> } | undefined, message: string) {
    super(message)
    this.host = host
  }
}

/** One bounded JSON round-trip against the host. */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as { ok: boolean, value?: T, error?: { message?: string, host?: { code?: string, params?: Record<string, string | number> } } }
  if (!response.ok || body.ok !== true) {
    throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}

/**
 * Turn a failed round-trip into a sentence in this page's own language.
 *
 * @param error - whatever the round-trip threw.
 * @param t - this plugin's locale-bound `t`.
 * @returns the sentence to show.
 */
function failureText(error: unknown, t: QuarantineTranslate): string {
  if (error instanceof HostError) {
    const code = error.host?.code
    // The dictionary owns the sentence; a code this build lacks falls back to the
    // host's English diagnostic rather than throwing on a missing key.
    if (code !== undefined && (KNOWN_KEYS as ReadonlySet<string>).has(code)) {
      return t(code as RewindKey, error.host?.params)
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** Every key this dictionary owns, so an unknown route code falls back safely. */
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(zh))

/** Bytes as a short human string, so the total reads as a size not a number. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The last path segment, which is what a row is recognisable by. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** A local `HH:MM` for one stamp, or an empty string when unusable. */
function clockText(at: number | undefined): string {
  if (at === undefined) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** What the confirm dialog is about to discard. */
interface Pending {
  readonly targets: readonly { sessionId: string, slot: string }[]
  readonly bytes: number
  readonly label: string
}

/**
 * The quarantine page.
 *
 * @param props - the section's `t` seat.
 * @returns the rendered page.
 */
export function QuarantineSection({ t }: QuarantineSectionProps): ReactNode {
  const [listing, setListing] = useState<Listing | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setListing(await fetchJson<Listing>(ROUTE))
      setFailure(null)
    } catch (error) {
      setFailure(failureText(error, t))
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  /** Arm discarding one slot, or every slot of one session. */
  const onPurge = useCallback((targets: readonly { sessionId: string, slot: string }[], bytes: number, label: string) => {
    setNotice(null)
    setPending({ targets, bytes, label })
  }, [])

  /** Confirm the pending discard, then reload so the page shows what is left. */
  const onConfirm = useCallback(async () => {
    const target = pending
    if (target === undefined) return
    setBusy(true)
    try {
      const result = await fetchJson<{ removed: number, failed: readonly string[] }>(`${ROUTE}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: target.targets }),
      })
      setNotice(result.failed.length === 0
        ? t('rewind.quarantine.purged', { count: result.removed })
        : t('rewind.quarantine.purgedPartial', { count: result.removed, failed: result.failed.length }))
      setPending(undefined)
      await load()
    } catch (error) {
      setFailure(failureText(error, t))
    } finally {
      setBusy(false)
    }
  }, [pending, t, load])

  const groups = listing?.groups ?? []

  return (
    <div className="dshRewind-quarantine">
      <p className="dshRewind-quarantineIntro">
        {listing === null || listing.entries === 0
          ? t('rewind.quarantine.empty')
          : t('rewind.quarantine.intro', {
            count: listing.entries,
            size: sizeText(listing.bytes),
          })}
      </p>
      {failure !== null && <p className="dshRewind-quarantineError" role="status">{failure}</p>}
      {notice !== null && <p className="dshRewind-quarantineNotice" role="status">{notice}</p>}

      {groups.map((group) => (
        <section key={group.sessionId} className="dshRewind-quarantineGroup">
          <header className="dshRewind-quarantineHead">
            <span className="dshRewind-quarantineSession" title={group.sessionId}>{group.sessionId}</span>
            <span className="dshRewind-quarantineMeta">{sizeText(group.bytes)}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onPurge(
                group.entries.map((entry) => ({ sessionId: group.sessionId, slot: entry.slot })),
                group.bytes,
                t('rewind.quarantine.targetSession', { session: group.sessionId, count: group.entries.length }),
              )}
            >
              {t('rewind.quarantine.discardAll')}
            </Button>
          </header>
          <ul className="dshRewind-quarantineList">
            {group.entries.map((entry) => (
              <li key={entry.slot} className="dshRewind-quarantineRow">
                <div className="dshRewind-quarantineRowMain">
                  <span className="dshRewind-quarantineKind" data-kind={entry.kind}>
                    {entry.kind === 'created'
                      ? t('rewind.quarantine.kindCreated')
                      : entry.kind === 'replaced'
                        ? t('rewind.quarantine.kindReplaced')
                        : t('rewind.quarantine.kindUnknown')}
                  </span>
                  <span className="dshRewind-quarantinePath" title={entry.originalPath ?? ''}>
                    {entry.originalPath === undefined ? entry.slot : baseName(entry.originalPath)}
                  </span>
                  <span className="dshRewind-quarantineMeta">{clockText(entry.at)}</span>
                  <span className="dshRewind-quarantineMeta">{sizeText(entry.bytes)}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onPurge(
                    [{ sessionId: entry.sessionId, slot: entry.slot }],
                    entry.bytes,
                    entry.originalPath === undefined
                      ? t('rewind.quarantine.targetSlot', { slot: entry.slot })
                      : t('rewind.quarantine.targetFile', { path: baseName(entry.originalPath) }),
                  )}
                >
                  {t('rewind.quarantine.discard')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Modal
        open={pending !== undefined}
        onClose={() => setPending(undefined)}
        title={t('rewind.quarantine.confirmTitle')}
        closeLabel={t('rewind.quarantine.cancel')}
        description={pending === undefined
          ? ''
          : t('rewind.quarantine.confirmBody', {
            label: pending.label,
            size: sizeText(pending.bytes),
          })}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => setPending(undefined)}>
              {t('rewind.quarantine.cancel')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => { void onConfirm() }}>
              {t('rewind.quarantine.confirm')}
            </Button>
          </>
        )}
      >
        {/* The one warning that has to be unmissable: this is the undo of the
            undo. The file itself is already back in place; what goes is the only
            copy of what was there before the recall. */}
        <p className="dshRewind-quarantineWarn">{t('rewind.quarantine.confirmWarn')}</p>
      </Modal>
    </div>
  )
}
