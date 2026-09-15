/**
 * Vocabulary and pure validation for the `.dshpreset` package format.
 *
 * The archive layout is fixed: a ZIP holding `manifest.json` at the root and
 * the preset directory's files under `preset/<relative path>`. Everything a
 * route or the store accepts passes through the validators here first, so the
 * safety rules (entry whitelist, path containment, manifest shape, size and
 * count caps) have exactly one home and are testable without any filesystem.
 *
 * Error discipline: every failure carries a stable code plus the values its
 * sentence interpolates ({@link HostText}); the client — which owns the locale
 * dictionary — renders it. No copy ever contains an absolute machine path:
 * archive-relative paths are fine to echo (they describe the untrusted file,
 * not the host), truncated to keep a hostile name from flooding the UI.
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

/**
 * A user-visible message the host cannot localize — and deliberately does not
 * try to.
 *
 * The host is a long-lived child process: its language would be decided at
 * boot, so switching the UI language would require restarting the kernel. It
 * therefore never sends prose. It sends a stable code plus the values the
 * sentence interpolates, and the client — which owns the locale namespace —
 * renders it. `text` is an ENGLISH diagnostic used only for a code this client
 * does not know (an older UI beside a newer kernel); it is never a localized
 * sentence, because matching on one across a boundary is how the kernel-side
 * failure classifier once misread "tampered" as "network error".
 *
 * A composed sentence may put another code of the client's dictionary in a
 * `params` slot: a nested rejection's reason (the outer copy wraps an inner
 * one) or the archive a message is about. The client resolves such a value
 * with the same fallback chain, one level deep; nested codes carry no params
 * of their own.
 */
export interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  /** English developer-facing fallback; shown only for an unknown code. */
  readonly text?: string
}

/**
 * Param value of a filesystem failure that carries no OS error code: a nested
 * code the client dictionary resolves, so the sentence keeps its own locale's
 * wording instead of the host leaking an English placeholder into it.
 */
export const UNKNOWN_ERROR_CODE = 'error.unknown'

/** The OS error code of a filesystem failure, or {@link UNKNOWN_ERROR_CODE}. */
export function fsErrorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? UNKNOWN_ERROR_CODE
}

/** Package-level failure with a stable code the routes map to HTTP statuses. */
export class PresetPackageError extends Error {
  /** Structured extras (e.g. the conflicting entry) surfaced alongside the message. */
  readonly details: Readonly<Record<string, unknown>>

  /**
   * @param code - domain code the routes map to an HTTP status (`too-large`,
   *   `conflict`, …). Kept apart from the message code: the first is a
   *   transport-ish category, the second names a sentence.
   * @param host - the coded message the client renders (see {@link HostText}).
   * @param details - structured extras surfaced alongside the message.
   */
  constructor(readonly code: string, readonly host: HostText, details: Readonly<Record<string, unknown>> = {}) {
    super(host.text ?? host.code)
    this.name = 'PresetPackageError'
    this.details = details
  }

  /** The coded message, in the shape every host route speaks. */
  hostText(): HostText {
    return this.host
  }
}

/**
 * Validate an archive/preset entry name against the whitelist.
 * @param entry - candidate entry (preset directory) name.
 * @returns the coded reason when the name is rejected, undefined when valid.
 */
export function entryNameProblem(entry: string): HostText | undefined {
  if (entry === '') return { code: 'entry.empty', text: 'the preset name is empty' }
  if (!ENTRY_PATTERN.test(entry)) {
    return {
      code: 'entry.pattern',
      text: 'a preset name is lowercase letters, digits and hyphens only, starts with a letter or digit, and is at most 64 characters',
    }
  }
  return undefined
}

/**
 * Validate one archive member path for containment. Rejects absolute paths,
 * `..` segments, backslashes (Windows separator smuggling), dot-leading
 * segments (hidden files / `.ssh`-style surprises) and empty segments.
 * @param name - archive member path as stored (forward slashes).
 * @returns the coded reason when the path is rejected, undefined when safe.
 */
export function zipPathSafetyProblem(name: string): HostText | undefined {
  if (name === '') return { code: 'path.empty', text: 'the path is empty' }
  if (name.includes('\\')) return { code: 'path.backslash', text: 'the path contains a backslash' }
  if (name.startsWith('/')) return { code: 'path.absolute', text: 'the path is absolute' }
  if (/^[a-zA-Z]:/.test(name)) return { code: 'path.absolute', text: 'the path is absolute' }
  for (const segment of name.split('/')) {
    if (segment === '') return { code: 'path.emptySegment', text: 'the path contains an empty segment' }
    if (segment === '..') return { code: 'path.parentSegment', text: 'the path contains a .. segment' }
    if (segment.startsWith('.')) return { code: 'path.hiddenSegment', text: 'a path segment starts with a dot' }
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
    throw new PresetPackageError('bad-package', { code: 'manifest.notJson', text: 'manifest.json is not valid JSON' })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PresetPackageError('bad-package', { code: 'manifest.notObject', text: 'manifest.json must be a JSON object' })
  }
  const record = parsed as Record<string, unknown>
  if (record.formatVersion !== FORMAT_VERSION) {
    throw new PresetPackageError('bad-package', {
      code: 'preset.manifestVersion',
      params: { version: String(record.formatVersion), supported: String(FORMAT_VERSION) },
      text: `unsupported preset formatVersion ${String(record.formatVersion)} (this build supports ${String(FORMAT_VERSION)})`,
    })
  }
  if (record.kind !== PRESET_KIND) {
    throw new PresetPackageError('bad-package', {
      code: 'preset.manifestKind',
      params: { kind: String(record.kind), expected: PRESET_KIND },
      text: `not a preset package: kind=${String(record.kind)}, expected ${PRESET_KIND}`,
    })
  }
  const entry = record.entry
  if (typeof entry !== 'string') {
    throw new PresetPackageError('bad-package', { code: 'preset.manifestEntryMissing', text: 'manifest.json has no entry (preset name)' })
  }
  const problem = entryNameProblem(entry)
  if (problem !== undefined) {
    throw new PresetPackageError('bad-package', {
      code: 'preset.manifestEntryInvalid',
      params: { reason: problem.code },
      text: `the preset name in manifest.json is invalid: ${problem.text ?? problem.code}`,
    })
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
