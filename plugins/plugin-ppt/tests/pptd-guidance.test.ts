/**
 * Content-carrying and typography guidance: the new advisory signals must
 * fire on the defect they describe and stay silent on a clean page. Every
 * case asserts the hit's location and its non-blocking severity, then the
 * matching miss on a project that differs only in the judged property.
 *
 * @module @dsh-app/plugin-ppt/tests/pptd-guidance
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPptdProject } from '../src/pptd/check.ts'
import { loadPptdProject } from '../src/pptd/load.ts'
import type { PptdIssue } from '../src/pptd/types.ts'

/** Build one on-disk PPTD project from file name → YAML text. */
function projectOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-guidance-test-'))
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const MANIFEST = (pages: string[]): string => [
  'version: v2',
  'title: 承载与层级样例',
  'size: [960, 540]',
  'pages:',
  ...pages.map(page => `  - ${page}`),
].join('\n')

async function checkOf(files: Record<string, string>) {
  const dir = projectOf(files)
  try {
    return checkPptdProject(await loadPptdProject(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const findIssue = (issues: readonly PptdIssue[], code: string, elementId?: string): PptdIssue | undefined =>
  issues.find(issue => issue.code === code && (elementId === undefined || issue.elementId === elementId))

test('guidance: a pie past six slices and a time series on bar are flagged, column stays quiet', async () => {
  const hit = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: pie-many',
      '    elementType: chart',
      '    bounds: [48, 60, 400, 260]',
      '    chart: pie',
      '    labels: [研发, 销售, 市场, 运营, 客服, 财务, 行政, 法务]',
      '    series:',
      '      - {name: 占比, values: [10, 20, 30, 10, 10, 10, 5, 5]}',
      '  - elementId: bar-time',
      '    elementType: chart',
      '    bounds: [480, 60, 400, 260]',
      '    chart: bar',
      '    labels: ["2023", "2024", "2025"]',
      '    series:',
      '      - {name: 营收, values: [10, 20, 30]}',
    ].join('\n'),
  })
  const crowdedPie = findIssue(hit.issues, 'chart-kind-mismatch', 'pie-many')
  assert.ok(crowdedPie !== undefined, 'a pie with eight slices is flagged')
  assert.equal(crowdedPie.severity, 'warning')
  assert.equal(crowdedPie.page, 1)
  const timeBar = findIssue(hit.issues, 'chart-kind-mismatch', 'bar-time')
  assert.ok(timeBar !== undefined, 'time labels on a bar are flagged')
  assert.equal(timeBar.severity, 'warning')

  const miss = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: column-clean',
      '    elementType: chart',
      '    bounds: [64, 96, 560, 320]',
      '    chart: column',
      '    labels: [研发, 销售, 市场]',
      '    series:',
      '      - {name: 本期, values: [10, 20, 30]}',
      '      - {name: 上期, values: [8, 18, 27]}',
    ].join('\n'),
  })
  assert.equal(findIssue(miss.issues, 'chart-kind-mismatch'), undefined, 'a category column chart is not flagged')
  assert.equal(findIssue(miss.issues, 'too-few-series-for-chart'), undefined)
})

test('guidance: a single series with two or three points is steered to text, a second series is not', async () => {
  const hit = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: tiny',
      '    elementType: chart',
      '    bounds: [64, 96, 400, 220]',
      '    chart: column',
      '    labels: [华东, 华南, 华北]',
      '    series:',
      '      - {name: 营收, values: [10, 20, 30]}',
    ].join('\n'),
  })
  const tiny = findIssue(hit.issues, 'too-few-series-for-chart', 'tiny')
  assert.ok(tiny !== undefined, 'one series with three points is flagged')
  assert.equal(tiny.severity, 'warning')
  assert.ok(tiny.message.includes('KPI'), 'the message points at a KPI card')

  const miss = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: pair',
      '    elementType: chart',
      '    bounds: [64, 96, 400, 220]',
      '    chart: column',
      '    labels: [华东, 华南, 华北]',
      '    series:',
      '      - {name: 本期, values: [10, 20, 30]}',
      '      - {name: 上期, values: [8, 18, 27]}',
    ].join('\n'),
  })
  assert.equal(findIssue(miss.issues, 'too-few-series-for-chart'), undefined)
})

test('guidance: body copy drifting past 15% in size is flagged, a uniform body is not', async () => {
  const hit = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: body-a',
      '    elementType: text',
      '    bounds: [48, 80, 520, 90]',
      '    content: {text: 本页第一条正文用于检查同层字号的偏差是否超过阈值。, fontSize: 20, color: "#111111"}',
      '  - elementId: body-b',
      '    elementType: text',
      '    bounds: [48, 220, 520, 90]',
      '    content: {text: 第二条正文的长度也超过十二个字符以便纳入正文级。, fontSize: 16, color: "#111111"}',
    ].join('\n'),
  })
  const off = findIssue(hit.issues, 'font-scale-off', 'body-b')
  assert.ok(off !== undefined, 'a 25% body-size spread is flagged')
  assert.equal(off.severity, 'warning')
  assert.equal(off.page, 1)

  const miss = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: body-a',
      '    elementType: text',
      '    bounds: [48, 80, 520, 90]',
      '    content: {text: 本页第一条正文用于检查同层字号的偏差是否超过阈值。, fontSize: 18, color: "#111111"}',
      '  - elementId: body-b',
      '    elementType: text',
      '    bounds: [48, 220, 520, 90]',
      '    content: {text: 第二条正文的长度也超过十二个字符以便纳入正文级。, fontSize: 18, color: "#111111"}',
    ].join('\n'),
  })
  assert.equal(findIssue(miss.issues, 'font-scale-off'), undefined, 'uniform body sizes stay quiet')
})

test('guidance: reading copy below 0.65x the body size is flagged unless it sits in the footer band', async () => {
  const hit = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: body-a',
      '    elementType: text',
      '    bounds: [48, 80, 520, 100]',
      '    content: {text: 本页正文段落用于建立本页的字号基准并保持最长。, fontSize: 20, color: "#111111"}',
      '  - elementId: too-small',
      '    elementType: text',
      '    bounds: [48, 260, 520, 60]',
      '    content: {text: 小号正文文字长度也超过了十二个字符限制。, fontSize: 9, color: "#333333"}',
    ].join('\n'),
  })
  const undersized = hit.issues.find(issue => issue.code === 'font-scale-off' && issue.message.includes('0.65'))
  assert.ok(undersized !== undefined, 'reading copy at 0.45x the body size is flagged')
  assert.equal(undersized.severity, 'warning')

  const miss = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: body-a',
      '    elementType: text',
      '    bounds: [48, 80, 520, 100]',
      '    content: {text: 本页正文段落用于建立本页的字号基准并保持最长。, fontSize: 20, color: "#111111"}',
      '  - elementId: footer',
      '    elementType: text',
      '    bounds: [48, 502, 520, 20]',
      '    content: {text: 内部资料 · 示例数据, fontSize: 9, color: "#666666"}',
    ].join('\n'),
  })
  assert.equal(findIssue(miss.issues, 'font-scale-off'), undefined, 'footer-band text is exempt')
})

test('guidance: left edges 2-8pt apart are alignment drift, a wide split is not', async () => {
  const hit = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: col-left',
      '    elementType: text',
      '    bounds: [48, 80, 400, 120]',
      '    content: {text: 第一段正文用作左边界对照并且长度足够。, fontSize: 18, color: "#111111"}',
      '  - elementId: col-drifting',
      '    elementType: text',
      '    bounds: [53, 240, 400, 120]',
      '    content: {text: 第二段正文的左边界漂移了几个点，长度足够。, fontSize: 18, color: "#111111"}',
    ].join('\n'),
  })
  const drift = findIssue(hit.issues, 'column-drift', 'col-drifting')
  assert.ok(drift !== undefined, 'a 5pt left-edge difference is drift')
  assert.equal(drift.severity, 'warning')
  assert.equal(drift.page, 1)

  const miss = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: col-left',
      '    elementType: text',
      '    bounds: [48, 80, 380, 120]',
      '    content: {text: 左侧分栏正文用作对齐基准且长度足够。, fontSize: 18, color: "#111111"}',
      '  - elementId: col-right',
      '    elementType: text',
      '    bounds: [480, 80, 380, 120]',
      '    content: {text: 右侧分栏正文明显分开属于有意分栏。, fontSize: 18, color: "#111111"}',
    ].join('\n'),
  })
  assert.equal(findIssue(miss.issues, 'column-drift'), undefined, 'a wide gap reads as a column split')
})

test('guidance: a bare cover and a thank-you closing are flagged, added visuals and a real conclusion are not', async () => {
  const hit = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page', 'pages/02.page']),
    'pages/01.page': [
      'pageType: cover',
      'elements:',
      '  - elementId: title',
      '    elementType: text',
      '    bounds: [48, 120, 700, 120]',
      '    content: {text: 季度复盘, fontSize: 44, bold: true, color: "#111111"}',
      '  - elementId: subtitle',
      '    elementType: text',
      '    bounds: [48, 280, 700, 60]',
      '    content: {text: 增长组内部评审材料, fontSize: 20, color: "#333333"}',
    ].join('\n'),
    'pages/02.page': [
      'pageType: closing',
      'elements:',
      '  - elementId: thanks',
      '    elementType: text',
      '    bounds: [48, 220, 700, 80]',
      '    content: {text: 谢谢观看, fontSize: 40, bold: true, color: "#111111"}',
    ].join('\n'),
  })
  const cover = findIssue(hit.issues, 'weak-cover')
  assert.ok(cover !== undefined, 'a title+subtitle-only cover is flagged')
  assert.equal(cover.severity, 'warning')
  assert.equal(cover.page, 1)
  const closing = findIssue(hit.issues, 'weak-closing')
  assert.ok(closing !== undefined, 'a thank-you closing is flagged')
  assert.equal(closing.severity, 'warning')
  assert.equal(closing.page, 2)

  const miss = await checkOf({
    'deck.pptd': MANIFEST(['pages/01.page', 'pages/02.page']),
    'pages/01.page': [
      'pageType: cover',
      'elements:',
      '  - elementId: title',
      '    elementType: text',
      '    bounds: [48, 120, 700, 120]',
      '    content: {text: 交付周期缩短两成, fontSize: 44, bold: true, color: "#111111"}',
      '  - elementId: subtitle',
      '    elementType: text',
      '    bounds: [48, 280, 700, 60]',
      '    content: {text: 增长组内部评审材料, fontSize: 20, color: "#333333"}',
      '  - elementId: rule',
      '    elementType: shape',
      '    bounds: [48, 240, 240, 3]',
      '    shapeName: rect',
      '    fill: {type: solid, color: "#1E2BFA"}',
    ].join('\n'),
    'pages/02.page': [
      'pageType: closing',
      'elements:',
      // A conclusion plus its owner is the landing the rule asks for.
      '  - elementId: action',
      '    elementType: text',
      '    bounds: [48, 200, 800, 120]',
      '    content: {text: 下一步：本周内由交付组确认压缩后的排期，并在周五例会上同步风险。, fontSize: 22, color: "#111111"}',
    ].join('\n'),
  })
  assert.equal(findIssue(miss.issues, 'weak-cover'), undefined, 'a cover with a visual element is not flagged')
  assert.equal(findIssue(miss.issues, 'weak-closing'), undefined, 'a conclusion closing is not flagged')
})
