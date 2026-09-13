/**
 * File-path discipline for the sheet tools: one engineering file and one
 * export target, both workspace-relative, both proven inside the workspace
 * before any filesystem access. Symbolic links are refused (lstat + realpath),
 * so a link planted inside the workspace cannot redirect a write outside it.
 *
 * The target's parent directories may not exist yet (a run writing into a new
 * `tables/` folder is ordinary), so containment is proven against the nearest
 * existing ancestor and the caller creates the directories. That keeps the
 * fence honest without forcing the model to make directories first.
 *
 * @module @dsh-app/plugin-sheet/sheet-paths
 */

import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { resolveInWorkspace } from './workspace.ts'

/** The engineering document's required suffix. */
export const SHEET_FILE_EXTENSION = '.sheet.json'
/** The export target's required suffix. */
export const SHEET_OUTPUT_EXTENSION = '.xlsx'

/** Reject absolute paths, backslashes and escapes; require the suffix. */
function sanitizeRelative(value: unknown, what: string, suffix: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what}：必须是非空的工程内相对路径`)
  }
  if (value.includes('\\') || /^([a-zA-Z]:|\/)/u.test(value)) {
    throw new Error(`${what}：必须是工作区相对路径（收到 ${value}）`)
  }
  const normalized = path.posix.normalize(value)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`${what}：路径越出工作区（${value}）`)
  }
  if (!normalized.toLocaleLowerCase().endsWith(suffix)) {
    throw new Error(`${what}：必须以 ${suffix} 结尾（收到 ${value}）`)
  }
  return normalized
}

/** Sanitized workspace-relative path of the `.sheet.json` engineering file. */
export function sheetFileRelative(value: unknown, what: string): string {
  return sanitizeRelative(value, what, SHEET_FILE_EXTENSION)
}

/** Sanitized workspace-relative path of the `.xlsx` export target. */
export function outputFileRelative(value: unknown, what: string): string {
  return sanitizeRelative(value, what, SHEET_OUTPUT_EXTENSION)
}

/** Existing regular file inside the workspace, canonicalized and link-free. */
export async function existingSheetFile(root: string, relative: string, what: string): Promise<string> {
  const lexical = resolveInWorkspace(root, relative, what)
  const metadata = await lstat(lexical).catch(() => undefined)
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${what}：文件不存在或不是普通文件（${relative}）；请先用 sheet_write 写出工程文件`)
  }
  const canonicalRoot = await realpath(root)
  const target = await realpath(lexical)
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`${what}：路径越出工作区根目录（${relative}）`)
  }
  return target
}

/**
 * Writable target inside the workspace. The parent directories may not exist
 * yet; the nearest existing ancestor must resolve back inside the workspace,
 * so a symlinked ancestor cannot redirect the write outside it. An existing
 * target must be a regular file (a directory or a link is refused rather than
 * replaced). The caller creates the missing directories.
 */
export async function writableSheetFile(root: string, relative: string, what: string): Promise<string> {
  const lexical = resolveInWorkspace(root, relative, what)
  const canonicalRoot = await realpath(root)
  let ancestor = path.dirname(lexical)
  for (;;) {
    const resolved = await realpath(ancestor).catch(() => undefined)
    if (resolved !== undefined) {
      if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new Error(`${what}：路径越出工作区根目录（${relative}）`)
      }
      break
    }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error(`${what}：无法在工作区内创建目标目录（${relative}）`)
    ancestor = parent
  }
  const metadata = await lstat(lexical).catch(() => undefined)
  if (metadata !== undefined && (metadata.isSymbolicLink() || !metadata.isFile())) {
    throw new Error(`${what}：目标已存在且不是普通文件（${relative}）`)
  }
  return lexical
}
