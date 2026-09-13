import { app, shell, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import semver from 'semver'
import { autoUpdater } from 'electron-updater'
import {
  APP_NAME,
  MODELSCOPE_ENDPOINT,
  MODELSCOPE_RELEASES_URL,
  MODELSCOPE_REPO,
  resolveArtifactOwner,
  resolveArtifactRepo,
} from '../shared/constants'
import { githubMirrorPrefixes } from '../kernel/sources/artifact'
import { inFrameDialogScript } from './in-frame-dialog'
import { readJsonFile, writeJsonFileAtomic } from './json-file'
import { noticeThemedDialog, promptThemedDialog } from './themed-dialog'
import { clearKernelProgress, showKernelProgress, showToastWhenLoaded, showUpdateToast } from './window'

let initialized = false
let busy = false

/**
 * Prompt a themed in-window confirmation (in-frame dialog script) with a
 * native showMessageBox fallback. Used by the shell-updater confirmations;
 * the target window is the focused one (or any open window) so these work on
 * macOS/Linux where the updater listeners live.
 * @param config - the in-frame dialog config.
 * @param native - native fallback options.
 * @returns true when the user picked the primary (download/restart) action.
 */
async function confirmInFrame(
  config: Parameters<typeof inFrameDialogScript>[0],
  native: Electron.MessageBoxOptions,
  primaryValue: string,
): Promise<boolean> {
  return promptThemedDialog(null, inFrameDialogScript(config), native, (value, nativeResponse) => {
    if (value !== '') return value === primaryValue
    return nativeResponse === 0
  })
}

/**
 * Themed single-button notice (info/warning/error) with native fallback,
 * scoped to a caller-known window. The outcome is unused — a notice is just a
 * confirm with one button.
 * @param win - the hosting window (null/destroyed falls back to native).
 * @param type - severity, used by the native fallback's icon only.
 * @param title - card title.
 * @param message - message line.
 */
async function noticeInFrame(
  win: BrowserWindow | null,
  type: 'info' | 'warning' | 'error',
  title: string,
  message: string,
): Promise<void> {
  await noticeThemedDialog(
    win,
    type,
    title,
    message,
    inFrameDialogScript({
      title,
      message,
      buttons: [{ label: '确定', value: 'ok', primary: true }],
      cancelValue: 'ok',
      enterValue: 'ok',
    }),
  )
}

/**
 * Shell update channel.
 *
 * Windows (primary market, mainland-first): a custom flow replaces
 * electron-updater — detect via latest.yml (GitHub `releases/latest` alias, or
 * its ModelScope mirror), pick the installer for the running arch, download
 * with a ModelScope-first / GitHub / mirror-prefix fallback chain, verify the
 * sha512 from latest.yml, then run the NSIS installer silently and quit. This
 * is what makes app updates work without a proxy in mainland China.
 *
 * macOS / Linux: keep electron-updater (native update formats), but surface
 * errors in a dialog and offer a release-page fallback. The ModelScope mirror
 * cannot back those platforms: electron-updater needs a static directory feed
 * while the ModelScope API is query-shaped (`.../repo?FilePath=<path>`).
 *
 * The dsh kernel is updated separately by the KernelManager; the two channels
 * stay decoupled.
 */
export function initShellUpdater(): void {
  if (initialized) return
  initialized = true
  if (process.platform === 'win32' || process.env.DSH_APP_DEV === '1') return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', async (info) => {
    const proceed = await confirmInFrame(
      {
        title: `${APP_NAME} 更新可用`,
        message: `发现新版本 ${APP_NAME}（${info.version}）。`,
        detail: '现在下载并安装？应用将在完成后重启。',
        buttons: [
          { label: '稍后', value: 'later' },
          { label: '下载', value: 'download', primary: true },
        ],
        cancelValue: 'later',
        enterValue: 'download',
      },
      {
        type: 'info',
        title: `${APP_NAME} 更新可用`,
        message: `发现新版本 ${APP_NAME}（${info.version}）。`,
        detail: '现在下载并安装？应用将在完成后重启。',
        buttons: ['下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
      },
      'download',
    )
    if (proceed) {
      try {
        await autoUpdater.downloadUpdate()
      } catch (err) {
        void showDownloadError(`下载失败：${(err as Error).message}`)
      }
    }
  })

  autoUpdater.on('update-downloaded', async () => {
    const proceed = await confirmInFrame(
      {
        title: `${APP_NAME} 更新就绪`,
        message: '更新已下载完成，将在退出时安装。',
        buttons: [
          { label: '稍后', value: 'later' },
          { label: '立即重启', value: 'restart', primary: true },
        ],
        cancelValue: 'later',
        enterValue: 'restart',
      },
      {
        type: 'info',
        title: `${APP_NAME} 更新就绪`,
        message: '更新已下载完成，将在退出时安装。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      },
      'restart',
    )
    if (proceed) autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (_err) => {
    // The download path above surfaces its own dialog; keep this quiet.
  })
}

// ------------------------------------------------------------- latest.yml

/** One entry of the `files:` block inside electron-builder's latest.yml. */
interface UpdateFileEntry {
  url: string
  sha512: string
}

interface LatestYaml {
  version: string
  files: UpdateFileEntry[]
}

/**
 * Minimal parser for electron-builder's latest.yml — the two keys the custom
 * Windows flow needs (version + files[].url/sha512). Avoids a YAML dependency
 * (project keeps deps minimal); the format is a fixed flat shape:
 *
 *   version: 0.1.9
 *   files:
 *     - url: DSH-APP-0.1.9-win-x64.exe
 *       sha512: <base64>
 *       size: 123
 *   path: ...
 */
export function parseLatestYaml(text: string): LatestYaml | null {
  let version = ''
  const files: UpdateFileEntry[] = []
  let current: Partial<UpdateFileEntry> | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line.trim() || line.startsWith('#')) continue

    // List item: "- url: ..." — only items that begin a file entry count.
    // Other list shapes (e.g. a future "- note: ..." releaseNotes block) are
    // not file entries and must not produce garbage url-less records.
    const dash = /^(\s*)-\s*(.+)$/.exec(line)
    if (dash) {
      const kv = /^([\w.-]+):\s*(.*)$/.exec(dash[2])
      if (!kv || kv[1] !== 'url') {
        current = null
        continue
      }
      current = { url: kv[2].trim() }
      files.push(current as UpdateFileEntry)
      continue
    }

    const kv = /^([\w.-]+):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    const key = kv[1]
    const value = kv[2].trim()
    // Indented key under the current file entry (e.g. "    sha512: ...").
    if (current && files.length > 0 && line.startsWith(' ') && key !== 'version') {
      ;(current as Record<string, string>)[key] = value
      continue
    }
    if (key === 'version' && !version) version = value
    current = null
  }

  if (!version || files.length === 0) return null
  return { version, files }
}

/** The verified metadata URL chain (mirror first, then official GitHub, then mirror prefixes). */
export function latestYamlCandidates(owner: string, repo: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/latest/download/latest.yml`
  return [modelscopeReleaseFileUrl('releases/latest/latest.yml'), official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
}

/**
 * ModelScope FilePath URL for one file in the mirror repo. The directory part
 * is fixed by this module; the filename comes from latest.yml (already trusted
 * for the GitHub URLs). Each path segment is encoded, which keeps the slashes
 * literal (the verified URL shape) while a crafted name can neither smuggle
 * `&`/`#` nor turn a literal `+` into a space.
 */
export function modelscopeReleaseFileUrl(relativePath: string): string {
  const encodedPath = relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `${MODELSCOPE_ENDPOINT}/api/v1/models/${MODELSCOPE_REPO}/repo?Revision=master&FilePath=${encodedPath}`
}

/** True when a metadata URL came from the ModelScope mirror. */
function isModelscopeSource(source: string): boolean {
  return source.startsWith(`${MODELSCOPE_ENDPOINT}/`)
}

/** Short diagnostic label for one source URL (no secrets on this chain). */
function sourceLabel(url: string): string {
  return isModelscopeSource(url) ? 'modelscope' : url
}

/**
 * Installer download candidates for one asset, same-source-first: metadata
 * served by the mirror makes the mirror lead, with official GitHub and its
 * prefixes kept as fallbacks; metadata from GitHub keeps the original order.
 * Either way the ModelScope mirror closes the chain as the last resort.
 *
 * Why the mirror is a safe last resort even when the metadata came from
 * GitHub: the mainland failure topology is asymmetric — a small latest.yml
 * often slips through (corporate proxy / brief connectivity) while a ~180 MB
 * installer consistently dies. Without the trailing mirror those users only
 * ever see "请手动下载". Every candidate is gated by the sha512 taken from
 * that same latest.yml, so a mirror serving a *different* build (lagging or
 * tampered) fails verification and falls through — it can degrade to a
 * slower download, never substitute content. When metadata came from the
 * mirror the same URL leads instead of being appended twice.
 */
export function assetCandidates(owner: string, repo: string, assetUrl: string, metadataSource: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/latest/download/${assetUrl}`
  const mirror = modelscopeReleaseFileUrl(`releases/latest/${assetUrl}`)
  const fallbacks = [official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
  return isModelscopeSource(metadataSource) ? [mirror, ...fallbacks] : [...fallbacks, mirror]
}

/** Pick the installer matching the running arch (x64 primary, arm64 explicit). */
export function pickAsset(files: UpdateFileEntry[], arch: string): UpdateFileEntry | null {
  // Defensive: only real file entries (url + sha512) are candidates — a
  // malformed / future metadata shape must not throw on undefined.url.
  const assets = files.filter((f) => typeof f.url === 'string' && f.url.length > 0 && typeof f.sha512 === 'string' && f.sha512.length > 0)
  const archSuffix = `-win-${arch}.exe`
  const byArch = assets.find((f) => f.url.endsWith(archSuffix))
  if (byArch) return byArch
  // Fallbacks: the generic `*-win.exe` (x64) or the x64-named asset.
  return assets.find((f) => /-win\.exe$/.test(f.url) || /-win-x64\.exe$/.test(f.url)) ?? assets.find((f) => f.url.endsWith('.exe')) ?? null
}

/** sha512 (base64, as latest.yml encodes it) of the downloaded installer. */
async function sha512Base64(filePath: string): Promise<string> {
  const hash = createHash('sha512')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('base64')
}

/** Actionable suffix for any "every source failed" message (user-visible). */
export const MANUAL_DOWNLOAD_HINT = `可手动从镜像仓库下载：${MODELSCOPE_RELEASES_URL}`

/**
 * Per-candidate download timeout. 180 s is generous for a ~180 MB installer
 * even on a slow mainland link, while bounding the worst case: with the
 * mirror appended, the chain holds at most four candidates, so a total
 * black-hole network costs ~12 min instead of ~40 min (the old 600 s value)
 * before the actionable "download manually" dialog appears. Exported for
 * the offline asset-layer tests.
 */
export const DOWNLOAD_TIMEOUT_MS = 180_000

/** Download a file with progress, trying each candidate until one verifies. */
export async function downloadWithFallback(
  candidates: string[],
  dest: string,
  expectedSha512: string,
  onProgress: (received: number, total: number) => void,
): Promise<string> {
  let lastError: Error | null = null
  for (const url of candidates) {
    try {
      await fs.rm(dest, { force: true })
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      const body = Readable.fromWeb(res.body as never)
      const out = await fs.open(dest, 'w')
      let received = 0
      try {
        for await (const chunk of body) {
          received += chunk.length
          await out.write(chunk)
          onProgress(received, total)
        }
      } finally {
        await out.close()
      }
      const actual = await sha512Base64(dest)
      if (actual !== expectedSha512) {
        throw new Error(`完整性校验失败（期望 ${expectedSha512.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）`)
      }
      return url
    } catch (err) {
      lastError = err as Error
      console.error(`[shell-updater] candidate failed (${url}): ${(err as Error).message}`)
    }
  }
  throw new Error(`无法从任何源下载更新包：${lastError?.message ?? '未知错误'}。${MANUAL_DOWNLOAD_HINT}`)
}

async function showDownloadError(message: string): Promise<void> {
  const proceed = await confirmInFrame(
    {
      title: APP_NAME,
      message: `应用更新失败：${message}`,
      detail: '你可以稍后重试，或从镜像仓库手动下载安装包。',
      buttons: [
        { label: '关闭', value: 'close' },
        { label: '打开镜像下载页', value: 'open', primary: true },
      ],
      cancelValue: 'close',
      enterValue: 'open',
    },
    {
      type: 'error',
      title: APP_NAME,
      message: `应用更新失败：${message}`,
      detail: '你可以稍后重试，或从镜像仓库手动下载安装包。',
      buttons: ['打开镜像下载页', '关闭'],
      defaultId: 1,
      cancelId: 1,
    },
    'open',
  )
  // The mirror is the one page verifiably reachable without a proxy in
  // mainland China; the GitHub release page is offered there as well.
  if (proceed) void shell.openExternal(MODELSCOPE_RELEASES_URL)
}

const UPDATER_OWNER = resolveArtifactOwner()
const UPDATER_REPO = resolveArtifactRepo()

/** Parsed metadata plus the source that served it (drives asset ordering). */
interface LatestMetadata {
  yaml: LatestYaml
  source: string
}

/**
 * Fetch latest.yml through the source chain and parse it. A source only wins
 * when its body parses as metadata, so a mirror answering 200 with a broken
 * body falls through instead of stalling the chain. Mirrors fail silently for
 * the user; the winning source and per-source failures go to the shell log.
 * @returns the parsed metadata and its source, or null when every source failed.
 */
export async function fetchAndParseLatest(): Promise<LatestMetadata | null> {
  for (const url of latestYamlCandidates(UPDATER_OWNER, UPDATER_REPO)) {
    const label = sourceLabel(url)
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (!res.ok) {
        console.warn(`[shell-updater] metadata HTTP ${res.status} from ${label}`)
        continue
      }
      const yaml = parseLatestYaml(await res.text())
      if (!yaml) {
        console.warn(`[shell-updater] metadata unparseable from ${label}`)
        continue
      }
      console.log(`[shell-updater] metadata source: ${label}`)
      return { yaml, source: url }
    } catch (err) {
      console.warn(`[shell-updater] metadata unreachable from ${label}: ${(err as Error).message}`)
    }
  }
  return null
}

/** True when the remote version is newer than the running app version. */
function isNewerThan(latest: string, current: string): boolean {
  return semver.valid(latest) && semver.valid(current)
    ? semver.gt(latest, current)
    : latest !== current
}

/**
 * Charset + shape guard for a version spliced into installer filenames, URLs,
 * the mirror archive path and the pending-install record. Beyond the original
 * `[\w.~-]` charset it must start with a digit and must not contain a literal
 * `..` segment: `..` passes the charset but is a relative path component, so
 * an unsigned latest.yml (or a tampered version history) could otherwise steer
 * a path one level up. Real versions all start with a digit and contain no
 * `..` — 0.11.7, 0.11.8-beta.1, 1.2.3-rc.2 — so this stays compatible.
 */
export function isSafeVersion(value: string): boolean {
  return /^\d[\w.~-]*$/.test(value) && !value.includes('..')
}

// ------------------------------------------------- skip version / history

/** Record of the update version the user chose to skip (auto-checks go silent). */
interface SkippedVersion {
  readonly version: string
}

function skippedVersionFile(): string {
  return path.join(app.getPath('userData'), 'dsh-app-skipped-version.json')
}

/** The skipped version, or null when none recorded (any parse error = none). */
async function readSkippedVersion(): Promise<string | null> {
  const record = await readJsonFile<SkippedVersion>(skippedVersionFile())
  return typeof record?.version === 'string' ? record.version : null
}

async function writeSkippedVersion(version: string): Promise<void> {
  try {
    await writeJsonFileAtomic(skippedVersionFile(), { version } satisfies SkippedVersion)
  } catch (err) {
    console.error('[shell-updater] failed to record skipped version:', (err as Error).message)
  }
}

async function clearSkippedVersion(): Promise<void> {
  await fs.rm(skippedVersionFile(), { force: true }).catch(() => undefined)
}

/** One confirmed version advance, kept for the tray's rollback menu. */
interface VersionHistoryEntry {
  readonly version: string
  /** ISO timestamp of when this version was confirmed running. */
  readonly at: string
}

/** How many confirmed version advances to keep for rollback. */
const VERSION_HISTORY_MAX = 5

function versionHistoryFile(): string {
  return path.join(app.getPath('userData'), 'dsh-app-version-history.json')
}

async function readVersionHistory(): Promise<VersionHistoryEntry[]> {
  const list = await readJsonFile<VersionHistoryEntry[]>(versionHistoryFile())
  return Array.isArray(list)
    ? list.filter((entry) => entry !== null && typeof entry.version === 'string')
    : []
}

/**
 * Append a confirmed version advance (max {@link VERSION_HISTORY_MAX}).
 * Consecutive duplicates collapse: the pending-install consumption of a
 * rollback re-records the version it just landed on otherwise. Best-effort.
 */
async function appendVersionHistory(version: string): Promise<void> {
  try {
    const history = await readVersionHistory()
    if (history[history.length - 1]?.version === version) return
    const next = [...history, { version, at: new Date().toISOString() } satisfies VersionHistoryEntry].slice(-VERSION_HISTORY_MAX)
    await writeJsonFileAtomic(versionHistoryFile(), next)
  } catch (err) {
    console.error('[shell-updater] failed to record version history:', (err as Error).message)
  }
}

/** Outcome of the Windows update-available dialog. */
type UpdateConfirmChoice = 'install' | 'skip' | 'cancel'

/**
 * The update-available dialog: install / skip-this-version / cancel. The
 * in-frame dialog carries the three buttons natively (values map 1:1); the
 * native fallback maps response indexes to the same outcomes.
 */
async function promptUpdateConfirm(win: BrowserWindow | null, current: string, version: string): Promise<UpdateConfirmChoice> {
  const message = `发现新版本 ${APP_NAME}（${version}）。`
  const detail = `当前 v${current} → v${version}。将下载并静默安装，安装完成后需重新打开应用。`
  return promptThemedDialog<UpdateConfirmChoice>(
    win,
    inFrameDialogScript({
      title: `${APP_NAME} 更新可用`,
      message,
      detail,
      buttons: [
        { label: '立即更新', value: 'install', primary: true },
        { label: '跳过此版本', value: 'skip' },
        { label: '取消', value: 'cancel' },
      ],
      cancelValue: 'cancel',
      enterValue: 'install',
    }),
    {
      type: 'info',
      title: `${APP_NAME} 更新可用`,
      message,
      detail,
      buttons: ['立即更新', '跳过此版本', '取消'],
      defaultId: 0,
      cancelId: 2,
    },
    (value, nativeResponse) => {
      if (value === 'install' || value === 'skip' || value === 'cancel') return value
      return nativeResponse === 0 ? 'install' : nativeResponse === 1 ? 'skip' : 'cancel'
    },
  )
}

/**
 * Manual re-check landing on a previously skipped version: name the skip and
 * let the user install it anyway or keep it skipped (auto checks never got
 * here — they stay silent on skipped versions).
 */
async function promptSkippedVersionConfirm(win: BrowserWindow | null, version: string): Promise<UpdateConfirmChoice> {
  const proceed = await confirmInFrame(
    {
      title: `${APP_NAME} 更新可用`,
      message: `检测到 ${APP_NAME} ${version}（你曾跳过此版本）。`,
      detail: '仍要安装该版本吗？',
      buttons: [
        { label: '保持跳过', value: 'cancel' },
        { label: '仍要安装', value: 'install', primary: true },
      ],
      cancelValue: 'cancel',
      enterValue: 'install',
    },
    {
      type: 'info',
      title: `${APP_NAME} 更新可用`,
      message: `检测到 ${APP_NAME} ${version}（你曾跳过此版本）。`,
      detail: '仍要安装该版本吗？',
      buttons: ['仍要安装', '保持跳过'],
      defaultId: 0,
      cancelId: 1,
    },
    'install',
  )
  return proceed ? 'install' : 'cancel'
}

/** Windows custom update flow (mirror fallback + sha512 + silent install). */
async function checkShellUpdateWin32(manual: boolean, win: BrowserWindow | null): Promise<void> {
  if (process.env.DSH_APP_DEV === '1') return
  if (busy) {
    // A check is already running; manual clicks deserve feedback instead of a
    // silent no-op (auto checks stay quiet).
    if (manual) showUpdateToast(win, '正在检查应用更新，请稍候…', 'progress', 3_000)
    return
  }
  busy = true
  try {
    showUpdateToast(win, '正在检查应用更新…', 'progress', undefined)
    const meta = await fetchAndParseLatest()
    if (!meta) throw new Error(`无法获取更新元数据（latest.yml）或格式无法解析。${MANUAL_DOWNLOAD_HINT}`)
    const yaml = meta.yaml
    // Version is spliced into an installer filename and the pending-install
    // record; constrain it to a safe charset so a crafted metadata value can
    // never break the path or the spawn target (defense in depth for an
    // unsigned latest.yml).
    if (!isSafeVersion(yaml.version)) throw new Error('更新元数据版本格式异常')

    const current = app.getVersion()
    const newer = isNewerThan(yaml.version, current)
    if (!newer) {
      clearKernelProgress(win)
      if (manual) void noticeInFrame(win, 'info', APP_NAME, `已是最新版本（${APP_NAME} ${current}）。`)
      return
    }

    // A version the user explicitly skipped stays silent for auto checks;
    // only a manual re-check surfaces it (with an opt-in below).
    const skippedVersion = await readSkippedVersion()
    if (skippedVersion === yaml.version && !manual) {
      clearKernelProgress(win)
      return
    }

    const asset = pickAsset(yaml.files, process.arch)
    if (!asset) throw new Error('未找到适用于当前系统的安装包')
    // Same charset guard for the asset filename (spliced into the download
    // URL and the spawned installer path): a crafted value must fail safely,
    // never inject.
    if (!/^[\w.~-]+\.exe$/.test(asset.url)) throw new Error('更新包文件名格式异常')

    const choice = skippedVersion === yaml.version
      ? await promptSkippedVersionConfirm(win, yaml.version)
      : await promptUpdateConfirm(win, current, yaml.version)
    if (choice === 'skip') {
      await writeSkippedVersion(yaml.version)
      clearKernelProgress(win)
      showUpdateToast(win, `已跳过 ${APP_NAME} ${yaml.version}，之后将不再自动提醒`, 'success', 3_000)
      return
    }
    if (choice !== 'install') {
      clearKernelProgress(win)
      return
    }

    await downloadAndInstallPackage(win, yaml.version, asset, assetCandidates(UPDATER_OWNER, UPDATER_REPO, asset.url, meta.source), {
      title: `${APP_NAME} 更新就绪`,
      message: `将关闭当前应用并打开 ${APP_NAME} ${yaml.version} 安装向导（与首次安装相同）。`,
      detail: '按向导完成安装后，应用会重新启动。安装包将在安装完成后自动删除。',
    })
  } catch (err) {
    console.error('[shell-updater]', (err as Error).message)
    clearKernelProgress(win)
    if (manual) await showDownloadError((err as Error).message)
  } finally {
    busy = false
  }
}

/**
 * Shared Windows installer tail: download with progress (mirror fallback +
 * sha512), confirm, stage the pending-install record, spawn the visible NSIS
 * wizard and quit. Returns when the user defers; the host process quits when
 * the install starts.
 */
async function downloadAndInstallPackage(
  win: BrowserWindow | null,
  version: string,
  asset: UpdateFileEntry,
  candidates: string[],
  installPrompt: { title: string; message: string; detail: string },
): Promise<void> {
  const dest = path.join(app.getPath('temp'), `dsh-app-update-${version}-${process.arch}.exe`)
  // Throttle card updates (~4/s) like the kernel downloader: every callback
  // is an executeJavaScript hop into the renderer, and the per-chunk stream
  // fires far faster than the eye can perceive.
  let lastEmit = 0
  const downloadedFrom = await downloadWithFallback(
    candidates,
    dest,
    asset.sha512,
    (received, total) => {
      const now = Date.now()
      if (now - lastEmit < 250 && !(total > 0 && received >= total)) return
      lastEmit = now
      showKernelProgress(win, {
        phase: 'downloading',
        message: `正在下载 ${APP_NAME} ${version}…`,
        progress: total > 0 ? Math.min(1, received / total) : null,
      })
    },
  )
  console.log(`[shell-updater] downloaded ${asset.url} from ${downloadedFrom}`)
  showUpdateToast(win, `${APP_NAME} ${version} 下载完成`, 'success', 3_000)

  const install = await confirmInFrame(
    {
      title: installPrompt.title,
      message: installPrompt.message,
      detail: installPrompt.detail,
      buttons: [
        { label: '稍后', value: 'later' },
        { label: '立即安装', value: 'install', primary: true },
      ],
      cancelValue: 'later',
      enterValue: 'install',
    },
    {
      type: 'question',
      title: installPrompt.title,
      message: installPrompt.message,
      detail: installPrompt.detail,
      buttons: ['立即安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    },
    'install',
  )
  if (!install) return
  // VISIBLE NSIS install: the app must be closed so the installer can
  // replace the running binaries; the wizard then shows the same flow as a
  // first-time install (user clicks through, completion page relaunches
  // the app). The installer is a GUI-subsystem binary spawned DIRECTLY —
  // no cmd wrapper: a detached cmd.exe always flashes a console window on
  // Windows, even with windowsHide.
  //
  // `windowsHide` must NOT be set on a GUI binary: libuv maps it to
  // STARTF_USESHOWWINDOW + SW_HIDE, which Windows applies to the GUI
  // process's first window — the wizard then runs invisibly and the user
  // sees nothing (learned the hard way; the flag only ever hides console
  // windows, and a GUI binary has none to hide).
  //
  // Completion is verified on the next boot instead of by a watcher
  // process (the host quits right after spawning, so it cannot observe the
  // exit itself): the pending-install record holds the target version and
  // the installer path, so the next run deletes the leftover package and
  // toasts when the version did not advance (wizard cancelled or failed).
  // Premise: per-user asInvoker NSIS (perMachine:false) installs in one
  // process; an elevation hop would change what the version check means.
  await fs.writeFile(
    pendingInstallFile(),
    `${JSON.stringify({ version, installerPath: dest } satisfies PendingInstall)}\n`,
    'utf8',
  )
  const child = spawn(dest, [], { detached: true, stdio: 'ignore' })
  // Spawn failure is otherwise invisible (the app is about to quit).
  child.on('error', (err) => { console.error('[shell-updater] installer spawn failed:', err.message) })
  child.unref()
  app.quit()
}

// -------------------------------------------------------- version rollback
// Windows-only: rollback leans on the custom update chain's asset contract
// (a tagged release carrying the installers + latest.yml), which exists only
// there — macOS/Linux update through electron-updater.

/** Tagged-release latest.yml candidates (mirror archive → official → mirror prefixes). */
export function releaseLatestYamlCandidates(owner: string, repo: string, version: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/download/v${version}/latest.yml`
  return [modelscopeReleaseFileUrl(`releases/archive/${version}/latest.yml`), official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
}

/**
 * Tagged-release installer candidates: the mirror archive leads when the
 * metadata came from the mirror, and closes the chain otherwise — same
 * trailing-mirror policy and sha512 gate as {@link assetCandidates} (the
 * trailing copy is what rescues a rollback whose metadata reached GitHub but
 * whose installer cannot be fetched from there).
 */
export function releaseAssetCandidates(owner: string, repo: string, version: string, assetUrl: string, metadataSource: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/download/v${version}/${assetUrl}`
  const mirror = modelscopeReleaseFileUrl(`releases/archive/${version}/${assetUrl}`)
  const fallbacks = [official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
  return isModelscopeSource(metadataSource) ? [mirror, ...fallbacks] : [...fallbacks, mirror]
}

/**
 * Fetch a tagged release's latest.yml. The asset name is fixed by the release
 * contract, so the deterministic `Latest.yml` URL — the mirror archive first
 * (mainland-reachable), then `releases/download/<tag>/latest.yml` with its
 * prefix chain — is tried first; the unauthenticated GitHub API stays as a
 * fallback for anything that renamed it. The parsed version must agree with
 * the tag: a mismatched file would install a version nobody asked for. Null on
 * any failure (caller reports and stays put).
 */
async function fetchReleaseLatestYaml(version: string): Promise<LatestMetadata | null> {
  const parse = (text: string): LatestYaml | null => {
    const parsed = parseLatestYaml(text)
    return parsed && parsed.version === version ? parsed : null
  }
  // 1. Deterministic asset URL, mirror first then official + mirrors.
  for (const url of releaseLatestYamlCandidates(UPDATER_OWNER, UPDATER_REPO, version)) {
    const label = sourceLabel(url)
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (!res.ok) {
        console.warn(`[shell-updater] rollback metadata HTTP ${res.status} from ${label}`)
        continue
      }
      const parsed = parse(await res.text())
      if (parsed) {
        console.log(`[shell-updater] rollback metadata source: ${label}`)
        return { yaml: parsed, source: url }
      }
    } catch (err) {
      console.warn(`[shell-updater] rollback metadata unreachable from ${label}: ${(err as Error).message}`)
    }
  }
  // 2. API fallback (asset renamed, deterministic URL missing).
  try {
    const api = `https://api.github.com/repos/${UPDATER_OWNER}/${UPDATER_REPO}/releases/tags/v${version}`
    const res = await fetch(api, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const release = await res.json() as { assets?: ReadonlyArray<{ name?: string; browser_download_url?: string }> }
    const yamls = (release.assets ?? []).filter((a) => a.name === 'latest.yml' && typeof a.browser_download_url === 'string')
    if (yamls.length === 0) return null
    const official = yamls[0].browser_download_url as string
    for (const url of [official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]) {
      try {
        const meta = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
        if (!meta.ok) continue
        const parsed = parse(await meta.text())
        if (parsed) return { yaml: parsed, source: url }
      } catch {
        // try next source
      }
    }
  } catch {
    // API unreachable / rate-limited: caller reports, nothing to retry here.
  }
  return null
}

/**
 * Roll the shell app back to the previous recorded version (see the version
 * history the pending-install consumer appends to). Deliberately bypasses
 * isNewerThan: a rollback IS a downgrade, gated by an explicit confirm.
 */
export async function rollbackShellUpdate(win: BrowserWindow | null = null): Promise<void> {
  if (process.platform !== 'win32') return
  if (process.env.DSH_APP_DEV === '1') {
    await noticeInFrame(win, 'info', APP_NAME, '开发模式下不支持回滚应用版本（当前运行的是未打包构建）。')
    return
  }
  if (busy) {
    // Shares the check guard with checkShellUpdateWin32 so a download and a
    // rollback can never interleave.
    showUpdateToast(win, '正在检查应用更新，请稍候…', 'progress', 3_000)
    return
  }
  busy = true
  try {
    const history = await readVersionHistory()
    const current = app.getVersion()
    // history[len-1] is the running version (recorded on its confirmation);
    // len-2 is the state before it — where a rollback lands.
    const previous = history.length >= 2 ? history[history.length - 2].version : null
    if (previous === null || previous === current || !isSafeVersion(previous)) {
      await noticeInFrame(win, 'info', APP_NAME, '没有可回滚的历史版本。')
      return
    }
    showUpdateToast(win, `正在获取 ${APP_NAME} ${previous} 的安装包信息…`, 'progress', undefined)
    const meta = await fetchReleaseLatestYaml(previous)
    clearKernelProgress(win)
    if (!meta) {
      await noticeInFrame(win, 'error', APP_NAME, `无法获取 ${APP_NAME} ${previous} 的更新元数据，请检查网络后重试。${MANUAL_DOWNLOAD_HINT}`)
      return
    }
    const yaml = meta.yaml
    const asset = pickAsset(yaml.files, process.arch)
    if (!asset || !/^[\w.~-]+\.exe$/.test(asset.url)) {
      await noticeInFrame(win, 'error', APP_NAME, `未找到 ${APP_NAME} ${previous} 适用于当前系统的安装包。`)
      return
    }
    const proceed = await confirmInFrame(
      {
        title: `${APP_NAME} 回滚到上一版本`,
        message: `将把 ${APP_NAME} 从 v${current} 回滚到 v${previous}。`,
        detail: '将下载该版本的安装包并打开安装向导，完成后应用会重新启动。',
        buttons: [
          { label: '取消', value: 'cancel' },
          { label: '确认回滚', value: 'rollback', primary: true },
        ],
        cancelValue: 'cancel',
        enterValue: 'rollback',
      },
      {
        type: 'question',
        title: `${APP_NAME} 回滚到上一版本`,
        message: `将把 ${APP_NAME} 从 v${current} 回滚到 v${previous}。`,
        detail: '将下载该版本的安装包并打开安装向导，完成后应用会重新启动。',
        buttons: ['确认回滚', '取消'],
        defaultId: 0,
        cancelId: 1,
      },
      'rollback',
    )
    if (!proceed) return
    await downloadAndInstallPackage(
      win,
      previous,
      asset,
      releaseAssetCandidates(UPDATER_OWNER, UPDATER_REPO, previous, asset.url, meta.source),
      {
        title: `${APP_NAME} 回滚就绪`,
        message: `将关闭当前应用并安装 ${APP_NAME} ${previous}（回滚到上一版本）。`,
        detail: '按向导完成安装后，应用会重新启动。安装包将在安装完成后自动删除。',
      },
    )
  } catch (err) {
    clearKernelProgress(win)
    await noticeInFrame(win, 'error', APP_NAME, `回滚失败：${(err as Error).message}`)
  } finally {
    busy = false
  }
}

/**
 * Read-only version probe for manual checks in dev mode. The running app is
 * the unpackaged build, so download/install stays disabled — but the tray
 * click must respond, and exercising the same metadata chain (official →
 * mirrors) without packaging is exactly what dev verification needs.
 */
async function checkShellUpdateDev(win: BrowserWindow | null): Promise<void> {
  try {
    showUpdateToast(win, '正在检查应用更新…', 'progress', undefined)
    const meta = await fetchAndParseLatest()
    if (!meta) throw new Error(`无法获取更新元数据（latest.yml）或格式无法解析。${MANUAL_DOWNLOAD_HINT}`)
    const yaml = meta.yaml
    if (!isSafeVersion(yaml.version)) throw new Error('更新元数据版本格式异常')
    const current = app.getVersion()
    const newer = isNewerThan(yaml.version, current)
    clearKernelProgress(win)
    await noticeInFrame(win, 'info', APP_NAME, newer
      ? `开发模式下不支持自动更新应用（当前运行的是未打包构建）。\n检测到新版本：v${current} → v${yaml.version}，请从正式安装的副本更新。`
      : `开发模式下不支持自动更新应用（当前运行的是未打包构建）。\n当前版本 v${current}，远端为同一版本。`)
  } catch (err) {
    clearKernelProgress(win)
    void noticeInFrame(win, 'info', APP_NAME, `开发模式下不支持自动更新应用，且远端版本检查失败：${(err as Error).message}`)
  }
}

/**
 * Run one shell-update check. Returns the flow's promise (callers ignore it;
 * it exists so probes and diagnostics can await the outcome — the win32 flow
 * itself never rejects, it reports through dialogs/toasts).
 */
export function checkShellUpdate(manual = false, win: BrowserWindow | null = null): Promise<void> {
  if (process.env.DSH_APP_DEV === '1') {
    // Dev cannot self-install (the running app is the unpackaged build), but
    // a manual tray click still deserves the check animation and a verdict.
    return manual ? checkShellUpdateDev(win) : Promise.resolve()
  }
  if (!initialized) initShellUpdater()
  if (process.platform === 'win32') {
    return checkShellUpdateWin32(manual, win)
  }
  return autoUpdater.checkForUpdates()
    .catch(async (err) => {
      console.error('[shell-updater]', err.message)
      if (manual) await showDownloadError((err as Error).message)
    })
    .then(() => undefined)
}

/**
 * Record of an in-flight visible install, written right before the app quits
 * for the installer. The next boot consumes it: delete the leftover package
 * and confirm the running version actually advanced.
 */
interface PendingInstall {
  readonly version: string
  readonly installerPath: string
}

function pendingInstallFile(): string {
  return path.join(app.getPath('userData'), 'updater-pending-install.json')
}

/**
 * Consume the pending-install record of the last update attempt: delete the
 * leftover installer package (success or cancel — it is re-downloadable), and
 * toast when the running version did not advance to the recorded target
 * (wizard cancelled or failed). The host process quits right after spawning
 * the installer, so the outcome can only be observed on the next boot.
 * No-op when no install was in flight.
 */
export async function consumeUpdaterInstallResult(win: BrowserWindow | null = null): Promise<void> {
  const file = pendingInstallFile()
  let pending: PendingInstall
  try {
    pending = JSON.parse(await fs.readFile(file, 'utf8')) as PendingInstall
  } catch {
    return // no install was in flight (fresh install or normal run)
  }
  await fs.rm(file, { force: true }).catch(() => undefined)
  // The recorded path must stay inside the temp dir: the file lives in
  // userData (writable by anything running as the user), so a tampered record
  // must never redirect the delete elsewhere.
  const tempDir = path.resolve(app.getPath('temp'))
  const installer = typeof pending.installerPath === 'string' ? pending.installerPath : ''
  if (installer !== '' && path.resolve(installer).startsWith(tempDir + path.sep)) {
    await fs.rm(installer, { force: true }).catch(() => undefined)
  }
  const target = typeof pending.version === 'string' ? pending.version : ''
  if (target === '') return
  const current = app.getVersion()
  const advanced = semver.valid(target) !== null && semver.valid(current) !== null
    ? semver.gte(current, target)
    : current === target
  if (advanced) {
    console.log(`[shell-updater] update to ${target} confirmed (running ${current})`)
    // The user now runs the version they may have skipped: retire the skip
    // record, and record the advance the tray rollback menu reads.
    await clearSkippedVersion()
    await appendVersionHistory(current)
    return
  }
  // The wizard was cancelled or failed: still on the old version.
  console.log(`[shell-updater] update to ${target} did not complete (running ${current})`)
  void showToastWhenLoaded(win, `上次应用更新未完成（当前仍为 v${current}），可从托盘「检查应用更新」重试`, 'error', 8_000)
}