/**
 * Close-confirmation dialog: the themed in-frame dialog specialized to the
 * window-close question. Thin facade over in-frame-dialog.ts — the rendering,
 * theming, keyboard, and dedup logic live there once.
 */

import { inFrameDialogScript } from './in-frame-dialog'

export type CloseDialogChoice = 'tray' | 'quit' | 'cancel'

const CLOSE_CONFIG = {
  rootId: 'dsh-close-dialog',
  title: '关闭 DSH APP',
  message: '关闭窗口后要如何运行？',
  buttons: [
    { label: '取消', value: 'cancel' },
    { label: '退出程序', value: 'quit' },
    { label: '最小化到托盘', value: 'tray', primary: true },
  ],
  cancelValue: 'cancel',
  enterValue: 'tray',
} as const

/** The one in-page script; resolves to {@link CloseDialogChoice}. */
export const CLOSE_DIALOG_SCRIPT: string = inFrameDialogScript(CLOSE_CONFIG)
