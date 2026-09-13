/**
 * Shared preview pipeline for template authoring scripts: turn one `.page`
 * YAML into the flat, already-resolved scene the PowerShell rasterizer draws
 * (fonts chosen, colors literal), and run that rasterizer. Both the colorway
 * generator and the layout-family importer render through this one module so
 * a preview always matches how the page is authored.
 *
 * @module scripts/preview-scenes
 */
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { load as loadYaml } from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
export const RENDERER_PATH = join(here, 'render-page-previews.ps1')

/** Portable Office substitutions for the source's display/body faces. */
const FONT_ALIASES = new Map([
  ['Arial', 'Arial'],
  ['Arial Black', 'Arial Black'],
  ['Georgia', 'Georgia'],
  ['Helvetica Neue', 'Arial'],
  ['PingFang SC', 'Microsoft YaHei'],
  ['Microsoft YaHei', 'Microsoft YaHei'],
  ['SimSun', 'SimSun'],
  ['Noto Sans CJK SC', 'Microsoft YaHei'],
  ['Noto Serif CJK SC', 'SimSun'],
])

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

export function resolveFont(family, text) {
  const chosen = CJK.test(text)
    ? (family?.win ?? family?.ea ?? family?.latin)
    : (family?.latin ?? family?.ea ?? family?.win)
  return FONT_ALIASES.get(chosen) ?? 'Arial'
}

export function normalizeColor(value, fallback) {
  const hex = typeof value === 'string' ? value.replace(/^#/, '') : ''
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : fallback
}

export function parsePoints(value) {
  if (typeof value !== 'string') return []
  return value
    .trim()
    .split(/\s+/)
    .map(pair => pair.split(',').map(Number))
    .filter(pair => pair.length === 2 && pair.every(Number.isFinite))
    .map(([x, y]) => ({ x, y }))
}

function shapeType(name) {
  if (name === 'ellipse' || name === 'roundRect') return name
  return 'rect'
}

/** Horizontal alignment: `content.align` is either a string or `[horizontal, vertical]`. */
function horizontalAlign(value) {
  const horizontal = Array.isArray(value) ? value[0] : value
  return horizontal === 'center' || horizontal === 'right' ? horizontal : 'left'
}

/** Vertical alignment from `content.align[1]`; the rasterizer draws the block accordingly. */
function verticalAlign(value) {
  const vertical = Array.isArray(value) ? value[1] : undefined
  return vertical === 'middle' || vertical === 'bottom' ? vertical : 'top'
}

/** One PPTD page → the flat scene the rasterizer draws. */
export function pageScene(name, source) {
  const page = loadYaml(source)
  const items = []
  for (const element of page.elements ?? []) {
    const [x, y, w, h] = element.bounds ?? [0, 0, 0, 0]
    if (element.elementType === 'text') {
      const text = typeof element.content?.text === 'string' ? element.content.text : ''
      if (text === '') continue
      items.push({
        t: 'text',
        x, y, w, h,
        text,
        font: resolveFont(element.content.fontFamily, text),
        size: element.content.fontSize ?? 18,
        color: normalizeColor(element.content.color, '#000000'),
        bold: element.content.bold === true,
        lineHeight: element.content.lineHeight ?? 1.2,
        align: horizontalAlign(element.content.align),
        valign: verticalAlign(element.content.align),
      })
    } else if (element.elementType === 'shape') {
      const fill = normalizeColor(element.fill?.color, '#FFFFFF')
      items.push({
        t: shapeType(element.shapeName),
        x, y, w, h,
        fill,
        stroke: normalizeColor(element.border?.color, fill),
        sw: element.border?.width ?? 0,
      })
    } else if (element.elementType === 'line') {
      items.push({
        t: 'line',
        x, y, w, h,
        pts: parsePoints(element.points),
        color: normalizeColor(element.border?.color, '#000000'),
        w: element.border?.width ?? 1,
      })
    }
  }
  return { name, bg: normalizeColor(page.background?.color, '#FFFFFF'), items }
}

/** Rasterize scenes through the PowerShell renderer into `<outDir>/NN.jpg`. */
export function renderPreviews(scenes, outDir) {
  const sceneFile = join(tmpdir(), `dsh-ppt-scene-${process.pid}-${Date.now()}.json`)
  writeFileSync(sceneFile, JSON.stringify({ width: 960, height: 540, pages: scenes }), 'utf8')
  try {
    const result = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RENDERER_PATH,
      '-Scene', sceneFile, '-OutDir', outDir,
    ], { encoding: 'utf8', windowsHide: true })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`preview renderer failed (${result.status}): ${result.stderr || result.stdout}`)
  } finally {
    rmSync(sceneFile, { force: true })
  }
}
