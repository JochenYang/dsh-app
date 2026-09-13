/**
 * Vocabulary and pure validation for the `.dshpreset` package format.
 *
 * The archive layout is fixed: a ZIP holding `manifest.json` at the root and
 * the preset directory's files under `preset/<relative path>`. Everything a
 * route or the store accepts passes through the validators here first, so the
 * safety rules (entry whitelist, path containment, manifest shape, size and
 * count caps) have exactly one home and are testable without any filesystem.
 *
 * Error discipline: messages are zh-CN, actionable, and never contain
 * absolute machine paths — archive-relative paths are fine to echo (they
 * describe the untrusted file, not the host), truncated to keep a hostile
 * name from flooding the UI.
 *
 * @module @dsh-app/plugin-presets/wire
 */

/**
 * Archive entry names this plugin will read from or write to disk. Deliberately
 * identical to the kernel roster's preset-id rule — a name we accept but the
 * roster skips would import "successfully" yet never appear, the worst kind of
 * silent divergence.
 */
export const ENTRY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The kernel's per-preset composition file; a preset directory without it is not exportable. */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/** Manifest file name inside the archive root. */
export const MANIFEST_NAME = 'manifest.json'

/** Archive prefix holding the preset directory's files. */
export const PAYLOAD_PREFIX = 'preset/'

/** `manifest.json` kind marker — anything else is not our format. */
export const PRESET_KIND = 'dsh-preset'

/** Package format version this plugin reads and writes. */
export const FORMAT_VERSION = 1

/** Hard cap on the archive itself, both for export output and import upload. */
export const MAX_ZIP_BYTES = 10 * 1024 * 1024

/** Hard cap on the decompressed payload of an imported archive. */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024

/** Hard cap on the number of files in one package (payload files; the manifest is not a preset file). */
export const MAX_FILE_COUNT = 200

/** Package-level failure with a stable code the routes map to HTTP statuses. */
export class PresetPackageError extends Error {
  readonly code: string
  /** Structured extras (e.g. the conflicting entry) surfaced alongside the message. */
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'PresetPackageError'
    this.code = code
    this.details = details
  }
}

/**
 * Validate an archive/preset entry name against the whitelist.
 * @param entry - candidate entry (preset directory) name.
 * @returns a zh-CN reason when the name is rejected, undefined when valid.
 */
export function entryNameProblem(entry: string): string | undefined {
  if (entry === '') return '预设名为空'
  if (!ENTRY_PATTERN.test(entry)) {
    return '预设名只能使用小写字母、数字以及短横线 -，以字母或数字开头，最长 64 个字符'
  }
  return undefined
}

/**
 * Validate one archive member path for containment. Rejects absolute paths,
 * `..` segments, backslashes (Windows separator smuggling), dot-leading
 * segments (hidden files / `.ssh`-style surprises) and empty segments.
 * @param name - archive member path as stored (forward slashes).
 * @returns a zh-CN reason when the path is rejected, undefined when safe.
 */
export function zipPathSafetyProblem(name: string): string | undefined {
  if (name === '') return '路径为空'
  if (name.includes('\\')) return '路径包含反斜杠'
  if (name.startsWith('/')) return '路径是绝对路径'
  if (/^[a-zA-Z]:/.test(name)) return '路径是绝对路径'
  for (const segment of name.split('/')) {
    if (segment === '') return '路径包含空段'
    if (segment === '..') return '路径包含 .. 段'
    if (segment.startsWith('.')) return '路径段不能以 . 开头'
  }
  return undefined
}

/** Shape of the manifest this format carries. */
export interface PresetManifest {
  readonly formatVersion: number
  readonly kind: string
  readonly exportedAt: string
  readonly entry: string
}

/**
 * Parse and validate the archive manifest. Strict on everything that decides
 * where bytes land on disk (version, kind, entry); lenient on `exportedAt`
 * (informational only — an archive missing it is still safe to import).
 * @param raw - the manifest.json bytes.
 * @returns the validated manifest.
 * @throws PresetPackageError with code `bad-package` on any shape violation.
 */
export function parseManifest(raw: Uint8Array): PresetManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw new PresetPackageError('bad-package', 'manifest.json 不是有效的 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PresetPackageError('bad-package', 'manifest.json 应该是一个 JSON 对象')
  }
  const record = parsed as Record<string, unknown>
  if (record.formatVersion !== FORMAT_VERSION) {
    throw new PresetPackageError('bad-package', `预设包格式版本不支持（formatVersion=${String(record.formatVersion)}，当前支持 ${String(FORMAT_VERSION)}）`)
  }
  if (record.kind !== PRESET_KIND) {
    throw new PresetPackageError('bad-package', `这不是预设包（kind=${String(record.kind)}，应为 ${PRESET_KIND}）`)
  }
  const entry = record.entry
  if (typeof entry !== 'string') {
    throw new PresetPackageError('bad-package', 'manifest.json 缺少预设名（entry）')
  }
  const problem = entryNameProblem(entry)
  if (problem !== undefined) {
    throw new PresetPackageError('bad-package', `manifest.json 中的预设名不合法：${problem}`)
  }
  return {
    formatVersion: FORMAT_VERSION,
    kind: PRESET_KIND,
    exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '',
    entry,
  }
}

/** Make an untrusted archive path safe to echo in an error message. */
export function sanitizeArchivePath(name: string): string {
  const printable = name.replace(/[^\x20-\x7e]/g, '?')
  return printable.length > 80 ? `${printable.slice(0, 77)}…` : printable
}
