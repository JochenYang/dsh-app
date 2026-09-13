/**
 * PPTD v2 parser: YAML text in, renderer-independent AST out. Every parse
 * problem lands in `parseIssues` (never a thrown error) so the checker can
 * return the complete problem list — with file, page and elementId — in one
 * round trip instead of one error per attempt.
 *
 * @module @dsh-app/plugin-ppt/pptd/parse
 */

import yaml from 'js-yaml'
import {
  asNumber,
  asRecord,
  asString,
  asTuple,
  ELEMENT_FIELDS,
  MANIFEST_FIELDS,
  MISPLACED_TEXT_STYLE_FIELDS,
  PAGE_FIELDS,
  TEMPLATE_FIELDS,
  TEMPLATE_REFERENCE_FIELDS,
  TEMPLATE_RELATIONSHIPS,
  MAX_ELEMENTS_PER_PAGE,
  MAX_PAGES,
} from './types.ts'
import type { PptdIssue, PptdSource, PptdPage, PptdProject } from './types.ts'

/** Parse one YAML document into an object; failures become issues. */
export function parseYaml(content: string, file: string, issues: PptdIssue[]): Record<string, unknown> | undefined {
  try {
    const value = asRecord(yaml.load(content, { schema: yaml.JSON_SCHEMA, json: true }))
    if (value !== undefined) return value
    issues.push({
      code: 'yaml-root',
      severity: 'error',
      file,
      message: `${file} 的 YAML 根节点必须是对象。`,
    })
  } catch (cause) {
    issues.push({
      code: 'yaml-syntax',
      severity: 'error',
      file,
      message: `${file} 无法解析：${cause instanceof Error ? cause.message : String(cause)}`,
    })
  }
  return undefined
}

/** Project-relative POSIX path that cannot escape the project directory. */
export function safeProjectPath(value: string): string | undefined {
  if (value === '' || value.includes('\\') || /^([a-zA-Z]:|\/)/u.test(value)) return undefined
  const normalized = posixNormalize(value)
  return normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') ? undefined : normalized
}

function posixNormalize(value: string): string {
  const segments = value.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return '..'
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.join('/')
}

function unknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key))
}

/**
 * Parse the bounded in-memory source plane into the project AST. Missing
 * pages keep their position in the page order so numbering stays honest.
 * The seed `source.issues` (loader-level failures) is copied, never mutated.
 */
export function parsePptdProject(source: PptdSource): PptdProject {
  const issues: PptdIssue[] = [...source.issues ?? []]
  const manifest = parseYaml(source.manifest, source.entryName, issues) ?? {}
  for (const field of unknownFields(manifest, MANIFEST_FIELDS)) {
    issues.push({ code: 'unknown-field', severity: 'error', file: source.entryName, message: `PPTD 包含未知字段 ${field}。` })
  }
  if (manifest.version !== 'v2') {
    issues.push({ code: 'version', severity: 'error', file: source.entryName, message: 'PPTD version 必须为 v2。' })
  }
  const size = asTuple(manifest.size, 2)
  const pageWidth = size?.[0]
  const pageHeight = size?.[1]
  if (pageWidth === undefined || pageHeight === undefined || pageWidth <= 0 || pageHeight <= 0) {
    issues.push({ code: 'page-size', severity: 'error', file: source.entryName, message: 'PPTD size 必须是两个正数。' })
  }
  const template = manifest.template === undefined ? undefined : asRecord(manifest.template)
  if (manifest.template !== undefined && template === undefined) {
    issues.push({ code: 'template', severity: 'error', file: source.entryName, message: 'PPTD template 必须是对象。' })
  }
  if (template !== undefined) {
    for (const field of unknownFields(template, TEMPLATE_FIELDS)) {
      issues.push({ code: 'unknown-field', severity: 'error', file: source.entryName, message: `PPTD template 包含未知字段 ${field}。` })
    }
    if (typeof template.id !== 'string' || typeof template.name !== 'string') {
      issues.push({ code: 'template', severity: 'error', file: source.entryName, message: 'PPTD template.id 和 template.name 必须是字符串。' })
    }
    if (template.sourceFile !== undefined && typeof template.sourceFile !== 'string') {
      issues.push({ code: 'template', severity: 'error', file: source.entryName, message: 'PPTD template.sourceFile 必须是字符串。' })
    }
    if (template.sourceSha256 !== undefined && (typeof template.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(template.sourceSha256))) {
      issues.push({ code: 'template', severity: 'error', file: source.entryName, message: 'PPTD template.sourceSha256 必须是 SHA-256。' })
    }
  }
  const pageRefs = Array.isArray(manifest.pages) ? manifest.pages : []
  if (!Array.isArray(manifest.pages) || pageRefs.length === 0 || pageRefs.length > MAX_PAGES) {
    issues.push({ code: 'pages', severity: 'error', file: source.entryName, message: `PPTD pages 必须包含 1 到 ${MAX_PAGES} 个页面路径。` })
  }
  const pages: PptdPage[] = []
  const seen = new Set<string>()
  for (const [index, rawRef] of pageRefs.slice(0, MAX_PAGES).entries()) {
    const pageNumber = index + 1
    const ref = typeof rawRef === 'string' ? safeProjectPath(rawRef) : undefined
    if (ref === undefined || !ref.endsWith('.page')) {
      issues.push({ code: 'page-path', severity: 'error', page: pageNumber, message: `第 ${pageNumber} 个页面路径无效。` })
      continue
    }
    if (seen.has(ref)) {
      issues.push({ code: 'duplicate-page', severity: 'error', file: ref, page: pageNumber, message: `页面 ${ref} 被重复引用。` })
      continue
    }
    seen.add(ref)
    const content = source.pages.get(ref)
    if (content === undefined) {
      issues.push({ code: 'missing-page', severity: 'error', file: ref, page: pageNumber, message: `找不到页面文件 ${ref}。` })
      continue
    }
    const parsed = parseYaml(content, ref, issues)
    if (parsed === undefined) continue
    for (const field of unknownFields(parsed, PAGE_FIELDS)) {
      issues.push({ code: 'unknown-field', severity: 'error', file: ref, page: pageNumber, message: `页面包含未知字段 ${field}。` })
    }
    const elements = Array.isArray(parsed.elements) ? parsed.elements.map(asRecord).filter((item) => item !== undefined) : []
    if (!Array.isArray(parsed.elements) || elements.length > MAX_ELEMENTS_PER_PAGE) {
      issues.push({ code: 'elements', severity: 'error', file: ref, page: pageNumber, message: `页面 elements 必须是数组且不超过 ${MAX_ELEMENTS_PER_PAGE} 个元素。` })
    }
    const background = asRecord(parsed.background)
    const templateReference = parsed.templateReference === undefined ? undefined : asRecord(parsed.templateReference)
    if (parsed.templateReference !== undefined && templateReference === undefined) {
      issues.push({ code: 'template-reference', severity: 'error', file: ref, page: pageNumber, message: '页面 templateReference 必须是对象。' })
    }
    if (templateReference !== undefined) {
      for (const field of unknownFields(templateReference, TEMPLATE_REFERENCE_FIELDS)) {
        issues.push({ code: 'unknown-field', severity: 'error', file: ref, page: pageNumber, message: `页面 templateReference 包含未知字段 ${field}。` })
      }
      if (!Number.isInteger(templateReference.sourceSlideNumber) || Number(templateReference.sourceSlideNumber) <= 0) {
        issues.push({ code: 'template-reference', severity: 'error', file: ref, page: pageNumber, message: '页面 templateReference.sourceSlideNumber 必须是正整数。' })
      }
      if (typeof templateReference.rationale !== 'string' || templateReference.rationale.trim() === '') {
        issues.push({ code: 'template-reference', severity: 'error', file: ref, page: pageNumber, message: '页面 templateReference.rationale 必须说明源页选择理由。' })
      }
      if (templateReference.contentRelationship !== undefined
        && (typeof templateReference.contentRelationship !== 'string' || !TEMPLATE_RELATIONSHIPS.has(templateReference.contentRelationship))) {
        issues.push({ code: 'template-reference', severity: 'error', file: ref, page: pageNumber, message: '页面 templateReference.contentRelationship 必须是受支持的内容关系。' })
      }
    }
    for (const element of elements) {
      const type = asString(element.elementType)
      const allowed = type === undefined ? undefined : ELEMENT_FIELDS[type]
      if (allowed === undefined) continue
      for (const field of unknownFields(element, allowed)) {
        const misplaced = type === 'text' && MISPLACED_TEXT_STYLE_FIELDS.has(field)
        issues.push({
          code: misplaced ? 'misplaced-text-style' : 'unknown-field',
          severity: 'error',
          file: ref,
          page: pageNumber,
          ...(typeof element.elementId === 'string' ? { elementId: element.elementId } : {}),
          message: misplaced
            ? `文本属性 ${field} 应放在 content 内，请修正 YAML 缩进。`
            : `元素包含未知字段 ${field}。`,
        })
      }
    }
    pages.push({
      file: ref,
      ...(typeof parsed.pageType === 'string' ? { pageType: parsed.pageType } : {}),
      ...(templateReference !== undefined && Number.isInteger(templateReference.sourceSlideNumber) && typeof templateReference.rationale === 'string'
        ? {
            templateReference: {
              sourceSlideNumber: Number(templateReference.sourceSlideNumber),
              rationale: templateReference.rationale,
              ...(typeof templateReference.contentRelationship === 'string' && TEMPLATE_RELATIONSHIPS.has(templateReference.contentRelationship)
                ? { contentRelationship: templateReference.contentRelationship }
                : {}),
            },
          }
        : {}),
      ...(background === undefined ? {} : { background }),
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      elements: elements.slice(0, MAX_ELEMENTS_PER_PAGE),
    })
  }
  return {
    source,
    title: typeof manifest.title === 'string' ? manifest.title : source.entryName.replace(/\.pptd$/u, ''),
    width: pageWidth ?? 960,
    height: pageHeight ?? 540,
    ...(template === undefined ? {} : { template }),
    theme: asRecord(manifest.theme) ?? {},
    pages,
    parseIssues: issues,
  }
}
