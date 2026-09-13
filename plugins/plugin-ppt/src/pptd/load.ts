/**
 * PPTD project loader: resolve the entry (a `.pptd` manifest or a project
 * directory containing exactly one), read every referenced page and every
 * image asset confined inside the project directory. Network resources stay
 * disabled by construction — only project-relative files are ever read.
 *
 * @module @dsh-app/plugin-ppt/pptd/load
 */

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parsePptdProject, parseYaml, safeProjectPath } from './parse.ts'
import {
  MAX_ASSET_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_PAGE_BYTES,
  MAX_PAGES,
  MAX_TOTAL_ASSET_BYTES,
} from './types.ts'
import type { PptdAsset, PptdIssue, PptdProject } from './types.ts'

function mediaTypeOf(file: string, bytes: Uint8Array): string | undefined {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.png' && bytes[0] === 137 && bytes[1] === 80) return 'image/png'
  if ((extension === '.jpg' || extension === '.jpeg') && bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg'
  if (extension === '.gif' && Buffer.from(bytes.subarray(0, 3)).toString('ascii') === 'GIF') return 'image/gif'
  if (extension === '.webp' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  if (extension === '.svg' && Buffer.from(bytes.subarray(0, 512)).toString('utf8').includes('<svg')) return 'image/svg+xml'
  return undefined
}

async function confinedFile(root: string, relative: string, maximumBytes: number): Promise<{ real: string, bytes: Buffer }> {
  const safe = safeProjectPath(relative)
  if (safe === undefined) throw new Error(`PPTD 路径不是工程内相对路径：${relative}`)
  const target = await realpath(path.join(root, ...safe.split('/')))
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`PPTD 路径越出工程根目录：${relative}`)
  }
  const metadata = await lstat(target)
  if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error(`PPTD 文件无效或过大：${relative}`)
  return { real: target, bytes: await readFile(target) }
}

/** Resolve a PPTD entry from either the manifest file or its project directory. */
export async function resolvePptdEntry(inputPath: string): Promise<string> {
  const input = await realpath(path.resolve(inputPath))
  const metadata = await lstat(input)
  if (metadata.isFile()) {
    if (!input.endsWith('.pptd')) throw new Error('PPTD 入口必须是 .pptd 文件')
    return input
  }
  if (!metadata.isDirectory()) throw new Error('PPTD 输入必须是 .pptd 清单或工程目录')
  const entries = (await readdir(input, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.pptd'))
    .map((entry) => entry.name)
    .sort()
  if (entries.length !== 1) {
    throw new Error(`PPTD 工程目录必须包含恰好一个 .pptd 清单；当前有 ${entries.length} 个`)
  }
  const entry = entries.at(0)
  if (entry === undefined) throw new Error('PPTD 工程目录必须包含一个 .pptd 清单')
  return path.join(input, entry)
}

/** Load a confined local PPTD project from disk. */
export async function loadPptdProject(entryPath: string): Promise<PptdProject> {
  const entry = await resolvePptdEntry(entryPath)
  const metadata = await lstat(entry)
  if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) throw new Error('PPTD 入口无效或过大')
  const root = path.dirname(entry)
  const manifest = await readFile(entry, 'utf8')
  const loadIssues: PptdIssue[] = []
  // Manifest-level problems are re-derived by the parser itself; this parse
  // only wants the page refs, so its issues go to a throwaway sink.
  const raw = parseYaml(manifest, path.basename(entry), [])
  const pages = new Map<string, string>()
  if (raw !== undefined) {
    const refs = Array.isArray(raw.pages) ? raw.pages.slice(0, MAX_PAGES) : []
    for (const rawRef of refs) {
      const ref = typeof rawRef === 'string' ? safeProjectPath(rawRef) : undefined
      if (ref === undefined) continue
      try {
        const file = await confinedFile(root, ref, MAX_PAGE_BYTES)
        pages.set(ref, Buffer.from(file.bytes).toString('utf8'))
      } catch (cause) {
        loadIssues.push({
          code: 'file-read',
          severity: 'error',
          file: ref,
          message: `无法读取页面文件 ${ref}：${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
    }
  }
  // First pass (without assets) collects the image paths the pages reference.
  const partial = parsePptdProject({ entryName: path.basename(entry), manifest, pages, assets: new Map() })
  const refsToLoad = new Set<string>()
  for (const page of partial.pages) {
    for (const element of page.elements) {
      if (element.elementType !== 'image') continue
      const src = typeof element.src === 'string' ? safeProjectPath(element.src.replace(/^\.\//u, '')) : undefined
      if (src !== undefined) refsToLoad.add(src)
    }
  }
  const assets = new Map<string, PptdAsset>()
  let totalBytes = 0
  for (const ref of refsToLoad) {
    let file: { real: string, bytes: Buffer }
    try {
      file = await confinedFile(root, ref, MAX_ASSET_BYTES)
    } catch (cause) {
      loadIssues.push({
        code: 'file-read',
        severity: 'error',
        file: ref,
        message: `无法读取资源 ${ref}：${cause instanceof Error ? cause.message : String(cause)}`,
      })
      continue
    }
    totalBytes += file.bytes.byteLength
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw new Error('PPTD 图片资源总量超出上限')
    const type = mediaTypeOf(ref, file.bytes)
    if (type === undefined) {
      loadIssues.push({ code: 'invalid-resource', severity: 'error', file: ref, message: `图片资源格式或内容无效：${ref}` })
      continue
    }
    assets.set(ref, {
      path: ref,
      mediaType: type,
      bytes: file.bytes,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })
  }
  return parsePptdProject({ entryName: path.basename(entry), manifest, pages, assets, issues: loadIssues })
}
