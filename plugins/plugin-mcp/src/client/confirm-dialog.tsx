/**
 * In-app confirmation modal — the React port of the shell's in-frame dialog
 * idiom (`src/main/in-frame-dialog.ts`): mask + centered alias-token card
 * (340px, radius 12, shell shadow), Esc/mask-click = cancel, Enter on the
 * focused confirm button. All colors come from the live `--dsw-alias-*`
 * theme tokens (with the shell's own fallbacks), so confirmations follow the
 * dsh light/dark theme and match the close/update dialogs instead of the
 * OS-native message box — which client UI must never use.
 *
 * @module @dsh-app/plugin-mcp/client/confirm-dialog
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
    <div className="dshMcp-mask" role="presentation" onClick={onClose}>
      <div
        className="dshMcp-dialogCard"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshMcp-dialogTitle">{title}</div>
        <div className="dshMcp-dialogMessage">{message}</div>
        <div className="dshMcp-dialogActions">
          <button type="button" className="dshMcp-button" disabled={busy} onClick={onClose}>{cancelLabel}</button>
          <button type="button" className="dshMcp-button dshMcp-buttonPrimary" disabled={busy} autoFocus onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
