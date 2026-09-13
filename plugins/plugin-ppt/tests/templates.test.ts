/**
 * The bundled template catalog: structure, base template plus colorways per
 * category, metadata integrity, zone→point conversion with textCapacity,
 * zone/.page reciprocity, the standalone geometry family's check+render
 * acceptance, and cover preview assets within the picker's size budget.
 *
 * @module @dsh-app/plugin-ppt/tests/templates
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  allTemplates,
  DEFAULT_TEMPLATE_ID,
  PPTD_CANVAS,
  pptdZone,
  templateById,
  templateCoverBytes,
  templateDesignDocument,
  templatePageSourcePath,
  toPointLength,
  TEMPLATE_CATEGORIES,
} from '../src/templates.ts'
import { loadPptdProject } from '../src/pptd/load.ts'
import { checkPptdProject } from '../src/pptd/check.ts'
import { renderPptdProject } from '../src/pptd/render.ts'
import { parseYaml } from '../src/pptd/parse.ts'

/**
 * The standalone geometry family: `dsh-slate-grid` and its colorway variants.
 * Every id here must check clean and render, and each variant must reuse the
 * base page geometry verbatim.
 */
const GRID_FAMILY_BASE = 'dsh-slate-grid'
const GRID_FAMILY_IDS = [
  'dsh-slate-grid',
  'dsh-teal-counsel',
  'dsh-amber-weekly',
  'dsh-indigo-study',
  'dsh-plum-review',
  'dsh-coral-bill',
] as const

test('catalog: every category ships several templates with 12-page indexes and zh names', async () => {
  const entries = await allTemplates()
  const categories = new Set(entries.map(entry => entry.meta.category))
  for (const category of TEMPLATE_CATEGORIES) assert.ok(categories.has(category), `category ${category} present`)
  for (const { meta } of entries) {
    assert.equal(meta.pages.length, 12)
    assert.ok(meta.name.length > 0, `zh display name for ${meta.id}`)
    assert.ok(meta.palette.background.length > 0)
    assert.ok(meta.layoutFamilies.length >= 3, `${meta.id} spans multiple layout families`)
    assert.ok(meta.fonts.zh.title.length > 0 && meta.fonts.zh.body.length > 0)
  }
})

test('catalog: integrity — unique ids, required metadata keys, per-category counts', async () => {
  const entries = await allTemplates()
  const ids = new Set<string>()
  const perCategory = new Map<string, number>(TEMPLATE_CATEGORIES.map(category => [category, 0]))
  const requiredKeys = [
    'id', 'category', 'name', 'nameEn', 'description', 'fonts', 'palette', 'width', 'height',
    'designSummary', 'visualGrammar', 'recommendedDensity', 'layoutFamilies', 'pages',
  ]
  for (const { meta } of entries) {
    assert.ok(!ids.has(meta.id), `template id ${meta.id} is unique`)
    ids.add(meta.id)
    perCategory.set(meta.category, (perCategory.get(meta.category) ?? 0) + 1)
    const record = meta as unknown as Record<string, unknown>
    for (const key of requiredKeys) {
      assert.ok(record[key] !== undefined && record[key] !== null, `${meta.id} carries ${key}`)
    }
    assert.ok(meta.name.length > 0 && meta.nameEn.length > 0 && meta.description.length > 0, `${meta.id} display fields non-empty`)
    const palette = meta.palette as unknown as Record<string, unknown>
    for (const key of ['background', 'text', 'accent', 'surface', 'secondary', 'muted']) {
      const value = palette[key]
      assert.ok(typeof value === 'string' && /^[0-9a-fA-F]{6}$/.test(value), `${meta.id} palette.${key} is a hex color`)
    }
    assert.ok(meta.width === 1280 && meta.height === 720, `${meta.id} reference canvas is 1280x720`)
    assert.ok(meta.designSummary.length > 200, `${meta.id} carries a design summary`)
    for (const page of meta.pages) {
      assert.ok(Number.isInteger(page.slideNumber) && page.slideNumber >= 1, `${meta.id} page numbering`)
      assert.ok(Array.isArray(page.zones) && page.zones.length > 0, `${meta.id} page ${page.slideNumber} exposes zones`)
      assert.ok(page.family.length > 0 && page.structureSummary.length > 0, `${meta.id} page ${page.slideNumber} described`)
    }
  }
  for (const category of TEMPLATE_CATEGORIES) {
    assert.ok((perCategory.get(category) ?? 0) >= 4, `category ${category} carries its base plus colorways`)
  }
})

test('catalog: each template ships 12 source pages and 12 preview frames matching its page index', async () => {
  for (const entry of await allTemplates()) {
    const sourcePages = (await readdir(join(entry.dir, 'source-zh', 'pages'))).filter(name => name.endsWith('.page'))
    const previews = (await readdir(join(entry.dir, 'pages'))).filter(name => name.endsWith('.jpg'))
    assert.equal(entry.meta.pages.length, 12, `${entry.meta.id} keeps the twelve-layout skeleton`)
    assert.equal(sourcePages.length, entry.meta.pages.length, `${entry.meta.id} source page count matches the index`)
    assert.equal(previews.length, entry.meta.pages.length, `${entry.meta.id} preview count matches the index`)
    for (const page of entry.meta.pages) {
      assert.ok(page.zones.length > 0, `${entry.meta.id} page ${page.slideNumber} exposes zones`)
    }
  }
})

test('catalog: the default template exists and its design document is readable', async () => {
  const entry = await templateById(DEFAULT_TEMPLATE_ID)
  assert.ok(entry !== undefined, 'default template bundled')
  const design = await templateDesignDocument(entry as NonNullable<typeof entry>)
  assert.ok(design !== undefined && design.length > 500, 'design document carries the layout grammar')
  assert.ok(design.includes('Layout grammar') || design.includes('composition'), 'design document covers composition')
})

test('catalog: zone conversion maps the 1280x720 reference space onto the 960x540 point canvas', async () => {
  assert.equal(toPointLength(1280, 'x'), PPTD_CANVAS.width)
  assert.equal(toPointLength(720, 'y'), PPTD_CANVAS.height)
  const entry = await templateById('dsh-blue-professional')
  assert.ok(entry !== undefined)
  const cover = entry.meta.pages[0]
  assert.ok(cover !== undefined)
  const zones = cover.zones.map(zone => pptdZone(zone))
  for (const zone of zones) {
    assert.ok(Number.isFinite(zone.x) && Number.isFinite(zone.y))
    assert.ok((zone.x as number) >= 0 && (zone.x as number) <= PPTD_CANVAS.width + 0.01)
    assert.ok((zone.y as number) >= 0 && (zone.y as number) <= PPTD_CANVAS.height + 0.01)
  }
  const textZones = zones.filter(zone => zone.kind === 'text' || zone.kind === 'title')
  assert.ok(textZones.length >= 2, 'cover exposes its text zones')
  for (const zone of textZones) {
    assert.ok(typeof zone.textCapacity === 'number' && (zone.textCapacity as number) >= 1)
  }
})

test('catalog: cover previews exist, stay under the picker cap and are valid JPEG', async () => {
  for (const entry of await allTemplates()) {
    const bytes = await templateCoverBytes(entry)
    assert.ok(bytes !== undefined, `cover for ${entry.meta.id}`)
    assert.ok(bytes.byteLength <= 200 * 1024, `cover of ${entry.meta.id} within cap (got ${bytes.byteLength})`)
    assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8', 'JPEG magic')
  }
})

test('catalog: every template ships a Chinese PPTD layout source project', async () => {
  for (const entry of await allTemplates()) {
    const manifest = await readFile(join(entry.dir, 'source-zh', 'deck.pptd'), 'utf8')
    assert.match(manifest, /version:\s*v2/u, `${entry.meta.id} source-zh manifest`)
    const firstPage = templatePageSourcePath(entry, 1)
    const page = await readFile(firstPage, 'utf8')
    assert.match(page, /pageType:\s*cover/u, `${entry.meta.id} source-zh first page`)
    assert.match(page, /bounds:/u, 'layout source carries point bounds')
  }
})

test('catalog: zones and .page elements stay reciprocal in geometry for every template', async () => {
  for (const entry of await allTemplates()) {
    for (const page of entry.meta.pages) {
      const text = await readFile(templatePageSourcePath(entry, page.slideNumber), 'utf8')
      const parsed = parseYaml(text, 'page', []) as Record<string, unknown> | undefined
      const elements = (parsed?.elements as Record<string, unknown>[] | undefined) ?? []
      // Lines are decoration the index does not carry; text and shape elements
      // are indexed one-to-one, in document order.
      const zoned = elements.filter((element) => element.elementType === 'text' || element.elementType === 'shape')
      assert.equal(zoned.length, page.zones.length, `${entry.meta.id} p${page.slideNumber} exposes one zone per element`)
      for (const [index, element] of zoned.entries()) {
        const zone = page.zones[index]
        assert.ok(zone !== undefined, `${entry.meta.id} p${page.slideNumber} zone ${index}`)
        const bounds = element.bounds as number[] | undefined
        assert.ok(Array.isArray(bounds) && bounds.length === 4, `${entry.meta.id} p${page.slideNumber} element ${index} bounds`)
        // Zones keep the 1280x720 reference pixel space: bounds (960x540 pt) x 4/3.
        const expected = (bounds as number[]).map((value) => value * 4 / 3)
        const got = [zone.x, zone.y, zone.width, zone.height]
        for (const axis of [0, 1, 2, 3]) {
          assert.ok(Math.abs((expected[axis] ?? 0) - (got[axis] ?? 0)) <= 0.02,
            `${entry.meta.id} p${page.slideNumber} element ${index} axis ${axis}: ${expected[axis]} vs ${got[axis]}`)
        }
        if (element.elementType === 'shape') {
          assert.equal(zone.kind, 'shape', `${entry.meta.id} p${page.slideNumber} element ${index} shape zone`)
          assert.ok(typeof zone.shape === 'string' && zone.shape.length > 0)
          assert.ok(typeof zone.fill === 'string' && /^[0-9a-f]{6}$/iu.test(zone.fill))
        } else {
          assert.ok(zone.kind === 'text' || zone.kind === 'title', `${entry.meta.id} p${page.slideNumber} element ${index} text zone`)
          assert.ok(typeof zone.textRole === 'string' && zone.textRole.length > 0)
          assert.ok(typeof zone.textCapacity === 'number' && zone.textCapacity >= 1)
        }
      }
    }
  }
})

test('catalog: the grid geometry family checks clean and renders a pptx', async () => {
  const entries = await allTemplates()
  for (const id of GRID_FAMILY_IDS) {
    const entry = entries.find((item) => item.meta.id === id)
    assert.ok(entry !== undefined, `${id} is bundled`)
    const project = await loadPptdProject(join(entry.dir, 'source-zh'))
    const check = checkPptdProject(project)
    const detail = check.issues.slice(0, 3).map((issue) => `${issue.code}(${issue.elementId ?? '-'}): ${issue.message}`).join('; ')
    assert.equal(check.errorCount, 0, `${id} has no check errors: ${detail}`)
    assert.equal(check.warningCount, 0, `${id} has no check warnings: ${detail}`)
    assert.equal(check.status, 'pass', `${id} checks clean`)
    const rendered = await renderPptdProject(project)
    assert.ok(rendered.bytes.byteLength > 20 * 1024, `${id} exports a non-trivial pptx`)
    assert.equal(rendered.check.status, 'pass')
  }
})

test('catalog: grid-family colorways reuse the base page geometry verbatim', async () => {
  const entries = await allTemplates()
  const base = entries.find((item) => item.meta.id === GRID_FAMILY_BASE)
  assert.ok(base !== undefined, 'grid geometry family base is bundled')
  const geometryOf = (text: string): string => (text.match(/bounds:\n(?: {6}- [\d.]+\n){4}/g) ?? []).join('|')
  const basePages: string[] = []
  for (let page = 1; page <= 12; page += 1) basePages.push(await readFile(templatePageSourcePath(base as NonNullable<typeof base>, page), 'utf8'))
  for (const entry of entries) {
    if (!GRID_FAMILY_IDS.includes(entry.meta.id as (typeof GRID_FAMILY_IDS)[number]) || entry.meta.id === GRID_FAMILY_BASE) continue
    assert.equal(entry.meta.pages.length, base.meta.pages.length, `${entry.meta.id} page count matches the base`)
    for (let page = 1; page <= 12; page += 1) {
      const text = await readFile(templatePageSourcePath(entry, page), 'utf8')
      assert.equal(geometryOf(text), geometryOf(basePages[page - 1] ?? ''), `${entry.meta.id} p${page} reuses the base geometry`)
      const zones = (item: { zones: readonly { x: number, y: number, width: number, height: number }[] } | undefined): number[][] =>
        (item?.zones ?? []).map((zone) => [zone.x, zone.y, zone.width, zone.height])
      assert.deepEqual(
        zones(entry.meta.pages[page - 1]),
        zones(base.meta.pages[page - 1]),
        `${entry.meta.id} p${page} zone geometry matches the base`,
      )
    }
  }
})
