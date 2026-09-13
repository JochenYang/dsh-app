/**
 * The model-facing shape of a PPTD check: status plus per-issue locations
 * with actionable Chinese messages (and read-back hints per file).
 * `needs_revision` is a normal authoring result — the report names every
 * file and element so one round trip carries the whole fix list.
 *
 * @module @dsh-app/plugin-ppt/pptd/report
 */

import path from 'node:path'
import type { PptdCheckResult, PptdIssue } from './types.ts'

export interface ValidationReport extends Omit<PptdCheckResult, 'status'> {
  readonly status: 'pass' | 'warning' | 'needs_revision'
  readonly issues: readonly ReportIssue[]
  /** Context added per project: project dir relative to the workspace. */
  readonly projectPath?: string
}

export interface ReportIssue extends PptdIssue {
  readonly absolutePath?: string
  readonly readArgs?: { project_path: string, file_path: string }
}

/** Map a check result into the report shape, adding absolute paths + read hints. */
export function validationReport(check: PptdCheckResult, context: { projectDirectory: string, projectPath?: string }): ValidationReport {
  const issues = check.issues.map((issue): ReportIssue => {
    if (issue.file === undefined) return issue
    const absolutePath = path.resolve(context.projectDirectory, issue.file)
    const relative = path.relative(context.projectDirectory, absolutePath)
    // Invalid project references must never surface as actionable outside paths.
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return issue
    return {
      ...issue,
      absolutePath,
      ...(/\.(page|pptd)$/iu.test(relative) && context.projectPath !== undefined
        ? { readArgs: { project_path: context.projectPath, file_path: relative.split(path.sep).join('/') } }
        : {}),
    }
  })
  return {
    status: check.status === 'fail' ? 'needs_revision' : check.status,
    digest: check.digest,
    pageCount: check.pageCount,
    errorCount: check.errorCount,
    warningCount: check.warningCount,
    nativeObjectCount: check.nativeObjectCount,
    compatibility: check.compatibility,
    issues,
    ...(context.projectPath === undefined ? {} : { projectPath: context.projectPath }),
  }
}

/**
 * Chinese, actionable plain-text rendering: one line per issue with page and
 * element, plus per-file read-back hints — the block the render gate returns
 * when it refuses an export.
 */
export function formatValidation(report: ValidationReport): string {
  const title = report.status === 'needs_revision' ? '校验未通过，需要调整' : report.status === 'warning' ? '校验通过，有建议' : '校验通过'
  const lines: string[] = [`${title}：${report.errorCount} 项需要修正，${report.warningCount} 项建议。`]
  const files = new Map<string, ReportIssue>()
  for (const issue of report.issues) {
    if (issue.absolutePath !== undefined) files.set(issue.absolutePath, issue)
    lines.push([
      issue.severity === 'error' ? '需修正' : '建议',
      issue.page === undefined ? '' : `第 ${issue.page} 页`,
      issue.file ?? '',
      issue.elementId === undefined ? '' : `元素 ${issue.elementId}`,
      `[${issue.code}] ${issue.message}`,
    ].filter(Boolean).join(' · '))
  }
  for (const [absolutePath, issue] of files) {
    lines.push(`文件：${absolutePath}`)
    if (issue.readArgs !== undefined) lines.push(`读取：pptd_read_file(${JSON.stringify(issue.readArgs)})`)
  }
  if (report.status === 'needs_revision') lines.push('按文件路径、页码和元素 ID 逐条修改后重新检查；不同页面可以存在同名元素。')
  return lines.join('\n')
}
