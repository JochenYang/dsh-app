#!/usr/bin/env node
/**
 * Runtime probe for the PPT panel's colour row.
 *
 * Why a probe and not a test: the three facts below are about a LAID-OUT row, and each
 * of them reads as correct in source.
 *
 *   C1  The chip row WRAPS instead of overflowing. Ten colourways plus 「模板自带」 in a
 *       320px-wide panel is a horizontal scrollbar unless the container wraps, and a
 *       scrolled-out-of-view accent is a choice the user cannot make.
 *   C2  A chip's label stays on ONE line and is not ellipsised while the chip has room.
 *       The chips are `white-space: nowrap` with `flex: none`; a future `flex: 1` or a
 *       missing `nowrap` squeezes 「克莱因蓝」 into two lines and the row doubles height.
 *   C3  The three swatch panes are three DISTINCT colours and each is wide enough to
 *       see. A swatch that renders one flat block — because `flex: 1 1 0` collapsed two
 *       panes, or because the slot names no longer match the host's palette keys — still
 *       looks like "a swatch" in a screenshot and carries no information.
 *   C4  The brand-colour input keeps its own width at the panel's narrow floor, and the
 *       label beside it is not squeezed to an unreadable width.
 *
 * It boots NO kernel and needs no runtime artifact: the stylesheet is a plain template
 * literal, so the probe BUNDLES `src/client/styles.ts` with esbuild, runs `adoptStyles`
 * against a stub document to capture the exact string that reaches the DOM, and then
 * measures what Chromium computed. The DOM shape is the one `TemplatePanel` renders.
 *
 * WHAT IT CANNOT PROVE: the row is built by this file, not by the component. Deleting
 * the `.dshPptColourChips` wrapper from `ppt-entry.tsx` leaves these assertions green;
 * the last assertion therefore reads the component source for the classes that make the
 * row work, which is the half a layout measurement cannot see. The React state rules
 * (apply disabled while the colour is invalid, choosing a colourway clearing the brand
 * text) are unit-testable logic, not layout — they are covered by the client suite.
 *
 * Run: node_modules/.bin/electron scripts/probe-ppt-colours.cjs
 *
 * @module dsh-app/scripts/probe-ppt-colours
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const lines = []

function record(label, ok, detail) {
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Evaluate the plugin's real stylesheet through the module's own `adoptStyles`. */
async function evaluatedStylesheet() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-css-'))
  const outfile = path.join(outdir, 'styles.cjs')
  buildSync({
    entryPoints: [path.join(root, 'plugins/plugin-ppt/src/client/styles.ts')],
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
    // The async form: this repo's delete guard measures it as safe around links.
    await fs.promises.rm(outdir, { recursive: true, force: true })
  }
  return captured.join('\n')
}

async function main() {
  const css = await evaluatedStylesheet()
  record('the evaluated stylesheet carries the colour-row rules',
    css.includes('.dshPptColourChip') && css.includes('.dshPptSwatchPane') && css.includes('.dshPptBrandInput'),
    `${css.length} chars`)
  record('every expression resolved before the sheet reached the DOM',
    !css.includes('${') && !css.includes('undefined') && !css.includes('NaN'),
    css.includes('${') ? 'a ${…} survived evaluation' : 'clean')

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  await win.loadURL('about:blank')
  await win.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style')
    style.textContent = ${JSON.stringify(css)}
    document.head.append(style)
  })()`)

  // The panel's narrow floor: `.dshPptPanel` is a flex column with padding, and the
  // grid inside it can be as narrow as ~300px on a small window.
  const measured = await win.webContents.executeJavaScript(`(() => {
    const PRESETS = [
      ['墨水经典', ['#f1efea', '#0a0a0b', '#111111']],
      ['靛蓝瓷', ['#f1f3f5', '#0a1f3d', '#315d93']],
      ['森林墨', ['#f5f1e8', '#1a2e1f', '#2e6b4f']],
      ['牛皮纸', ['#eedfc7', '#2a1e13', '#9b5a2e']],
      ['沙丘', ['#f0e6d2', '#1f1a14', '#8f7650']],
      ['午夜墨', ['#0e0d0c', '#ece2cf', '#d4a04a']],
      ['克莱因蓝', ['#fafaf8', '#0a0a0a', '#002fa7']],
      ['柠檬黄', ['#fafaf8', '#0a0a0a', '#ffd500']],
      ['柠檬绿', ['#fafaf8', '#0a0a0a', '#c5e803']],
      ['安全橙', ['#fafaf8', '#0a0a0a', '#ff6b35']],
    ]
    const colours = document.createElement('div')
    colours.className = 'dshPptColours'
    colours.style.width = '320px'
    const label = document.createElement('span')
    label.className = 'dshPptColoursLabel'
    label.textContent = '配色'
    colours.append(label)

    const chips = document.createElement('div')
    chips.className = 'dshPptColourChips'
    const own = document.createElement('button')
    own.type = 'button'
    own.className = 'dshPptColourChip'
    own.textContent = '模板自带'
    chips.append(own)
    const built = []
    for (const [name, slots] of PRESETS) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'dshPptColourChip'
      const swatch = document.createElement('span')
      swatch.className = 'dshPptSwatch'
      const panes = []
      for (const colour of slots) {
        const pane = document.createElement('span')
        pane.className = 'dshPptSwatchPane'
        pane.style.background = colour
        swatch.append(pane)
        panes.push(pane)
      }
      chip.append(swatch)
      chip.append(document.createTextNode(name))
      chips.append(chip)
      built.push({ chip, panes })
    }
    colours.append(chips)

    const row = document.createElement('label')
    row.className = 'dshPptBrandRow'
    const brandLabel = document.createElement('span')
    brandLabel.className = 'dshPptBrandLabel'
    brandLabel.textContent = '品牌色'
    const input = document.createElement('input')
    input.className = 'dshPptBrandInput'
    input.placeholder = '#RRGGBB，可留空'
    row.append(brandLabel, input)
    colours.append(row)
    document.body.append(colours)

    const chipRects = built.map(({ chip, panes }) => {
      const box = chip.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(chip)
      const swatchBox = chip.querySelector('.dshPptSwatch').getBoundingClientRect()
      return {
        height: box.height,
        width: box.width,
        inkWidth: swatchBox.width,
        paneWidths: panes.map(pane => pane.getBoundingClientRect().width),
        paneColours: panes.map(pane => getComputedStyle(pane).backgroundColor),
      }
    })
    const brandBox = input.getBoundingClientRect()
    const labelBox = brandLabel.getBoundingClientRect()
    const container = colours.getBoundingClientRect()
    return {
      overflowX: chips.scrollWidth - chips.clientWidth,
      containerOverflow: colours.scrollWidth - colours.clientWidth,
      chipsHeight: chips.getBoundingClientRect().height,
      singleRowHeight: Math.max(...chipRects.map(chip => chip.height)),
      chipCount: chipRects.length + 1,
      maxPaneWidth: Math.max(...chipRects.flatMap(chip => chip.paneWidths)),
      minPaneWidth: Math.min(...chipRects.flatMap(chip => chip.paneWidths)),
      distinctPanes: chipRects.every(chip => new Set(chip.paneColours).size === chip.paneColours.length),
      swatchWidth: Math.min(...chipRects.map(chip => chip.inkWidth)),
      brandWidth: brandBox.width,
      brandLabelWidth: labelBox.width,
      containerWidth: container.width,
      // A chip whose label wrapped would be ~1.6× the height of a single-line one.
      chipHeights: chipRects.map(chip => Math.round(chip.height)),
    }
  })()`)

  record('the chip row wraps instead of scrolling sideways at the panel floor',
    measured.overflowX <= 1 && measured.containerOverflow <= 1,
    `chips overflow ${measured.overflowX}px, container ${measured.containerOverflow}px at ${measured.containerWidth}px`)
  record('every chip label stays on one line',
    new Set(measured.chipHeights).size === 1,
    `chip heights ${measured.chipHeights.join('/')}px — a wrapped label would be visibly taller`)
  record('the three swatch panes are three distinct colours, each wide enough to see',
    measured.distinctPanes && measured.minPaneWidth >= 4 && measured.maxPaneWidth <= measured.minPaneWidth * 2,
    `panes ${measured.minPaneWidth.toFixed(1)}–${measured.maxPaneWidth.toFixed(1)}px, distinct=${measured.distinctPanes}`)
  record('the swatch keeps room for three panes',
    measured.swatchWidth >= 18,
    `${measured.swatchWidth.toFixed(1)}px swatch for ${measured.chipCount} chips`)
  record('the brand field keeps its own width and the label is not squeezed',
    measured.brandWidth >= 90 && measured.brandLabelWidth >= 36,
    `input ${measured.brandWidth.toFixed(1)}px, label ${measured.brandLabelWidth.toFixed(1)}px`)

  // The half a layout measurement cannot see: the component must actually use the
  // classes this probe measured, and must wire the colour choice into the apply call.
  const component = fs.readFileSync(path.join(root, 'plugins/plugin-ppt/src/client/ppt-entry.tsx'), 'utf8')
  record('the component renders the row this probe measured',
    component.includes('dshPptColourChips') && component.includes('dshPptSwatchPane') && component.includes('dshPptBrandInput'),
    'ppt-entry.tsx carries the three class names')
  record('the apply call carries the colour source, so a pick cannot land on the template palette',
    /onApply\(\s*picked,\s*\{\s*brand:/.test(component) && component.includes('palette: palettePick'),
    'applyPicked receives { brand, palette }')

  console.log('\n--- ppt panel colour row ---')
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
