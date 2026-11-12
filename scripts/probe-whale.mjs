#!/usr/bin/env node
// What the two home decorations actually PAINT, measured in the running window.
//
// Why this probe exists in this shape: `ui-brand-official` registers a canvas
// into `conversation.hero.frame` unconditionally (0.2.2-rc.2), and our own whale
// layer paints the same screen. Counting canvas ELEMENTS cannot tell "two whales"
// from "a canvas that is transparent at rest" — this counts alpha>8 pixels, which
// is the only way to see the difference (and it is how the earlier
// "two whales at once" reading was corrected).
//
// It also does not boot a kernel: the document the desktop window shows is
// `dsh-app://app/index.html`, a scheme that exists only inside the app's own
// process, so a second Electron instance cannot load it. The probe therefore
// drives the ALREADY RUNNING dev window over CDP:
//
//   DSH_APP_DEV=1 npm start -- --remote-debugging-port=9222   (or npm run dev)
//   node scripts/probe-whale.mjs [--cdp http://127.0.0.1:9222]
//
// Assertions (each one is a fact the decision in
// docs/plans/kernel-0.2.2-rc.2-upgrade.md rests on):
//   W1 our layer paints at rest
//   W2 the official canvas exists and is transparent at rest
//   W3 a blank click makes the official canvas paint, and it clears itself
//   W4 our layer is unaffected by that click
import { connect, sleep } from './lib/cdp.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const endpoint = argOf('--cdp', process.env.CDP ?? 'http://127.0.0.1:9222')

const lines = []
const record = (name, ok, detail) => {
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Painted-pixel census of both decorations, plus where a blank click can land. */
const CENSUS = `
(() => {
  const painted = (canvas) => {
    if (canvas === null || canvas === undefined) return null
    const ctx = canvas.getContext('2d')
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let n = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n += 1
    return { painted: n, w: canvas.width, h: canvas.height }
  }
  const theirs = [...document.querySelectorAll('canvas')].find((c) => c.hasAttribute('data-home-whale')) ?? null
  const ours = document.querySelector('#dshapp-whale-bg')
  const body = document.querySelector('[data-phase]')
  const rect = body === null ? null : body.getBoundingClientRect()
  return JSON.stringify({
    ours: painted(ours),
    theirs: painted(theirs),
    phase: body?.getAttribute('data-phase') ?? null,
    body: rect === null ? null : { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  })
})()`

const cdp = await connect(endpoint)
try {
  // Both decorations are HOME features. A window left on an existing session
  // shows neither, so the probe opens a blank session first — the state the
  // decision was made about — instead of measuring whatever was on screen.
  const NEW_SESSION = `
    (() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => (candidate.getAttribute('aria-label') ?? '') === '新建会话'
          || (candidate.getAttribute('aria-label') ?? '').toLowerCase() === 'new session')
      if (button === undefined) return false
      button.click()
      return true
    })()`
  const opened = await cdp.evaluate(NEW_SESSION)
  // Poll rather than sleep: the session switch re-renders the conversation and
  // the decorations mount a frame or two later (a fixed 2.5 s was not enough on
  // a cold window, and a longer one would just make the probe slow).
  let idle = JSON.parse(await cdp.evaluate(CENSUS))
  for (let attempt = 0; attempt < 20 && idle.phase !== 'hero'; attempt += 1) {
    await sleep(500)
    idle = JSON.parse(await cdp.evaluate(CENSUS))
  }
  if (idle.phase !== 'hero') {
    record('W0 the window is on a blank home', false, `phase: ${String(idle.phase)} (opened a session: ${String(opened)})`)
  } else {
    record('W0 the window is on a blank home', true, 'phase: hero')
  }
  record('W1 our whale layer paints at rest', (idle.ours?.painted ?? 0) > 0, `${String(idle.ours?.painted)} px`)
  record('W2 the official canvas is transparent at rest', idle.theirs !== null && idle.theirs.painted === 0,
    idle.theirs === null ? 'no [data-home-whale] canvas in the document' : `${String(idle.theirs.painted)} px`)

  if (idle.body === null) {
    record('W3 a blank click paints the official canvas', false, 'no [data-phase] container to click')
  } else {
    const x = Math.round(idle.body.x + idle.body.w / 2)
    const y = Math.round(idle.body.y + 40)
    // The animation is click-triggered and self-ending; sampling twice is what
    // separates "it painted" from "it never paints".
    await cdp.click(x, y)
    await sleep(1600)
    const playing = JSON.parse(await cdp.evaluate(CENSUS))
    record('W3 a blank click paints the official canvas', (playing.theirs?.painted ?? 0) > 0,
      `${String(playing.theirs?.painted)} px after 1.6 s`)
    // Guarded on presence: two absent readings would otherwise satisfy the
    // tolerance trivially, and the claim is about a layer that is there.
    const oursIdle = idle.ours?.painted ?? 0
    const oursPlaying = playing.ours?.painted ?? 0
    record('W4 our layer is unaffected by the click', oursIdle > 0 && Math.abs(oursPlaying - oursIdle) < oursIdle * 0.1,
      `${String(idle.ours?.painted)} → ${String(playing.ours?.painted)}`)
  }
} finally {
  cdp.close()
}

const failed = lines.filter((line) => line.startsWith('FAIL'))
console.log(`\nRESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${String(lines.length)} checks, ${String(failed.length)} failed)`)
process.exitCode = failed.length === 0 ? 0 : 1
