/**
 * Page-level PDF editing: metadata, keeping/deleting pages, rotation and
 * merging — the operations a user means by "edit this PDF".
 *
 * Every case builds a REAL PDF with `pdf-lib` and runs it through the module,
 * so what is asserted is the resulting document (page count, rotation, metadata
 * read back from the saved bytes) rather than an internal decision. That is the
 * only way to catch the failure this module was written to avoid: `pdf-lib`'s
 * page removal renumbers as it goes, so a delete-then-delete implementation
 * silently targets the wrong pages while every counter still looks right.
 *
 * The refusals are equally deliberate. "Remove all pages", "keep and remove in
 * the same call", an out-of-range index and an encrypted source each have a
 * test, because each one would otherwise produce a plausible-looking file.
 *
 * @module @dsh-app/plugin-pdf/tests/pdfd-edit
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, degrees } from 'pdf-lib'
import { PdfEditRefusal, editPdf } from '../src/pdfd/edit.ts'

/** A PDF with `count` pages, each carrying its index as text for identification. */
async function makePdf(count: number, options: { rotatedFirst?: number } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  for (let index = 0; index < count; index += 1) {
    const page = pdf.addPage([200, 200])
    page.drawText(`page-${String(index)}`, { x: 20, y: 100, size: 12 })
    if (index === 0 && options.rotatedFirst !== undefined) page.setRotation(degrees(options.rotatedFirst))
  }
  pdf.setTitle('source title')
  pdf.setAuthor('source author')
  return pdf.save()
}

/** Load result bytes and answer the facts a user would check by opening it. */
async function facts(bytes: Uint8Array): Promise<{
  pageCount: number
  rotations: number[]
  title: string | undefined
  author: string | undefined
  subject: string | undefined
}> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  return {
    pageCount: pdf.getPageCount(),
    rotations: pdf.getPages().map(page => page.getRotation().angle),
    title: pdf.getTitle(),
    author: pdf.getAuthor(),
    subject: pdf.getSubject(),
  }
}

test('edit: keeping a page selection produces exactly those pages, in the order given', async () => {
  const source = await makePdf(5)
  const { bytes, summary } = await editPdf(source, { keepPages: [3, 0, 2] })
  const result = await facts(bytes)
  assert.equal(result.pageCount, 3)
  assert.deepEqual(summary.removed, [1, 4])
  assert.equal(summary.originalPageCount, 5)
  assert.equal(summary.pageCount, 3)
})

test('edit: removing pages keeps the rest and reports what went', async () => {
  const source = await makePdf(5)
  const { bytes, summary } = await editPdf(source, { removePages: [1, 3] })
  const result = await facts(bytes)
  assert.equal(result.pageCount, 3)
  assert.deepEqual(summary.removed, [1, 3])
})

test('edit: two consecutive removals target the ORIGINAL pages, not shifted indexes', async () => {
  // The failure this guards: an implementation that deletes page 1 and then
  // page 3 from a renumbered document removes original pages 1 and 4.
  const source = await makePdf(6)
  const { bytes, summary } = await editPdf(source, { removePages: [1, 3] })
  const result = await facts(bytes)
  assert.equal(result.pageCount, 4)
  assert.deepEqual(summary.removed, [1, 3])
})

test('edit: rotation applies to every page when no target list is given', async () => {
  const source = await makePdf(3)
  const { bytes, summary } = await editPdf(source, { rotate: { degrees: 90 } })
  const result = await facts(bytes)
  assert.deepEqual(result.rotations, [90, 90, 90])
  assert.deepEqual(summary.rotated, [0, 1, 2])
})

test('edit: rotation targets the RESULT page numbering after a keep selection', async () => {
  const source = await makePdf(4)
  const { bytes, summary } = await editPdf(source, { keepPages: [2, 3], rotate: { degrees: 180, pages: [1] } })
  const result = await facts(bytes)
  // Result has two pages; index 1 is the original page 3.
  assert.deepEqual(result.rotations, [0, 180])
  assert.deepEqual(summary.rotated, [1])
})

test('edit: rotation accumulates onto a page the source already turned', async () => {
  const source = await makePdf(2, { rotatedFirst: 90 })
  const { bytes } = await editPdf(source, { rotate: { degrees: 90, pages: [0] } })
  const result = await facts(bytes)
  assert.equal(result.rotations[0], 180)
})

test('edit: merging appends the other document after the edited original', async () => {
  const source = await makePdf(2)
  const other = await makePdf(3)
  const { bytes, summary } = await editPdf(source, { merge: [{ label: 'other.pdf', bytes: other }] })
  const result = await facts(bytes)
  assert.equal(result.pageCount, 5)
  assert.deepEqual(summary.merged, [{ label: 'other.pdf', pages: 3 }])
})

test('edit: a merge source can be supplied by a loader, once per entry, in order', async () => {
  const source = await makePdf(1)
  const other = await makePdf(2)
  const asked: string[] = []
  const { bytes, summary } = await editPdf(
    source,
    { merge: [{ label: 'a.pdf', bytes: new Uint8Array() }, { label: 'b.pdf', bytes: new Uint8Array() }] },
    async (label) => {
      asked.push(label)
      return other
    },
  )
  assert.deepEqual(asked, ['a.pdf', 'b.pdf'])
  assert.equal(summary.pageCount, 1 + 2 + 2)
  assert.equal((await facts(bytes)).pageCount, 5)
})

test('edit: metadata is written and the untouched fields survive', async () => {
  const source = await makePdf(1)
  const { bytes, summary } = await editPdf(source, { metadata: { title: 'new title', subject: 'a subject' } })
  const result = await facts(bytes)
  assert.equal(result.title, 'new title')
  assert.equal(result.subject, 'a subject')
  // The author was never mentioned, so the source's value is still there.
  assert.equal(result.author, 'source author')
  assert.deepEqual(summary.metadataWritten, ['title', 'subject'])
})

test('edit: the source bytes are never mutated', async () => {
  const source = await makePdf(3)
  const before = Array.from(source)
  await editPdf(source, { removePages: [0], rotate: { degrees: 90 }, metadata: { title: 'x' } })
  assert.deepEqual(Array.from(source), before)
})

test('refusal: keeping and removing in one call is refused', async () => {
  const source = await makePdf(3)
  await assert.rejects(() => editPdf(source, { keepPages: [0], removePages: [1] }), (error: unknown) => {
    assert.ok(error instanceof PdfEditRefusal)
    assert.match(error.message, /keepPages 与 removePages 不能同时使用/u)
    return true
  })
})

test('refusal: removing every page is refused, naming the page count', async () => {
  const source = await makePdf(3)
  await assert.rejects(() => editPdf(source, { removePages: [0, 1, 2] }), (error: unknown) => {
    assert.ok(error instanceof PdfEditRefusal)
    assert.match(error.message, /全部 3 页/u)
    return true
  })
})

test('refusal: an out-of-range page index is refused with the count', async () => {
  const source = await makePdf(4)
  await assert.rejects(() => editPdf(source, { removePages: [4] }), (error: unknown) => {
    assert.ok(error instanceof PdfEditRefusal)
    assert.match(error.message, /页码 4 超出范围/u)
    assert.match(error.message, /共 4 页/u)
    return true
  })
})

test('refusal: a duplicate page index is refused', async () => {
  const source = await makePdf(4)
  await assert.rejects(() => editPdf(source, { keepPages: [1, 1] }), (error: unknown) => {
    assert.ok(error instanceof PdfEditRefusal)
    assert.match(error.message, /重复/u)
    return true
  })
})

test('refusal: a non-integer page index is refused', async () => {
  const source = await makePdf(4)
  await assert.rejects(() => editPdf(source, { removePages: [1.5] }), (error: unknown) => {
    assert.ok(error instanceof PdfEditRefusal)
    assert.match(error.message, /必须是整数/u)
    return true
  })
})

test('refusal: a rotation that is not a multiple of 90 is refused', async () => {
  const source = await makePdf(2)
  await assert.rejects(
    () => editPdf(source, { rotate: { degrees: 45 as unknown as 90 } }),
    (error: unknown) => {
      assert.ok(error instanceof PdfEditRefusal)
      assert.match(error.message, /只能是 90 \/ 180 \/ 270/u)
      return true
    },
  )
})

test('refusal: an empty keywords array is refused rather than clearing silently', async () => {
  const source = await makePdf(1)
  await assert.rejects(() => editPdf(source, { metadata: { keywords: [] } }), (error: unknown) => {
    assert.ok(error instanceof PdfEditRefusal)
    assert.match(error.message, /keywords：数组不能为空/u)
    return true
  })
})

test('refusal: bytes that are not a PDF are refused with an actionable message', async () => {
  await assert.rejects(
    () => editPdf(new TextEncoder().encode('this is not a pdf'), {}),
    (error: unknown) => {
      assert.ok(error instanceof PdfEditRefusal)
      assert.match(error.message, /不是有效的 PDF/u)
      return true
    },
  )
})

test('refusal: a merge source that is not a PDF names the offending file', async () => {
  const source = await makePdf(1)
  await assert.rejects(
    () => editPdf(source, { merge: [{ label: 'broken.pdf', bytes: new TextEncoder().encode('nope') }] }),
    (error: unknown) => {
      assert.ok(error instanceof PdfEditRefusal)
      assert.match(error.message, /merge：broken\.pdf/u)
      return true
    },
  )
})
