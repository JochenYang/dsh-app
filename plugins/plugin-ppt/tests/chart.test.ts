/**
 * The flat chart authoring form: closed validation (kinds, labels/series
 * bounds, aligned values, title length, no form mixing) and native rendering
 * — the exported .pptx carries a real chart part whose series colors derive
 * from the theme accent, so PowerPoint can edit the data.
 *
 * @module @dsh-app/plugin-ppt/tests/chart
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPptdProject } from '../src/pptd/check.ts'
import { loadPptdProject } from '../src/pptd/load.ts'
import { renderPptdProject } from '../src/pptd/render.ts'
import { accentSeriesColors } from '../src/pptd/colors.ts'

/** Build one on-disk PPTD project from file name → YAML text. */
function projectOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-chart-test-'))
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const MANIFEST = (pages: string[]): string => [
  'version: v2',
  'title: 图表校验',
  'size: [960, 540]',
  'theme:',
  '  colors:',
  '    background: "#FDFAE7"',
  '    text: "#111111"',
  '    accent: "#1E2BFA"',
  'pages:',
  ...pages.map(page => `  - ${page}`),
].join('\n')

const CHART_ELEMENT = (overrides: string[] = []): string => [
  '  - elementId: trend',
  '    elementType: chart',
  '    bounds: [64, 96, 560, 320]',
  '    chart: column',
  '    labels: [一月, 二月, 三月]',
  '    series:',
  '      - {name: 营收, values: [120, 156, 171]}',
  '      - {name: 成本, values: [80, 92, 96]}',
  ...overrides,
].join('\n')

test('chart: a clean flat chart passes validation', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      CHART_ELEMENT(['    color: "$accent"']),
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    assert.equal(check.errorCount, 0, `flat chart must be clean: ${JSON.stringify(check.issues.filter(i => i.severity === 'error'))}`)
    assert.equal(check.status, 'pass')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chart: misaligned values and over-limit labels/series are errors with element locations', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      // values length ≠ labels length
      '  - elementId: misaligned',
      '    elementType: chart',
      '    bounds: [32, 24, 400, 200]',
      '    chart: line',
      '    labels: [一月, 二月, 三月]',
      '    series:',
      '      - {name: 营收, values: [120, 156]}',
      // 25 labels
      '  - elementId: crowded',
      '    elementType: chart',
      '    bounds: [32, 260, 400, 200]',
      `    chart: bar`,
      `    labels: [${Array.from({ length: 25 }, (_, index) => `类目${index + 1}`).join(', ')}]`,
      '    series:',
      '      - {name: 数值, values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5]}',
      // 7 series
      '  - elementId: stacked-series',
      '    elementType: chart',
      '    bounds: [480, 24, 400, 200]',
      '    chart: column',
      '    labels: [一月, 二月]',
      '    series:',
      '      - {name: 一, values: [1, 2]}',
      '      - {name: 二, values: [1, 2]}',
      '      - {name: 三, values: [1, 2]}',
      '      - {name: 四, values: [1, 2]}',
      '      - {name: 五, values: [1, 2]}',
      '      - {name: 六, values: [1, 2]}',
      '      - {name: 七, values: [1, 2]}',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    assert.ok(check.issues.some(issue => issue.code === 'chart-values' && issue.elementId === 'misaligned' && issue.file === 'pages/01.page' && issue.page === 1))
    assert.ok(check.issues.some(issue => issue.code === 'chart-labels' && issue.elementId === 'crowded'))
    assert.ok(check.issues.some(issue => issue.code === 'chart-series' && issue.elementId === 'stacked-series'))
    assert.equal(check.status, 'fail')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chart: unknown kind, oversized title and form mixing are errors with fix guidance', async () => {
  const longTitle = '标题长度校验。'.repeat(12)
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: bad-kind',
      '    elementType: chart',
      '    bounds: [32, 24, 400, 160]',
      '    chart: radar',
      '    labels: [一月, 二月]',
      '    series:',
      '      - {name: 营收, values: [1, 2]}',
      '  - elementId: long-title',
      '    elementType: chart',
      '    bounds: [480, 24, 400, 160]',
      '    chart: column',
    `    title: ${JSON.stringify(longTitle)}`,
      '    labels: [一月, 二月]',
      '    series:',
      '      - {name: 营收, values: [1, 2]}',
      '  - elementId: mixed-form',
      '    elementType: chart',
      '    bounds: [32, 220, 400, 160]',
      '    chart: column',
      '    labels: [一月, 二月]',
      '    series:',
      '      - {name: 营收, values: [1, 2]}',
      '    data:',
      '      cols: [类目, 数值]',
      '      rows:',
      '        - [一月, 1]',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    assert.ok(check.issues.some(issue => issue.code === 'chart-kind' && issue.elementId === 'bad-kind'))
    assert.ok(check.issues.some(issue => issue.code === 'chart-title' && issue.elementId === 'long-title'))
    assert.ok(check.issues.some(issue => issue.code === 'chart-form' && issue.elementId === 'mixed-form'))
    // Every chart violation carries a fix in its message.
    for (const code of ['chart-kind', 'chart-title', 'chart-form']) {
      const issue = check.issues.find(item => item.code === code)
      assert.equal(issue?.severity, 'error')
      assert.ok(issue?.message.includes('校验') || issue?.message.includes('修正') || issue?.message.includes('缩短') || issue?.message.includes('二选一'))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chart: a flat chart exports a native editable chart part themed by the accent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-chart-render-'))
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'deck.pptd'), MANIFEST(['pages/01.page']), 'utf8')
    writeFileSync(join(dir, 'pages', '01.page'), [
      'pageType: content',
      'elements:',
      CHART_ELEMENT(),
    ].join('\n'), 'utf8')
    const project = await loadPptdProject(dir)
    const rendered = await renderPptdProject(project)

    const entries = new Map<string, string>()
    const buffer = Buffer.from(rendered.bytes)
    let offset = 0
    while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
      const method = buffer.readUInt16LE(offset + 8)
      const compressedSize = buffer.readUInt32LE(offset + 18)
      const nameLength = buffer.readUInt16LE(offset + 26)
      const extraLength = buffer.readUInt16LE(offset + 28)
      const entryName = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
      const dataStart = offset + 30 + nameLength + extraLength
      const raw = buffer.subarray(dataStart, dataStart + compressedSize)
      entries.set(entryName, method === 0 ? raw.toString('utf8') : inflateRawSync(raw).toString('utf8'))
      offset = dataStart + compressedSize
    }

    const chartPart = entries.get('ppt/charts/chart1.xml')
    assert.ok(chartPart !== undefined, `chart part present (got: ${[...entries.keys()].filter(name => name.includes('chart')).join(', ')})`)
    assert.ok(chartPart.includes('营收') && chartPart.includes('成本'), 'series names are editable data')
    assert.ok(chartPart.includes('一月') && chartPart.includes('三月'), 'category labels are editable data')
    // Series colors: the first series keeps the theme accent, the second is a
    // derived lightness variant — both visible in the chart XML.
    assert.ok(chartPart.includes('1E2BFA'), 'first series uses the theme accent')
    const fills = [...chartPart.matchAll(/<a:srgbClr val="([0-9A-F]{6})"/gu)].map(match => match[1])
    assert.ok(new Set(fills).size >= 2, `series colors are distinct variants (got ${[...new Set(fills)].join(', ')})`)

    const slide1 = entries.get('ppt/slides/slide1.xml')
    assert.ok(slide1 !== undefined)
    assert.ok(slide1.includes('graphicFrame'), 'the chart is a native graphicFrame')
    assert.ok(slide1.includes('chart'), 'the slide references the chart part')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chart: accentSeriesColors derives deterministic lightness variants of the accent', () => {
  const colors = accentSeriesColors('#1E2BFA', 3)
  assert.equal(colors.length, 3)
  for (const color of colors) assert.match(color, /^#[0-9A-F]{6}$/u)
  assert.equal(colors[0], '#1E2BFA', 'the first series keeps the accent itself')
  assert.equal(new Set(colors).size, 3, 'variants are distinct')
  // The ladder cycles past the factor list.
  const cycled = accentSeriesColors('#1E2BFA', 8)
  assert.equal(cycled[6], cycled[0])
  assert.equal(cycled[7], cycled[1])
})

test('chart: a pie with more than one series is an error steering to bar or split', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: pie-multi',
      '    elementType: chart',
      '    bounds: [64, 96, 420, 300]',
      '    chart: pie',
      '    labels: [一月, 二月]',
      '    series:',
      '      - {name: 营收, values: [120, 156]}',
      '      - {name: 成本, values: [80, 92]}',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    const pie = check.issues.find(issue => issue.code === 'chart-series' && issue.elementId === 'pie-multi')
    assert.ok(pie !== undefined, 'multi-series pie is flagged')
    assert.equal(pie.severity, 'error')
    assert.ok(pie.message.includes('饼图只支持一组数据'))
    assert.equal(check.status, 'fail')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chart: a single-series pie stays clean and grid-form pies obey the same ceiling', async () => {
  const single = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: pie-single',
      '    elementType: chart',
      '    bounds: [64, 96, 420, 300]',
      '    chart: pie',
      '    labels: [一月, 二月]',
      '    series:',
      '      - {name: 营收, values: [120, 156]}',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(single))
    assert.equal(check.errorCount, 0, `single-series pie must be clean: ${JSON.stringify(check.issues.filter(i => i.severity === 'error'))}`)
  } finally {
    rmSync(single, { recursive: true, force: true })
  }

  const grid = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: grid-pie',
      '    elementType: chart',
      '    bounds: [64, 96, 420, 300]',
      '    data:',
      '      cols: [month, value]',
      '      rows:',
      '        - [一月, 1]',
      '        - [二月, 2]',
      '    series:',
      '      - {type: pie, encode: {x: month, y: value}}',
      '      - {type: pie, encode: {x: month, y: value}}',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(grid))
    const pie = check.issues.find(issue => issue.code === 'chart-series' && issue.elementId === 'grid-pie')
    assert.ok(pie !== undefined, 'multi-series grid pie is flagged')
    assert.equal(pie.severity, 'error')
    assert.ok(pie.message.includes('饼图只支持一组数据'))
  } finally {
    rmSync(grid, { recursive: true, force: true })
  }
})
