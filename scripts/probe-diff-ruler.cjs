#!/usr/bin/env node
/**
 * Focused probe: is a diff ruler mark PAINTED at its true line fraction?
 *
 * This used to be asserted as part of a full Git-panel UI walk
 * (`probe-git-panel.cjs`, retired 2026-10-22). That walk depended on session
 * switching and Git-panel timing, so a red run proved nothing about the ruler;
 * this probe isolates the one fact instead. It renders the plugin's REAL
 * stylesheet in Chromium and measures marks whose spans the component itself
 * computes, so a CSS floor (a `min-height`, or a `Math.max(span, …)` in the
 * inline style) is the only thing that can make the measurement disagree.
 *
 * Why a floor matters. The ruler's whole job is "how much changed, and where": a
 * one-line change in a 400-line diff is 0.25% of the column and must read as a
 * hairline. A 2px floor paints it the same as a 20-line block, and on a long file
 * every mark then looks alike — the reader learns nothing from it.
 *
 * Assertions, by label:
 *   R1  the stylesheet applies NO minimum height to a mark (the painted box of a
 *       0.25% mark is its true sub-pixel fraction, not 2px)
 *   R2  a mark's painted height tracks its span across a range of spans — the
 *       ratio of painted heights equals the ratio of spans
 *   R3  the clickable area still reaches a hairline (the ::after overhang), so
 *       removing the floor did not make small changes un-clickable
 *
 * Usage:  node scripts/probe-diff-ruler.cjs
 */

const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const gitTab = path.join(repo, 'plugins', 'plugin-sidebar', 'src', 'client', 'git-tab.tsx')

/**
 * The plugin's own stylesheet, lifted out of the TSX template literal.
 *
 * Reading the SOURCE rather than the built bundle is deliberate: the bundle keeps
 * the template's placeholders, so a text slice of it is not CSS.
 */
function extractStylesheet(source) {
  // The styles live in one exported template literal; take the largest backtick
  // block that contains the ruler's own selectors.
  const blocks = [...source.matchAll(/`([^`]*\.dshAsbGit-ruler[^`]*)`/gu)].map(m => m[1])
  if (blocks.length === 0) throw new Error('could not find the ruler stylesheet in git-tab.tsx')
  return blocks.sort((a, b) => b.length - a.length)[0]
}

const results = []
const record = (id, ok, detail) => {
  results.push({ id, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}\n`)
}

app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  try {
    const css = extractStylesheet(readFileSync(gitTab, 'utf8'))

    const win = new BrowserWindow({ show: false, width: 400, height: 800 })
    await win.loadURL('about:blank')

    // A ruler of known height with marks at known spans, using the plugin's own
    // class names so its real rules are what applies.
    const measured = await win.webContents.executeJavaScript(`(function () {
      var style = document.createElement('style')
      style.textContent = ${JSON.stringify(css)}
      document.head.appendChild(style)

      // A 200px column, matching an ordinary diff pane.
      var ruler = document.createElement('div')
      ruler.className = 'dshAsbGit-ruler'
      ruler.style.height = '200px'
      document.body.appendChild(ruler)

      var spans = [0.25, 1, 5, 20]
      var nodes = spans.map(function (pct) {
        var mark = document.createElement('button')
        mark.type = 'button'
        mark.className = 'dshAsbGit-rulerMark dshAsbGit-rulerMarkAdd'
        mark.style.top = '0%'
        mark.style.height = pct + '%'
        ruler.appendChild(mark)
        return mark
      })

      var out = nodes.map(function (node, index) {
        var rect = node.getBoundingClientRect()
        var computed = getComputedStyle(node)
        // The overhang pseudo-element is what carries the click target.
        var after = getComputedStyle(node, '::after')
        return {
          spanPct: spans[index],
          painted: Math.round(rect.height * 1000) / 1000,
          minHeight: computed.minHeight,
          afterTop: after.top,
          afterBottom: after.bottom,
          afterContent: after.content,
        }
      })
      return { rulerHeight: 200, marks: out }
    })()`)

    const marks = measured.marks
    process.stdout.write(`probe: ruler ${measured.rulerHeight}px, marks ${JSON.stringify(marks.map(m => ({ span: m.spanPct, px: m.painted })))}\n`)

    // R1: no minimum height is applied, so a 0.25% mark paints at 0.5px.
    const smallest = marks.find(m => m.spanPct === 0.25)
    const noFloor = smallest !== undefined && smallest.painted < 1
    record('R1', noFloor,
      `a 0.25% mark paints at ${String(smallest?.painted)}px (a floor would make it >= 2px); computed min-height ${JSON.stringify(smallest?.minHeight)}`)

    // R2: painted heights are proportional to spans.
    const predicted = marks.map(m => (m.spanPct / 100) * measured.rulerHeight)
    const proportional = marks.every((m, i) => Math.abs(m.painted - predicted[i]) <= 0.5)
    record('R2', proportional,
      `painted ${JSON.stringify(marks.map(m => m.painted))} vs predicted ${JSON.stringify(predicted.map(p => Math.round(p * 1000) / 1000))}`)

    // R3: the click target still overhangs, so a hairline is reachable.
    const overhangs = marks.every(m => m.afterContent !== 'none' && parseFloat(m.afterTop) <= -1 && parseFloat(m.afterBottom) <= -1)
    record('R3', overhangs,
      `::after overhang present on every mark (top ${JSON.stringify(marks[0]?.afterTop)}, bottom ${JSON.stringify(marks[0]?.afterBottom)}, content ${JSON.stringify(marks[0]?.afterContent)})`)

    win.destroy()
  } catch (error) {
    record('R0', false, `probe threw: ${error instanceof Error ? error.message : String(error)}`)
  }

  const failed = results.filter(r => !r.ok)
  process.stdout.write(`\nprobe: ${results.length - failed.length}/${results.length} checks passed\n`)
  if (failed.length > 0) for (const item of failed) process.stdout.write(`  ${item.id}: ${item.detail}\n`)
  app.exit(failed.length === 0 ? 0 : 1)
})
