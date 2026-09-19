/**
 * Config backup pack/restore: a `dsh-config-backup` zip carrying the user's
 * profile patch layer, the profile manifest, the home-level configuration that
 * is not part of any profile (the host settings file and AGENTS.md), the market
 * source list, the whitelisted top-level store files of every installed suite
 * plugin, and the user's own hook files.
 *
 * The host settings file (providers, their model lists, the default model,
 * theme, locale, permissions) is the bulk of what a migration actually needs,
 * so it rides along: it carries credential *references* (`apiKeyEnv` names)
 * and gateway request headers, never key material — dsh keeps the keys in its
 * own credential store, which no backup path ever reads. A header value the
 * user filled with a real key still cannot escape the archive: the content
 * scan below covers this file like every other member. The home's AGENTS.md
 * rides in the same block: hand-written user content that exists nowhere else,
 * which is exactly what a machine migration must not lose.
 *
 * Hook files are the one member with code semantics — the kernel executes them
 * on the target machine — so that block admits a narrow name shape at the top
 * level of `<home>/hooks` only. Importing one is exactly as consequential as
 * importing the settings file beside it, which is why the client copy says to
 * import only a backup the user exported themselves.
 *
 * Redaction is structural plus content-scanned, not a filter list: only exact
 * whitelisted FILE names inside plugin store directories ever enter the
 * archive, any name that smells like a credential
 * (credential/token/secret/key) is refused again at collect time, and every
 * collected file is scanned against secret-shaped content rules — the
 * whitelisted names are exactly where suite plugins keep provider keys, so
 * the name whitelist alone cannot keep a secret out of the archive. A scan
 * hit refuses the export (fail-closed) and reports only the file and rule
 * name, never the matched content.
 *
 * Import mirrors the preset package engine (pack.ts): a decompress-free
 * census pass proves every member path safe, unique, and within the declared
 * caps before anything is inflated; the bounded inflate then proves every
 * member's real byte count against its declared size; layout validation pins
 * each member to its one restore target. Restore is transactional: every
 * member is staged first, then swapped in by rename with a best-effort
 * rollback, so a failed import never leaves a half-restored config set.
 * `profile/package.json` is restored byte-for-byte — it may carry local
 * `file:` dependency paths that only work on the machine that exported the
 * backup, which the client copy states.
 *
 * @module @dsh-app/plugin-presets/backup
 */

import { randomBytes } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { removeTree } from './remove-tree.ts'
import { PresetPackageError, fsErrorCode, zipPathSafetyProblem, type HostText } from './wire.ts'
import { inflateZipMembersBounded } from './zip.ts'

/** `manifest.json` kind marker of a config backup — anything else is rejected. */
export const BACKUP_KIND = 'dsh-config-backup'

/** Config-backup format version this plugin reads and writes. */
export const BACKUP_FORMAT_VERSION = 1

/** Hard cap on the backup zip itself (export output and import upload). */
export const MAX_BACKUP_ZIP_BYTES = 20 * 1024 * 1024

/** Hard cap on the decompressed payload of an imported backup. */
export const MAX_BACKUP_TOTAL_BYTES = 20 * 1024 * 1024

/** Hard cap on the number of files in one backup (the manifest not counted). */
export const MAX_BACKUP_FILE_COUNT = 300

/** Top-level store files a plugin may contribute to a backup. */
export const PLUGIN_FILE_WHITELIST: readonly string[] = ['config.json', 'servers.json', 'sources.json']

/** The market's own store directory — its sources ride the dedicated `market/` block. */
export const MARKET_STORE_DIR = 'dsh-app-plugin-market'

/** Archive layout prefixes. */
export const PROFILE_PREFIX = 'profile/'
export const MARKET_PREFIX = 'market/'
export const PLUGINS_PREFIX = 'plugins/'
export const HOOKS_PREFIX = 'hooks/'

/** Manifest file name inside the backup archive root. */
export const BACKUP_MANIFEST_NAME = 'manifest.json'

/** Exact archive paths of the profile patch layer and the profile manifest. */
export const PROFILE_PATCH_REL = `${PROFILE_PREFIX}cordis.patch.yml`
export const PROFILE_PACKAGE_REL = `${PROFILE_PREFIX}package.json`

/** Exact archive path of the market source list. */
export const MARKET_SOURCES_REL = `${MARKET_PREFIX}sources.json`

/**
 * Exact archive path of the host settings file. It rides at the archive root
 * beside `manifest.json` because it belongs to the home and not to a profile:
 * one settings file serves every profile of the install.
 */
export const HOME_SETTINGS_REL = 'settings.yaml'

/**
 * Exact archive path of the home's agent instructions. Same block as the
 * settings file: it is the user's own hand-written configuration, the one
 * document a migration would otherwise lose silently.
 */
export const HOME_AGENTS_REL = 'AGENTS.md'

/** Store directory names eligible for the `plugins/` block. */
const PLUGIN_DIR_PATTERN = /^dsh-app-plugin-[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * File names the `hooks/` block admits, top level only. Deliberately narrow:
 * the kernel EXECUTES these files on the target machine, so the name is the
 * one thing an archive must not smuggle anything through — no separator, no
 * colon (an NTFS alternate data stream on Windows), no dot-leading name (the
 * archive's own path rules refuse those too, and this keeps export and import
 * agreeing on exactly one name set).
 */
const HOOK_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** Suffix of the automatic pre-overwrite copy of a restored file. */
const OVERWRITE_SIDECAR_SUFFIX = '.bak-import-'

/**
 * The profile a backup applies to. Only DSH_APP_PROFILE names a profiles/
 * subdirectory, so the value must never carry separators; an unusable value
 * degrades to the default `web` (the boot never fails over a backup).
 */
export function effectiveBackupProfile(raw: string | undefined): string {
  const name = (raw ?? '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ? name : 'web'
}

/**
 * Whether a file name must never enter a backup: anything that names (or
 * merely contains) a credential-ish token. Applied in ADDITION to the
 * whitelist, but strictly BEHIND it — every caller tests the whitelist first,
 * so this only ever sees an already-whitelisted name. That is the job: a
 * future whitelist edit that admits a credential-named file still cannot pack
 * it. A key hidden INSIDE a whitelisted file is the content scan's catch, not
 * this one.
 *
 * `settings.yaml` is deliberately NOT matched here. It is the migration
 * payload (providers, their model lists, the default model), and it carries
 * credential *references* and gateway request headers rather than key
 * material; the keys live in dsh's own credential store, which no backup path
 * reads. Its content still goes through the secret scan like any other member.
 */
export function isSensitiveFileName(name: string): boolean {
  return /credential|token|secret|key/.test(name.toLowerCase())
}

/**
 * Content-level fail-closed secret rules scanned over every collected file —
 * the file-name whitelist cannot see what a whitelisted file contains, and
 * the whitelisted store files (servers.json/config.json/sources.json) are
 * exactly where suite plugins keep provider keys. The host settings file is
 * the other subject: it is free-form YAML, and its provider request headers
 * are the one place a user can paste a real key by hand. All patterns are
 * matched case-insensitively over the decoded text; a hit refuses the export
 * and only the rule name is ever reported, never the matched content.
 */
const SECRET_CONTENT_RULES: ReadonlyArray<{ readonly name: string, readonly pattern: RegExp }> = [
  // The optional `"` before the colon keeps JSON keys (`"Authorization":`)
  // in reach, same as the api-key/token rules below.
  { name: 'authorization', pattern: /authorization"?\s*[:=]/iu },
  { name: 'bearer', pattern: /bearer\s+[a-z0-9._-]{8,}/iu },
  // The `\b` is load-bearing: without it "task-oriented" reads as a key. The
  // prefix families mirror the shapes plugin-memory already vets, whose scan
  // runs over free text and therefore carries the stricter boundary work.
  { name: 'sk', pattern: /\bsk[-_][a-z0-9_-]{16,}\b/iu },
  { name: 'github', pattern: /\b(gh[pousr]|github_pat)_[a-z0-9_]{16,}\b/iu },
  { name: 'slack', pattern: /\bxox[bpas]-[a-z0-9-]+/iu },
  { name: 'api-key', pattern: /api[_-]?key"?\s*[:=]/iu },
  // Every value rule below accepts THREE shapes: a double-quoted value of at
  // least 8 characters (how a JSON store file writes one), a single-quoted one
  // (hand-written YAML), or a bare scalar (how the YAML host settings file
  // writes one). The quoted branches are the original rules unchanged — a rule
  // may only ever grow, or a shape it used to refuse would start passing. The
  // bare branch's length is its only guard against refusing a number
  // (`token: 4096`); `secret`/`password` also match their `*_key` spellings.
  { name: 'token', pattern: /token"?\s*[:=]\s*("[^"]{8,}|'[^']{8,}|[a-z0-9._-]{12,})/iu },
  { name: 'secret', pattern: /secret(?:[_-]?key)?"?\s*[:=]\s*("[^"]{8,}|'[^']{8,}|[a-z0-9._-]{8,})/iu },
  { name: 'password', pattern: /password"?\s*[:=]\s*("[^"]{8,}|'[^']{8,}|[a-z0-9._-]{8,})/iu },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
]

/**
 * The name of the first secret rule matching the file's decoded text, or
 * undefined when the content scans clean.
 * @param data - the file's raw bytes.
 */
export function secretScanRuleHit(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data)
  for (const rule of SECRET_CONTENT_RULES) {
    if (rule.pattern.test(text)) return rule.name
  }
  return undefined
}

/** One file collected for (or restored from) a backup. */
export interface BackupFile {
  /** Archive path (forward slashes), e.g. `plugins/dsh-app-plugin-x/config.json`. */
  readonly rel: string
  readonly data: Uint8Array
}

/** The validated manifest of a config backup (kind/version strict, rest lenient). */
export interface BackupManifest {
  readonly formatVersion: number
  readonly kind: string
  readonly exportedAt: string
}

/**
 * Whether an archive path is a layout member this plugin restores. Every
 * member must map to one exact profile/market block or one whitelisted file
 * of a suite-plugin store directory — a backup carries known shapes only, so
 * an unexpected member is a tampered or foreign archive, not a skip candidate.
 * @param rel - archive path (already through the traversal safety rules).
 * @returns the coded reason when rejected, undefined when restorable.
 */
export function backupLayoutProblem(rel: string): HostText | undefined {
  if (rel === HOME_SETTINGS_REL
    || rel === HOME_AGENTS_REL
    || rel === PROFILE_PATCH_REL
    || rel === PROFILE_PACKAGE_REL
    || rel === MARKET_SOURCES_REL) {
    return undefined
  }
  if (rel.startsWith(HOOKS_PREFIX)) {
    const name = rel.slice(HOOKS_PREFIX.length)
    if (!HOOK_FILE_PATTERN.test(name)) {
      return { code: 'backup.hookFileInvalid', params: { name }, text: `invalid hook file name: "${name}"` }
    }
    if (isSensitiveFileName(name)) {
      return { code: 'backup.hookFileSensitive', params: { name }, text: `the hook file looks credential-bearing: "${name}"` }
    }
    return undefined
  }
  if (rel.startsWith(PLUGINS_PREFIX)) {
    const segments = rel.slice(PLUGINS_PREFIX.length).split('/')
    if (segments.length !== 2) {
      return { code: 'backup.storeEntryShape', text: 'a plugin store entry must be exactly plugins/<directory>/<file>' }
    }
    const [dir, file] = segments as [string, string]
    if (!PLUGIN_DIR_PATTERN.test(dir)) {
      return { code: 'backup.storeDirInvalid', params: { dir }, text: `invalid plugin store directory name: "${dir}"` }
    }
    if (!PLUGIN_FILE_WHITELIST.includes(file)) {
      return { code: 'backup.storeFileNotAllowed', params: { file }, text: `the plugin store file is not whitelisted: "${file}"` }
    }
    if (isSensitiveFileName(file)) {
      return { code: 'backup.storeFileSensitive', params: { file }, text: `the plugin store file looks credential-bearing: "${file}"` }
    }
    return undefined
  }
  return { code: 'backup.unknownBlock', text: 'the path belongs to no known section of a configuration backup' }
}

/** Map one validated archive path to its absolute restore target. */
function restoreTargetOf(home: string, profile: string, rel: string): string {
  if (rel === PROFILE_PATCH_REL || rel === PROFILE_PACKAGE_REL) {
    return join(home, 'profiles', profile, rel.slice(PROFILE_PREFIX.length))
  }
  if (rel === MARKET_SOURCES_REL) {
    return join(home, 'storages', MARKET_STORE_DIR, 'sources.json')
  }
  if (rel === HOME_SETTINGS_REL || rel === HOME_AGENTS_REL) {
    return join(home, rel)
  }
  if (rel.startsWith(HOOKS_PREFIX)) {
    return join(home, 'hooks', rel.slice(HOOKS_PREFIX.length))
  }
  // layout: plugins/<dir>/<file> — validated by backupLayoutProblem first.
  const [dir, file] = rel.slice(PLUGINS_PREFIX.length).split('/') as [string, string]
  return join(home, 'storages', dir, file)
}

/**
 * Collect every file the backup carries: the profile patch layer and manifest
 * (optional — a fresh install has neither), the home-level settings file and
 * AGENTS.md, the market source list, the hook files, and the whitelisted
 * top-level files of every suite-plugin store directory.
 * @param home - the dsh home root.
 * @param profile - the profile whose patch layer and manifest are packed.
 * @returns the archive payload (manifest.json not included).
 * @throws PresetPackageError with codes `too-many-files`, `too-large`,
 *   `sensitive-content`, `io`.
 */
export async function collectConfigBackup(home: string, profile: string): Promise<BackupFile[]> {
  const files: BackupFile[] = []
  const add = (rel: string, path: string): void => {
    try {
      // Export never follows symlinks: a link named like a whitelisted file
      // would pull its target's content into the shareable archive.
      if (lstatSync(path).isSymbolicLink()) return
      if (!statSync(path).isFile()) return
      const data = readFileSync(path)
      const rule = secretScanRuleHit(data)
      if (rule !== undefined) {
        throw new PresetPackageError('sensitive-content', {
          code: 'backup.secretContent',
          params: { rel, rule },
          text: `configuration file "${rel}" matched a credential-like pattern (rule ${rule}); the export was refused`,
        })
      }
      files.push({ rel, data })
    } catch (error) {
      if (error instanceof PresetPackageError) throw error
      // Absent/unreadable optional member: the backup just carries less.
    }
  }
  const profileDir = join(home, 'profiles', profile)
  add(PROFILE_PATCH_REL, join(profileDir, 'cordis.patch.yml'))
  add(PROFILE_PACKAGE_REL, join(profileDir, 'package.json'))
  add(MARKET_SOURCES_REL, join(home, 'storages', MARKET_STORE_DIR, 'sources.json'))
  // Optional like the rest: a fresh install may not have written one yet.
  add(HOME_SETTINGS_REL, join(home, 'settings.yaml'))
  add(HOME_AGENTS_REL, join(home, 'AGENTS.md'))

  // The kernel EXECUTES hook files on the target machine, so the block admits
  // one narrow name shape, top level only, and rides the same content scan.
  let hookNames: string[]
  try {
    hookNames = await readdir(join(home, 'hooks'))
  } catch {
    hookNames = [] // no hooks directory yet: nothing to pack
  }
  for (const name of [...hookNames].sort((a, b) => a.localeCompare(b))) {
    if (!HOOK_FILE_PATTERN.test(name) || isSensitiveFileName(name)) continue
    add(`${HOOKS_PREFIX}${name}`, join(home, 'hooks', name))
  }

  let storeDirs: string[]
  try {
    storeDirs = (await readdir(join(home, 'storages'), { withFileTypes: true }))
      .filter(child => child.isDirectory() && PLUGIN_DIR_PATTERN.test(child.name) && child.name !== MARKET_STORE_DIR)
      .map(child => child.name)
  } catch {
    storeDirs = [] // no storages root yet: nothing plugin-side to pack
  }
  for (const dir of [...storeDirs].sort((a, b) => a.localeCompare(b))) {
    let names: string[]
    try {
      names = await readdir(join(home, 'storages', dir))
    } catch {
      continue // unreadable store: skipped, never fatal for the whole backup
    }
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      if (!PLUGIN_FILE_WHITELIST.includes(name)) continue
      // Tripwire beside the whitelist: a credential-named file never packs,
      // even if a future whitelist edit admits it.
      if (isSensitiveFileName(name)) continue
      add(`${PLUGINS_PREFIX}${dir}/${name}`, join(home, 'storages', dir, name))
    }
  }

  if (files.length > MAX_BACKUP_FILE_COUNT) {
    throw new PresetPackageError('too-many-files', {
      code: 'backup.exportTooManyFiles',
      params: { count: files.length, cap: MAX_BACKUP_FILE_COUNT },
      text: `the configuration backup has ${String(files.length)} files, over the ${String(MAX_BACKUP_FILE_COUNT)}-file per-package cap; it cannot be exported`,
    })
  }
  const total = files.reduce((sum, file) => sum + file.data.byteLength, 0)
  if (total > MAX_BACKUP_TOTAL_BYTES) {
    throw new PresetPackageError('too-large', {
      code: 'backup.exportTooLarge',
      params: { mb: Math.floor(MAX_BACKUP_TOTAL_BYTES / 1024 / 1024) },
      text: `the configuration backup is over the ${String(Math.floor(MAX_BACKUP_TOTAL_BYTES / 1024 / 1024))} MB total-size cap; it cannot be exported`,
    })
  }
  return files
}

/**
 * Pack a config backup: manifest first, then the collected payload, zipped in
 * memory.
 * @param home - the dsh home root.
 * @param profile - the profile whose patch layer and manifest are packed.
 * @returns the archive bytes (≤ MAX_BACKUP_ZIP_BYTES).
 * @throws PresetPackageError with codes from {@link collectConfigBackup} or `too-large`.
 */
export async function packConfigBackup(home: string, profile: string): Promise<Uint8Array> {
  const files = await collectConfigBackup(home, profile)
  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    kind: BACKUP_KIND,
    exportedAt: new Date().toISOString(),
    app: 'dsh-app',
  }
  const zipped: Zippable = { [BACKUP_MANIFEST_NAME]: strToU8(JSON.stringify(manifest)) }
  for (const file of files) {
    // readFile returns a Buffer, which satisfies fflate's Uint8Array slots.
    zipped[file.rel] = file.data
  }
  const bytes = zipSync(zipped)
  if (bytes.byteLength > MAX_BACKUP_ZIP_BYTES) {
    throw new PresetPackageError('too-large', {
      code: 'backup.archiveTooLarge',
      params: { mb: Math.floor(MAX_BACKUP_ZIP_BYTES / 1024 / 1024) },
      text: `the packed configuration backup is over the ${String(Math.floor(MAX_BACKUP_ZIP_BYTES / 1024 / 1024))} MB cap; it cannot be exported`,
    })
  }
  return bytes
}

/** Shape of the manifest a config backup carries. */
interface RawManifest {
  formatVersion?: unknown
  kind?: unknown
  exportedAt?: unknown
}

/** Parse + validate the backup manifest; kind and formatVersion are strict. */
function parseBackupManifest(raw: Uint8Array): BackupManifest {
  let parsed: RawManifest
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as RawManifest
  } catch {
    throw new PresetPackageError('bad-package', { code: 'manifest.notJson', text: 'manifest.json is not valid JSON' })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PresetPackageError('bad-package', { code: 'manifest.notObject', text: 'manifest.json must be a JSON object' })
  }
  if (parsed.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new PresetPackageError('bad-package', {
      code: 'backup.manifestVersion',
      params: { version: String(parsed.formatVersion), supported: String(BACKUP_FORMAT_VERSION) },
      text: `unsupported configuration-backup formatVersion ${String(parsed.formatVersion)} (this build supports ${String(BACKUP_FORMAT_VERSION)})`,
    })
  }
  if (parsed.kind !== BACKUP_KIND) {
    throw new PresetPackageError('bad-package', {
      code: 'backup.manifestKind',
      params: { kind: String(parsed.kind), expected: BACKUP_KIND },
      text: `not a configuration backup: kind=${String(parsed.kind)}, expected ${BACKUP_KIND}`,
    })
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    kind: BACKUP_KIND,
    // Informational only — an archive missing it is still safe to import.
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
  }
}

/**
 * Unpack and fully validate an uploaded backup. Every safety decision is made
 * before inflation: caps, path traversal, layout, then the manifest.
 * @param data - the uploaded archive bytes (caller already capped).
 * @returns the payload files to restore.
 * @throws PresetPackageError with codes `bad-package`, `illegal-path`,
 * `too-large`, `too-many-files`.
 */
export function unpackConfigBackup(data: Uint8Array): BackupFile[] {
  // Pass 1 — census: the filter always returns false, so fflate enumerates
  // every member and decompresses none; totals are checked from metadata.
  // Duplicate names are refused here (later entries would otherwise silently
  // shadow earlier ones), and the declared sizes feed the bounded inflate.
  const names: string[] = []
  const declaredSizes = new Map<string, number>()
  let totalOriginal = 0
  let payloadCount = 0
  try {
    unzipSync(data, {
      filter: (info) => {
        if (declaredSizes.has(info.name)) {
          throw new PresetPackageError('bad-package', {
            code: 'backup.duplicateMember',
            params: { name: info.name },
            text: `the configuration backup contains a duplicate member name "${info.name}"; refused`,
          })
        }
        names.push(info.name)
        if (!info.name.endsWith('/')) {
          declaredSizes.set(info.name, info.originalSize)
          // The manifest counts toward the size cap too: every inflated byte
          // must be covered by the census, the count cap tracks restore targets.
          totalOriginal += info.originalSize
          if (info.name !== BACKUP_MANIFEST_NAME) payloadCount += 1
        }
        return false
      },
    })
  } catch (error) {
    if (error instanceof PresetPackageError) throw error
    throw new PresetPackageError('bad-package', { code: 'backup.notZip', text: 'cannot read the configuration backup: not valid ZIP data' })
  }
  if (totalOriginal > MAX_BACKUP_TOTAL_BYTES) {
    throw new PresetPackageError('too-large', {
      code: 'backup.decompressedTooLarge',
      params: { mb: Math.floor(MAX_BACKUP_TOTAL_BYTES / 1024 / 1024) },
      text: `the decompressed configuration backup exceeds the ${String(Math.floor(MAX_BACKUP_TOTAL_BYTES / 1024 / 1024))} MB cap; refused`,
    })
  }
  if (payloadCount > MAX_BACKUP_FILE_COUNT) {
    throw new PresetPackageError('too-many-files', {
      code: 'backup.importTooManyFiles',
      params: { count: payloadCount, cap: MAX_BACKUP_FILE_COUNT },
      text: `the configuration backup has ${String(payloadCount)} files, over the ${String(MAX_BACKUP_FILE_COUNT)}-file per-package cap; refused`,
    })
  }
  // Containment and layout first: every member must be a restorable shape
  // before anything is inflated (the manifest itself is checked after).
  for (const name of names) {
    if (name.endsWith('/') || name === BACKUP_MANIFEST_NAME) continue
    const problem = zipPathSafetyProblem(name) ?? backupLayoutProblem(name)
    if (problem !== undefined) {
      throw new PresetPackageError('illegal-path', {
        code: 'backup.illegalPath',
        params: { path: name, reason: problem.code },
        text: `the configuration backup contains a forbidden path "${name}": ${problem.text ?? problem.code}; refused`,
      })
    }
  }
  // Pass 2 — bounded inflate of the vetted members: every member's actual
  // byte count must equal its declared size, and the running total aborts
  // the moment it crosses the cap (see zip.ts for why unzipSync cannot).
  const inflated = inflateZipMembersBounded(data, declaredSizes, 'backup', MAX_BACKUP_TOTAL_BYTES)
  const manifestRaw = inflated.find(member => member.name === BACKUP_MANIFEST_NAME)?.data
  if (manifestRaw === undefined) {
    throw new PresetPackageError('bad-package', {
      code: 'backup.manifestMissing',
      text: 'the configuration backup has no manifest.json, so it is not a valid backup package',
    })
  }
  parseBackupManifest(manifestRaw)
  return inflated
    .filter(member => member.name !== BACKUP_MANIFEST_NAME)
    .map(member => ({ rel: member.name, data: member.data }))
}

/** What one restore did to one archive member. */
export type RestoreAction = 'written' | 'unchanged'

/** One line of the restore report (archive paths only, never disk paths). */
export interface RestoredFile {
  readonly path: string
  readonly action: RestoreAction
}

/** The outcome of a successful restore. */
export interface RestoreOutcome {
  readonly files: readonly RestoredFile[]
  /** Sidecar copies made before overwriting (the profile patch layer and the host settings file). */
  readonly backups: readonly string[]
  /** How many members actually changed on disk. */
  readonly written: number
  /** How many members were already identical and skipped. */
  readonly unchanged: number
}

/** Archive-safe timestamp for the pre-overwrite sidecar copies. */
function backupStamp(now: () => Date): string {
  return now().toISOString().replace(/[:.]/g, '-')
}

/**
 * Restore a validated backup payload. A member whose target already exists
 * with identical content is skipped; a differing target requires the explicit
 * `overwrite` — otherwise the whole restore refuses with the conflict list
 * (all-or-nothing: a partial import of a config set is worse than none).
 * The restore itself is transactional: every member is staged into a random
 * `~/.config-import-stage-<rand>/` mirror first, and only after ALL of them
 * are written does the swap begin — each replaced old file steps aside into
 * the stage and each new file renames into place. Any swap failure deletes
 * the already-swapped new files, moves the old ones back, and reports `io`
 * with the auto-restore note, so no failure sequence can leave a
 * half-restored config set on disk. Overwriting the profile patch layer or
 * the host settings file first copies the old one aside as
 * `<name>.bak-import-<timestamp>` so a bad restore is one rename away from
 * recovery.
 * @param home - the dsh home root.
 * @param profile - the profile the profile-block members apply to.
 * @param files - validated payload from {@link unpackConfigBackup}.
 * @param overwrite - replace differing existing files.
 * @param now - injectable clock for the sidecar timestamp.
 * @returns the restore report.
 * @throws PresetPackageError with code `conflict` when differing files exist
 *   and `overwrite` is false, `illegal-path` on a layout violation, `io` on
 *   write failures (after best-effort rollback).
 */
export async function restoreConfigBackup(
  home: string,
  profile: string,
  files: readonly BackupFile[],
  overwrite: boolean,
  now: () => Date = () => new Date(),
): Promise<RestoreOutcome> {
  // Per-member verdict: identical targets are skipped, absent targets are
  // plain writes, and differing targets need the explicit overwrite.
  const planned: Array<{ rel: string, target: string, data: Uint8Array, replacing: boolean }> = []
  const skipped: string[] = []
  const conflicts: string[] = []
  for (const file of files) {
    const problem = backupLayoutProblem(file.rel)
    if (problem !== undefined) {
      throw new PresetPackageError('illegal-path', {
        code: 'backup.illegalPath',
        params: { path: file.rel, reason: problem.code },
        text: `the configuration backup contains a forbidden path "${file.rel}": ${problem.text ?? problem.code}; refused`,
      })
    }
    const target = restoreTargetOf(home, profile, file.rel)
    const existing = readFileSyncIfExists(target)
    if (existing !== undefined && existing.equals(Buffer.from(file.data))) {
      skipped.push(file.rel)
      continue
    }
    if (existing !== undefined && !overwrite) {
      conflicts.push(file.rel)
      continue
    }
    planned.push({ rel: file.rel, target, data: file.data, replacing: existing !== undefined })
  }
  if (conflicts.length > 0) {
    // Never rendered: the client turns any 409 into its own overwrite dialog
    // and reads `details.files` for the list (see the presets section). The
    // sentence is therefore an English diagnostic, not dictionary copy.
    throw new PresetPackageError(
      'conflict',
      {
        code: 'backup.conflict',
        params: { count: conflicts.length, files: conflicts.slice(0, 5).join(', ') },
        text: `${String(conflicts.length)} configuration files already exist with different content: ${conflicts.slice(0, 5).join(', ')}; confirm the overwrite to replace them`,
      },
      { files: conflicts },
    )
  }

  const stage = join(home, `.config-import-stage-${randomBytes(6).toString('hex')}`)
  const report: RestoredFile[] = skipped.map(rel => ({ path: rel, action: 'unchanged' as const }))
  const backups: string[] = []
  const stamp = backupStamp(now)

  // Phase 1 — stage every planned member in the mirror layout. Nothing on
  // the restore targets has been touched yet, so a failure here just cleans
  // up the stage.
  for (const item of planned) {
    try {
      const stagedPath = join(stage, item.rel)
      mkdirSync(dirname(stagedPath), { recursive: true })
      writeFileSync(stagedPath, item.data)
    } catch (error) {
      await removeTree(stage)
      throw new PresetPackageError('io', {
        code: 'backup.writeFailed',
        params: { code: fsErrorCode(error) },
        text: `cannot write a configuration file (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
      })
    }
  }

  // Phase 2 — swap by rename: old files step aside into stage/old, new files
  // take their place. Renames stay inside the home volume, so they are
  // atomic per member; a failure anywhere rolls the whole swap back.
  const setAside: Array<{ rel: string, target: string }> = []
  const swapped: string[] = []
  try {
    for (const item of planned) {
      mkdirSync(dirname(item.target), { recursive: true })
      if (item.replacing) {
        // The patch layer and the settings file are the two members a bad
        // restore can silently break every session with — the patch composes
        // the loader rows, the settings carry the providers — so each gets an
        // automatic sidecar copy before it is replaced.
        if (item.rel === PROFILE_PATCH_REL || item.rel === HOME_SETTINGS_REL) {
          const sidecar = `${item.target}${OVERWRITE_SIDECAR_SUFFIX}${stamp}`
          copyFileSync(item.target, sidecar)
          backups.push(`${item.rel}${OVERWRITE_SIDECAR_SUFFIX}${stamp}`)
        }
        const oldPath = join(stage, 'old', item.rel)
        mkdirSync(dirname(oldPath), { recursive: true })
        renameSync(item.target, oldPath)
        setAside.push({ rel: item.rel, target: item.target })
      }
      renameSync(join(stage, item.rel), item.target)
      swapped.push(item.target)
    }
  } catch (error) {
    const restored = await rollbackSwap(stage, swapped, setAside)
    const code = fsErrorCode(error)
    const osCode = (error as NodeJS.ErrnoException).code ?? 'unknown'
    throw new PresetPackageError('io', restored
      ? {
          code: 'backup.writeFailedRestored',
          params: { code },
          text: `cannot write a configuration file (${osCode}); every change of this import was rolled back`,
        }
      : {
          code: 'backup.writeFailedRollbackFailed',
          params: { code },
          text: `cannot write a configuration file (${osCode}); the automatic rollback of some changes failed — check the current content of those files`,
        })
  }

  // Committed: the stage only ever held staging copies and set-aside olds.
  await removeTree(stage)
  for (const item of planned) report.push({ path: item.rel, action: 'written' })
  return { files: report, backups, written: planned.length, unchanged: skipped.length }
}

/**
 * Best-effort undo of a half-finished swap: new files come off their targets
 * first (a rename home needs the path free), then the set-aside old files
 * move back, then the stage dies. Answers whether every step succeeded.
 */
async function rollbackSwap(stage: string, swapped: readonly string[], setAside: ReadonlyArray<{ rel: string, target: string }>): Promise<boolean> {
  let complete = true
  for (const target of [...swapped].reverse()) {
    try {
      await removeTree(target)
    } catch {
      complete = false
    }
  }
  for (const item of [...setAside].reverse()) {
    try {
      renameSync(join(stage, 'old', item.rel), item.target)
    } catch {
      complete = false
    }
  }
  try {
    await removeTree(stage)
  } catch {
    complete = false
  }
  return complete
}

/** Read a file, answering undefined when absent or unreadable. */
function readFileSyncIfExists(path: string): Buffer | undefined {
  try {
    return readFileSync(path)
  } catch {
    return undefined
  }
}
