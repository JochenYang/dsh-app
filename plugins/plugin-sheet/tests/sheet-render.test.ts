/**
 * End-to-end sheet authoring through the host tools: a fake plugin context
 * captures the registered tools, a fake execution context supplies the
 * session's workspace, and the real workflow runs
 * sheet_write → sheet_check → sheet_render on a temp workspace.
 *
 * The produced .xlsx is asserted at two levels: the ZIP member list and XML
 * (real parts, real shared strings, a native formula cell, a frozen view), and
 * a read-back through exceljs (worksheet names, header style and fill, column
 * width, number format, formula). Refusal paths are pinned too: an invalid
 * document never reaches disk, and a failing render never leaves an .xlsx.
 *
 * @module @dsh-app/plugin-sheet/tests/sheet-render
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Workbook } from 'exceljs'
import { apply } from '../src/index.ts'
import { installSkill, skillFilePath } from '../src/skill.ts'

// apply() mounts the mode store and the skill installer under $DSH_HOME, so the
// whole file runs against a throwaway home.
const dshHome = mkdtempSync(join(tmpdir(), 'sheet-dsh-home-'))
process.env['DSH_HOME'] = dshHome
after(() => { rmSync(dshHome, { recursive: true, force: true }) })

interface RegisteredTool {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>
}

/** Fake host context: captures tool registrations and accepts the rest. */
function fakeHost(): { ctx: unknown, tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>()
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect: (fn: () => unknown) => {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    tools: {
      register: (definition: RegisteredTool) => {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  }
  return { ctx, tools }
}

/** The kernel execution identity the tools read cwd/session from. */
function execFor(cwd: string, sessionId = 'sheet-test-session'): unknown {
  return {
    agent: { session: { header: { id: sessionId, cwd } } },
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

/** ZIP member names and contents, walking the local file headers. */
function readZip(bytes: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(bytes)
  const entries = new Map<string, string>()
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const dataStart = offset + 30 + nameLength + extraLength
    if ((flags & 0x08) === 0) {
      const raw = buffer.subarray(dataStart, dataStart + compressedSize)
      entries.set(name, method === 0 ? raw.toString('utf8') : inflateRawSync(raw).toString('utf8'))
      offset = dataStart + compressedSize
    } else {
      // Data descriptor: the payload size follows the payload, so hop to the
      // next local header signature.
      let next = dataStart
      while (next < buffer.length && buffer.readUInt32LE(next) !== 0x04034b50) next += 1
      offset = next
    }
  }
  return entries
}

/** The document the render test authors: two sheets, one formula per dialect. */
function sampleDocument(): Record<string, unknown> {
  return {
    title: '测试工作簿',
    sheets: [
      {
        name: '月度营收',
        columns: [
          { header: '月份' },
          { header: '营收（万元）', width: 14, numberFormat: '#,##0' },
          { header: '同比', numberFormat: '0.0%' },
        ],
        rows: [['1 月', 1280, 0.128], ['2 月', 1050, 0.083], [null, null, null]],
        formulas: { B4: '=SUM(B2:B3)', R4C3: '=AVERAGE(C2:C3)' },
      },
      {
        name: '备注',
        columns: [{ header: '说明' }],
        rows: [['示例数据，来源：用户材料']],
      },
    ],
  }
}

test('sheet tools: write, check and render produce a native editable xlsx', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sheet-render-'))
  try {
    const { ctx, tools } = fakeHost()
    apply(ctx as unknown as Context)
    assert.deepEqual([...tools.keys()].sort(), ['sheet_check', 'sheet_render', 'sheet_write'])

    const exec = execFor(dir)
    const write = tools.get('sheet_write')
    const check = tools.get('sheet_check')
    const render = tools.get('sheet_render')
    assert.ok(write !== undefined && check !== undefined && render !== undefined)

    const document = sampleDocument()
    const content = JSON.stringify(document, null, 2)
    const written = await write.execute({ file_path: 'tables/q1.sheet.json', content }, exec)
    assert.equal(written['status'], 'written')
    assert.equal(written['sheetCount'], 2)
    assert.equal(written['rowCount'], 4)
    assert.equal(written['formulaCount'], 2)
    assert.match(String(written['sha256']), /^[0-9a-f]{64}$/u)
    assert.ok(existsSync(join(dir, 'tables', 'q1.sheet.json')))
    assert.equal(written['warningCount'], 0)

    const checked = await check.execute({ file_path: 'tables/q1.sheet.json' }, exec)
    assert.equal(checked['status'], 'pass')
    assert.equal(checked['digest'], written['sha256'])

    const refused = await render.execute({ file_path: 'tables/q1.sheet.json', output_file: 'tables/q1.csv' }, exec)
    assert.equal(refused['status'], 'needs_revision')

    const exported = await render.execute({ file_path: 'tables/q1.sheet.json', output_file: 'tables/q1.xlsx' }, exec)
    assert.equal(exported['status'], 'exported')
    assert.equal(exported['outputPath'], 'tables/q1.xlsx')
    assert.equal(exported['sheetCount'], 2)
    assert.equal(exported['rowCount'], 4)
    assert.equal(exported['formulaCount'], 2)
    assert.ok(Number(exported['sizeBytes']) > 5_000)
    assert.match(String(exported['sha256']), /^[0-9a-f]{64}$/u)

    const xlsxPath = join(dir, 'tables', 'q1.xlsx')
    assert.ok(existsSync(xlsxPath), 'xlsx written to the workspace')
    // The tmp file used for the atomic rename must not survive.
    assert.ok(!existsSync(`${xlsxPath}.${process.pid}.tmp`))

    // --- ZIP / XML level: real parts, real shared strings, real formulas -----
    const entries = readZip(await readFileBytes(xlsxPath))
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml',
      'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
      assert.ok(entries.has(part), `xlsx contains ${part}`)
    }
    const sharedStrings = entries.get('xl/sharedStrings.xml') ?? ''
    for (const text of ['月份', '营收（万元）', '同比', '示例数据，来源：用户材料']) {
      assert.ok(sharedStrings.includes(text), `shared strings keep ${text}`)
    }
    const sheetXml = entries.get('xl/worksheets/sheet1.xml') ?? ''
    assert.ok(sheetXml.includes('<f>SUM(B4:B5)</f>'), 'native formula cell survives as a formula, shifted by the caption block')
    assert.ok(sheetXml.includes('<f>AVERAGE(C4:C5)</f>'), 'R1C1 key resolved to the same native formula, shifted too')
    assert.ok(sheetXml.includes('frozen'), 'frozen first row is written')
    const workbookXml = entries.get('xl/workbook.xml') ?? ''
    assert.ok(workbookXml.includes('月度营收') && workbookXml.includes('备注'), 'both sheet names reach the workbook part')

    // --- semantic read-back through exceljs ---------------------------------
    // exceljs types its own `Buffer extends ArrayBuffer`, while the runtime
    // reads a Node Buffer fine; the cast bridges the declaration, not behavior.
    const wb = new Workbook()
    await wb.xlsx.load(await readFileBytes(xlsxPath) as unknown as ArrayBuffer)
    assert.equal(wb.title, '测试工作簿')
    const sheet = wb.getWorksheet('月度营收')
    assert.ok(sheet !== undefined)
    // Caption block: title (row 1), spacer (row 2), then the styled header (row 3).
    assert.equal(sheet.getRow(1).getCell(1).value, '测试工作簿')
    assert.equal(sheet.getRow(1).getCell(1).font.size, 14)
    assert.equal(sheet.getRow(3).getCell(1).value, '月份')
    assert.equal(sheet.getRow(3).getCell(1).font.bold, true)
    const headerFill = sheet.getRow(3).getCell(1).fill as { fgColor?: { argb?: string } }
    assert.equal(headerFill.fgColor?.argb, 'FFF1F5F9')
    assert.equal(sheet.getColumn(2).width, 14)
    assert.equal(sheet.getCell('B4').value, 1280)
    assert.equal(sheet.getCell('B4').numFmt, '#,##0')
    assert.equal(sheet.getCell('C4').numFmt, '0.0%')
    // Formulas keep their document coordinates but land below the caption block.
    const formulaCell: unknown = sheet.getCell('B6').value
    assert.ok(typeof formulaCell === 'object' && formulaCell !== null && 'formula' in formulaCell)
    assert.equal((formulaCell as { formula: string }).formula, 'SUM(B4:B5)')
    const averageCell: unknown = sheet.getCell('C6').value
    assert.ok(typeof averageCell === 'object' && averageCell !== null && 'formula' in averageCell)
    assert.equal((averageCell as { formula: string }).formula, 'AVERAGE(C4:C5)')
    assert.ok(sheet.views.some(view => view.state === 'frozen' && view.ySplit === 3), 'caption block plus header row is frozen')
    const second = wb.getWorksheet('备注')
    assert.ok(second !== undefined)
    assert.equal(second.getRow(4).getCell(1).value, '示例数据，来源：用户材料')

    // --- the skill half installed under the throwaway $DSH_HOME -------------
    await installSkill(dshHome)
    assert.ok(existsSync(skillFilePath(dshHome)))
    assert.equal(await installSkill(dshHome), 'unchanged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sheet_write: an invalid document is refused and never reaches disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sheet-refuse-'))
  try {
    const { ctx, tools } = fakeHost()
    apply(ctx as unknown as Context)
    const exec = execFor(dir)
    const write = tools.get('sheet_write')
    assert.ok(write !== undefined)

    const invalid = sampleDocument()
    ;(invalid['sheets'] as Record<string, unknown>[])[0]!['rows'] = [['1 月', 1280, 0.128], ['2 月']]
    const refused = await write.execute({ file_path: 'bad.sheet.json', content: JSON.stringify(invalid) }, exec)
    assert.equal(refused['status'], 'needs_revision')
    assert.ok(Number(refused['errorCount']) >= 1)
    assert.match(String(refused['issuesText']), /row-width/u)
    assert.match(String(refused['issuesText']), /第 3 行/u)
    assert.ok(!existsSync(join(dir, 'bad.sheet.json')), 'nothing was written for an invalid document')

    // A malformed JSON text fails before any parse of the document.
    const broken = await write.execute({ file_path: 'bad.sheet.json', content: '{ nope' }, exec)
    assert.equal(broken['status'], 'needs_revision')
    assert.match(String((broken['issues'] as { message: string }[])[0]?.message), /不是合法 JSON/u)

    // Replacing an existing file requires the revision SHA.
    const valid = await write.execute({ file_path: 'ok.sheet.json', content: JSON.stringify(sampleDocument()) }, exec)
    assert.equal(valid['status'], 'written')
    const noSha = await write.execute({ file_path: 'ok.sheet.json', content: JSON.stringify(sampleDocument()) }, exec)
    assert.equal(noSha['status'], 'needs_revision')
    assert.match(String((noSha['issues'] as { message: string }[])[0]?.message), /expected_sha256/u)
    const withSha = await write.execute({
      file_path: 'ok.sheet.json',
      content: JSON.stringify(sampleDocument()),
      expected_sha256: valid['sha256'],
    }, exec)
    assert.equal(withSha['status'], 'written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sheet_render: an on-disk document that fails the check exports nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sheet-gate-'))
  try {
    const { ctx, tools } = fakeHost()
    apply(ctx as unknown as Context)
    const exec = execFor(dir)
    const render = tools.get('sheet_render')
    const check = tools.get('sheet_check')
    assert.ok(render !== undefined && check !== undefined)

    const invalid = sampleDocument()
    ;(invalid['sheets'] as Record<string, unknown>[])[0]!['formulas'] = { B9: '=SUM(B2:B3)' }
    writeFileSync(join(dir, 'gate.sheet.json'), JSON.stringify(invalid), 'utf8')

    const checked = await check.execute({ file_path: 'gate.sheet.json' }, exec)
    assert.equal(checked['status'], 'needs_revision')
    assert.match(String(checked['issuesText']), /formula-out-of-range/u)

    const refused = await render.execute({ file_path: 'gate.sheet.json', output_file: 'gate.xlsx' }, exec)
    assert.equal(refused['status'], 'needs_revision')
    // formula-out-of-range plus the now-unbacked all-null placeholder row.
    assert.ok(Number(refused['errorCount']) >= 1)
    assert.ok(!existsSync(join(dir, 'gate.xlsx')), 'no xlsx is left behind when the check fails')

    // The path fence refuses escapes instead of writing outside the workspace.
    const escape = await render.execute({ file_path: 'gate.sheet.json', output_file: '../gate.xlsx' }, exec)
    assert.equal(escape['status'], 'needs_revision')
    assert.match(String((escape['issues'] as { message: string }[])[0]?.message), /越出工作区/u)
    const absolute = await render.execute({
      file_path: 'gate.sheet.json',
      output_file: join(dir, 'abs.xlsx'),
    }, exec)
    assert.equal(absolute['status'], 'needs_revision')
    assert.match(String((absolute['issues'] as { message: string }[])[0]?.message), /工作区相对路径/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Read a file as bytes (kept as a helper so the zip reader stays pure). */
async function readFileBytes(file: string): Promise<Buffer> {
  return readFileSync(file)
}
