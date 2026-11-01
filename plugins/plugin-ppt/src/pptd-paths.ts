/**
 * Workspace-path discipline for the PPTD project tools: every tool path is
 * resolved against the executing session's workspace root, then a second
 * containment check fences project files inside the project directory.
 * Symbolic links are refused on both levels (lstat + realpath), so a
 * model-supplied path cannot reach outside the workspace even through a
 * link planted inside the project.
 *
 * @module @dsh-app/plugin-ppt/pptd-paths
 */

import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { resolveInWorkspace } from './workspace.ts'

export const PROJECT_TEXT_EXTENSIONS = new Set(['.pptd', '.page', '.yaml', '.yml'])
export const PROJECT_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
/** Text files above this size are refused (a page never needs more). */
export const MAX_PROJECT_TEXT_BYTES = 512 * 1024

/** Workspace-rooted path that already exists as a directory (or the .pptd manifest). */
export async function existingWorkspaceEntry(root: string, relative: string, what: string): Promise<string> {
  const lexical = resolveInWorkspace(root, relative, what)
  const metadata = await lstat(lexical).catch(() => undefined)
  if (metadata === undefined || metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
    throw new Error(`${what}：必须是工作区内已存在的 PPTD 工程目录或 .pptd 清单（收到 ${relative}）`)
  }
  const canonicalRoot = await realpath(root)
  const target = await realpath(lexical)
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`${what}：路径越出工作区根目录（${relative}）`)
  }
  return target
}

/** Workspace-rooted project directory, created when absent. */
export async function writableProjectDirectory(root: string, relative: string): Promise<string> {
  const lexical = resolveInWorkspace(root, relative, 'project_path')
  const metadata = await lstat(lexical).catch(() => undefined)
  if (metadata !== undefined && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
    throw new Error('project_path：必须是工作区内的 PPTD 工程目录')
  }
  if (metadata === undefined) await mkdir(lexical, { recursive: true })
  const canonicalRoot = await realpath(root)
  const canonicalDirectory = await realpath(lexical)
  if (canonicalDirectory === canonicalRoot || !canonicalDirectory.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('project_path：必须位于工作区内部的子目录')
  }
  return canonicalDirectory
}

/** Sanitized project-relative file path with an allowed extension. */
export function projectFileRelative(value: unknown, what: string, extensions: ReadonlySet<string>): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what}：必须是非空的工程内相对路径`)
  }
  if (value.includes('\\') || /^([a-zA-Z]:|\/)/u.test(value)) {
    throw new Error(`${what}：必须是工程内相对路径（收到 ${value}）`)
  }
  const normalized = path.posix.normalize(value)
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized === '.') {
    throw new Error(`${what}：路径越出工程目录（${value}）`)
  }
  if (!extensions.has(path.posix.extname(normalized).toLowerCase())) {
    throw new Error(`${what}：不支持的文件扩展名（${normalized}）`)
  }
  return normalized
}

async function assertInsideProject(directory: string, lexical: string, what: string): Promise<string> {
  if (lexical === directory || !lexical.startsWith(`${directory}${path.sep}`)) {
    throw new Error(`${what}：必须位于 project_path 内部`)
  }
  // Every existing ancestor must resolve back inside the project directory, and a
  // MISSING ancestor is not a reason to stop looking: `a/b/c/x.pptx` with a
  // nonexistent `c` still has a real `b`, and if that one is a symlink pointing out
  // of the project, creating `c` would write outside it. Walk up until an ancestor
  // exists, then judge it — the shape `plugin-pdf/src/pdf-paths.ts` uses.
  let ancestor = path.dirname(lexical)
  for (;;) {
    const resolved = await realpath(ancestor).catch(() => undefined)
    if (resolved !== undefined) {
      if (resolved !== directory && !resolved.startsWith(`${directory}${path.sep}`)) {
        throw new Error(`${what}：父目录越出 project_path`)
      }
      break
    }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error(`${what}：无法在 project_path 内创建目标目录`)
    ancestor = parent
  }
  return lexical
}

/**
 * The project directory as the filesystem names it.
 *
 * A workspace can be opened through a symlink — macOS resolves `/tmp` and
 * `/var/folders`, Windows hands out junctions and 8.3 short names — and then the
 * caller's root and an ancestor's `realpath` carry different prefixes, so every
 * containment comparison fails from the wrong side and every write is refused as
 * "outside the project" although it is inside.
 */
async function canonicalDirectory(directory: string): Promise<string> {
  return realpath(directory).catch(() => directory)
}

/** Existing project file, containment-checked. */
export async function existingProjectFile(directory: string, fileRelative: string, what: string): Promise<string> {
  const canonical = await canonicalDirectory(directory)
  const lexical = await assertInsideProject(canonical, path.resolve(canonical, ...fileRelative.split('/')), what)
  const metadata = await lstat(lexical).catch(() => undefined)
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${what}：文件不存在或不是普通文件（${fileRelative}）`)
  }
  const target = await realpath(lexical)
  if (!target.startsWith(`${directory}${path.sep}`)) throw new Error(`${what}：路径越出 project_path`)
  return target
}

/** Writable project file target (parent directories may not exist yet). */
export async function writableProjectFile(directory: string, fileRelative: string, what: string): Promise<string> {
  const canonical = await canonicalDirectory(directory)
  return assertInsideProject(canonical, path.resolve(canonical, ...fileRelative.split('/')), what)
}
