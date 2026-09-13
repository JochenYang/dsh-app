/**
 * PDF reading: the bounded-extraction contract and the failure messages the
 * model is expected to act on. A reader that silently truncates or reports a
 * stack trace instead of an actionable sentence is worse than no reader, so
 * both the ceilings and the error mapping are pinned here.
 *
 * @module @dsh-app/plugin-pdf/tests/pdfd-read
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPdfDocument, loadPdfDocument } from '../src/pdfd/check.ts'
import { renderPdfProject } from '../src/pdfd/render.ts'
import { describePdfFailure, MAX_SOURCE_BYTES, readPdfFile } from '../src/pdfd/read.ts'

/** Write a rendered project to a temp file and hand the path to `run`. */
async function withRenderedPdf(
  project: unknown,
  run: (file: string, sizeBytes: number) => Promise<void>,
): Promise<void> {
  const check = checkPdfDocument(project)
  assert.equal(check.errorCount, 0)
  const { bytes } = await renderPdfProject(loadPdfDocument(project).project)
  const dir = mkdtempSync(join(tmpdir(), 'pdfd-read-'))
  const file = join(dir, 'sample.pdf')
  try {
    writeFileSync(file, Buffer.from(bytes))
    await run(file, bytes.byteLength)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const THREE_PAGES = {
  title: '三页文档',
  blocks: [
    { paragraph: { text: '第一页。' } },
    { pageBreak: true },
    { paragraph: { text: '第二页。' } },
    { pageBreak: true },
    { paragraph: { text: '第三页。' } },
  ],
}

test('read: the character ceiling truncates and says so', async () => {
  await withRenderedPdf(THREE_PAGES, async (file, sizeBytes) => {
    const summary = await readPdfFile(file, sizeBytes, { maxChars: 8 })
    assert.equal(summary.truncated, true)
    assert.ok(summary.extractedChars <= 8)
    assert.equal(summary.pageCount, 3)
    // Extraction stops at the ceiling instead of walking every page.
    assert.equal(summary.pages.length, 1)
  })
})

test('read: the page ceiling is reported, not silently applied', async () => {
  await withRenderedPdf(THREE_PAGES, async (file, sizeBytes) => {
    const summary = await readPdfFile(file, sizeBytes, { maxPages: 2 })
    assert.equal(summary.pageLimitHit, true)
    assert.equal(summary.truncated, true)
    assert.equal(summary.pages.length, 2)
    assert.equal(summary.pageCount, 3)
  })
})

test('read: a source above the size ceiling is refused before any parsing', async () => {
  await withRenderedPdf(THREE_PAGES, async (file) => {
    await assert.rejects(
      () => readPdfFile(file, MAX_SOURCE_BYTES + 1),
      /50 MB/u,
    )
  })
})

test('read: a corrupt file reports an actionable message, not a parser trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfd-read-bad-'))
  const file = join(dir, 'broken.pdf')
  try {
    writeFileSync(file, 'this is definitely not a pdf')
    await assert.rejects(
      () => readPdfFile(file, 26),
      (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        assert.match(message, /不是有效的 PDF|损坏/u)
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read: an encrypted document reports the password instruction', async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'encrypted.pdf')
  const size = statSync(fixture).size
  await assert.rejects(
    () => readPdfFile(fixture, size),
    (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      assert.match(message, /加密/u)
      assert.match(message, /密码/u)
      return true
    },
  )
})

test('read: parser failures map to password and corruption instructions', () => {
  const password = Object.assign(new Error('No password given'), { name: 'PasswordException' })
  assert.match(describePdfFailure(password), /加密/u)
  assert.match(describePdfFailure(password), /密码/u)

  const invalid = Object.assign(new Error('Invalid PDF structure'), { name: 'InvalidPDFException' })
  assert.match(describePdfFailure(invalid), /不是有效的 PDF/u)

  // Anything else keeps its own message rather than being mislabelled.
  assert.equal(describePdfFailure(new Error('boom')), 'boom')
  assert.equal(describePdfFailure('boom'), 'boom')
})

test('read: metadata and page text come out of one document proxy', async () => {
  await withRenderedPdf({
    title: '元数据标题',
    author: '数据组',
    blocks: [{ paragraph: { text: '正文。' } }],
  }, async (file, sizeBytes) => {
    const summary = await readPdfFile(file, sizeBytes)
    assert.equal(summary.title, '元数据标题')
    assert.equal(summary.author, '数据组')
    assert.equal(summary.pageCount, 1)
    assert.equal(summary.truncated, false)
    assert.ok(summary.pages[0]?.includes('正文'))
  })
})
