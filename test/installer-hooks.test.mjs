// The NSIS installer hooks' registry contract.
//
// Why this is asserted on the SOURCE: NSIS is compiled only in CI (no makensis on
// a developer machine), so a mistake here reaches users through an installer that
// cannot be exercised locally. The rule pinned below was broken exactly that way
// and shipped: an in-app update installed to the default location instead of the
// one the user had chosen.
//
// The mechanism, from electron-builder's own templates:
//
//   * `setInstallModePerUser` / `setInstallModePerAllUsers` resolve the target
//     directory from `${INSTALL_REGISTRY_KEY}` InstallLocation and fall back to
//     `$LocalAppData\Programs\<app>` when it is EMPTY (multiUser.nsh:26-47,
//     multiUser.nsh:75-96).
//   * `uninstallOldVersion` decides whether to run the previous version's
//     uninstaller from `${UNINSTALL_REGISTRY_KEY}` UninstallString alone, and
//     returns immediately when it is absent (installUtil.nsh:155-164).
//
// So the two keys carry different jobs, and our hook must treat them differently:
// dropping UninstallString is what stops the old uninstaller; dropping
// InstallLocation throws away the remembered path and is what sent the update to
// the default directory.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const HOOKS = path.join(ROOT, 'scripts', 'installer', 'installer-hooks.nsh')

/** The hook source with its comment lines removed, so only code is asserted. */
function code() {
  return readFileSync(HOOKS, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => !/^\s*[;#]/u.test(line))
    .join('\n')
}

test('the hooks never delete the InstallLocation the installer reads the path from', () => {
  const body = code()
  // Every DeleteRegKey that names the INSTALL key is a repeat of the regression,
  // whichever hive it targets.
  const deleting = [...body.matchAll(/DeleteRegKey\s+\S+\s+"?\$\{INSTALL_REGISTRY_KEY\}"?/gu)].map((m) => m[0])
  assert.deepEqual(deleting, [],
    'deleting InstallLocation forgets the user\'s chosen path; an update then installs to the default location')
  // The uninstall string IS meant to go: that is what stops the old uninstaller.
  assert.match(body, /DeleteRegKey HKCU "\$\{UNINSTALL_REGISTRY_KEY\}"/u,
    'the uninstall string must be removed, or the previous uninstaller runs and fails')
  assert.match(body, /DeleteRegKey HKLM "\$\{UNINSTALL_REGISTRY_KEY\}"/u,
    'both hives carry the entry: an elevated instance sees the machine one')
})

test('the previous tree is still removed by the path InstallLocation gave', () => {
  const body = code()
  // Keeping the key is only safe because the OLD TREE is deleted explicitly —
  // otherwise a stale install would sit beside the new one.
  assert.match(body, /ReadRegStr \$R2 HKLM "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/u,
    'the path must be read (HKLM first) so the old tree can be removed by it')
  assert.match(body, /ReadRegStr \$R2 HKCU "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/u,
    'a per-user install records its path in HKCU')
  assert.match(body, /RMDir \/r \$R2/u, 'the old tree at that path must be removed')
  // And the removal must be conditional on having found a path: an unconditional
  // RMDir /r $R2 would delete whatever a stale variable held.
  assert.match(body, /\$\{if\} \$R2 != ""/u, 'the removal must be guarded by a found path')
})

test('the hook file stays macro-balanced', () => {
  // NSIS reports an unbalanced macro as a compile error deep in generated code,
  // in CI only — a local check is cheap insurance.
  const body = readFileSync(HOOKS, 'utf8')
  const opens = (body.match(/^!macro /gmu) ?? []).length
  const closes = (body.match(/^!macroend/gmu) ?? []).length
  assert.equal(opens, closes, `!macro (${String(opens)}) and !macroend (${String(closes)}) must pair`)
})
