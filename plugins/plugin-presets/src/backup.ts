/**
 * Config backup pack/restore: a `dsh-config-backup` zip carrying the user's
 * profile patch layer, the profile manifest, the market source list, and the
 * whitelisted top-level store files of every installed suite plugin.
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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { PresetPackageError, zipPathSafetyProblem } from './wire.ts'
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

/** Manifest file name inside the backup archive root. */
export const BACKUP_MANIFEST_NAME = 'manifest.json'

/** Exact archive paths of the profile patch layer and the profile manifest. */
export const PROFILE_PATCH_REL = `${PROFILE_PREFIX}cordis.patch.yml`
export const PROFILE_PACKAGE_REL = `${PROFILE_PREFIX}package.json`

/** Exact archive path of the market source list. */
export const MARKET_SOURCES_REL = `${MARKET_PREFIX}sources.json`

/** Store directory names eligible for the `plugins/` block. */
const PLUGIN_DIR_PATTERN = /^dsh-app-plugin-[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Suffix of the automatic pre-overwrite copy of the profile patch file. */
const PATCH_BACKUP_SUFFIX = '.bak-import-'

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
 * merely contains) a credential-ish token, plus the host's own settings.yaml.
 * Applied in ADDITION to the whitelist — the whitelist is the primary gate,
 * this is the tripwire that keeps a future whitelist edit from leaking keys.
 */
export function isSensitiveFileName(name: string): boolean {
  const lowered = name.toLowerCase()
  return lowered === 'settings.yaml'
    || /credential|token|secret|key/.test(lowered)
}

/**
 * Content-level fail-closed secret rules scanned over every collected file —
 * the file-name whitelist cannot see what a whitelisted file contains, and
 * the whitelisted store files (servers.json/config.json/sources.json) are
 * exactly where suite plugins keep provider keys. All patterns are matched
 * case-insensitively over the decoded text; a hit refuses the export and only
 * the rule name is ever reported, never the matched content.
 */
const SECRET_CONTENT_RULES: ReadonlyArray<{ readonly name: string, readonly pattern: RegExp }> = [
  // The optional `"` before the colon keeps JSON keys (`"Authorization":`)
  // in reach, same as the api-key/token rules below.
  { name: 'authorization', pattern: /authorization"?\s*[:=]/iu },
  { name: 'bearer', pattern: /bearer\s+[a-z0-9._-]{8,}/iu },
  { name: 'sk', pattern: /sk-[a-z0-9]{10,}/iu },
  { name: 'api-key', pattern: /api[_-]?key"?\s*[:=]/iu },
  { name: 'token', pattern: /token"?\s*[:=]\s*"[^"]{8,}/iu },
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
 * @returns a zh-CN reason when rejected, undefined when restorable.
 */
export function backupLayoutProblem(rel: string): string | undefined {
  if (rel === PROFILE_PATCH_REL || rel === PROFILE_PACKAGE_REL || rel === MARKET_SOURCES_REL) {
    return undefined
  }
  if (rel.startsWith(PLUGINS_PREFIX)) {
    const segments = rel.slice(PLUGINS_PREFIX.length).split('/')
    if (segments.length !== 2) return '插件存储条目必须是 plugins/<目录>/<文件> 两层'
    const [dir, file] = segments as [string, string]
    if (!PLUGIN_DIR_PATTERN.test(dir)) return `插件存储目录名不合法：「${dir}」`
    if (!PLUGIN_FILE_WHITELIST.includes(file)) return `插件存储文件不在白名单内：「${file}」`
    if (isSensitiveFileName(file)) return `插件存储文件疑似包含凭据：「${file}」`
    return undefined
  }
  return '路径不属于配置备份的任何已知区块'
}

/** Map one validated archive path to its absolute restore target. */
function restoreTargetOf(home: string, profile: string, rel: string): string {
  if (rel === PROFILE_PATCH_REL || rel === PROFILE_PACKAGE_REL) {
    return join(home, 'profiles', profile, rel.slice(PROFILE_PREFIX.length))
  }
  if (rel === MARKET_SOURCES_REL) {
    return join(home, 'storages', MARKET_STORE_DIR, 'sources.json')
  }
  // layout: plugins/<dir>/<file> — validated by backupLayoutProblem first.
  const [dir, file] = rel.slice(PLUGINS_PREFIX.length).split('/') as [string, string]
  return join(home, 'storages', dir, file)
}

/**
 * Collect every file the backup carries: the profile patch layer and manifest
 * (optional — a fresh install has neither), the market source list, and the
 * whitelisted top-level files of every suite-plugin store directory.
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
        throw new PresetPackageError('sensitive-content', `配置文件「${rel}」命中疑似凭据内容（规则 ${rule}），已拒绝导出；请移除该文件中的凭据后重试`)
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
    throw new PresetPackageError('too-many-files', `配置备份包含 ${String(files.length)} 个文件，超过单包 ${String(MAX_BACKUP_FILE_COUNT)} 个的上限，无法导出`)
  }
  const total = files.reduce((sum, file) => sum + file.data.byteLength, 0)
  if (total > MAX_BACKUP_TOTAL_BYTES) {
    throw new PresetPackageError('too-large', `配置备份总大小超过 ${String(Math.floor(MAX_BACKUP_TOTAL_BYTES / 1024 / 1024))}MB 上限，无法导出`)
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
    throw new PresetPackageError('too-large', `打包后的配置备份超过 ${String(Math.floor(MAX_BACKUP_ZIP_BYTES / 1024 / 1024))}MB 上限，无法导出`)
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
    throw new PresetPackageError('bad-package', 'manifest.json 不是有效的 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PresetPackageError('bad-package', 'manifest.json 应该是一个 JSON 对象')
  }
  if (parsed.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new PresetPackageError('bad-package', `配置备份格式版本不支持（formatVersion=${String(parsed.formatVersion)}，当前支持 ${String(BACKUP_FORMAT_VERSION)}）`)
  }
  if (parsed.kind !== BACKUP_KIND) {
    throw new PresetPackageError('bad-package', `这不是配置备份（kind=${String(parsed.kind)}，应为 ${BACKUP_KIND}）`)
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
          throw new PresetPackageError('bad-package', `配置备份包含重复的成员名「${info.name}」，已拒绝`)
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
    throw new PresetPackageError('bad-package', '无法读取配置备份：不是有效的 ZIP 数据')
  }
  if (totalOriginal > MAX_BACKUP_TOTAL_BYTES) {
    throw new PresetPackageError('too-large', `配置备份解压后总大小超过 ${String(Math.floor(MAX_BACKUP_TOTAL_BYTES / 1024 / 1024))}MB 上限，已拒绝`)
  }
  if (payloadCount > MAX_BACKUP_FILE_COUNT) {
    throw new PresetPackageError('too-many-files', `配置备份包含 ${String(payloadCount)} 个文件，超过单包 ${String(MAX_BACKUP_FILE_COUNT)} 个的上限，已拒绝`)
  }
  // Containment and layout first: every member must be a restorable shape
  // before anything is inflated (the manifest itself is checked after).
  for (const name of names) {
    if (name.endsWith('/') || name === BACKUP_MANIFEST_NAME) continue
    const problem = zipPathSafetyProblem(name) ?? backupLayoutProblem(name)
    if (problem !== undefined) {
      throw new PresetPackageError('illegal-path', `配置备份内存在不允许的路径「${name}」：${problem}，已拒绝`)
    }
  }
  // Pass 2 — bounded inflate of the vetted members: every member's actual
  // byte count must equal its declared size, and the running total aborts
  // the moment it crosses the cap (see zip.ts for why unzipSync cannot).
  const inflated = inflateZipMembersBounded(data, declaredSizes, '配置备份', MAX_BACKUP_TOTAL_BYTES)
  const manifestRaw = inflated.find(member => member.name === BACKUP_MANIFEST_NAME)?.data
  if (manifestRaw === undefined) {
    throw new PresetPackageError('bad-package', '配置备份缺少 manifest.json，不是有效的备份包')
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
  /** Sidecar copies made before overwriting (e.g. the profile patch layer). */
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
 * half-restored config set on disk. Overwriting the profile patch layer
 * first copies it aside as `cordis.patch.yml.bak-import-<timestamp>` so a
 * bad restore is one rename away from recovery.
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
export function restoreConfigBackup(
  home: string,
  profile: string,
  files: readonly BackupFile[],
  overwrite: boolean,
  now: () => Date = () => new Date(),
): RestoreOutcome {
  // Per-member verdict: identical targets are skipped, absent targets are
  // plain writes, and differing targets need the explicit overwrite.
  const planned: Array<{ rel: string, target: string, data: Uint8Array, replacing: boolean }> = []
  const skipped: string[] = []
  const conflicts: string[] = []
  for (const file of files) {
    const problem = backupLayoutProblem(file.rel)
    if (problem !== undefined) {
      throw new PresetPackageError('illegal-path', `配置备份内存在不允许的路径「${file.rel}」：${problem}，已拒绝`)
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
    throw new PresetPackageError(
      'conflict',
      `以下配置文件已存在且内容不同（${String(conflicts.length)} 个）：${conflicts.slice(0, 5).join('、')}${conflicts.length > 5 ? ' 等' : ''}。如需覆盖请确认覆盖导入`,
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
      rmSync(stage, { recursive: true, force: true })
      throw new PresetPackageError('io', `写入配置文件失败（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）`)
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
        // The patch layer is the one file a bad restore can silently break
        // every session with, so it alone gets the automatic sidecar copy.
        if (item.rel === PROFILE_PATCH_REL) {
          const sidecar = `${item.target}${PATCH_BACKUP_SUFFIX}${stamp}`
          copyFileSync(item.target, sidecar)
          backups.push(`${item.rel}${PATCH_BACKUP_SUFFIX}${stamp}`)
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
    const restored = rollbackSwap(stage, swapped, setAside)
    throw new PresetPackageError('io', `写入配置文件失败（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）${restored ? '，已自动还原本次导入的全部变更' : '，部分变更自动还原失败，请检查上述配置文件的当前内容'}`)
  }

  // Committed: the stage only ever held staging copies and set-aside olds.
  rmSync(stage, { recursive: true, force: true })
  for (const item of planned) report.push({ path: item.rel, action: 'written' })
  return { files: report, backups, written: planned.length, unchanged: skipped.length }
}

/**
 * Best-effort undo of a half-finished swap: new files come off their targets
 * first (a rename home needs the path free), then the set-aside old files
 * move back, then the stage dies. Answers whether every step succeeded.
 */
function rollbackSwap(stage: string, swapped: readonly string[], setAside: ReadonlyArray<{ rel: string, target: string }>): boolean {
  let complete = true
  for (const target of [...swapped].reverse()) {
    try {
      rmSync(target, { force: true })
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
    rmSync(stage, { recursive: true, force: true })
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
