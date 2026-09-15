/**
 * Close-confirmation dialog: the themed in-frame dialog specialized to the
 * window-close question. Thin facade over in-frame-dialog.ts — the rendering,
 * theming, keyboard, and dedup logic live there once.
 */

import { inFrameDialogScript } from './in-frame-dialog'
import { t } from '../shared/locale'

export type CloseDialogChoice = 'tray' | 'quit' | 'cancel'

/**
 * The one in-page script; resolves to {@link CloseDialogChoice}.
 *
 * Built per call rather than at import: the button labels are localized, and a
 * module-level string would freeze whichever locale happened to be resolvable
 * while the module loaded (before Electron's app is ready).
 */
export function closeDialogScript(): string {
  return inFrameDialogScript({
    rootId: 'dsh-close-dialog',
    title: t('closeDialog.title'),
    message: t('closeDialog.message'),
    buttons: [
      { label: t('closeDialog.cancel'), value: 'cancel' },
      { label: t('closeDialog.quit'), value: 'quit' },
      { label: t('closeDialog.tray'), value: 'tray', primary: true },
    ],
    cancelValue: 'cancel',
    enterValue: 'tray',
  })
}
