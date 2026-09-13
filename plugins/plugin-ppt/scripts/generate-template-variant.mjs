#!/usr/bin/env node
/**
 * Derive a colorway variant from a bundled base template.
 *
 * A variant keeps the base layout skeleton exactly (source-zh geometry, text
 * and font pairing) and changes only the palette. Colors are remapped by
 * treating every base color as a mix of two palette anchors (or pure white /
 * black), then recomposing that same mix from the variant's anchors — this
 * preserves the tonal structure the layout author tuned, including the many
 * tints and shades that never appear as a named palette entry. Preview JPEGs
 * are rendered fresh from the remapped pages (see render-page-previews.ps1)
 * rather than copied from the base.
 *
 * Usage (from anywhere):
 *   node plugins/plugin-ppt/scripts/generate-template-variant.mjs
 *   node plugins/plugin-ppt/scripts/generate-template-variant.mjs --only dsh-moss-lecture
 *   node plugins/plugin-ppt/scripts/generate-template-variant.mjs --skip-render
 *
 * Writes into plugins/plugin-ppt/templates/<category>/<id>/ and never touches
 * the base template.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pageScene, renderPreviews } from './preview-scenes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const templatesRoot = join(pluginRoot, 'templates')
const configPath = join(here, 'template-variants.json')
const VARIANT_DATE = '2026-09-13'
const PAGE_COUNT = 12

const ANCHOR_KEYS = ['background', 'text', 'accent', 'surface', 'secondary']
const WHITE = [255, 255, 255]
const BLACK = [0, 0, 0]

const args = process.argv.slice(2)
function argValue(name) {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined
}
const only = argValue('--only')
const skipRender = args.includes('--skip-render')

function parseHex(value) {
  const hex = value.replace(/^#/, '')
  return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
}

function toHex(rgb, uppercase) {
  const digits = rgb.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')
  return uppercase ? digits.toUpperCase() : digits
}

/** Least-squares decomposition of `color` into a pair of anchor colors. */
function decompose(color, anchors) {
  let best = { error: Number.POSITIVE_INFINITY, t: 0, a: 0, b: 0 }
  for (let a = 0; a < anchors.length; a += 1) {
    for (let b = a + 1; b < anchors.length; b += 1) {
      const from = anchors[a]
      const to = anchors[b]
      let numerator = 0
      let denominator = 0
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = to[channel] - from[channel]
        numerator += (color[channel] - from[channel]) * delta
        denominator += delta * delta
      }
      const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, numerator / denominator))
      let error = 0
      for (let channel = 0; channel < 3; channel += 1) {
        const predicted = from[channel] + t * (to[channel] - from[channel])
        error += (predicted - color[channel]) ** 2
      }
      if (Math.sqrt(error / 3) < best.error) best = { error: Math.sqrt(error / 3), t, a, b }
    }
  }
  return best
}

/** Build the base-color → variant-color mapping for one variant spec. */
function buildColorMap(baseMeta, variant) {
  const anchorsBase = [...ANCHOR_KEYS.map(key => parseHex(baseMeta.palette[key])), WHITE, BLACK]
  const anchorsVariant = [...ANCHOR_KEYS.map(key => parseHex(variant.palette[key])), WHITE, BLACK]
  const pagesText = readPages(variant, baseMeta).map(file => file.text).join('\n')
  const designText = readBaseDesign(variant, baseMeta)
  const known = new Set()
  for (const key of ANCHOR_KEYS) known.add(baseMeta.palette[key].toUpperCase())
  for (const match of `${pagesText}\n${designText}`.matchAll(/#([0-9a-fA-F]{6})/g)) known.add(match[1].toUpperCase())
  const mapping = new Map()
  for (const hex of known) {
    const { t, a, b } = decompose(parseHex(hex), anchorsBase)
    const from = anchorsVariant[a]
    const to = anchorsVariant[b]
    mapping.set(hex, toHex([0, 1, 2].map(channel => from[channel] + t * (to[channel] - from[channel])), true))
  }
  return mapping
}

/** Replace only hex literals the base already used, preserving each match's case. */
function remapHex(text, mapping) {
  return text.replace(/#([0-9a-fA-F]{6})/g, (whole, digits) => {
    const mapped = mapping.get(digits.toUpperCase())
    if (mapped === undefined) return whole
    const lowercase = digits !== digits.toUpperCase()
    return `#${lowercase ? mapped.toLowerCase() : mapped}`
  })
}

/**
 * Base template directory. `baseCategory` lets a variant in one category
 * derive from a base bundled in another (the geometry family is portable);
 * it defaults to the base's own category when the layout is colocated.
 */
function baseDir(variant, baseMeta) {
  return join(templatesRoot, variant.baseCategory ?? baseMeta.category, baseMeta.id)
}

function readBaseDesign(variant, baseMeta) {
  return readFileSync(join(baseDir(variant, baseMeta), 'design.md'), 'utf8').replace(/\r\n/g, '\n')
}

function readPages(variant, baseMeta) {
  const dir = join(baseDir(variant, baseMeta), 'source-zh', 'pages')
  const files = []
  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const name = String(page).padStart(2, '0')
    files.push({ name, text: readFileSync(join(dir, `${name}.page`), 'utf8') })
  }
  return files
}

/**
 * Rewrite the base design document into the variant's: title, provenance
 * preamble, preview-location note and copyright, then the per-variant color
 * vocabulary swaps, then every known hex.
 */
function transformDesign(designText, variant, baseMeta, mapping) {
  const lines = designText.split('\n')
  lines[0] = `# ${variant.nameEn} / ${variant.name}`
  const preambleIndex = lines.findIndex(line => line.startsWith('Adapted from '))
  if (preambleIndex >= 0) {
    const carried = lines[preambleIndex].replace(/^Adapted from /, 'The base edition is adapted from ')
    lines[preambleIndex] = `${variant.colorwayNote} ${carried}`
  }
  const previewsIndex = lines.findIndex(line => line.includes('English previews use source/.'))
  if (previewsIndex >= 0) {
    lines[previewsIndex] = lines[previewsIndex]
      .replace('English previews use source/. Chinese examples use source-zh/.', 'Layout examples live in source-zh/.')
  }
  const copyrightIndex = lines.findIndex(line => line.startsWith('Copyright (c) '))
  if (copyrightIndex >= 0) {
    lines[copyrightIndex] = `Copyright (c) 2026 Zara Zhang. DSH adaptation 2026-09-06; ${variant.nameEn}`
      + ` colorway variant ${VARIANT_DATE}. Derived from the bundled ${baseMeta.name} template (MIT);`
      + ' see its design document for the pinned upstream source.'
  }
  let text = lines.join('\n')
  for (const [from, to] of variant.replacements ?? []) text = text.split(from).join(to)
  return remapHex(text, mapping)
}

function generate(variant, baseMeta) {
  const mapping = buildColorMap(baseMeta, variant)
  const outDir = join(templatesRoot, variant.category, variant.id)
  const pagesDir = join(outDir, 'source-zh', 'pages')
  mkdirSync(pagesDir, { recursive: true })

  const palette = {}
  for (const key of ANCHOR_KEYS) palette[key] = variant.palette[key].toUpperCase()
  palette.muted = palette.secondary

  const meta = {
    ...JSON.parse(JSON.stringify(baseMeta)),
    id: variant.id,
    category: variant.category,
    name: variant.name,
    nameEn: variant.nameEn,
    description: `${variant.name} · ${variant.nameEn}`,
    palette,
    visualGrammar: variant.id.replace(/^dsh-/, ''),
  }
  const design = transformDesign(readBaseDesign(variant, baseMeta), variant, baseMeta, mapping)
  meta.designSummary = design
  for (const page of meta.pages) {
    for (const zone of page.zones ?? []) {
      // Zone fills are stored without the leading '#'; the map is keyed with
      // it, so re-add and strip it to keep the metadata in step with pages.
      if (typeof zone.fill === 'string') zone.fill = remapHex(`#${zone.fill}`, mapping).slice(1)
    }
  }

  writeFileSync(join(outDir, 'metadata.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  writeFileSync(join(outDir, 'design.md'), design, 'utf8')

  const basePages = readPages(variant, baseMeta)
  const baseDeck = readFileSync(join(baseDir(variant, baseMeta), 'source-zh', 'deck.pptd'), 'utf8')
  const deck = baseDeck
    .replace(`title: ${baseMeta.name}`, `title: ${variant.name}`)
    .replace(`id: ${baseMeta.id}`, `id: ${variant.id}`)
    .replace(`name: ${baseMeta.nameEn}`, `name: ${variant.nameEn}`)
  writeFileSync(join(outDir, 'source-zh', 'deck.pptd'), deck, 'utf8')

  const scenes = []
  for (const page of basePages) {
    const source = remapHex(page.text, mapping)
    writeFileSync(join(pagesDir, `${page.name}.page`), source, 'utf8')
    scenes.push(pageScene(page.name, source))
  }
  if (!skipRender) renderPreviews(scenes, join(outDir, 'pages'))
  return { outDir, palette, pages: scenes.length }
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const selected = only === undefined ? config.variants : config.variants.filter(variant => variant.id === only)
if (selected.length === 0) {
  console.error(`no variant matches --only ${only}`)
  process.exit(1)
}
const metas = new Map()
for (const variant of selected) {
  const baseCategory = variant.baseCategory ?? variant.category
  const key = `${baseCategory}/${variant.base}`
  if (!metas.has(key)) metas.set(key, JSON.parse(readFileSync(join(templatesRoot, baseCategory, variant.base, 'metadata.json'), 'utf8')))
  const result = generate(variant, metas.get(key))
  console.log(`${variant.id}  ${variant.name} / ${variant.nameEn}  ${result.pages} pages${skipRender ? ' (no render)' : ''}`)
}
