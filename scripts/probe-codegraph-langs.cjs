#!/usr/bin/env node
/**
 * Runtime probe for the code graph settings page's language grid.
 *
 * Why a probe and not a test: the three defects it pins down are facts about a
 * LAID-OUT row, and every one of them reads as correct in source.
 *
 *   L1  A two-character Chinese action label stays on ONE line. The row is a
 *       flex box in a grid column that can be as narrow as `minmax(240px, 1fr)`;
 *       a button with the default `flex-shrink: 1` was compressed to roughly one
 *       character wide and `下载` broke into `下` / `载`, which is what shipped.
 *   L2  A long language name is not squeezed while the row has room. Same cause
 *       from the other side: the name shrank first, so `Regular expression`
 *       truncated to `Regular...` beside several hundred pixels of empty space.
 *   L3  The action keeps its own width — the fix for L1/L2 must not be a
 *       narrower button that happens to fit.
 *
 * It boots NO kernel and needs no runtime artifact: the stylesheet is a plain
 * template literal, so the probe BUNDLES `src/client/styles.ts` with esbuild,
 * runs `adoptStyles` against a stub document to capture the exact string that
 * reaches the DOM, and then measures what Chromium computed. The primitives'
 * own `Button.module.css` and `Tag.module.css` are folded in with their class
 * names renamed, because the capsule and control geometry is theirs — measuring
 * a hand-written 44px box would assert this probe's arithmetic, not the page.
 *
 * WHAT IT CANNOT PROVE, stated here because the first version read as more: the
 * row is built by this file, not rendered by the component. Every measurement
 * below is "this CSS applied to this DOM shape", so deleting the
 * `dshcg_langAction` wrapper from `section.tsx` — the original defect, a bare
 * button with no `flex` rule — leaves the layout assertions green. The last three
 * assertions therefore read `section.tsx` itself and pin the structure and the
 * tooltip branch, which is the half a layout measurement cannot see. Rendering
 * the real component needs React and the primitives' CSS-module pipeline, which
 * this probe deliberately does not pull in.
 *
 * Run: node_modules/.bin/electron scripts/probe-codegraph-langs.cjs
 *
 * @module dsh-app/scripts/probe-codegraph-langs
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const PRIMITIVES = path.join(root, 'plugins/plugin-codegraph/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib')
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
 * Evaluate the plugin's real stylesheet.
 *
 * The module builds its CSS inside a template literal and exposes only
 * `adoptStyles`, so the probe reproduces the DOM surface that function touches
 * and keeps whatever it writes — the same seam the unit suite uses.
 *
 * @returns the stylesheet text.
 */
async function evaluatedStylesheet() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-css-'))
  const outfile = path.join(outdir, 'styles.cjs')
  buildSync({
    entryPoints: [path.join(root, 'plugins/plugin-codegraph/src/client/styles.ts')],
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
    // links, and its sync twin has followed a junction and emptied a tree.
    await fs.promises.rm(outdir, { recursive: true, force: true })
  }
  return captured.join('\n')
}

/**
 * One primitives stylesheet, with its class names renamed.
 *
 * The package ships CSS modules whose class names the bundler hashes, so the
 * probe reads the authored file and rewrites the selectors it uses. A rename that
 * silently matched nothing would make every assertion pass on unstyled boxes, so
 * each rewrite is asserted to have changed the text.
 *
 * @param file - the `.module.css` under the primitives package.
 * @param prefixes - old class prefix → new class prefix, longest first.
 * @returns the rewritten stylesheet.
 */
function primitivesCss(file, prefixes) {
  let body = fs.readFileSync(path.join(PRIMITIVES, file), 'utf8')
  for (const [from, to] of prefixes) {
    const before = body
    body = body.replaceAll(from, to)
    if (body === before) throw new Error(`${file} carries no "${from}" selector — the probe would measure unstyled boxes`)
  }
  return body
}

async function main() {
  const css = await evaluatedStylesheet()
  record('the evaluated stylesheet carries the row and name rules',
    css.includes('.dshcg_lang') && css.includes('.dshcg_langName') && css.includes('.dshcg_langAction'),
    `${css.length} chars`)
  record('every expression was resolved before the sheet reached the DOM',
    !css.includes('${') && !css.includes('undefined') && !css.includes('NaN'),
    css.includes('${') ? 'a ${…} survived evaluation' : 'clean')

  // The row alone would prove nothing: the squeeze came from the CONTROL's own
  // geometry, so the probe folds in the two primitives' authored rules.
  const buttonCss = primitivesCss('Button.module.css', [['.button', '.probeBtn'], ['.sm', '.probeBtnSm'], ['.ghost', '.probeBtnGhost']])
  const tagCss = primitivesCss('Tag.module.css', [['.tag', '.probeTag']])
  record('the control geometry under test is the primitives own',
    buttonCss.includes('height: 28px') && buttonCss.includes('padding: 0 10px'),
    'Button.module.css .sm folded in')

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  await win.loadURL('about:blank')
  await win.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style')
    style.textContent = ${JSON.stringify([css, buttonCss, tagCss].join('\n'))}
    document.head.append(style)
  })()`)

  /**
   * Measure one language row at a given column width.
   *
   * The markup is the exact shape `LanguageItem` renders — name, tags, and the
   * action wrapped in `.dshcg_langAction`. A language WITHOUT an extension has no
   * action in the row at all, which is the case the empty-tooltip defect came
   * from, so the caller decides whether to append it.
   */
  const measure = await win.webContents.executeJavaScript(`(async () => {
    /**
     * Build the row the COMPONENT renders: a main line (name + action) and a
     * metadata line (tags).
     *
     * Two rows, not one flat wrapped line — and the assertions below are about
     * the geometry that difference produces, so the shape here must match
     * \`section.tsx\`. A probe that built the old flat shape would keep passing
     * while the card on screen looked like the report: a button stranded on its
     * own line and cards of unequal height.
     */
    const build = (width, { name, tags, action }) => {
      const grid = document.createElement('div')
      grid.className = 'dshcg_langs'
      grid.style.width = width + 'px'
      // One column, so the grid's own minmax() is exercised at its floor.
      grid.style.gridTemplateColumns = '1fr'
      const row = document.createElement('div')
      row.className = 'dshcg_lang'
      const main = document.createElement('div')
      main.className = 'dshcg_langMain'
      const nameEl = document.createElement('span')
      nameEl.className = 'dshcg_langName'
      // The TOOLTIP ANCHOR is this inner inline span, not the flex item around
      // it — that separation is the fix. The primitive measures this element, so
      // these assertions are only meaningful against it.
      const labelEl = document.createElement('span')
      labelEl.className = 'dshcg_langLabel'
      labelEl.textContent = name
      nameEl.append(labelEl)
      main.append(nameEl)
      let button
      if (action !== undefined) {
        const holder = document.createElement('span')
        holder.className = 'dshcg_langAction'
        button = document.createElement('button')
        button.type = 'button'
        button.className = 'probeBtn probeBtnGhost probeBtnSm'
        button.textContent = action
        holder.append(button)
        main.append(holder)
      }
      row.append(main)
      const meta = document.createElement('div')
      meta.className = 'dshcg_langMeta'
      for (const text of tags) {
        const tag = document.createElement('span')
        tag.className = 'probeTag'
        tag.dataset.tone = 'neutral'
        tag.textContent = text
        meta.append(tag)
      }
      row.append(meta)
      grid.append(row)
      document.body.append(grid)
      return { grid, row, nameEl, labelEl, button }
    }
    /** How many line boxes a button's own text occupies. */
    const textLines = (button) => {
      const range = document.createRange()
      range.selectNodeContents(button)
      return range.getClientRects().length
    }
    const rows = []
    /** The width of a box's OWN TEXT, not the box. */
    const textWidth = (el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return range.getBoundingClientRect().width
    }
    // The grid's declared floor is minmax(240px, 1fr); 240 is the narrowest a
    // column can be, so that is where a squeezed control shows up first.
    for (const width of [240, 300, 520]) {
      const narrow = build(width, { name: 'Regular expression', tags: ['未安装', '无提取规则'], action: '下载' })
      const button = narrow.button
      const nameBox = narrow.nameEl
      const rowBox = narrow.row.getBoundingClientRect()
      const buttonBox = button.getBoundingClientRect()
      const nameBoxRect = nameBox.getBoundingClientRect()
      rows.push({
        width,
        lines: textLines(button),
        buttonWidth: buttonBox.width,
        buttonHeight: buttonBox.height,
        buttonOverflows: button.scrollWidth > button.clientWidth + 1,
        nameClient: nameBox.clientWidth,
        nameScroll: nameBox.scrollWidth,
        nameTruncated: nameBox.scrollWidth > nameBox.clientWidth + 1,
        // THE ANCHOR FIT IS THE TOOLTIP'S POSITION. The name box is the element
        // the Tooltip measures, so a box wider than its text puts the bubble over
        // empty card instead of over the word — measured at 164px of box for 31px
        // of "Ruby", which is exactly where the reported bubble landed.
        nameBoxWidth: nameBoxRect.width,
        nameTextWidth: textWidth(nameBox),
        rowRight: rowBox.right,
        rowHeight: rowBox.height,
        buttonRight: buttonBox.right,
        // The two boxes share a line when their vertical centres agree. A button
        // that WRAPPED onto its own line has a different centre — the defect the
        // report showed, which "how many line boxes does the text occupy" could
        // never see: a stranded button renders its two characters on one line
        // quite happily.
        buttonCentreY: buttonBox.top + buttonBox.height / 2,
        nameCentreY: nameBoxRect.top + nameBoxRect.height / 2,
      })
      narrow.grid.remove()
    }
    // Equal card heights across the grid: a card whose tags wrap to a second
    // line while its neighbour's do not is what made the report's two cards
    // different sizes.
    const tall = build(240, { name: 'INI / TOML', tags: ['未安装', '无提取规则'], action: '下载' })
    const short = build(240, { name: 'Rust', tags: ['未安装'], action: '下载' })
    tall.row.style.width = '232px'
    short.row.style.width = '232px'
    const heights = { tall: tall.row.getBoundingClientRect().height, short: short.row.getBoundingClientRect().height }
    tall.grid.remove()
    short.grid.remove()
    // A bundled language renders NO action, so the wrapper must be absent from
    // ITS row. This measures the wrapper the COMPONENT emits in the other case
    // below; the bundled case is asserted structurally at the end, because the
    // probe builds the row itself, so a "no holder" assertion here would be
    // true by construction — it would measure this file's own arithmetic, not
    // the component.
    const withAction = build(240, { name: 'TypeScript', tags: ['随包提供', '1.3MB'], action: '下载' })
    const holderCount = withAction.row.querySelectorAll('.dshcg_langAction').length
    withAction.grid.remove()
    // The tooltip anchor: a SHORT name in a WIDE column. This is the shape that
    // shipped a bubble over empty card, because the name cell grew to fill the
    // row and the bubble is placed from that cell's rect.
    const fits = []
    for (const width of [240, 420]) {
      const wide = build(width, { name: 'Ruby', tags: ['未安装'], action: '下载' })
      wide.grid.style.gridTemplateColumns = '1fr'
      const anchorRect = wide.labelEl.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(wide.labelEl)
      fits.push({ width, boxWidth: anchorRect.width, textWidth: range.getBoundingClientRect().width })
      wide.grid.remove()
    }
    return { rows, holderCount, heights, fits }
  })()`)

  for (const row of measure.rows) {
    record(`the action label stays on one line at a ${row.width}px column`,
      row.lines === 1,
      `${row.lines} line box(es), button ${row.buttonWidth.toFixed(1)}x${row.buttonHeight.toFixed(1)}`)
    record(`the action is not clipped at a ${row.width}px column`,
      row.buttonOverflows === false && row.buttonRight <= row.rowRight + 0.5,
      `overflow=${String(row.buttonOverflows)} right=${row.buttonRight.toFixed(1)} row=${row.rowRight.toFixed(1)}`)
    // The assertion the previous version of this probe lacked, and the reason a
    // stranded button shipped: the label rendered on one line and the name was
    // not truncated, so every old check passed while the button sat alone on a
    // second row, pushed right by an auto margin.
    record(`the action shares a line with the name at a ${row.width}px column`,
      Math.abs(row.buttonCentreY - row.nameCentreY) <= 1,
      `button centre ${row.buttonCentreY.toFixed(1)}px vs name centre ${row.nameCentreY.toFixed(1)}px`)
  }

  record('cards in one grid keep the same height whatever their tags wrap to',
    Math.abs(measure.heights.tall - measure.heights.short) <= 0.5,
    `two-tag card ${measure.heights.tall.toFixed(1)}px vs one-tag card ${measure.heights.short.toFixed(1)}px`)

  // L2 is about the NAME, and only where the row genuinely has room: at 240px the
  // name plus two tags plus the button exceed the line, so a wrap is correct and
  // a truncation is not — the row wraps instead of cutting the label.
  for (const row of measure.rows) {
    record(`the language name is not truncated at a ${row.width}px column`,
      row.nameTruncated === false,
      `client=${String(row.nameClient)}px scroll=${String(row.nameScroll)}px`)
  }
  record('the action wrapper the stylesheet targets is present in an action row',
    measure.holderCount === 1,
    `${String(measure.holderCount)} .dshcg_langAction node(s)`)

  // The tooltip's position IS this box. A short name at a wide column is the case
  // that shipped wrong: the name cell grew to fill the row (164px for the 31px
  // word "Ruby"), and the bubble, centred on that box, floated out over the empty
  // card — what the report circled.
  for (const fit of measure.fits) {
    record(`the name box hugs its text at a ${fit.width}px column (the tooltip anchor)`,
      Math.abs(fit.boxWidth - fit.textWidth) <= 2,
      `box ${fit.boxWidth.toFixed(1)}px vs text ${fit.textWidth.toFixed(1)}px — the bubble lands on the box, not the word`)
  }

  // The JSX half. The measurements above run against a row this probe builds, so
  // they can only prove the CSS. These read the COMPONENT, which is what decides
  // whether the wrapper, the two-row structure and the tooltip branch exist at
  // all.
  const section = fs.readFileSync(path.join(root, 'plugins/plugin-codegraph/src/client/section.tsx'), 'utf8')
  record('the component wraps its action in the class the stylesheet targets',
    /className="dshcg_langAction"/u.test(section),
    'section.tsx `dshcg_langAction`')
  // The rows the CSS shapes must be the rows the component renders, or the
  // geometry above describes a DOM that never reaches a screen.
  record('the component renders the two-row card the stylesheet shapes',
    /className="dshcg_langMain"/u.test(section) && /className="dshcg_langMeta"/u.test(section),
    'section.tsx `dshcg_langMain` + `dshcg_langMeta`')
  record('the component skips the tooltip when it has no label',
    /bubble\.label === undefined/u.test(section),
    'section.tsx branches on `bubble.label`')
  record('the component portals its tooltip out of the dialog panel',
    // The defect this pins: the bubble is `position: fixed`, and the settings
    // panel carries a `transform`, so a non-portaled bubble positioned itself
    // against that ancestor and appeared ~70px away from the language it named.
    // Measured in the browser below; this asserts the PROP that does it.
    /<Tooltip label=\{bubble\.label\}[^>]*\sportal/u.test(section),
    'section.tsx passes `portal` to the language Tooltip')
  record('a bundled language renders no action button at all',
    /\{language\.bundled \? null : \(/u.test(section),
    'a disabled button would suggest a state the user could reach')

  // T1: the offset itself, measured. A transformed ancestor is exactly the
  // condition that broke it, so the probe builds one and asks where a
  // `position: fixed` box actually lands. Without a portal the answer is
  // "relative to the ancestor"; with one it is "relative to the viewport".
  const anchorRect = await win.webContents.executeJavaScript(`(() => {
    const panel = document.createElement('div')
    // The settings panel's own shape: a transform makes this element the
    // containing block for any fixed descendant.
    panel.style.cssText = 'position:absolute;left:120px;top:80px;transform:translateZ(0);padding:20px'
    const anchor = document.createElement('span')
    anchor.textContent = 'PHP'
    panel.append(anchor)
    document.body.append(panel)
    const box = anchor.getBoundingClientRect()
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px'
    // Inside the transformed panel: the fixed box is placed against the PANEL,
    // not the viewport, which is the whole bug.
    panel.append(probe)
    const inside = probe.getBoundingClientRect()
    document.body.append(probe)
    const portaled = probe.getBoundingClientRect()
    panel.remove()
    probe.remove()
    return { anchorLeft: box.left, anchorTop: box.top, insideLeft: inside.left, portaledLeft: portaled.left }
  })()`)
  record('a fixed box inside the transformed panel is displaced (the mechanism behind the offset)',
    Math.abs(anchorRect.insideLeft - anchorRect.portaledLeft) > 1,
    `inside the panel a fixed box sits at x=${anchorRect.insideLeft.toFixed(1)}; portaled it sits at x=${anchorRect.portaledLeft.toFixed(1)} — that gap is what put the bubble ~70px from its language`)

  console.log('\n--- code graph language rows ---')
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
