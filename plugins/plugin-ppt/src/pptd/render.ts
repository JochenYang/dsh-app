/**
 * PPTD v2 → editable PPTX rendering over pptxgenjs. Every element becomes a
 * native PowerPoint object placed by explicit point bounds — text lands in
 * real text boxes that wrap natively, tables carry per-row heights, so no
 * element ever borrows another's position. Rendering requires a passing
 * check: overflow, occlusion and malformed structure are refused upstream,
 * never patched at export time.
 *
 * @module @dsh-app/plugin-ppt/pptd/render
 */

import PptxGenJS from 'pptxgenjs'
import { accentSeriesColors, colorOptions, PPTD_CHART_SERIES_PALETTE, readableForeground, resolvePptdChartSeriesColors, resolvePptdColor } from './colors.ts'
import { checkPptdProject, isFlatChart, plainText, resolveThemeReference, tableCellStyle, tableCellTypography, tableCellValue, tableColumnPlans, tableColumnRatios, textStyle } from './check.ts'
import { safeProjectPath } from './parse.ts'
import { POINTS_PER_INCH } from './types.ts'
import type { PptdProject } from './types.ts'
import { asBoolean, asNumber, asRecord, asString, asTuple } from './types.ts'

type Element = Record<string, unknown>
type Slide = ReturnType<InstanceType<typeof PptxGenJS>['addSlide']>

/** Points → inches (pptxgenjs geometry unit). */
function inches(value: number): number {
  return value / POINTS_PER_INCH
}

function frame(element: Element): { x: number, y: number, w: number, h: number } {
  const [x = 0, y = 0, width = 0, height = 0] = asTuple(element.bounds, 4) ?? [0, 0, 0, 0]
  return { x: inches(x), y: inches(y), w: inches(width), h: inches(height) }
}

/** Face resolution: string passes through; `{latin, ea, ...}` prefers `ea`. */
function fontFace(value: unknown, fallback = 'Arial'): string {
  if (typeof value === 'string') return value
  const font = asRecord(value)
  return asString(font?.ea) ?? asString(font?.latin) ?? fallback
}

function inlineStyle(project: PptdProject, raw: string | undefined): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  for (const declaration of raw?.split(';') ?? []) {
    const [name, ...rest] = declaration.split(':')
    const value = rest.join(':').trim()
    if (name?.trim() === 'color') options.color = colorOptions(resolvePptdColor(project, value) ?? '#000000').color
    if (name?.trim() === 'font-size' && /^\d+(?:\.\d+)?px$/u.test(value)) options.fontSize = Number.parseFloat(value)
    if (name?.trim() === 'font-family' && value !== '') {
      const face = value.replace(/^['"]|['"]$/gu, '').split(',')[0]?.trim()
      if (face !== undefined && face !== '') options.fontFace = face
    }
    if (name?.trim() === 'background-color') options.highlight = colorOptions(resolvePptdColor(project, value) ?? '#000000').color
    if (name?.trim() === 'font-weight' && (value === 'bold' || Number(value) >= 600)) options.bold = true
    if (name?.trim() === 'font-style' && value === 'italic') options.italic = true
  }
  return options
}

/** Reduce the markup subset content.text may carry into pptxgenjs runs. */
function richRuns(project: PptdProject, value: string): { text: string, options: Record<string, unknown> }[] {
  const runs: { text: string, options: Record<string, unknown> }[] = []
  const stack: { tag: string, options: Record<string, unknown> }[] = [{ tag: 'root', options: {} }]
  const currentOptions = (): Record<string, unknown> => stack.at(-1)?.options ?? {}
  for (const token of value.split(/(<[^>]+>)/gu)) {
    if (token === '') continue
    if (!token.startsWith('<')) {
      const decoded = plainText(token)
      if (decoded !== '') runs.push({ text: decoded, options: { ...currentOptions() } })
      continue
    }
    const closing = /^<\/([a-z0-9]+)/iu.exec(token)
    if (closing !== null) {
      const tag = closing[1]?.toLowerCase()
      if (tag === undefined) continue
      if (tag === 'p' || tag === 'li') runs.push({ text: '\n', options: { ...currentOptions() } })
      while (stack.length > 1) {
        if (stack.pop()?.tag === tag) break
      }
      continue
    }
    const opening = /^<([a-z0-9]+)/iu.exec(token)
    if (opening === null) continue
    const tag = opening[1]?.toLowerCase()
    if (tag === undefined) continue
    if (tag === 'br') {
      runs.push({ text: '\n', options: { ...currentOptions() } })
      continue
    }
    if (tag === 'li') runs.push({ text: '• ', options: { ...currentOptions() } })
    const style = /\sstyle=(?:"([^"]*)"|'([^']*)')/iu.exec(token)
    const options: Record<string, unknown> = {
      ...currentOptions(),
      ...inlineStyle(project, style?.[1] ?? style?.[2]),
    }
    if (tag === 'strong') options.bold = true
    if (tag === 'em') options.italic = true
    if (tag === 'u') options.underline = { style: 'sng' }
    if (tag === 's') options.strike = 'sngStrike'
    if (tag === 'sup') options.superscript = true
    if (tag === 'sub') options.subscript = true
    if (tag === 'a') {
      const href = /\shref=(?:"([^"]*)"|'([^']*)')/iu.exec(token)?.slice(1).find((item) => item !== undefined)
      if (href !== undefined && /^(?:https?:|mailto:)/iu.test(href)) options.hyperlink = { url: href }
    }
    stack.push({ tag, options })
  }
  while (runs.at(-1)?.text === '\n') runs.pop()
  return runs
}

function flipOptions(element: Element): { flipH?: boolean, flipV?: boolean } {
  const flip = Array.isArray(element.flip) ? element.flip : []
  return {
    ...(typeof flip[0] === 'boolean' ? { flipH: flip[0] } : {}),
    ...(typeof flip[1] === 'boolean' ? { flipV: flip[1] } : {}),
  }
}

function shadowOptions(project: PptdProject, value: unknown): Record<string, unknown> | undefined {
  const shadow = asRecord(value)
  if (shadow === undefined || asNumber(shadow.blur) === undefined || typeof shadow.color !== 'string') return undefined
  const resolved = resolvePptdColor(project, shadow.color) ?? '#000000'
  const alpha = resolved.length === 9 ? Number.parseInt(resolved.slice(7, 9), 16) / 255 : 1
  const [offsetX = 0, offsetY = 0] = asTuple(shadow.offset, 2) ?? [0, 0]
  const angle = (Math.atan2(-offsetY, offsetX) * 180 / Math.PI + 360) % 360
  return {
    type: 'outer',
    color: resolved.slice(1, 7).toUpperCase(),
    opacity: alpha,
    blur: asNumber(shadow.blur) ?? 0,
    offset: Math.hypot(offsetX, offsetY),
    angle,
  }
}

function dash(value: unknown): 'solid' | 'dash' | 'dot' {
  return value === 'dash' || value === 'dot' ? value : 'solid'
}

function borderOptions(project: PptdProject, value: unknown): { color: string, width: number, dash?: 'dash' | 'dot' } | undefined {
  const config = asRecord(value)
  if (config === undefined) return undefined
  const style = dash(config.style)
  const color = colorOptions(resolvePptdColor(project, config.color) ?? '#000000').color
  return {
    color,
    width: asNumber(config.width) ?? 1,
    ...(style === 'solid' ? {} : { dash: style }),
  }
}

function horizontalAlign(value: unknown, fallback: 'left' | 'center' | 'right' | 'justify'): string {
  return value === 'center' || value === 'right' || value === 'justify' ? value : fallback
}

function verticalAlign(value: unknown, fallback: 'top' | 'middle' | 'bottom'): string {
  return value === 'middle' || value === 'bottom' ? value : fallback
}

function renderText(project: PptdProject, slide: Slide, element: Element): void {
  const content = asRecord(element.content) ?? {}
  const style = textStyle(project, content)
  const align = Array.isArray(style.align) ? style.align : []
  const raw = asString(content.text) ?? ''
  const runs = /<[^>]+>/u.test(raw) ? richRuns(project, raw) : raw
  const textColor = colorOptions(resolvePptdColor(project, style.color) ?? themeColor(project, 'text') ?? '#000000').color
  const objectName = asString(element.elementId)
  const charSpacing = asNumber(style.letterSpacing)
  const textShadow = shadowOptions(project, style.shadow)
  slide.addText(runs as never, {
    ...frame(element),
    ...(objectName === undefined ? {} : { objectName }),
    fontFace: fontFace(style.fontFamily, 'MiSans'),
    fontSize: asNumber(style.fontSize) ?? 18,
    color: textColor,
    bold: asBoolean(style.bold) ?? false,
    italic: asBoolean(style.italic) ?? false,
    align: horizontalAlign(align[0], 'left'),
    valign: verticalAlign(align[1], 'top'),
    margin: 0,
    breakLine: false,
    wrap: asBoolean(style.wrap) ?? true,
    textDirection: style.textDirection === 'vertical' ? 'vert' : 'horz',
    rotate: asNumber(element.rotation) ?? 0,
    ...flipOptions(element),
    transparency: Math.round((1 - (asNumber(element.opacity) ?? 1)) * 100),
    ...(textShadow === undefined ? {} : { shadow: textShadow as never }),
    ...(charSpacing === undefined ? {} : { charSpacing }),
  } as never)
}

/** Solid fill resolution; a bare color string (e.g. `$accent`) is a solid paint, a gradient degrades to its first stop (check warns). */
function solidFill(project: PptdProject, value: unknown, opacity = 1): { color: string, transparency?: number } | undefined {
  if (typeof value === 'string') {
    const resolved = resolvePptdColor(project, value)
    return resolved === undefined ? undefined : colorOptions(resolved, opacity)
  }
  const fill = asRecord(value)
  if (fill === undefined) return undefined
  if (fill.type === 'solid') return colorOptions(resolvePptdColor(project, fill.color) ?? '#000000', opacity)
  if (fill.type === 'gradient' && Array.isArray(fill.stops)) {
    const first = asRecord(fill.stops[0])
    return first === undefined ? undefined : colorOptions(resolvePptdColor(project, first.color) ?? '#000000', opacity)
  }
  return undefined
}

/** The theme's own color for `key` (e.g. background/text), resolved through theme.colors. */
function themeColor(project: PptdProject, key: string): string | undefined {
  const colors = asRecord(project.theme.colors)
  return colors === undefined ? undefined : resolvePptdColor(project, colors[key])
}

function shapeType(pptx: PptxGenJS, value: unknown): string {
  const name = typeof value === 'string' ? value : 'rect'
  const shape = (pptx as unknown as { ShapeType?: Record<string, string> }).ShapeType?.[name]
  if (shape === undefined) throw new Error(`不支持的内置形状：${name}`)
  return shape
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** SVG paint for the custom-shape vector fallback (rasterized via data URL). */
function svgPaint(project: PptdProject, fillValue: unknown, opacity: number): { paint: string, definition: string } {
  const fill = asRecord(fillValue)
  if (fill?.type === 'gradient' && Array.isArray(fill.stops) && fill.stops.length >= 2) {
    const id = 'pptd-gradient'
    const stops = fill.stops.map((rawStop) => {
      const stop = asRecord(rawStop) ?? {}
      const color = colorOptions(resolvePptdColor(project, stop.color) ?? '#000000', opacity)
      return `<stop offset="${Math.round(Math.max(0, Math.min(1, asNumber(stop.position) ?? 0)) * 100)}%" stop-color="#${color.color}"${color.transparency === undefined ? '' : ` stop-opacity="${1 - color.transparency / 100}"`}/>`
    }).join('')
    if (fill.gradientType === 'radial') return { paint: `url(#${id})`, definition: `<radialGradient id="${id}">${stops}</radialGradient>` }
    const angle = asNumber(fill.angle) ?? 0
    return { paint: `url(#${id})`, definition: `<linearGradient id="${id}" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="rotate(${angle} 0.5 0.5)">${stops}</linearGradient>` }
  }
  const solid = colorOptions(resolvePptdColor(project, fill?.type === 'solid' ? fill.color : '#000000') ?? '#000000', opacity)
  return { paint: `#${solid.color}`, definition: '' }
}

function renderCustomShape(project: PptdProject, slide: Slide, element: Element): void {
  const viewBox = asTuple(element.viewBox, 2) ?? [1, 1]
  const pathData = asString(element.path) ?? ''
  const opacity = asNumber(element.opacity) ?? 1
  const fill = svgPaint(project, element.fill, opacity)
  const line = borderOptions(project, element.border)
  const shadow = shadowOptions(project, element.shadow)
  const shadowAngle = (shadow?.angle as number | undefined) ?? 0
  const shadowOffset = (shadow?.offset as number | undefined) ?? 0
  const shadowBlur = (shadow?.blur as number | undefined) ?? 0
  const objectName = asString(element.elementId)
  const [width = 1, height = 1] = viewBox
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><defs>${[fill.definition, shadow === undefined ? '' : [
    '<filter id="pptd-shadow" x="-50%" y="-50%" width="200%" height="200%">',
    `<feDropShadow dx="${Math.cos(shadowAngle * Math.PI / 180) * shadowOffset}" dy="${-Math.sin(shadowAngle * Math.PI / 180) * shadowOffset}" stdDeviation="${shadowBlur / 2}" flood-color="#${(shadow?.color as string) ?? '000000'}" flood-opacity="${(shadow?.opacity as number) ?? 1}"/>`,
    '</filter>',
  ].join('')].join('')}</defs><path d="${xmlEscape(pathData)}" fill="${fill.paint}" fill-rule="evenodd"${line === undefined ? ' stroke="none"' : ` stroke="#${line.color}" stroke-width="${line.width}"${line.dash === undefined ? '' : ` stroke-dasharray="${line.dash === 'dot' ? '1 2' : '4 3'}"`}`}${shadow === undefined ? '' : ' filter="url(#pptd-shadow)"'}/></svg>`
  slide.addImage({
    ...frame(element),
    data: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    ...(objectName === undefined ? {} : { objectName }),
    rotate: asNumber(element.rotation) ?? 0,
    ...flipOptions(element),
  } as never)
}

function renderShape(project: PptdProject, pptx: PptxGenJS, slide: Slide, element: Element): void {
  if (element.shapeName === 'custom') {
    renderCustomShape(project, slide, element)
    return
  }
  const opacity = asNumber(element.opacity) ?? 1
  const fill = solidFill(project, element.fill, opacity)
  const line = borderOptions(project, element.border)
  const objectName = asString(element.elementId)
  const shapeShadow = shadowOptions(project, element.shadow)
  slide.addShape(shapeType(pptx, element.shapeName) as never, {
    ...frame(element),
    ...(objectName === undefined ? {} : { objectName }),
    rotate: asNumber(element.rotation) ?? 0,
    ...flipOptions(element),
    ...(fill === undefined ? { fill: { color: 'FFFFFF', transparency: 100 } } : { fill }),
    line: line === undefined ? { color: 'FFFFFF', transparency: 100 } : line,
    ...(shapeShadow === undefined ? {} : { shadow: shapeShadow as never }),
  } as never)
}

function renderCurvedLine(project: PptdProject, slide: Slide, element: Element, points: number[][]): void {
  const [width = 1, height = 1] = asTuple(element.viewBox, 2) ?? [1, 1]
  const [first = [0, 0], ...rest] = points
  const [startX = 0, startY = 0] = first
  const pathData = rest.length === 3
    ? `M ${startX} ${startY} C ${rest.map((point) => point.join(' ')).join(' ')}`
    : `M ${startX} ${startY} ${rest.map((point) => `L ${point[0] ?? 0} ${point[1] ?? 0}`).join(' ')}`
  const line = borderOptions(project, element.border) ?? { color: '000000', width: 1 }
  const arrow = Array.isArray(element.arrow) ? element.arrow : []
  const marker = (id: string, kind: unknown): string => kind === null || kind === undefined ? '' : [
    `<marker id="${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">`,
    kind === 'oval' ? '<circle cx="4" cy="4" r="3" fill="context-stroke"/>' : kind === 'diamond' ? '<path d="M0,4 L4,0 L8,4 L4,8 Z" fill="context-stroke"/>' : '<path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"/>',
    '</marker>',
  ].join('')
  const dashAttr = line.dash === undefined ? '' : ` stroke-dasharray="${line.dash === 'dot' ? '1 2' : '4 3'}"`
  const markerStart = arrow[0] === undefined || arrow[0] === null ? '' : ' marker-start="url(#start)"'
  const markerEnd = arrow[1] === undefined || arrow[1] === null ? '' : ' marker-end="url(#end)"'
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
    `<defs>${marker('start', arrow[0])}${marker('end', arrow[1])}</defs>`,
    `<path d="${pathData}" fill="none" stroke="#${line.color}" stroke-width="${line.width}"`,
    `${dashAttr}${markerStart}${markerEnd}/></svg>`,
  ].join('')
  const objectName = asString(element.elementId)
  slide.addImage({
    ...frame(element),
    data: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    ...(objectName === undefined ? {} : { objectName }),
    rotate: asNumber(element.rotation) ?? 0,
    ...flipOptions(element),
  } as never)
}

function renderLine(project: PptdProject, pptx: PptxGenJS, slide: Slide, element: Element): void {
  const points = (asString(element.points) ?? '').trim().split(/\s+/u).map((value) => value.split(',').map(Number))
  if (points.length > 2 || element.curve === 'smooth') {
    renderCurvedLine(project, slide, element, points)
    return
  }
  const viewBox = asTuple(element.viewBox, 2) ?? [1, 1]
  const bounds = frame(element)
  const first = points[0] ?? [0, 0]
  const last = points.at(-1) ?? [viewBox[0] ?? 1, viewBox[1] ?? 1]
  const x1 = bounds.x + (first[0] ?? 0) / (viewBox[0] ?? 1) * bounds.w
  const y1 = bounds.y + (first[1] ?? 0) / (viewBox[1] ?? 1) * bounds.h
  const x2 = bounds.x + (last[0] ?? 0) / (viewBox[0] ?? 1) * bounds.w
  const y2 = bounds.y + (last[1] ?? 0) / (viewBox[1] ?? 1) * bounds.h
  const line = borderOptions(project, element.border) ?? { color: '000000', width: 1 }
  const arrow = Array.isArray(element.arrow) ? element.arrow : []
  const objectName = asString(element.elementId)
  const lineShadow = shadowOptions(project, element.shadow)
  slide.addShape('line' as never, {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
    ...(objectName === undefined ? {} : { objectName }),
    flipH: x2 < x1,
    flipV: y2 < y1,
    rotate: asNumber(element.rotation) ?? 0,
    line: {
      ...line,
      ...(arrow[0] === undefined || arrow[0] === null ? {} : { beginArrowType: arrow[0] }),
      ...(arrow[1] === undefined || arrow[1] === null ? {} : { endArrowType: arrow[1] }),
    },
    ...(lineShadow === undefined ? {} : { shadow: lineShadow as never }),
  } as never)
}

function renderImage(project: PptdProject, slide: Slide, element: Element): void {
  const assetPath = typeof element.src === 'string' ? safeProjectPath(element.src.replace(/^\.\//u, '')) : undefined
  const asset = assetPath === undefined ? undefined : project.source.assets.get(assetPath)
  if (asset === undefined) throw new Error(`PPTD 图片 ${String(element.src)} 不可用`)
  const objectName = asString(element.elementId)
  const mode = asString(asRecord(element.fit)?.mode) ?? 'cover'
  const bounds = frame(element)
  const cropShape = asRecord(element.cropShape)
  const imageShadow = shadowOptions(project, element.shadow)
  slide.addImage({
    ...bounds,
    ...(objectName === undefined ? {} : { objectName }),
    data: `data:${asset.mediaType};base64,${Buffer.from(asset.bytes).toString('base64')}`,
    rotate: asNumber(element.rotation) ?? 0,
    ...flipOptions(element),
    transparency: Math.round((1 - (asNumber(element.opacity) ?? 1)) * 100),
    ...(mode === 'fill' ? {} : { sizing: { type: mode, w: bounds.w, h: bounds.h } as never }),
    ...(cropShape?.shapeName === 'ellipse' ? { rounding: true } : {}),
    ...(imageShadow === undefined ? {} : { shadow: imageShadow as never }),
  } as never)
  const imageBorder = borderOptions(project, element.border)
  if (imageBorder !== undefined) {
    slide.addShape((cropShape?.shapeName === 'ellipse' ? 'ellipse' : 'rect') as never, {
      ...bounds,
      objectName: `${objectName ?? 'image'}-border`,
      fill: { color: 'FFFFFF', transparency: 100 },
      line: imageBorder,
      rotate: asNumber(element.rotation) ?? 0,
      ...flipOptions(element),
    } as never)
  }
}

type CellStyle = Record<string, unknown>

function tableBorder(project: PptdProject, value: unknown): unknown {
  // `type: 'none'` is what pptxgenjs turns into a noFill edge; a white 0pt
  // line would still emit a solidFill and read as a rule at some zoom levels.
  const none = [{ type: 'none' }, { type: 'none' }, { type: 'none' }, { type: 'none' }]
  const one = (item: unknown): { color: string, pt: number, dash?: string } | { type: 'none' } => {
    const parsed = borderOptions(project, item)
    return parsed === undefined ? { type: 'none' } : { color: parsed.color, pt: parsed.width, ...(parsed.dash === undefined ? {} : { dash: parsed.dash }) }
  }
  if (value === null) return none
  if (Array.isArray(value)) {
    if (value.length === 2) return [one(value[0]), one(value[1]), one(value[0]), one(value[1])]
    if (value.length === 4) return [one(value[0]), one(value[1]), one(value[2]), one(value[3])]
  }
  return asRecord(value) === undefined ? undefined : one(value)
}

function renderTable(project: PptdProject, slide: Slide, element: Element): void {
  const rows = element.rows as unknown[] | undefined
  if (!Array.isArray(rows) || rows.length === 0) return
  const rowCount = rows.length
  // The declared grid wins for merged tables (rows carry fewer cells than
  // columns); a table whose ratios are missing or shorter than its widest row
  // falls back to that row width so the estimate still has a column count.
  const declaredColumns = Array.isArray(element.columnWidths) ? element.columnWidths.length : 0
  const rowColumns = rows.reduce<number>((widest, row) => Math.max(widest, Array.isArray(row) ? row.length : 0), 0)
  const columnCount = declaredColumns > 0 && declaredColumns >= rowColumns ? declaredColumns : rowColumns
  // Column plans are keyed by the cell's raw index, exactly the order this
  // walk visits cells, so formatting stays identical to the capacity check.
  const plans = tableColumnPlans(element, columnCount)
  const tableRows = rows.map((row, rowIndex) => (row as unknown[]).map((rawCell, columnIndex) => {
    const cell = asRecord(rawCell) ?? { text: typeof rawCell === 'string' || typeof rawCell === 'number' ? String(rawCell) : '' }
    const style = {
      ...asRecord(resolveThemeReference(cell.textStyle, asRecord(project.theme.textStyles) ?? {})) ?? {},
      ...tableCellStyle(project, element, cell, rowIndex, columnIndex, rowCount, columnCount),
    } as CellStyle
    const value = tableCellValue(rawCell)
    const plan = plans[columnIndex]
    const text = value === undefined ? '' : plan === undefined ? String(value) : plan.format(value)
    const align = Array.isArray(style.align) ? style.align : []
    const explicitAlign = align[0]
    // An explicit alignment wins; otherwise the column's own numeric/text
    // profile decides, and the header shares it with the data rows.
    const horizontal = explicitAlign === 'left' || explicitAlign === 'center' || explicitAlign === 'right' || explicitAlign === 'justify'
      ? explicitAlign
      : plan?.align ?? 'left'
    const vertical = verticalAlign(align[1], 'middle')
    const fill = solidFill(project, style.fill)
    const cellBorder = tableBorder(project, style.border)
    const typography = tableCellTypography(style, rowIndex)
    const rowSpan = asNumber(cell.rowSpan)
    const colSpan = asNumber(cell.colSpan)
    const options = {
      fontFace: fontFace(style.fontFamily, 'MiSans'),
      fontSize: typography.fontSize,
      color: colorOptions(resolvePptdColor(project, style.color) ?? themeColor(project, 'text') ?? '#000000').color,
      bold: typography.bold,
      italic: asBoolean(style.italic) ?? false,
      align: horizontal,
      valign: vertical,
      margin: 0.03,
      ...(rowSpan === undefined ? {} : { rowspan: rowSpan }),
      ...(colSpan === undefined ? {} : { colspan: colSpan }),
      ...(fill === undefined ? {} : { fill }),
      ...(cellBorder === undefined ? {} : { border: cellBorder }),
    }
    return { text, options }
  }))
  const bounds = frame(element)
  const colRatios = Array.isArray(element.columnWidths) ? element.columnWidths.map(asNumber).filter((item) => item !== undefined) : []
  const rowRatios = Array.isArray(element.rowHeights) ? element.rowHeights.map(asNumber).filter((item) => item !== undefined) : []
  // Explicit ratios win; a missing or length-mismatched columnWidths falls
  // back to a content-derived estimate instead of an even split.
  const ratios = colRatios.length === columnCount ? colRatios : tableColumnRatios(element, columnCount)
  const colW = ratios === undefined ? undefined : ratios.map((value) => value * bounds.w)
  const rowH = rowRatios.length === rowCount ? rowRatios.map((value) => value * bounds.h) : undefined
  const objectName = asString(element.elementId)
  slide.addTable(tableRows as never, {
    ...bounds,
    ...(objectName === undefined ? {} : { objectName }),
    autoPage: false,
    ...(colW === undefined ? {} : { colW }),
    ...(rowH === undefined ? {} : { rowH }),
    // Table-level border is the no-line fallback: themed cell borders draw the
    // horizontal rules, and no cell ever gains a vertical rule by default.
    border: { type: 'none' },
    margin: 0,
  } as never)
}

function legendPosition(value: unknown): 'b' | 'l' | 'r' | 't' | 'tr' {
  return ({ bottom: 'b', left: 'l', right: 'r', top: 't', topRight: 'tr' } as Record<string, 'b' | 'l' | 'r' | 't' | 'tr'>)[asString(value) ?? ''] ?? 'r'
}

function valueAxisOptions(project: PptdProject, axis: Element): Record<string, unknown> {
  const label = asRecord(axis.label) ?? {}
  const grid = asRecord(axis.gridLine)
  const minimum = asNumber(axis.min)
  const maximum = asNumber(axis.max)
  const fontSize = asNumber(label.fontSize)
  const title = asString(axis.title)
  return {
    ...(minimum === undefined ? {} : { valAxisMinVal: minimum }),
    ...(maximum === undefined ? {} : { valAxisMaxVal: maximum }),
    ...(fontSize === undefined ? {} : { valAxisLabelFontSize: fontSize }),
    ...(title === undefined ? {} : { showValAxisTitle: true, valAxisTitle: title }),
    ...(axis.gridLine === false
      ? { valGridLine: { style: 'none' } }
      : grid === undefined ? {} : { valGridLine: { color: colorOptions(resolvePptdColor(project, grid.color) ?? '#000000').color, style: dash(grid.style) } }),
  }
}

function chartAxisOptions(project: PptdProject, element: Element, horizontal = false): Record<string, unknown> {
  const xAxis = Array.isArray(element.xAxis) ? asRecord(element.xAxis[0]) ?? {} : asRecord(element.xAxis) ?? {}
  const yAxis = (Array.isArray(element.yAxis) ? element.yAxis.map(asRecord).filter((item) => item !== undefined) : [asRecord(element.yAxis) ?? {}])[0] ?? {}
  const valueAxis = horizontal ? xAxis : yAxis
  const categoryAxis = horizontal ? yAxis : xAxis
  const categoryLabel = asRecord(categoryAxis.label) ?? {}
  return {
    ...valueAxisOptions(project, valueAxis),
    ...(asNumber(categoryLabel.fontSize) === undefined ? {} : { catAxisLabelFontSize: asNumber(categoryLabel.fontSize) }),
    ...(asNumber(categoryLabel.rotate) === undefined ? {} : { catAxisLabelRotate: asNumber(categoryLabel.rotate) }),
    ...(categoryAxis.gridLine === false ? { catGridLine: { style: 'none' } } : {}),
  }
}

/**
 * Flat-form chart (chart + labels/series.values): one native, editable
 * PowerPoint chart via addChart. `column` and `bar` are the same bar variant
 * with opposite direction; series colors derive from the theme accent (or the
 * element's own color) through the lightness ladder; the chart/plot areas stay
 * transparent so the page background reads through.
 */
function renderFlatChart(project: PptdProject, slide: Slide, element: Element, foregroundColor: string): void {
  const kind = asString(element.chart) ?? 'column'
  const labels = (Array.isArray(element.labels) ? element.labels : []).map((value) => asString(value) ?? '')
  const series = (Array.isArray(element.series) ? element.series : []).map(asRecord).filter((item) => item !== undefined)
  const dataSeries = series.map((item, index) => ({
    name: asString(item.name)?.trim() ?? `系列 ${index + 1}`,
    labels,
    values: (Array.isArray(item.values) ? item.values : []).map((value) => asNumber(value) ?? 0),
  }))
  const accent = asRecord(project.theme.colors)?.accent
  const base = resolvePptdColor(project, element.color) ?? resolvePptdColor(project, accent) ?? PPTD_CHART_SERIES_PALETTE[0] ?? '#2563EB'
  const chartColors = accentSeriesColors(base, series.length).map((value) => colorOptions(value).color)
  const textStyles = asRecord(project.theme.textStyles) ?? {}
  const font = fontFace(asRecord(textStyles.body)?.fontFamily, 'MiSans')
  const title = asString(element.title)?.trim()
  const chartType = kind === 'pie' ? 'pie' : kind === 'line' ? 'line' : kind === 'area' ? 'area' : 'bar'
  const groupOptions: Record<string, unknown> = {
    chartColors,
    ...(kind === 'bar' ? { barDir: 'bar' } : kind === 'column' ? { barDir: 'col' } : {}),
    ...(kind === 'line' ? { lineSize: 2, lineDataSymbol: 'circle' } : {}),
    ...(kind === 'area' ? { lineSize: 2 } : {}),
  }
  const common: Record<string, unknown> = {
    ...frame(element),
    ...(asString(element.elementId) === undefined ? {} : { objectName: asString(element.elementId) }),
    showLegend: kind === 'pie' || series.length > 1,
    legendPos: 'b',
    legendFontFace: font,
    legendColor: foregroundColor,
    catAxisLabelFontFace: font,
    catAxisLabelColor: foregroundColor,
    catAxisLineColor: foregroundColor,
    valAxisLabelFontFace: font,
    valAxisLabelColor: foregroundColor,
    valAxisLineColor: foregroundColor,
    dataLabelColor: foregroundColor,
    showTitle: title !== undefined && title !== '',
    ...(title === undefined || title === '' ? {} : { title, titleFontFace: font, titleColor: foregroundColor }),
    chartArea: { border: { color: 'FFFFFF', pt: 0 }, fill: { color: 'FFFFFF', transparency: 100 } },
    plotArea: { border: { color: 'FFFFFF', pt: 0 }, fill: { color: 'FFFFFF', transparency: 100 } },
  }
  slide.addChart([{ type: chartType, data: dataSeries, options: groupOptions }] as never, common as never)
}

function renderChart(project: PptdProject, pptx: PptxGenJS, slide: Slide, element: Element, foregroundColor: string): void {
  if (isFlatChart(element)) return renderFlatChart(project, slide, element, foregroundColor)
  const data = asRecord(element.data) ?? {}
  const columns = (Array.isArray(data.cols) ? data.cols : []).map((value) => String(value))
  const rows = Array.isArray(data.rows) ? data.rows as unknown[] : []
  const columnIsNumeric = (column: string | undefined): boolean => {
    if (column === undefined) return false
    const columnIndex = columns.indexOf(column)
    if (columnIndex < 0) return false
    const values = rows.map((row) => (row as unknown[])[columnIndex]).filter((value) => value !== undefined && value !== null && value !== '')
    return values.length > 0 && values.every((value) => {
      if (typeof value === 'number') return Number.isFinite(value)
      return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
    })
  }
  const seriesDefaults = asRecord(element.seriesDefaults) ?? {}
  const xAxis = Array.isArray(element.xAxis) ? asRecord(element.xAxis[0]) ?? {} : asRecord(element.xAxis) ?? {}
  const yAxes = Array.isArray(element.yAxis) ? element.yAxis.map(asRecord).filter((item) => item !== undefined) : [asRecord(element.yAxis) ?? {}]
  const mergeSeries = (raw: Element): Element => {
    const defaults = asRecord(seriesDefaults[asString(raw.type) ?? '']) ?? {}
    const merged: Element = { ...defaults, ...raw }
    for (const key of ['marker', 'dataLabels', 'border', 'upBars', 'downBars', 'totalBars', 'increaseBars', 'decreaseBars']) {
      const base = asRecord(defaults[key])
      const specific = asRecord(raw[key])
      if (base !== undefined || specific !== undefined) merged[key] = { ...base ?? {}, ...specific ?? {} }
    }
    return merged
  }
  const series = (Array.isArray(element.series) ? element.series : []).map(asRecord).filter((item) => item !== undefined).map(mergeSeries)
  const types: unknown[] = []
  const mergeableGroups = new Map<string, { type: unknown, data: unknown[], options: Record<string, unknown> }>()
  for (const [index, item] of series.entries()) {
    const encode = asRecord(item.encode) ?? {}
    const chartTypeName = asString(item.type) ?? 'bar'
    const xColumn = asString(encode.x)
    const yColumn = asString(encode.y)
    const horizontal = chartTypeName === 'bar' && columnIsNumeric(xColumn) && !columnIsNumeric(yColumn)
    const categoryColumn = asString(chartTypeName === 'pie' || chartTypeName === 'radar' ? encode.category : horizontal ? encode.y : encode.x) ?? columns[0] ?? 'category'
    const valueColumn = asString(chartTypeName === 'pie' ? encode.value : horizontal ? encode.x : encode.y) ?? columns[1] ?? 'value'
    const categoryIndex = columns.indexOf(categoryColumn)
    const valueIndex = columns.indexOf(valueColumn)
    const filter = asRecord(item.dataFilter)
    const filterColumn = asString(filter?.col)
    const selectedRows = filterColumn === undefined ? rows : rows.filter((row) => (row as unknown[])[columns.indexOf(filterColumn)] === filter?.value)
    const filteredRows = horizontal ? [...selectedRows].reverse() : selectedRows
    const filteredLabels = filteredRows.map((row) => {
      const value = (row as unknown[])[categoryIndex]
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
    })
    const values = filteredRows.map((row) => Number((row as unknown[])[valueIndex] ?? 0))
    const chartTypeOf = (): string => {
      if (chartTypeName === 'line') return 'line'
      if (chartTypeName === 'area') return 'area'
      if (chartTypeName === 'scatter') return 'scatter'
      if (chartTypeName === 'bubble') return 'bubble'
      if (chartTypeName === 'radar') return 'radar'
      if (chartTypeName === 'pie' && (asNumber(item.innerRadius) ?? 0) > 0) return 'doughnut'
      if (chartTypeName === 'pie') return 'pie'
      return 'bar'
    }
    const kind = chartTypeOf()
    const paint = chartTypeName === 'line' || chartTypeName === 'area' || chartTypeName === 'radar' ? item.lineColor ?? item.areaColor : item.fill
    const chartColors = (resolvePptdChartSeriesColors(project, paint)
      ?? [PPTD_CHART_SERIES_PALETTE[index % PPTD_CHART_SERIES_PALETTE.length] ?? '#2563EB'])
      .map((value) => colorOptions(resolvePptdColor(project, value) ?? value).color)
    const labelsConfig = asRecord(item.dataLabels)
    const showLabels = asBoolean(labelsConfig?.show) === true
    const showPercent = labelsConfig?.content === 'percentage'
    const dataLabelFontSize = asNumber(labelsConfig?.fontSize)
    const dataLabelColor = labelsConfig?.color === undefined ? foregroundColor : colorOptions(resolvePptdColor(project, labelsConfig.color) ?? '#000000').color
    const axisIndex = Math.max(0, Math.trunc(asNumber(item.yAxisIndex) ?? 0))
    const valueAxis = horizontal ? xAxis : yAxes[axisIndex] ?? yAxes[0] ?? {}
    const valueAxisLabel = asRecord(valueAxis.label) ?? {}
    const valueAxisGrid = asRecord(valueAxis.gridLine)
    const valueAxisMin = asNumber(valueAxis.min)
    const valueAxisMax = asNumber(valueAxis.max)
    const valueAxisLabelFontSize = asNumber(valueAxisLabel.fontSize)
    const valueAxisTitle = asString(valueAxis.title)
    const groupOptions: Record<string, unknown> = {
      ...(horizontal ? { barDir: 'bar' } : chartTypeName === 'bar' ? { barDir: 'col' } : {}),
      ...(axisIndex === 1 ? { secondaryValAxis: true } : {}),
      ...(valueAxisMin === undefined ? {} : { valAxisMinVal: valueAxisMin }),
      ...(valueAxisMax === undefined ? {} : { valAxisMaxVal: valueAxisMax }),
      ...(valueAxisLabelFontSize === undefined ? {} : { valAxisLabelFontSize: valueAxisLabelFontSize }),
      ...(valueAxisTitle === undefined ? {} : { showValAxisTitle: true, valAxisTitle: valueAxisTitle }),
      ...(valueAxis.gridLine === false
        ? { valGridLine: { style: 'none' } }
        : valueAxisGrid === undefined ? {} : { valGridLine: { color: colorOptions(resolvePptdColor(project, valueAxisGrid.color) ?? '#000000').color, style: dash(valueAxisGrid.style) } }),
      ...(showLabels && !showPercent ? { showValue: true } : {}),
      ...(showLabels && showPercent ? { showPercent: true } : {}),
      dataLabelColor,
      ...(dataLabelFontSize === undefined ? {} : { dataLabelFontSize, dataLabelPosition: 'outEnd' }),
      ...(chartTypeName === 'line' ? { lineSize: asNumber(item.width) ?? 2, lineDataSymbol: 'circle' } : {}),
      ...(chartTypeName === 'area' ? { lineSize: asNumber(item.width) ?? 2 } : {}),
      ...(chartTypeName === 'radar' ? { radarStyle: item.areaColor === undefined ? 'marker' : 'filled' } : {}),
      ...((chartTypeName === 'line' || chartTypeName === 'area') && item.marker === false ? { lineDataSymbol: 'none' } : {}),
      ...((chartTypeName === 'line' || chartTypeName === 'area') && asRecord(item.marker) !== undefined
        ? {
            lineDataSymbol: asRecord(item.marker)?.shape === 'rect' ? 'square' : asString(asRecord(item.marker)?.shape) ?? 'circle',
            lineDataSymbolSize: asNumber(asRecord(item.marker)?.size) ?? 6,
          }
        : {}),
      ...(item.stack === 'percent' ? { barGrouping: 'percentStacked' } : item.stack === 'value' || item.stack === 'stream' ? { barGrouping: 'stacked' } : chartTypeName === 'bar' ? { barGrouping: 'clustered' } : {}),
      ...(item.nullHandling === 'gap' ? { displayBlanksAs: 'gap' } : { displayBlanksAs: 'span' }),
      ...(kind === 'doughnut' ? { holeSize: Math.round((asNumber(item.innerRadius) ?? 0.5) * 100) } : {}),
    }
    const dataSeries = {
      name: asString(item.name) ?? valueColumn ?? `Series ${index + 1}`,
      labels: filteredLabels,
      values,
      ...(chartTypeName === 'bubble' ? { sizes: filteredRows.map((row) => Number((row as unknown[])[columns.indexOf(asString(encode.size) ?? '')] ?? 0)) } : {}),
    }
    const mergeable = kind !== 'pie' && kind !== 'doughnut'
    const groupKey = chartTypeName === 'bar'
      ? `${kind}:${horizontal ? 'horizontal' : 'vertical'}:${axisIndex}:${String(groupOptions.barGrouping)}`
      : `${kind}:${JSON.stringify(groupOptions)}`
    const existing = mergeable ? mergeableGroups.get(groupKey) : undefined
    if (existing === undefined) {
      const chartGroup = { type: kind, data: [dataSeries], options: { ...groupOptions, chartColors } }
      types.push(chartGroup)
      if (mergeable) mergeableGroups.set(groupKey, chartGroup)
      continue
    }
    existing.data.push(dataSeries)
    existing.options.chartColors = [...(existing.options.chartColors as string[] ?? []), ...chartColors]
    if (groupOptions.showValue === true) existing.options.showValue = true
    if (groupOptions.showPercent === true) existing.options.showPercent = true
    if (existing.options.dataLabelFontSize === undefined && groupOptions.dataLabelFontSize !== undefined) existing.options.dataLabelFontSize = groupOptions.dataLabelFontSize
  }
  const legend = typeof element.legend === 'boolean' ? { show: element.legend } : asRecord(element.legend) ?? {}
  const font = fontFace(element.fontFamily, 'MiSans')
  const objectName = asString(element.elementId)
  const title = typeof element.title === 'string' ? { text: element.title } : asRecord(element.title) ?? {}
  const chartFill = solidFill(project, element.fill)
  const chartBorder = borderOptions(project, element.border)
  const legendFontSize = asNumber(legend.fontSize)
  const titleFontSize = asNumber(title.fontSize)
  const titleText = asString(title.text)
  const barGap = asNumber(element.barGap)
  const valAxes = series.some((item) => Math.trunc(asNumber(item.yAxisIndex) ?? 0) === 1)
    ? [valueAxisOptions(project, yAxes[0] ?? {}), valueAxisOptions(project, yAxes[1] ?? {})]
    : undefined
  const common = {
    ...frame(element),
    ...(objectName === undefined ? {} : { objectName }),
    showLegend: asBoolean(legend.show) ?? series.some((item) => !['waterfall', 'heatmap', 'treemap', 'sunburst', 'sankey'].includes(asString(item.type) ?? '')),
    legendPos: legendPosition(legend.position),
    legendFontFace: fontFace(legend.fontFamily, font),
    legendColor: colorOptions(resolvePptdColor(project, legend.color ?? `#${foregroundColor}`) ?? `#${foregroundColor}`).color,
    ...(legendFontSize === undefined ? {} : { legendFontSize }),
    catAxisLabelFontFace: font,
    catAxisLabelColor: foregroundColor,
    catAxisLineColor: foregroundColor,
    valAxisLabelFontFace: font,
    valAxisLabelColor: foregroundColor,
    valAxisLineColor: foregroundColor,
    showTitle: titleText !== undefined,
    ...(titleText === undefined ? {} : { title: titleText }),
    titleFontFace: fontFace(title.fontFamily, font),
    titleColor: colorOptions(resolvePptdColor(project, title.color ?? `#${foregroundColor}`) ?? `#${foregroundColor}`).color,
    ...(titleFontSize === undefined ? {} : { titleFontSize }),
    showValue: false,
    chartArea: {
      border: chartBorder === undefined ? { color: 'FFFFFF', pt: 0 } : { color: chartBorder.color, pt: chartBorder.width },
      fill: chartFill ?? { color: 'FFFFFF', transparency: 100 },
    },
    plotArea: { border: { color: 'FFFFFF', pt: 0 }, fill: { color: 'FFFFFF', transparency: 100 } },
    ...(barGap === undefined ? {} : { barGapWidthPct: Math.round(barGap * 100) }),
    ...(valAxes === undefined ? {} : { valAxes }),
    ...chartAxisOptions(project, element, series.some((item) => {
      const encode = asRecord(item.encode) ?? {}
      return asString(item.type) === 'bar' && columnIsNumeric(asString(encode.x)) && !columnIsNumeric(asString(encode.y))
    })),
  }
  slide.addChart(types as never, common as never)
}

function renderIcon(project: PptdProject, slide: Slide, element: Element): void {
  const color = colorOptions(resolvePptdColor(project, element.color) ?? '#000000').color
  const objectName = asString(element.elementId)
  slide.addText(asString(element.iconName) ?? '●', {
    ...frame(element),
    ...(objectName === undefined ? {} : { objectName }),
    fontFace: 'Arial',
    fontSize: 18,
    color,
    margin: 0,
    align: 'center',
    valign: 'middle',
    fit: 'shrink',
  } as never)
}

function renderElement(project: PptdProject, pptx: PptxGenJS, slide: Slide, element: Element, foregroundColor: string): void {
  if (element.elementType === 'text') return renderText(project, slide, element)
  if (element.elementType === 'shape') return renderShape(project, pptx, slide, element)
  if (element.elementType === 'line') return renderLine(project, pptx, slide, element)
  if (element.elementType === 'image') return renderImage(project, slide, element)
  if (element.elementType === 'table') return renderTable(project, slide, element)
  if (element.elementType === 'chart') return renderChart(project, pptx, slide, element, foregroundColor)
  if (element.elementType === 'icon') return renderIcon(project, slide, element)
}

export interface RenderedPptd {
  readonly bytes: Uint8Array
  readonly nativeObjectCount: number
  readonly check: ReturnType<typeof checkPptdProject>
}

export interface RenderPptdOptions {
  /**
   * Theme used when the document never wrote one: the session's chosen
   * template, synthesized by `templatePptdTheme`. The chosen template must
   * steer the output even when the manifest omitted `theme`, so the fallback
   * is applied BEFORE the internal re-check (an empty theme can resolve
   * `$refs` through it) and feeds the default slide background / text color.
   */
  readonly fallbackTheme?: Record<string, unknown>
}

/**
 * Fill in a missing document theme; a document that wrote one keeps it. Pure
 * and shared with the tool layer so the outer check and the render see the
 * same effective project.
 */
export function applyFallbackTheme(project: PptdProject, fallbackTheme: Record<string, unknown> | undefined): PptdProject {
  if (fallbackTheme === undefined || Object.keys(project.theme).length > 0) return project
  return { ...project, theme: fallbackTheme }
}

/** Render one checked PPTD AST to editable native PowerPoint objects. */
export async function renderPptdProject(input: PptdProject, options: RenderPptdOptions = {}): Promise<RenderedPptd> {
  const project = applyFallbackTheme(input, options.fallbackTheme)
  const check = checkPptdProject(project)
  if (check.status === 'fail') {
    const details = check.issues.filter((issue) => issue.severity === 'error').slice(0, 3)
      .map((issue) => `${issue.code}${issue.elementId === undefined ? '' : `(${issue.elementId})`}: ${issue.message}`).join('; ')
    throw new Error(`PPTD 渲染要求先通过校验；当前有 ${check.errorCount} 项错误${details === '' ? '' : `：${details}`}`)
  }
  const themeBackground = themeColor(project, 'background')
  const fallbackBackground = themeBackground === undefined ? { color: 'FFFFFF' } : colorOptions(themeBackground)
  const pptx = new PptxGenJS()
  const layoutName = `PPTD_${project.width}x${project.height}`
  pptx.defineLayout({ name: layoutName, width: inches(project.width), height: inches(project.height) })
  pptx.layout = layoutName
  pptx.author = 'DSH APP PPTD'
  pptx.title = project.title
  const textStyles = asRecord(project.theme.textStyles) ?? {}
  const titleStyle = asRecord(textStyles.title) ?? {}
  const bodyStyle = asRecord(textStyles.body) ?? {}
  pptx.theme = {
    headFontFace: fontFace(titleStyle.fontFamily, 'Arial'),
    bodyFontFace: fontFace(bodyStyle.fontFamily, 'Arial'),
  }
  for (const page of project.pages) {
    const slide = pptx.addSlide()
    // Pages without an explicit background take the theme background instead
    // of a hard white, so the chosen template colors the deck even when the
    // page YAML stays silent.
    const background = solidFill(project, page.background) ?? fallbackBackground
    slide.background = background
    const foregroundColor = readableForeground(background.color)
    for (const element of page.elements) renderElement(project, pptx, slide, element, foregroundColor)
    if (page.notes.trim() !== '') slide.addNotes(page.notes)
  }
  const output = await pptx.write({ outputType: 'nodebuffer', compression: true })
  return {
    bytes: new Uint8Array(output as Buffer),
    nativeObjectCount: check.nativeObjectCount,
    check,
  }
}
