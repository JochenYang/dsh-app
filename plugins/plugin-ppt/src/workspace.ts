/**
 * Workspace-path discipline shared by every PPT tool.
 *
 * The workspace root is the executing session's validated cwd (the same
 * source the kernel file tools resolve against) — never model input, never a
 * process-level guess. Relative targets are resolved and containment-checked
 * before any filesystem access, so a model-supplied path cannot reach
 * outside the workspace.
 *
 * @module @dsh-app/plugin-ppt/workspace
 */

import { isAbsolute, resolve, sep } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** The executing session's workspace root, or a plain reason it is absent. */
export function workspaceRootOf(exec: ToolRunContext): { root: string } | { reason: string } {
  const cwd = exec.agent?.session.header.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    return { reason: '当前会话没有绑定工作目录；请在一个已打开工作区的会话中使用 PPT 工具' }
  }
  return { root: cwd }
}

/**
 * Resolve a model-supplied relative path against the workspace root and
 * prove containment. Absolute paths and escape attempts (`..`) are refused
 * with an actionable message naming the offending value.
 * @param root - workspace root (already validated absolute).
 * @param relative - model-supplied workspace-relative path.
 * @param what - short field label used in error messages (e.g. `path`).
 */
export function resolveInWorkspace(root: string, relative: string, what: string): string {
  if (typeof relative !== 'string' || relative.trim() === '') {
    throw new Error(`${what}：必须是非空的工作区相对路径`)
  }
  if (isAbsolute(relative)) {
    throw new Error(`${what}：必须是工作区相对路径，收到绝对路径 ${relative}`)
  }
  const resolved = resolve(root, relative)
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`${what}：路径越出工作区根目录（${relative}）`)
  }
  return resolved
}
