/**
 * In-app confirmation modal — the same idiom the shell's in-frame dialog uses:
 * mask + centered alias-token card, Esc / mask-click = cancel, focus lands on
 * the confirm button. Colors come from the live `--dsw-alias-*` theme tokens,
 * so the card follows the dsh light/dark theme instead of an OS-native message
 * box, which client UI must never use.
 *
 * Rendered through a body portal: a destructive confirmation must not sit
 * inside the scroll container of the row that triggered it, where the user
 * would have to hunt for it after clicking a button further down the list.
 *
 * @module @dsh-app/plugin-memory/client/confirm-dialog
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

/**
 * Render one in-page confirmation over everything else (body portal).
 * @returns null when closed.
 */
export function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel = '取消', busy = false, onConfirm, onClose,
}: ConfirmDialogProps): ReactNode {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="dshm_mask" role="presentation" onClick={onClose}>
      <div
        className="dshm_dialogCard"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshm_dialogTitle">{title}</div>
        <div className="dshm_dialogMessage">{message}</div>
        <div className="dshm_dialogActions">
          <button type="button" className="dshm_button" disabled={busy} onClick={onClose}>{cancelLabel}</button>
          <button
            type="button"
            className="dshm_button dshm_buttonDanger"
            disabled={busy}
            autoFocus
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
