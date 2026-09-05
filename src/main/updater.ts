import { app, dialog, shell, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import semver from 'semver'
import { autoUpdater } from 'electron-updater'
import { APP_NAME } from '../shared/constants'
import { githubMirrorPrefixes } from '../kernel/sources/artifact'
import { inFrameDialogScript } from './in-frame-dialog'
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
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  if (win !== null && !win.isDestroyed()) {
    try {
      const choice: unknown = await win.webContents.executeJavaScript(inFrameDialogScript(config))
      return choice === primaryValue
    } catch {
      // Page not answerable: fall through to the native dialog.
    }
  }
  const prompt = win === null
    ? dialog.showMessageBox(native)
    : dialog.showMessageBox(win, native)
  const { response } = await prompt
  return response === 0
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
  const target = win ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  if (target !== null && !target.isDestroyed()) {
    try {
      await target.webContents.executeJavaScript(inFrameDialogScript({
        title,
        message,
        buttons: [{ label: '确定', value: 'ok', primary: true }],
        cancelValue: 'ok',
        enterValue: 'ok',
      }))
      return
    } catch {
      // Page not answerable: fall through to the native dialog.
    }
  }
  const prompt = target === null
    ? dialog.showMessageBox({ type, title, message, buttons: ['确定'], defaultId: 0, cancelId: 0, noLink: true })
    : dialog.showMessageBox(target, { type, title, message, buttons: ['确定'], defaultId: 0, cancelId: 0, noLink: true })
  await prompt
}

/**
 * Shell update channel.
 *
 * Windows (primary market, mainland-first): a custom flow replaces
 * electron-updater — detect via latest.yml (GitHub `releases/latest` alias),
 * pick the installer for the running arch, download with an official-first /
 * mirror-fallback chain (gh-proxy.com), verify the sha512 from latest.yml,
 * then run the NSIS installer silently and quit. This is what makes app
 * updates work without a proxy in mainland China.
 *
 * macOS / Linux: keep electron-updater (native update formats), but surface
 * errors in a dialog and offer a release-page fallback.
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
  size?: number
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

/** The verified metadata URL chain (official GitHub first, then mirrors). */
function latestYamlCandidates(owner: string, repo: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/latest/download/latest.yml`
  return [official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
}

/** Installer download candidates for one asset (official first, then mirrors). */
function assetCandidates(owner: string, repo: string, assetUrl: string): string[] {
  const official = `https://github.com/${owner}/${repo}/releases/latest/download/${assetUrl}`
  return [official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
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
  return assets.find((f) => /-win\.exe$/.test(f.url) || /-win-x64\.exe$/.test(f.url)) ?? assets[0] ?? null
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

/** Download a file with progress, trying each candidate until one verifies. */
async function downloadWithFallback(
  candidates: string[],
  dest: string,
  expectedSha512: string,
  onProgress: (received: number, total: number) => void,
): Promise<string> {
  let lastError: Error | null = null
  for (const url of candidates) {
    try {
      await fs.rm(dest, { force: true })
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) })
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
  throw new Error(`无法从任何源下载更新包：${lastError?.message ?? '未知错误'}`)
}

async function showDownloadError(message: string): Promise<void> {
  const proceed = await confirmInFrame(
    {
      title: APP_NAME,
      message: `应用更新失败：${message}`,
      detail: '你可以稍后重试，或从下载页手动安装。',
      buttons: [
        { label: '关闭', value: 'close' },
        { label: '打开下载页', value: 'open', primary: true },
      ],
      cancelValue: 'close',
      enterValue: 'open',
    },
    {
      type: 'error',
      title: APP_NAME,
      message: `应用更新失败：${message}`,
      detail: '你可以稍后重试，或从下载页手动安装。',
      buttons: ['打开下载页', '关闭'],
      defaultId: 1,
      cancelId: 1,
    },
    'open',
  )
  if (proceed) void shell.openExternal(`https://github.com/${UPDATER_OWNER}/${UPDATER_REPO}/releases/latest`)
}

const UPDATER_OWNER = process.env.DSH_APP_ARTIFACT_OWNER ?? 'JochenYang'
const UPDATER_REPO = process.env.DSH_APP_ARTIFACT_REPO ?? 'dsh-app'

/**
 * Fetch latest.yml through the official-first / mirror-fallback chain.
 * @returns the raw YAML text, or null when every source failed.
 */
async function fetchLatestYamlText(): Promise<string | null> {
  for (const url of latestYamlCandidates(UPDATER_OWNER, UPDATER_REPO)) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (res.ok) return await res.text()
    } catch {
      // try next base
    }
  }
  return null
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
    showUpdateToast(win, '正在检查应用更新…', 'progress', 0)
    const yamlText = await fetchLatestYamlText()
    if (!yamlText) throw new Error('无法获取更新元数据（latest.yml）')

    const yaml = parseLatestYaml(yamlText)
    if (!yaml) throw new Error('更新元数据格式无法解析')
    // Version is spliced into an installer filename and the pending-install
    // record; constrain it to a safe charset so a crafted metadata value can
    // never break the path or the spawn target (defense in depth for an
    // unsigned latest.yml).
    if (!/^[\w.~-]+$/.test(yaml.version)) throw new Error('更新元数据版本格式异常')

    const current = app.getVersion()
    const newer = semver.valid(yaml.version) && semver.valid(current)
      ? semver.gt(yaml.version, current)
      : yaml.version !== current
    if (!newer) {
      clearKernelProgress(win)
      if (manual) void noticeInFrame(win, 'info', APP_NAME, `已是最新版本（${APP_NAME} ${current}）。`)
      return
    }

    const asset = pickAsset(yaml.files, process.arch)
    if (!asset) throw new Error('未找到适用于当前系统的安装包')
    // Same charset guard for the asset filename (spliced into the download
    // URL and the spawned installer path): a crafted value must fail safely,
    // never inject.
    if (!/^[\w.~-]+\.exe$/.test(asset.url)) throw new Error('更新包文件名格式异常')
    const proceed = await confirmInFrame(
      {
        title: `${APP_NAME} 更新可用`,
        message: `发现新版本 ${APP_NAME}（${yaml.version}）。`,
        detail: `当前 v${current} → v${yaml.version}。将下载并静默安装，安装完成后需重新打开应用。`,
        buttons: [
          { label: '稍后', value: 'later' },
          { label: '下载并安装', value: 'install', primary: true },
        ],
        cancelValue: 'later',
        enterValue: 'install',
      },
      {
        type: 'info',
        title: `${APP_NAME} 更新可用`,
        message: `发现新版本 ${APP_NAME}（${yaml.version}）。`,
        detail: `当前 v${current} → v${yaml.version}。将下载并静默安装，安装完成后需重新打开应用。`,
        buttons: ['下载并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      },
      'install',
    )
    if (!proceed) {
      clearKernelProgress(win)
      return
    }

    const dest = path.join(app.getPath('temp'), `dsh-app-update-${yaml.version}-${process.arch}.exe`)
    // Throttle card updates (~4/s) like the kernel downloader: every callback
    // is an executeJavaScript hop into the renderer, and the per-chunk stream
    // fires far faster than the eye can perceive.
    let lastEmit = 0
    const downloadedFrom = await downloadWithFallback(
      assetCandidates(UPDATER_OWNER, UPDATER_REPO, asset.url),
      dest,
      asset.sha512,
      (received, total) => {
        const now = Date.now()
        if (now - lastEmit < 250 && !(total > 0 && received >= total)) return
        lastEmit = now
        showKernelProgress(win, {
          phase: 'downloading',
          message: `正在下载 ${APP_NAME} ${yaml.version}…`,
          progress: total > 0 ? Math.min(1, received / total) : null,
        })
      },
    )
    console.log(`[shell-updater] downloaded ${asset.url} from ${downloadedFrom}`)
    showUpdateToast(win, `${APP_NAME} ${yaml.version} 下载完成`, 'success', 3_000)

    const install = await confirmInFrame(
      {
        title: `${APP_NAME} 更新就绪`,
        message: `将关闭当前应用并打开 ${APP_NAME} ${yaml.version} 安装向导（与首次安装相同）。`,
        detail: '按向导完成安装后，应用会重新启动。安装包将在安装完成后自动删除。',
        buttons: [
          { label: '稍后', value: 'later' },
          { label: '立即安装', value: 'install', primary: true },
        ],
        cancelValue: 'later',
        enterValue: 'install',
      },
      {
        type: 'question',
        title: `${APP_NAME} 更新就绪`,
        message: `将关闭当前应用并打开 ${APP_NAME} ${yaml.version} 安装向导（与首次安装相同）。`,
        detail: '按向导完成安装后，应用会重新启动。安装包将在安装完成后自动删除。',
        buttons: ['立即安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      },
      'install',
    )
    if (install) {
      // VISIBLE NSIS install: the app must be closed so the installer can
      // replace the running binaries; the wizard then shows the same flow as a
      // first-time install (user clicks through, completion page relaunches
      // the app). The installer is a GUI-subsystem binary spawned DIRECTLY —
      // no cmd wrapper: a detached cmd.exe always flashes a console window on
      // Windows, even with windowsHide.
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
        `${JSON.stringify({ version: yaml.version, installerPath: dest } satisfies PendingInstall)}\n`,
        'utf8',
      )
      const child = spawn(dest, [], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      app.quit()
    }
  } catch (err) {
    console.error('[shell-updater]', (err as Error).message)
    clearKernelProgress(win)
    if (manual) await showDownloadError((err as Error).message)
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
    showUpdateToast(win, '正在检查应用更新…', 'progress', 0)
    const yamlText = await fetchLatestYamlText()
    if (!yamlText) throw new Error('无法获取更新元数据（latest.yml）')
    const yaml = parseLatestYaml(yamlText)
    if (!yaml) throw new Error('更新元数据格式无法解析')
    if (!/^[\w.~-]+$/.test(yaml.version)) throw new Error('更新元数据版本格式异常')
    const current = app.getVersion()
    const newer = semver.valid(yaml.version) && semver.valid(current)
      ? semver.gt(yaml.version, current)
      : yaml.version !== current
    clearKernelProgress(win)
    await noticeInFrame(win, 'info', APP_NAME, newer
      ? `开发模式下不支持自动更新应用（当前运行的是未打包构建）。\n检测到新版本：v${current} → v${yaml.version}，请从正式安装的副本更新。`
      : `开发模式下不支持自动更新应用（当前运行的是未打包构建）。\n当前版本 v${current}，远端为同一版本。`)
  } catch (err) {
    clearKernelProgress(win)
    void noticeInFrame(win, 'info', APP_NAME, `开发模式下不支持自动更新应用，且远端版本检查失败：${(err as Error).message}`)
  }
}

export function checkShellUpdate(manual = false, win: BrowserWindow | null = null): void {
  if (process.env.DSH_APP_DEV === '1') {
    // Dev cannot self-install (the running app is the unpackaged build), but
    // a manual tray click still deserves the check animation and a verdict.
    if (manual) void checkShellUpdateDev(win)
    return
  }
  if (!initialized) initShellUpdater()
  if (process.platform === 'win32') {
    void checkShellUpdateWin32(manual, win)
    return
  }
  void autoUpdater.checkForUpdates().catch((err) => {
    console.error('[shell-updater]', err.message)
    if (manual) void showDownloadError((err as Error).message)
  })
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
    return
  }
  // The wizard was cancelled or failed: still on the old version.
  console.log(`[shell-updater] update to ${target} did not complete (running ${current})`)
  void showToastWhenLoaded(win, `上次应用更新未完成（当前仍为 v${current}），可从托盘「检查应用更新」重试`, 'error', 8_000)
}