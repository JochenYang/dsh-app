// The in-frame dialog's primary button: its FILL and its LABEL must come from
// one token pair.
//
// This is a regression guard, not a style preference. The dialog used to paint
// the primary button with `--dsw-alias-brand-primary` and a hardcoded white
// label. That token is near-black in light mode but NEAR-WHITE in dark mode, so
// in dark the tray button (最小化到托盘) rendered white text on a white fill —
// invisible, reported from a real screenshot. The app's own buttons pair
// `--dsw-alias-button-primary-fill` with `--dsw-alias-label-primary-foreground`;
// both flip together, which is what makes the label readable in either theme.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { inFrameDialogScript } = require('../dist/main/in-frame-dialog.js')

/** The script the shell injects into the page for one dialog. */
const script = inFrameDialogScript({
  title: '关闭 DSH APP',
  message: '关闭窗口后要如何运行？',
  buttons: [
    { label: '最小化到托盘', value: 'tray', primary: true },
    { label: '退出程序', value: 'quit' },
  ],
})

test('the primary button reads its fill and label from the paired tokens', () => {
  assert.match(script, /--dsw-alias-button-primary-fill/u, 'the fill token is read')
  assert.match(script, /--dsw-alias-label-primary-foreground/u, 'the label token is read')
  // The exact shape that broke: a fill token with a literal white label.
  assert.doesNotMatch(script, /color:#fff/u, 'no hardcoded white label survives')
  assert.doesNotMatch(script, /--dsw-alias-brand-primary/u, 'the unpaired fill token is gone')
})

test('the fallbacks keep the pairing, so a page without tokens is still readable', () => {
  // The inline defaults are the light-mode values: a near-black fill with a
  // white label. Pairing is the invariant; which values are the default is not.
  assert.match(script, /token\('--dsw-alias-button-primary-fill', "#1f2328"\)/u, 'fill fallback present')
  assert.match(script, /token\('--dsw-alias-label-primary-foreground', "#ffffff"\)/u, 'label fallback present')
})

test('the dialog still carries its content and its defaults', () => {
  assert.match(script, /关闭窗口后要如何运行？/u, 'message travels verbatim')
  assert.match(script, /最小化到托盘/u, 'button labels travel verbatim')
  // Enter must resolve to the primary button: a dialog answered by keyboard
  // has to pick the same outcome the highlighted button would.
  assert.match(script, /cfg\.buttons\.find\(function \(b\) \{ return b\.primary; \}\)/u, 'Enter defaults to the primary button')
})
