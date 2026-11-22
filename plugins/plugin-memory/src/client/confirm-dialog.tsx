/**
 * The section's confirmation: a destructive action asks first, and the dialog
 * that asks is the host's own.
 *
 * ## Composed from the host's primitives, not hand-rolled
 *
 * An earlier version drew its own mask, card and buttons with plugin CSS. The
 * alias tokens were right and the composition was not, so it read subtly
 * off-theme beside every other dialog in the suite. `Modal` and `Button` from
 * `@deepseek-ai/dsh-client-ui-primitives` carry the mask, the blur, the
 * elevation, the close affordance, the modal layer, Escape and mask-click
 * dismissal, the Tab trap, and the return of focus to the control that opened
 * the dialog. A plugin composes them; it does not re-draw them.
 *
 * ## The safe answer holds the focus
 *
 * The initial focus is the CANCEL button, marked with `data-modal-autofocus`
 * — the primitive's documented seat. (React `autoFocus` runs before the modal
 * layer can capture the invoking control, which is what return focus needs.)
 * The hand-rolled version put `autoFocus` on the destructive button, so
 * pressing Enter on a dialog that was opened from the keyboard deleted the
 * card. While a request is in flight the cancel button is disabled and cannot
 * take focus, so the mark moves with it: the primitive then focuses the first
 * enabled control, which is the header's close button — also a cancel.
 *
 * `RiskConfirmation` is deliberately not used: its acknowledgement checkbox
 * suits a one-shot irreversible choice, and each of these confirmations
 * already names its target and its consequence in the message.
 *
 * @module @dsh-app/plugin-memory/client/confirm-dialog
 */

import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export interface ConfirmDialogProps {
  readonly open: boolean
  readonly title: string
  /** May span lines: each line is rendered (the sentences quote their target). */
  readonly message: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  /** A request is in flight: both footer actions are disabled. */
  readonly busy?: boolean
  readonly onConfirm: () => void
  readonly onClose: () => void
}

/**
 * Render the confirmation over everything else, or nothing when closed.
 * @returns the dialog, or null.
 */
export function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel, busy = false, onConfirm, onClose,
}: ConfirmDialogProps): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      // The destructive variant of the primitive: an amber title icon.
      tone="warning"
      closeLabel={cancelLabel}
      footer={(
        <>
          <Button
            variant="outline"
            disabled={busy}
            data-modal-autofocus={busy ? undefined : ''}
            onClick={onClose}
          >
            {cancelLabel}
          </Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <p className="dshm_confirmMessage">{message}</p>
    </Modal>
  )
}
