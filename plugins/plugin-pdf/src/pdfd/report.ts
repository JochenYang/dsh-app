/**
 * The model-facing shape of a PDF check: status plus per-issue locations with
 * actionable Chinese messages. Every issue is anchored to the project file
 * and, where it belongs to one, a 1-based block index and its field, so one
 * round trip carries the whole fix list and the next `pdf_write` is targeted.
 * `needs_revision` is a normal authoring result, never a delivery.
 *
 * @module @dsh-app/plugin-pdf/pdfd/report
 */

import type { PdfCheckResult, PdfIssue } from './types.ts'

export interface ReportIssue extends PdfIssue {
  /** Workspace-relative or absolute project path the issue belongs to. */
  readonly file: string
}

export interface ValidationReport {
  readonly status: 'pass' | 'warning' | 'needs_revision'
  readonly file: string
  readonly blockCount: number
  readonly estimatedPages: number
  readonly errorCount: number
  readonly warningCount: number
  readonly issues: readonly ReportIssue[]
}

/** Bind a check result to the project it was computed from. */
export function validationReport(check: PdfCheckResult, context: { file: string }): ValidationReport {
  return {
    status: check.status === 'fail' ? 'needs_revision' : check.status,
    file: context.file,
    blockCount: check.blockCount,
    estimatedPages: check.estimatedPages,
    errorCount: check.errorCount,
    warningCount: check.warningCount,
    issues: check.issues.map(issue => ({ ...issue, file: context.file })),
  }
}

/**
 * Chinese, actionable plain-text rendering: one line per issue with its block
 * index and fix hint — the block the render gate returns when it refuses an
 * export.
 */
export function formatValidation(report: ValidationReport): string {
  const title = report.status === 'needs_revision'
    ? '校验未通过，需要调整'
    : report.status === 'warning' ? '校验通过，有建议' : '校验通过'
  const lines: string[] = [
    `${title}：${report.errorCount} 项需要修正，${report.warningCount} 项建议（共 ${report.blockCount} 块，约 ${report.estimatedPages} 页）。`,
    `文件：${report.file}`,
  ]
  for (const issue of report.issues) {
    lines.push([
      issue.severity === 'error' ? '需修正' : '建议',
      issue.block === undefined ? '' : `第 ${issue.block} 块`,
      issue.field ?? '',
      `[${issue.code}] ${issue.message}`,
      issue.fix === undefined ? '' : `修复：${issue.fix}`,
    ].filter(Boolean).join(' · '))
  }
  if (report.status === 'needs_revision') {
    lines.push('按块索引与字段逐条修改 pdf_write 的内容后重新校验；未修正前不会渲染任何 PDF。')
  }
  return lines.join('\n')
}
