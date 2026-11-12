#!/usr/bin/env node
// The settings rail, measured in the RUNNING window.
//
// Why this exists next to `probe-settings-nav.cjs`: that probe boots its own
// kernel through `pnpm dsh web` inside a built harness checkout
// (`scripts/probe-settings-nav.cjs:423-435`), so on a machine without one it
// cannot run at all — and the app-origin window it needs for the happy path is
// exactly what only the app has. This one drives the running desktop window over
// CDP instead, which is the only place `dsh-app://app` exists:
//
//   DSH_APP_DEV=1 npm start -- --remote-debugging-port=9222   (or npm run dev)
//   node scripts/probe-settings-rail.mjs [--cdp http://127.0.0.1:9222]
//
// Assertions — the regressions this rail has actually had:
//   S1 the settings dialog opens from the account menu and renders a nav list
//   S2 every row carries at most ONE native glyph (the rc.1 double-icon bug)
//   S3 the merged 维护 section is one rail row, not one per tab
//   S4 in English mode no rail label still holds Han characters
import { connect, sleep } from '../scratch/cdp-lib.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const endpoint = argOf('--cdp', process.env.CDP ?? 'http://127.0.0.1:9222')

const lines = []
const record = (name, ok, detail) => {
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * Open the settings dialog through the seat this line puts it in.
 *
 * On 0.2.x the entry is an item of the ACCOUNT menu (`settings.launcher` holds a
 * button labelled 账号菜单); when that seat is empty it is a direct dialog
 * trigger. Both shapes are tried, and only the account trigger is clicked — a
 * blanket click over every `aria-haspopup` element opens workspace context menus
 * and leaves the window in a state the rest of the probe cannot read.
 */
const OPEN_SETTINGS = `
(() => {
  const account = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .find((candidate) => /账号|account/i.test(candidate.getAttribute('aria-label') ?? ''))
  if (account !== undefined) { account.click(); return 'account-menu' }
  const direct = document.querySelector('button[aria-haspopup="dialog"]')
  if (direct !== null) { direct.click(); return 'dialog-trigger' }
  return 'none'
})()`

const CLICK_SETTINGS_ITEM = `
(() => {
  // The item's text carries its shortcut too ("设置 Ctrl+Alt+,"), so the match is
  // a prefix on the first line rather than an equality on textContent.
  const items = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button')]
  // The item's text carries its shortcut too ("设置 Ctrl+Alt+," or, with no
  // separating space, "设置Ctrl+Alt+,"), so the match is a prefix.
  const item = items.find((node) => /^(设置|Settings)/u.test((node.textContent ?? '').trim()))
  if (item === undefined) return false
  item.click()
  return true
})()`

/** The rail: label, glyph count and translated-ness of every row. */
const RAIL = `
(() => {
  const rows = [...document.querySelectorAll('[class*="navList"] button, [class*="navList"] [role="tab"], [class*="navList"] a')]
  return JSON.stringify(rows.map((row) => {
    const label = (row.querySelector('[class*="navLabel"]') ?? row).textContent.trim()
    // One native glyph cell: the kernel wraps its glyph in a [class*="navIcon"]
    // span on this line, and the rc.1 bug was a second glyph beside it.
    const glyphs = row.querySelectorAll('svg').length
    const iconCells = row.querySelectorAll('[class*="navIcon"]').length
    return { label, glyphs, iconCells, han: /[\\u4e00-\\u9fff]/u.test(label) }
  }))
})()`

const cdp = await connect(endpoint)
try {
  const opened = await cdp.evaluate(OPEN_SETTINGS)
  await sleep(600)
  const clicked = await cdp.evaluate(CLICK_SETTINGS_ITEM)
  await sleep(900)

  let rail = []
  for (let attempt = 0; attempt < 20 && rail.length === 0; attempt += 1) {
    rail = JSON.parse(await cdp.evaluate(RAIL))
    if (rail.length === 0) await sleep(300)
  }

  record('S1 the settings dialog opens and renders a nav list', rail.length > 0,
    rail.length > 0 ? `${String(rail.length)} rows` : `no rows (opened via ${String(opened)}, item clicked: ${String(clicked)})`)

  const doubled = rail.filter((row) => row.glyphs > 1)
  record('S2 no row paints two native glyphs', doubled.length === 0,
    doubled.length === 0 ? '' : JSON.stringify(doubled))

  const maintenance = rail.filter((row) => /维护|Maintenance/u.test(row.label))
  record('S3 the merged maintenance section is one rail row', maintenance.length <= 1,
    `${String(maintenance.length)} row(s): ${JSON.stringify(maintenance.map((row) => row.label))}`)

  // The Han-leak check only means something in an ENGLISH window, and the window's
  // language is a property of the RAIL, not of this process: the app is switched
  // from its own settings, and `DSH_APP_LOCALE` on the probe would not change it.
  const hanRows = rail.filter((row) => row.han).length
  if (hanRows > rail.length / 2) {
    record('S4 (skipped) no Han left in the rail under English', true,
      `this window is Chinese (${String(hanRows)}/${String(rail.length)} rows carry Han) — switch the app to English and rerun`)
  } else {
    const leaking = rail.filter((row) => row.han)
    record('S4 no Han left in the rail under English', leaking.length === 0, JSON.stringify(leaking.map((row) => row.label)))
  }
} finally {
  cdp.close()
}

const failed = lines.filter((line) => line.startsWith('FAIL'))
console.log(`\nRESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${String(lines.length)} checks, ${String(failed.length)} failed)`)
process.exitCode = failed.length === 0 ? 0 : 1
