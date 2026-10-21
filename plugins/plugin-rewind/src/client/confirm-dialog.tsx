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
 * ## Two kinds of shortfall, both spoken
 *
 * A preview that lists only the changes it CAN make teaches the user to trust it.
 * Two things can be missing, and they are different sentences:
 *
 *   - files the plugin knows it could not put back (too large to copy, an
 *     oversized file, a before-image the store no longer holds) — these are named
 *     in the count below;
 *   - a range with NO workspace snapshot whose tools write through their own
 *     handle, so the plugin cannot even name what it missed. That is the
 *     `coverage` verdict, and it is the one that used to be reported as an
 *     unqualified success.
 *
 * The note below the list is therefore always present, zero included: silence
 * would read as "nothing else changed", which is exactly the claim a recall must
 * not make when it cannot back it up.
 *
 * It is also where the compaction boundary is stated, when there is one: a recall
 * cannot reach past the newest checkpoint, and the user approving a cut should
 * know that older messages are not in the list they are choosing from.
 *
 * @module @dsh-app/plugin-rewind/client/confirm-dialog
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, DiffBlock, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileChangePreview, RecallMode, RevertPlan } from '../wire.ts'
import { coverageSentence } from './messages.ts'
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
  /**
   * Run the recall. The mode is chosen IN this dialog, so it travels back with
   * the confirmation rather than being fixed before the user sees the plan —
   * a preview of files the user may then decide not to touch would be a lie
   * about what the button does.
   */
  readonly onConfirm: (mode: RecallMode) => void
  readonly onClose: () => void
  /**
   * The scope changed, so the caller must re-ask the host what the recall would
   * do. The dialog does not fetch by itself: the plan is the caller's state, and
   * a second fetch path would be a second place for it to go stale.
   */
  readonly onScopeChange?: (mode: RecallMode) => void
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
export function ConfirmDialog({ open, plan, busy, t, onConfirm, onClose, onScopeChange }: ConfirmDialogProps): ReactNode {
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  // The safe default: a recall that also puts files back is what the button has
  // always done, and a user who only wants the messages can say so here.
  const [mode, setMode] = useState<RecallMode>('withFiles')

  // A closed dialog forgets which row was expanded, so reopening it never shows a
  // stale diff for a plan that has since changed. The mode resets with it: the
  // next recall starts from the ordinary shape instead of inheriting a choice
  // made about a different message.
  useEffect(() => {
    if (!open) {
      setExpanded(undefined)
      setMode('withFiles')
    }
  }, [open])

  if (!open) return null
  const restore = plan?.restore ?? []
  const remove = plan?.remove ?? []
  const unrestorable = plan?.unrestorable ?? []
  const rows: PreviewRow[] = [...restore, ...remove]
  // A shortfall the plugin can NAME (files it could not put back) and one it can
  // only quantify (a range with no snapshot, so it does not know what it missed)
  // are different sentences, and both belong above the confirm button.
  const coverage = coverageSentence(plan, t, {
    none: 'rewind.confirm.coverageNone',
    partial: 'rewind.confirm.coveragePartial',
  })
  // The boundary is context, not a shortfall: it takes the plain tone, which is
  // why `warn` below stays driven by the coverage verdict and the named files.
  const boundary = plan?.stoppedAtCompaction === true ? t('rewind.confirm.boundary') : undefined
  const note = [
    ...(boundary === undefined ? [] : [boundary]),
    ...(coverage === undefined ? [] : [coverage]),
    ...(unrestorable.length === 0 ? [] : [t('rewind.confirm.unrestorable', { n: unrestorable.length })]),
  ].join(' ')
  const warn = coverage !== undefined || unrestorable.length > 0
  // Choosing "messages only" makes the file rows moot, and the dialog says so
  // rather than showing a list of files it will not touch.
  const modeNote = mode === 'conversationOnly' ? t('rewind.confirm.modeConversationOnly') : undefined

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
          <Button variant="primary" disabled={busy} onClick={() => { onConfirm(mode) }}>
            {busy ? t('rewind.confirm.working') : t('rewind.confirm.confirm')}
          </Button>
        </>
      )}
    >
      {/* The scope choice sits ABOVE the file list, because it decides whether
          that list is even going to be acted on. Choosing "messages only" hides
          the rows rather than dimming them: a list of files that will not be
          touched is noise in a dialog whose job is to say what WILL happen. */}
      <SegmentedControl
        id="dshRewind-scope"
        value={mode}
        options={[
          { value: 'withFiles' as const, label: t('rewind.mode.withFiles') },
          { value: 'conversationOnly' as const, label: t('rewind.mode.conversationOnly') },
        ]}
        onChange={(next) => {
          setMode(next)
          onScopeChange?.(next)
        }}
        label={t('rewind.mode.label')}
        disabled={busy}
        className="dshRewind-scope"
      />
      {modeNote === undefined ? null : (
        <p className="dshRewind-modeNote">{modeNote}</p>
      )}
      {mode === 'withFiles' && rows.length > 0 && (
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
          changed", which is exactly the claim this plugin must not make when a
          shortfall exists. */}
      <p className="dshRewind-dialogNote" data-tone={warn ? 'warn' : 'plain'}>
        {note === '' ? t('rewind.confirm.note') : note}
      </p>
    </Modal>
  )
}
