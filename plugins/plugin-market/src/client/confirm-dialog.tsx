/**
 * In-app confirmation modal, built on the host's `Modal` primitive.
 *
 * The shell's in-frame idiom (mask + centered alias-token card, Esc/mask = cancel,
 * Enter on the focused confirm button) is the framework's own: drawing a second
 * mask and card here meant two focus traps, two Escape handlers and two looks that
 * drift apart. `Modal` owns the portal, the mask, Escape, the focus trap and the
 * focus return; this file only supplies the body and the action row. All copy
 * arrives as props: the caller owns the wording and its locale namespace.
 *
 * @module @dsh-app/plugin-market/client/confirm-dialog
 */

import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  /** Cancel label; the caller owns the copy (its own locale namespace). */
  cancelLabel: string
  busy?: boolean
  /**
   * Confirm-button tone within the neutral system: 'neutral' (white surface,
   * dark label — non-destructive actions like install) or 'dark' (inverted
   * surface — the emphasized half of the pair, e.g. uninstall). Never red:
   * install is not destructive and red read as an error state.
   */
  tone?: 'neutral' | 'dark'
  onConfirm: () => void
  onClose: () => void
}

/**
 * Render one in-page confirmation over everything else (body portal).
 * @returns null when closed.
 */
export function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel, busy = false, tone = 'neutral', onConfirm, onClose,
}: ConfirmDialogProps): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={cancelLabel}
      footer={(
        <div className="dshMkt-dialogActions">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>{cancelLabel}</Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      )}
    >
      <p className="dshMkt-dialogMessage">{message}</p>
    </Modal>
  )
}
