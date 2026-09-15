/**
 * In-app confirmation modal — the React port of the shell's in-frame dialog
 * idiom (mask + centered alias-token card, Esc/mask = cancel, Enter on the
 * focused confirm button), the same idiom the other suite sections use.
 * All copy arrives as props: the caller owns the wording and its locale
 * namespace (no string is built here).
 *
 * @module @dsh-app/plugin-market/client/confirm-dialog
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

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
    <div className="dshMkt-dialogWrap" role="presentation" onClick={onClose}>
      <div
        className="dshMkt-dialogCard"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshMkt-dialogTitle">{title}</div>
        <div className="dshMkt-dialogMessage">{message}</div>
        <div className="dshMkt-dialogActions">
          <button type="button" className="dshMkt-button" disabled={busy} onClick={onClose}>{cancelLabel}</button>
          <button
            type="button"
            className={tone === 'dark' ? 'dshMkt-button dshMkt-buttonDark' : 'dshMkt-button dshMkt-buttonNeutral'}
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
