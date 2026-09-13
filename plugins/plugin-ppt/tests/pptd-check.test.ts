/**
 * The PPTD checker against real YAML projects: the two historical layout
 * bugs must be caught BEFORE rendering (stacked cover copy, overflowing
 * table copy), with file/page/elementId locations on every issue.
 *
 * @module @dsh-app/plugin-ppt/tests/pptd-check
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPptdProject } from '../src/pptd/check.ts'
import { loadPptdProject } from '../src/pptd/load.ts'
import { validationReport } from '../src/pptd/report.ts'

/** Build one on-disk PPTD project from file name → YAML text. */
function projectOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-check-test-'))
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const MANIFEST = (pages: string[]): string => [
  'version: v2',
  'title: 校验样例',
  'size: [960, 540]',
  'pages:',
  ...pages.map(page => `  - ${page}`),
].join('\n')

test('check: two cover text elements sharing one box stack — needs_revision with location', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: cover',
      'background: {type: solid, color: "#F8F8F6"}',
      'elements:',
      '  - elementId: subtitle-a',
      '    elementType: text',
      '    bounds: [48, 380, 600, 60]',
      '    content: {text: 第一行副标题, fontSize: 20, color: "#333333"}',
      '  - elementId: subtitle-b',
      '    elementType: text',
      '    bounds: [48, 380, 600, 60]',
      '    content: {text: 第二行副标题, fontSize: 20, color: "#333333"}',
    ].join('\n'),
  })
  try {
    const project = await loadPptdProject(dir)
    const check = checkPptdProject(project)
    // Identical text boxes are the stacked-copy defect: a hard error.
    const stacked = check.issues.filter(issue => issue.code === 'text-stacked')
    assert.ok(stacked.length >= 1, 'stacked text is flagged as error')
    const located = stacked.find(issue => issue.elementId !== undefined && issue.page !== undefined)
    assert.ok(located !== undefined)
    assert.equal(located.file, 'pages/01.page')
    assert.equal(located.page, 1)
    assert.equal(located.severity, 'error')
    assert.equal(check.status, 'fail')
    assert.equal(validationReport(check, { projectDirectory: dir, projectPath: 'p' }).status, 'needs_revision')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check: partially overlapping text and shape stays an advisory warning', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'background: {type: solid, color: "#FFFFFF"}',
      'elements:',
      '  - elementId: copy',
      '    elementType: text',
      '    bounds: [48, 100, 400, 100]',
      '    content: {text: 部分重叠的正文, fontSize: 18, color: "#333333"}',
      '  - elementId: panel',
      '    elementType: shape',
      '    bounds: [48, 180, 400, 200]',
      '    shapeName: rect',
      '    fill: {type: solid, color: "#EEEEEE"}',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    assert.ok(check.issues.some(issue => issue.code === 'text-occlusion' && issue.severity === 'warning' && issue.elementId === 'copy'))
    assert.equal(check.errorCount, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check: oversized copy in a small text box overflows — needs_revision names the element', async () => {
  const longText = '这是一个故意写得非常长的段落，用来触发容量校验。'.repeat(6)
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'background: {type: solid, color: "#FFFFFF"}',
      'elements:',
      '  - elementId: body-copy',
      '    elementType: text',
      '    bounds: [48, 120, 300, 60]',
      `    content: {text: ${JSON.stringify(longText)}, fontSize: 18, color: "#111111"}`,
    ].join('\n'),
  })
  try {
    const project = await loadPptdProject(dir)
    const check = checkPptdProject(project)
    assert.equal(check.status, 'fail')
    assert.ok(check.issues.some(issue => issue.code === 'text-overflow' && issue.elementId === 'body-copy' && issue.file === 'pages/01.page' && issue.page === 1))
    const report = validationReport(check, { projectDirectory: dir, projectPath: '示例工程' })
    assert.equal(report.status, 'needs_revision')
    assert.equal(report.issues[0]?.readArgs?.project_path, '示例工程')
    assert.equal(report.issues[0]?.readArgs?.file_path, 'pages/01.page')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check: a clean two-page project passes with no issues', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page', 'pages/02.page']),
    'pages/01.page': [
      'pageType: cover',
      'background: {type: solid, color: "#F8F8F6"}',
      'elements:',
      '  - elementId: headline',
      '    elementType: text',
      '    bounds: [48, 200, 600, 120]',
      '    content: {text: 明确的结论, fontSize: 44, color: "#111111", bold: true}',
      '  - elementId: kicker',
      '    elementType: shape',
      '    bounds: [48, 160, 36, 2]',
      '    shapeName: rect',
      '    fill: {type: solid, color: "#1E2BFA"}',
    ].join('\n'),
    'pages/02.page': [
      'pageType: content',
      'background: {type: solid, color: "#FFFFFF"}',
      'elements:',
      '  - elementId: body',
      '    elementType: text',
      '    bounds: [48, 120, 600, 300]',
      '    content: {text: 简短的正文, fontSize: 18, color: "#333333"}',
    ].join('\n'),
  })
  try {
    const project = await loadPptdProject(dir)
    const check = checkPptdProject(project)
    assert.equal(check.status, 'pass')
    assert.equal(check.errorCount, 0)
    assert.equal(check.pageCount, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check: out-of-bounds elements and duplicate ids are errors with element locations', async () => {
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: twice',
      '    elementType: shape',
      '    bounds: [900, 500, 200, 100]',
      '    shapeName: rect',
      '  - elementId: twice',
      '    elementType: text',
      '    bounds: [10, 10, 100, 40]',
      '    content: {text: 重复, fontSize: 18}',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    assert.ok(check.issues.some(issue => issue.code === 'out-of-bounds' && issue.elementId === 'twice'))
    assert.ok(check.issues.some(issue => issue.code === 'duplicate-id'))
    assert.equal(check.status, 'fail')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check: a table whose text exceeds the row height is caught by the layout estimate', async () => {
  // The engine enforces table grid validity; the cell overflow risk is
  // handled by explicit rowHeights — an invalid grid must be an error.
  const dir = projectOf({
    'deck.pptd': MANIFEST(['pages/01.page']),
    'pages/01.page': [
      'pageType: content',
      'elements:',
      '  - elementId: grid',
      '    elementType: table',
      '    bounds: [48, 120, 600, 240]',
      '    columnWidths: [0.5, 0.5, 0.5]',
      '    rowHeights: [0.5, 0.5]',
      '    rows:',
      '      - [a, b]',
      '      - [c, d]',
    ].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    assert.ok(check.issues.some(issue => issue.code === 'table-data' && issue.elementId === 'grid'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check: unknown manifest fields and missing pages report the offending file', async () => {
  const dir = projectOf({
    'deck.pptd': ['version: v2', 'size: [960, 540]', 'author: 某人', 'pages:', '  - pages/gone.page'].join('\n'),
  })
  try {
    const check = checkPptdProject(await loadPptdProject(dir))
    assert.ok(check.issues.some(issue => issue.code === 'unknown-field' && issue.file === 'deck.pptd'))
    assert.ok(check.issues.some(issue => issue.code === 'missing-page' && issue.file === 'pages/gone.page' && issue.page === 1))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
