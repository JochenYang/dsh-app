/**
 * Document loading: one `.sheet.json` file in, a parsed JSON value out — or
 * one actionable Chinese reason why not. Size is checked before reading and
 * again on the text, so an oversized or unparseable file never reaches the
 * checker as a partial document.
 *
 * @module @dsh-app/plugin-sheet/sheet/load
 */

import { lstat, readFile } from 'node:fs/promises'
import { MAX_SHEET_FILE_BYTES } from './check.ts'

/** A parsed document or the single reason it could not be produced. */
export interface SheetDocumentLoad {
  readonly text?: string
  readonly value?: unknown
  /** Chinese, actionable reason the document is unusable. */
  readonly error?: string
}

function byteLimitMessage(bytes: number): string {
  return `工程文件 ${bytes} 字节超过上限 ${MAX_SHEET_FILE_BYTES} 字节；请精简数据或拆分成多个工程文件。`
}

/** Parse one JSON document text; the only place JSON syntax errors surface. */
export function parseSheetText(text: string): SheetDocumentLoad {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_SHEET_FILE_BYTES) return { error: byteLimitMessage(bytes) }
  if (text.trim() === '') return { error: '工程内容为空；请写入完整的 .sheet.json（JSON 对象，至少含 title 与 sheets）。' }
  try {
    return { text, value: JSON.parse(text) as unknown }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { error: `不是合法 JSON：${detail}；请修正 JSON 语法（引号、逗号、括号）后重试。` }
  }
}

/** Read and parse one workspace `.sheet.json` file. */
export async function readSheetDocument(file: string): Promise<SheetDocumentLoad> {
  const metadata = await lstat(file)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return { error: `工程文件必须是普通文件：${file}` }
  }
  if (metadata.size > MAX_SHEET_FILE_BYTES) return { error: byteLimitMessage(metadata.size) }
  const text = await readFile(file, 'utf8')
  return parseSheetText(text)
}
