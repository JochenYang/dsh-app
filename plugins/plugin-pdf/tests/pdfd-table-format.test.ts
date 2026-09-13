/**
 * Table presentation: the column format plans, the geometry the renderer draws
 * and the readability rules the checker raises against the same plans.
 *
 * The renderer is asserted two ways. The pure side pins the plans and the
 * table layout directly; the drawn side reads the page content stream back, so
 * "no column verticals", "one medium rule under the header", "one medium rule
 * above the total row", "zebra only past seven detail rows" and "numbers share
 * a right edge" are proven against the bytes, not inferred from the source.
 *
 * @module @dsh-app/plugin-pdf/tests/pdfd-table-format
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDocument, PDFRawStream, PDFRef } from 'pdf-lib'
import { getDocumentProxy } from 'unpdf'
import { checkPdfDocument, loadPdfDocument } from '../src/pdfd/check.ts'
import { approxMeasure, BODY_FONT_SIZE, paperMetrics, TABLE_BORDER_WIDTH, TABLE_HEADER_FONT_DELTA, TABLE_RULE_WIDTH_MEDIUM } from '../src/pdfd/metrics.ts'
import { decimalPlacesOfText, parseNumber, planColumnFormat } from '../src/pdfd/number-format.ts'
import { renderPdfProject } from '../src/pdfd/render.ts'
import { isTotalRowLabel, layoutTable, STRIPE_ROW_THRESHOLD } from '../src/pdfd/table.ts'

/** One stroked segment lifted from a page content stream. */
interface Segment {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly width: number
}

/** One filled path's colour, as a normalized `[r, g, b]`. */
type FillColor = readonly [number, number, number]

/** The stroked segments and filled colours of one page. */
interface PageDrawing {
  readonly segments: readonly Segment[]
  readonly fills: readonly FillColor[]
  /** Colour in force at every text-showing operator (body and header alike). */
  readonly textColors: readonly FillColor[]
  /** Number of `2 Tr` (fill-and-stroke) texts, i.e. faux-bold runs. */
  readonly boldRuns: number
}

/** `#RRGGBB` → a normalized triple, for readable colour assertions. */
function colorHex(value: string): FillColor {
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  ]
}

const STRIPE_COLOR = colorHex('#F8FAFC')
const TOTAL_FILL_COLOR = colorHex('#EEF2FF')
const HEADER_LIGHT_FILL = colorHex('#F1F5F9')
const HEADER_LIGHT_TEXT = colorHex('#0F172A')
const HEADER_DARK_FILL = colorHex('#0F172A')
const HEADER_DARK_TEXT = colorHex('#FFFFFF')

/** The decoded content stream of one page, concatenated when split in parts. */
async function pageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const pdf = await PDFDocument.load(bytes)
  const contents = pdf.getPage(pageIndex).node.Contents()
  let raw = ''
  const visit = (object: unknown): void => {
    if (object instanceof PDFRawStream) {
      const data = object.getContents()
      try {
        raw += inflateSync(data).toString('latin1')
      } catch {
        raw += Buffer.from(data).toString('latin1')
      }
    } else if (object instanceof PDFArray) {
      for (const item of object.asArray()) visit(item)
    } else if (object instanceof PDFRef) {
      visit(pdf.context.lookup(object))
    }
  }
  visit(contents)
  return raw
}

/**
 * Walk the operators of a content stream, keeping the line width and colour in
 * force at every path so a stroked segment or a filled rectangle can be read
 * back with the style it was drawn with. Segments are only collected when the
 * path is *stroked* (`S`): a filled background rectangle is a closed path too,
 * but its edges are not rules. Everything else is skipped, so the walk doubles
 * as a check that nothing unexpected is painted.
 */
function interpret(raw: string): PageDrawing {
  let width = 1
  let fill: FillColor = [0, 0, 0]
  const points: [number, number][] = []
  const segments: Segment[] = []
  const fills: FillColor[] = []
  const textColors: FillColor[] = []
  let boldRuns = 0
  const flush = (stroke: boolean): void => {
    if (stroke) {
      for (let index = 0; index + 1 < points.length; index += 1) {
        const start = points[index]
        const end = points[index + 1]
        if (start === undefined || end === undefined) continue
        if (start[0] === end[0] && start[1] === end[1]) continue
        segments.push({ x1: start[0], y1: start[1], x2: end[0], y2: end[1], width })
      }
    } else {
      fills.push(fill)
    }
    points.length = 0
  }
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/u)
    const operator = parts[parts.length - 1]
    const numbers = parts.slice(0, -1).map(Number)
    switch (operator) {
      case 'w': width = numbers[0] ?? 1; break
      case 'rg': fill = [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0]; break
      case 'Tr': if (numbers[0] === 2) boldRuns += 1; break
      case 'Tj': textColors.push(fill); break
      case 'm': points.push([numbers[0] ?? 0, numbers[1] ?? 0]); break
      case 'l': points.push([numbers[0] ?? 0, numbers[1] ?? 0]); break
      case 'S': flush(true); break
      case 'f': flush(false); break
      default: break
    }
  }
  return { segments, fills, textColors, boldRuns }
}

/** Horizontal stroked segments only (a vertical one would be a column rule). */
function horizontals(drawing: PageDrawing): Segment[] {
  return drawing.segments.filter(segment => segment.y1 === segment.y2)
}

/** Vertical stroked segments (must never exist inside a table). */
function verticals(drawing: PageDrawing): Segment[] {
  return drawing.segments.filter(segment => segment.x1 === segment.x2 && segment.y1 !== segment.y2)
}

/** Whether a filled colour matches, within one 8-bit step. */
function isColor(actual: FillColor, expected: FillColor): boolean {
  return actual.every((channel, index) => Math.abs(channel - (expected[index] ?? 0)) < 1 / 255)
}

/** Render a project and read the first page's drawing back. */
async function drawFirstPage(project: unknown): Promise<PageDrawing> {
  const { project: parsed } = loadPdfDocument(project)
  const { bytes } = await renderPdfProject(parsed)
  return interpret(await pageContent(bytes, 0))
}

/** One rendered text line reconstructed from PDF.js text items. */
interface RenderedLine {
  readonly y: number
  readonly x: number
  readonly right: number
  readonly text: string
}

/** Group a page's text items into visual lines by baseline, top to bottom. */
async function pageLines(bytes: Uint8Array): Promise<RenderedLine[]> {
  const document = await getDocumentProxy(bytes, { verbosity: 0 })
  try {
    const page = await document.getPage(1)
    const content = await page.getTextContent()
    const groups = new Map<number, { x: number, right: number, text: string[] }>()
    for (const item of content.items) {
      if (!('str' in item) || item.str === '') continue
      const x = Number(item.transform[4])
      const y = Math.round(Number(item.transform[5]) * 10) / 10
      const group = groups.get(y) ?? { x: Number.POSITIVE_INFINITY, right: 0, text: [] }
      group.x = Math.min(group.x, x)
      group.right = Math.max(group.right, x + item.width)
      group.text.push(item.str)
      groups.set(y, group)
    }
    return [...groups.entries()]
      .map(([y, group]) => ({ y, x: group.x, right: group.right, text: group.text.join('') }))
      .sort((left, right) => right.y - left.y)
  } finally {
    await document.destroy().catch(() => undefined)
  }
}

test('format: a numeric column fixes one precision and groups thousands', () => {
  const plan = planColumnFormat(['1280', '1050.5'], '金额')
  assert.equal(plan.kind, 'number')
  assert.equal(plan.align, 'right')
  assert.equal(plan.numeric, true)
  assert.equal(plan.render('1280'), '1,280.0')
  assert.equal(plan.render('1050.5'), '1,050.5')
  assert.equal(plan.render('0'), '-', 'zero reads as a dash')
  assert.equal(plan.render('-2500'), '(2,500.0)', 'a negative keeps its sign through parentheses')
})

test('format: a ratio column renders one decimal percent', () => {
  const plan = planColumnFormat(['0.128', '0.05'], '增长率')
  assert.equal(plan.kind, 'percent')
  assert.equal(plan.align, 'right')
  assert.equal(plan.render('0.128'), '12.8%')
  assert.equal(plan.render('0.05'), '5.0%')
})

test('format: date columns normalize to YYYY-MM-DD and mixed columns stay as authored', () => {
  const slash = planColumnFormat(['2024/1/5', '2024/12/31'], '日期')
  assert.equal(slash.kind, 'date')
  assert.equal(slash.render('2024/1/5'), '2024-01-05')
  const cjk = planColumnFormat(['2024年2月29日', '2023年3月1日'], '日期')
  assert.equal(cjk.render('2024年2月29日'), '2024-02-29')
  // A column with one unparseable value is left exactly as authored.
  const mixed = planColumnFormat(['1,280 万', '34.5%'], '本期')
  assert.equal(mixed.kind, 'text')
  assert.equal(mixed.align, 'left')
  assert.equal(mixed.render('1,280 万'), '1,280 万')
  // A ratio written as a percentage keeps its one-decimal percent shape.
  const alreadyPercent = planColumnFormat(['12.8%', '5.0%'], '同比增长率')
  assert.equal(alreadyPercent.render('12.8%'), '12.8%')
})

test('format: decimal places come from the raw text and the shared helpers agree', () => {
  assert.equal(decimalPlacesOfText('1,280.50'), 2)
  assert.equal(decimalPlacesOfText('12.8%'), 1)
  assert.equal(parseNumber('1,280'), 1280)
  assert.equal(parseNumber('1,280 万'), undefined)
  assert.equal(parseNumber('34.5%'), undefined)
})

test('layout: column width is measured against the formatted text, not the raw value', () => {
  const measured: string[] = []
  const measure = (text: string): number => {
    measured.push(text)
    return approxMeasure(BODY_FONT_SIZE)(text)
  }
  const layout = layoutTable(
    { headers: ['项目', '金额'], rows: [['甲', '123456789'], ['乙', '987654321']] },
    { availableWidth: 481.9, measure, headerMeasure: approxMeasure(BODY_FONT_SIZE + TABLE_HEADER_FONT_DELTA) },
  )
  assert.ok(measured.includes('123,456,789'), 'the formatted number is what gets measured')
  assert.deepEqual(layout.columnAlign, ['left', 'right'])
  assert.equal(layout.columnFormats[1]?.numeric, true)
  assert.equal(layout.rows[0]?.lines[1]?.[0], '123,456,789', 'the formatted number stays on one line')
  assert.equal(layout.rows[0]?.lines[1]?.length, 1)
  assert.equal(layout.rows[1]?.lines[1]?.[0], '987,654,321')
})

test('layout: a total row is recognized by its first column and only marks the row', () => {
  const table = {
    headers: ['项目', '金额'],
    rows: [['甲', '1'], ['合计', '3']],
  }
  const layout = layoutTable(table, { availableWidth: 400, measure: approxMeasure(BODY_FONT_SIZE) })
  assert.equal(layout.rows[0]?.isTotal, false)
  assert.equal(layout.rows[1]?.isTotal, true)
  assert.equal(isTotalRowLabel('total.'), false)
  for (const label of ['合计', '总计', '小计', '汇总', 'Total', 'subtotal', 'SUM']) {
    assert.equal(isTotalRowLabel(label), true, `${label} must be a total row`)
  }
})

test('render: a table draws no column verticals and only horizontal rules', async () => {
  const drawing = await drawFirstPage({
    title: '极简表格',
    blocks: [{
      table: {
        headers: ['项目', '金额'],
        rows: [['甲', '1280'], ['乙', '1050'], ['丙', '980'], ['合计', '3310']],
      },
    }],
  })
  assert.equal(verticals(drawing).length, 0, 'no column vertical or outer frame is ever drawn')
  const rules = horizontals(drawing)
  // One 0.8 pt title rule plus the table's rules.
  const tableRules = rules.filter(segment => segment.width <= TABLE_RULE_WIDTH_MEDIUM)
  const medium = tableRules.filter(segment => segment.width === TABLE_RULE_WIDTH_MEDIUM)
  const thin = tableRules.filter(segment => segment.width === TABLE_BORDER_WIDTH)
  assert.equal(medium.length, 2, 'the header bottom and the total top are both medium')
  assert.equal(thin.length, 2, 'one hairline per detail row boundary, minus the one before the total')
  const [top, bottom] = [...medium].sort((left, right) => right.y1 - left.y1)
  assert.ok(top !== undefined && bottom !== undefined)
  for (const hairline of thin) {
    assert.ok(hairline.y1 < top.y1 && hairline.y1 > bottom.y1, `hairline ${hairline.y1} sits between the two medium rules`)
  }
})

test('render: the header defaults to the light band and style.header dark inverts it', async () => {
  // Default: the same light band the Word, PPT and Excel suites draw.
  const light = await drawFirstPage({
    title: '浅色表头',
    blocks: [{ table: { headers: ['项目', '金额'], rows: [['甲', '1280'], ['乙', '1050']] } }],
  })
  assert.ok(light.fills.some(fill => isColor(fill, HEADER_LIGHT_FILL)), 'the default header fill is F1F5F9')
  assert.ok(light.textColors.some(color => isColor(color, HEADER_LIGHT_TEXT)), 'the default header text is 0F172A')
  assert.ok(!light.fills.some(fill => isColor(fill, HEADER_DARK_FILL)), 'no dark band is drawn by default')

  // Opt-in inverse band, so the dark look survives as an explicit choice.
  const dark = await drawFirstPage({
    title: '深色表头',
    style: { header: 'dark' },
    blocks: [{ table: { headers: ['项目', '金额'], rows: [['甲', '1280'], ['乙', '1050']] } }],
  })
  assert.ok(dark.fills.some(fill => isColor(fill, HEADER_DARK_FILL)), 'style.header dark fills the band with 0F172A')
  assert.ok(dark.textColors.some(color => isColor(color, HEADER_DARK_TEXT)), 'the dark band uses white text')
  assert.ok(!dark.fills.some(fill => isColor(fill, HEADER_LIGHT_FILL)), 'the light band is not drawn in dark mode')
})

test('render: zebra striping starts past seven detail rows and never bands a two-row table', async () => {
  assert.equal(STRIPE_ROW_THRESHOLD, 7)
  const short = await drawFirstPage({
    title: '两行表',
    blocks: [{ table: { headers: ['项目', '金额'], rows: [['甲', '1'], ['乙', '2']] } }],
  })
  assert.equal(short.fills.filter(fill => isColor(fill, STRIPE_COLOR)).length, 0, 'a two-row table stays unbanded')

  const long = await drawFirstPage({
    title: '长表',
    blocks: [{
      table: {
        headers: ['项目', '金额'],
        rows: Array.from({ length: 9 }, (_value, index) => [`行${String(index)}`, String(1000 + index)]),
      },
    }],
  })
  assert.ok(long.fills.some(fill => isColor(fill, STRIPE_COLOR)), 'a long table bands its detail rows')
})

test('render: a total row is bold and filled, and still extracts its text once', async () => {
  const { project } = loadPdfDocument({
    title: '合计行',
    blocks: [{
      table: {
        headers: ['项目', '金额'],
        rows: [['甲', '1280'], ['合计', '1280']],
      },
    }],
  })
  const { bytes } = await renderPdfProject(project)
  const drawing = interpret(await pageContent(bytes, 0))
  assert.ok(drawing.boldRuns >= 2, `the total row's cells are faux-bold, got ${String(drawing.boldRuns)}`)
  assert.ok(drawing.fills.some(fill => isColor(fill, TOTAL_FILL_COLOR)), 'the total row carries its own fill')
  // Fill-and-stroke thickens the glyphs, so the reader must not see the label twice.
  const lines = await pageLines(bytes)
  const totalLine = lines.find(line => line.text.includes('合计'))
  assert.ok(totalLine !== undefined, lines.map(line => line.text).join('|'))
  assert.ok(!totalLine.text.includes('合计合计'), `total label duplicated: ${totalLine.text}`)
})

test('render: numeric columns share one right edge and formatted values read back intact', async () => {
  const { project } = loadPdfDocument({
    title: '数字对齐',
    blocks: [{
      table: {
        headers: ['项目', '金额'],
        rows: [['甲', '1280'], ['乙', '1050.5'], ['丙', '0'], ['丁', '987654321']],
      },
    }],
  })
  const { bytes } = await renderPdfProject(project)
  const metrics = paperMetrics(project.size)
  const contentRight = metrics.margin + metrics.contentWidth
  const lines = await pageLines(bytes)
  const dataLines = lines.filter(line => /^[甲乙丙丁]/u.test(line.text))
  assert.equal(dataLines.length, 4, `expected four data rows, got ${dataLines.length}`)
  for (const line of dataLines) {
    assert.ok(line.right <= contentRight + 1, `row right edge ${line.right} stays inside ${contentRight}`)
  }
  // The rightmost column is the numeric one, so each row's right edge is that
  // column's right edge — all four must land within one point of each other.
  const rights = dataLines.map(line => line.right)
  assert.ok(Math.max(...rights) - Math.min(...rights) <= 1, `right edges differ: ${rights.join(',')}`)
  // The header follows its column's alignment, so the numeric header shares the
  // same right edge as the values below it.
  const headerLine = lines.find(line => line.text.includes('金额'))
  assert.ok(headerLine !== undefined, `header line missing: ${lines.map(line => line.text).join('|')}`)
  assert.ok(Math.abs(headerLine.right - (rights[0] ?? 0)) <= 1, `header right ${headerLine.right} differs from ${String(rights[0])}`)
  assert.ok(lines.some(line => line.text.includes('1,280.0')), `formatted value missing: ${lines.map(line => line.text).join('|')}`)
  assert.ok(lines.some(line => line.text.includes('1,050.5')), 'formatted decimals missing')
  assert.ok(lines.some(line => line.text.includes('987,654,321')), 'the widest formatted value is intact')
})

test('check: decimal consistency, ratio format and missing unit are reported with a column location', () => {
  const mismatch = checkPdfDocument({
    title: '小数位',
    blocks: [{ table: { headers: ['项目', '金额（元）'], rows: [['甲', '1280'], ['乙', '1050.5']] } }],
  })
  const warning = mismatch.issues.find(issue => issue.code === 'decimal-mismatch')
  assert.ok(warning !== undefined, mismatch.issues.map(issue => issue.code).join(','))
  assert.equal(warning.severity, 'warning')
  assert.equal(warning.block, 1)
  assert.equal(warning.field, 'table.columns[1]')

  const threeShapes = checkPdfDocument({
    title: '小数位',
    blocks: [{ table: { headers: ['项目', '金额（元）'], rows: [['甲', '1.5'], ['乙', '1.25'], ['丙', '1.125']] } }],
  })
  const error = threeShapes.issues.find(issue => issue.code === 'decimal-mismatch')
  assert.ok(error !== undefined)
  assert.equal(error.severity, 'error')
  assert.equal(threeShapes.status, 'fail')

  const ratio = checkPdfDocument({
    title: '比率列',
    blocks: [{ table: { headers: ['项目', '增长率'], rows: [['甲', '0.128'], ['乙', '0.05']] } }],
  })
  assert.ok(ratio.issues.some(issue => issue.code === 'percent-column-format'), ratio.issues.map(issue => issue.code).join(','))

  const unitless = checkPdfDocument({
    title: '营收表',
    blocks: [{ table: { headers: ['项目', '金额'], rows: [['甲', '12000'], ['乙', '18000']] } }],
  })
  assert.ok(unitless.issues.some(issue => issue.code === 'missing-unit'), unitless.issues.map(issue => issue.code).join(','))

  // A declared unit silences the warning, and consistent precision stays clean.
  const clean = checkPdfDocument({
    title: '营收表（万元）',
    blocks: [{ table: { headers: ['项目', '金额'], rows: [['甲', '1,280.0'], ['乙', '1,050.5']] } }],
  })
  assert.equal(clean.status, 'pass', clean.issues.map(issue => issue.code).join(','))
})

test('check: a ratio column written as a percentage raises no ratio warning', () => {
  const result = checkPdfDocument({
    title: '比率列',
    blocks: [{ table: { headers: ['项目', '增长率'], rows: [['甲', '12.8%'], ['乙', '5.0%']] } }],
  })
  assert.ok(!result.issues.some(issue => issue.code === 'percent-column-format'), result.issues.map(issue => issue.code).join(','))
})
