; DSH APP installer hooks (wired through `nsis.include` in electron-builder.yml).
;
; Three hooks live here:
;
;   1. `customInstall` — pre-extract the bundled kernel at install time, so the
;      app's first launch adopts the staged tree instead of unpacking ~13k
;      files behind the splash.
;   2. `customCheckAppRunning` — exact-match replacement for the stock
;      app-running check.
;   3. `customUnInstallCheck` / `customUnInstallCheckCurrentUser` — fallback
;      when the previous version's uninstaller fails on the update path.
;
; Why (2) is not the stock one: the stock `FIND_PROCESS` matches EVERY process
; whose executable path merely STARTS WITH `$INSTDIR`. That is wrong the moment
; the install directory is a shared one — a Program Files root, or any folder
; the user points at that other applications also run from: the installer then
; finds those unrelated processes, tries to close them (killing the user's
; other software), and lands in the "cannot be closed" retry loop when they
; survive or restart. Measured on this project: installing into
; `D:\Program Files (x86)` (the parent of the app's own folder) matched eight
; unrelated dictionary processes and produced exactly that dialog. This matcher
; looks for THIS application's executable — `$INSTDIR\<app>.exe` — and nothing
; else, so a shared directory can never disturb a neighbour.
;
; Why (3) exists: on the update path the previous version's uninstaller renames
; every installed file into $PLUGINSDIR (TEMP) before deleting, and NSIS's
; Rename cannot cross volumes — an install on D: with TEMP on C: aborts on the
; first file and exits 2, which the stock installer treats as fatal. See the
; comment above the hook for the full reasoning.
;
; PowerShell is used directly (it ships with every Windows this app supports);
; the command shape mirrors the stock macro's, backtick-quoted so the nested
; double quotes survive.

; ---------------------------------------------------------------- (1) extract

!macro customInstall
  CreateDirectory "$INSTDIR\resources\kernel-staged"
  nsExec::ExecToLog `"$SYSDIR\tar.exe" -xzf "$INSTDIR\resources\kernel\kernel.tgz" -C "$INSTDIR\resources\kernel-staged"`
  Pop $0
  ${If} $0 != 0
    DetailPrint "warning: bundled kernel pre-extraction failed (tar exit $0); the app will extract it on first launch"
  ${Else}
    DetailPrint "bundled kernel extracted for the first launch"
  ${EndIf}
!macroend

; ------------------------------------------------------- (2) app-running check

!macro customCheckAppRunning
  Var /GLOBAL AppExePath
  StrCpy $AppExePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  # Find: exit 0 = this app's executable is running (exact, case-insensitive).
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.Equals('$AppExePath', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
  Pop $R0
  ${if} $R0 == 0
    ${if} ${isUpdated}
      # The in-app updater already asked the app to quit; give it a moment and
      # close whatever is left without prompting.
      Sleep 1000
    ${else}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit

      doStopProcess:
    ${endIf}

    DetailPrint "$(appClosing)"

    StrCpy $R1 0

    loop:
      IntOp $R1 $R1 + 1

      # Graceful close first; force only from the second round on.
      ${if} $R1 > 1
        nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.Equals('$AppExePath', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
      ${else}
        nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.Equals('$AppExePath', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId }"`
      ${endIf}
      Sleep 1000

      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.Equals('$AppExePath', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
      Pop $R0
      ${if} $R0 != 0
        Goto not_running
      ${endIf}

      # Still there after a graceful and a forced close: ask the user rather
      # than looping forever against a process that will not die.
      ${if} $R1 > 2
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
        Quit
      ${endIf}
      Goto loop

    not_running:
  ${endIf}
!macroend

; ------------------------------------------------- (3) old-uninstall handling

# The failure this section exists for, as measured on this machine:
#
# electron-builder's installer, before unpacking, finds the previous install in
# the registry and runs ITS uninstaller with `--updated` (installUtil.nsh:206 —
# unconditionally). That uninstaller then exits 2 and the installer retries
# five times before raising "$(appCannotBeClosed)" — the dialog users see.
#
# What the exit code depends on (four isolated runs of the REAL installed
# uninstaller against a scratch tree):
#
#   /S --updated _?=<dir>   exit 2   the installer's own invocation
#   /S --updated (no _?=)   exit 0   registry-resolved target
#   /S (no --updated)       exit 0   the manual-uninstall path
#   empty tree, --updated   exit 2   NOT about how many files there are
#
# So `--updated` plus a pinned target is what fails, and it fails on an EMPTY
# tree too — emptying the directory first (what this file did in its previous
# revision) cannot help. Two hooks handle it:
#
#   A. `customRemoveFiles` (uninstaller side, this macro) — replaces the stock
#      delete block outright, so a NEW uninstaller never runs the `--updated`
#      move-into-$PLUGINSDIR dance. Cures every update from 0.14.2 onward.
#   B. `dshPreclearPreviousInstall` (installer side, below) — removes the
#      registry entries before the stock code looks for them, so an OLD
#      uninstaller is never invoked at all. That is what covers the very next
#      update, where the uninstaller on disk is still the old one.
#
# User data is never in scope either way: the paths touched here are $INSTDIR
# (app binaries and the staged kernel), shortcuts and registry keys. $DSH_HOME
# (~/.dsh) and the Electron userData live outside all of them, and the stock
# `--updated` flag is what suppresses app-data deletion in the first place.

; A. The uninstaller-side replacement for the stock delete block.
!macro customRemoveFiles
  # The stock block renames $INSTDIR into $PLUGINSDIR before deleting, and
  # aborts when that rename fails — which is what produces the exit code the
  # installer treats as fatal. Delete in place instead: RMDir /r removes file
  # by file, so it works on any volume and on any tree shape.
  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend

!macro dshRemovePreviousInstall
  ${if} ${errors}
    ClearErrors
    DetailPrint "old uninstaller could not be launched; removing the previous install directory directly"
  ${elseIf} $R0 != 0
    DetailPrint "old uninstaller exited with code $R0; removing the previous install directory directly"
  ${else}
    Return
  ${endIf}

  RMDir /r $INSTDIR

  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
  ; InstallLocation is deliberately LEFT in place — see dshPreclearPreviousInstall.
!macroend

; B. Installer side: take the UNINSTALL STRING away before the stock code reads
; it, so it never finds a previous install to run an uninstaller for.
;
; Why this works where removing files did not: `uninstallOldVersion` reads
; `${UNINSTALL_REGISTRY_KEY}` UninstallString and returns immediately when it is
; absent (installUtil.nsh:155-164). No uninstall string, no uninstaller, no
; retry loop, no dialog — and the installer writes fresh entries at the end of a
; successful install, so nothing is left missing.
;
; WHY InstallLocation SURVIVES — this is the fix for a real regression:
; `setInstallModePerUser`/`setInstallModePerAllUsers` resolve the install
; directory from `${INSTALL_REGISTRY_KEY}` InstallLocation, and fall back to
; `$LocalAppData\Programs\<app>` when it is empty (multiUser.nsh:26-47). That
; read happens when the directory page runs its pre-function, which is AFTER
; this hook. Deleting the whole `${INSTALL_REGISTRY_KEY}` therefore erased the
; user's chosen path before it was read, and an in-app update silently
; reinstalled into the default location — reported as "the update installed to
; C: instead of where I had it". Measured: the key is read twice, once here for
; the old install's location and once by the mode selection for the new one, and
; only the SECOND read feeds $INSTDIR.
;
; The two keys are therefore treated differently on purpose:
;   - UninstallString (both hives)      -> removed, so no old uninstaller runs;
;   - InstallLocation (both hives)      -> kept, so the path is remembered.
; The old tree itself is removed by path, which is what InstallLocation gave us.
;
; Called from `customInit` (.onInit), which matters for the elevated path: a
; per-machine install elevates through UAC and the INNER instance runs
; `.onInit` again (initMultiUser → setInstallModePerAllUsers → UAC_RunElevated),
; while the install section's running-process check is skipped for that inner
; instance. `.onInit` is therefore the one place both the normal and the
; elevated instance pass through.
;
; The per-machine entry is read from HKLM first: an elevated instance sees the
; machine hive, and a per-user instance must still find an HKLM install it is
; about to be replaced by.
!macro dshPreclearPreviousInstall
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R2 == ""
      ReadRegStr $R2 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${endif}
    ${if} $R2 != ""
      DetailPrint "removing the previous install at $R2 (uninstall string first, so its uninstaller is never run)"
      DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
      DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
      RMDir /r $R2
    ${else}
      ; No recorded path (a first install, or a tree whose key is already gone):
      ; still drop any uninstall string, so a stale entry cannot summon an
      ; uninstaller for a directory this installer is not touching.
      DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
      DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
    ${endif}
  !endif
!macroend

!macro customInit
  !insertmacro dshPreclearPreviousInstall
!macroend

!macro customUnInstallCheck
  !insertmacro dshRemovePreviousInstall
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro dshRemovePreviousInstall
!macroend
