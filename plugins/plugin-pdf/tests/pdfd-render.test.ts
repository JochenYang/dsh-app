/**
 * Renderer end to end: a project is rendered with pdf-lib and then read back
 * through the plugin's own extraction path (unpdf/PDF.js). The round trip is
 * the point — it proves the render gate's output is real selectable text with
 * recoverable metadata, that pagination produced the pages the footer claims,
 * and that the bundled CJK subset actually carries the document's characters.
 *
 * @module @dsh-app/plugin-pdf/tests/pdfd-render
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPdfDocument, loadPdfDocument } from '../src/pdfd/check.ts'
import { renderPdfProject } from '../src/pdfd/render.ts'
import { readPdfFile } from '../src/pdfd/read.ts'

/** Render an error-free project and read the bytes back. */
async function renderAndRead(project: unknown): Promise<{
  pageCount: number
  pages: readonly string[]
  title?: string
  author?: string
  bytes: number
}> {
  const parsed = loadPdfDocument(project).project
  const check = checkPdfDocument(project)
  assert.equal(check.errorCount, 0, `project must be error-free: ${check.issues.map(issue => issue.code).join(',')}`)
  const { bytes, fontSource } = await renderPdfProject(parsed)
  assert.equal(fontSource, 'built-in', 'the bundled asset must resolve before any system font')
  const dir = mkdtempSync(join(tmpdir(), 'pdfd-render-'))
  const file = join(dir, 'out.pdf')
  try {
    writeFileSync(file, Buffer.from(bytes))
    const summary = await readPdfFile(file, bytes.byteLength)
    return { ...summary, bytes: bytes.byteLength }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Whitespace-insensitive containment: wrapped lines join without spaces. */
function compact(text: string): string {
  return text.replace(/\s+/gu, '')
}

test('render: a Chinese project round-trips through the reader with metadata intact', async () => {
  const summary = await renderAndRead({
    title: '二〇二六年第一季度评审',
    author: '增长组',
    size: 'a4',
    blocks: [
      { heading: { level: 1, text: '核心结论' } },
      { paragraph: { text: '本季度核心指标全面达标，毛利率提升 3.3 个百分点。' } },
      { bullets: ['营收同比增长 22%', '新增客户 128 家'] },
      { heading: { level: 2, text: '关键指标' } },
      { table: { headers: ['指标', '本期', '上期'], rows: [['营收', '1,280 万', '1,050 万'], ['毛利率', '34.5%', '31.2%']] } },
    ],
  })
  assert.equal(summary.pageCount, 1)
  assert.equal(summary.title, '二〇二六年第一季度评审')
  assert.equal(summary.author, '增长组')
  const body = compact(summary.pages.join('\n'))
  for (const fragment of ['核心结论', '毛利率提升3.3个百分点', '营收同比增长22%', '新增客户128家', '1,280万', '34.5%']) {
    assert.ok(body.includes(compact(fragment)), `missing ${fragment} in ${body}`)
  }
})

test('render: a long project paginates and every page carries its footer number', async () => {
  const blocks: unknown[] = [{ heading: { level: 1, text: '长篇报告' } }]
  for (let index = 0; index < 12; index += 1) {
    blocks.push(
      { heading: { level: 2, text: `第 ${String(index + 1)} 节` } },
      { paragraph: { text: `这是第 ${String(index + 1)} 节的正文。`.repeat(12) } },
    )
  }
  const summary = await renderAndRead({ title: '长篇报告', size: 'a4', blocks })
  assert.ok(summary.pageCount >= 2, `expected pagination, got ${String(summary.pageCount)} pages`)
  for (const [index, page] of summary.pages.entries()) {
    assert.ok(
      compact(page).includes(compact(`第 ${String(index + 1)} 页 / 共 ${String(summary.pageCount)} 页`)),
      `page ${String(index + 1)} footer missing from ${page}`,
    )
  }
})

test('render: a forced page break starts a new sheet', async () => {
  const summary = await renderAndRead({
    title: '两页文档',
    blocks: [
      { heading: { level: 1, text: '第一页' } },
      { paragraph: { text: '第一页正文。' } },
      { pageBreak: true },
      { heading: { level: 1, text: '第二页' } },
      { paragraph: { text: '第二页正文。' } },
    ],
  })
  assert.equal(summary.pageCount, 2)
  assert.ok(compact(summary.pages[0] ?? '').includes('第一页正文'))
  assert.ok(compact(summary.pages[1] ?? '').includes('第二页正文'))
})

test('render: letter paper is honoured and still readable', async () => {
  const summary = await renderAndRead({
    title: 'Letter 版式',
    size: 'letter',
    blocks: [{ heading: { level: 1, text: '标题' } }, { paragraph: { text: '正文内容。' } }],
  })
  assert.equal(summary.pageCount, 1)
  assert.ok(compact(summary.pages[0] ?? '').includes('正文内容'))
})

test('render: a character outside the bundled subset fails with an actionable font error', async () => {
  const parsed = loadPdfDocument({
    title: '生僻字',
    blocks: [{ paragraph: { text: '括号外的字符：𠮷。' } }],
  }).project
  await assert.rejects(
    () => renderPdfProject(parsed),
    (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      assert.match(message, /DSH_PDF_FONT/u)
      assert.match(message, /𠮷/u)
      return true
    },
  )
})

test('render: Latin-dense text is never under-estimated and loses no line', async () => {
  const denseUrl = 'https://example.com/api/v1/VERY-LONG-SEGMENT/with-WIDE-WORDS-AND-TOKENS/ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789'
  const blocks: unknown[] = [{ heading: { level: 1, text: 'LATIN DENSITY REPORT' } }]
  for (let index = 0; index < 6; index += 1) {
    blocks.push({ paragraph: { text: `Section ${String(index + 1)}: ${denseUrl} `.repeat(7) } })
  }
  // A unique final paragraph pins the read side's zero-loss proof.
  blocks.push({ paragraph: { text: `FINAL-SENTINEL-WWW-MMM-0123456789-${'Z'.repeat(40)}` } })
  const project = { title: 'Latin density', author: 'QA', size: 'a4', blocks }

  const check = checkPdfDocument(project)
  assert.equal(check.errorCount, 0, `planted project must pass the gate: ${check.issues.map(issue => issue.code).join(',')}`)
  const summary = await renderAndRead(project)

  // The font-free estimate is an upper bound, never a floor: the checker must
  // not promise fewer sheets than the real font actually needs.
  assert.ok(
    check.estimatedPages >= summary.pageCount,
    `checker estimated ${String(check.estimatedPages)} pages, renderer produced ${String(summary.pageCount)}`,
  )
  assert.ok(summary.pageCount >= 2, `dense text should paginate, got ${String(summary.pageCount)} pages`)

  // Every line stays inside the frame, so the final paragraph is readable.
  const lastPage = compact(summary.pages[summary.pages.length - 1] ?? '')
  assert.ok(lastPage.includes(compact('FINAL-SENTINEL-WWW-MMM-0123456789')), `last line missing from final page: ${lastPage}`)
  assert.ok(compact(summary.pages.join('\n')).includes(compact('LATIN DENSITY REPORT')), 'heading survives')
})

test('render: a table taller than a page repeats its header instead of clipping', async () => {
  const table = {
    headers: ['HDR-COLUMN-ALPHA', 'HDR-COLUMN-BETA'],
    rows: Array.from({ length: 70 }, (_value, index) => [`row-${String(index)}`, `value-${String(index)}`]),
  }
  const project = { title: 'Table split', size: 'a4', blocks: [{ heading: { level: 1, text: 'Split' } }, { table }] }
  const { project: parsed } = loadPdfDocument(project)
  // The checker refuses this table, so render directly: the fallback is exactly
  // the case where the estimate and the gate are not the last word.
  const check = checkPdfDocument(project)
  assert.ok(check.issues.some(issue => issue.code === 'table-too-tall'), 'planted table must exceed one sheet')

  const { bytes } = await renderPdfProject(parsed)
  const dir = mkdtempSync(join(tmpdir(), 'pdfd-split-'))
  try {
    const file = join(dir, 'split.pdf')
    writeFileSync(file, Buffer.from(bytes))
    const summary = await readPdfFile(file, bytes.byteLength)
    assert.ok(summary.pageCount >= 2, `split table must span pages, got ${String(summary.pageCount)}`)
    const headerPages = summary.pages.filter(page => compact(page).includes(compact('HDR-COLUMN-ALPHA'))).length
    assert.ok(headerPages >= 2, `header must repeat on continuation pages, found ${String(headerPages)}`)
    const body = compact(summary.pages.join('\n'))
    assert.ok(body.includes(compact('row-0')) && body.includes(compact('row-69')), 'first and last rows both survive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
