// The tray menu's template, and the ONE row whose clickability depends on this
// machine: the managed terminal's.
//
// The menu is a SNAPSHOT of the callbacks — `buildTrayMenu` builds a fresh
// template on every rebuild — so what is assertable without an Electron process
// is the mapping (a callback's answer becomes a row's `enabled`) plus the answer
// itself for the case that made this change necessary: a machine with no usable
// kernel must show the row GREYED, not offer a click whose only possible report
// is "no kernel". Both halves are read through the shipped code —
// `trayMenuTemplate` is the pure half of the menu (`tray.ts`), and
// `kernelCliUsable` is the predicate BOTH the tray row and the click's own plan
// consult (see its JSDoc in terminal.ts).
//
// Reverse-tested by hand, in both directions: pinning the row's `enabled` to a
// constant fails the case that disagrees with it, and making `kernelCliUsable`
// answer `true` unconditionally fails the empty-path and missing-file cases.
//
// Electron is a module-level import of `tray.ts` and resolves to the binary path
// outside Electron, so requiring the built module here is safe —
// `Menu.buildFromTemplate` is never reached. The file on disk is a scratch root
// from test/scratch.mjs, so nothing here names a real machine path.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { scratchDir } from './scratch.mjs'

const require = createRequire(import.meta.url)
const { trayMenuTemplate } = require('../dist/main/tray.js')
const { kernelCliUsable } = require('../dist/main/terminal.js')

/** The handler that names the terminal row, so the row is found by identity and no label is assumed. */
const openTerminal = () => {}
const openApp = () => {}
const restartServer = () => {}
const toggleSafeMode = () => {}
const restoreConfig = () => {}
const rollbackApp = () => {}

/** The callbacks `index.ts` hands the tray, with only the machine's answers stubbed. */
function callbacksFor(canOpenTerminal, overrides = {}) {
  return {
    onOpen: openApp,
    onRestartServer: restartServer,
    onOpenTerminal: openTerminal,
    canOpenTerminal,
    onToggleSafeMode: toggleSafeMode,
    onRestoreConfig: restoreConfig,
    canRestoreConfig: () => false,
    isSafeMode: () => false,
    onRollbackApp: rollbackApp,
    canRollbackApp: () => false,
    ...overrides,
  }
}

/** The recovery submenu of the menu built from these callbacks. */
function recoverySubmenu(canOpenTerminal, overrides = {}) {
  const items = trayMenuTemplate(callbacksFor(canOpenTerminal, overrides))
  const group = items.find((item) => Array.isArray(item.submenu))
  assert.ok(group !== undefined, 'the menu must carry the recovery submenu')
  return group.submenu
}

/** The terminal row of the menu built from these callbacks, asserting it is there. */
function terminalRow(canOpenTerminal) {
  const row = trayMenuTemplate(callbacksFor(canOpenTerminal)).find((item) => item.click === openTerminal)
  assert.ok(row !== undefined, 'the menu must carry the row that opens the managed terminal')
  return row
}

test('the terminal row is greyed while there is no usable kernel CLI', () => {
  // The state `kernelCliPath()` answers with '' — no active kernel at all.
  assert.equal(kernelCliUsable(''), false, 'an empty path is not a file')
  assert.equal(terminalRow(() => kernelCliUsable('')).enabled, false, 'no active kernel: the row must be greyed')
  // The state one step later: a path was resolved and the file is not there.
  const absent = path.join(scratchDir('dsh-app-tray-absent-'), 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assert.equal(kernelCliUsable(absent), false, 'a resolved path with no file behind it')
  assert.equal(terminalRow(() => kernelCliUsable(absent)).enabled, false, 'a missing CLI file: the row must be greyed')
})

test('the terminal row is clickable once the kernel CLI is on disk', () => {
  const cli = path.join(scratchDir('dsh-app-tray-present-'), 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(path.dirname(cli), { recursive: true })
  writeFileSync(cli, '// the kernel CLI entry\n')
  assert.equal(kernelCliUsable(cli), true, 'the CLI file is there')
  assert.equal(terminalRow(() => kernelCliUsable(cli)).enabled, true, 'a usable CLI: the row must be clickable')
})

test('the top level is the daily set plus one recovery submenu', () => {
  const items = trayMenuTemplate(callbacksFor(() => true))
  assert.equal(items.length, 7, 'open / terminal / restart / sep / submenu / sep / quit')
  assert.equal(items[0].click, openApp)
  assert.equal(items[1].click, openTerminal)
  assert.equal(items[2].click, restartServer)
  assert.equal(items[3].type, 'separator')
  assert.ok(Array.isArray(items[4].submenu), 'the escape hatches live one level down')
  assert.equal(items[5].type, 'separator')
  assert.equal(typeof items[6].click, 'function', 'quit closes the menu')
})

test('the recovery submenu is never empty and never offers a dead restore', () => {
  // Both restores refused: only the safe-mode toggle remains, so the submenu
  // still has a row — and neither restore is a click whose outcome is a sentence.
  const submenu = recoverySubmenu(() => true)
  assert.equal(submenu.length, 1)
  assert.equal(submenu[0].click, toggleSafeMode)
})

test('the restore rows appear only when the shell can act', () => {
  // The platform/dev refusals live in the predicate (syncRollbackTarget), not
  // in the template, so here the predicate's answer alone decides the row.
  const both = recoverySubmenu(() => true, { canRestoreConfig: () => true, canRollbackApp: () => true })
  assert.ok(both.some((row) => row.click === restoreConfig), 'a verified checkpoint offers the restore row')
  assert.ok(both.some((row) => row.click === rollbackApp), 'a rollback target offers the rollback row')
  const noCheckpoint = recoverySubmenu(() => true, { canRollbackApp: () => true })
  assert.ok(!noCheckpoint.some((row) => row.click === restoreConfig), 'no checkpoint: no restore row')
  const noTarget = recoverySubmenu(() => true, { canRestoreConfig: () => true })
  assert.ok(!noTarget.some((row) => row.click === rollbackApp), 'no target: no rollback row')
})

test('the safe-mode row flips its label with the state', () => {
  const enter = recoverySubmenu(() => true)[0]
  const exit = recoverySubmenu(() => true, { isSafeMode: () => true })[0]
  assert.equal(enter.click, toggleSafeMode)
  assert.equal(exit.click, toggleSafeMode)
  assert.notEqual(enter.label, exit.label, 'enter and exit are different sentences')
})
