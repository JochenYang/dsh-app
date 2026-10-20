#!/usr/bin/env node
/**
 * Runtime probe for the effort track's two visual behaviours.
 *
 * Why a probe and not a test: `npm test` reads the stylesheet as TEXT and the
 * component as SOURCE. Both can be correct while the RENDERED control is wrong — a
 * `transform` on an absolutely-positioned child can be clipped, a later rule of
 * equal specificity can override a transition, and a value that looks right in the
 * source can compute to `all`. Those are facts about a laid-out document.
 *
 * It boots NO kernel and needs no runtime artifact. The stylesheet is a template
 * literal over the geometry/mosaic/colour constants, so the probe BUNDLES
 * `src/client/styles.ts` with esbuild, runs `adoptStyles` against a stub document
 * to capture the exact string it injects, feeds that to Chromium, and measures what
 * the engine computed. Reading the built `lib/client.js` as text does not work:
 * that file is a browser module (`window.__ModuleLoader__`) whose template keeps
 * its `${…}` placeholders for the loader to resolve, so a text slice of it is not
 * CSS at all — measured, as `width: 0px` on every tick.
 *
 * What it asserts, from raw observations:
 *   A1  the evaluated sheet carries the tick rules, with no unresolved expression
 *   A2  hovering a tick makes it measurably larger (the scale really applies)
 *   A3  the mark returns to its rest size when the hover attribute clears
 *   A4  a neighbouring tick does not move — a scale, not a re-layout
 *   A5  the computed transition names `transform` alone, never `all`
 *   A6  under `prefers-reduced-motion: reduce` the mark still appears and the
 *       transition is gone
 *
 * Run: node_modules/.bin/electron scripts/probe-effort-hover.cjs
 *
 * @module dsh-app/scripts/probe-effort-hover
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const lines = []

/**
 * Record one assertion.
 * @param {string} name - what is being claimed.
 * @param {boolean} ok - whether it held.
 * @param {string} detail - the raw observation behind the verdict.
 */
function record(name, ok, detail = '') {
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Evaluate the real stylesheet.
 *
 * The module builds its CSS at evaluation time and exposes only `adoptStyles`, so
 * the probe reproduces the DOM surface that function touches and keeps whatever it
 * writes. This is the same stub the unit suite uses, at the same seam.
 *
 * @returns the stylesheet text.
 */
async function evaluatedStylesheet() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-css-'))
  const outfile = path.join(outdir, 'styles.cjs')
  buildSync({
    entryPoints: [path.join(root, 'plugins/plugin-effort/src/client/styles.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'error',
  })
  const captured = []
  const appended = new Map()
  const previous = globalThis.document
  globalThis.document = {
    getElementById: id => appended.get(id) ?? null,
    createElement: () => {
      const element = { id: '' }
      Object.defineProperty(element, 'textContent', { set(value) { captured.push(value) } })
      return element
    },
    head: { append: element => appended.set(element.id, element) },
  }
  try {
    delete require.cache[outfile]
    require(outfile).adoptStyles()
  } finally {
    globalThis.document = previous
    // The async form: the repo's recursive-delete guard measures it as safe around
    // links, and its sync twin has followed a junction and emptied a tree
    // (test/recursive-delete-guard.test.mjs). This directory is a fresh mkdtemp,
    // but the rule is the rule — it is why this file needs no audit entry.
    await fs.promises.rm(outdir, { recursive: true, force: true })
  }
  return captured.join('\n')
}

async function main() {
  const css = await evaluatedStylesheet()
  record('the evaluated stylesheet carries the tick and track rules',
    css.includes('.dshAppEffort-tick') && css.includes('.dshAppEffort-track'),
    `${css.length} chars`)
  record('every expression was resolved before the sheet reached the DOM',
    !css.includes('${') && !css.includes('undefinedpx') && !css.includes('NaN'),
    css.includes('${') ? 'a ${…} survived evaluation' : 'clean')
  record('the sheet carries the hover rule',
    /\.dshAppEffort-tick\[data-hover="1"\]\s*\{/u.test(css),
    (css.match(/\.dshAppEffort-tick\[data-hover="1"\]\s*\{[^}]*\}/u) ?? ['(missing)'])[0].replaceAll('\n', ' '))
  record('the tick transition names transform alone',
    /\.dshAppEffort-tick\s*\{[^}]*transition: transform [\d.]+ms/u.test(css),
    (css.match(/transition: transform [\d.]+ms[^;]*/u) ?? ['(missing)'])[0])
  record('reduced motion drops the tick transition',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dshAppEffort-tick/u.test(css),
    'the media block names the tick')

  const win = new BrowserWindow({
    width: 480,
    height: 360,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  await win.loadURL('about:blank')
  await win.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style')
    style.id = 'effort'
    style.textContent = ${JSON.stringify(css)}
    document.head.append(style)
  })()`)

  // Animations are FINISHED rather than waited out. A window that is not shown is
  // throttled, and a `setTimeout` race against a 120ms transition measured the
  // reverting mark as stuck at its grown size — a harness artefact that reads
  // exactly like a real bug. `finish()` is deterministic and asserts the same
  // thing: the rule applies and the transition is what carries it.
  const measured = await win.webContents.executeJavaScript(`(async () => {
    const settle = () => { for (const animation of document.getAnimations()) { try { animation.finish() } catch { /* infinite ones */ } } }
    const host = document.createElement('div')
    host.className = 'dshAppEffort'
    host.style.width = '320px'
    host.innerHTML = '<div class="dshAppEffort-track" data-mode="interactive" data-energy="1">'
      + '<span class="dshAppEffort-tick" data-on="1" id="probe-neighbour" style="left:38%"></span>'
      + '<span class="dshAppEffort-tick" data-on="0" id="probe-target" style="left:62%"></span>'
      + '</div>'
    document.body.append(host)
    const target = document.getElementById('probe-target')
    const neighbour = document.getElementById('probe-neighbour')
    const rest = target.getBoundingClientRect()
    const neighbourRest = neighbour.getBoundingClientRect()
    const transitionProperty = getComputedStyle(target).transitionProperty
    target.setAttribute('data-hover', '1')
    await new Promise(resolve => { setTimeout(resolve, 20) })
    const runningTransition = (target.getAnimations?.() ?? []).length
    settle()
    const grown = target.getBoundingClientRect()
    const neighbourGrown = neighbour.getBoundingClientRect()
    target.setAttribute('data-hover', '0')
    await new Promise(resolve => { setTimeout(resolve, 20) })
    settle()
    const back = target.getBoundingClientRect()
    return {
      restWidth: rest.width,
      grownWidth: grown.width,
      backWidth: back.width,
      neighbourRest: neighbourRest.left,
      neighbourGrown: neighbourGrown.left,
      transitionProperty,
      runningTransition,
    }
  })()`)

  record('hovering a tick makes it measurably larger',
    measured.grownWidth > measured.restWidth * 1.5,
    `${measured.restWidth.toFixed(2)}px → ${measured.grownWidth.toFixed(2)}px`)
  record('the mark returns to its rest size when the hover clears',
    Math.abs(measured.backWidth - measured.restWidth) < 0.05,
    `${measured.grownWidth.toFixed(2)}px → ${measured.backWidth.toFixed(2)}px`)
  record('a neighbouring tick does not move when one grows (no re-layout)',
    Math.abs(measured.neighbourGrown - measured.neighbourRest) < 0.05,
    `neighbour x ${measured.neighbourRest.toFixed(2)} → ${measured.neighbourGrown.toFixed(2)}`)
  record('the computed transition names transform, not all',
    measured.transitionProperty === 'transform' || measured.transitionProperty === '-webkit-transform',
    `transition-property: ${measured.transitionProperty}`)
  record('the change is animated, not instant',
    measured.runningTransition > 0,
    `${measured.runningTransition} running transition(s) after the attribute changed`)

  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  const reduced = await win.webContents.executeJavaScript(`(async () => {
    const settle = () => { for (const animation of document.getAnimations()) { try { animation.finish() } catch { /* infinite ones */ } } }
    const host = document.createElement('div')
    host.className = 'dshAppEffort'
    host.style.width = '320px'
    host.innerHTML = '<div class="dshAppEffort-track" data-mode="interactive">'
      + '<span class="dshAppEffort-tick" id="rm" data-on="0" style="left:50%"></span>'
      + '</div>'
    document.body.append(host)
    const tick = document.getElementById('rm')
    const rest = tick.getBoundingClientRect().width
    const style = getComputedStyle(tick)
    tick.setAttribute('data-hover', '1')
    await new Promise(resolve => { setTimeout(resolve, 20) })
    const running = (tick.getAnimations?.() ?? []).length
    settle()
    return {
      rest,
      hovered: tick.getBoundingClientRect().width,
      property: style.transitionProperty,
      duration: style.transitionDuration,
      running,
    }
  })()`)
  win.webContents.debugger.detach()

  record('reduced motion keeps the mark without animating it',
    reduced.hovered > reduced.rest * 1.5,
    `width ${reduced.rest.toFixed(2)} → ${reduced.hovered.toFixed(2)}`)
  record('reduced motion removes the tick transition',
    reduced.property === 'none' || reduced.duration === '0s',
    `transition ${reduced.property} ${reduced.duration}`)
  record('reduced motion starts no transition at all',
    reduced.running === 0,
    `${reduced.running} running transition(s)`)

  console.log('\n--- effort track visuals ---')
  for (const line of lines) console.log(line)
  const failed = lines.filter(line => line.startsWith('FAIL')).length
  console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${lines.length - failed}/${lines.length})`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
}

app.disableHardwareAcceleration()
app.whenReady().then(main).catch((error) => {
  console.error(`probe failed: ${error?.stack ?? String(error)}`)
  app.exit(1)
})
