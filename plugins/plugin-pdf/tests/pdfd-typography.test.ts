/**
 * Chinese body typography on the render side: the first-line indent, basic
 * two-end justification and the 禁则 line-break prohibitions.
 *
 * The line planner is a pure function, so its geometry is asserted directly;
 * the rendered bytes are then read back through PDF.js so the indent, the
 * stretch and every line head/tail are also checked as a reader sees them.
 *
 * @module @dsh-app/plugin-pdf/tests/pdfd-typography
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDocumentProxy } from 'unpdf'
import { loadPdfDocument } from '../src/pdfd/check.ts'
import { planLine, stretchableGaps } from '../src/pdfd/justify.ts'
import {
  approxMeasure,
  BODY_FIRST_LINE_INDENT,
  BODY_FONT_SIZE,
  isWideChar,
  NO_LINE_END,
  NO_LINE_START,
  paperMetrics,
  wrapText,
} from '../src/pdfd/metrics.ts'
import { renderPdfProject } from '../src/pdfd/render.ts'

/** One rendered text line reconstructed from PDF.js text items. */
interface RenderedLine {
  readonly y: number
  readonly x: number
  /** Right edge of the line's last glyph, in points. */
  readonly right: number
  readonly text: string
}

/** Group each page's text items into visual lines by baseline, top to bottom. */
async function pageLines(bytes: Uint8Array): Promise<RenderedLine[][]> {
  const document = await getDocumentProxy(bytes, { verbosity: 0 })
  try {
    const pages: RenderedLine[][] = []
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number)
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
      pages.push([...groups.entries()]
        .map(([y, group]) => ({ y, x: group.x, right: group.right, text: group.text.join('') }))
        .sort((left, right) => right.y - left.y))
    }
    return pages
  } finally {
    await document.destroy().catch(() => undefined)
  }
}

/** Whitespace-insensitive containment: wrapped lines join without spaces. */
function compact(text: string): string {
  return text.replace(/\s+/gu, '')
}

/** The document's text with page footers removed, in page order. */
function bodyText(pages: readonly (readonly RenderedLine[])[]): string {
  return compact(pages
    .flat()
    .filter(line => !/^第\d+页/u.test(compact(line.text)))
    .map(line => line.text)
    .join('\n'))
}

test('wrap: a closing mark never opens a line', () => {
  const measure = approxMeasure(BODY_FONT_SIZE)
  const width = measure('甲'.repeat(5))
  const text = '甲'.repeat(5) + '，' + '乙'.repeat(5)
  const lines = wrapText(text, width, measure)
  assert.ok(lines.length >= 2, `expected a break: ${lines.join('|')}`)
  assert.ok(lines[0]?.endsWith('，') === true, `mark pulled back: ${lines.join('|')}`)
  for (const line of lines) assert.ok(!NO_LINE_START.has(line[0] ?? ''), `line opens with a forbidden mark: ${line}`)
  assert.equal(lines.join(''), text, 'no character is lost')
})

test('wrap: an opening mark never ends a line', () => {
  const measure = approxMeasure(BODY_FONT_SIZE)
  const width = measure('甲'.repeat(5))
  const text = '甲'.repeat(4) + '（' + '乙'.repeat(6)
  const lines = wrapText(text, width, measure)
  assert.ok(lines.length >= 2, `expected a break: ${lines.join('|')}`)
  for (const line of lines) assert.ok(!NO_LINE_END.has(line.slice(-1)), `line closes with an opening mark: ${line}`)
  assert.ok(lines[1]?.startsWith('（') === true, `mark moved to the next head: ${lines.join('|')}`)
  assert.equal(lines.join(''), text, 'no character is lost')
})

test('wrap: only the first line of a paragraph takes the indent', () => {
  const measure = approxMeasure(BODY_FONT_SIZE)
  const width = measure('甲'.repeat(10))
  const lines = wrapText('甲'.repeat(20), width, measure, { firstLineIndent: BODY_FIRST_LINE_INDENT })
  assert.equal(lines.length, 3, `expected 8+10+2 characters: ${lines.map(line => line.length).join('+')}`)
  assert.equal(lines.join(''), '甲'.repeat(20))
  assert.ok(Math.abs(measure(lines[0] ?? '') - (width - BODY_FIRST_LINE_INDENT)) < 1e-9, 'first line is two characters short')
  assert.equal(measure(lines[1] ?? ''), width, 'later lines use the full width')
})

test('justify: a stretched line closes exactly on the content edge', () => {
  const measure = approxMeasure(BODY_FONT_SIZE)
  const text = '甲'.repeat(20)
  const x = 56.7
  const availableWidth = measure(text) + 17
  const plan = planLine(text, { x, availableWidth, size: BODY_FONT_SIZE, measure, justify: true })
  assert.equal(plan.justified, true)
  assert.equal(stretchableGaps(text), 19)
  const last = plan.runs[plan.runs.length - 1]
  assert.ok(last !== undefined)
  assert.ok(Math.abs(last.x + last.width - (x + availableWidth)) < 1e-9, 'the stretch closes the line exactly')
})

test('justify: gaps open only between two wide characters', () => {
  const measure = approxMeasure(BODY_FONT_SIZE)
  const text = '这是测试word混排的内容'
  const availableWidth = measure(text) + 3.2
  const plan = planLine(text, { x: 0, availableWidth, size: BODY_FONT_SIZE, measure, justify: true })
  assert.equal(plan.justified, true)
  assert.equal(plan.runs.map(run => run.text).join(''), text, 'runs preserve every character')
  for (let index = 0; index + 1 < plan.runs.length; index += 1) {
    const before = plan.runs[index]?.text.slice(-1) ?? ''
    const after = plan.runs[index + 1]?.text.slice(0, 1) ?? ''
    assert.ok(isWideChar(before) && isWideChar(after), `a gap opened outside a wide pair: ${before}|${after}`)
  }
  assert.ok(plan.runs.some(run => run.text.includes('word')), 'the Latin word stays inside one run')
})

test('justify: a degenerate line falls back to left alignment', () => {
  const measure = approxMeasure(BODY_FONT_SIZE)
  const options = { x: 0, availableWidth: 200, size: BODY_FONT_SIZE, measure, justify: true }
  assert.equal(planLine('甲', options).justified, false, 'a single character is never stretched')
  assert.equal(planLine('latin', options).justified, false, 'no wide pair, no gap')
  assert.equal(planLine('甲乙', options).justified, false, 'a sparse line is not stretched')
  assert.equal(planLine('甲乙丙', { ...options, justify: false }).justified, false, 'the last line keeps left alignment')
})

test('render: the first body line is indented and a page continuation is not', async () => {
  const paragraph = '起始标记' + '缩进续行测试'.repeat(400)
  const { project } = loadPdfDocument({
    title: '缩进与续行',
    blocks: [{ heading: { level: 1, text: '正文缩进' } }, { paragraph: { text: paragraph } }],
  })
  const { bytes } = await renderPdfProject(project)
  const metrics = paperMetrics(project.size)
  const pages = await pageLines(bytes)
  assert.ok(pages.length >= 2, `the paragraph must paginate, got ${pages.length} page(s)`)

  const isProse = (line: RenderedLine): boolean =>
    line.text.startsWith('起始标记') || /^[缩进续行测试]+$/u.test(line.text)
  const firstPage = pages[0]?.filter(isProse) ?? []
  assert.ok(firstPage.length >= 2, `expected the paragraph's first lines, got ${firstPage.length}`)
  assert.ok(
    Math.abs((firstPage[0]?.x ?? 0) - (metrics.margin + BODY_FIRST_LINE_INDENT)) < 0.05,
    `first line starts at the indent: x=${String(firstPage[0]?.x)}`,
  )
  for (const line of firstPage.slice(1)) {
    assert.ok(Math.abs(line.x - metrics.margin) < 0.05, `continuation sits at the margin: x=${line.x}`)
  }

  const continued = pages[1]?.[0]
  assert.ok(continued !== undefined && isProse(continued), 'page two opens with the paragraph continuation')
  assert.ok(
    Math.abs(continued.x - metrics.margin) < 0.05,
    `a page continuation is not re-indented: x=${continued.x}`,
  )

  const readBack = bodyText(pages)
  assert.ok(readBack.includes(compact(paragraph)), 'the paragraph survives pagination in full')
})

test('render: justified prose closes on the content edge', async () => {
  const paragraph = '排版规范测试内容'.repeat(24)
  const { project } = loadPdfDocument({
    title: '两端对齐',
    blocks: [{ paragraph: { text: paragraph } }],
  })
  const { bytes } = await renderPdfProject(project)
  const metrics = paperMetrics(project.size)
  const rightEdge = metrics.margin + metrics.contentWidth
  const pages = await pageLines(bytes)
  const prose = pages.flat().filter(line => /^[排版规范测试内容]+$/u.test(line.text))
  assert.ok(prose.length >= 3, `expected a wrapped paragraph, got ${prose.length} line(s)`)
  for (const line of prose.slice(0, -1)) {
    assert.ok(Math.abs(line.right - rightEdge) <= 1, `justified line ends at ${line.right}, edge ${rightEdge}`)
  }
})

test('render: prose, a list, a table and a page break keep every 禁则 line legal', async () => {
  const paragraph = '排版，规范。测试、内容；注释：结束！括号（示例）与引号“引用”’。'.repeat(14)
  const { project } = loadPdfDocument({
    title: '禁则核对',
    author: '排版组',
    blocks: [
      { heading: { level: 1, text: '核心结论' } },
      { paragraph: { text: paragraph } },
      { bullets: ['列表，项一。', '列表（项二）。'] },
      { table: { headers: ['指标', '说明'], rows: [['营收', '同比增长，达标。'], ['毛利', '提升（三点）个百分点。']] } },
      { pageBreak: true },
      { paragraph: { text: '第二页，正文。' } },
    ],
  })
  const { bytes } = await renderPdfProject(project)
  const pages = await pageLines(bytes)
  assert.ok(pages.length >= 2, `expected pagination, got ${pages.length} page(s)`)

  for (const line of pages.flat()) {
    if (line.text === '') continue
    assert.ok(!NO_LINE_START.has(line.text[0] ?? ''), `line opens with a forbidden mark: ${line.text}`)
    assert.ok(!NO_LINE_END.has(line.text.slice(-1)), `line closes with a forbidden mark: ${line.text}`)
  }

  const body = bodyText(pages)
  for (const fragment of [
    paragraph,
    '列表，项一。',
    '列表（项二）。',
    '营收',
    '同比增长，达标。',
    '毛利',
    '提升（三点）个百分点。',
    '第二页，正文。',
  ]) {
    assert.ok(body.includes(compact(fragment)), `missing ${fragment} in the read-back text`)
  }
})
