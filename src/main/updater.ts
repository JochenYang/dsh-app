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
import { t } from '../shared/locale'
import { inFrameDialogScript } from './in-frame-dialog'
import { readJsonFile, writeJsonFileAtomic } from './json-file'
import { noticeThemedDialog, promptThemedDialog, resolveDialogWindow } from './themed-dialog'
import { clearKernelProgress, showKernelProgress, showToastWhenLoaded, showUpdateToast } from './window'

let initialized = false
let busy = false

/**
 * macOS/Linux (`electron-updater`) flow state. Those listeners are registered
 * once at boot, before any window exists and before any check knows whether
 * the user asked for it, so the check has to be remembered for them: `manual`
 * selects the skip semantics, the window hosts the progress card, and the
 * version being downloaded is what the card names.
 */
let electronCheckWasManual = false
let electronCheckWindow: BrowserWindow | null = null
let electronDownloadVersion: string | null = null

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
      buttons: [{ label: t('common.ok'), value: 'ok', primary: true }],
      cancelValue: 'ok',
      enterValue: 'ok',
    }),
  )
}

/**
 * Shell update channel.
 *
 * Windows (primary market, mainland-first): a custom flow replaces
 * electron-updater — detect via latest.yml (official GitHub
 * `releases/latest` alias first, its ModelScope mirror and the proxy prefixes
 * as fallback), pick the installer for the running arch, download with a
 * ModelScope-first byte chain, verify the sha512 from latest.yml, then run the
 * NSIS installer silently and quit. This is what makes app updates work
 * without a proxy in mainland China.
 *
 * macOS / Linux: keep electron-updater (native update formats), but surface
 * errors in a dialog and offer a release-page fallback. The ModelScope mirror
 * cannot back those platforms: electron-updater needs a static directory feed
 * while the ModelScope API is query-shaped (`.../repo?FilePath=<path>`).
 *
 * Both chains share everything the user sees — the three-button
 * install/skip/cancel prompt, the skip record ({@link readSkippedVersion}),
 * the prompts and the progress card — so only the transport differs:
 * electron-updater resolves and downloads the native package itself and
 * reports through `download-progress`.
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

  /** Progress throttle for the download in flight; reset when one starts. */
  let lastProgressEmit = 0

  autoUpdater.on('update-available', async (info) => {
    const current = app.getVersion()
    const decision = decideUpdatePrompt(info.version, current, await readSkippedVersion(), electronCheckWasManual)
    // electron-updater only reports an available update when it is newer, so
    // 'latest' never happens in practice — it must produce no prompt at all.
    if (decision === 'latest' || decision === 'silent') return
    const choice = decision === 'skipped'
      ? await promptSkippedVersionConfirm(electronCheckWindow, info.version)
      : await promptUpdateConfirm(electronCheckWindow, current, info.version)
    if (choice === 'skip') {
      await recordSkippedVersion(electronCheckWindow, info.version)
      return
    }
    if (choice !== 'install') return
    electronDownloadVersion = info.version
    lastProgressEmit = 0
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      // A cancelled download rejects without emitting 'error', so the card is
      // dropped here as well as in the listener below.
      clearElectronDownload()
      void showDownloadError(t('updater.downloadFailed', { detail: (err as Error).message }))
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    const version = electronDownloadVersion
    if (version === null) return
    const now = Date.now()
    if (now - lastProgressEmit < 250 && !(progress.total > 0 && progress.transferred >= progress.total)) return
    lastProgressEmit = now
    // Same card, same wording and same 0..1 progress contract as the Windows
    // downloader, which throttles for the identical reason: every callback is
    // an executeJavaScript hop into the renderer.
    showKernelProgress(resolveDialogWindow(electronCheckWindow), {
      phase: 'downloading',
      message: t('updater.downloading', { app: APP_NAME, version }),
      progress: progress.total > 0 ? Math.min(1, progress.transferred / progress.total) : null,
    })
  })

  autoUpdater.on('update-downloaded', async () => {
    // The transfer is over: nothing may outlive it, and the card would sit on
    // top of the dialog below.
    clearElectronDownload()
    const proceed = await confirmInFrame(
      {
        title: t('updater.readyTitle', { app: APP_NAME }),
        message: t('updater.readyMessage'),
        buttons: [
          { label: t('common.later'), value: 'later' },
          { label: t('updater.restartNow'), value: 'restart', primary: true },
        ],
        cancelValue: 'later',
        enterValue: 'restart',
      },
      {
        type: 'info',
        title: t('updater.readyTitle', { app: APP_NAME }),
        message: t('updater.readyMessage'),
        buttons: [t('updater.restartNow'), t('common.later')],
        defaultId: 0,
        cancelId: 1,
      },
      'restart',
    )
    if (proceed) autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (_err) => {
    // The download path above surfaces its own dialog; keep this quiet, but
    // never leave a stuck progress card behind a failed download.
    clearElectronDownload()
  })
}

/**
 * Drop the macOS/Linux download state and its progress card. The success, the
 * failure and the cancelled path all end here — the card is non-blocking but
 * must never outlive the transfer it describes.
 */
function clearElectronDownload(): void {
  electronDownloadVersion = null
  clearKernelProgress(resolveDialogWindow(electronCheckWindow))
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

/**
 * The metadata URL chain, official GitHub first.
 *
 * The version a user is offered is a trust decision — which build runs next,
 * and whether it is even an upgrade — so the primary answer is read from the
 * release owner's own copy. The ModelScope mirror and the proxy prefixes stay
 * in the chain for the mainland topology (GitHub unreachable), where a mirror
 * is the only source at all; they are fallbacks, never the primary answer.
 * The BYTES follow the mirror-first order (see {@link assetCandidates}) — that
 * is transport, and every candidate is gated by the sha512 this metadata
 * carried, so a lagging or tampered mirror copy fails verification and falls
 * through instead of substituting content.
 */
export function latestYamlCandidates(owner: string, repo: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/latest/download/latest.yml`
  return [official, modelscopeReleaseFileUrl('releases/latest/latest.yml'), ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
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
 * Installer download candidates for one asset, mirror first.
 *
 * Metadata is official-first (see {@link latestYamlCandidates}); the BYTES are
 * the opposite — the mainland failure topology is asymmetric: a small
 * latest.yml often reaches GitHub while a ~180 MB installer consistently does
 * not, so the mirror leads the byte chain and official GitHub closes it with
 * the proxy prefixes. Every candidate is gated by the sha512 taken from that
 * latest.yml, so a mirror serving a *different* build (lagging or tampered)
 * fails verification and falls through — it can degrade to a slower download,
 * never substitute content. The metadata source no longer reorders this chain:
 * where the version was read from decides what is offered, not what is fast.
 */
export function assetCandidates(owner: string, repo: string, assetUrl: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/latest/download/${assetUrl}`
  const mirror = modelscopeReleaseFileUrl(`releases/latest/${assetUrl}`)
  return [mirror, official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
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

/**
 * Actionable suffix for any "every source failed" message (user-visible).
 *
 * A function, not a constant: the hint is localized, and a module-level string
 * would be resolved while this module loads — before Electron's app is ready,
 * i.e. before `app.getLocale()` carries an answer.
 */
export function manualDownloadHint(): string {
  return t('updater.manualHint', { url: MODELSCOPE_RELEASES_URL })
}

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
        throw new Error(t('updater.integrityFailed', {
          expected: expectedSha512.slice(0, 16),
          actual: actual.slice(0, 16),
        }))
      }
      return url
    } catch (err) {
      lastError = err as Error
      console.error(`[shell-updater] candidate failed (${url}): ${(err as Error).message}`)
    }
  }
  throw new Error(t('updater.allSourcesFailed', {
    detail: lastError?.message ?? t('common.unknownError'),
    hint: manualDownloadHint(),
  }))
}

async function showDownloadError(message: string): Promise<void> {
  const proceed = await confirmInFrame(
    {
      title: APP_NAME,
      message: t('updater.updateFailedMessage', { message }),
      detail: t('updater.updateFailedDetail'),
      buttons: [
        { label: t('common.close'), value: 'close' },
        { label: t('updater.openMirror'), value: 'open', primary: true },
      ],
      cancelValue: 'close',
      enterValue: 'open',
    },
    {
      type: 'error',
      title: APP_NAME,
      message: t('updater.updateFailedMessage', { message }),
      detail: t('updater.updateFailedDetail'),
      buttons: [t('updater.openMirror'), t('common.close')],
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

/** What an available-update finding should become on screen. */
export type UpdatePromptDecision =
  /** Nothing newer than the running version: no prompt. */
  | 'latest'
  /** Auto check landing on an explicitly skipped version: stay silent. */
  | 'silent'
  /** Manual re-check of a skipped version: name the skip, offer it anyway. */
  | 'skipped'
  /** Ordinary finding: ask install / skip / cancel. */
  | 'prompt'

/**
 * Platform-independent "should this version be surfaced, and how" decision,
 * shared by the Windows and the electron-updater flows so both chains follow
 * one skip semantics (§4.4): an explicitly skipped version stays silent for
 * automatic checks, but a manual check still surfaces it (with the skip named
 * and an opt-in to install it anyway). Pure — exercised by the unit tests.
 * @param latest - the version the update source reports.
 * @param current - the running app version.
 * @param skipped - the recorded skip, or null when none.
 * @param manual - true when the user asked for this check.
 */
export function decideUpdatePrompt(latest: string, current: string, skipped: string | null, manual: boolean): UpdatePromptDecision {
  if (!isNewerThan(latest, current)) return 'latest'
  if (typeof skipped === 'string' && skipped === latest) return manual ? 'skipped' : 'silent'
  return 'prompt'
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

/**
 * Frozen user-visible confirmation for a recorded skip (§4.4). One copy for
 * every platform and both update chains, so the wording cannot drift apart.
 */
export function skippedVersionToast(version: string): string {
  return t('updater.skipToast', { app: APP_NAME, version })
}

/**
 * Record the user's skip-this-version choice and confirm it on screen. The
 * shared
 * outcome of that button on every platform and both update chains. The host
 * window is resolved here (not by the caller) so the confirmation is never
 * silently dropped when the caller's window is gone — the toast renderer
 * needs a live window, the skip record does not.
 */
async function recordSkippedVersion(win: BrowserWindow | null, version: string): Promise<void> {
  await writeSkippedVersion(version)
  const target = resolveDialogWindow(win)
  clearKernelProgress(target)
  showUpdateToast(target, skippedVersionToast(version), 'success', 3_000)
}

/**
 * True when a recorded skip has been superseded: the app now runs the skipped
 * version itself (or something newer), so the record has no version left to
 * suppress and must be retired. Windows retires it when the pending-install
 * record is consumed; macOS/Linux write no such record, so the check that
 * follows the relaunch asks this instead. Non-semver values only ever retire
 * on exact equality — never throw. Pure — exercised by the unit tests.
 * @param skipped - the recorded skip, or null when none.
 * @param current - the running app version.
 */
export function shouldRetireSkippedVersion(skipped: string | null, current: string): boolean {
  if (typeof skipped !== 'string' || skipped === '') return false
  if (semver.valid(skipped) !== null && semver.valid(current) !== null) return semver.gte(current, skipped)
  return skipped === current
}

/** Retire a superseded skip record (see {@link shouldRetireSkippedVersion}). */
async function retireSkippedVersionIfRunning(current: string): Promise<void> {
  if (!shouldRetireSkippedVersion(await readSkippedVersion(), current)) return
  console.log(`[shell-updater] retiring the skip record for a version already running (${current})`)
  await clearSkippedVersion()
}

/** One confirmed version advance, kept for the tray's rollback menu. */
export interface VersionHistoryEntry {
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

/**
 * The history that agrees with the version actually running.
 *
 * Pure so the rule is testable without a disk or an Electron app (the shell's
 * I/O around it is {@link reconcileVersionHistory}): the running version is
 * dropped if it already appears anywhere, then appended, and the list is capped
 * at {@link VERSION_HISTORY_MAX}. Dropping the earlier record matters for a
 * re-upgrade — a downgrade followed by an upgrade would otherwise leave two
 * entries of the same version and shift the rollback menu's `len-2` off the
 * real previous release.
 *
 * @param history - the recorded advances, oldest first.
 * @param current - the version this process is running.
 * @param at - ISO timestamp to stamp the appended entry with.
 * @returns the next history, or null when nothing needs writing.
 */
export function reconciledVersionHistory(
  history: readonly VersionHistoryEntry[],
  current: string,
  at: string,
): VersionHistoryEntry[] | null {
  if (!isSafeVersion(current)) return null
  if (history[history.length - 1]?.version === current && !history.slice(0, -1).some((entry) => entry.version === current)) {
    return null
  }
  return [...history.filter((entry) => entry.version !== current), { version: current, at }].slice(-VERSION_HISTORY_MAX)
}

/**
 * Make the history agree with the version actually running.
 *
 * The only writer used to be the pending-install consumer, which runs solely
 * after an IN-APP update: a version installed by hand (the download-the-
 * installer route the user takes when the app cannot start, or any manual
 * reinstall) advanced without a record, so `history[len-1]` — the entry the
 * rollback menu reads as "the version I am running" — named an older release
 * and a rollback would have landed one version too far back. Measured on
 * 0.12.6: the history ended at 0.12.5 while 0.12.6 was running, and the menu
 * would have offered 0.12.4.
 *
 * Reconciling on every boot closes that gap for every install route at once.
 * A DEVELOPMENT run is skipped: `app.getVersion()` there is the checkout's
 * version, and recording it would push a dev number into the rollback list.
 */
async function reconcileVersionHistory(): Promise<void> {
  if (process.env.DSH_APP_DEV === '1') return
  const current = app.getVersion()
  const history = await readVersionHistory()
  const next = reconciledVersionHistory(history, current, new Date().toISOString())
  if (next === null) return
  try {
    await writeJsonFileAtomic(versionHistoryFile(), next)
    console.log(`[shell-updater] version history reconciled to ${current} (was ${history[history.length - 1]?.version ?? 'empty'})`)
  } catch (err) {
    console.error('[shell-updater] failed to reconcile version history:', (err as Error).message)
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
  const message = t('updater.availableMessage', { app: APP_NAME, version })
  const detail = t('updater.availableDetail', { current, version })
  return promptThemedDialog<UpdateConfirmChoice>(
    win,
    inFrameDialogScript({
      title: t('updater.availableTitle', { app: APP_NAME }),
      message,
      detail,
      buttons: [
        { label: t('updater.updateNow'), value: 'install', primary: true },
        { label: t('updater.skipThisVersion'), value: 'skip' },
        { label: t('common.cancel'), value: 'cancel' },
      ],
      cancelValue: 'cancel',
      enterValue: 'install',
    }),
    {
      type: 'info',
      title: t('updater.availableTitle', { app: APP_NAME }),
      message,
      detail,
      buttons: [t('updater.updateNow'), t('updater.skipThisVersion'), t('common.cancel')],
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
      title: t('updater.availableTitle', { app: APP_NAME }),
      message: t('updater.skippedMessage', { app: APP_NAME, version }),
      detail: t('updater.skippedDetail'),
      buttons: [
        { label: t('updater.keepSkipped'), value: 'cancel' },
        { label: t('updater.installAnyway'), value: 'install', primary: true },
      ],
      cancelValue: 'cancel',
      enterValue: 'install',
    },
    {
      type: 'info',
      title: t('updater.availableTitle', { app: APP_NAME }),
      message: t('updater.skippedMessage', { app: APP_NAME, version }),
      detail: t('updater.skippedDetail'),
      buttons: [t('updater.installAnyway'), t('updater.keepSkipped')],
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
    if (manual) showUpdateToast(win, t('updater.checkingBusy'), 'progress', 3_000)
    return
  }
  busy = true
  try {
    showUpdateToast(win, t('updater.checking'), 'progress', undefined)
    const meta = await fetchAndParseLatest()
    if (!meta) throw new Error(t('updater.metadataFailed', { hint: manualDownloadHint() }))
    const yaml = meta.yaml
    // Version is spliced into an installer filename and the pending-install
    // record; constrain it to a safe charset so a crafted metadata value can
    // never break the path or the spawn target (defense in depth for an
    // unsigned latest.yml).
    if (!isSafeVersion(yaml.version)) throw new Error(t('updater.badVersion'))

    const current = app.getVersion()
    const decision = decideUpdatePrompt(yaml.version, current, await readSkippedVersion(), manual)
    if (decision === 'latest') {
      clearKernelProgress(win)
      if (manual) void noticeInFrame(win, 'info', APP_NAME, t('updater.upToDate', { app: APP_NAME, current }))
      return
    }

    // A version the user explicitly skipped stays silent for auto checks;
    // only a manual re-check surfaces it (with the opt-in below).
    if (decision === 'silent') {
      clearKernelProgress(win)
      return
    }

    const asset = pickAsset(yaml.files, process.arch)
    if (!asset) throw new Error(t('updater.noAsset'))
    // Same charset guard for the asset filename (spliced into the download
    // URL and the spawned installer path): a crafted value must fail safely,
    // never inject.
    if (!/^[\w.~-]+\.exe$/.test(asset.url)) throw new Error(t('updater.badAssetName'))

    const choice = decision === 'skipped'
      ? await promptSkippedVersionConfirm(win, yaml.version)
      : await promptUpdateConfirm(win, current, yaml.version)
    if (choice === 'skip') {
      await recordSkippedVersion(win, yaml.version)
      return
    }
    if (choice !== 'install') {
      clearKernelProgress(win)
      return
    }

    await downloadAndInstallPackage(win, yaml.version, asset, assetCandidates(UPDATER_OWNER, UPDATER_REPO, asset.url), {
      title: t('updater.readyTitle', { app: APP_NAME }),
      message: t('updater.installPromptMessage', { app: APP_NAME, version: yaml.version }),
      detail: t('updater.installPromptDetail'),
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
        message: t('updater.downloading', { app: APP_NAME, version }),
        progress: total > 0 ? Math.min(1, received / total) : null,
      })
    },
  )
  console.log(`[shell-updater] downloaded ${asset.url} from ${downloadedFrom}`)
  showUpdateToast(win, t('updater.downloadedToast', { app: APP_NAME, version }), 'success', 3_000)

  const install = await confirmInFrame(
    {
      title: installPrompt.title,
      message: installPrompt.message,
      detail: installPrompt.detail,
      buttons: [
        { label: t('common.later'), value: 'later' },
        { label: t('updater.installNow'), value: 'install', primary: true },
      ],
      cancelValue: 'later',
      enterValue: 'install',
    },
    {
      type: 'question',
      title: installPrompt.title,
      message: installPrompt.message,
      detail: installPrompt.detail,
      buttons: [t('updater.installNow'), t('common.later')],
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

/** Tagged-release latest.yml candidates (official GitHub → mirror archive → mirror prefixes). */
export function releaseLatestYamlCandidates(owner: string, repo: string, version: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/download/v${version}/latest.yml`
  return [official, modelscopeReleaseFileUrl(`releases/archive/${version}/latest.yml`), ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
}

/**
 * Tagged-release installer candidates, mirror first — the same split as
 * {@link assetCandidates}: the rollback VERSION is pinned by the tag and its
 * metadata is official-first, while the bytes lead with the mirror and are
 * gated by that metadata's sha512.
 */
export function releaseAssetCandidates(owner: string, repo: string, version: string, assetUrl: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/download/v${version}/${assetUrl}`
  const mirror = modelscopeReleaseFileUrl(`releases/archive/${version}/${assetUrl}`)
  return [mirror, official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
}

/**
 * Fetch a tagged release's latest.yml. The asset name is fixed by the release
 * contract, so the deterministic `latest.yml` URL — official GitHub first,
 * then the mirror archive with its prefix chain (mainland-reachable) — is
 * tried first; the unauthenticated GitHub API stays as a fallback for anything
 * that renamed it. The parsed version must agree with the tag: a mismatched
 * file would install a version nobody asked for. Null on any failure (caller
 * reports and stays put).
 */
async function fetchReleaseLatestYaml(version: string): Promise<LatestMetadata | null> {
  const parse = (text: string): LatestYaml | null => {
    const parsed = parseLatestYaml(text)
    return parsed && parsed.version === version ? parsed : null
  }
  // 1. Deterministic asset URL, official first then the mirror + mirrors.
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
    await noticeInFrame(win, 'info', APP_NAME, t('updater.rollbackDevUnsupported'))
    return
  }
  if (busy) {
    // Shares the check guard with checkShellUpdateWin32 so a download and a
    // rollback can never interleave.
    showUpdateToast(win, t('updater.checkingBusy'), 'progress', 3_000)
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
      await noticeInFrame(win, 'info', APP_NAME, t('updater.noRollbackTarget'))
      return
    }
    showUpdateToast(win, t('updater.rollbackFetching', { app: APP_NAME, previous }), 'progress', undefined)
    const meta = await fetchReleaseLatestYaml(previous)
    clearKernelProgress(win)
    if (!meta) {
      await noticeInFrame(win, 'error', APP_NAME, t('updater.rollbackMetadataFailed', { app: APP_NAME, previous, hint: manualDownloadHint() }))
      return
    }
    const yaml = meta.yaml
    const asset = pickAsset(yaml.files, process.arch)
    if (!asset || !/^[\w.~-]+\.exe$/.test(asset.url)) {
      await noticeInFrame(win, 'error', APP_NAME, t('updater.rollbackNoAsset', { app: APP_NAME, previous }))
      return
    }
    const proceed = await confirmInFrame(
      {
        title: t('updater.rollbackTitle', { app: APP_NAME }),
        message: t('updater.rollbackMessage', { app: APP_NAME, current, previous }),
        detail: t('updater.rollbackDetail'),
        buttons: [
          { label: t('common.cancel'), value: 'cancel' },
          { label: t('updater.rollbackConfirm'), value: 'rollback', primary: true },
        ],
        cancelValue: 'cancel',
        enterValue: 'rollback',
      },
      {
        type: 'question',
        title: t('updater.rollbackTitle', { app: APP_NAME }),
        message: t('updater.rollbackMessage', { app: APP_NAME, current, previous }),
        detail: t('updater.rollbackDetail'),
        buttons: [t('updater.rollbackConfirm'), t('common.cancel')],
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
      releaseAssetCandidates(UPDATER_OWNER, UPDATER_REPO, previous, asset.url),
      {
        title: t('updater.rollbackReadyTitle', { app: APP_NAME }),
        message: t('updater.rollbackReadyMessage', { app: APP_NAME, previous }),
        detail: t('updater.installPromptDetail'),
      },
    )
  } catch (err) {
    clearKernelProgress(win)
    await noticeInFrame(win, 'error', APP_NAME, t('updater.rollbackFailed', { detail: (err as Error).message }))
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
    showUpdateToast(win, t('updater.checking'), 'progress', undefined)
    const meta = await fetchAndParseLatest()
    if (!meta) throw new Error(t('updater.metadataFailed', { hint: manualDownloadHint() }))
    const yaml = meta.yaml
    if (!isSafeVersion(yaml.version)) throw new Error(t('updater.badVersion'))
    const current = app.getVersion()
    const newer = isNewerThan(yaml.version, current)
    clearKernelProgress(win)
    await noticeInFrame(win, 'info', APP_NAME, newer
      ? t('updater.devCheckNewer', { current, latest: yaml.version })
      : t('updater.devCheckSame', { current }))
  } catch (err) {
    clearKernelProgress(win)
    void noticeInFrame(win, 'info', APP_NAME, t('updater.devCheckFailed', { detail: (err as Error).message }))
  }
}

/**
 * macOS/Linux shell-update check (electron-updater transport). Shares the skip
 * record, the prompts and the progress card with the Windows flow; only the
 * transport differs. The listeners registered by {@link initShellUpdater} read
 * the state stored here.
 */
async function checkShellUpdateElectron(manual: boolean, win: BrowserWindow | null): Promise<void> {
  electronCheckWasManual = manual
  electronCheckWindow = win
  // Unlike Windows there is no pending-install record to consume on the next
  // boot, so a skip that the running version has caught up with is retired
  // here — before the check that would otherwise report the stale record.
  await retireSkippedVersionIfRunning(app.getVersion())
  await autoUpdater.checkForUpdates()
    .catch(async (err) => {
      console.error('[shell-updater]', err.message)
      if (manual) await showDownloadError((err as Error).message)
    })
    .then(() => undefined)
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
  return checkShellUpdateElectron(manual, win)
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
 *
 * Reconciliation runs FIRST and unconditionally, because the pending record
 * only exists for in-app updates: a version installed by hand still has to
 * reach the history the rollback menu reads (see
 * {@link reconcileVersionHistory}).
 */
export async function consumeUpdaterInstallResult(win: BrowserWindow | null = null): Promise<void> {
  await reconcileVersionHistory()
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
  void showToastWhenLoaded(win, t('updater.previousIncomplete', { current }), 'error', 8_000)
}