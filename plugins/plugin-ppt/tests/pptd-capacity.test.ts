/**
 * The capacity and composition gates: text/table overflow estimation,
 * cover one-message rule, page density and color validity — every rule that
 * refuses an export must produce a located, actionable issue first.
 *
 * @module @dsh-app/plugin-ppt/tests/pptd-capacity
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureTextLayout } from '../src/text-layout.ts'
import { checkPptdProject } from '../src/pptd/check.ts'
import { parsePptdProject } from '../src/pptd/parse.ts'
import { formatValidation, validationReport } from '../src/pptd/report.ts'
import { loadPptdProject } from '../src/pptd/load.ts'
import type { PptdSource } from '../src/pptd/types.ts'

// --- text capacity model -----------------------------------------------------

test('capacity: CJK glyphs count one em each and wrap by line simulation', () => {
  const layout = measureTextLayout({ text: '一二三四五六七', width: 50, height: 11.5, fontSize: 10 })
  assert.equal(layout.availableLineWidth, 47.5)
  assert.equal(layout.lineCount, 2, '7 CJK glyphs at 10pt = 70pt wide, wraps into 2 lines')
  assert.equal(layout.maxLineCount, 1)
  assert.equal(layout.overflow, true)
})

test('capacity: narrow latin glyphs stay on one line inside the same box', () => {
  const layout = measureTextLayout({ text: 'ill.,', width: 50, height: 11.5, fontSize: 10 })
  assert.equal(layout.lineCount, 1)
  assert.equal(layout.overflow, false)
})

test('capacity: multi-line copy exactly filling the box does not overflow', () => {
  const fitting = measureTextLayout({ text: '一\n二', width: 50, height: 23, fontSize: 10 })
  assert.equal(fitting.lineCount, 2)
  assert.equal(fitting.maxLineCount, 2)
  assert.equal(fitting.overflow, false)
  const cramped = measureTextLayout({ text: '一\n二', width: 50, height: 22, fontSize: 10 })
  assert.equal(cramped.maxLineCount, 1)
  assert.equal(cramped.overflow, true)
})

// --- project harness ---------------------------------------------------------

/** Build one on-disk PPTD project from file name → YAML text. */
function projectOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-capacity-test-'))
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const MANIFEST = (pages: string[]): string => [
  'version: v2',
  'title: 容量样例',
  'size: [960, 540]',
  'pages:',
  ...pages.map(page => `  - ${page}`),
].join('\n')

/** One plain text element with explicit bounds and style. */
const TEXT = (id: string, bounds: string, text: string, fontSize = 18): string => [
  `  - elementId: ${id}`,
  '    elementType: text',
  `    bounds: [${bounds}]`,
  '    content:',
  `      text: ${text}`,
  `      fontSize: ${fontSize}`,
].join('\n')

test('capacity: table cells that exceed their row height are errors with a fix list', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: grid',
      '    elementType: table',
      '    bounds: [36, 80, 400, 40]',
      '    columnWidths: [0.5, 0.5]',
      '    rowHeights: [0.5, 0.5]',
      '    rows:',
      '      - [{text: 指标}, {text: 数值}]',
      '      - [{text: 一段远远超过了单元格行高容量的说明文字需要换行}, {text: ok}]',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    const overflow = check.issues.find(issue => issue.code === 'table-cell-overflow')
    assert.ok(overflow !== undefined, 'cell overflow is an error')
    assert.equal(overflow.severity, 'error')
    assert.ok(overflow.message.includes('加宽该列'), `message offers the widen-column fix: ${overflow.message}`)
    assert.equal(check.status, 'fail')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capacity: a cell beyond 120 characters is rejected and asks for a rewrite', async () => {
  const long = '字'.repeat(121)
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: grid',
      '    elementType: table',
      '    bounds: [36, 80, 400, 200]',
      '    columnWidths: [1]',
      '    rowHeights: [1]',
      '    rows:',
      `      - [{text: ${JSON.stringify(long)}}]`,
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    const length = check.issues.find(issue => issue.code === 'table-cell-length')
    assert.ok(length !== undefined, 'oversized cell is an error')
    assert.ok(length.message.includes('121'), 'message names the character count')
    assert.ok(!check.issues.some(issue => issue.code === 'table-cell-overflow'), 'length check supersedes the estimate for the same cell')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capacity: a ragged row fails the grid check as an error', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: grid',
      '    elementType: table',
      '    bounds: [36, 80, 400, 200]',
      '    columnWidths: [0.5, 0.5]',
      '    rowHeights: [0.5, 0.5]',
      '    rows:',
      '      - [{text: a}, {text: b}]',
      '      - [{text: c}]',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    const grid = check.issues.find(issue => issue.code === 'table-data')
    assert.ok(grid !== undefined, 'ragged row is an error')
    assert.equal(grid.severity, 'error')
    assert.ok(grid.message.includes('铺满同一列网格'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capacity: table font sizes below 10pt are flagged as warnings only', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: grid',
      '    elementType: table',
      '    bounds: [36, 80, 400, 200]',
      '    columnWidths: [1]',
      '    rowHeights: [1]',
      '    rows:',
      '      - [{text: 小字, fontSize: 9}]',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    const small = check.issues.find(issue => issue.code === 'font-size')
    assert.ok(small !== undefined, 'small cell font is flagged')
    assert.equal(small.severity, 'warning')
    assert.equal(check.errorCount, 0, 'warnings never block on their own')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capacity: a cover with more than three text elements is refused', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: cover',
      'background: {type: solid, color: "#1C2644"}',
      'elements:',
      TEXT('kicker', '64, 74, 780, 20', '简报 / 战略 / 经营', 11),
      TEXT('headline', '64, 190, 800, 170', '关键决策', 44),
      TEXT('subtitle', '64, 403, 780, 44', '证据与选择', 22),
      TEXT('footer', '48, 506, 760, 16', 'DSH / 示例', 9),
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    const cover = check.issues.find(issue => issue.code === 'cover-elements')
    assert.ok(cover !== undefined, 'cover text count is an error')
    assert.equal(cover.severity, 'error')
    assert.ok(cover.message.includes('封面只保留一条主信息'), cover.message)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capacity: a three-element cover and a data-free cover pass; charts and tables on covers do not', async () => {
  const clean = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: cover',
      'elements:',
      TEXT('kicker', '64, 74, 780, 20', '简报', 11),
      TEXT('headline', '64, 190, 800, 170', '关键决策', 44),
      TEXT('subtitle', '64, 403, 780, 44', '证据与选择', 22),
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(clean))
    assert.ok(!check.issues.some(issue => issue.code === 'cover-elements'), 'three cover texts pass')
  } finally {
    rmSync(clean, { recursive: true, force: true })
  }

  const exhibit = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: cover',
      'elements:',
      '  - elementId: badge',
      '    elementType: chart',
      '    bounds: [400, 100, 200, 200]',
      '    data:',
      '      cols: [类别, 数值]',
      '      rows: [[甲, 1], [乙, 2]]',
      '    series:',
      '      - type: bar',
      '        encode: {x: 类别, y: 数值}',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(exhibit))
    const cover = check.issues.find(issue => issue.code === 'cover-elements')
    assert.ok(cover !== undefined, 'chart on a cover is an error')
    assert.ok(cover.elementId === 'badge')
  } finally {
    rmSync(exhibit, { recursive: true, force: true })
  }
})

test('capacity: pages beyond 40 elements are refused', async () => {
  const shapes: string[] = []
  for (let index = 0; index < 41; index += 1) {
    shapes.push([
      `  - elementId: deco-${index}`,
      '    elementType: shape',
      `    bounds: [${10 + index}, 10, 20, 20]`,
      '    shapeName: rect',
    ].join('\n'))
  }
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': ['pageType: content', 'elements:', ...shapes].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    const density = check.issues.find(issue => issue.code === 'page-density')
    assert.ok(density !== undefined, 'density overage is an error')
    assert.ok(density.message.includes('41'), 'message names the element count')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capacity: invalid color literals are errors, never silent black', () => {
  const source: PptdSource = {
    entryName: 'deck.pptd',
    manifest: MANIFEST(['pages/01.page']),
    pages: new Map([['pages/01.page', [
      'pageType: content',
      'elements:',
      '  - elementId: copy',
      '    elementType: text',
      '    bounds: [36, 20, 300, 30]',
      '    content: {text: 颜色, fontSize: 18, color: red}',
    ].join('\n')]]),
    assets: new Map(),
  }
  const check = checkPptdProject(parsePptdProject(source))
  const color = check.issues.find(issue => issue.code === 'invalid-color')
  assert.ok(color !== undefined, 'invalid literal color is an error')
  assert.equal(color.severity, 'error')
  assert.ok(color.elementId === 'copy')
  assert.equal(check.status, 'fail')
})

test('capacity: manifests beyond 100 pages are refused at parse time', () => {
  const refs = Array.from({ length: 101 }, (_, index) => `  - pages/${String(index + 1).padStart(2, '0')}.page`)
  const source: PptdSource = {
    entryName: 'deck.pptd',
    manifest: ['version: v2', 'title: 超长', 'size: [960, 540]', 'pages:', ...refs].join('\n'),
    pages: new Map(),
    assets: new Map(),
  }
  const project = parsePptdProject(source)
  assert.ok(project.parseIssues.some(issue => issue.code === 'pages' && issue.message.includes('100')))
})

test('capacity: the formatted report names page, element and the fix path', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: tight',
      '    elementType: text',
      '    bounds: [36, 20, 60, 15]',
      '    content: {text: 一段完全放不下的长文案, fontSize: 18}',
    ].join('\n'),
  })
  try {
    const report = validationReport(checkPptdProject(await loadPptdProject(dir)), { projectDirectory: dir, projectPath: '示例工程' })
    assert.equal(report.status, 'needs_revision')
    const text = formatValidation(report)
    assert.ok(text.includes('第 1 页'), 'page number present')
    assert.ok(text.includes('元素 tight'), 'element id present')
    assert.ok(text.includes('缩短文案'), 'fix options present')
    assert.ok(text.includes('pptd_read_file'), 'read hint present')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
