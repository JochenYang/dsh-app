/**
 * DOC → .docx rendering: a real document (headings, paragraph, bullets, table,
 * embedded picture) is validated, rendered, and the produced .docx is unzipped
 * and asserted at the OOXML level — Word heading styles, editable text runs, a
 * native table, a numbering reference for the list, and the embedded media part
 * with its relationship. Also pins the render gate: a referenced image that is
 * not in the workspace refuses the export instead of producing a document with
 * a hole in it.
 *
 * @module @dsh-app/plugin-doc/tests/docd-render
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDocDocument, loadDocDocument } from '../src/docd/check.ts'
import { imageSizeOf } from '../src/docd/image-size.ts'
import { renderDocProject } from '../src/docd/render.ts'
import { columnWidthsTwips, CONTENT_WIDTH_TWIPS, MIN_COLUMN_RATIO, PAGE } from '../src/docd/styles.ts'
import { isZip, readZipEntries } from './zip.ts'

/** A valid 1×1 PNG, the smallest real picture the embedder can read. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** The full-featured sample project used by the render assertions. */
function sampleDocument(): Record<string, unknown> {
  return {
    title: '二〇二六年第一季度评审',
    author: '增长组',
    sections: [
      { heading: { level: 1, text: '核心结论' } },
      { paragraph: { text: '本季度核心指标全面达标。', bold: true } },
      { paragraph: { text: '以下数据来自内部报表。', italic: true } },
      { bullets: ['营收同比增长 22%', '毛利率提升 3.3 个百分点'] },
      { heading: { level: 2, text: '关键指标' } },
      { table: { headers: ['指标', '本期', '上期'], rows: [['营收', '1,280 万', '1,050 万'], ['毛利率', '34.5%', '31.2%']] } },
      { image: { path: 'assets/pixel.png' } },
    ],
  }
}

test('render: a full document exports native OOXML parts and stays editable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docd-render-'))
  try {
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'assets', 'pixel.png'), ONE_PIXEL_PNG)

    const { project, issues } = loadDocDocument(sampleDocument())
    assert.equal(issues.length, 0, `sample must be clean: ${JSON.stringify(issues)}`)
    assert.equal(checkDocDocument(sampleDocument()).status, 'pass')

    const bytes = await renderDocProject(project, { workspaceRoot: root })
    assert.ok(bytes.byteLength > 4_000, 'a non-trivial docx is produced')
    assert.ok(isZip(bytes), 'output is a zip container')

    const entries = readZipEntries(bytes)
    for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/_rels/document.xml.rels']) {
      assert.ok(entries.has(part), `OOXML part present: ${part}`)
    }
    const document = entries.get('word/document.xml') ?? ''
    assert.ok(document.length > 0, 'document body present')

    // Editable text: every source string is a text run, not an image.
    for (const text of [
      '二〇二六年第一季度评审',
      '增长组',
      '核心结论',
      '本季度核心指标全面达标。',
      '以下数据来自内部报表。',
      '营收同比增长 22%',
      '毛利率提升 3.3 个百分点',
      '营收',
      '1,280 万',
    ]) {
      assert.ok(document.includes(text), `editable run present: ${text}`)
    }

    // Native heading styles the user can restyle from Word's style gallery.
    assert.match(document, /w:pStyle w:val="Heading1"/u)
    assert.match(document, /w:pStyle w:val="Heading2"/u)
    assert.match(document, /w:pStyle w:val="Title"/u)
    // Bold and italic runs are real run properties.
    assert.match(document, /<w:b\/>/u)
    assert.match(document, /<w:i\/>/u)

    // Bullet list: a native numbering reference, not literal "·" prefixes.
    assert.match(document, /<w:numPr>/u)
    assert.ok(entries.has('word/numbering.xml'), 'numbering part present')

    // Table: a native <w:tbl> with two data rows plus the header row.
    assert.match(document, /<w:tbl>/u)
    const rows = [...document.matchAll(/<w:tr[ >]/gu)]
    assert.equal(rows.length, 3, 'header row + two data rows')

    // Picture: embedded media part plus a drawing anchor in the body. docx
    // names media parts by content hash, so the assertion matches the pattern.
    const media = [...entries.keys()].filter(name => /^word\/media\/.+\.png$/u.test(name))
    assert.equal(media.length, 1, `one embedded png part (got ${media.join(', ')})`)
    assert.match(document, /<w:drawing>/u)
    assert.match(entries.get('word/_rels/document.xml.rels') ?? '', /media\//u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** The `<w:style … w:styleId="id">…</w:style>` fragment of a stylesheet, or ''. */
function styleFragment(styles: string, id: string): string {
  const marker = `w:styleId="${id}"`
  const start = styles.indexOf(marker)
  if (start < 0) return ''
  const end = styles.indexOf('</w:style>', start)
  return styles.slice(start, end < 0 ? undefined : end)
}

test('render: the exported package carries the formal Chinese office typography', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docd-typography-'))
  try {
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'assets', 'pixel.png'), ONE_PIXEL_PNG)
    const source = {
      title: '二〇二六年第一季度评审',
      subtitle: '增长组内部评审材料',
      author: '增长组',
      date: '2026-04-10',
      sections: [
        { heading: { level: 1, text: '核心结论' } },
        { paragraph: { text: '本季度核心指标全面达标。' } },
        { bullets: ['营收同比增长 22%', '毛利率提升 3.3 个百分点'] },
        { heading: { level: 2, text: '关键指标' } },
        { table: { headers: ['指标', '本期', '上期'], rows: [['营收', '1,280 万', '1,050 万'], ['毛利率', '34.5%', '31.2%']] } },
        { image: { path: 'assets/pixel.png' } },
      ],
    }
    assert.equal(checkDocDocument(source).status, 'pass', 'the typography sample is a clean project')
    const { project } = loadDocDocument(source)
    const bytes = await renderDocProject(project, { workspaceRoot: root })

    // Land the artifact on disk and assert on the bytes actually written.
    const file = join(root, 'report.docx')
    writeFileSync(file, bytes)
    const entries = readZipEntries(readFileSync(file))
    const document = entries.get('word/document.xml') ?? ''
    const styles = entries.get('word/styles.xml') ?? ''
    assert.ok(document.length > 0, 'document.xml written')
    assert.ok(styles.length > 0, 'styles.xml written')

    // Page: A4 with 2.54cm top/bottom and 3.17cm left/right (twips).
    assert.match(document, new RegExp(`<w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"`, 'u'))
    assert.match(document, new RegExp(`<w:pgMar[^>]*w:top="${PAGE.margin.top}"`, 'u'))
    assert.match(document, new RegExp(`<w:pgMar[^>]*w:bottom="${PAGE.margin.bottom}"`, 'u'))
    assert.match(document, new RegExp(`<w:pgMar[^>]*w:left="${PAGE.margin.left}"`, 'u'))
    assert.match(document, new RegExp(`<w:pgMar[^>]*w:right="${PAGE.margin.right}"`, 'u'))

    // Typography defaults: CJK font, dark slate ink, 11pt, 1.5-line spacing.
    assert.match(styles, /<w:rPrDefault>[\s\S]*?w:eastAsia="等线"/u)
    assert.match(styles, /<w:rPrDefault>[\s\S]*?<w:sz w:val="22"\/>/u)
    assert.match(styles, /<w:rPrDefault>[\s\S]*?w:color w:val="1F2937"/u)
    assert.match(styles, /<w:pPrDefault>[\s\S]*?w:line="360"/u)
    assert.match(styles, /<w:pPrDefault>[\s\S]*?w:after="120"/u)

    // Size ladder: 22 / 18 / 15 / 13 pt headings, an 11pt table header over
    // 10pt table data, muted metadata, and no Word-default blue on any heading.
    const ladder: [string, string][] = [
      ['Title', '44'],
      ['Heading1', '36'],
      ['Heading2', '30'],
      ['Heading3', '26'],
      ['DocSubtitle', '28'],
      ['DocBody', '22'],
      ['DocTableHeader', '22'],
      ['DocTableNumberHeader', '22'],
      ['DocTableNumber', '20'],
      ['DocMeta', '18'],
    ]
    for (const [id, size] of ladder) {
      const fragment = styleFragment(styles, id)
      assert.ok(fragment.length > 0, `style ${id} is defined`)
      assert.match(fragment, new RegExp(`<w:sz w:val="${size}"/>`, 'u'), `${id} is ${size} half-points`)
    }
    for (const heading of ['Heading1', 'Heading2', 'Heading3']) {
      const fragment = styleFragment(styles, heading)
      assert.match(fragment, /w:color w:val="1F2937"/u, `${heading} uses dark ink`)
      assert.doesNotMatch(fragment, /2E74B5/u, `${heading} is not Word's default blue`)
      assert.match(fragment, /<w:spacing w:after="120" w:before="240"\/>/u, `${heading} has 12pt/6pt spacing`)
    }
    assert.match(styleFragment(styles, 'Title'), /<w:b\/>/u, 'the document title is bold')
    assert.match(styleFragment(styles, 'DocBody'), /w:line="360"/u, 'body runs at 1.5 lines')
    assert.match(styleFragment(styles, 'DocBody'), /w:after="120"/u, 'body has 6pt paragraph spacing')
    assert.match(styleFragment(styles, 'DocMeta'), /w:color w:val="6B7280"/u, 'metadata is muted gray')

    // Elements wear the styles; only structure and geometry are set per element.
    assert.match(document, /w:pStyle w:val="Heading1"/u)
    assert.match(document, /w:pStyle w:val="Heading2"/u)
    assert.match(document, /w:pStyle w:val="DocSubtitle"/u)
    assert.match(document, /w:pStyle w:val="DocBody"/u)
    assert.match(document, /<w:rStyle w:val="DocMeta"\/>/u)
    assert.ok(document.includes('增长组 · 2026-04-10'), 'the metadata line joins author and date')
    assert.ok(document.includes('增长组内部评审材料'), 'the subtitle is a real paragraph')
    assert.match(document, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr>/u, 'list items keep a numbering reference')
    assert.match(document, /w:pStyle w:val="DocFigure"\/>/u, 'the picture paragraph is centered by style')

    // List indentation is owned by the numbering level, not a paragraph style.
    const numbering = entries.get('word/numbering.xml') ?? ''
    assert.ok(numbering.length > 0, 'numbering.xml written')
    assert.match(numbering, /<w:ind w:left="420" w:hanging="210"\/>/u, 'list indent is 0.74cm')

    // Table: horizontal rules only. docx draws a default `single` border on any
    // edge it is not told about, so the outer frame and the vertical lines are
    // declared `none`; the single drawn rule is the 0.5pt row hairline. The
    // header underline is a 1.5pt rule on the header cells.
    const tableBorders = /<w:tblBorders>[\s\S]*?<\/w:tblBorders>/u.exec(document)?.[0] ?? ''
    assert.ok(tableBorders.length > 0, 'tblBorders is written')
    assert.match(tableBorders, /<w:insideH w:val="single" w:color="E2E8F0" w:sz="4"\/>/u)
    for (const edge of ['top', 'bottom', 'left', 'right', 'insideV']) {
      assert.match(tableBorders, new RegExp(`<w:${edge} w:val="none"`, 'u'), `${edge} is not drawn`)
    }
    const rows = [...document.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/gu)].map(match => match[0])
    assert.equal(rows.length, 3, 'header + two data rows')
    assert.match(rows[0] ?? '', /<w:bottom w:val="single" w:color="334155" w:sz="12"\/>/u, 'the header has a medium bottom rule')
    for (const row of rows.slice(1)) {
      assert.doesNotMatch(row, /<w:tcBorders>/u, 'data cells carry no cell-level borders')
    }
    assert.match(document, /w:fill="F1F5F9"/u)
    assert.match(document, /w:tblLayout w:type="fixed"/u)
    assert.match(document, /<w:tcMar>/u)
    assert.match(document, /<w:tcMar>[\s\S]*?<w:left w:type="dxa" w:w="120"/u)
    assert.match(document, /w:pStyle w:val="DocTableHeader"/u)
    const grid = [...document.matchAll(/<w:gridCol w:w="(\d+)"/gu)].map(match => Number(match[1]))
    assert.equal(grid.length, 3, 'one grid column per header')
    assert.equal(grid.reduce((sum, width) => sum + width, 0), CONTENT_WIDTH_TWIPS, 'columns fill the content width')
    for (const width of grid) {
      assert.ok(width >= Math.floor(CONTENT_WIDTH_TWIPS * MIN_COLUMN_RATIO), `column ${width} respects the ${MIN_COLUMN_RATIO * 100}% floor`)
    }

    // Footer: real PAGE and NUMPAGES fields, centered, "第 N 页 共 M 页".
    const footerName = [...entries.keys()].find(name => /^word\/footer\d*\.xml$/u.test(name))
    assert.ok(footerName !== undefined, 'a footer part is exported')
    const footer = entries.get(footerName) ?? ''
    assert.match(footer, /<w:instrText[^>]*>PAGE<\/w:instrText>/u)
    assert.match(footer, /<w:instrText[^>]*>NUMPAGES<\/w:instrText>/u, 'the footer counts the total pages too')
    assert.match(footer, /<w:jc w:val="center"\/>/u)
    for (const text of ['第 ', ' 页 共 ', ' 页']) {
      assert.ok(footer.includes(text), `footer carries the label text ${JSON.stringify(text)}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render: body prose is justified with a two-character first-line indent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docd-body-'))
  try {
    const source = {
      title: '正文档式',
      author: '排版组',
      sections: [
        { heading: { level: 1, text: '核心结论' } },
        { paragraph: { text: '本季度核心指标全面达标。' } },
        { paragraph: { text: '以下数据来自内部报表。' } },
        { bullets: ['营收同比增长 22%'] },
        { table: { headers: ['指标', '本期'], rows: [['营收', '1,280 万']] } },
      ],
    }
    assert.equal(checkDocDocument(source).status, 'pass', 'the body sample is a clean project')
    const { project } = loadDocDocument(source)
    const bytes = await renderDocProject(project, { workspaceRoot: root })
    const entries = readZipEntries(bytes)
    const document = entries.get('word/document.xml') ?? ''
    const styles = entries.get('word/styles.xml') ?? ''

    // The DocBody style owns the geometry (paragraph styles live in styles.xml)…
    const body = styleFragment(styles, 'DocBody')
    assert.ok(body.length > 0, 'DocBody style is defined')
    assert.match(body, /<w:ind w:firstLine="420"\/>/u, 'DocBody indents its first line by two characters')
    assert.match(body, /<w:jc w:val="both"\/>/u, 'DocBody is justified')

    // …and the exported body states it on every body paragraph as well.
    const paragraphs = [...document.matchAll(/<w:p>(.*?)<\/w:p>/gsu)].map(match => match[1] ?? '')
    const prose = paragraphs.filter(paragraph => paragraph.includes('w:val="DocBody"'))
    assert.equal(prose.length, 2, 'one DocBody paragraph per paragraph block')
    for (const paragraph of prose) {
      assert.match(paragraph, /<w:ind w:firstLine="420"\/>/u, 'the body paragraph carries the indent itself')
      assert.match(paragraph, /<w:jc w:val="both"\/>/u, 'the body paragraph carries the justification itself')
    }

    // Headings, list items, table cells and metadata keep their own geometry.
    for (const paragraph of paragraphs) {
      if (paragraph.includes('w:val="DocBody"')) continue
      assert.doesNotMatch(paragraph, /w:firstLine/u, `no first-line indent outside DocBody: ${paragraph}`)
      assert.doesNotMatch(paragraph, /<w:jc w:val="both"\/>/u, `no justification outside DocBody: ${paragraph}`)
    }
    const numbering = entries.get('word/numbering.xml') ?? ''
    assert.doesNotMatch(numbering, /w:firstLine/u, 'the list indent stays left+hanging only')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render: an image that is not in the workspace refuses the export', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docd-render-missing-'))
  try {
    const { project, issues } = loadDocDocument({
      title: '缺图',
      sections: [{ image: { path: 'assets/absent.png' } }],
    })
    assert.equal(issues.length, 0)
    await assert.rejects(
      () => renderDocProject(project, { workspaceRoot: root }),
      /图片块引用无法读取/u,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render: numeric columns align right and a totals row is marked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docd-table-'))
  try {
    const { project, issues } = loadDocDocument({
      title: '季度数据',
      author: '增长组',
      sections: [
        { heading: { level: 1, text: '关键指标' } },
        {
          table: {
            headers: ['项目', '本期', '增长率'],
            rows: [
              ['营收', '1280', '0.128'],
              ['成本', '1050.5', '0.052'],
              ['合计', '2330.5', '0.18'],
            ],
          },
        },
      ],
    })
    assert.equal(issues.filter(issue => issue.severity === 'error').length, 0, 'the sample has no errors')

    const bytes = await renderDocProject(project, { workspaceRoot: root })
    const entries = readZipEntries(bytes)
    const document = entries.get('word/document.xml') ?? ''
    const styles = entries.get('word/styles.xml') ?? ''

    // Same-column precision: 0- and 1-decimal values both render at one decimal.
    for (const text of ['1,280.0', '1,050.5', '2,330.5']) {
      assert.ok(document.includes(text), `number formatted: ${text}`)
    }
    // A ratio column reads as a percent at one decimal (0.18 → 18.0%).
    for (const text of ['12.8%', '5.2%', '18.0%']) {
      assert.ok(document.includes(text), `percent formatted: ${text}`)
    }
    assert.ok(document.includes('营收'), 'the text column stays as authored')

    // Numeric data and headers right-align by style; the text column stays left.
    assert.match(styleFragment(styles, 'DocTableNumber'), /<w:jc w:val="right"\/>/u)
    assert.match(styleFragment(styles, 'DocTableNumberHeader'), /<w:jc w:val="right"\/>/u)
    assert.doesNotMatch(styleFragment(styles, 'DocTableText'), /<w:jc w:val="right"\/>/u)
    assert.match(document, /w:pStyle w:val="DocTableNumber"\/>/u, 'numeric cells wear the right-aligned style')
    assert.match(document, /w:pStyle w:val="DocTableNumberHeader"\/>/u, 'numeric headers right-align too')
    assert.match(document, /w:pStyle w:val="DocTableText"\/>/u, 'the text column keeps its style')

    // Totals row: bold, weak indigo fill, 1.5pt overline — data rows have none.
    const rows = [...document.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/gu)].map(match => match[0])
    assert.equal(rows.length, 4, 'header + three body rows')
    const total = rows[3] ?? ''
    assert.match(total, /<w:top w:val="single" w:color="334155" w:sz="12"\/>/u, 'the totals row has a medium top rule')
    assert.match(total, /w:fill="EEF2FF"/u, 'the totals row carries the weak fill')
    assert.match(total, /<w:b\/>/u, 'the totals row is bold')
    for (const row of rows.slice(1, 3)) {
      assert.doesNotMatch(row, /<w:tcBorders>/u, 'data rows carry no cell-level rules')
      assert.doesNotMatch(row, /w:fill="EEF2FF"/u, 'data rows are not filled')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render: a CJK column is wider than a same-character-count ASCII column', () => {
  const widths = columnWidthsTwips(['指标', 'ID'], [['营收', '1280']], CONTENT_WIDTH_TWIPS)
  assert.equal(widths.length, 2)
  assert.ok((widths[0] ?? 0) > (widths[1] ?? 0), `CJK column ${widths[0]} is wider than ASCII ${widths[1]}`)
  assert.equal(widths.reduce((sum, width) => sum + width, 0), CONTENT_WIDTH_TWIPS, 'widths fill the content width')
})

test('render: image headers give the embedder its intrinsic size', () => {
  assert.deepEqual(imageSizeOf(ONE_PIXEL_PNG), { width: 1, height: 1 })
  assert.equal(imageSizeOf(Buffer.from('not an image')), undefined)
  assert.equal(imageSizeOf(Buffer.alloc(0)), undefined)
})
