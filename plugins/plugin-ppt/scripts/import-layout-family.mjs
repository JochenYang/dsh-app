#!/usr/bin/env node
/**
 * Import a 16:9 SVG layout family into the bundled template catalog.
 *
 * The pinned open-source layout assets are structure-only SVGs: every editable
 * slot is a `<g data-pptx-placeholder>` carrying `data-pptx-bounds` in a
 * 1280x720 pixel space, and every fixed decoration is a rect/circle/line
 * marked `data-pptx-layer` or `data-pptx-editable="false"`. This script
 * parses those attributes (plain XML attribute reading, no renderer) and emits
 * one bundled template:
 *
 *   - `.page` files: source pixels x 0.75 -> the 960x540 point canvas.
 *   - metadata zones: source pixels, i.e. `.page` points x 4/3, with the
 *     slot's textCapacity budget. Zones and `.page` elements are emitted from
 *     one walk so the two can never drift.
 *   - `deck.pptd`, plus fresh preview JPEGs through the shared rasterizer.
 *
 * Filtering: slots are only `<g data-pptx-placeholder>` groups WITHOUT a
 * master/layout layer or `data-pptx-editable="false"`; the latter (panels,
 * rules, rails, node circles) are extracted separately as editable shapes and
 * lines so the preview shows exactly what the page draws. A slot whose
 * placeholder is `picture`, `chart` or `table` cannot be a native element from
 * structure alone, so it degrades to a placeholder text block that keeps the
 * slot geometry (see the printed report).
 *
 * Usage (from anywhere):
 *   node plugins/plugin-ppt/scripts/import-layout-family.mjs --layouts <asset-root>
 *   node plugins/plugin-ppt/scripts/import-layout-family.mjs --layouts <asset-root> --only dsh-slate-grid
 *   node plugins/plugin-ppt/scripts/import-layout-family.mjs --layouts <asset-root> --skip-render
 *
 * `<asset-root>` is the directory holding the family folders (each with
 * `templates/*.svg`); the page list lives in layout-family-imports.json.
 * Idempotent: a rerun rewrites the same bytes. Never touches other templates.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pageScene, renderPreviews } from './preview-scenes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const templatesRoot = join(pluginRoot, 'templates')
const configPath = join(here, 'layout-family-imports.json')
const PAGE_COUNT = 12
/** Source pixels -> PPTD points (960/1280). */
const PX_TO_PT = 0.75
/** Degraded content-slot defaults: label + replacement hint, in points. */
const DEGRADED = {
  PICTURE: { text: '图片占位区\n替换为实拍图或截图', size: 18 },
  CHART: { text: '图表占位区\n替换为柱状图或折线图', size: 20 },
  TABLE: { text: '表格占位区\n替换为指标对照表', size: 20 },
}
const LINE_HEIGHT = 1.15

const args = process.argv.slice(2)
function argValue(name) {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined
}
const layoutsRoot = argValue('--layouts')
const only = argValue('--only')
const skipRender = args.includes('--skip-render')
const configArg = argValue('--config')
const activeConfigPath = configArg === undefined ? configPath : configArg

// --- XML attribute reading --------------------------------------------------

const TAG = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g
const ATTRIBUTE = /([\w:.-]+)="([^"]*)"/g

function attributes(source) {
  const record = {}
  for (const match of source.matchAll(ATTRIBUTE)) record[match[1]] = match[2]
  return record
}

/**
 * Flat document-order element list. Each node keeps its parent chain so a
 * slot's carrier/metadata can be read without descending into a sibling.
 */
function readXml(source) {
  const nodes = []
  const stack = []
  let cursor = 0
  TAG.lastIndex = 0
  for (let match = TAG.exec(source); match !== null; match = TAG.exec(source)) {
    const between = source.slice(cursor, match.index)
    if (between.trim() !== '' && stack.length > 0) stack.at(-1).text += between
    cursor = TAG.lastIndex
    const [, closing, tag, attributeText, selfClosing] = match
    if (closing === '/') {
      stack.pop()
      continue
    }
    const node = {
      tag,
      attributes: attributes(attributeText),
      children: [],
      parent: stack.at(-1) ?? null,
      text: '',
    }
    if (stack.length > 0) stack.at(-1).children.push(node)
    else nodes.push(node)
    if (selfClosing === '/') continue
    stack.push(node)
  }
  return nodes
}

function insideSlot(node) {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.attributes['data-pptx-placeholder'] !== undefined) return true
  }
  return false
}

function descendants(node) {
  const found = []
  const walk = (current) => {
    for (const child of current.children) {
      found.push(child)
      walk(child)
    }
  }
  walk(node)
  return found
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseBounds(value) {
  const parts = typeof value === 'string' ? value.trim().split(/\s+/).map(number) : []
  return parts.length === 4 && parts.every((item) => item !== undefined) ? parts : undefined
}

function toPoint(value) {
  return Number((value * PX_TO_PT).toFixed(3))
}

function hex(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : undefined
}

/** `#RRGGBB` -> the metadata zone convention (uppercase, no `#`). */
function bareHex(value) {
  return value.replace(/^#/, '').toUpperCase()
}

/** The capacity budget the template zone index publishes (mirrors src/text-layout.ts). */
function textCapacity(widthPt, heightPt, fontSize) {
  const perLine = Math.max(1, Math.floor(widthPt * 0.95 / fontSize))
  const lines = Math.max(1, Math.floor(heightPt / (fontSize * LINE_HEIGHT)))
  return Math.max(1, Math.min(1000, Math.floor(perLine * lines * 0.9)))
}

// --- SVG page extraction ----------------------------------------------------

/** Fixed decoration (panel, rule, rail, node circle, axis line) as a .page element. */
function decorationElement(node) {
  const attrs = node.attributes
  if (node.tag === 'rect') {
    const x = number(attrs.x)
    const y = number(attrs.y)
    const width = number(attrs.width)
    const height = number(attrs.height)
    const fill = hex(attrs.fill)
    if (x === undefined || y === undefined || width === undefined || height === undefined || fill === undefined) return undefined
    const stroke = hex(attrs.stroke)
    const strokeWidth = number(attrs['stroke-width']) ?? 0
    return {
      elementType: 'shape',
      shape: number(attrs.rx) > 0 ? 'roundRect' : 'rect',
      shapeName: number(attrs.rx) > 0 ? 'roundRect' : 'rect',
      bounds: [toPoint(x), toPoint(y), toPoint(width), toPoint(height)],
      px: [x, y, width, height],
      fill,
      stroke: stroke ?? fill,
      strokeWidth: strokeWidth === 0 ? 0 : Number((strokeWidth * PX_TO_PT).toFixed(3)),
    }
  }
  if (node.tag === 'circle') {
    const cx = number(attrs.cx)
    const cy = number(attrs.cy)
    const r = number(attrs.r)
    const fill = hex(attrs.fill)
    if (cx === undefined || cy === undefined || r === undefined || fill === undefined) return undefined
    const stroke = hex(attrs.stroke)
    const strokeWidth = number(attrs['stroke-width']) ?? 0
    return {
      elementType: 'shape',
      shape: 'ellipse',
      shapeName: 'ellipse',
      bounds: [toPoint(cx - r), toPoint(cy - r), toPoint(2 * r), toPoint(2 * r)],
      px: [cx - r, cy - r, 2 * r, 2 * r],
      fill,
      stroke: stroke ?? fill,
      strokeWidth: strokeWidth === 0 ? 0 : Number((strokeWidth * PX_TO_PT).toFixed(3)),
    }
  }
  if (node.tag === 'line') {
    const x1 = number(attrs.x1)
    const y1 = number(attrs.y1)
    const x2 = number(attrs.x2)
    const y2 = number(attrs.y2)
    const stroke = hex(attrs.stroke)
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined || stroke === undefined) return undefined
    const horizontal = y1 === y2
    const vertical = x1 === x2
    // A hairline box: the renderer draws the stroke, the 1px axis keeps the
    // element inside the canvas without implying a filled area.
    const px = horizontal
      ? [Math.min(x1, x2), y1, Math.abs(x2 - x1), 1]
      : vertical ? [x1, Math.min(y1, y2), 1, Math.abs(y2 - y1)] : [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)]
    const points = horizontal
      ? `0,0 ${toPoint(px[2])},0`
      : vertical ? `0,0 0,${toPoint(px[3])}` : `0,0 ${toPoint(px[2])},${toPoint(px[3])}`
    return {
      elementType: 'line',
      bounds: [toPoint(px[0]), toPoint(px[1]), toPoint(px[2]), toPoint(px[3])],
      px,
      viewBox: [toPoint(px[2]), toPoint(px[3])],
      points,
      stroke,
      strokeWidth: Number(((number(attrs['stroke-width']) ?? 1) * PX_TO_PT).toFixed(3)),
    }
  }
  return undefined
}

/** Read one SVG into its background, fixed decoration and editable slots. */
function extractPage(file) {
  const source = readFileSync(file, 'utf8')
  const [svg] = readXml(source)
  if (svg === undefined || svg.tag !== 'svg') throw new Error(`无法解析 SVG 根元素：${file}`)
  const all = descendants(svg)
  const every = [svg, ...all]

  let background
  const decorations = []
  const slots = []
  for (const node of every) {
    const attrs = node.attributes
    const layered = attrs['data-pptx-layer'] !== undefined
    const locked = attrs['data-pptx-editable'] === 'false'
    if (node.tag === 'rect' && attrs['data-pptx-layer'] === 'master') {
      background = hex(attrs.fill)
      continue
    }
    if ((layered || locked) && !insideSlot(node)) {
      const decoration = decorationElement(node)
      if (decoration !== undefined) decorations.push(decoration)
      else if (['rect', 'circle', 'ellipse', 'line', 'path'].includes(node.tag)) {
        console.log(`  ! 跳过无法表达的装饰元素 <${node.tag} id=${attrs.id ?? '?'}>（预览与产出同时省略）`)
      }
      continue
    }
    if (node.tag === 'g' && attrs['data-pptx-placeholder'] !== undefined && !layered && !locked) slots.push(node)
  }
  if (background === undefined) throw new Error(`SVG 缺少 master 背景：${file}`)
  return { background, decorations, slots, layoutName: svg.attributes['data-pptx-layout-name'] ?? '' }
}

function carrierOf(slot) {
  const nodes = descendants(slot)
  const text = nodes.find((node) => node.tag === 'text' && node.attributes['data-pptx-carrier'] === 'true')
  const metadata = nodes.find((node) => node.tag === 'metadata')
  let payload
  if (metadata !== undefined) {
    try {
      payload = JSON.parse(metadata.text)
    } catch {
      payload = undefined
    }
  }
  return { text, payload }
}

// --- emission ---------------------------------------------------------------

/** YAML scalar for one line of copy; block literal when it spans lines. */
function yamlScalar(value) {
  if (value.includes('\n')) return undefined
  // A plain scalar must start with a letter/CJK and read back as a string:
  // `1.08` or `on` would otherwise parse as a number or boolean.
  const reserved = /^(?:true|false|null|yes|no|on|off|~)$/iu
  const plain = /^[\p{L}\u4e00-\u9fff][^:#\n]*$/u.test(value)
    && !reserved.test(value)
    && value.trim() === value
    && !value.includes(': ')
    && !value.includes(' #')
  if (plain) return value
  return `'${value.replaceAll("'", "''")}'`
}

function scalarLines(key, value, indent) {
  const pad = ' '.repeat(indent)
  const inline = yamlScalar(value)
  if (inline !== undefined) return [`${pad}${key}: ${inline}`]
  return [`${pad}${key}: |-`, ...value.split('\n').map((line) => `${pad}  ${line}`)]
}

function boundsLines(key, values, indent) {
  const pad = ' '.repeat(indent)
  return [`${pad}${key}:`, ...values.map((value) => `${pad}  - ${value}`)]
}

function fontFamilyLines(key, font, indent, anchor) {
  const pad = ' '.repeat(indent)
  return [
    `${pad}${key}: ${anchor}`,
    `${pad}  latin: ${font.latin}`,
    `${pad}  ea: ${font.ea}`,
    `${pad}  mac: ${font.mac}`,
    `${pad}  win: ${font.win}`,
  ]
}

function renderPage(page) {
  const lines = []
  lines.push(`pageType: ${page.pageType}`)
  lines.push('background:')
  lines.push('  type: solid')
  lines.push(`  color: '${page.background}'`)
  lines.push(...scalarLines('notes', page.notes, 0))
  lines.push('elements:')
  const anchors = new Map()
  for (const element of page.elements) {
    lines.push(`  - elementId: ${element.elementId}`)
    lines.push(`    elementType: ${element.elementType}`)
    lines.push(...boundsLines('bounds', element.bounds, 4))
    if (element.elementType === 'shape') {
      lines.push(`    shapeName: ${element.shapeName}`)
      lines.push('    fill:')
      lines.push('      type: solid')
      lines.push(`      color: '${element.fill}'`)
      lines.push('    border:')
      lines.push(`      width: ${element.strokeWidth}`)
      lines.push(`      color: '${element.stroke}'`)
    } else if (element.elementType === 'line') {
      lines.push(...boundsLines('viewBox', element.viewBox, 4))
      lines.push(`    points: ${element.points}`)
      lines.push('    border:')
      lines.push(`      color: '${element.stroke}'`)
      lines.push(`      width: ${element.strokeWidth}`)
    } else {
      lines.push('    content:')
      lines.push(...scalarLines('text', element.text, 6))
      const key = `${element.font.latin}|${element.font.ea}|${element.font.mac}|${element.font.win}`
      const anchor = anchors.get(key)
      if (anchor === undefined) {
        const name = `&ref_${anchors.size}`
        anchors.set(key, name)
        lines.push(...fontFamilyLines('fontFamily', element.font, 6, name))
      } else {
        lines.push(`      fontFamily: ${anchor.replace('&', '*')}`)
      }
      lines.push(`      fontSize: ${element.fontSize}`)
      lines.push(`      color: '${element.color}'`)
      lines.push(`      lineHeight: ${element.lineHeight ?? LINE_HEIGHT}`)
      lines.push(`      bold: ${element.bold}`)
      if (element.alignH !== undefined || element.alignV !== undefined) {
        lines.push(`      align: [${element.alignH ?? 'left'}, ${element.alignV ?? 'top'}]`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

function renderDeck(meta) {
  return [
    'version: v2',
    `title: ${meta.name}`,
    'size:',
    '  - 960',
    '  - 540',
    'template:',
    `  id: ${meta.id}`,
    `  name: ${meta.nameEn}`,
    'pages:',
    ...Array.from({ length: meta.pages.length }, (_, index) => `  - pages/${String(index + 1).padStart(2, '0')}.page`),
    '',
  ].join('\n')
}

/** The per-slot font table a `.page` text element carries. */
function fontMap(spec) {
  const zhFallbacks = spec.fonts.fallbacks?.zh ?? {}
  return {
    latin: spec.fonts.en?.body ?? 'Arial',
    ea: zhFallbacks.Linux?.sans ?? 'Noto Sans CJK SC',
    mac: zhFallbacks.macOS?.sans ?? 'PingFang SC',
    win: zhFallbacks.Windows?.sans ?? 'Microsoft YaHei',
  }
}

function importFamily(spec, layoutsRoot) {
  if (spec.pages.length !== PAGE_COUNT) throw new Error(`${spec.id}: 需要 ${PAGE_COUNT} 页，配置里是 ${spec.pages.length} 页`)
  const outDir = join(templatesRoot, spec.category, spec.id)
  const pagesDir = join(outDir, 'source-zh', 'pages')
  mkdirSync(pagesDir, { recursive: true })

  const deckPages = []
  const scenes = []
  const primaryFont = fontMap(spec)
  const report = { degraded: [], decorations: 0, slots: 0 }
  for (const [index, pageSpec] of spec.pages.entries()) {
    const file = join(layoutsRoot, ...pageSpec.file.split('/'))
    if (!existsSync(file)) throw new Error(`找不到版式资产：${file}`)
    const extracted = extractPage(file)
    const colorOverrideMap = Object.fromEntries(
      Object.entries(pageSpec.colorOverrides ?? {}).map(([from, to]) => [from.toUpperCase(), to]),
    )
    const colorOverride = (value) => {
      const normalized = value.startsWith('#') ? value.toUpperCase() : `#${value.toUpperCase()}`
      return colorOverrideMap[normalized] ?? normalized
    }
    const elements = []
    const zones = []
    let shapeIndex = 0
    let lineIndex = 0
    let textIndex = 0
    for (const decoration of extracted.decorations) {
      report.decorations += 1
      if (decoration.elementType === 'shape') {
        shapeIndex += 1
        elements.push({
          elementId: `s${shapeIndex}`,
          elementType: 'shape',
          shapeName: decoration.shapeName,
          bounds: decoration.bounds,
          fill: colorOverride(decoration.fill),
          stroke: colorOverride(decoration.stroke),
          strokeWidth: decoration.strokeWidth,
        })
        zones.push({
          kind: 'shape',
          x: decoration.px[0],
          y: decoration.px[1],
          width: decoration.px[2],
          height: decoration.px[3],
          shape: decoration.shape,
          fill: bareHex(colorOverride(decoration.fill)),
        })
      } else {
        lineIndex += 1
        elements.push({
          elementId: `l${lineIndex}`,
          elementType: 'line',
          bounds: decoration.bounds,
          viewBox: decoration.viewBox,
          points: decoration.points,
          stroke: colorOverride(decoration.stroke),
          strokeWidth: decoration.strokeWidth,
        })
      }
    }
    for (const slot of extracted.slots) {
      const placeholder = slot.attributes['data-pptx-placeholder']
      const bounds = parseBounds(slot.attributes['data-pptx-bounds'])
      if (bounds === undefined) throw new Error(`槽缺少有效 bounds：${pageSpec.file} ${slot.attributes.id ?? '?'}`)
      const { text, payload } = carrierOf(slot)
      const token = text?.text.match(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/)?.[1]
      const key = token ?? placeholder.toUpperCase()
      const pxBounds = bounds
      const ptBounds = bounds.map((value) => toPoint(value))
      textIndex += 1
      const degraded = DEGRADED[placeholder.toUpperCase()] !== undefined && token === undefined
      const example = pageSpec.examples?.[key]
      if (example === undefined && !degraded) throw new Error(`${spec.id} 第 ${index + 1} 页缺少 ${key} 的示例文案（请补 examples）`)
      const rawSize = number(text?.attributes['font-size'])
      const fontSize = pageSpec.sizes?.[key] ?? (degraded
        ? DEGRADED[placeholder.toUpperCase()].size
        : rawSize === undefined ? 18 : Number((rawSize * PX_TO_PT).toFixed(1)))
      if (degraded) {
        // The data slots carry their intended exhibit spec; naming it in the
        // report keeps the later native mapping a mechanical follow-up.
        const kind = payload?.type !== undefined ? `源数据为 ${String(payload.type)} 图表`
          : Array.isArray(payload?.columns) ? `源数据为 ${payload.columns.length} 列表格` : ''
        report.degraded.push(`第 ${index + 1} 页 ${key}（${placeholder}）-> 占位文本块${kind === '' ? '' : `，${kind}`}`)
      }
      const anchor = text?.attributes['text-anchor']
      // A carrier without a fill (data slots) takes the template ink instead of
      // the page ground, which would be invisible on a tinted panel.
      const alignH = pageSpec.alignment?.[key]
        ?? (anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : undefined)
        ?? (degraded ? 'center' : undefined)
      // The asset places a short band's baseline vertically centred in its slot
      // and a tall text frame's line near the top; the carrier baseline ratio
      // is the only signal for which, so reproduce it as the block anchor.
      const carrierY = number(text?.attributes.y)
      const alignV = degraded || (carrierY !== undefined && (carrierY - pxBounds[1]) / pxBounds[3] >= 0.45)
        ? 'middle'
        : undefined
      const bold = text?.attributes['font-weight'] === '700'
      const color = colorOverride(hex(text?.attributes.fill) ?? spec.palette.text)
      const isTitle = placeholder === 'title'
      elements.push({
        elementId: `t${textIndex}`,
        elementType: 'text',
        bounds: ptBounds,
        text: example ?? DEGRADED[placeholder.toUpperCase()].text,
        font: primaryFont,
        fontSize,
        color,
        bold,
        alignH,
        alignV,
      })
      zones.push({
        kind: isTitle ? 'title' : 'text',
        x: pxBounds[0],
        y: pxBounds[1],
        width: pxBounds[2],
        height: pxBounds[3],
        textRole: isTitle ? 'title' : 'body',
        fontSize,
        textCapacity: textCapacity(ptBounds[2], ptBounds[3], fontSize),
      })
      report.slots += 1
    }
    const background = colorOverride(extracted.background)
    const pageRecord = {
      pageType: pageSpec.pageType,
      background,
      notes: spec.notes,
      elements,
    }
    const pageName = String(index + 1).padStart(2, '0')
    const pageText = renderPage(pageRecord)
    writeFileSync(join(pagesDir, `${pageName}.page`), pageText, 'utf8')
    scenes.push(pageScene(pageName, pageText))
    deckPages.push({ pageSpec, zones })
  }

  const designPath = join(outDir, 'design.md')
  const designSummary = existsSync(designPath) ? readFileSync(designPath, 'utf8').replace(/\r\n/g, '\n') : spec.description
  const palette = { ...spec.palette }
  palette.muted = palette.secondary
  const meta = {
    id: spec.id,
    category: spec.category,
    name: spec.name,
    nameEn: spec.nameEn,
    description: spec.description,
    fonts: spec.fonts,
    palette,
    width: 1280,
    height: 720,
    designSummary,
    visualGrammar: spec.visualGrammar,
    recommendedDensity: spec.recommendedDensity,
    layoutFamilies: [...new Set(deckPages.map(({ pageSpec }) => pageSpec.family))],
    pages: deckPages.map(({ pageSpec, zones }, index) => ({
      slideNumber: index + 1,
      sourceTitle: pageSpec.sourceTitle,
      family: pageSpec.family,
      density: pageSpec.density,
      structureSummary: pageSpec.structureSummary,
      zones,
    })),
  }
  writeFileSync(join(outDir, 'metadata.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  writeFileSync(join(outDir, 'source-zh', 'deck.pptd'), renderDeck(meta), 'utf8')
  if (!skipRender) renderPreviews(scenes, join(outDir, 'pages'))
  return { outDir, report, meta }
}

// --- entry ------------------------------------------------------------------

if (layoutsRoot === undefined) {
  console.error('缺少 --layouts：请传入 16:9 版式资产根目录（其下为各族目录，族内 templates/*.svg）。')
  process.exit(1)
}
const config = JSON.parse(readFileSync(activeConfigPath, 'utf8'))
const selected = only === undefined ? config.imports : config.imports.filter((item) => item.id === only)
if (selected.length === 0) {
  console.error(`no import matches --only ${only}`)
  process.exit(1)
}
for (const spec of selected) {
  const result = importFamily(spec, layoutsRoot)
  console.log(`${result.meta.id}  ${result.meta.name} / ${result.meta.nameEn}  ${result.meta.pages.length} pages`
    + `  slots=${result.report.slots} 装饰=${result.report.decorations}${skipRender ? ' (no render)' : ''}`)
  for (const item of result.report.degraded) console.log(`  ~ 降级 ${item}`)
}
