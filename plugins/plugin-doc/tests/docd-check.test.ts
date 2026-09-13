/**
 * The DOC checker: the authoring rules that decide whether a project may be
 * rendered. Each case pins one rule with the block index and field the model
 * needs to fix it, so a failure names both the rule and the location.
 *
 * @module @dsh-app/plugin-doc/tests/docd-check
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDocDocument, loadDocDocument } from '../src/docd/check.ts'
import { MAX_BLOCKS, MAX_CELL_CHARS, MAX_HEADING_SENTENCE_CHARS, MAX_PARAGRAPH_SENTENCE_CHARS, MAX_TABLE_HEADERS, MAX_TABLE_SOFT_ROWS } from '../src/docd/types.ts'

/** A minimal valid project. */
function validDocument(): Record<string, unknown> {
  return {
    title: '季度复盘',
    sections: [
      { heading: { level: 1, text: '结论' } },
      { paragraph: { text: '核心指标全面达标。' } },
      { bullets: ['营收增长 22%', '毛利率提升 3.3 个百分点'] },
      { heading: { level: 2, text: '关键指标' } },
      { table: { headers: ['指标', '本期'], rows: [['营收', '1,280 万']] } },
      { image: { path: 'assets/trend.png' } },
    ],
  }
}

test('check: a well-formed project passes without issues', () => {
  const result = checkDocDocument(validDocument())
  assert.equal(result.status, 'pass')
  assert.equal(result.errorCount, 0)
  assert.equal(result.warningCount, 0)
  assert.equal(result.blockCount, 6)
})

test('check: the author is optional and carried into the project', () => {
  const { project, issues } = loadDocDocument({ ...validDocument(), author: '增长组' })
  assert.equal(issues.length, 0)
  assert.equal(project.author, '增长组')
})

test('check: a non-object root is a document-level error', () => {
  const result = checkDocDocument(['not', 'a', 'document'])
  assert.equal(result.status, 'fail')
  assert.equal(result.issues[0]?.code, 'invalid-document')
  assert.equal(result.issues[0]?.block, undefined)
})

test('check: an empty sections array is an error, never an empty document', () => {
  const result = checkDocDocument({ title: '空文档', sections: [] })
  assert.equal(result.status, 'fail')
  const issue = result.issues.find(item => item.code === 'empty-document')
  assert.ok(issue !== undefined)
  assert.equal(issue.field, 'sections')
})

test('check: unknown fields are refused at every level with their path', () => {
  const result = checkDocDocument({
    title: '未知字段',
    version: 2,
    sections: [
      { heading: { level: 1, text: '标题', align: 'center' } },
      { paragraph: { text: '正文', color: 'red' } },
      { table: { headers: ['A'], rows: [['1']], width: 100 } },
      { image: { path: 'a.png', caption: 'x' } },
    ],
  })
  const fields = result.issues.filter(item => item.code === 'unknown-field').map(item => item.field)
  assert.deepEqual(fields.sort(), [
    'heading.align',
    'image.caption',
    'paragraph.color',
    'table.width',
    'version',
  ].sort())
  assert.equal(result.status, 'fail')
})

test('check: a heading level jump is an error anchored to the block', () => {
  const result = checkDocDocument({
    title: '跳级',
    sections: [
      { heading: { level: 1, text: '第一章' } },
      { paragraph: { text: '章节导语。' } },
      { heading: { level: 3, text: '直接到三级' } },
    ],
  })
  assert.equal(result.status, 'fail')
  assert.equal(result.errorCount, 1)
  const issue = result.issues.find(item => item.code === 'heading-level-jump')
  assert.ok(issue !== undefined)
  assert.equal(issue.severity, 'error')
  assert.equal(issue.block, 3)
  assert.equal(issue.field, 'heading.level')
  assert.match(issue.message, /H1/)
  assert.match(issue.message, /H3/)
})

test('check: a consecutive heading sequence with chapter body is not warned about', () => {
  const result = checkDocDocument({
    title: '连续',
    sections: [
      { heading: { level: 1, text: '第一章' } },
      { paragraph: { text: '第一章正文。' } },
      { heading: { level: 2, text: '第一节' } },
      { paragraph: { text: '第一节正文。' } },
      { heading: { level: 3, text: '第一小节' } },
      { paragraph: { text: '第一小节正文。' } },
      { heading: { level: 2, text: '第二节' } },
      { paragraph: { text: '第二节正文。' } },
    ],
  })
  assert.equal(result.status, 'pass')
  assert.equal(result.warningCount, 0)
})

test('check: a table row whose width differs from the headers is an error', () => {
  const result = checkDocDocument({
    title: '表格',
    sections: [{ table: { headers: ['指标', '本期', '上期'], rows: [['营收', '1,280 万']] } }],
  })
  assert.equal(result.status, 'fail')
  const issue = result.issues.find(item => item.code === 'table-row-shape')
  assert.ok(issue !== undefined)
  assert.equal(issue.block, 1)
  assert.equal(issue.field, 'table.rows[0]')
  assert.match(issue.message, /2 个单元格/)
  assert.match(issue.message, /3 列/)
})

test('check: an over-long cell is an error; a header-only table is only a warning', () => {
  const long = checkDocDocument({
    title: '长单元格',
    sections: [{ table: { headers: ['A'], rows: [[`长`.repeat(MAX_CELL_CHARS + 1)]] } }],
  })
  assert.equal(long.status, 'fail')
  assert.equal(long.issues.find(item => item.code === 'cell-too-long')?.field, 'table.rows[0][0]')

  const headerOnly = checkDocDocument({
    title: '只有表头',
    sections: [{ table: { headers: ['A'], rows: [] } }],
  })
  assert.equal(headerOnly.status, 'warning')
  assert.equal(headerOnly.issues[0]?.code, 'empty-table-rows')
})

test('check: tables and empty lists report their shape problems', () => {
  const result = checkDocDocument({
    title: '结构',
    sections: [
      { bullets: [] },
      { table: { headers: [], rows: [] } },
      { table: { headers: ['A'], rows: ['not-an-array'] } },
    ],
  })
  const codes = result.issues.map(item => item.code)
  assert.ok(codes.includes('empty-bullets'))
  assert.ok(codes.includes('empty-table-headers'))
  assert.ok(codes.includes('invalid-table-row'))
})

test('check: a block must carry exactly one content key', () => {
  const none = checkDocDocument({ title: '缺内容', sections: [{ heading: undefined }] })
  assert.equal(none.issues[0]?.code, 'missing-content')
  assert.equal(none.issues[0]?.block, 1)

  const both = checkDocDocument({
    title: '两种内容',
    sections: [{ heading: { level: 1, text: 'A' }, paragraph: { text: 'B' } }],
  })
  assert.equal(both.issues[0]?.code, 'multiple-content')
  assert.match(both.issues[0]?.message ?? '', /heading/)
})

test('check: heading levels outside 1-3 and empty text are errors', () => {
  const result = checkDocDocument({
    title: '标题',
    sections: [{ heading: { level: 4, text: '太深' } }, { heading: { level: 1, text: '   ' } }],
  })
  const codes = result.issues.map(item => item.code)
  assert.ok(codes.includes('invalid-heading-level'))
  assert.ok(codes.includes('invalid-text'))
})

test('check: an image path must stay inside the workspace and be embeddable', () => {
  const cases: [string, string][] = [
    ['/etc/passwd.png', 'absolute'],
    ['../secret.png', 'parent escape'],
    ['assets\\logo.png', 'backslash'],
    ['assets/logo.webp', 'unsupported format'],
    ['assets/noextension', 'no extension'],
  ]
  for (const [path, label] of cases) {
    const result = checkDocDocument({ title: '图片', sections: [{ image: { path } }] })
    assert.equal(result.status, 'fail', `${label} must be rejected`)
    assert.equal(result.issues[0]?.field, 'image.path', `${label} names image.path`)
  }
  const good = checkDocDocument({ title: '图片', sections: [{ image: { path: 'assets/logo.jpg' } }] })
  assert.equal(good.status, 'pass')
})

test('check: the block count limit is enforced', () => {
  const sections = Array.from({ length: MAX_BLOCKS + 1 }, () => ({ paragraph: { text: '一段' } }))
  const result = checkDocDocument({ title: '太长', sections })
  assert.equal(result.status, 'fail')
  assert.ok(result.issues.some(item => item.code === 'too-many-blocks'))
})

test('check: invalid blocks are dropped from the normalized project', () => {
  const { project, issues } = loadDocDocument({
    title: '混合',
    sections: [
      { paragraph: { text: '保留' } },
      { paragraph: { text: '' } },
      'not-an-object',
    ],
  })
  assert.equal(project.sections.length, 1)
  assert.equal(issues.filter(item => item.severity === 'error').length, 2)
})

test('check: a heading longer than a short claim is an error with a rewrite hint', () => {
  const result = checkDocDocument({
    title: '长标题',
    sections: [
      { heading: { level: 1, text: '标'.repeat(MAX_HEADING_SENTENCE_CHARS + 1) } },
      { paragraph: { text: '正文。' } },
    ],
  })
  assert.equal(result.status, 'fail')
  const issue = result.issues.find(item => item.code === 'heading-too-long')
  assert.ok(issue !== undefined)
  assert.equal(issue.severity, 'error')
  assert.equal(issue.block, 1)
  assert.equal(issue.field, 'heading.text')
  assert.match(issue.fix ?? '', /正文/)

  const boundary = checkDocDocument({
    title: '刚好',
    sections: [
      { heading: { level: 1, text: '标'.repeat(MAX_HEADING_SENTENCE_CHARS) } },
      { paragraph: { text: '正文。' } },
    ],
  })
  assert.equal(boundary.status, 'pass')
})

test('check: a lone or stacked heading is empty, but a chapter opening a section only warns', () => {
  // A heading at the end of the document has no body at all.
  const loneHeading = checkDocDocument({
    title: '空章节',
    sections: [{ heading: { level: 1, text: '第一章' } }],
  })
  assert.equal(loneHeading.status, 'fail')
  const lone = loneHeading.issues.find(item => item.code === 'empty-section')
  assert.ok(lone !== undefined)
  assert.equal(lone.severity, 'error')
  assert.equal(lone.block, 1)
  assert.equal(lone.field, 'heading')

  // H1 → H2 is a chapter opening its first section: warned, not blocked.
  const stacked = checkDocDocument({
    title: '堆叠标题',
    sections: [
      { heading: { level: 1, text: '第一章' } },
      { heading: { level: 2, text: '第一节' } },
      { paragraph: { text: '正文。' } },
    ],
  })
  assert.equal(stacked.status, 'warning')
  assert.equal(stacked.errorCount, 0)
  const transition = stacked.issues.find(item => item.code === 'empty-section')
  assert.ok(transition !== undefined)
  assert.equal(transition.severity, 'warning')
  assert.equal(transition.block, 1)
  assert.match(transition.message, /下级 H2/u)

  // H1 → H1 has no content and nothing deeper to carry it: an error.
  const siblings = checkDocDocument({
    title: '同级标题',
    sections: [
      { heading: { level: 1, text: '第一章' } },
      { heading: { level: 1, text: '第二章' } },
      { paragraph: { text: '正文。' } },
    ],
  })
  assert.equal(siblings.status, 'fail')
  const siblingIssue = siblings.issues.find(item => item.code === 'empty-section')
  assert.ok(siblingIssue !== undefined)
  assert.equal(siblingIssue.severity, 'error')
  assert.equal(siblingIssue.block, 1)

  // An H2 at the end of the document is empty too.
  const trailing = checkDocDocument({
    title: '文末标题',
    sections: [
      { heading: { level: 1, text: '第一章' } },
      { paragraph: { text: '正文。' } },
      { heading: { level: 2, text: '第一节' } },
    ],
  })
  assert.equal(trailing.status, 'fail')
  const trailingIssue = trailing.issues.find(item => item.code === 'empty-section')
  assert.ok(trailingIssue !== undefined)
  assert.equal(trailingIssue.severity, 'error')
  assert.equal(trailingIssue.block, 3)

  // H3 is a sub-heading, not a chapter: it may carry its own content but a
  // missing body under it is not this rule's concern.
  const h3Only = checkDocDocument({
    title: '三级标题',
    sections: [
      { heading: { level: 1, text: '第一章' } },
      { paragraph: { text: '正文。' } },
      { heading: { level: 2, text: '第一节' } },
      { paragraph: { text: '正文。' } },
      { heading: { level: 3, text: '第一小节' } },
    ],
  })
  assert.equal(h3Only.status, 'pass')
})

test('check: an over-long paragraph warns instead of blocking', () => {
  const result = checkDocDocument({
    title: '长段落',
    sections: [{ paragraph: { text: '长'.repeat(MAX_PARAGRAPH_SENTENCE_CHARS + 1) } }],
  })
  assert.equal(result.status, 'warning')
  assert.equal(result.errorCount, 0)
  const issue = result.issues.find(item => item.code === 'paragraph-too-long')
  assert.ok(issue !== undefined)
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.block, 1)
  assert.equal(issue.field, 'paragraph.text')
})

test('check: an over-long table warns, and past the column ceiling it is refused', () => {
  const long = checkDocDocument({
    title: '长表格',
    sections: [{
      table: {
        headers: ['指标', '本期'],
        rows: Array.from({ length: MAX_TABLE_SOFT_ROWS + 1 }, () => ['营收', '1,280 万']),
      },
    }],
  })
  assert.equal(long.status, 'warning')
  assert.equal(long.errorCount, 0)
  const longIssues = long.issues.filter(item => item.code === 'table-too-long')
  assert.equal(longIssues.length, 1, 'the soft row limit is reported exactly once')
  assert.equal(longIssues[0]?.severity, 'warning')

  const wide = checkDocDocument({
    title: '宽表格',
    sections: [{
      table: {
        headers: Array.from({ length: MAX_TABLE_HEADERS + 1 }, (_value, index) => `列${index + 1}`),
        rows: [Array.from({ length: MAX_TABLE_HEADERS + 1 }, () => '1')],
      },
    }],
  })
  assert.equal(wide.status, 'fail')
  assert.ok(wide.issues.some(item => item.code === 'too-many-columns' && item.severity === 'error'))
})

test('check: a numeric column with mixed decimal places warns, and three shapes fail', () => {
  const warn = checkDocDocument({
    title: '小数',
    sections: [{ table: { headers: ['金额'], rows: [['1.2'], ['3.45']] } }],
  })
  assert.equal(warn.status, 'warning')
  const issue = warn.issues.find(item => item.code === 'decimal-mismatch')
  assert.ok(issue !== undefined)
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.block, 1)
  assert.equal(issue.field, 'table.headers[0]')

  const error = checkDocDocument({
    title: '小数',
    sections: [{ table: { headers: ['金额'], rows: [['1.2'], ['3.45'], ['6.789']] } }],
  })
  assert.equal(error.status, 'fail')
  assert.equal(error.issues.find(item => item.code === 'decimal-mismatch')?.severity, 'error')

  const clean = checkDocDocument({
    title: '小数',
    sections: [{ table: { headers: ['金额'], rows: [['1.2'], ['3.4']] } }],
  })
  assert.equal(clean.issues.some(item => item.code === 'decimal-mismatch'), false)
})

test('check: a ratio column written as fractions warns unless it uses percent text', () => {
  const fraction = checkDocDocument({
    title: '比率',
    sections: [{ table: { headers: ['增长率'], rows: [['0.128'], ['0.052']] } }],
  })
  const issue = fraction.issues.find(item => item.code === 'percent-column-format')
  assert.ok(issue !== undefined)
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.field, 'table.headers[0]')

  const percent = checkDocDocument({
    title: '比率',
    sections: [{ table: { headers: ['增长率'], rows: [['12.8%'], ['5.2%']] } }],
  })
  assert.equal(percent.issues.some(item => item.code === 'percent-column-format'), false)

  const percentScale = checkDocDocument({
    title: '比率',
    sections: [{ table: { headers: ['增长率'], rows: [['128'], ['52']] } }],
  })
  assert.equal(percentScale.issues.some(item => item.code === 'percent-column-format'), false, 'values above 1.5 are already percent-scale')
})

test('check: large values without a unit warn, and a declared unit silences it', () => {
  const missing = checkDocDocument({
    title: '营收',
    sections: [{ table: { headers: ['营收'], rows: [['12000'], ['15000']] } }],
  })
  const issue = missing.issues.find(item => item.code === 'missing-unit')
  assert.ok(issue !== undefined)
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.field, 'table.headers[0]')

  const titled = checkDocDocument({
    title: '营收（万元）',
    sections: [{ table: { headers: ['营收'], rows: [['12000'], ['15000']] } }],
  })
  assert.equal(titled.issues.some(item => item.code === 'missing-unit'), false)

  const headed = checkDocDocument({
    title: '营收',
    sections: [{ table: { headers: ['营收（万元）'], rows: [['12000'], ['15000']] } }],
  })
  assert.equal(headed.issues.some(item => item.code === 'missing-unit'), false)
})

test('check: subtitle and date are optional metadata carried into the project', () => {
  const { project, issues } = loadDocDocument({
    ...validDocument(),
    subtitle: '增长组内部评审材料',
    author: '增长组',
    date: '2026-04-10',
  })
  assert.equal(issues.length, 0)
  assert.equal(project.subtitle, '增长组内部评审材料')
  assert.equal(project.author, '增长组')
  assert.equal(project.date, '2026-04-10')

  const empty = checkDocDocument({ ...validDocument(), subtitle: '  ' })
  assert.equal(empty.status, 'fail')
  assert.equal(empty.issues[0]?.code, 'invalid-subtitle')

  const long = checkDocDocument({ ...validDocument(), date: 'd'.repeat(41) })
  assert.equal(long.status, 'fail')
  assert.equal(long.issues[0]?.code, 'date-too-long')
})
