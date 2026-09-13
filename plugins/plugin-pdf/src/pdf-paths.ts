/**
 * Workspace-path discipline for the PDF tools: every path is resolved against
 * the executing session's workspace root, then proven to name an in-workspace
 * regular file (or an in-workspace write target). Symbolic links are refused
 * (lstat + realpath), so a model-supplied path cannot reach outside the
 * workspace even through a link planted inside it.
 *
 * @module @dsh-app/plugin-pdf/pdf-paths
 */

import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { resolveInWorkspace } from './workspace.ts'

/** The only PDF project source extension. */
export const PDF_PROJECT_EXTENSION = '.pdf.json'
/** The only PDF input/output extension. */
export const PDF_FILE_EXTENSION = '.pdf'
/** Project JSON above this size is refused (a project never needs more). */
export const MAX_PROJECT_TEXT_BYTES = 1024 * 1024

/** Sanitized workspace-relative path ending in `extension`. */
function fileRelative(value: unknown, what: string, extension: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what}：必须是非空的工作区相对路径`)
  }
  if (value.includes('\\') || /^([a-zA-Z]:|\/)/u.test(value)) {
    throw new Error(`${what}：必须是工作区相对路径（收到 ${value}）`)
  }
  const normalized = path.posix.normalize(value)
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized === '.') {
    throw new Error(`${what}：路径越出工作区（${value}）`)
  }
  if (!normalized.toLowerCase().endsWith(extension)) {
    throw new Error(`${what}：必须以 ${extension} 结尾（收到 ${normalized}）`)
  }
  return normalized
}

/** Workspace-relative `*.pdf.json` project path. */
export function pdfProjectRelative(value: unknown, what: string): string {
  return fileRelative(value, what, PDF_PROJECT_EXTENSION)
}

/** Workspace-relative `*.pdf` path (a read source or a render target). */
export function pdfFileRelative(value: unknown, what: string): string {
  return fileRelative(value, what, PDF_FILE_EXTENSION)
}

/**
 * Existing, contained, non-symlink regular file.
 * @throws Error naming the offending value when the path is unusable.
 */
export async function existingWorkspaceFile(root: string, relative: string, what: string): Promise<string> {
  const lexical = resolveInWorkspace(root, relative, what)
  const metadata = await lstat(lexical).catch(() => undefined)
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${what}：工作区内不存在该文件（${relative}）`)
  }
  const canonicalRoot = await realpath(root)
  const target = await realpath(lexical)
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`${what}：路径越出工作区根目录（${relative}）`)
  }
  return target
}

/**
 * Write target inside the workspace. The parent directory may not exist yet;
 * the caller creates it. The path is not required to exist, but every existing
 * ancestor on the way to it is canonicalized first — a directory symlink
 * inside the workspace must not redirect the write outside it. An existing
 * target must be a regular file (a directory or a link is refused rather than
 * replaced).
 */
export async function writableWorkspaceFile(root: string, relative: string, what: string): Promise<string> {
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
  if (metadata !== undefined && (metadata.isSymbolicLink() || metadata.isFile() === false)) {
    throw new Error(`${what}：目标已存在且不是普通文件（${relative}）`)
  }
  return lexical
}
