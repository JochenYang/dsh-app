/**
 * Self-contained confirmation modal — React port of the shell's in-frame
 * dialog idiom (src/main/in-frame-dialog.ts). Uses dshHk- styles defined in
 * styles.ts. Esc/mask = cancel, Enter on focused confirm = confirm.
 * @module @dsh-app/plugin-hooks/client/confirm-dialog
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

export function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel = '取消', busy = false, onConfirm, onClose,
}: ConfirmDialogProps): ReactNode {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="dshHk-mask" role="presentation" onClick={onClose}>
      <div className="dshHk-dialogCard" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => { e.stopPropagation() }}>
        <div className="dshHk-dialogTitle">{title}</div>
        <div className="dshHk-dialogMessage">{message}</div>
        <div className="dshHk-dialogActions">
          <button type="button" className="dshHk-button" disabled={busy} onClick={onClose}>{cancelLabel}</button>
          <button type="button" className="dshHk-button dshHk-buttonPrimary" disabled={busy} autoFocus onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
