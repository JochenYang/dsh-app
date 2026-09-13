/**
 * In-app confirmation modal — same in-page dialog idiom as the other suite
 * sections: mask + centered alias-token card, Esc/mask-click = cancel, Enter
 * on the focused confirm button. Never an OS-native message box.
 *
 * @module @dsh-app/plugin-presets/client/confirm-dialog
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
    <div className="dshPresets-mask" role="presentation" onClick={onClose}>
      <div
        className="dshPresets-dialogCard"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshPresets-dialogTitle">{title}</div>
        <div className="dshPresets-dialogMessage">{message}</div>
        <div className="dshPresets-dialogActions">
          <button type="button" className="dshPresets-button" disabled={busy} onClick={onClose}>{cancelLabel}</button>
          <button type="button" className="dshPresets-button dshPresets-buttonPrimary" disabled={busy} autoFocus onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
