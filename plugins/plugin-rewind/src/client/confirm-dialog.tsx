/**
 * The recall confirmation: what will change, before it changes.
 *
 * A recall is destructive — it rewrites files and moves others aside — and the
 * first version simply did it and reported afterwards. That is the one shape a
 * user cannot consent to: by the time the sentence appears, the tree has already
 * changed. This dialog is the missing step.
 *
 * ## Built from the host's own primitives, not hand-rolled
 *
 * An earlier version drew its own mask, card and buttons with plugin CSS. That
 * looked subtly wrong in both themes and drifted from every other dialog in the
 * suite — the tokens were right and the composition was not. `Modal` and `Button`
 * from `@deepseek-ai/dsh-client-ui-primitives` are the host's own: they carry the
 * mask, the blur, the elevation, the close affordance, focus handling, Escape and
 * the modal layer, and they follow a theme change for free. A plugin composes
 * them; it does not re-draw them.
 *
 * The `RiskConfirmation` primitive is deliberately NOT used even though the
 * action is destructive: it requires an acknowledgement checkbox, which suits a
 * one-shot irreversible choice. A recall is neither one-shot nor irreversible —
 * everything displaced lands in the quarantine — and the per-file preview below
 * is the confirmation the user actually needs.
 *
 * ## The unrestorable note is the point
 *
 * A preview that lists only the changes it CAN make teaches the user to trust it.
 * A file a shell command touched is invisible to this plugin, so it cannot appear
 * as a row — but staying silent would read as "nothing else changed", which is
 * false. The note below the list is therefore always present, zero included.
 *
 * @module @dsh-app/plugin-rewind/client/confirm-dialog
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, DiffBlock, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileChangePreview, RevertPlan } from '../wire.ts'
import type { RewindKey } from './locales.ts'

/**
 * The row and plan types come from `wire.ts` — the SAME definition the host
 * builds against.
 *
 * A local copy of `RevertPlan` used to live here with a different field set, so a
 * change made against one compiled and silently failed to reach the other. The
 * host is the producer and `wire.ts` is the shared vocabulary both halves already
 * import, so the definitions live there.
 */
export type PreviewRow = FileChangePreview
export type { RevertPlan }

export interface ConfirmDialogProps {
  readonly open: boolean
  readonly plan: RevertPlan | undefined
  readonly busy: boolean
  /** The locale-bound `t` seat; this component owns no copy of its own. */
  readonly t: (key: RewindKey, params?: Readonly<Record<string, string | number>>) => string
  readonly onConfirm: () => void
  readonly onClose: () => void
}

/** The last path segment, which is what a row is recognisable by. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/**
 * The chrome labels `DiffBlock` renders around the hunks.
 *
 * `DiffBlock` is the host's own diff component — it computes the hunks, colours
 * added and removed lines, caps long diffs behind an expander and offers copy and
 * wrap. Hand-rolling two text columns instead (the first attempt) showed the
 * before and after side by side with no line-level marking, which is not a diff.
 * Only the words come from here; every behaviour is the primitive's.
 *
 * @param t - this plugin's locale-bound `t`.
 * @returns the labels the primitive reads.
 */
function diffLabels(t: ConfirmDialogProps['t']): {
  codeLabel: string
  wrapLabel: string
  unwrapLabel: string
  copy: string
  copied: string
  collapseAria: string
  expandAria: (count: number) => string
  collapse: string
  expand: (count: number) => string
} {
  return {
    codeLabel: '',
    wrapLabel: t('rewind.diff.wrap'),
    unwrapLabel: t('rewind.diff.unwrap'),
    copy: t('rewind.diff.copy'),
    copied: t('rewind.diff.copied'),
    collapseAria: t('rewind.diff.collapseAria'),
    expandAria: (count) => t('rewind.diff.expandAria', { count }),
    collapse: t('rewind.diff.collapse'),
    expand: (count) => t('rewind.diff.expand', { count }),
  }
}

/**
/**
 * Render the confirmation, or nothing when closed.
 *
 * @returns the dialog element, or null.
 */
export function ConfirmDialog({ open, plan, busy, t, onConfirm, onClose }: ConfirmDialogProps): ReactNode {
  const [expanded, setExpanded] = useState<string | undefined>(undefined)

  // A closed dialog forgets which row was expanded, so reopening it never shows a
  // stale diff for a plan that has since changed.
  useEffect(() => {
    if (!open) setExpanded(undefined)
  }, [open])

  if (!open) return null
  const restore = plan?.restore ?? []
  const remove = plan?.remove ?? []
  const unrestorable = plan?.unrestorable ?? []
  const rows: PreviewRow[] = [...restore, ...remove]

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('rewind.confirm.title')}
      closeLabel={t('rewind.confirm.cancel')}
      // The primitive's own extension point. The card defaults to 380px, which
      // is right for a sentence and too narrow for a diff: a code line wraps
      // three times and the change is unreadable. Widening is a content need, so
      // the width is overridden here rather than the frame being redrawn.
      className="dshRewind-confirmDialog"
      description={rows.length === 0
        ? t('rewind.confirm.nofiles')
        : t('rewind.confirm.summary', { files: rows.length })}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('rewind.confirm.cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            {busy ? t('rewind.confirm.working') : t('rewind.confirm.confirm')}
          </Button>
        </>
      )}
    >
      {rows.length > 0 && (
        <ul className="dshRewind-fileList">
          {rows.map((row) => (
            <li key={row.path} className="dshRewind-fileRow">
              <div className="dshRewind-fileHead">
                <span className="dshRewind-fileAction" data-action={row.action}>
                  {row.action === 'restore' ? t('rewind.confirm.restore') : t('rewind.confirm.remove')}
                </span>
                <span className="dshRewind-filePath" title={row.path}>{baseName(row.path)}</span>
                {row.action === 'restore' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={expanded === row.path}
                    onClick={() => setExpanded((current) => (current === row.path ? undefined : row.path))}
                  >
                    {expanded === row.path ? t('rewind.confirm.hideDiff') : t('rewind.confirm.showDiff')}
                  </Button>
                )}
              </div>
              {expanded === row.path && row.action === 'restore' && (
                <DiffBlock
                  diffs={[{ path: row.path, oldText: row.current ?? '', newText: row.next ?? '' }]}
                  labels={diffLabels(t)}
                  maxLines={24}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Always present, zero included: silence here would read as "nothing else
          changed", and a shell command's writes are exactly what this cannot see. */}
      <p className="dshRewind-dialogNote" data-tone={unrestorable.length > 0 ? 'warn' : 'plain'}>
        {unrestorable.length > 0
          ? t('rewind.confirm.unrestorable', { n: unrestorable.length })
          : t('rewind.confirm.note')}
      </p>
    </Modal>
  )
}
