/**
 * PPTD v2 checker: structure, renderability, and measurable composition
 * signals, all without external effects. A failed check is a normal authoring
 * result — the point is to hand the model every problem (file, page,
 * elementId, actionable Chinese message) in one pass, which is what makes the
 * fixed rendering trustworthy: overflow, occlusion and drift are refused
 * before a single slide is produced.
 *
 * @module @dsh-app/plugin-ppt/pptd/check
 */

import { createHash } from 'node:crypto'
import { measureTextLayout } from '../text-layout.ts'
import type { TextLayoutResult } from '../text-layout.ts'
import {
  decimalPlacesOf,
  estimateColumnRatios,
  parsePlainNumber,
  planColumnFormat,
} from './number-format.ts'
import type { ColumnFormatPlan, ColumnFormatSample, ColumnValue } from './number-format.ts'
import { safeProjectPath } from './parse.ts'
import { nativeShapeNames } from './native.ts'
import type { PptdIssue, PptdPage, PptdProject, PptdCheckResult } from './types.ts'
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  asTuple,
  ELEMENT_TYPES,
  FLAT_CHART_KINDS,
  MAX_CHART_LABELS,
  MAX_CHART_SERIES,
  MAX_CHART_TITLE_CHARS,
  NATIVE_CHART_TYPES,
  UNSUPPORTED_CHART_TYPES,
} from './types.ts'

type Element = Record<string, unknown>

function themeMap(project: PptdProject, key: string): Record<string, unknown> {
  return asRecord(project.theme[key]) ?? {}
}

function digestOf(project: PptdProject): string {
  const hash = createHash('sha256')
  hash.update(project.source.manifest)
  for (const page of project.pages) hash.update(page.file).update(project.source.pages.get(page.file) ?? '')
  for (const asset of [...project.source.assets.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(asset.path).update(asset.sha256)
  }
  return hash.digest('hex')
}

function themeReferenceIssue(project: PptdProject, value: unknown, mapName: string, file?: string, page?: number, elementId?: string): PptdIssue | undefined {
  if (typeof value !== 'string' || !value.startsWith('$')) return undefined
  const key = value.slice(1)
  if (key !== '' && key in themeMap(project, mapName)) return undefined
  return {
    code: 'invalid-theme',
    severity: 'error',
    ...(file === undefined ? {} : { file }),
    ...(page === undefined ? {} : { page }),
    ...(elementId === undefined ? {} : { elementId }),
    message: `主题引用 ${value} 不存在于 theme.${mapName}。`,
  }
}

function colorThemeIssues(project: PptdProject, value: unknown, file?: string, page?: number, elementId?: string): PptdIssue[] {
  const issues: PptdIssue[] = []
  const visited = new WeakSet<object>()
  const visit = (current: unknown, field = ''): void => {
    if (typeof current === 'string') {
      if (field === 'color' || field === 'backgroundColor' || field === 'lineColor' || field === 'areaColor' || field === 'fill') {
        if (current.startsWith('$')) {
          const issue = themeReferenceIssue(project, current, 'colors', file, page, elementId)
          if (issue !== undefined) issues.push(issue)
        } else if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(current)) {
          // Invalid literals must fail at check time — the renderer would
          // otherwise silently substitute black and hide the drift.
          issues.push({
            code: 'invalid-color',
            severity: 'error',
            ...(file === undefined ? {} : { file }),
            ...(page === undefined ? {} : { page }),
            ...(elementId === undefined ? {} : { elementId }),
            message: `颜色值 ${current} 无效：使用 #RRGGBB（可带两位透明度）或 theme.colors 的 $引用。`,
          })
        }
      }
      return
    }
    if (Array.isArray(current)) {
      if (visited.has(current)) return
      visited.add(current)
      for (const item of current) visit(item, field)
      return
    }
    const object = asRecord(current)
    if (object === undefined || visited.has(object)) return
    visited.add(object)
    for (const [key, child] of Object.entries(object)) visit(child, key === 'fill' ? 'fill' : key)
  }
  visit(value)
  return issues
}

function themeColorChainIssues(project: PptdProject): PptdIssue[] {
  const colors = themeMap(project, 'colors')
  const issues: PptdIssue[] = []
  const reportedCycles = new Set<string>()
  const reportedInvalidTerminals = new Set<string>()
  for (const start of Object.keys(colors)) {
    const path: string[] = []
    let key = start
    for (;;) {
      const cycleIndex = path.indexOf(key)
      if (cycleIndex >= 0) {
        const cycle = path.slice(cycleIndex)
        const signature = [...cycle].sort().join('\0')
        if (!reportedCycles.has(signature)) {
          reportedCycles.add(signature)
          issues.push({
            code: 'invalid-theme',
            severity: 'error',
            file: project.source.entryName,
            message: `theme.colors 存在循环引用：${[...cycle, key].map((item) => `$${item}`).join(' -> ')}。`,
          })
        }
        break
      }
      path.push(key)
      const value = colors[key]
      if (typeof value !== 'string' || !value.startsWith('$')) {
        if (key !== start && (typeof value !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value))) {
          if (!reportedInvalidTerminals.has(key)) {
            reportedInvalidTerminals.add(key)
            issues.push({
              code: 'invalid-theme',
              severity: 'error',
              file: project.source.entryName,
              message: `theme.colors.${start} 最终指向无效颜色 theme.colors.${key}。`,
            })
          }
        }
        break
      }
      const next = value.slice(1)
      if (!(next in colors)) break
      key = next
    }
  }
  return issues
}

export function resolveThemeReference(value: unknown, map: Record<string, unknown>): unknown {
  if (typeof value !== 'string' || !value.startsWith('$')) return value
  return map[value.slice(1)]
}

/** Strip the small markup subset text may carry down to layout-relevant plain text. */
export function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/p\s*>/giu, '\n')
    .replace(/<li(?:\s[^>]*)?>/giu, '• ')
    .replace(/<\/li\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd()
}

/** Effective text style: `$style` theme reference merged under the content. */
export function textStyle(project: PptdProject, content: Record<string, unknown>): Record<string, unknown> {
  return {
    ...asRecord(resolveThemeReference(content.style, themeMap(project, 'textStyles'))) ?? {},
    ...content,
  }
}

/** Layout estimate for one text element, or undefined when it is not measurable. */
export function textLayout(project: PptdProject, element: Element): TextLayoutResult | undefined {
  // Structural errors are reported by their own checks; estimation uses fallback styles.
  const type = asString(element.elementType)
  if (type === undefined) return undefined
  const bounds = asTuple(element.bounds, 4)
  const content = asRecord(element.content)
  if (bounds === undefined || content === undefined || typeof content.text !== 'string' || plainText(content.text).trim() === '') return undefined
  const style = textStyle(project, content)
  const fontSize = asNumber(style.fontSize) ?? 18
  const inlineSizes = Array.from(content.text.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/giu), (match) => Number(match[1]))
  const vertical = style.textDirection === 'vertical'
  const lineHeight = asNumber(style.lineHeight)
  const letterSpacing = asNumber(style.letterSpacing)
  const wrap = asBoolean(style.wrap)
  return measureTextLayout({
    text: plainText(content.text),
    width: bounds[vertical ? 3 : 2] ?? 0,
    height: bounds[vertical ? 2 : 3] ?? 0,
    fontSize: Math.max(fontSize, ...inlineSizes),
    bold: asBoolean(style.bold) === true || /<(?:b|strong)(?:\s|>)/iu.test(content.text),
    ...(lineHeight === undefined ? {} : { lineHeight }),
    ...(letterSpacing === undefined ? {} : { letterSpacing }),
    ...(wrap === undefined ? {} : { wrap }),
  })
}

function localAssetPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || /^https?:\/\//iu.test(value)) return undefined
  return safeProjectPath(value)
}

function compatibilityIssue(page: PptdPage, context: { elementId?: string }, level: string, feature: string): PptdIssue {
  return {
    code: `compatibility-${level}`,
    severity: level === 'unsupported' ? 'error' : 'warning',
    file: page.file,
    ...context,
    message: `${feature} 的渲染兼容级别为 ${level}。`,
  }
}

/**
 * Content-carrying decisions and typography heuristics. These are advisory
 * (warning) signals: they name a carrier form or an alignment-level smell
 * before export without ever blocking it, because taste is the author's call
 * and only structural breakage is refused.
 */

/** Reading copy: shorter strings are labels, kickers or page furniture. */
const BODY_TEXT_CHARS = 12
/** Reading-copy sizes beyond this ratio have no ladder step to justify them. */
const FONT_SCALE_TOLERANCE = 1.15
/** Left edges closer than this are the same alignment in effect. */
const ALIGNMENT_TOLERANCE = 2
/** Left edges further apart than this are a deliberate column split. */
const COLUMN_SPLIT_MAX = 8

/** Category labels that read as a time axis rather than a category set. */
const TIME_LABEL_PATTERN = /(?:\d{4}|\bQ[1-4]\b|季度|[0-9一二三四五六七八九十]{1,3}月|[0-9]{1,2}日|第[0-9一二三四五六七八九十]{1,2}(?:周|期|步)|年)/iu

/** Category labels of a data-grid chart, read from the first series' x encode. */
function gridChartCategories(element: Element): string[] {
  const data = asRecord(element.data)
  const cols = Array.isArray(data?.cols) ? data.cols : []
  const rows = Array.isArray(data?.rows) ? data.rows : []
  const series = Array.isArray(element.series) ? element.series.map(asRecord) : []
  const encode = asRecord(series[0]?.encode)
  const xRef = asString(encode?.x) ?? asString(cols[0])
  const index = xRef === undefined ? -1 : cols.indexOf(xRef)
  if (index < 0) return []
  return rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => (row[index] === undefined || row[index] === null ? '' : String(row[index]).trim()))
    .filter((value) => value !== '')
}

/**
 * The carrier-form judgement behind `chart-kind-mismatch` and
 * `too-few-series-for-chart`: describe the relation first, then pick the
 * form. Time series belong on a line, a pie beyond a handful of slices stops
 * being readable, and two or three numbers never needed a whole chart.
 */
function chartDecisionIssues(page: PptdPage, element: Element, context: { page: number, elementId?: string }): PptdIssue[] {
  const issues: PptdIssue[] = []
  const flat = isFlatChart(element)
  const rawLabels = flat
    ? (Array.isArray(element.labels) ? element.labels.filter((value): value is string => typeof value === 'string') : [])
    : gridChartCategories(element)
  const categories = rawLabels.map((value) => value.trim()).filter((value) => value !== '')
  if (categories.length === 0) return issues
  const kinds = flat
    ? [asString(element.chart)].filter((kind): kind is string => kind !== undefined)
    : (Array.isArray(element.series) ? element.series.map(asRecord) : [])
      .map((series) => asString(series?.type)).filter((kind): kind is string => kind !== undefined)
  if (kinds.length === 0) return issues
  const seriesCount = flat ? (Array.isArray(element.series) ? element.series.length : 0) : kinds.length
  if (kinds.includes('pie') && categories.length > 6) {
    issues.push({
      code: 'chart-kind-mismatch',
      severity: 'warning',
      file: page.file,
      ...context,
      message: `饼图有 ${categories.length} 个扇区：部分与整体只在类别不超过 5 个且份额差异明显时用饼图或环形图；先试试条形图比较，或改用表格列出精确数值。`,
    })
  }
  if (TIME_LABEL_PATTERN.test(categories.join(' ')) && kinds.some((kind) => kind === 'pie' || kind === 'bar')) {
    issues.push({
      code: 'chart-kind-mismatch',
      severity: 'warning',
      file: page.file,
      ...context,
      message: '类目看起来是时间序列，却用了饼图或条形图：时间变化用折线图或面积图更清楚，不需要看趋势时改用表格列出各期数值。',
    })
  }
  if (seriesCount === 1 && categories.length >= 2 && categories.length <= 3) {
    issues.push({
      code: 'too-few-series-for-chart',
      severity: 'warning',
      file: page.file,
      ...context,
      message: `单系列只有 ${categories.length} 个数据点：直接用文字或 KPI 卡更清楚，不必占用整块图表；确有对比需求时再补足类目。`,
    })
  }
  return issues
}

/** One text element reduced to the signals typography heuristics need. */
interface ReadingText {
  id?: string
  size: number
  chars: number
  x: number
  y: number
  height: number
}

/** Reading-copy text elements of a page, skipping labels and empty copy. */
function readingTexts(project: PptdProject, page: PptdPage): ReadingText[] {
  const reading: ReadingText[] = []
  for (const element of page.elements) {
    if (asString(element.elementType) !== 'text') continue
    const content = asRecord(element.content)
    if (content === undefined || typeof content.text !== 'string') continue
    const text = plainText(content.text).trim()
    if (text.length < BODY_TEXT_CHARS) continue
    const bounds = asTuple(element.bounds, 4)
    if (bounds === undefined) continue
    reading.push({
      ...(typeof element.elementId === 'string' ? { id: element.elementId } : {}),
      size: asNumber(textStyle(project, content).fontSize) ?? 18,
      chars: text.length,
      x: bounds[0] ?? 0,
      y: bounds[1] ?? 0,
      height: bounds[3] ?? 0,
    })
  }
  return reading
}

/**
 * Typography signals: `font-scale-off` (body-level sizes drifting > 15% with
 * no ladder step, or reading copy below 0.65x the page body size away from the
 * footer band) and `column-drift` (left edges 2-8pt apart — neither aligned
 * nor an intentional split). All advisory.
 */
function typographyIssues(project: PptdProject, page: PptdPage, pageNumber: number): PptdIssue[] {
  const issues: PptdIssue[] = []
  const reading = readingTexts(project, page)
  if (reading.length === 0) return issues
  // The page's body size is the size of its longest run, not its most common
  // one: labels and captions can outnumber real copy.
  const body = reading.reduce((longest, item) => (item.chars > longest.chars ? item : longest)).size
  const comparable = reading.filter((item) => item.size >= body * 0.5 && item.size < body * 1.5)
  if (comparable.length >= 2) {
    const smallest = Math.min(...comparable.map((item) => item.size))
    const largest = Math.max(...comparable.map((item) => item.size))
    if (largest / smallest > FONT_SCALE_TOLERANCE) {
      const outlier = comparable.reduce((worst, item) => (Math.abs(item.size - body) > Math.abs(worst.size - body) ? item : worst))
      issues.push({
        code: 'font-scale-off',
        severity: 'warning',
        file: page.file,
        page: pageNumber,
        ...(outlier.id === undefined ? {} : { elementId: outlier.id }),
        message: `本页正文级文字出现 ${smallest}–${largest}pt 的字号（基准 ${body}pt），偏差超过 15% 且不属于标题/注释层级：统一到同一档，或按视觉层级拉开到明确档位。`,
      })
    }
  }
  for (const item of reading) {
    if (item.size >= body * 0.65 || item.y + item.height >= project.height * 0.9) continue
    issues.push({
      code: 'font-scale-off',
      severity: 'warning',
      file: page.file,
      page: pageNumber,
      ...(item.id === undefined ? {} : { elementId: item.id }),
      message: `正文级文字只有 ${item.size}pt（本页正文基准 ${body}pt，低于 0.65 倍）且不在页脚位置：增大字号、精简内容，或确认它属于注释/页脚层级。`,
    })
  }
  const edges = [...new Set(reading.map((item) => item.x))].sort((left, right) => left - right)
  for (let index = 1; index < edges.length; index += 1) {
    const gap = edges[index] - edges[index - 1]
    if (gap < ALIGNMENT_TOLERANCE || gap > COLUMN_SPLIT_MAX) continue
    const rightEdge = reading.find((item) => item.x === edges[index])
    issues.push({
      code: 'column-drift',
      severity: 'warning',
      file: page.file,
      page: pageNumber,
      ...(rightEdge?.id === undefined ? {} : { elementId: rightEdge.id }),
      message: `本页文本左边界 ${edges[index - 1]}pt 与 ${edges[index]}pt 只差 ${gap}pt（既不是对齐也不是分栏）：同类元素对齐到同一条左边界，或明确拉开为分栏。`,
    })
    // One drift signal per page is enough to send the author back to the grid.
    break
  }
  return issues
}

/** A cover whose only content is a title and subtitle reads as a shell. */
function coverHookIssues(project: PptdProject): PptdIssue[] {
  return project.pages.flatMap((page, index) => {
    if (!/^(?:cover|title|opening)$/iu.test(page.pageType?.trim() ?? '')) return []
    const texts = page.elements.filter((element) => {
      if (asString(element.elementType) !== 'text') return false
      const text = asString(asRecord(element.content)?.text)
      return text !== undefined && plainText(text).trim() !== ''
    })
    const visuals = page.elements.filter((element) => asString(element.elementType) !== 'text')
    if (texts.length === 0 || texts.length > 2 || visuals.length > 0) return []
    return [{
      code: 'weak-cover',
      severity: 'warning',
      file: page.file,
      page: index + 1,
      message: '封面只有标题和副标题，没有取自材料的具体钩子：补一个主张、一个数字、一个隐喻或一处冲突情境，或放一张主视觉，让封面本身传递信息。',
    }]
  })
}

/** A closing page must land on a conclusion or an action, not a thank-you. */
function closingLandingIssues(project: PptdProject): PptdIssue[] {
  return project.pages.flatMap((page, index) => {
    if (!/^(?:closing|final|end|thanks|thank-you|thankyou)$/iu.test(page.pageType?.trim() ?? '')) return []
    const copy = page.elements
      .flatMap((element) => {
        if (asString(element.elementType) !== 'text') return []
        const text = asString(asRecord(element.content)?.text)
        return text === undefined ? [] : [plainText(text)]
      })
      .join('')
      .trim()
    const residual = copy.replace(/谢谢|感谢|联系方式|敬请指正|观看/gu, '')
    if (copy.length >= 20 && residual.length >= 20) return []
    return [{
      code: 'weak-closing',
      severity: 'warning',
      file: page.file,
      page: index + 1,
      message: '结尾页信息量不足（或只有致谢、联系方式）：改写为可落地的结论、决策或下一步行动项，让观众带走一件明确要做的事。',
    }]
  })
}

/** One cell's resolved grid position from the occupancy walk. */
interface TableCellSlot {
  cell: Element
  /** The authored cell before record coercion; scalar cells keep their value. */
  rawCell: unknown
  row: number
  column: number
  /** Index within the raw row; column formatting is keyed by it, like the renderer. */
  rawColumn: number
  rowSpan: number
  colSpan: number
}

/** Walk a table grid; undefined when ratios, merges or row lengths are inconsistent. */
function tableGridSlots(element: Element): TableCellSlot[] | undefined {
  const rows = Array.isArray(element.rows) ? element.rows : []
  const columnWidths = Array.isArray(element.columnWidths) ? element.columnWidths.map(asNumber) : []
  const rowHeights = Array.isArray(element.rowHeights) ? element.rowHeights.map(asNumber) : []
  const columnCount = columnWidths.length
  const rowCount = rowHeights.length
  if (rowCount === 0 || columnCount === 0 || rows.length !== rowCount) return undefined
  if (columnWidths.some((value) => value === undefined || value < 0 || value > 1)) return undefined
  if (rowHeights.some((value) => value === undefined || value < 0 || value > 1)) return undefined
  const nearOne = (values: (number | undefined)[]): boolean =>
    Math.abs(values.reduce<number>((sum, value) => sum + (value ?? 0), 0) - 1) < 0.001
  if (!nearOne(columnWidths) || !nearOne(rowHeights)) return undefined
  const occupied = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => false))
  const slots: TableCellSlot[] = []
  for (const [rowIndex, rawRow] of rows.entries()) {
    if (!Array.isArray(rawRow)) return undefined
    let columnIndex = 0
    for (const [rawColumn, rawCell] of rawRow.entries()) {
      while (columnIndex < columnCount && occupied[rowIndex]?.[columnIndex] === true) columnIndex += 1
      const cell = asRecord(rawCell) ?? {}
      const rowSpan = asNumber(cell.rowSpan) ?? 1
      const colSpan = asNumber(cell.colSpan) ?? 1
      if (!Number.isInteger(rowSpan) || !Number.isInteger(colSpan) || rowSpan < 1 || colSpan < 1
        || rowIndex + rowSpan > rowCount || columnIndex + colSpan > columnCount) return undefined
      for (let row = rowIndex; row < rowIndex + rowSpan; row += 1) {
        const occupiedRow = occupied[row]
        if (occupiedRow === undefined) return undefined
        for (let column = columnIndex; column < columnIndex + colSpan; column += 1) {
          if (occupiedRow[column] === true) return undefined
          occupiedRow[column] = true
        }
      }
      slots.push({ cell, rawCell, row: rowIndex, column: columnIndex, rawColumn, rowSpan, colSpan })
      columnIndex += colSpan
    }
    if (occupied[rowIndex]?.some((value) => !value) === true) return undefined
  }
  return slots
}

/** A table whose grid, ratios and merged regions form a complete rectangle. */
function validTableGrid(element: Element): boolean {
  return tableGridSlots(element) !== undefined
}

/** Fields only the data-grid chart form carries; a flat chart must not mix them in. */
const FLAT_CHART_CONFLICT_FIELDS: readonly string[] = [
  'data', 'seriesDefaults', 'xAxis', 'yAxis', 'barWidth', 'barGap', 'categoryGap',
  'spokeAxis', 'legend', 'dataLabels', 'fontFamily', 'fill', 'border', 'shadow',
]

/** Whether the element uses the flat authoring form (`chart` kind + labels/series values). */
export function isFlatChart(element: Element): boolean {
  return element.chart !== undefined
}

/**
 * Flat-form chart validation: closed kind set, bounded labels/series, and
 * per-series values aligned with the labels. Every violation is an error with
 * the fix in its message — the render path never patches chart data.
 */
function flatChartIssues(page: PptdPage, element: Element, context: { page: number, elementId?: string }): PptdIssue[] {
  const issues: PptdIssue[] = []
  const conflict = FLAT_CHART_CONFLICT_FIELDS.filter((field) => element[field] !== undefined)
  if (conflict.length > 0) {
    issues.push({
      code: 'chart-form',
      severity: 'error',
      file: page.file,
      ...context,
      message: `精简图表写法（chart/labels/series.values）不能混用数据表字段：${conflict.join('、')}；两种写法二选一，重写后重新校验。`,
    })
  }
  const kind = asString(element.chart)
  if (kind === undefined || !FLAT_CHART_KINDS.has(kind)) {
    issues.push({
      code: 'chart-kind',
      severity: 'error',
      file: page.file,
      ...context,
      message: `chart 必须是 ${[...FLAT_CHART_KINDS].join('、')} 之一${kind === undefined ? '' : `（当前 ${kind}）`}；改用受支持的类型后重新校验。`,
    })
  }
  const labels = element.labels
  const labelValues = Array.isArray(labels) ? labels.map((value) => (typeof value === 'string' ? value.trim() : undefined)) : undefined
  if (labelValues === undefined || labelValues.length === 0
    || labelValues.length > MAX_CHART_LABELS || labelValues.some((value) => value === undefined || value === '')) {
    issues.push({
      code: 'chart-labels',
      severity: 'error',
      file: page.file,
      ...context,
      message: `labels 必须是 1–${MAX_CHART_LABELS} 个非空字符串（当前 ${Array.isArray(labels) ? labels.length : '缺失'} 项或有空项）；每个类目一行短标签，超出时改用表格或拆分图表。`,
    })
  }
  const labelCount = labelValues?.length ?? 0
  const rawSeries = Array.isArray(element.series) ? element.series : undefined
  const series = rawSeries?.map(asRecord)
  if (rawSeries === undefined || series === undefined || series.length < 1 || series.length > MAX_CHART_SERIES
    || series.some((item) => item === undefined)) {
    issues.push({
      code: 'chart-series',
      severity: 'error',
      file: page.file,
      ...context,
      message: `series 必须是 1–${MAX_CHART_SERIES} 个对象，每项含 name 与 values；多于 ${MAX_CHART_SERIES} 条时拆成多个图表。`,
    })
  } else {
    // A pie can only carry one data series; more than one is an authoring
    // mistake the renderer would silently resolve by dropping series.
    if (kind === 'pie' && series.length > 1) {
      issues.push({
        code: 'chart-series',
        severity: 'error',
        file: page.file,
        ...context,
        message: '饼图只支持一组数据，请改用柱状图或拆分。',
      })
    }
    for (const [index, item] of series.entries()) {
      const name = asString(item?.name)?.trim()
      if (name === undefined || name === '') {
        issues.push({
          code: 'chart-series',
          severity: 'error',
          file: page.file,
          ...context,
          message: `第 ${index + 1} 条 series 缺少非空 name；补上系列名称后重新校验。`,
        })
      }
      const values = Array.isArray(item?.values) ? item?.values : undefined
      const finite = values !== undefined && values.every((value) => typeof value === 'number' && Number.isFinite(value))
      if (values === undefined || !finite || values.length !== labelCount) {
        issues.push({
          code: 'chart-values',
          severity: 'error',
          file: page.file,
          ...context,
          message: `第 ${index + 1} 条 series 的 values 必须是与 labels 等长（${labelCount} 个）的有限数字；补齐或修正数值后重新校验。`,
        })
      }
    }
  }
  const title = asString(element.title)
  if (title !== undefined && plainText(title).length > MAX_CHART_TITLE_CHARS) {
    issues.push({
      code: 'chart-title',
      severity: 'error',
      file: page.file,
      ...context,
      message: `chart title 超过 ${MAX_CHART_TITLE_CHARS} 字（当前 ${plainText(title).length} 字）；缩短为一句结论，或删掉 title 改用页面文本元素。`,
    })
  }
  return issues
}

/**
 * First-column labels that mark the last row as a total. The check is on the
 * label, not the position: a plain final data row must look like every other
 * data row.
 */
const TOTAL_ROW_PATTERN = /^(?:合计|总计|小计|汇总|total|subtotal|sum)$/iu

/** One cell reduced to its authored value; scalar cells and `{text}` both work. */
export function tableCellValue(raw: unknown): ColumnValue | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === 'string') return plainText(raw)
  const record = asRecord(raw)
  if (record === undefined) return undefined
  if (typeof record.text === 'number') return Number.isFinite(record.text) ? record.text : undefined
  return typeof record.text === 'string' ? plainText(record.text) : undefined
}

/** The table's raw column count: the declared widths, or the widest row. */
function tableColumnCount(element: Element): number {
  if (Array.isArray(element.columnWidths)) return element.columnWidths.length
  const rows = Array.isArray(element.rows) ? element.rows : []
  return rows.reduce<number>((widest, row) => Math.max(widest, Array.isArray(row) ? row.length : 0), 0)
}

/** Data values of one raw column, header excluded. */
function tableColumnValues(element: Element, column: number): ColumnValue[] {
  const rows = Array.isArray(element.rows) ? element.rows : []
  const values: ColumnValue[] = []
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row)) continue
    const value = tableCellValue(row[column])
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) continue
    values.push(value)
  }
  return values
}

/**
 * Per-column formatting plans, keyed by the cell's raw column index exactly
 * as the renderer walks rows. Shared so a capacity estimate and the exported
 * cell can never disagree about how a value is written.
 */
export function tableColumnPlans(element: Element, columnCount?: number): ColumnFormatPlan[] {
  const rows = Array.isArray(element.rows) ? element.rows : []
  const headerRow = Array.isArray(rows[0]) ? rows[0] : []
  const width = columnCount ?? tableColumnCount(element)
  return Array.from({ length: width }, (_, column) => {
    const header = tableCellValue(headerRow[column])
    return planColumnFormat(tableColumnValues(element, column), header === undefined ? '' : String(header))
  })
}

/** Content-derived column ratios for a table that declared no usable widths. */
export function tableColumnRatios(element: Element, columnCount?: number): number[] | undefined {
  const rows = Array.isArray(element.rows) ? element.rows : []
  const headerRow = Array.isArray(rows[0]) ? rows[0] : []
  const plans = tableColumnPlans(element, columnCount)
  const samples: ColumnFormatSample[] = plans.map((_, column) => {
    const header = tableCellValue(headerRow[column])
    return { header: header === undefined ? '' : String(header), values: tableColumnValues(element, column) }
  })
  return estimateColumnRatios(samples, plans)
}

/** First-column label of the last row, when it marks a total. */
function isTotalRow(table: Element, rowCount: number): boolean {
  const rows = Array.isArray(table.rows) ? table.rows : []
  const lastRow = rows[rowCount - 1]
  if (!Array.isArray(lastRow)) return false
  const label = tableCellValue(lastRow[0])
  return typeof label === 'string' && TOTAL_ROW_PATTERN.test(label.trim())
}

/**
 * Header cells default to 11pt bold and data cells to 10pt; an explicit style
 * always wins, so theme typography is never overridden by the fallback.
 */
export function tableCellTypography(style: Element, row: number): { fontSize: number, bold: boolean } {
  const header = row === 0
  return {
    fontSize: asNumber(style.fontSize) ?? (header ? 11 : 10),
    bold: asBoolean(style.bold) ?? header,
  }
}

/**
 * Effective style of one table cell: the table-style theme resolved against
 * theme.tableStyles, then row/column bands, then the cell itself. When the
 * table names no style, the theme's `default` entry applies, which is how the
 * fallback theme gives every table a visible structure. Shared with the
 * renderer so capacity estimates can never drift from what is drawn.
 */
export function tableCellStyle(project: PptdProject, table: Element, cell: Element, row: number, column: number, rowCount: number, columnCount: number): Element {
  const tableStyles = asRecord(project.theme.tableStyles) ?? {}
  const tableTheme = asRecord(resolveThemeReference(table.style, tableStyles)) ?? asRecord(tableStyles.default) ?? {}
  const baseline = asRecord(tableTheme.cellStyle) ?? {}
  const bodyStyles = Array.isArray(tableTheme.bodyStyles) ? tableTheme.bodyStyles.map(asRecord).filter((item) => item !== undefined) : []
  const body = row > 0 && row < rowCount - 1 && bodyStyles.length > 0 ? bodyStyles[(row - 1) % bodyStyles.length] ?? {} : {}
  const totalStyle = asRecord(tableTheme.totalRowStyle) ?? {}
  const total = row === rowCount - 1 && Object.keys(totalStyle).length > 0 && isTotalRow(table, rowCount)
  const rowStyle = row === 0
    ? asRecord(tableTheme.firstRowStyle) ?? {}
    : total ? totalStyle : row === rowCount - 1 ? asRecord(tableTheme.lastRowStyle) ?? {} : body
  const columnStyle = column === 0 ? asRecord(tableTheme.firstColumnStyle) ?? {} : column === columnCount - 1 ? asRecord(tableTheme.lastColumnStyle) ?? {} : {}
  return asBoolean(tableTheme.rowOverColumn) === false
    ? { ...baseline, ...rowStyle, ...columnStyle, ...cell }
    : { ...baseline, ...columnStyle, ...rowStyle, ...cell }
}

/**
 * Per-cell capacity rules: PowerPoint grows a row when copy does not fit, so
 * an overflowing cell means the table will push past its declared bounds and
 * press into the elements below — refused here instead of discovered there.
 */
function tableCellIssues(project: PptdProject, page: PptdPage, pageNumber: number, element: Element, slots: TableCellSlot[], plans: readonly ColumnFormatPlan[]): PptdIssue[] {
  const issues: PptdIssue[] = []
  const context = { page: pageNumber, ...(typeof element.elementId === 'string' ? { elementId: element.elementId } : {}) }
  const bounds = asTuple(element.bounds, 4)
  if (bounds === undefined) return issues
  const columnWidths = Array.isArray(element.columnWidths) ? element.columnWidths.map(asNumber) : []
  const rowHeights = Array.isArray(element.rowHeights) ? element.rowHeights.map(asNumber) : []
  for (const { cell, rawCell, row, column, rawColumn, rowSpan, colSpan } of slots) {
    const value = tableCellValue(rawCell)
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) continue
    // Capacity is measured on the text that will actually be drawn: a raw
    // `1280` becomes `1,280.0` and takes more room than the authored digits.
    const text = plans[rawColumn]?.format(value) ?? (typeof value === 'number' ? String(value) : value)
    const spanWidth = columnWidths.slice(column, column + colSpan).reduce<number>((sum, item) => sum + (item ?? 0), 0)
    const spanHeight = rowHeights.slice(row, row + rowSpan).reduce<number>((sum, item) => sum + (item ?? 0), 0)
    const style = {
      ...asRecord(resolveThemeReference(cell.textStyle, themeMap(project, 'textStyles'))) ?? {},
      ...tableCellStyle(project, element, cell, row, column, rowHeights.length, columnWidths.length),
    }
    const typography = tableCellTypography(style, row)
    if (text.length > 120) {
      issues.push({
        code: 'table-cell-length',
        severity: 'error',
        file: page.file,
        ...context,
        message: `第 ${row + 1} 行第 ${column + 1} 列单元格文字过长（${text.length} 字，上限 120）：改写为短句、拆成多个单元格，或拆分表格。`,
      })
      continue
    }
    const layout = measureTextLayout({
      text,
      width: (bounds[2] ?? 0) * spanWidth,
      height: (bounds[3] ?? 0) * spanHeight,
      fontSize: typography.fontSize,
      bold: typography.bold,
      ...(asNumber(style.lineHeight) === undefined ? {} : { lineHeight: asNumber(style.lineHeight) }),
    })
    if (layout.overflow) {
      issues.push({
        code: 'table-cell-overflow',
        severity: 'error',
        file: page.file,
        ...context,
        message: `第 ${row + 1} 行第 ${column + 1} 列单元格文字预计需要 ${layout.lineCount} 行，行高只容得下 ${layout.maxLineCount} 行（渲染会撑高表格、压到下方内容）；请缩短文字、加宽该列或加高行，或拆分表格。`,
      })
    }
    if (typography.fontSize < 10) {
      issues.push({
        code: 'font-size',
        severity: 'warning',
        file: page.file,
        ...context,
        message: `第 ${row + 1} 行第 ${column + 1} 列单元格字号 ${typography.fontSize} 低于 10pt，投屏与打印可读性差；请增大字号或精简内容。`,
      })
    }
  }
  return issues
}

/** Magnitude whose median marks a column as needing an explicit unit. */
const MAJOR_VALUE_MEDIAN = 1e4
/** Unit markers accepted in a header or title: a parenthesised suffix or a common unit word. */
const UNIT_PATTERN = /[（(][^）)]*[）)]|万元|亿元|万|亿|千元|元|美元|%|％|人|个|次|天|小时|分钟|秒|吨|件|台|套|份|倍|米|平方米/u

function hasUnit(text: string): boolean {
  return UNIT_PATTERN.test(text)
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * Column-level presentation smells: `decimal-mismatch` (one column mixing
 * decimal places renders ragged or, past two shapes, cannot pick a width),
 * `percent-column-format` (a ratio stored as a true decimal would be silently
 * rewritten to a percent) and `missing-unit` (a large-magnitude numeric column
 * whose header never names a unit). All advisory except the three-way decimal
 * mismatch, which is a rendering defect rather than taste.
 */
function tableColumnIssues(project: PptdProject, page: PptdPage, pageNumber: number, element: Element, plans: readonly ColumnFormatPlan[]): PptdIssue[] {
  const issues: PptdIssue[] = []
  const context = { page: pageNumber, ...(typeof element.elementId === 'string' ? { elementId: element.elementId } : {}) }
  const rows = Array.isArray(element.rows) ? element.rows : []
  const headerRow = Array.isArray(rows[0]) ? rows[0] : []
  for (let column = 0; column < plans.length; column += 1) {
    const headerValue = tableCellValue(headerRow[column])
    const header = headerValue === undefined ? '' : String(headerValue)
    const label = header === '' ? `第 ${column + 1} 列` : `第 ${column + 1} 列「${header}」`
    const values = tableColumnValues(element, column)
    const numbers = values.map(parsePlainNumber).filter((value): value is number => value !== undefined)
    if (plans[column]?.kind === 'number' && numbers.length >= 2) {
      const distinct = [...new Set(numbers.map(decimalPlacesOf))].sort((left, right) => left - right)
      if (distinct.length >= 3) {
        issues.push({
          code: 'decimal-mismatch',
          severity: 'error',
          file: page.file,
          ...context,
          message: `${label}同列数值混用 ${distinct.length} 种小数位（${distinct.map((item) => `${item} 位`).join('、')}），显示会参差不齐；请统一小数位后重新校验，或把该列改写为文本。`,
        })
      } else if (distinct.length === 2) {
        issues.push({
          code: 'decimal-mismatch',
          severity: 'warning',
          file: page.file,
          ...context,
          message: `${label}同列混用 ${distinct.join('、')} 位小数，渲染会按最大位数（${distinct[distinct.length - 1]} 位）统一显示；如需不同精度请统一数据的小数位。`,
        })
      }
    }
    if (plans[column]?.kind === 'percent') {
      const first = numbers[0] ?? 0
      issues.push({
        code: 'percent-column-format',
        severity: 'warning',
        file: page.file,
        ...context,
        message: `${label}是比率列却按小数真值书写（如 ${first}）：渲染会显示为 ${(first * 100).toFixed(1)}%；请直接写成百分比文本（如 "${(first * 100).toFixed(1)}%"），或确认该列本应是真值。`,
      })
    }
    if (numbers.length > 0) {
      const median = medianOf(numbers.map((value) => Math.abs(value)))
      if (median >= MAJOR_VALUE_MEDIAN && !hasUnit(header) && !hasUnit(project.title)) {
        issues.push({
          code: 'missing-unit',
          severity: 'warning',
          file: page.file,
          ...context,
          message: `${label}数值量级较大（|值| 中位数 ${Math.round(median)}），但表头与标题都没有单位；请在表头写清单位（如「金额（万元）」）。`,
        })
      }
    }
  }
  return issues
}

function checkElement(project: PptdProject, page: PptdPage, pageNumber: number, element: Element, ids: Set<string>): PptdIssue[] {
  const issues: PptdIssue[] = []
  const context = {
    page: pageNumber,
    ...(typeof element.elementId === 'string' ? { elementId: element.elementId } : {}),
  }
  const id = asString(element.elementId)
  issues.push(...colorThemeIssues(project, element, page.file, pageNumber, id))
  if (id === undefined || id.trim() === '') {
    issues.push({ code: 'element-id', severity: 'error', file: page.file, ...context, message: '元素缺少 elementId。' })
  } else if (ids.has(id)) {
    issues.push({ code: 'duplicate-id', severity: 'error', file: page.file, ...context, message: `元素 ID ${id} 重复。` })
  } else {
    ids.add(id)
  }
  const bounds = asTuple(element.bounds, 4)
  const [x = 0, y = 0, width = -1, height = -1] = bounds ?? []
  if (bounds === undefined || width < 0 || height < 0) {
    issues.push({ code: 'bounds', severity: 'error', file: page.file, ...context, message: '元素 bounds 必须是 [x, y, width, height]。' })
  } else if (x < 0 || y < 0 || x + width > project.width + 0.01 || y + height > project.height + 0.01) {
    issues.push({ code: 'out-of-bounds', severity: 'error', file: page.file, ...context, message: '元素超出 PPTD 页面边界。' })
  }
  const type = asString(element.elementType)
  if (type === undefined || !ELEMENT_TYPES.has(type)) {
    issues.push({ code: 'element-type', severity: 'error', file: page.file, ...context, message: `不支持的 elementType：${type ?? 'missing'}。` })
    return issues
  }
  if (type === 'text') {
    const content = asRecord(element.content)
    const styleIssue = themeReferenceIssue(project, content?.style, 'textStyles', page.file, pageNumber, id)
    if (styleIssue !== undefined) issues.push(styleIssue)
    if (content === undefined || typeof content.text !== 'string') {
      issues.push({ code: 'text-content', severity: 'error', file: page.file, ...context, message: '文本元素需要 content.text。' })
    } else {
      const layout = textLayout(project, element)
      if (layout?.overflow === true) {
        const message = layout.horizontalOverflow
          ? `文本设置为不换行，但预计宽度 ${Math.ceil(layout.widestLine)}pt 超过文本框可用宽度 ${Math.floor(layout.availableLineWidth)}pt；请缩短文案或增大文本框。`
          : `文本预计需要 ${layout.lineCount} 行，当前文本框可容纳 ${layout.maxLineCount} 行；请缩短文案、增大文本框或拆分页面。`
        issues.push({ code: 'text-overflow', severity: 'error', file: page.file, ...context, message })
      }
      const fontSize = asNumber(textStyle(project, content).fontSize) ?? 18
      if (fontSize < 10) {
        issues.push({
          code: 'font-size',
          severity: 'warning',
          file: page.file,
          ...context,
          message: `字号 ${fontSize} 低于 10pt，投屏与打印可读性差；请增大字号或精简内容。`,
        })
      }
    }
    if (content !== undefined && (content.gradient !== undefined || content.shadow !== undefined)) {
      issues.push(compatibilityIssue(page, context, 'normalized', '文本渐变或阴影'))
    }
    if (typeof content?.text === 'string' && /<(?:u|s|sup|sub|a|ol)(?:\s|>)/iu.test(content.text)) {
      issues.push(compatibilityIssue(page, context, 'normalized', '高级富文本标签'))
    }
  }
  if (type === 'shape') {
    const name = asString(element.shapeName)
    if (name === undefined) {
      issues.push({ code: 'shape-name', severity: 'error', file: page.file, ...context, message: '形状元素需要 shapeName。' })
    } else if (name === 'custom') {
      if (asTuple(element.viewBox, 2) === undefined || typeof element.path !== 'string') {
        issues.push({ code: 'custom-shape', severity: 'error', file: page.file, ...context, message: '自定义形状需要 viewBox 和 SVG path。' })
      } else {
        issues.push(compatibilityIssue(page, context, 'vector-fallback', '自定义 SVG 形状'))
      }
    } else if (!nativeShapeNames().has(name)) {
      issues.push({ code: 'shape-name', severity: 'error', file: page.file, ...context, message: `未知的内置形状：${name}。` })
    }
    if (element.adjustments !== undefined) issues.push(compatibilityIssue(page, context, 'normalized', '形状 adjustments'))
    const fill = asRecord(element.fill)
    if (fill?.type === 'gradient' || fill?.type === 'image') issues.push(compatibilityIssue(page, context, 'normalized', '形状渐变或图片填充'))
    if (element.shadow !== undefined) issues.push(compatibilityIssue(page, context, 'normalized', '形状阴影'))
  }
  if (type === 'line') {
    const points = typeof element.points === 'string' ? element.points.trim().split(/\s+/u) : []
    const invalidPoint = points.some((point) => !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/u.test(point))
    if (asTuple(element.viewBox, 2) === undefined || points.length < 2 || invalidPoint) {
      issues.push({ code: 'line-path', severity: 'error', file: page.file, ...context, message: '线条元素需要有效的 viewBox 和至少两个 points。' })
    } else if (points.length > 2 || element.curve === 'smooth') {
      issues.push(compatibilityIssue(page, context, 'vector-fallback', '贝塞尔曲线'))
    }
    if (element.shadow !== undefined) issues.push(compatibilityIssue(page, context, 'normalized', '线条阴影'))
  }
  if (type === 'image') {
    if (typeof element.src !== 'string') {
      issues.push({ code: 'image-src', severity: 'error', file: page.file, ...context, message: '图片元素需要 src。' })
    } else if (/^https?:\/\//iu.test(element.src)) {
      issues.push({ code: 'remote-image', severity: 'error', file: page.file, ...context, message: '本地 PPTD 渲染器不访问网络图片，请先将图片放入项目目录。' })
    } else {
      const assetPath = localAssetPath(element.src)
      if (assetPath === undefined || !project.source.assets.has(assetPath)) {
        issues.push({ code: 'missing-asset', severity: 'error', file: page.file, ...context, message: `找不到图片资源 ${element.src}。` })
      }
    }
    const fit = asRecord(element.fit)
    if (fit !== undefined && !['fill', 'contain', 'cover'].includes(asString(fit.mode) ?? '')) {
      issues.push({ code: 'image-fit', severity: 'error', file: page.file, ...context, message: '图片 fit.mode 必须是 fill、contain 或 cover。' })
    }
    if (element.crop !== undefined || element.cropShape !== undefined || element.shadow !== undefined || element.border !== undefined) {
      const cropShape = asRecord(element.cropShape)
      issues.push(compatibilityIssue(page, context, cropShape?.shapeName === 'custom' ? 'raster-fallback' : 'normalized', '图片裁剪、边框或阴影'))
    }
  }
  if (type === 'table') {
    if (typeof element.style === 'string') {
      const styleIssue = themeReferenceIssue(project, element.style, 'tableStyles', page.file, pageNumber, id)
      if (styleIssue !== undefined) issues.push(styleIssue)
    }
    const rows = Array.isArray(element.rows) ? element.rows : []
    for (const rawRow of rows) {
      for (const rawCell of Array.isArray(rawRow) ? rawRow : []) {
        const styleIssue = themeReferenceIssue(project, asRecord(rawCell)?.textStyle, 'textStyles', page.file, pageNumber, id)
        if (styleIssue !== undefined) issues.push(styleIssue)
      }
    }
    const slots = tableGridSlots(element)
    if (slots === undefined) {
      issues.push({
        code: 'table-data',
        severity: 'error',
        file: page.file,
        ...context,
        message: '表格网格、宽高比例或合并区域无效：每一行的单元格（含合并）必须铺满同一列网格，columnWidths 与 rowHeights 必须是和为 1 的正数比例。',
      })
    } else {
      const plans = tableColumnPlans(element)
      issues.push(...tableCellIssues(project, page, pageNumber, element, slots, plans))
      issues.push(...tableColumnIssues(project, page, pageNumber, element, plans))
    }
  }
  if (type === 'chart') {
    // Flat form (chart + labels/series.values) and data-grid form (data +
    // series.encode) are mutually exclusive; the flat form never reaches the
    // grid grammar below and vice versa.
    if (isFlatChart(element)) {
      issues.push(...flatChartIssues(page, element, context))
    } else {
      const data = asRecord(element.data)
      const cols = Array.isArray(data?.cols) ? data.cols : []
      const rows = Array.isArray(data?.rows) ? data.rows : []
      const series = Array.isArray(element.series) ? element.series.map(asRecord).filter((item) => item !== undefined) : []
      const validRows = rows.every((row) => Array.isArray(row) && row.length === cols.length)
      const validSeries = series.length > 0 && series.every((item) => {
        const encode = asRecord(item.encode)
        const refs = encode === undefined ? [] : Object.values(encode).filter((value) => typeof value === 'string')
        return typeof item.type === 'string' && refs.length >= 2 && refs.every((ref) => cols.includes(ref))
      })
      if (cols.length < 2 || rows.length === 0 || !validRows || !validSeries) {
        issues.push({ code: 'chart-data', severity: 'error', file: page.file, ...context, message: '图表 data/series/encode 结构不完整。' })
      }
      const chartTypes = series.map((item) => asString(item.type)).filter((item) => item !== undefined)
      const unknownTypes = chartTypes.filter((item) => !NATIVE_CHART_TYPES.has(item) && !UNSUPPORTED_CHART_TYPES.has(item))
      if (unknownTypes.length > 0) {
        issues.push({ code: 'chart-type', severity: 'error', file: page.file, ...context, message: `未知的图表类型：${[...new Set(unknownTypes)].join('、')}。` })
      }
      const unsupportedTypes = chartTypes.filter((item) => UNSUPPORTED_CHART_TYPES.has(item))
      if (unsupportedTypes.length > 0) {
        issues.push(compatibilityIssue(page, context, 'unsupported', `图表类型 ${[...new Set(unsupportedTypes)].join('、')}`))
      }
      // Same pie ceiling as the flat form: one series is all a pie renders.
      if (series.length > 1 && chartTypes.includes('pie')) {
        issues.push({ code: 'chart-series', severity: 'error', file: page.file, ...context, message: '饼图只支持一组数据，请改用柱状图或拆分。' })
      }
    }
    issues.push(...chartDecisionIssues(page, element, context))
  }
  if (type === 'icon' && typeof element.iconName !== 'string') {
    issues.push({ code: 'icon-name', severity: 'error', file: page.file, ...context, message: '图标元素需要 iconName。' })
  }
  return issues
}

/**
 * Text layering signals: a text box covered by a later element, a text box
 * sitting on a table/chart, or copy drifting into the element below. The
 * stacked-subtitle class of bug surfaces here as `text-occlusion` /
 * `text-drift` warnings before any export.
 */
function textLayerIssues(project: PptdProject, page: PptdPage, pageNumber: number): PptdIssue[] {
  const issues: PptdIssue[] = []
  const overlap = (left: number[], right: number[]): { area: number, width: number } => {
    const rightEdge = Math.min((left[0] ?? 0) + (left[2] ?? 0), (right[0] ?? 0) + (right[2] ?? 0))
    const leftEdge = Math.max(left[0] ?? 0, right[0] ?? 0)
    const bottomEdge = Math.min((left[1] ?? 0) + (left[3] ?? 0), (right[1] ?? 0) + (right[3] ?? 0))
    const topEdge = Math.max(left[1] ?? 0, right[1] ?? 0)
    const width = Math.max(0, rightEdge - leftEdge)
    return { area: width * Math.max(0, bottomEdge - topEdge), width }
  }
  for (const [index, element] of page.elements.entries()) {
    if (element.elementType !== 'text') continue
    const textBounds = asTuple(element.bounds, 4)
    if (textBounds === undefined || (textBounds[2] ?? 0) <= 0 || (textBounds[3] ?? 0) <= 0) continue
    const textArea = (textBounds[2] ?? 0) * (textBounds[3] ?? 0)
    const estimatedBottom = (textBounds[1] ?? 0) + (textLayout(project, element)?.requiredHeight ?? 0)
    const textId = asString(element.elementId) ?? '未命名元素'
    for (const earlier of page.elements.slice(0, index)) {
      if (earlier.elementType !== 'table' && earlier.elementType !== 'chart') continue
      const earlierBounds = asTuple(earlier.bounds, 4)
      if (earlierBounds === undefined) continue
      if (overlap(textBounds, earlierBounds).area / textArea >= 0.15) {
        issues.push({
          code: 'text-occlusion',
          severity: 'warning',
          file: page.file,
          page: pageNumber,
          ...(typeof element.elementId === 'string' ? { elementId: element.elementId } : {}),
          message: `文本 ${textId} 与 ${asString(earlier.elementId) ?? earlier.elementType} 的内容区域重叠，请调整两者位置或大小。`,
        })
        break
      }
    }
    for (const later of page.elements.slice(index + 1)) {
      if (later.elementType === 'line' || (asNumber(later.opacity) === 0)) continue
      const laterBounds = asTuple(later.bounds, 4)
      if (laterBounds === undefined) continue
      const intersection = overlap(textBounds, laterBounds)
      // Two text boxes sharing (nearly) one position is the stacked-copy
      // defect — every line lands on the same spot. Hard error, never a style.
      if (later.elementType === 'text') {
        const smallerArea = Math.min(textArea, (laterBounds[2] ?? 0) * (laterBounds[3] ?? 0))
        if (smallerArea > 0 && intersection.area / smallerArea >= 0.9) {
          issues.push({
            code: 'text-stacked',
            severity: 'error',
            file: page.file,
            page: pageNumber,
            ...(typeof element.elementId === 'string' ? { elementId: element.elementId } : {}),
            message: `文本 ${textId} 与后绘制文本元素 ${asString(later.elementId) ?? '未命名元素'} 几乎完全重叠（叠字）；请为每个文本元素安排独立位置。`,
          })
          continue
        }
      }
      if (intersection.area / textArea >= 0.15) {
        issues.push({
          code: 'text-occlusion',
          severity: 'warning',
          file: page.file,
          page: pageNumber,
          ...(typeof element.elementId === 'string' ? { elementId: element.elementId } : {}),
          message: `文本 ${textId} 可能被后绘制元素 ${asString(later.elementId) ?? asString(later.elementType) ?? 'unknown'} 遮挡；请调整两者位置或层级。`,
        })
        break
      }
      const laterTop = laterBounds[1] ?? 0
      if (laterTop > (textBounds[1] ?? 0) && laterTop < (textBounds[1] ?? 0) + (textBounds[3] ?? 0)
        && estimatedBottom > laterTop && intersection.width / (textBounds[2] ?? 1) >= 0.3) {
        issues.push({
          code: 'text-drift',
          severity: 'warning',
          file: page.file,
          page: pageNumber,
          ...(typeof element.elementId === 'string' ? { elementId: element.elementId } : {}),
          message: `文本 ${textId} 可能跨入下方元素 ${asString(later.elementId) ?? asString(later.elementType) ?? 'unknown'} 的边界；请缩短文案或下移该元素。`,
        })
        break
      }
    }
  }
  return issues
}

function visibleTextSizes(project: PptdProject, page: PptdPage): number[] {
  return page.elements.flatMap((element) => {
    if (element.elementType !== 'text') return []
    const content = asRecord(element.content)
    if (content === undefined || typeof content.text !== 'string' || plainText(content.text).trim() === '') return []
    return [asNumber(textStyle(project, content).fontSize) ?? 18]
  })
}

function coverFocusIssues(project: PptdProject): PptdIssue[] {
  const canvasArea = project.width * project.height
  return project.pages.flatMap((page, index) => {
    if (!/^(?:cover|title|opening)$/iu.test(page.pageType?.trim() ?? '')) return []
    if (page.elements.reduce((largest, element) => {
      if (!['image', 'chart', 'table'].includes(asString(element.elementType) ?? '')) return largest
      const bounds = asTuple(element.bounds, 4)
      if (bounds === undefined || canvasArea <= 0) return largest
      return Math.max(largest, (bounds[2] ?? 0) * (bounds[3] ?? 0) / canvasArea)
    }, 0) >= 0.25) return []
    const sizes = visibleTextSizes(project, page).sort((left, right) => left - right)
    if (sizes.length < 3) return []
    const middle = Math.floor(sizes.length / 2)
    const median = sizes.length % 2 === 1 ? sizes[middle] ?? 0 : ((sizes[middle - 1] ?? 0) + (sizes[middle] ?? 0)) / 2
    const largest = sizes.at(-1) ?? 0
    if (median > 0 && largest / median >= 3) return []
    return [{
      code: 'cover-focus',
      severity: 'warning',
      file: page.file,
      page: index + 1,
      message: '封面需要更明确的首读焦点：让一张图片、图表或表格占据至少 25% 画布，或让最大标题达到可见文字中位字号的 3 倍。',
    }]
  })
}

/**
 * A cover carries one message: at most three text boxes (title + subtitle),
 * and no data exhibits. Kicker/footer/page-number boxes count — they belong
 * in notes or on interior pages, which is what keeps cover copy from
 * stacking into the overlapping blob the deck format used to produce.
 */
function coverStructureIssues(project: PptdProject): PptdIssue[] {
  const issues: PptdIssue[] = []
  for (const [index, page] of project.pages.entries()) {
    if (!/^(?:cover|title|opening)$/iu.test(page.pageType?.trim() ?? '')) continue
    const textCount = page.elements.filter((element) => {
      if (asString(element.elementType) !== 'text') return false
      const text = asString(asRecord(element.content)?.text)
      return text !== undefined && plainText(text).trim() !== ''
    }).length
    if (textCount > 3) {
      issues.push({
        code: 'cover-elements',
        severity: 'error',
        file: page.file,
        page: index + 1,
        message: `封面只保留一条主信息：本页有 ${textCount} 个文本元素（上限 3 个）；合并为主标题与副标题，把日期、作者、页码等次要说明移入内页或页面备注。`,
      })
    }
    for (const element of page.elements) {
      const exhibit = asString(element.elementType)
      if (exhibit !== 'table' && exhibit !== 'chart') continue
      issues.push({
        code: 'cover-elements',
        severity: 'error',
        file: page.file,
        page: index + 1,
        ...(typeof element.elementId === 'string' ? { elementId: element.elementId } : {}),
        message: `封面不承载${exhibit === 'table' ? '表格' : '图表'}：把数据内容移到内页，封面只保留一条主信息。`,
      })
    }
  }
  return issues
}

/** Density ceiling: past 40 elements a page stops being readable or fixable. */
function pageDensityIssues(project: PptdProject): PptdIssue[] {
  return project.pages.flatMap((page, index) => page.elements.length > 40
    ? [{
        code: 'page-density',
        severity: 'error',
        file: page.file,
        page: index + 1,
        message: `本页有 ${page.elements.length} 个元素，超过 40 个上限；拆分页面或合并装饰元素。`,
      }]
    : [])
}

function compositionFamily(element: Element): 'text' | 'visual' | 'shape' | undefined {
  const type = asString(element.elementType)
  if (type === 'text' || type === 'icon') return 'text'
  if (type === 'image' || type === 'chart' || type === 'table') return 'visual'
  if (type === 'shape') return 'shape'
  return undefined
}

function layoutSignature(project: PptdProject, page: PptdPage): string {
  const canvasArea = project.width * project.height
  const landmarks = new Set<string>()
  for (const element of page.elements) {
    const family = compositionFamily(element)
    const bounds = asTuple(element.bounds, 4)
    if (family === undefined || bounds === undefined || canvasArea <= 0) continue
    const [x = 0, y = 0, width = 0, height = 0] = bounds
    if (width <= 0 || height <= 0) continue
    const areaShare = width * height / canvasArea
    if (family === 'shape' && (areaShare < 0.01 || areaShare > 0.85)) continue
    const column = Math.max(0, Math.min(3, Math.floor((x + width / 2) / project.width * 4)))
    const row = Math.max(0, Math.min(3, Math.floor((y + height / 2) / project.height * 4)))
    const scale = areaShare >= 0.25 ? 'large' : areaShare >= 0.08 ? 'medium' : 'small'
    landmarks.add(`${family}:${column}:${row}:${scale}`)
  }
  return [...landmarks].sort().join('|')
}

function isCompositionBookend(page: PptdPage): boolean {
  return /^(?:cover|title|opening|section|closing|final)$/iu.test(page.pageType?.trim() ?? '')
}

function layoutRepetitionIssues(project: PptdProject): PptdIssue[] {
  const issues: PptdIssue[] = []
  let runStart = 0
  let runSignature: string | undefined
  const finishRun = (end: number): void => {
    if (runSignature === undefined || end - runStart < 3) return
    const first = project.pages[runStart]
    if (first === undefined) return
    issues.push({
      code: 'layout-repetition',
      severity: 'warning',
      file: first.file,
      page: runStart + 1,
      message: `第 ${runStart + 1}–${end} 页连续使用相同构图轮廓。调整主视觉位置、尺度或内容分组，并重新预览这组页面；固定指标序列可以保留重复。`,
    })
  }
  for (const [index, page] of project.pages.entries()) {
    const signature = isCompositionBookend(page) ? '' : layoutSignature(project, page)
    if (signature === '') {
      finishRun(index)
      runStart = index + 1
      runSignature = undefined
      continue
    }
    if (signature === runSignature) continue
    finishRun(index)
    runStart = index
    runSignature = signature
  }
  finishRun(project.pages.length)
  return issues
}

function compatibilitySummary(project: PptdProject): PptdCheckResult['compatibility'] {
  const summary = { native: 0, normalized: 0, vectorFallback: 0, rasterFallback: 0, unsupported: 0 }
  const recordLevel = (level: string): void => {
    if (level === 'native') summary.native += 1
    else if (level === 'normalized') summary.normalized += 1
    else if (level === 'vector-fallback') summary.vectorFallback += 1
    else if (level === 'raster-fallback') summary.rasterFallback += 1
    else summary.unsupported += 1
  }
  for (const page of project.pages) {
    for (const element of page.elements) {
      const type = asString(element.elementType)
      if (type === 'icon') {
        recordLevel('normalized')
        continue
      }
      if (type === 'shape' && element.shapeName === 'custom') {
        recordLevel('vector-fallback')
        continue
      }
      if (type === 'line' && (asString(element.curve) === 'smooth' || (asString(element.points)?.trim().split(/\s+/u).length ?? 0) > 2)) {
        recordLevel('vector-fallback')
        continue
      }
      if (type === 'image' && asRecord(element.cropShape)?.shapeName === 'custom') {
        recordLevel('raster-fallback')
        continue
      }
      if (type === 'chart') {
        const chartTypes = (Array.isArray(element.series) ? element.series.map(asRecord).filter((item) => item !== undefined) : [])
          .map((item) => asString(item.type)).filter((item) => item !== undefined)
        if (chartTypes.some((item) => UNSUPPORTED_CHART_TYPES.has(item))) {
          recordLevel('unsupported')
          continue
        }
        if (chartTypes.some((item) => !NATIVE_CHART_TYPES.has(item))) {
          recordLevel('unsupported')
          continue
        }
      }
      const fill = asRecord(element.fill)
      const content = asRecord(element.content)
      recordLevel(fill?.type === 'gradient' || fill?.type === 'image' || content?.gradient !== undefined || content?.shadow !== undefined
        || element.shadow !== undefined || element.adjustments !== undefined || element.crop !== undefined || element.cropShape !== undefined
        ? 'normalized'
        : 'native')
    }
  }
  return summary
}

/** Check structure, renderability, and measurable composition signals. */
export function checkPptdProject(project: PptdProject): PptdCheckResult {
  const issues: PptdIssue[] = [...project.parseIssues]
  issues.push(...colorThemeIssues(project, project.theme, project.source.entryName))
  for (const [key, value] of Object.entries(themeMap(project, 'colors'))) {
    const referenceIssue = themeReferenceIssue(project, value, 'colors', project.source.entryName)
    if (referenceIssue !== undefined) issues.push(referenceIssue)
    if (typeof value !== 'string' || (!value.startsWith('$') && !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value))) {
      issues.push({ code: 'invalid-theme', severity: 'error', file: project.source.entryName, message: `theme.colors.${key} 必须是颜色或颜色主题引用。` })
    }
  }
  issues.push(...themeColorChainIssues(project))
  for (const [index, page] of project.pages.entries()) {
    const ids = new Set<string>()
    issues.push(...colorThemeIssues(project, page.background, page.file, index + 1))
    for (const element of page.elements) issues.push(...checkElement(project, page, index + 1, element, ids))
    issues.push(...textLayerIssues(project, page, index + 1), ...typographyIssues(project, page, index + 1))
  }
  issues.push(
    ...coverFocusIssues(project),
    ...coverStructureIssues(project),
    ...coverHookIssues(project),
    ...closingLandingIssues(project),
    ...pageDensityIssues(project),
    ...layoutRepetitionIssues(project),
  )
  const errorCount = issues.filter((item) => item.severity === 'error').length
  const warningCount = issues.filter((item) => item.severity === 'warning').length
  return {
    status: errorCount > 0 ? 'fail' : warningCount > 0 ? 'warning' : 'pass',
    digest: digestOf(project),
    pageCount: project.pages.length,
    nativeObjectCount: project.pages.reduce((sum, page) => sum + page.elements.length, 0),
    warningCount,
    errorCount,
    issues,
    compatibility: compatibilitySummary(project),
  }
}
