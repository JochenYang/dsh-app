// The Windows update path: silent install, one interruption, and a notice that
// says what landed. Each rule is a spawn argument, a dialog that must stay gone,
// or a file that must survive a deferral — none of it is callable without
// Electron, so the shapes are pinned here the way platform-view.test.mjs pins
// its own windows.
//
// Why these particular rules: the flow shipped a copy that claimed "downloads
// and installs silently" while spawning a visible NSIS wizard, asked the same
// question twice (once at "update available", once after the download), and
// said nothing at all when the new version came up.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'updater.ts'), 'utf8')
const { t } = require('../dist/shared/locale.js')

test('the windows install is silent, asks nothing, and relaunches the app', () => {
  // `--updated` skips the pages and the running-app prompt; `/S` is silent;
  // `--force-run` is what makes an assisted installer start the app again (only
  // `${Silent} && ${isForceRun}` does that in installSection.nsh). The hooks
  // file stays free of page customisation: the installer shows nothing, and the
  // themed progress UI belongs to the app, not to NSIS (see the design note in
  // the changeset).
  // The installer is spawned directly and silently. A separate progress helper
  // that ran from this same installed executable was removed in 0.19.6: it kept
  // the old binaries open, so the installer exited 0 without installing.
  assert.match(source, /spawn\(dest, \['--updated', '\/S', '--force-run'\]/u)
  assert.ok(!source.includes('UPDATE_PROGRESS_ARGV'), 'no in-process helper is spawned')
  assert.ok(!source.includes('update-progress'), 'the helper module is gone')
  // The pre-install card is the only thing left on screen.
  assert.match(source, /t\('updater\.installing'/u)
  const hooks = readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'installer', 'installer-hooks.nsh'), 'utf8')
  assert.match(hooks, /!macro customInstall/u)
  assert.match(hooks, /!macro customCheckAppRunning/u)
  assert.ok(!hooks.includes('customFinishPage'), 'no custom NSIS page hooks')
  assert.ok(!hooks.includes('dshInstFilesShow'), 'no themed NSIS page')
})

test('the post-download confirmation is gone, leaving the task gate and a countdown', () => {
  // The decision was already made at the availability prompt; a second
  // "install now" DIALOG was the one that made the flow feel manual. The label
  // survives as a countdown button (start now, skip the wait), not as a prompt.
  assert.ok(!source.includes('installPrompt'), 'the second confirmation dialog must not come back')
  const windowsTail = source.slice(
    source.indexOf('async function downloadAndInstallPackage'),
    source.indexOf('// -------------------------------------------------------- version rollback'),
  )
  assert.ok(windowsTail.length > 0, 'the windows install tail is where the download ends')
  assert.ok(!windowsTail.includes('confirmInFrame'), 'the windows install tail asks nothing after the download')
  assert.match(source, /if \(!await confirmNoActiveTasks\(win\)\) return/u)
  assert.match(source, /if \(!await confirmSilentInstall\(win\)\) return/u)
  // The countdown is a card with two buttons — start now, or not now — rather
  // than another dialog.
  assert.match(source, /showUpdateCard\(win, t\('updater\.installCountdown'/u)
  assert.match(source, /id: CANCEL_INSTALL_ACTION, label: t\('updater\.cancelInstall'\)/u)
  assert.match(source, /id: INSTALL_NOW_ACTION, label: t\('updater\.installNow'\), primary: true/u)
  assert.match(source, /chosen === INSTALL_NOW_ACTION/u)
})

test('a deferred install keeps its bytes instead of deleting them', () => {
  assert.match(source, /async function rememberCachedInstaller/u)
  assert.match(source, /async function cachedInstallerMatches/u)
  assert.match(source, /async function pruneCachedInstaller/u)
  // The two deferral paths (active tasks, countdown cancel) must return without
  // removing the ~250 MB installer; only the cache record's expiry or a
  // completed install may delete it.
  const tail = source.slice(source.indexOf('const reused = await cachedInstallerMatches'))
  assert.ok(!tail.slice(0, 3_000).includes('fs.rm(dest'), 'a deferral must not delete the downloaded installer')
  // A cache hit is still gated on the metadata digest, never on the file's name.
  assert.match(source, /sha512Base64\(dest\) === sha512/u)
})

test('the next boot names the installed version and links to its release', () => {
  assert.match(source, /t\('updater\.updatedToast', \{ app: APP_NAME, version: current \}\)/u)
  // The notice opens the IN-APP changelog: a mainland user cannot reach the
  // GitHub release page, and the sheet's own external link is the mirror.
  assert.match(source, /label: t\('updater\.viewReleaseNotes'\) \}/u)
  assert.match(source, /openChangelogDialog\(win\)/u)
  assert.ok(!source.includes('releases/tag/v'), 'no GitHub release link is built by the updater')
  // A rollback is named as a rollback, not as an update.
  assert.match(source, /t\('updater\.rollbackDoneToast', \{ app: APP_NAME, version: current \}\)/u)
})

test('macOS and Linux install silently and relaunch explicitly', () => {
  // BaseUpdater only honours `isForceRunAfter` when silent; stating both keeps
  // the three platforms on one contract instead of the autoRun default.
  assert.match(source, /autoUpdater\.quitAndInstall\(true, true\)/u)
})

test('an already-downloaded installer skips the availability prompt next time', () => {
  // The user's "later" is a decision, not a request to be asked again: the next
  // check (startup or manual) goes straight to the install countdown and reuses
  // the bytes. The digest is re-checked, so a stale or tampered file still
  // falls through to a fresh download.
  const check = source.slice(source.indexOf('async function checkShellUpdateWin32'), source.indexOf('async function downloadAndInstallPackage'))
  const cachedAt = check.indexOf('const alreadyDownloaded = await cachedInstallerReady')
  const promptAt = check.indexOf('await promptUpdateConfirm')
  assert.ok(cachedAt !== -1, 'the cached installer is checked before prompting')
  assert.ok(promptAt !== -1)
  assert.ok(cachedAt < promptAt, 'the cache check must come first')
  assert.match(check, /if \(!alreadyDownloaded\) \{/u)
})

test('the cache record expires on age or on a missing file', () => {
  const { cachedInstallerExpired } = require('../dist/main/updater.js')
  const day = 24 * 60 * 60 * 1_000
  const now = 1_800_000_000_000
  // Fresh and present: keep.
  assert.equal(cachedInstallerExpired(now - day, now, true), false)
  // Exactly at the boundary still counts as useful; the next day does not.
  assert.equal(cachedInstallerExpired(now - 7 * day, now, true), false)
  assert.equal(cachedInstallerExpired(now - 7 * day - 1, now, true), true)
  // A record whose file is gone describes nothing.
  assert.equal(cachedInstallerExpired(now, now, false), true)
})

test('the installed copy matches what the flow does', () => {
  // The old copy promised a silent install while the wizard showed; these are
  // the strings a user now actually sees.
  assert.match(t('updater.availableDetail', { current: '1.0.0', version: '1.1.0' }), /静默安装/u)
  assert.match(t('updater.installCountdown', { seconds: 10 }), /10/u)
  assert.match(t('updater.cancelInstall'), /取消/u)
  assert.match(t('updater.updatedToast', { app: 'DSH APP', version: '1.2.3' }), /1\.2\.3/u)
  assert.match(t('updater.viewReleaseNotes'), /更新/u)
})

